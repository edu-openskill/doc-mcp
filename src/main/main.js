'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ClaudeRunner } = require('./claude-runner');
const { HwpxServer } = require('./hwpx-server');

let mainWindow = null;
let runner = null;
let docDir = os.homedir();
let hwpxServer = null;

const APP_ROOT = path.join(__dirname, '..', '..');
const SYSTEM_PROMPT_PATH = path.join(APP_ROOT, 'system-prompt.md');
// 런타임 MCP 설정(한컴은 HTTP, 엑셀/워드는 stdio)을 생성해 둘 경로
const RUNTIME_MCP_PATH = path.join(app.getPath('userData'), 'mcp.runtime.json');

function writeRuntimeMcpConfig(hwpUrl) {
  const cfg = {
    mcpServers: {
      hwp: { type: 'http', url: hwpUrl },
      excel: { command: 'npx', args: ['-y', '@negokaz/excel-mcp-server'] },
      docx: { command: 'npx', args: ['-y', '@modelcontextprotocol-server/word'] },
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
    { cwd: docDir, mcpConfig, systemPromptFile: SYSTEM_PROMPT_PATH },
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

  // 사용자 메시지 전송
  ipcMain.handle('chat:send', (_e, text) => {
    const r = ensureRunner();
    r.send(text);
    return true;
  });

  // 진행 중인 생성 중단 (세션은 유지)
  ipcMain.handle('chat:stop', () => {
    if (runner) return runner.interrupt();
    return false;
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
