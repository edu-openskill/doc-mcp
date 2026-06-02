'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { ClaudeRunner } = require('./claude-runner');

let mainWindow = null;
let runner = null;
let docDir = os.homedir();

const MCP_CONFIG_PATH = path.join(__dirname, '..', '..', 'mcp.json');

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
  runner = new ClaudeRunner(
    { cwd: docDir, mcpConfig: MCP_CONFIG_PATH },
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

app.whenReady().then(() => {
  createWindow();

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
  if (process.platform !== 'darwin') app.quit();
});
