'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const providers = require('./providers');

const MARKER = '[[NEEDS_APPROVAL]]';

/** 스트리밍 중 승인요청 마커를 감지/제거하면서 안전하게 텍스트를 흘려보낸다. */
class MarkerFilter {
  constructor(m) { this.m = m; this.buf = ''; this.seen = false; }
  push(s) {
    this.buf += s;
    let out = '', idx;
    while ((idx = this.buf.indexOf(this.m)) >= 0) {
      out += this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + this.m.length);
      this.seen = true;
    }
    let keep = 0;
    for (let k = Math.min(this.m.length - 1, this.buf.length); k > 0; k--) {
      if (this.buf.slice(this.buf.length - k) === this.m.slice(0, k)) { keep = k; break; }
    }
    out += this.buf.slice(0, this.buf.length - keep);
    this.buf = this.buf.slice(this.buf.length - keep);
    return out;
  }
  flush() { const r = this.buf; this.buf = ''; return r; }
}

/**
 * 제공자 비종속 러너. 모드별 흐름:
 *  - edit(편집수락): 한 번에 쓰기 실행.
 *  - plan(계획): 읽기 전용, 계획만.
 *  - auto(자동): 읽기 전용 1차 → 조회면 바로 답, 변경이면 [[NEEDS_APPROVAL]] → 승인 시 실행.
 */
class AgentRunner {
  constructor(opts, handlers) {
    this.opts = opts; // {cwd, mcpConfig, providerId, model, mode, autoPromptFile, planPromptFile, execPromptFile}
    this.h = handlers || {};
    this.proc = null;
    this.buffer = '';
    this.sessions = {}; // providerId -> session_id
    this.pendingExecute = false;
    this.phase = 'idle';
  }

  get adapter() { return providers.get(this.opts.providerId); }

  setProvider(id) { this.opts.providerId = id; }
  setModel(m) { this.opts.model = m; }
  setMode(m) { this.opts.mode = m; }

  /** 사용자 메시지 처리(모드에 따라 분기) */
  send(text) {
    const mode = this.opts.mode || 'auto';
    this.pendingExecute = false;
    if (mode === 'edit') {
      this._run({ level: 'write', prompt: text, sysFile: this.opts.execPromptFile, phase: 'executing' });
    } else if (mode === 'plan') {
      this._run({ level: 'read', prompt: text, sysFile: this.opts.planPromptFile, phase: 'planning' });
    } else {
      this._run({ level: 'read', prompt: text, sysFile: this.opts.autoPromptFile, phase: 'planning', watchMarker: true });
    }
  }

  /** 자동 모드에서 승인됨 → 실행 단계 */
  approve() {
    if (!this.pendingExecute) return;
    this.pendingExecute = false;
    this._run({
      level: 'write', phase: 'executing', sysFile: this.opts.execPromptFile,
      prompt: '위 제안이 승인되었습니다. 제안한 변경을 그대로 실행하고, 각 쓰기 후 다시 읽어 검증한 뒤 보고하세요.',
      resume: true,
    });
  }

  reject(feedback) {
    this.pendingExecute = false;
    if (feedback && feedback.trim()) {
      this._run({ level: 'read', phase: 'planning', sysFile: this.opts.autoPromptFile, watchMarker: true, resume: true,
        prompt: '직전 제안은 거절되었습니다. 다음 피드백을 반영해 다시 검토하세요: ' + feedback });
    } else {
      this.phase = 'idle';
      this.h.onResult && this.h.onResult({ phase: 'rejected' });
    }
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); } catch (_) {} this.proc.kill(); this.proc = null; }
  }

  _run({ level, prompt, sysFile, phase, watchMarker, resume }) {
    const a = this.adapter;
    const det = a.detect();
    if (!det.installed) {
      this.h.onError && this.h.onError(`${a.label} CLI가 설치되어 있지 않습니다. (${a.loginHint})`);
      return;
    }
    if (this.proc) this.stop();
    this.phase = phase;
    this.buffer = '';
    this.filter = new MarkerFilter(MARKER);
    this._watch = !!watchMarker;

    const resumeId = resume ? this.sessions[a.id] : null;
    const built = a.spawnArgs({
      level, model: this.opts.model, mcpConfig: this.opts.mcpConfig,
      systemPromptFile: sysFile, resume: resumeId,
    });

    // gemini/codex 는 시스템 프롬프트 플래그가 없어 프롬프트 앞에 규칙을 붙인다
    let finalPrompt = prompt;
    if (built.prependSystem) {
      try { finalPrompt = fs.readFileSync(built.prependSystem, 'utf8') + '\n\n---\n\n요청:\n' + prompt; } catch (_) {}
    }

    this.proc = spawn(built.command, built.args, {
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
      if (/login|authenticat|unauthor|not logged|credential/i.test(t)) {
        this.h.onError && this.h.onError(`${a.label} 인증이 필요합니다. 터미널에서 "${a.loginHint}" 실행 후 로그인하세요.`);
      }
    });
    this.proc.on('error', (e) => this.h.onError && this.h.onError(String(e.message || e)));
    this.proc.on('exit', () => { this.h.onExit && this.h.onExit(this.phase); this.proc = null; });

    if (built.stdinPrompt) { this.proc.stdin.write(finalPrompt); this.proc.stdin.end(); }
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch (_) { continue; }
      this._dispatch(evt);
    }
  }

  _dispatch(evt) {
    const a = this.adapter;
    a.parse(evt, {
      system: (s) => {
        if (s.session_id) this.sessions[a.id] = s.session_id;
        this.h.onSystem && this.h.onSystem({ ...s, phase: this.phase });
      },
      text: (t) => {
        const out = this._watch ? this.filter.push(t) : t;
        if (out) this.h.onText && this.h.onText(out);
      },
      tool: (tool) => this.h.onTool && this.h.onTool(tool),
      result: (r) => {
        if (r.session_id) this.sessions[a.id] = r.session_id;
        if (this._watch) {
          const tail = this.filter.flush();
          if (tail) this.h.onText && this.h.onText(tail);
        }
        const needsApproval = this._watch && this.filter.seen;
        if (needsApproval) this.pendingExecute = true;
        this.h.onResult && this.h.onResult({
          phase: this.phase, status: r.status,
          needsApproval, mode: this.opts.mode,
        });
      },
    });
  }
}

module.exports = { AgentRunner };
