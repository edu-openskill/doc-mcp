'use strict';
const $ = (id) => document.getElementById(id);
const colEl = $('col'), inputEl = $('input'), sendBtn = $('send');
const body = document.body;

let providersData = [];
let current = { provider: 'claude', model: null };
let busy = false;
let curAssistant = null;     // 현재 어시스턴트 블록 element
let curTyping = null;

// ── 유틸 ────────────────────────────────────────────────
function esc(v){return v==null?'':String(v).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));}
function scrollEnd(){const s=document.querySelector('.scroll');if(s)s.scrollTop=s.scrollHeight;}
function clearGreeting(){const g=$('greeting');if(g)g.remove();}
function autoGrow(t){t.style.height='26px';t.style.height=Math.min(t.scrollHeight,150)+'px';}

function addUser(text){clearGreeting();const d=document.createElement('div');d.className='turn';
  d.innerHTML='<div class="u-row"><div class="u-bubble"></div></div>';
  d.querySelector('.u-bubble').textContent=text;colEl.appendChild(d);scrollEnd();}

function newAssistant(){const d=document.createElement('div');d.className='turn';
  const a=document.createElement('div');a.className='a-block';d.appendChild(a);colEl.appendChild(d);
  curAssistant=a;scrollEnd();return a;}

function ensureAssistant(){if(!curAssistant)newAssistant();return curAssistant;}

function showTyping(){removeTyping();const a=ensureAssistant();
  curTyping=document.createElement('div');curTyping.className='typing';
  curTyping.innerHTML='<span class="d"></span><span class="d"></span><span class="d"></span> 작업 중…';
  a.appendChild(curTyping);scrollEnd();}
function removeTyping(){if(curTyping){curTyping.remove();curTyping=null;}}

function appendText(t){const a=ensureAssistant();
  let p=a.querySelector('p.stream');
  if(!p){p=document.createElement('p');p.className='stream';a.insertBefore(p,curTyping||null);}
  p.textContent+=t;scrollEnd();}

function addTool(tool){const a=ensureAssistant();const d=document.createElement('div');d.className='tools';
  const inp=tool.input&&Object.keys(tool.input).length?' · '+esc(JSON.stringify(tool.input)).slice(0,80):'';
  d.innerHTML='🔧 '+esc(tool.name)+inp;a.insertBefore(d,a.firstChild);scrollEnd();}

function setBusy(b){busy=b;sendBtn.textContent=b?'■':'↑';sendBtn.classList.toggle('stop',b);}

// ── 전송/중지/승인/거절 ─────────────────────────────────
async function send(){
  const text=inputEl.value.trim();if(!text||busy)return;
  inputEl.value='';autoGrow(inputEl);
  addUser(text);newAssistant();showTyping();setBusy(true);
  await window.api.send(text);
}
async function stop(){await window.api.stop();removeTyping();finalize();setBusy(false);}
function finalize(){if(curAssistant){const p=curAssistant.querySelector('p.stream');if(p)p.classList.remove('stream');}curAssistant=null;}

async function approve(node){
  node.remove();finalize();
  newAssistant();showTyping();setBusy(true);
  await window.api.approve();
}
async function reject(node){
  const fb=inputEl.value.trim();inputEl.value='';autoGrow(inputEl);
  node.remove();finalize();
  if(fb){addUser('(수정) '+fb);newAssistant();showTyping();setBusy(true);}
  await window.api.reject(fb);
}
function showApprove(){
  removeTyping();const a=ensureAssistant();
  const row=document.createElement('div');row.className='approve';
  row.innerHTML='<span class="q">승인하시겠습니까?</span>'+
    '<button class="btn ok">승인</button><button class="btn no">거절</button>'+
    '<span class="tip">거절 후 수정사항을 입력하면 반영해 다시 검토합니다.</span>';
  row.querySelector('.btn.ok').onclick=()=>approve(row);
  row.querySelector('.btn.no').onclick=()=>reject(row);
  a.appendChild(row);finalize();scrollEnd();
}

sendBtn.onclick=()=>busy?stop():send();
inputEl.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}
  else if(e.key==='Escape'&&busy){e.preventDefault();stop();}
});
inputEl.addEventListener('input',()=>autoGrow(inputEl));

// ── 팝업/선택 ───────────────────────────────────────────
function pop(id){document.querySelectorAll('.pop').forEach(p=>p.id==='pop-'+id?p.classList.toggle('open'):p.classList.remove('open'));}
$('mode-btn').onclick=()=>pop('mode');
$('prov-btn').onclick=()=>pop('prov');
$('model-btn').onclick=()=>pop('model');
document.addEventListener('click',e=>{if(!e.target.closest('.seg'))document.querySelectorAll('.pop').forEach(p=>p.classList.remove('open'));});

document.querySelectorAll('#pop-mode .pi').forEach(pi=>pi.onclick=()=>{
  const m=pi.dataset.mode;body.dataset.mode=m;
  $('mode-name').textContent={auto:'자동',plan:'계획',edit:'편집수락'}[m];
  window.api.setMode(m);pop('mode');});

function renderProviders(){
  const pm=$('pop-prov');pm.innerHTML='';
  providersData.forEach(p=>{
    const d=document.createElement('div');d.className='pi';
    const state=!p.installed?'미설치':(p.loggedIn?'로그인됨':'미로그인');
    d.innerHTML=`<div class="pt"><span class="dot ${p.installed&&p.loggedIn?'ok':'off'}"></span>${esc(p.label)}<span class="sub">${state}</span></div>`;
    d.onclick=()=>selectProvider(p.id);
    pm.appendChild(d);
  });
}
async function selectProvider(id){
  const p=providersData.find(x=>x.id===id);if(!p)return;
  current.provider=id;current.model=p.models[0]?p.models[0].id:null;
  body.dataset.provider=id;
  $('prov-name').textContent=p.label;
  $('prov-dot').className='dot '+(p.installed&&p.loggedIn?'ok':'off');
  // 모델 목록
  const mm=$('pop-model');mm.innerHTML='';
  p.models.forEach(m=>{const d=document.createElement('div');d.className='pi';
    d.innerHTML=`<div class="pt">${esc(m.label)}</div>`;
    d.onclick=()=>{current.model=m.id;$('model-name').textContent=m.label;window.api.setModel(m.id);pop('model');};
    mm.appendChild(d);});
  $('model-name').textContent=p.models[0]?p.models[0].label:'—';
  await window.api.setProvider(id,current.model);
  updateBanner(p);pop('prov');
}
function updateBanner(p){
  const b=$('banner');
  if(!p.installed){b.hidden=false;$('banner-prov').textContent=p.label;
    $('banner-msg').innerHTML=`CLI가 설치되어 있지 않습니다.`;}
  else if(!p.loggedIn){b.hidden=false;$('banner-prov').textContent=p.label;
    $('banner-msg').innerHTML=`로그인이 필요합니다 — 터미널에서 <code>${esc(p.loginHint)}</code> 실행`;}
  else b.hidden=true;
}
$('banner-x').onclick=()=>{$('banner').hidden=true;};

// ── 탭/폴더/새대화 ──────────────────────────────────────
function setTab(t){body.dataset.tab=t;
  $('rail-chat').classList.toggle('active',t==='chat');
  $('rail-data').classList.toggle('active',t==='data');
  if(t==='data')loadTables();}
$('rail-chat').onclick=()=>setTab('chat');
$('rail-data').onclick=()=>setTab('data');
$('rail-new').onclick=async()=>{await window.api.reset();colEl.innerHTML=
  '<div class="greeting" id="greeting"><div class="big">무엇을 도와드릴까요?</div>새 대화입니다.</div>';
  curAssistant=null;setBusy(false);};
$('btn-dir').onclick=async()=>{const d=await window.api.chooseDir();if(d){
  $('folder-chip').innerHTML='📁 <b></b>';$('folder-chip').querySelector('b').textContent=d.split(/[\\/]/).pop();
  $('folder-chip').title=d;}};

// ── 데이터 탭 ───────────────────────────────────────────
const tableSelect=$('table-select'),dataGrid=$('data-grid'),queryInput=$('query-input');
async function loadTables(){const r=await window.api.dbTables();const ts=(r&&r.tables)||[];
  tableSelect.innerHTML='';
  if(!ts.length){dataGrid.innerHTML='<div class="data-empty">아직 데이터가 없습니다. 채팅에서 문서 데이터를 DB로 모아보세요.</div>';return;}
  ts.forEach(t=>{const o=document.createElement('option');o.value=o.textContent=t;tableSelect.appendChild(o);});
  loadRows(tableSelect.value);}
async function loadRows(t){renderGrid(await window.api.dbRows(t,200,0));}
function renderGrid(res){
  if(!res||res.error){dataGrid.innerHTML=`<div class="data-empty">오류: ${res?esc(res.error):'응답 없음'}</div>`;return;}
  const cols=res.columns||[],rows=res.rows||[];
  if(!cols.length){dataGrid.innerHTML='<div class="data-empty">결과 없음</div>';return;}
  const head='<tr>'+cols.map(c=>`<th>${esc(c)}</th>`).join('')+'</tr>';
  const bodyR=rows.map(r=>'<tr>'+cols.map(c=>`<td>${esc(r[c])}</td>`).join('')+'</tr>').join('');
  const meta=res.total!=null?`총 ${res.total}행 (상위 ${rows.length})`:`${rows.length}행`;
  dataGrid.innerHTML=`<div class="dmeta">${meta}</div><table class="grid"><thead>${head}</thead><tbody>${bodyR}</tbody></table>`;}
$('btn-refresh').onclick=loadTables;
tableSelect.onchange=()=>loadRows(tableSelect.value);
queryInput.addEventListener('keydown',async e=>{if(e.key==='Enter'){e.preventDefault();
  const sql=queryInput.value.trim();if(sql)renderGrid(await window.api.dbQuery(sql));}});

// ── 스트리밍 수신 ───────────────────────────────────────
window.api.onText(t=>{removeTyping();appendText(t);});
window.api.onTool(t=>addTool(t));
window.api.onResult(r=>{
  removeTyping();
  if(r.needsApproval){showApprove();setBusy(false);return;}
  finalize();setBusy(false);
});
window.api.onError(m=>{removeTyping();const a=ensureAssistant();
  const p=document.createElement('p');p.style.color='#b6453a';p.textContent='⚠ '+m;a.appendChild(p);
  finalize();setBusy(false);});
window.api.onExit(()=>{if(busy){removeTyping();finalize();setBusy(false);}});
window.api.onSystem(s=>{
  if(s.status){const c=$('conn');c.innerHTML=`<span class="dot ${/준비됨|연결/.test(s.status)?'ok':'off'}"></span>${esc(s.status)}`;}
});

// ── 시작 ────────────────────────────────────────────────
(async()=>{
  const env=await window.api.checkEnv();
  if(env.docDir){$('folder-chip').innerHTML='📁 <b></b>';
    $('folder-chip').querySelector('b').textContent=env.docDir.split(/[\\/]/).pop();$('folder-chip').title=env.docDir;}
  providersData=await window.api.listProviders();
  renderProviders();
  // 기본 제공자: 로그인된 첫 항목, 없으면 설치된 첫 항목, 없으면 claude
  const pick=providersData.find(p=>p.installed&&p.loggedIn)||providersData.find(p=>p.installed)||providersData[0];
  await selectProvider(pick.id);
  $('conn').innerHTML='<span class="dot ok"></span>MCP 준비 중…';
})();
