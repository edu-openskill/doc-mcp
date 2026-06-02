'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { ClaudeRunner } = require('./claude-runner');
const { HwpxServer } = require('./hwpx-server');

let mainWindow = null;
let runner = null;
let docDir = os.homedir();
let hwpxServer = null;

const APP_ROOT = path.join(__dirname, '..', '..');
const PLAN_PROMPT_PATH = path.join(APP_ROOT, 'system-prompt-plan.md');
const EXEC_PROMPT_PATH = path.join(APP_ROOT, 'system-prompt-execute.md');
const DB_SERVER_PATH = path.join(APP_ROOT, 'mcp-servers', 'sqlite_db', 'sqlite_mcp_server.py');
const DB_READ_PATH = path.join(APP_ROOT, 'mcp-servers', 'sqlite_db', 'db_read.py');
// 통합 DB 파일 (MCP 서버 쓰기 / 앱이 직접 읽기). WAL 로 동시접근.
const DB_PATH = path.join(app.getPath('userData'), 'data.db');
// 런타임 MCP 설정(한컴=HTTP, 엑셀/워드=stdio, db=stdio)
const RUNTIME_MCP_PATH = path.join(app.getPath('userData'), 'mcp.runtime.json');

function writeRuntimeMcpConfig(hwpUrl) {
  const cfg = {
    mcpServers: {
      hwp: { type: 'http', url: hwpUrl },
      excel: { command: 'npx', args: ['-y', '@negokaz/excel-mcp-server'] },
      docx: { command: 'npx', args: ['-y', '@modelcontextprotocol-server/word'] },
      db: {
        command: 'python',
        args: ['-u', DB_SERVER_PATH],
        env: { DOC_MCP_DB_PATH: DB_PATH },
      },
    },
  };
  fs.writeFileSync(RUNTIME_MCP_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return RUNTIME_MCP_PATH;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: 'Doc MCP Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/** 렌더러로 이벤트를 보낸다. */
function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function ensureRunner() {
  if (runner) return runner;
  const mcpConfig = writeRuntimeMcpConfig(hwpxServer ? hwpxServer.url : 'http://127.0.0.1:8765/mcp');
  runner = new ClaudeRunner(
    {
      cwd: docDir,
      mcpConfig,
      planPromptFile: PLAN_PROMPT_PATH,
      execPromptFile: EXEC_PROMPT_PATH,
    },
    {
      onSystem: (evt) => emit('claude:system', evt),
      onText: (text) => emit('claude:text', text),
      onTool: (tool) => emit('claude:tool', tool),
      onResult: (evt) => emit('claude:result', evt),
      onError: (msg) => emit('claude:error', msg),
      onExit: (code) => {
        emit('claude:exit', code);
        runner = null;
      },
    }
  );
  return runner;
}

app.whenReady().then(async () => {
  createWindow();

  // 한컴 COM HWPX 서버 기동(HTTP). 파이프 없이 띄워야 COM이 동작한다.
  hwpxServer = new HwpxServer(8765);
  hwpxServer.start((msg) => emit('claude:system', { subtype: 'status', text: msg }))
    .then((ok) => emit('claude:system', {
      subtype: 'status',
      text: ok ? 'hwpx COM 서버 준비됨' : 'hwpx COM 서버 시작 실패(한컴/파이썬 확인)',
    }));

  // 환경 점검
  ipcMain.handle('env:check', () => {
    const env = ClaudeRunner.checkEnvironment();
    return { ...env, docDir };
  });

  // 대시보드: data.db 를 파이썬 헬퍼로 읽어 JSON 반환(읽기 전용)
  const runDbRead = (args) =>
    new Promise((resolve) => {
      execFile(
        'python',
        ['-u', DB_READ_PATH, ...args],
        { env: { ...process.env, DOC_MCP_DB_PATH: DB_PATH, PYTHONIOENCODING: 'utf-8' }, windowsHide: true },
        (err, stdout) => {
          if (err && !stdout) return resolve({ error: String(err.message || err) });
          try { resolve(JSON.parse(stdout)); }
          catch (e) { resolve({ error: 'parse: ' + String(e), raw: stdout }); }
        }
      );
    });
  ipcMain.handle('db:tables', () => runDbRead(['tables']));
  ipcMain.handle('db:rows', (_e, table, limit, offset) =>
    runDbRead(['rows', String(table), String(limit || 100), String(offset || 0)]));
  ipcMain.handle('db:query', (_e, sql) => runDbRead(['query', String(sql)]));

  // 문서 폴더 선택
  ipcMain.handle('dir:choose', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: docDir,
    });
    if (!res.canceled && res.filePaths[0]) {
      docDir = res.filePaths[0];
      // 폴더가 바뀌면 기존 세션을 종료해 새 cwd 로 재시작되게 한다.
      if (runner) {
        runner.stop();
        runner = null;
      }
    }
    return docDir;
  });

  // 사용자 요청 → 계획 단계(읽기 전용, 변경 없음)
  ipcMain.handle('chat:plan', (_e, text) => {
    ensureRunner().runPlan(text);
    return true;
  });

  // 계획 승인 → 실행 단계(쓰기 허용)
  ipcMain.handle('chat:approve', () => {
    if (runner) runner.approveExecute();
    return true;
  });

  // 계획 거절(+선택적 피드백 → 재계획)
  ipcMain.handle('chat:reject', (_e, feedback) => {
    if (runner) runner.reject(feedback);
    return true;
  });

  // 진행 중 단계 중단(세션 유지)
  ipcMain.handle('chat:stop', () => {
    if (runner) runner.stop();
    return true;
  });

  // 세션 초기화
  ipcMain.handle('chat:reset', () => {
    if (runner) {
      runner.stop();
      runner = null;
    }
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (runner) runner.stop();
  if (hwpxServer) hwpxServer.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (hwpxServer) hwpxServer.stop();
});
