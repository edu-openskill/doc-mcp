'use strict';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const statusEl = $('status');
const dirLabel = $('dir-label');

let currentAssistant = null; // 스트리밍 중인 assistant 말풍선
let busy = false;
const sendBtn = $('btn-send');

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('show', !!text);
  statusEl.classList.toggle('error', !!isError);
}

/** 생성 중에는 전송 버튼을 '중지'로 바꾼다. */
function setBusy(state) {
  busy = state;
  if (state) {
    sendBtn.textContent = '■ 중지';
    sendBtn.classList.add('stop');
  } else {
    sendBtn.textContent = '전송';
    sendBtn.classList.remove('stop');
  }
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
  setBusy(true);
  setStatus('생각 중… (중지하려면 ■ 중지 또는 Esc)');
  finishAssistant();
  await window.api.send(text);
}

// ── 중지 (진행 중 생성만 중단, 세션은 유지) ─────────────
async function stop() {
  if (!busy) return;
  setStatus('중지하는 중…');
  await window.api.stop();
  // result(error_during_execution) 이벤트가 와서 setBusy(false) 처리됨.
  // 혹시 이벤트가 늦거나 누락돼도 UI가 멈추지 않도록 안전망:
  setTimeout(() => {
    if (busy) {
      finishAssistant();
      setBusy(false);
      setStatus('중지됨');
    }
  }, 1500);
}

// ── 이벤트 바인딩 ───────────────────────────────────────
// 전송 버튼은 생성 중에는 '중지'로 동작한다.
sendBtn.addEventListener('click', () => (busy ? stop() : send()));

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    stop();
  }
});

// 입력창 밖에서도 Esc 로 중지
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && busy) {
    e.preventDefault();
    stop();
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
  setBusy(false);
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

window.api.onResult((evt) => {
  finishAssistant();
  setBusy(false);
  setStatus(evt && evt.subtype === 'error_during_execution' ? '중지됨' : '');
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
  setBusy(false);
  addMessage('error', '⚠ ' + msg);
  setStatus('오류', true);
});

window.api.onExit((code) => {
  finishAssistant();
  setBusy(false);
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
