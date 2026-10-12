const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printSilent: () => ipcRenderer.send('print-silent'),
    reloadApp: (hard) => ipcRenderer.send('reload-app', hard),
    toggleDevTools: () => ipcRenderer.send('toggle-devtools'),
    openDevTools: () => ipcRenderer.send('open-devtools'),
    ensureBackendRunning: () => ipcRenderer.invoke('ensure-backend-running'),
    restartBackend: () => ipcRenderer.invoke('restart-backend'),
    getBackendStatus: () => ipcRenderer.invoke('get-backend-status')
});

