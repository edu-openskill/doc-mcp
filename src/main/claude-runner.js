'use strict';

const { spawn, spawnSync } = require('child_process');
const os = require('os');

/**
 * claude CLI를 헤드리스로 구동하되, **계획 → 검토 → 승인 → 실행** 모드를 강제한다.
 *
 * - 계획 단계: 읽기 전용 도구만 허용 + `--permission-mode dontAsk`(허용목록 외 전부 거부)
 *   → 물리적으로 변경 불가능한 상태에서 "무엇을 바꿀지" 계획만 출력.
 * - 실행 단계: 사용자가 승인하면 같은 세션을 `--resume <session_id>` 로 이어,
 *   쓰기 도구 허용 + `acceptEdits` 로 계획을 실행하고 쓰기 후 재조회로 검증.
 *
 * 각 단계는 별도의 `claude -p` 호출이며 session_id 로 대화를 잇는다.
 * 프롬프트(한글/특수문자 포함)는 argv 대신 stdin 으로 넣어 인용 문제를 피한다.
 */

// 계획 단계에서 허용하는 읽기 전용 도구 (우리가 통제하는 hwp/db + 파일 읽기)
// excel/docx 서버의 읽기 도구명이 확정되면 여기에 추가한다.
const READ_ALLOW = [
  'mcp__hwp__hwp_open',
  'mcp__hwp__hwp_status',
  'mcp__hwp__hwp_get_text',
  'mcp__hwp__hwp_read_table',
  'mcp__hwp__hwp_get_cell',
  'mcp__db__db_list_tables',
  'mcp__db__db_schema',
  'mcp__db__db_query',
  'Read', 'Glob', 'Grep',
].join(',');

// 실행 단계에서 허용하는 전체 도구
const WRITE_ALLOW = 'mcp__hwp__*,mcp__excel__*,mcp__docx__*,mcp__db__*,Read,Glob,Grep';

class ClaudeRunner {
  /**
   * @param {object} opts {cwd, mcpConfig, planPromptFile, execPromptFile}
   * @param {object} handlers {onText,onTool,onResult,onError,onExit,onSystem}
   */
  constructor(opts, handlers) {
    this.opts = opts;
    this.handlers = handlers || {};
    this.proc = null;
    this.buffer = '';
    this.sessionId = null;
    this.phase = 'idle'; // idle | planning | executing
  }

  static resolveClaudeCommand() {
    const isWin = process.platform === 'win32';
    const candidates = isWin ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
    for (const cmd of candidates) {
      const probe = spawnSync(cmd, ['--version'], { shell: isWin, encoding: 'utf8' });
      if (!probe.error && probe.status === 0) {
        return { command: cmd, version: (probe.stdout || '').trim() };
      }
    }
    return null;
  }

  static checkEnvironment() {
    const resolved = ClaudeRunner.resolveClaudeCommand();
    if (!resolved) {
      return {
        ok: false,
        reason: 'not_installed',
        message:
          'claude CLI를 찾을 수 없습니다. "npm i -g @anthropic-ai/claude-code" 로 설치 후 다시 시도하세요.',
      };
    }
    return { ok: true, command: resolved.command, version: resolved.version };
  }

  /** 사용자 요청 → 계획 단계 실행(읽기 전용). 변경은 일어나지 않는다. */
  runPlan(text) {
    this._spawnPhase({
      phase: 'planning',
      prompt: text,
      allow: READ_ALLOW,
      permissionMode: 'dontAsk',
      systemPromptFile: this.opts.planPromptFile,
    });
  }

  /** 승인됨 → 실행 단계(쓰기 허용). 직전 계획 세션을 이어 실행한다. */
  approveExecute() {
    this._spawnPhase({
      phase: 'executing',
      prompt:
        '위 계획이 승인되었습니다. 계획한 변경을 그대로 실행하세요. ' +
        '각 쓰기 작업 후에는 반드시 해당 셀/내용을 다시 읽어 반영을 검증하고 결과를 보고하세요.',
      allow: WRITE_ALLOW,
      permissionMode: 'acceptEdits',
      systemPromptFile: this.opts.execPromptFile,
    });
  }

  /** 거절 → 사용자가 피드백을 주면 다음 runPlan 이 같은 세션을 이어 다시 계획한다. */
  reject(feedback) {
    if (feedback && feedback.trim()) {
      this.runPlan('이전 계획은 거절되었습니다. 다음 피드백을 반영해 다시 계획하세요: ' + feedback);
    } else {
      this.phase = 'idle';
      this.handlers.onResult && this.handlers.onResult({ phase: 'rejected' });
    }
  }

  _spawnPhase({ phase, prompt, allow, permissionMode, systemPromptFile }) {
    const env = ClaudeRunner.checkEnvironment();
    if (!env.ok) {
      this.handlers.onError && this.handlers.onError(env.message);
      return;
    }
    if (this.proc) this.stop();
    this.phase = phase;
    this.buffer = '';

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config', this.opts.mcpConfig,
      '--permission-mode', permissionMode,
      '--allowedTools', allow,
    ];
    if (systemPromptFile) {
      args.push('--append-system-prompt-file', systemPromptFile);
    }
    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    this.proc = spawn(env.command, args, {
      cwd: this.opts.cwd || os.homedir(),
      shell: process.platform === 'win32',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this._onStdout(c));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c) => {
      const t = String(c);
      if (/login|authenticat|unauthor/i.test(t)) {
        this.handlers.onError &&
          this.handlers.onError(
            'claude 인증이 필요합니다. 터미널에서 "claude" 를 실행해 로그인(구독)하세요.\n' + t.trim()
          );
      }
    });
    this.proc.on('error', (e) => this.handlers.onError && this.handlers.onError(String(e.message || e)));
    this.proc.on('exit', () => {
      this.handlers.onExit && this.handlers.onExit(this.phase);
      this.proc = null;
    });

    // 프롬프트는 stdin 으로 전달(인용 문제 회피, BOM 없음)
    this.proc.stdin.write(prompt);
    this.proc.stdin.end();
  }

  /** 진행 중인 단계를 중단한다(프로세스 종료). 세션은 유지. */
  stop() {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (_) {}
      this.proc.kill();
      this.proc = null;
    }
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch (_) { continue; }
      this._dispatch(evt);
    }
  }

  _dispatch(evt) {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          this.sessionId = evt.session_id || this.sessionId;
          this.handlers.onSystem && this.handlers.onSystem({ ...evt, phase: this.phase });
        } else if (evt.subtype === 'api_retry') {
          this.handlers.onSystem && this.handlers.onSystem({ ...evt, phase: this.phase });
        }
        break;
      case 'stream_event': {
        const e = evt.event || {};
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          this.handlers.onText && this.handlers.onText(e.delta.text);
        }
        break;
      }
      case 'assistant': {
        const content = (evt.message && evt.message.content) || [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.handlers.onTool && this.handlers.onTool({ name: block.name, input: block.input });
          }
        }
        break;
      }
      case 'result':
        if (evt.session_id) this.sessionId = evt.session_id;
        this.handlers.onResult && this.handlers.onResult({ ...evt, phase: this.phase });
        break;
      default:
        break;
    }
  }
}

module.exports = { ClaudeRunner };
