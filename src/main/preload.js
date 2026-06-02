'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 설정/상태
  checkEnv: () => ipcRenderer.invoke('env:check'),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  setProvider: (id, model) => ipcRenderer.invoke('provider:set', id, model),
  setModel: (m) => ipcRenderer.invoke('model:set', m),
  setMode: (m) => ipcRenderer.invoke('mode:set', m),
  chooseDir: () => ipcRenderer.invoke('dir:choose'),

  // 대화
  send: (text) => ipcRenderer.invoke('chat:send', text),
  approve: () => ipcRenderer.invoke('chat:approve'),
  reject: (fb) => ipcRenderer.invoke('chat:reject', fb),
  stop: () => ipcRenderer.invoke('chat:stop'),
  reset: () => ipcRenderer.invoke('chat:reset'),

  // 데이터(대시보드)
  dbTables: () => ipcRenderer.invoke('db:tables'),
  dbRows: (t, l, o) => ipcRenderer.invoke('db:rows', t, l, o),
  dbQuery: (sql) => ipcRenderer.invoke('db:query', sql),

  // 스트리밍 이벤트
  onSystem: (cb) => ipcRenderer.on('agent:system', (_e, v) => cb(v)),
  onText: (cb) => ipcRenderer.on('agent:text', (_e, v) => cb(v)),
  onTool: (cb) => ipcRenderer.on('agent:tool', (_e, v) => cb(v)),
  onResult: (cb) => ipcRenderer.on('agent:result', (_e, v) => cb(v)),
  onError: (cb) => ipcRenderer.on('agent:error', (_e, v) => cb(v)),
  onExit: (cb) => ipcRenderer.on('agent:exit', (_e, v) => cb(v)),
});
