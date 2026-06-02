'use strict';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const statusEl = $('status');
const dirLabel = $('dir-label');

let currentAssistant = null; // 스트리밍 중인 assistant 말풍선
let busy = false;

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('show', !!text);
  statusEl.classList.toggle('error', !!isError);
}

function clearHint() {
  const hint = messagesEl.querySelector('.hint');
  if (hint) hint.remove();
}

function addMessage(cls, text) {
  clearHint();
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.textContent = text || '';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function appendToAssistant(text) {
  if (!currentAssistant) {
    currentAssistant = addMessage('assistant', '');
    currentAssistant.classList.add('blink');
  }
  currentAssistant.textContent += text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finishAssistant() {
  if (currentAssistant) currentAssistant.classList.remove('blink');
  currentAssistant = null;
}

// ── 전송 ────────────────────────────────────────────────
async function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  addMessage('user', text);
  busy = true;
  setStatus('생각 중…');
  finishAssistant();
  await window.api.send(text);
}

// ── 이벤트 바인딩 ───────────────────────────────────────
$('btn-send').addEventListener('click', send);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

$('btn-dir').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (dir) {
    dirLabel.textContent = dir;
    dirLabel.title = dir;
    setStatus('문서 폴더: ' + dir);
  }
});

$('btn-reset').addEventListener('click', async () => {
  await window.api.reset();
  finishAssistant();
  messagesEl.innerHTML = '';
  addMessage('assistant', '새 대화를 시작합니다.');
  busy = false;
  setStatus('');
});

// ── 메인 프로세스 스트리밍 수신 ─────────────────────────
window.api.onText((t) => {
  appendToAssistant(t);
});

window.api.onTool((tool) => {
  const label = `🔧 ${tool.name}`;
  const detail =
    tool.input && Object.keys(tool.input).length
      ? '\n' + JSON.stringify(tool.input, null, 2)
      : '';
  addMessage('tool', label + detail);
});

window.api.onResult(() => {
  finishAssistant();
  busy = false;
  setStatus('');
});

window.api.onSystem((evt) => {
  if (evt.subtype === 'init') {
    setStatus('세션 준비됨 · 모델: ' + (evt.model || '?'));
  } else if (evt.subtype === 'api_retry') {
    setStatus(`재시도 중 (${evt.attempt}/${evt.max_retries})…`);
  }
});

window.api.onError((msg) => {
  finishAssistant();
  busy = false;
  addMessage('error', '⚠ ' + msg);
  setStatus('오류', true);
});

window.api.onExit((code) => {
  finishAssistant();
  busy = false;
  if (code && code !== 0) {
    setStatus('claude 프로세스 종료 (code ' + code + ')', true);
  }
});

// ── 시작 시 환경 점검 ───────────────────────────────────
(async () => {
  const env = await window.api.checkEnv();
  if (env.docDir) {
    dirLabel.textContent = env.docDir;
    dirLabel.title = env.docDir;
  }
  if (!env.ok) {
    addMessage('error', '⚠ ' + env.message);
  } else {
    setStatus('claude 준비됨 · ' + (env.version || ''));
  }
})();
