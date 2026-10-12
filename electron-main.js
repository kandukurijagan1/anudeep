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
let isStartingBackend = false;
let startBackendPromise = null;

ipcMain.on('print-silent', (event) => {
    if (mainWindow) {
        mainWindow.webContents.print({ silent: true, printBackground: true, color: false });
    }
});

ipcMain.on('reload-app', async (event, hard) => {
    if (mainWindow) {
        if (hard) {
            try { await mainWindow.webContents.session.clearCache(); } catch (_) {}
        }
        mainWindow.webContents.reloadIgnoringCache();
    }
});

ipcMain.on('toggle-devtools', () => {
    if (mainWindow) {
        mainWindow.webContents.toggleDevTools();
    }
});

ipcMain.on('open-devtools', () => {
    if (mainWindow) {
        mainWindow.webContents.openDevTools({ mode: 'right' });
    }
});

// IPC Handler: Frontend requests ensuring the backend is active
ipcMain.handle('ensure-backend-running', async () => {
    const healthy = await checkServer('http://127.0.0.1:3000/api/health', 800);
    if (healthy) return { running: true, message: 'Server is already running' };
    const started = await startBackend();
    return { running: started, message: started ? 'Server started successfully' : 'Failed to start server' };
});

ipcMain.handle('restart-backend', async () => {
    if (serverChild) {
        try { serverChild.kill(); } catch (_) {}
        serverChild = null;
    }
    const started = await startBackend();
    return { running: started };
});

ipcMain.handle('get-backend-status', async () => {
    const healthy = await checkServer('http://127.0.0.1:3000/api/health', 800);
    return { running: healthy };
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

// Find real node.exe executable path across all standard Windows locations and PATH
function findNodeExecutable() {
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\ADMIN';
    const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');

    const candidates = [
        path.join(__dirname, 'node.exe'),
        'C:\\Program Files\\nodejs\\node.exe',
        'C:\\Program Files (x86)\\nodejs\\node.exe',
        path.join(localAppData, 'Programs', 'node', 'node.exe'),
        path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
        path.join(appData, 'npm', 'node.exe'),
        path.join(appData, 'nvm', 'node.exe'),
        path.join(userProfile, '.nvm', 'versions', 'node', 'node.exe')
    ];

    for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
    }

    // Search directories in PATH environment variable
    const pathEnv = process.env.PATH || '';
    const pathDirs = pathEnv.split(path.delimiter);
    for (const dir of pathDirs) {
        if (!dir) continue;
        const target = path.join(dir.trim(), 'node.exe');
        if (fs.existsSync(target)) return target;
    }

    return null;
}

// Start background Node.js server with watchdog & auto-recovery
function startBackend() {
    if (isStartingBackend && startBackendPromise) {
        return startBackendPromise;
    }
    isStartingBackend = true;

    startBackendPromise = (async () => {
        try {
            // Check if already healthy first
            const alreadyUp = await checkServer('http://127.0.0.1:3000/api/health', 800);
            if (alreadyUp) {
                console.log('[Electron] Backend is already running on port 3000.');
                isStartingBackend = false;
                return true;
            }

            console.log('[Electron] Starting background Node backend...');
            const serverJs = path.join(__dirname, 'server.js');

            let stdioConfig = 'ignore';
            try {
                const logDir = path.join(app.getPath('appData'), 'AnudeepKhadiBandar');
                if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
                const logPath = path.join(logDir, 'server.log');
                const logFile = fs.openSync(logPath, 'a');
                stdioConfig = ['ignore', logFile, logFile];
            } catch (err) {
                console.warn('[Electron] Could not open log file, using default stdio:', err.message);
                stdioConfig = 'ignore';
            }

            const nodeExe = findNodeExecutable();
            const useNode = (nodeExe && fs.existsSync(nodeExe));
            const execBinary = useNode ? nodeExe : process.execPath;
            const extraEnv = useNode ? {} : { ELECTRON_RUN_AS_NODE: '1' };

            console.log(`[Electron] Launching backend server with: ${execBinary} (useNode: ${useNode})`);
            serverChild = spawn(execBinary, [serverJs], {
                cwd: __dirname,
                env: { ...process.env, PORT: '3000', ...extraEnv },
                stdio: stdioConfig,
                windowsHide: true
            });

            if (serverChild) {
                serverChild.on('error', (err) => {
                    console.warn('[Electron] Backend child process error:', err.message);
                });
                serverChild.on('exit', (code, signal) => {
                    console.warn(`[Electron] Backend server exited (code: ${code}, signal: ${signal}).`);
                    serverChild = null;
                    if (!isQuitting) {
                        setTimeout(() => {
                            if (!isQuitting) {
                                console.log('[Electron Watchdog] Auto-recovering exited backend server...');
                                startBackend();
                            }
                        }, 2500);
                    }
                });
            }

            // High-speed polling: check every 100ms for instant readiness (up to 150 attempts)
            for (let attempt = 1; attempt <= 150; attempt++) {
                await new Promise(r => setTimeout(r, 100));
                const ready = await checkServer('http://127.0.0.1:3000/api/health', 150);
                if (ready) {
                    console.log(`[Electron] Backend verified ready in ${attempt * 100}ms`);
                    isStartingBackend = false;
                    return true;
                }
            }

            console.warn('[Electron] Backend startup polling timed out after 15 seconds.');
            isStartingBackend = false;
            return false;
        } catch (e) {
            console.warn('[Electron] Error launching backend:', e.message);
            isStartingBackend = false;
            return false;
        }
    })();

    return startBackendPromise;
}

// 🛡️ BACKGROUND SUPERVISOR: Keep backend alive at all times
setInterval(async () => {
    if (isQuitting || isStartingBackend) return;
    const alive = await checkServer('http://127.0.0.1:3000/api/health', 1000);
    if (!alive && !isQuitting && !isStartingBackend) {
        console.log('[Electron Supervisor] Backend detected offline. Automatically reviving...');
        startBackend();
    }
}, 8000);

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

// Build dedicated Workstation Menu with POS hotkeys & full reload accelerators
function setupApplicationMenu() {
    const template = [
        {
            label: 'POS Workstation',
            submenu: [
                {
                    label: '🧾 New Invoice',
                    accelerator: 'F2',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.show();
                            mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') { UI.show('billing-view'); setTimeout(function(){ var el = document.getElementById('b-rn'); if(el) el.focus(); }, 100); }");
                        }
                    }
                },
                {
                    label: '📜 Invoice History',
                    accelerator: 'CmdOrCtrl+H',
                    click: () => {
                        if (mainWindow) {
                            mainWindow.show();
                            mainWindow.webContents.executeJavaScript("if (typeof UI !== 'undefined') UI.show('invoices-view');");
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: '🔄 Reload Window',
                    accelerator: 'CmdOrCtrl+R',
                    click: (item, focusedWindow) => {
                        if (focusedWindow) focusedWindow.webContents.reloadIgnoringCache();
                    }
                },
                {
                    label: '🔄 Force Reload (F5)',
                    accelerator: 'F5',
                    click: (item, focusedWindow) => {
                        if (focusedWindow) focusedWindow.webContents.reloadIgnoringCache();
                    }
                },
                {
                    label: '⚡ Hard Reset & Clear Cache',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: async (item, focusedWindow) => {
                        if (focusedWindow) {
                            try { await focusedWindow.webContents.session.clearCache(); } catch (_) {}
                            focusedWindow.webContents.reloadIgnoringCache();
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: 'Toggle Developer Tools (Inspect)',
                    accelerator: 'F12',
                    click: (item, focusedWindow) => {
                        if (focusedWindow) focusedWindow.webContents.toggleDevTools();
                    }
                },
                {
                    label: 'Developer Tools (Ctrl+Shift+I)',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: (item, focusedWindow) => {
                        if (focusedWindow) focusedWindow.webContents.toggleDevTools();
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
                { role: 'togglefullscreen' }
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
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.setMenuBarVisibility(false);

    // Workstation maximized desktop layout
    mainWindow.maximize();

    mainWindow.once('ready-to-show', async () => {
        try {
            await mainWindow.webContents.session.clearCache();
            console.log('[Electron] Cleared web cache to ensure latest UI.');
        } catch (e) {
            console.warn('[Electron] Failed to clear cache', e);
        }
        mainWindow.show();
        mainWindow.focus();
    });

    // Check if server is ready
    let isRunning = false;
    if (startBackendPromise) {
        isRunning = await startBackendPromise;
    } else {
        isRunning = await checkServer('http://127.0.0.1:3000/api/health', 300);
        if (!isRunning) isRunning = await startBackend();
    }
    if (isRunning) {
        console.log('[Electron] Connected to backend on port 3000');
    } else {
        console.log('[Electron] Backend unavailable, loading local index.html directly.');
    }

    // Load local backend server or fallback directly to local index.html file
    if (isRunning) {
        console.log('[Electron] Loading UI from local backend server: http://127.0.0.1:3000/?mode=dedicated_app');
        try {
            await mainWindow.loadURL('http://127.0.0.1:3000/?mode=dedicated_app');
        } catch (e) {
            console.warn('[Electron] Failed to load local server URL, loading local index.html directly:', e.message);
            await mainWindow.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'dedicated_app' } });
        }
    } else {
        console.log('[Electron] Loading local index.html file directly...');
        await mainWindow.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'dedicated_app' } });
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

    // Enable Right-Click "Inspect Element" for fast diagnostics
    mainWindow.webContents.on('context-menu', (event, params) => {
        const menu = Menu.buildFromTemplate([
            {
                label: '🔍 Inspect Element',
                click: () => {
                    mainWindow.webContents.inspectElement(params.x, params.y);
                    if (!mainWindow.webContents.isDevToolsOpened()) {
                        mainWindow.webContents.openDevTools({ mode: 'right' });
                    }
                }
            },
            {
                label: '🛠 Toggle Developer Tools (F12)',
                accelerator: 'F12',
                click: () => {
                    mainWindow.webContents.toggleDevTools();
                }
            },
            { type: 'separator' },
            {
                label: '🔄 Reload Window',
                click: () => {
                    mainWindow.webContents.reloadIgnoringCache();
                }
            }
        ]);
        menu.popup({ window: mainWindow, x: params.x, y: params.y });
    });

    mainWindow.on('close', (event) => {
        isQuitting = true;
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
    startBackend();
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
    // Keep background server alive for WhatsApp connection!
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
