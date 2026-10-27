const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickWorkspace: () => ipcRenderer.invoke('dialog:pickWorkspace'),
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),
  stopAgent: () => ipcRenderer.send('agent:stop'),
  respondApproval: (id, ok) => ipcRenderer.send('agent:approval', { id, ok }),
  onAgentEvent: (cb) => {
    ipcRenderer.on('agent:event', (_e, data) => cb(data));
  },
});
