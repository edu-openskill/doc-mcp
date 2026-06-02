'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 렌더러에 노출하는 안전한 브리지 (contextIsolation 유지)
contextBridge.exposeInMainWorld('api', {
  // 요청/응답
  checkEnv: () => ipcRenderer.invoke('env:check'),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  send: (text) => ipcRenderer.invoke('chat:send', text),
  reset: () => ipcRenderer.invoke('chat:reset'),

  // 스트리밍 이벤트 구독
  onSystem: (cb) => ipcRenderer.on('claude:system', (_e, v) => cb(v)),
  onText: (cb) => ipcRenderer.on('claude:text', (_e, v) => cb(v)),
  onTool: (cb) => ipcRenderer.on('claude:tool', (_e, v) => cb(v)),
  onResult: (cb) => ipcRenderer.on('claude:result', (_e, v) => cb(v)),
  onError: (cb) => ipcRenderer.on('claude:error', (_e, v) => cb(v)),
  onExit: (cb) => ipcRenderer.on('claude:exit', (_e, v) => cb(v)),
});
