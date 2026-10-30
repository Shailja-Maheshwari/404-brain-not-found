const { contextBridge, ipcRenderer } = require('electron');

// Secure IPC exposure to the renderer (Student Frontend)
contextBridge.exposeInMainWorld('proctor', {
  getHistory: () => ipcRenderer.invoke('proctor:get-history'),
  getStatus: () => ipcRenderer.invoke('proctor:get-status'),
  reportActivity: (eventType, details) =>
    ipcRenderer.send('proctor:activity', { eventType, details }),
  quitDev: () => ipcRenderer.send('proctor:dev-quit'),
  onEvent: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on('proctor:event', handler);
    return () => ipcRenderer.removeListener('proctor:event', handler);
  },
  onViolation: (callback) => {
    const handler = (_event, info) => callback(info);
    ipcRenderer.on('proctor:violation', handler);
    return () => ipcRenderer.removeListener('proctor:violation', handler);
  },
});
