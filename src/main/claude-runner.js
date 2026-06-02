'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

/**
 * claude CLI를 헤드리스 stream-json 모드로 구동하는 러너.
 *
 * - 하나의 claude 프로세스를 stdin(--input-format stream-json)으로 살려두고
 *   사용자 메시지를 JSON 줄로 주입하여 멀티턴 세션을 유지한다.
 * - stdout(--output-format stream-json --verbose --include-partial-messages)을
 *   NDJSON으로 파싱하여 토큰/툴호출/완료 이벤트를 콜백으로 흘려보낸다.
 *
 * PTY를 쓰지 않으므로 TUI 출력 파싱이 필요 없다.
 */
class ClaudeRunner {
  /**
   * @param {object} opts
   * @param {string} opts.cwd          작업 디렉터리(문서 폴더)
   * @param {string} opts.mcpConfig    mcp.json 절대 경로
   * @param {string} [opts.allowedTools] 사전 승인 툴 패턴
   * @param {object} handlers  { onText, onTool, onResult, onError, onExit, onSystem }
   */
  constructor(opts, handlers) {
    this.opts = opts;
    this.handlers = handlers || {};
    this.proc = null;
    this.buffer = '';
    this.sessionId = null;
    this._reqSeq = 0;
  }

  /** claude 실행 파일 경로를 찾는다(Windows에서는 .cmd/.ps1 래퍼). */
  static resolveClaudeCommand() {
    const isWin = process.platform === 'win32';
    // Windows: npm 전역 설치 시 claude.cmd 가 PATH에 있다.
    const candidates = isWin
      ? ['claude.cmd', 'claude.exe', 'claude']
      : ['claude'];
    for (const cmd of candidates) {
      const probe = spawnSync(cmd, ['--version'], {
        shell: isWin,
        encoding: 'utf8',
      });
      if (!probe.error && probe.status === 0) {
        return { command: cmd, version: (probe.stdout || '').trim() };
      }
    }
    return null;
  }

  /** claude 설치 + 로그인 상태를 점검한다. */
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

  start() {
    const env = ClaudeRunner.checkEnvironment();
    if (!env.ok) {
      this.handlers.onError && this.handlers.onError(env.message);
      return false;
    }

    const allow =
      this.opts.allowedTools ||
      'mcp__hwp__*,mcp__excel__*,mcp__docx__*,Read,Glob,Grep';

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config', this.opts.mcpConfig,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', allow,
    ];
    if (this.opts.systemPromptFile) {
      args.push('--append-system-prompt-file', this.opts.systemPromptFile);
    }

    this.proc = spawn(env.command, args, {
      cwd: this.opts.cwd || os.homedir(),
      shell: process.platform === 'win32',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      // stderr 는 진단용. 인증 만료 등 힌트가 여기 올 수 있다.
      const text = String(chunk);
      if (/login|authenticat|unauthor/i.test(text)) {
        this.handlers.onError &&
          this.handlers.onError(
            'claude 인증이 필요합니다. 터미널에서 "claude" 를 한 번 실행해 로그인(구독) 하세요.\n' +
              text.trim()
          );
      }
    });

    this.proc.on('error', (err) => {
      this.handlers.onError && this.handlers.onError(String(err.message || err));
    });

    this.proc.on('exit', (code) => {
      this.handlers.onExit && this.handlers.onExit(code);
      this.proc = null;
    });

    return true;
  }

  /** 사용자 메시지를 stream-json 한 줄로 stdin 에 주입한다. */
  send(text) {
    if (!this.proc) {
      if (!this.start()) return;
    }
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /**
   * 현재 진행 중인 생성(턴)만 중단한다. 세션 프로세스는 살려두어
   * 곧바로 다음 메시지를 보낼 수 있다. (control_request:interrupt)
   * @returns {boolean} 인터럽트 요청을 보냈으면 true
   */
  interrupt() {
    if (!this.proc) return false;
    const reqId = `int_${++this._reqSeq}`;
    try {
      this.proc.stdin.write(
        JSON.stringify({
          type: 'control_request',
          request_id: reqId,
          request: { subtype: 'interrupt' },
        }) + '\n'
      );
      return true;
    } catch (_) {
      // stdin 이 닫혔으면 프로세스를 강제 종료한다(최후 수단).
      this.stop();
      return false;
    }
  }

  /** 세션 자체를 완전히 종료한다(프로세스 kill). */
  stop() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch (_) {}
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
      try {
        evt = JSON.parse(line);
      } catch (_) {
        continue; // 부분 라인/비JSON 무시
      }
      this._dispatch(evt);
    }
  }

  _dispatch(evt) {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          this.sessionId = evt.session_id || this.sessionId;
          this.handlers.onSystem && this.handlers.onSystem(evt);
        } else if (evt.subtype === 'api_retry') {
          this.handlers.onSystem && this.handlers.onSystem(evt);
        }
        break;

      case 'stream_event': {
        // 토큰 단위 텍스트 델타
        const e = evt.event || {};
        if (
          e.type === 'content_block_delta' &&
          e.delta &&
          e.delta.type === 'text_delta'
        ) {
          this.handlers.onText && this.handlers.onText(e.delta.text);
        }
        break;
      }

      case 'assistant': {
        // 완성된 assistant 메시지 — tool_use 블록에서 툴 호출 표면화
        const content = (evt.message && evt.message.content) || [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            this.handlers.onTool &&
              this.handlers.onTool({ name: block.name, input: block.input });
          }
        }
        break;
      }

      case 'result':
        this.handlers.onResult && this.handlers.onResult(evt);
        break;

      default:
        break;
    }
  }
}

module.exports = { ClaudeRunner };
