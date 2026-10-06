const { app, BrowserWindow, Menu, Tray, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

// Ensure single instance lock for dedicated workstation
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log('[Electron] Another instance is already running. Focusing existing instance...');
    app.quit();
    process.exit(0);
}

let mainWindow = null;
let splashWindow = null;
let tray = null;
let serverChild = null;
let isQuitting = false;

ipcMain.on('print-silent', (event) => {
    if (mainWindow) {
        mainWindow.webContents.print({ silent: true, printBackground: true, color: false });
    }
});

// Check if local HTTP server is healthy
function checkServer(url, timeout = 800) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

// Find node.exe in common locations or PATH
function findNodeExecutable() {
    const candidates = [
        path.join(__dirname, 'node.exe'),
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs\\node\\node.exe'),
        path.join(process.env.APPDATA || '', 'npm\\node.exe')
    ];

    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }
    return 'node';
}

// Start background Node.js server if not already running
function startBackend() {
    return new Promise((resolve) => {
        try {
            console.log('[Electron] Starting background Node backend...');
            const nodeExe = findNodeExecutable();
            const serverJs = path.join(__dirname, 'server.js');

            try {
                serverChild = spawn(nodeExe, [serverJs], {
                    cwd: __dirname,
                    env: { ...process.env, PORT: '3000' },
                    stdio: 'ignore',
                    windowsHide: true
                });
            } catch (err) {
                console.warn('[Electron] Primary spawn failed, trying process.execPath with ELECTRON_RUN_AS_NODE:', err.message);
                serverChild = spawn(process.execPath, [serverJs], {
                    cwd: __dirname,
                    env: { ...process.env, PORT: '3000', ELECTRON_RUN_AS_NODE: '1' },
                    stdio: 'ignore',
                    windowsHide: true
                });
            }

            if (serverChild) {
                serverChild.on('error', (err) => {
                    console.warn('[Electron] Backend child process error:', err.message);
                });
            }

            // Poll for server readiness up to 10 seconds
            let attempts = 0;
            const interval = setInterval(async () => {
                attempts++;
                const ready = await checkServer('http://localhost:3000/api/health', 500);
                if (ready || attempts > 20) {
                    clearInterval(interval);
                    resolve(ready);
                }
            }, 500);
        } catch (e) {
            console.warn('[Electron] Error launching backend:', e.message);
            resolve(false);
        }
    });
}

// Setup System Tray icon and workstation menu
function createSystemTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    if (!fs.existsSync(iconPath)) return;

    try {
        tray = new Tray(iconPath);
        const contextMenu = Menu.buildFromTemplate([
            {
                label: '📌 Open Dedicated Workstation',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            },
            { type: 'separator' },
            {
                label: '🧾 New Invoice (F2)',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                        mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') { UI.show('billing-view'); setTimeout(function(){ var el = document.getElementById('b-rn'); if(el) el.focus(); }, 100); }");
                    }
                }
            },
            {
                label: '📜 Invoice History (Ctrl+H)',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                        mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') UI.show('invoices-view');");
                    }
                }
            },
            {
                label: '🔄 Refresh & Sync Cloud Data',
                click: () => {
                    if (mainWindow) {
                        mainWindow.webContents.executeJavaScript("if (typeof App !== 'undefined' && App.load) { App.load(); U.toast('Synchronizing with database...', 'info'); }");
                    }
                }
            },
            { type: 'separator' },
            {
                label: '❌ Exit Application',
                click: () => {
                    isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('Anudeep Khadi Bandar - Dedicated GST Workstation');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });
    } catch (err) {
        console.warn('[Electron] Could not initialize tray:', err.message);
    }
}

// Build dedicated Workstation Menu with POS hotkeys
function setupApplicationMenu() {
    const template = [
        {
            label: 'POS Workstation',
            submenu: [
                {
                    label: 'New Invoice',
                    accelerator: 'F2',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') { UI.show('billing-view'); setTimeout(function(){ var el = document.getElementById('b-rn'); if(el) el.focus(); }, 100); }");
                        }
                    }
                },
                {
                    label: 'Jump to Product Selection',
                    accelerator: 'F4',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') { UI.show('billing-view'); setTimeout(function(){ var el = document.getElementById('b-pn'); if(el) el.focus(); }, 100); }");
                        }
                    }
                },
                {
                    label: 'Save & Print Invoice',
                    accelerator: 'F8',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.executeJavaScript("if (typeof BM !== 'undefined' && BM.save) BM.save();");
                        }
                    }
                },
                {
                    label: 'Invoice History',
                    accelerator: 'CmdOrCtrl+H',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') UI.show('invoices-view');");
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Print Active Document',
                    accelerator: 'CmdOrCtrl+P',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.webContents.executeJavaScript("if (typeof handleCtrlP === 'function') { handleCtrlP(); } else { window.print(); }");
                        }
                    }
                },
                {
                    label: 'Reload App',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => {
                        if (mainWindow) mainWindow.reload();
                    }
                },
                {
                    label: 'Toggle Fullscreen',
                    accelerator: 'F11',
                    click: () => {
                        if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
                    }
                },
                { type: 'separator' },
                {
                    label: 'Exit Workstation',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        isQuitting = true;
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'toggledevtools' }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// Create dedicated application window
async function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 850,
        minWidth: 1024,
        minHeight: 650,
        title: 'Anudeep Khadi Bandar - GST Billing Workstation',
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#f3f4f6',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Workstation maximized desktop layout
    mainWindow.maximize();

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    // Check if server is already running
    const isRunning = await checkServer('http://localhost:3000/api/health', 1000);
    if (isRunning) {
        console.log('[Electron] Connected to existing server on port 3000');
        await mainWindow.loadURL('http://localhost:3000?mode=dedicated_app');
    } else {
        const started = await startBackend();
        if (started) {
            console.log('[Electron] Connected to newly started backend on port 3000');
            await mainWindow.loadURL('http://localhost:3000?mode=dedicated_app');
        } else {
            console.log('[Electron] Falling back to local index.html with Cloud GAS sync');
            await mainWindow.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'dedicated_app' } });
        }
    }

    // Intercept external links (WhatsApp, Telegram, Google Sheets, external URLs)
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://wa.me') ||
            url.startsWith('https://api.whatsapp.com') ||
            url.startsWith('https://web.whatsapp.com') ||
            url.startsWith('https://t.me') ||
            url.startsWith('https://docs.google.com') ||
            url.startsWith('https://script.google.com')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            // Minimize or clean close
            // On desktop, user can exit via Tray or Menu
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Single instance handler: bring window to front
app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
});

app.whenReady().then(() => {
    setupApplicationMenu();
    createSystemTray();
    createMainWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (serverChild) {
        try {
            console.log('[Electron] Terminating background server process...');
            serverChild.kill();
        } catch (_) {}
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
