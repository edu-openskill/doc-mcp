'use strict';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const statusEl = $('status');
const dirLabel = $('dir-label');
const sendBtn = $('btn-send');
const approvalBar = $('approval-bar');

let currentAssistant = null;
// idle | planning | awaiting | executing
let phase = 'idle';

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('show', !!text);
  statusEl.classList.toggle('error', !!isError);
}

function setPhase(p) {
  phase = p;
  const busy = p === 'planning' || p === 'executing';
  sendBtn.textContent = busy ? '■ 중지' : '계획';
  sendBtn.classList.toggle('stop', busy);
  approvalBar.hidden = p !== 'awaiting';
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

function appendToAssistant(text, cls) {
  if (!currentAssistant) {
    currentAssistant = addMessage(cls || 'assistant', '');
    currentAssistant.classList.add('blink');
  }
  currentAssistant.textContent += text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finishAssistant() {
  if (currentAssistant) currentAssistant.classList.remove('blink');
  currentAssistant = null;
}

// ── 전송(계획 요청) / 중지 ───────────────────────────────
async function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  if (phase === 'planning' || phase === 'executing') return; // 진행 중이면 무시
  inputEl.value = '';
  addMessage('user', text);
  finishAssistant();
  setPhase('planning');
  setStatus('계획을 세우는 중… (변경하지 않음)');
  await window.api.plan(text);
}

async function stop() {
  await window.api.stop();
  finishAssistant();
  setPhase('idle');
  setStatus('중지됨');
}

async function approve() {
  finishAssistant();
  setPhase('executing');
  setStatus('승인됨 · 실행 중…');
  addMessage('phase', '▶ 실행 단계');
  await window.api.approve();
}

async function reject() {
  const feedback = inputEl.value.trim();
  inputEl.value = '';
  finishAssistant();
  if (feedback) {
    addMessage('user', '(수정 요청) ' + feedback);
    setPhase('planning');
    setStatus('피드백 반영해 다시 계획 중…');
  } else {
    addMessage('phase', '✗ 계획 거절됨');
    setPhase('idle');
    setStatus('');
  }
  await window.api.reject(feedback);
}

// ── 버튼/키 바인딩 ───────────────────────────────────────
sendBtn.addEventListener('click', () =>
  phase === 'planning' || phase === 'executing' ? stop() : send()
);
$('btn-approve').addEventListener('click', approve);
$('btn-reject').addEventListener('click', reject);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape' && (phase === 'planning' || phase === 'executing')) {
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
  setPhase('idle');
  setStatus('');
});

// ── 스트리밍 수신 ────────────────────────────────────────
window.api.onText((t) => appendToAssistant(t, phase === 'planning' ? 'plan' : 'assistant'));

window.api.onTool((tool) => {
  const detail =
    tool.input && Object.keys(tool.input).length
      ? '\n' + JSON.stringify(tool.input, null, 2)
      : '';
  addMessage('tool', `🔧 ${tool.name}` + detail);
});

window.api.onResult((evt) => {
  finishAssistant();
  if (evt.phase === 'planning') {
    setPhase('awaiting');
    setStatus('계획 검토 후 승인/거절하세요.');
  } else if (evt.phase === 'executing') {
    setPhase('idle');
    setStatus('완료됨');
  } else if (evt.phase === 'rejected') {
    setPhase('idle');
    setStatus('');
  } else {
    setPhase('idle');
    setStatus('');
  }
});

window.api.onSystem((evt) => {
  if (evt.subtype === 'init') {
    const label = evt.phase === 'planning' ? '계획' : evt.phase === 'executing' ? '실행' : '';
    setStatus(`세션 준비됨${label ? ' · ' + label + ' 단계' : ''}`);
  } else if (evt.subtype === 'api_retry') {
    setStatus(`재시도 중 (${evt.attempt}/${evt.max_retries})…`);
  } else if (evt.subtype === 'status') {
    setStatus(evt.text);
  }
});

window.api.onError((msg) => {
  finishAssistant();
  setPhase('idle');
  addMessage('error', '⚠ ' + msg);
  setStatus('오류', true);
});

window.api.onExit(() => {
  // 단계 종료는 onResult 에서 처리. 비정상 종료 시 안전망:
  if (phase === 'planning' || phase === 'executing') {
    finishAssistant();
    setPhase('idle');
  }
});

// ── 데이터 대시보드 ──────────────────────────────────────
const viewData = $('view-data');
const composerEl = document.querySelector('.composer');
const tableSelect = $('table-select');
const dataGrid = $('data-grid');
const queryInput = $('query-input');

function switchTab(tab) {
  const data = tab === 'data';
  $('tab-chat').classList.toggle('active', !data);
  $('tab-data').classList.toggle('active', data);
  messagesEl.hidden = data;
  composerEl.hidden = data;
  approvalBar.hidden = data || phase !== 'awaiting';
  viewData.hidden = !data;
  if (data) loadTables();
}

async function loadTables() {
  const res = await window.api.dbTables();
  const tables = (res && res.tables) || [];
  tableSelect.innerHTML = '';
  if (!tables.length) {
    dataGrid.innerHTML = '<div class="data-empty">아직 데이터가 없습니다. 채팅에서 문서 데이터를 DB로 모아보세요.</div>';
    return;
  }
  for (const t of tables) {
    const opt = document.createElement('option');
    opt.value = opt.textContent = t;
    tableSelect.appendChild(opt);
  }
  loadRows(tableSelect.value);
}

async function loadRows(table) {
  const res = await window.api.dbRows(table, 200, 0);
  renderGrid(res);
}

function renderGrid(res) {
  if (!res || res.error) {
    dataGrid.innerHTML = `<div class="data-empty">오류: ${res ? res.error : '응답 없음'}</div>`;
    return;
  }
  const cols = res.columns || [];
  const rows = res.rows || [];
  if (!cols.length) {
    dataGrid.innerHTML = '<div class="data-empty">결과 없음</div>';
    return;
  }
  const head = '<tr>' + cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr>';
  const body = rows
    .map((r) => '<tr>' + cols.map((c) => `<td>${esc(r[c])}</td>`).join('') + '</tr>')
    .join('');
  const meta = res.total != null ? `총 ${res.total}행 (상위 ${rows.length})` : `${rows.length}행`;
  dataGrid.innerHTML = `<div class="data-meta">${meta}</div><table class="grid"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

$('tab-chat').addEventListener('click', () => switchTab('chat'));
$('tab-data').addEventListener('click', () => switchTab('data'));
$('btn-refresh').addEventListener('click', loadTables);
tableSelect.addEventListener('change', () => loadRows(tableSelect.value));
queryInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const sql = queryInput.value.trim();
    if (sql) renderGrid(await window.api.dbQuery(sql));
  }
});

// ── 시작 점검 ────────────────────────────────────────────
(async () => {
  const env = await window.api.checkEnv();
  if (env.docDir) {
    dirLabel.textContent = env.docDir;
    dirLabel.title = env.docDir;
  }
  if (!env.ok) addMessage('error', '⚠ ' + env.message);
  else setStatus('claude 준비됨 · ' + (env.version || ''));
  setPhase('idle');
})();
