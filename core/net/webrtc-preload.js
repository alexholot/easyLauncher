'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rtcBridge', {
  send: (msg) => ipcRenderer.send('rtc:event', msg),
  on: (fn) => ipcRenderer.on('rtc:cmd', (_e, cmd) => fn(cmd)),
});
