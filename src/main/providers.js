'use strict';

/**
 * 제공자(CLI) 어댑터 레이어.
 *
 * 각 어댑터는 동일한 인터페이스를 제공한다:
 *  - id, label, models[]
 *  - detect()                      → { installed, version, command }
 *  - spawnArgs({level, model, mcpConfig, systemPromptFile, resume})
 *      level: 'read'(읽기전용=계획) | 'write'(쓰기허용=실행)
 *  - parse(evt, emit)              → 통일 이벤트로 변환 (onText/onTool/onResult/onSystem)
 *  - ensureMcp(servers)            → (선택) 사전 MCP 등록 (gemini)
 *
 * claude/gemini 는 stream-json 출력(필드만 다름), codex 는 json(미설치 환경이라 best-effort).
 */
const { spawnSync, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
function bin(name) { return isWin ? name + '.cmd' : name; }

function detectCmd(cmd) {
  try {
    const p = spawnSync(bin(cmd), ['--version'], { shell: isWin, encoding: 'utf8' });
    if (!p.error && p.status === 0) return { installed: true, version: (p.stdout || '').trim().split('\n')[0], command: bin(cmd) };
  } catch (_) {}
  return { installed: false };
}

// ── claude 읽기/쓰기 허용 도구 ──────────────────────────────────────────
const CLAUDE_READ = [
  'mcp__hwp__hwp_open', 'mcp__hwp__hwp_status', 'mcp__hwp__hwp_get_text',
  'mcp__hwp__hwp_read_table', 'mcp__hwp__hwp_get_cell',
  'mcp__db__db_list_tables', 'mcp__db__db_schema', 'mcp__db__db_query',
  'Read', 'Glob', 'Grep',
].join(',');
const CLAUDE_WRITE = 'mcp__hwp__*,mcp__excel__*,mcp__docx__*,mcp__db__*,Read,Glob,Grep';

// ── Claude ──────────────────────────────────────────────────────────────
const claude = {
  id: 'claude',
  label: 'Claude',
  models: [
    { id: 'opus', label: 'Opus 4.8' },
    { id: 'sonnet', label: 'Sonnet 4.6' },
    { id: 'haiku', label: 'Haiku 4.5' },
  ],
  detect() { return detectCmd('claude'); },
  loginHint: 'claude',
  spawnArgs({ level, model, mcpConfig, systemPromptFile, resume }) {
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--mcp-config', mcpConfig,
      '--permission-mode', level === 'write' ? 'acceptEdits' : 'dontAsk',
      '--allowedTools', level === 'write' ? CLAUDE_WRITE : CLAUDE_READ,
    ];
    if (model) args.push('--model', model);
    if (systemPromptFile) args.push('--append-system-prompt-file', systemPromptFile);
    if (resume) args.push('--resume', resume);
    return { command: this.detect().command || bin('claude'), args, stdinPrompt: true };
  },
  parse(evt, emit) {
    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') emit.system({ session_id: evt.session_id, model: evt.model });
        else if (evt.subtype === 'api_retry') emit.system({ retry: evt });
        break;
      case 'stream_event': {
        const e = evt.event || {};
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') emit.text(e.delta.text);
        break;
      }
      case 'assistant':
        for (const b of (evt.message && evt.message.content) || [])
          if (b.type === 'tool_use') emit.tool({ name: b.name, input: b.input });
        break;
      case 'result':
        emit.result({ session_id: evt.session_id, status: evt.subtype });
        break;
    }
  },
};

// ── Gemini ──────────────────────────────────────────────────────────────
const gemini = {
  id: 'gemini',
  label: 'Gemini',
  models: [
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  ],
  detect() { return detectCmd('gemini'); },
  loginHint: 'gemini',
  /** gemini 는 MCP 를 settings 에 등록해두는 방식. 서버 정의를 미리 add 한다(idempotent). */
  ensureMcp(servers) {
    for (const [name, def] of Object.entries(servers)) {
      try {
        if (def.type === 'http' && def.url) {
          execFileSync(bin('gemini'), ['mcp', 'remove', name], { shell: isWin, stdio: 'ignore' });
          execFileSync(bin('gemini'), ['mcp', 'add', name, def.url], { shell: isWin, stdio: 'ignore' });
        } else if (def.command) {
          execFileSync(bin('gemini'), ['mcp', 'remove', name], { shell: isWin, stdio: 'ignore' });
          execFileSync(bin('gemini'), ['mcp', 'add', name, def.command, ...(def.args || [])], { shell: isWin, stdio: 'ignore' });
        }
      } catch (_) {}
    }
  },
  spawnArgs({ level, model, systemPromptFile, resume }) {
    // gemini: 계획=plan(읽기전용), 실행=yolo(자동승인). MCP 는 ensureMcp 로 등록됨.
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--approval-mode', level === 'write' ? 'yolo' : 'plan',
    ];
    if (model) args.push('-m', model);
    if (resume) args.push('-r', 'latest');
    // gemini 는 --append-system-prompt 가 없으므로 시스템 규칙은 프롬프트 앞에 붙여 전달(runner 처리)
    return { command: this.detect().command || bin('gemini'), args, stdinPrompt: true, prependSystem: systemPromptFile };
  },
  parse(evt, emit) {
    switch (evt.type) {
      case 'init':
        emit.system({ session_id: evt.session_id, model: evt.model });
        break;
      case 'message':
        if (evt.role === 'assistant' && typeof evt.content === 'string') {
          if (evt.delta) emit.text(evt.content);
          // 비delta 전체 메시지는 누적 중복 방지 위해 무시
        }
        break;
      case 'tool_call':
      case 'tool':
        emit.tool({ name: evt.name || evt.tool || 'tool', input: evt.args || evt.input });
        break;
      case 'result':
        emit.result({ session_id: null, status: evt.status });
        break;
    }
  },
};

// ── Codex (미설치 환경 — best-effort) ────────────────────────────────────
const codex = {
  id: 'codex',
  label: 'Codex',
  models: [
    { id: 'gpt-5-codex', label: 'gpt-5-codex' },
    { id: 'gpt-5', label: 'gpt-5' },
  ],
  detect() { return detectCmd('codex'); },
  loginHint: 'codex login',
  spawnArgs({ level, model, systemPromptFile, resume }) {
    // codex exec --json. 쓰기=workspace-write, 읽기=read-only 샌드박스.
    const args = ['exec', '--json', '--sandbox', level === 'write' ? 'workspace-write' : 'read-only'];
    if (model) args.push('-m', model);
    if (resume) args.push('--last'); // 직전 세션 이어가기(근사)
    return { command: bin('codex'), args, stdinPrompt: true, prependSystem: systemPromptFile };
  },
  parse(evt, emit) {
    // codex json 이벤트(근사): {type:"item.completed"/"message"/...}
    const t = evt.type || '';
    if (t.includes('message') && (evt.text || evt.content)) emit.text(evt.text || evt.content);
    else if (t.includes('tool') && (evt.name || evt.tool)) emit.tool({ name: evt.name || evt.tool, input: evt.arguments });
    else if (t.includes('completed') || t === 'result' || t === 'turn.completed') emit.result({ session_id: null, status: 'success' });
  },
};

const ADAPTERS = { claude, gemini, codex };

function get(id) { return ADAPTERS[id] || claude; }
function list() { return Object.values(ADAPTERS).map((a) => ({ id: a.id, label: a.label, models: a.models, loginHint: a.loginHint })); }

module.exports = { get, list, ADAPTERS };
