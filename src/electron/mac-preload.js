// SPDX-License-Identifier: GPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shortDramaDesktop', {
  send: (message, point) => ipcRenderer.send('shortdrama:command', message, point),
  onMessage: listener => {
    const receive = (_event, message) => listener(message);
    ipcRenderer.on('shortdrama:state', receive);
    return () => ipcRenderer.removeListener('shortdrama:state', receive);
  }
});
