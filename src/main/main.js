'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { AgentRunner } = require('./agent-runner');
const providers = require('./providers');
const { HwpxServer } = require('./hwpx-server');

let mainWindow = null;
let runner = null;
let hwpxServer = null;

let docDir = os.homedir();
let providerId = 'claude';
let model = null;
let mode = 'auto'; // auto | plan | edit

const APP_ROOT = path.join(__dirname, '..', '..');
const AUTO_PROMPT = path.join(APP_ROOT, 'system-prompt-auto.md');
const PLAN_PROMPT = path.join(APP_ROOT, 'system-prompt-plan.md');
const EXEC_PROMPT = path.join(APP_ROOT, 'system-prompt-execute.md');
const DB_SERVER = path.join(APP_ROOT, 'mcp-servers', 'sqlite_db', 'sqlite_mcp_server.py');
const DB_READ = path.join(APP_ROOT, 'mcp-servers', 'sqlite_db', 'db_read.py');
const DB_PATH = path.join(app.getPath('userData'), 'data.db');
const RUNTIME_MCP = path.join(app.getPath('userData'), 'mcp.runtime.json');

function mcpServers() {
  const hwpUrl = hwpxServer ? hwpxServer.url : 'http://127.0.0.1:8765/mcp';
  return {
    hwp: { type: 'http', url: hwpUrl },
    excel: { command: 'npx', args: ['-y', '@negokaz/excel-mcp-server'] },
    docx: { command: 'npx', args: ['-y', '@modelcontextprotocol-server/word'] },
    db: { command: 'python', args: ['-u', DB_SERVER], env: { DOC_MCP_DB_PATH: DB_PATH } },
  };
}

function writeMcpConfig() {
  const cfg = { mcpServers: mcpServers() };
  fs.writeFileSync(RUNTIME_MCP, JSON.stringify(cfg, null, 2), 'utf8');
  return RUNTIME_MCP;
}

/** 로그인 사전점검(휴리스틱): 자격증명 파일/환경변수 존재 여부 */
function loginState(id) {
  const home = os.homedir();
  const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };
  if (id === 'claude')
    return exists(path.join(home, '.claude', '.credentials.json')) || exists(path.join(home, '.claude.json')) || !!process.env.ANTHROPIC_API_KEY;
  if (id === 'gemini')
    return exists(path.join(home, '.gemini', 'oauth_creds.json')) || exists(path.join(home, '.gemini', 'google_accounts.json')) || !!process.env.GEMINI_API_KEY;
  if (id === 'codex')
    return exists(path.join(home, '.codex', 'auth.json')) || !!process.env.OPENAI_API_KEY;
  return false;
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080, height: 760, minWidth: 720, title: 'Doc MCP',
    backgroundColor: '#faf9f5',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function ensureRunner() {
  if (runner) return runner;
  runner = new AgentRunner(
    {
      cwd: docDir, mcpConfig: writeMcpConfig(),
      providerId, model, mode,
      autoPromptFile: AUTO_PROMPT, planPromptFile: PLAN_PROMPT, execPromptFile: EXEC_PROMPT,
    },
    {
      onSystem: (s) => emit('agent:system', s),
      onText: (t) => emit('agent:text', t),
      onTool: (t) => emit('agent:tool', t),
      onResult: (r) => emit('agent:result', r),
      onError: (m) => emit('agent:error', m),
      onExit: (p) => emit('agent:exit', p),
    }
  );
  return runner;
}

app.whenReady().then(() => {
  createWindow();

  hwpxServer = new HwpxServer(8765);
  hwpxServer.start((msg) => emit('agent:system', { status: msg }))
    .then((ok) => emit('agent:system', { status: ok ? 'hwp COM 서버 준비됨' : 'hwp COM 서버 시작 실패(한컴/파이썬 확인)' }));

  // 제공자 목록 + 설치/로그인 상태
  ipcMain.handle('providers:list', () => providers.list().map((p) => {
    const det = providers.get(p.id).detect();
    return { ...p, installed: det.installed, version: det.version || '', loggedIn: det.installed && loginState(p.id) };
  }));

  ipcMain.handle('provider:set', (_e, id, m) => {
    providerId = id; model = m || null;
    if (runner) { runner.setProvider(id); runner.setModel(model); }
    // gemini 는 MCP 를 사전 등록
    if (id === 'gemini') { try { providers.get('gemini').ensureMcp(mcpServers()); } catch (_) {} }
    return { installed: providers.get(id).detect().installed, loggedIn: loginState(id) };
  });
  ipcMain.handle('model:set', (_e, m) => { model = m; if (runner) runner.setModel(m); return true; });
  ipcMain.handle('mode:set', (_e, m) => { mode = m; if (runner) runner.setMode(m); return true; });

  ipcMain.handle('chat:send', (_e, text) => { ensureRunner().send(text); return true; });
  ipcMain.handle('chat:approve', () => { if (runner) runner.approve(); return true; });
  ipcMain.handle('chat:reject', (_e, fb) => { if (runner) runner.reject(fb); return true; });
  ipcMain.handle('chat:stop', () => { if (runner) runner.stop(); return true; });
  ipcMain.handle('chat:reset', () => { if (runner) { runner.stop(); runner = null; } return true; });

  ipcMain.handle('dir:choose', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: docDir });
    if (!res.canceled && res.filePaths[0]) {
      docDir = res.filePaths[0];
      if (runner) { runner.stop(); runner = null; }
    }
    return docDir;
  });
  ipcMain.handle('env:check', () => ({ docDir, providerId, mode, model }));

  // 대시보드 DB 읽기
  const dbRead = (args) => new Promise((resolve) => {
    execFile('python', ['-u', DB_READ, ...args],
      { env: { ...process.env, DOC_MCP_DB_PATH: DB_PATH, PYTHONIOENCODING: 'utf-8' }, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: String(err.message || err) });
        try { resolve(JSON.parse(stdout)); } catch (e) { resolve({ error: 'parse', raw: stdout }); }
      });
  });
  ipcMain.handle('db:tables', () => dbRead(['tables']));
  ipcMain.handle('db:rows', (_e, t, l, o) => dbRead(['rows', String(t), String(l || 100), String(o || 0)]));
  ipcMain.handle('db:query', (_e, sql) => dbRead(['query', String(sql)]));

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (runner) runner.stop();
  if (hwpxServer) hwpxServer.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { if (hwpxServer) hwpxServer.stop(); });
