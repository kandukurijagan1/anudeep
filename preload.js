const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printSilent: () => ipcRenderer.send('print-silent'),
    reloadApp: (hard) => ipcRenderer.send('reload-app', hard),
    toggleDevTools: () => ipcRenderer.send('toggle-devtools'),
    openDevTools: () => ipcRenderer.send('open-devtools'),
    ensureBackendRunning: () => ipcRenderer.invoke('ensure-backend-running'),
    restartBackend: () => ipcRenderer.invoke('restart-backend'),
    getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
    savePdfToDownloads: (data) => ipcRenderer.invoke('save-pdf-to-downloads', data),
    openFile: (filePath) => ipcRenderer.invoke('open-file', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('show-in-folder', filePath),
    getDownloadsPath: () => ipcRenderer.invoke('get-downloads-path'),
    getAppToken: () => ipcRenderer.invoke('get-app-token'),
    onDownloadCompleted: (callback) => {
        ipcRenderer.on('download-completed', (event, data) => callback(data));
    }
});

