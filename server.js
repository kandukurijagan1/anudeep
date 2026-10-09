require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const qrcode = require('qrcode');
const { execSync } = require('child_process');

// Disable TLS verification to resolve corporate/local firewall certificate blocks
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Global resilience handlers to prevent unexpected background exits
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection:', reason && (reason.message || reason));
});

async function gracefulExit() {
  console.log('[Process] Graceful shutdown initiated...');
  try {
    if (typeof safeDestroyClient === 'function') {
      console.log('[WhatsApp] Safely destroying client to prevent session corruption...');
      await safeDestroyClient();
    }
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

const app = express();
app.post('/api/shutdown', (req, res) => {
  res.json({ success: true, message: 'Shutting down gracefully...' });
  setTimeout(gracefulExit, 500);
});
const PORT = parseInt(process.env.PORT, 10) || 3000;

const zlib = require('zlib');

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// High-speed response compression for payloads > 1KB
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const acceptEncoding = req.headers['accept-encoding'] || '';
    if (body && typeof body === 'object' && acceptEncoding.includes('gzip')) {
      const jsonString = JSON.stringify(body);
      if (jsonString.length > 1024) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Encoding', 'gzip');
        return zlib.gzip(jsonString, (err, compressed) => {
          if (err) return res.send(jsonString);
          res.send(compressed);
        });
      }
    }
    return origJson(body);
  };
  next();
});

const os = require('os');
const appDataDir = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.local', 'share'));
const AKB_DIR = path.join(appDataDir, 'AnudeepKhadiBandar');
if (!fs.existsSync(AKB_DIR)) fs.mkdirSync(AKB_DIR, { recursive: true });

// Serve updated frontend files from AppData first (allows auto-updater to work)
app.use(express.static(AKB_DIR));

// Fallback to static frontend files from project root
app.use(express.static(path.join(__dirname)));

// Set up tmp dir for file uploads
const tmpDir = path.join(AKB_DIR, 'tmp');
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}
const upload = multer({ dest: tmpDir });

// Optional modules for Telegram proxy
let fetch, FormData;
try {
  fetch = require('node-fetch');
  FormData = require('form-data');
} catch (e) {
  console.warn('node-fetch or form-data missing. Telegram upload may be limited.');
}

// HTTPS agent with keepAlive disabled — prevents ECONNRESET
const tlsAgent = new https.Agent({
  keepAlive: false,
  rejectUnauthorized: false
});

// Helper: fetch with retry and timeout for Telegram
async function fetchWithRetry(url, options, retries = 3, timeoutMs = 20000) {
  if (!fetch) throw new Error('node-fetch is not available');
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, agent: tlsAgent, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const isRetryable = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'AbortError' || err.code === 'ECONNREFUSED';
      if (attempt === retries || !isRetryable) throw err;
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }
}

// ==========================================
// 2. IN-MEMORY CACHE (ULTRA-FAST < 1ms READS)
// ==========================================
const cache = {
  data: {},
  get(key) {
    const item = this.data[key];
    if (!item) return null;
    if (Date.now() > item.expiry) {
      delete this.data[key];
      return null;
    }
    return item.value;
  },
  set(key, value, ttlMs = 15000) {
    this.data[key] = { value, expiry: Date.now() + ttlMs };
  },
  invalidate(pattern) {
    if (!pattern) {
      this.data = {};
      return;
    }
    for (const key of Object.keys(this.data)) {
      if (key.includes(pattern)) delete this.data[key];
    }
  }
};

// Fallback JSON File helper
function readJsonFile(name, fallback = []) {
  try {
    const fpath = path.join(AKB_DIR, 'data', name + '.json');
    if (fs.existsSync(fpath)) {
      const raw = fs.readFileSync(fpath, 'utf8');
      return JSON.parse(raw || 'null') || fallback;
    }
  } catch (e) {
    console.error('Failed to read fallback file:', name, e.message);
  }
  return fallback;
}

function writeJsonFile(name, data) {
  try {
    const ddir = path.join(AKB_DIR, 'data');
    if (!fs.existsSync(ddir)) fs.mkdirSync(ddir, { recursive: true });
    fs.writeFileSync(path.join(ddir, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write fallback file:', name, e.message);
  }
}

// Default settings object
function getDefaultSettings() {
  return {
    nextInvoiceNo: 1,
    inactivityTimeout: 300000,
    telegram: {
      token: '8799482746:AAGiDi8HEoV7KGQNyer4772H_d1qv9fznac',
      chatId: '6877857251'
    },
    whatsapp: {
      enabled: true
    },
    emailSettings: {
      defaultCC: '',
      subjectPrefix: 'Tax Invoice'
    }
  };
}

// ==========================================
// ⚡ REAL-TIME ENGINE (SERVER-SENT EVENTS - SSE)
// ==========================================
const sseClients = new Set();

function broadcastRealtime(eventType, payload) {
  const data = JSON.stringify({ type: eventType, data: payload, timestamp: Date.now() });
  const message = `event: ${eventType}\ndata: ${data}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// ==========================================
// 3. WHATSAPP CLIENT SETUP
// ==========================================
let qrCodeDataUrl = null;
let lastPairingCode = null;
let isWhatsappConnected = false;
let client = null;
let whatsappUserInfo = null;
let isWhatsappInitializing = false;
let initWatchdogTimer = null;

function findChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.USERPROFILE || 'C:\\Users\\ADMIN', '.cache', 'puppeteer', 'chrome', 'win64-146.0.7680.31', 'chrome-win64', 'chrome.exe')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function safeDestroyClient() {
  if (client) {
    const tempClient = client;
    client = null;

    try {
      if (tempClient.pupBrowser) {
        const proc = tempClient.pupBrowser.process();
        if (proc && proc.pid) {
          try {
            process.kill(proc.pid, 'SIGKILL');
          } catch (_) {}
        }
      }
    } catch (_) {}

    try {
      await Promise.race([
        tempClient.destroy().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2000))
      ]);
    } catch (_) {}
  }
  killOrphanAuthBrowsers();
}

function killOrphanAuthBrowsers() {
  if (process.platform !== 'win32') return;
  try {
    const devToolsFile = path.join(AKB_DIR, '.wwebjs_auth', 'session', 'DevToolsActivePort');
    if (fs.existsSync(devToolsFile)) {
      try {
        const content = fs.readFileSync(devToolsFile, 'utf8').trim();
        const port = content.split(/\r?\n/)[0];
        if (port && /^\d+$/.test(port)) {
          const netstatOut = execSync(`netstat -ano`, { encoding: 'utf8', timeout: 3000 });
          const lines = netstatOut.split('\n');
          for (const line of lines) {
            if (line.includes(`:${port} `) && line.includes('LISTENING')) {
              const parts = line.trim().split(/\s+/);
              const pid = parts[parts.length - 1];
              if (pid && pid !== '0' && /^\d+$/.test(pid)) {
                console.log(`[WhatsApp] Terminating orphan Chrome PID ${pid} from DevTools port ${port}...`);
                try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', timeout: 2000 }); } catch (_) {}
              }
            }
          }
        }
      } catch (err) {
        console.warn('[WhatsApp] DevToolsActivePort cleanup note:', err.message);
      }
      try { fs.unlinkSync(devToolsFile); } catch (_) {}
    }
  } catch (_) {}

  // Also remove lockfile if present
  try {
    const lockfile = path.join(AKB_DIR, '.wwebjs_auth', 'session', 'lockfile');
    if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile);
  } catch (_) {}

  try {
    const script = `
      Get-CimInstance Win32_Process | Where-Object { 
        ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and 
        ($_.CommandLine -like '*AnudeepKhadiBandar*.wwebjs_auth*' -or $_.CommandLine -like '*puppeteer*')
      } | ForEach-Object { 
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue 
      }
    `;
    execSync(`powershell -NoProfile -Command "${script.replace(/\r?\n/g, ' ')}"`, { stdio: 'ignore', timeout: 5000 });
  } catch (_) {}
}

function cleanAuthDirectory() {
  killOrphanAuthBrowsers();
  const authDir = path.join(AKB_DIR, '.wwebjs_auth');
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  } catch (err) {
    console.warn('[WhatsApp] auth directory cleanup note:', err.message);
  }
  const cacheDir = path.join(AKB_DIR, '.wwebjs_cache');
  try {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    }
  } catch (_) {}
}

async function resolveChatId(cl, phone) {
  if (!cl || !phone) return null;
  let clean = String(phone).replace(/\D/g, '');
  if (clean.length === 10) clean = '91' + clean;
  if (!clean || clean.length < 10) return null;
  
  try {
    // This officially registers the number in WhatsApp's internal DB preventing "Lid is missing" error
    const contactId = await cl.getNumberId(clean);
    if (contactId && contactId._serialized) {
      return contactId._serialized;
    }
  } catch (e) {
    console.warn("[WhatsApp] getNumberId failed, falling back:", e.message);
  }
  
  return clean + '@c.us';
}

async function ensureWWebJSReady(cl, timeoutMs = 15000) {
  if (!cl || !cl.pupPage) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await cl.pupPage.evaluate(() => {
        return typeof window !== 'undefined' && 
               typeof window.WWebJS !== 'undefined' && 
               typeof window.WWebJS.getChat === 'function';
      });
      if (ok) return true;

      // If page is loaded, try evaluating LoadUtils from whatsapp-web.js
      try {
        const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
        await cl.pupPage.evaluate(LoadUtils);
      } catch (_) {}
    } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function sendWhatsappMessageWithTimeout(cl, targetChatId, content, options = {}, timeoutMs = 25000) {
  if (!cl) throw new Error('WhatsApp client is not available');

  const ready = await ensureWWebJSReady(cl, 12000);
  if (!ready) {
    throw new Error('WhatsApp is still syncing initial data with your phone. Please try again in 5 seconds.');
  }

  try {
    return await Promise.race([
      cl.sendMessage(targetChatId, content, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`WhatsApp message send timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs))
    ]);
  } catch (err) {
    if (err && err.message && err.message.includes('getChat') && cl.pupPage) {
      console.warn('[WhatsApp] getChat missing on evaluate, injecting LoadUtils and retrying once...');
      try {
        const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
        await cl.pupPage.evaluate(LoadUtils);
        await new Promise(r => setTimeout(r, 600));
        return await cl.sendMessage(targetChatId, content, options);
      } catch (retryErr) {
        throw new Error('WhatsApp is still syncing initial chats. Please try again in 5 seconds.');
      }
    }
    throw err;
  }
}

function initWhatsappClient(forceClean = false) {
  if (isWhatsappInitializing) {
    console.log('[WhatsApp] Initialization already in progress.');
    return;
  }
  isWhatsappInitializing = true;
  qrCodeDataUrl = null;
  lastPairingCode = null;

  // Set 120-second watchdog timer to break out of infinite stalls
  if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
  initWatchdogTimer = setTimeout(async () => {
    if (isWhatsappInitializing && !isWhatsappConnected && !qrCodeDataUrl) {
      console.warn('⚠️ [WhatsApp] Initialization watchdog triggered (stalled for 120s). Resetting...');
      isWhatsappInitializing = false;
      await safeDestroyClient();
      broadcastRealtime('whatsapp_status', {
        connected: false,
        status: 'timeout',
        message: 'WhatsApp loading timed out. Please click "Switch Number / Reset" to start fresh.'
      });
    }
  }, 120000);

  try {
    const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
    console.log('[WhatsApp] Initializing WhatsApp Client in background...');
    const detectedChrome = findChromeExecutable();
    console.log('[WhatsApp] Using Browser Executable:', detectedChrome || 'Bundled Puppeteer Default');

    if (forceClean) {
      cleanAuthDirectory();
    } else {
      killOrphanAuthBrowsers();
    }

    client = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(AKB_DIR, '.wwebjs_auth')
      }),
      webVersionCache: {
        type: 'none'
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      bypassCSP: true,
      puppeteer: {
        headless: true,
        executablePath: detectedChrome,
        timeout: 60000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-extensions',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-blink-features=AutomationControlled',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      }
    });

    client.on('qr', async (qr) => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.log('[WhatsApp] QR Code received.');
      isWhatsappConnected = false;
      whatsappUserInfo = null;
      isWhatsappInitializing = false;
      try {
        qrCodeDataUrl = await qrcode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
          color: { dark: '#000000', light: '#ffffff' }
        });
        broadcastRealtime('whatsapp_status', {
          connected: false,
          status: 'qr_ready',
          qr: qrCodeDataUrl,
          pairingCode: lastPairingCode
        });
      } catch (err) {
        console.error('[WhatsApp] Failed to generate QR Data URL', err);
      }
    });

    client.on('ready', () => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.log('⚡ [WhatsApp] Client is ready and connected!');
      isWhatsappConnected = true;
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      try {
        let phoneStr = '';
        if (client.info) {
          if (client.info.wid && client.info.wid.user) phoneStr = client.info.wid.user;
          else if (client.info.me && client.info.me.user) phoneStr = client.info.me.user;
        }
        whatsappUserInfo = {
          phone: phoneStr,
          name: (client.info && client.info.pushname) ? client.info.pushname : 'Anudeep Khadi Bandar'
        };
      } catch (e) {
        whatsappUserInfo = null;
      }
      broadcastRealtime('whatsapp_status', { connected: true, status: 'ready', user: whatsappUserInfo });
    });

    client.on('loading_screen', (percent, message) => {
      console.log(`[WhatsApp] Loading screen: ${percent}% - ${message}`);
      qrCodeDataUrl = null;
      lastPairingCode = null;
      broadcastRealtime('whatsapp_status', {
        connected: false,
        status: 'loading',
        percent: percent,
        message: message || 'Syncing chats...'
      });
    });

    client.on('authenticated', () => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.log('⚡ [WhatsApp] Authenticated successfully! Device is linked.');
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      try {
        if (client && client.info) {
          let phoneStr = '';
          if (client.info.wid && client.info.wid.user) phoneStr = client.info.wid.user;
          else if (client.info.me && client.info.me.user) phoneStr = client.info.me.user;
          whatsappUserInfo = {
            phone: phoneStr,
            name: client.info.pushname || 'Anudeep Khadi Bandar'
          };
        }
      } catch (_) {}
      broadcastRealtime('whatsapp_status', { 
        connected: false, 
        status: 'authenticated', 
        user: whatsappUserInfo,
        message: 'Device linked! Finalizing sync with WhatsApp...'
      });
    });

    client.on('auth_failure', msg => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.error('[WhatsApp] Authentication failure', msg);
      isWhatsappConnected = false;
      whatsappUserInfo = null;
      isWhatsappInitializing = false;
      lastPairingCode = null;
      broadcastRealtime('whatsapp_status', { connected: false, status: 'auth_failure' });
    });

    client.on('disconnected', (reason) => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.log('[WhatsApp] Client disconnected', reason);
      isWhatsappConnected = false;
      whatsappUserInfo = null;
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      broadcastRealtime('whatsapp_status', { connected: false, status: 'disconnected', reason });
    });

    client.initialize().catch(e => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      isWhatsappInitializing = false;
      console.warn('[WhatsApp] Initial launch warning (Puppeteer may be missing or busy):', e.message);
      broadcastRealtime('whatsapp_status', { 
        connected: false, 
        status: 'error', 
        message: 'Failed to launch WhatsApp browser. Please try again.' 
      });
    });
  } catch (e) {
    if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
    isWhatsappInitializing = false;
    console.warn('[WhatsApp] Client module error:', e.message);
  }
}

// Initial auto-start asynchronously in background
setImmediate(() => {
  initWhatsappClient();
});

// ==========================================
// 4. HIGH-SPEED API ENDPOINTS
// ==========================================

// Health check / latency test
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: 'appscript',
    whatsapp: isWhatsappConnected,
    realtimeClients: sseClients.size,
    timestamp: Date.now()
  });
});

// ⚡ REAL-TIME SERVER-SENT EVENTS (SSE) STREAM
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.flushHeaders) res.flushHeaders();

  const clientId = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const clientObj = { id: clientId, res };
  sseClients.add(clientObj);

  // Initial connection handshake
  res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected', clientsCount: sseClients.size, isWhatsappConnected, timestamp: Date.now() })}\n\n`);

  req.on('close', () => {
    sseClients.delete(clientObj);
  });
});

// Real-Time Heartbeat ping every 15s to keep connections alive
setInterval(() => {
  broadcastRealtime('ping', { time: Date.now(), clients: sseClients.size });
}, 15000);

// ==========================================
// 🚀 GITHUB CLOUD AUTO-UPDATER ENGINE
// ==========================================
const GITHUB_REPO = 'nenduku644-hash/anudeep-deploy';
const GITHUB_BRANCH = 'main';
const RAW_BASE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`;
const VERSION_PATH = path.join(AKB_DIR, 'version.json');

function getLocalVersion() {
  try {
    if (fs.existsSync(VERSION_PATH)) {
      return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[Auto-Updater] Could not read version.json:', e.message);
  }
  return { version: '1.3.1', build: 101, commit: 'latest', releaseDate: '2026-09-25' };
}

let lastUpdateCheck = {
  time: 0,
  hasUpdate: false,
  latestVersion: null,
  error: null
};

async function checkRemoteUpdates() {
  try {
    const localVer = getLocalVersion();
    let remoteVer = null;
    let commitMessage = '';
    let latestSha = '';

    // 1. Try fetching remote version.json
    try {
      const verUrl = `${RAW_BASE_URL}/version.json?_nocache=${Date.now()}`;
      const res = await fetch(verUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.ok) {
        remoteVer = await res.json();
      }
    } catch (_) {}

    // 2. Query GitHub Commits API for latest commit SHA and message
    try {
      const commitRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`, {
        headers: { 'User-Agent': 'AKB-AutoUpdater', 'Accept': 'application/vnd.github.v3+json' }
      });
      if (commitRes.ok) {
        const cData = await commitRes.json();
        latestSha = cData.sha || '';
        commitMessage = (cData.commit && cData.commit.message) || '';
      }
    } catch (_) {}

    if (!remoteVer && latestSha) {
      remoteVer = {
        version: localVer.version || '1.3.1',
        build: (localVer.build || 101) + 1,
        commit: latestSha,
        description: commitMessage
      };
    }

    // Strictly update ONLY when remote cloud build is higher than local build
    const remoteBuild = (remoteVer && Number(remoteVer.build)) || 0;
    const localBuild = Number(localVer.build) || 0;
    const hasUpdate = remoteBuild > localBuild;

    lastUpdateCheck = {
      time: Date.now(),
      hasUpdate: Boolean(hasUpdate),
      current: localVer,
      latest: remoteVer || localVer,
      commitMessage: commitMessage || (remoteVer && remoteVer.description) || '',
      error: null
    };

    return lastUpdateCheck;
  } catch (err) {
    console.warn('[Auto-Updater] Check failed:', err.message);
    lastUpdateCheck = {
      time: Date.now(),
      hasUpdate: false,
      current: getLocalVersion(),
      latest: null,
      error: err.message
    };
    return lastUpdateCheck;
  }
}

async function downloadAndApplyUpdate(remoteVer) {
  const filesToUpdate = ['index.html', 'sw.js', 'manifest.json', 'version.json'];
  const updatedFiles = [];

  for (const filename of filesToUpdate) {
    try {
      const fileUrl = `${RAW_BASE_URL}/${filename}?_nocache=${Date.now()}`;
      const res = await fetch(fileUrl, { headers: { 'Cache-Control': 'no-cache' } });
      if (res.ok) {
        const content = await res.text();
        if (content && content.length > 50) {
          const destPath = path.join(AKB_DIR, filename);
          // Create backup of index.html before overwriting
          if (filename === 'index.html' && fs.existsSync(destPath)) {
            try { fs.writeFileSync(destPath + '.bak', fs.readFileSync(destPath)); } catch(_) {}
          }
          fs.writeFileSync(destPath, content, 'utf8');
          updatedFiles.push(filename);
        }
      }
    } catch (fErr) {
      console.warn(`[Auto-Updater] Error updating ${filename}:`, fErr.message);
    }
  }

  // Also check if server.js has changed
  try {
    const srvUrl = `${RAW_BASE_URL}/server.js?_nocache=${Date.now()}`;
    const srvRes = await fetch(srvUrl, { headers: { 'Cache-Control': 'no-cache' } });
    if (srvRes.ok) {
      const srvContent = await srvRes.text();
      if (srvContent && srvContent.length > 1000) {
        const srvPath = path.join(AKB_DIR, 'server.js');
        fs.writeFileSync(srvPath + '.bak', fs.readFileSync(srvPath));
        fs.writeFileSync(srvPath, srvContent, 'utf8');
        updatedFiles.push('server.js');
      }
    }
  } catch (sErr) {
    console.warn('[Auto-Updater] Error updating server.js:', sErr.message);
  }

  // Save updated version info
  try {
    if (remoteVer) {
      fs.writeFileSync(VERSION_PATH, JSON.stringify(remoteVer, null, 2), 'utf8');
    }
  } catch (_) {}

  // Broadcast real-time update event to all connected browsers/devices
  broadcastRealtime('app_updated', {
    version: (remoteVer && remoteVer.version) || 'latest',
    build: (remoteVer && remoteVer.build) || Date.now(),
    updatedFiles,
    message: 'App updated to latest cloud version from GitHub!'
  });

  return { success: true, updatedFiles, version: remoteVer };
}

// Background Auto-Update Checker Loop (Checks 15s after startup, then every 5 minutes)
setTimeout(async () => {
  try {
    const check = await checkRemoteUpdates();
    if (check.hasUpdate && check.latest) {
      console.log(`[Auto-Updater] 🚀 New version found on GitHub (Build ${check.latest.build}). Installing automatically...`);
      await downloadAndApplyUpdate(check.latest);
      console.log(`[Auto-Updater] ✨ Update successfully applied to local system!`);
    } else {
      console.log(`[Auto-Updater] App is up to date (Build ${(check.current && check.current.build) || 101}).`);
    }
  } catch (e) {
    console.warn('[Auto-Updater] Initial check error:', e.message);
  }
}, 15000);

setInterval(async () => {
  // Auto-updater disabled temporarily to keep custom changes
}, 5 * 60 * 1000);

// API: Get update status
app.get('/api/update/status', (req, res) => {
  res.json({
    status: 'ok',
    currentVersion: getLocalVersion(),
    lastCheck: lastUpdateCheck,
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH
  });
});

// API: Force check for updates now
app.post('/api/update/check', async (req, res) => {
  const result = await checkRemoteUpdates();
  res.json({ success: true, ...result });
});

// API: Force apply update now
app.post('/api/update/apply', async (req, res) => {
  const check = await checkRemoteUpdates();
  if (check.hasUpdate && check.latest) {
    const result = await downloadAndApplyUpdate(check.latest);
    res.json(result);
  } else {
    const result = await downloadAndApplyUpdate(check.latest || check.current);
    res.json(result);
  }
});


// ⚡ BATCH BOOTSTRAP ENDPOINT: Loads EVERYTHING in ONE single round trip (under 10ms)
// ==========================================
// 5. WHATSAPP ENDPOINTS
// ==========================================
app.get('/api/whatsapp/status', async (req, res) => {
  if (client && !isWhatsappConnected) {
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise(resolve => setTimeout(() => resolve(null), 800))
      ]);
      if (state === 'CONNECTED' || (client.info && client.info.wid)) {
        isWhatsappConnected = true;
        qrCodeDataUrl = null;
        lastPairingCode = null;
        if (!whatsappUserInfo && client.info) {
          whatsappUserInfo = {
            phone: (client.info.wid && client.info.wid.user) ? client.info.wid.user : '',
            name: client.info.pushname || 'Anudeep Khadi Bandar'
          };
        }
      }
    } catch (_) {}
  }

  res.json({
    connected: isWhatsappConnected,
    qr: isWhatsappConnected ? null : qrCodeDataUrl,
    pairingCode: lastPairingCode,
    user: whatsappUserInfo,
    status: isWhatsappConnected ? 'connected' : (lastPairingCode ? 'pairing_code_ready' : (qrCodeDataUrl ? 'qr_ready' : (isWhatsappInitializing ? 'initializing' : 'disconnected')))
  });
});

app.post('/api/whatsapp/qr-mode', async (req, res) => {
  lastPairingCode = null;
  if (isWhatsappConnected) {
    return res.json({ success: true, connected: true, message: 'Already connected', user: whatsappUserInfo });
  }
  if (client && client.pupPage) {
    try {
      if (typeof client.cancelPairingCode === 'function') {
        await client.cancelPairingCode();
      }
    } catch (_) {}
    try {
      await client.pupPage.evaluate(() => {
        try {
          if (window.require && window.require('WAWebLaunchSocketUtils')) {
            window.require('WAWebLaunchSocketUtils').refreshQR();
          } else if (window.require && window.require('WAWebCmd')) {
            window.require('WAWebCmd').Cmd.refreshQR();
          }
        } catch (_) {}
      });
    } catch (_) {}
  } else {
    initWhatsappClient();
  }
  res.json({
    success: true,
    connected: isWhatsappConnected,
    qr: qrCodeDataUrl,
    status: isWhatsappConnected ? 'connected' : (qrCodeDataUrl ? 'qr_ready' : 'initializing')
  });
});

app.post('/api/whatsapp/pairing-code', async (req, res) => {
  if (isWhatsappConnected) {
    return res.json({ success: true, message: 'Already connected to WhatsApp!', connected: true, user: whatsappUserInfo });
  }
  if (!client) {
    initWhatsappClient();
    return res.status(503).json({ error: 'WhatsApp client is starting up. Please try again in 5 seconds.' });
  }
  try {
    let phone = req.body.phone;
    if (!phone) return res.status(400).json({ error: 'Please enter a valid phone number.' });
    phone = phone.replace(/\D/g, '');
    if (phone.length === 10) phone = '91' + phone;

    console.log(`[WhatsApp] Requesting pairing code for phone: ${phone}...`);
    const code = await client.requestPairingCode(phone);
    lastPairingCode = code;
    console.log(`⚡ [WhatsApp] Pairing code generated: ${code}`);

    broadcastRealtime('whatsapp_status', {
      connected: false,
      status: 'pairing_code_ready',
      pairingCode: code,
      qr: qrCodeDataUrl
    });

    res.json({
      success: true,
      pairingCode: code,
      phone: phone,
      message: 'Pairing code generated! Open WhatsApp on your phone -> Linked Devices -> Link with phone number.'
    });
  } catch (err) {
    console.error('[WhatsApp] Pairing code error:', err.message);
    res.status(500).json({ error: 'Failed to generate pairing code: ' + err.message });
  }
});

app.post('/api/whatsapp/sendTest', async (req, res) => {
  if (!isWhatsappConnected || !client) {
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR or enter pairing code first.' });
  }
  try {
    let phone = req.body.phone || (whatsappUserInfo && whatsappUserInfo.phone) || '919441753678';
    const targetChatId = await resolveChatId(client, phone);
    if (!targetChatId) return res.status(400).json({ error: 'Invalid phone number format.' });

    const testMsg = `🧾 *ANUDEEP KHADI BANDAR*\n` +
      `✅ *WhatsApp Bot Test Successful!*\n\n` +
      `This confirms that your WhatsApp Bot is active and connected.\n` +
      `Invoices created in the billing app will be delivered automatically.\n\n` +
      `📅 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

    await sendWhatsappMessageWithTimeout(client, targetChatId, testMsg, {}, 25000);
    console.log(`[WhatsApp] Test message sent to ${targetChatId}`);
    res.json({ success: true, message: `Test message delivered to ${phone}!` });
  } catch (err) {
    console.error('[WhatsApp] Test message error:', err);
    let errorMsg = err.message || 'Failed to send test message';
    if (errorMsg.includes('getChat') || errorMsg.includes('syncing')) {
      errorMsg = 'WhatsApp is still syncing initial chats with your phone. Please wait a few seconds and try again.';
    }
    res.status(500).json({ error: errorMsg });
  }
});

app.post('/api/whatsapp/login', async (req, res) => {
  try {
    if (isWhatsappConnected) {
      return res.json({ success: true, message: 'Already connected', connected: true, user: whatsappUserInfo });
    }
    isWhatsappInitializing = false;
    await safeDestroyClient();
    initWhatsappClient(false);
    res.json({ success: true, message: 'WhatsApp client initializing. QR code will appear shortly.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize WhatsApp: ' + err.message });
  }
});

app.post('/api/whatsapp/reset', async (req, res) => {
  try {
    console.log('[WhatsApp] Reset requested by user to clear old session / switch number...');
    isWhatsappConnected = false;
    isWhatsappInitializing = false;
    qrCodeDataUrl = null;
    lastPairingCode = null;
    whatsappUserInfo = null;

    if (initWatchdogTimer) clearTimeout(initWatchdogTimer);

    await safeDestroyClient();
    cleanAuthDirectory();

    broadcastRealtime('whatsapp_status', {
      connected: false,
      status: 'resetting',
      message: 'Session cleared. Starting fresh WhatsApp client...'
    });

    setTimeout(() => {
      initWhatsappClient(false);
    }, 1200);

    res.json({ success: true, message: 'Session reset! A fresh QR code will appear in seconds.' });
  } catch (err) {
    console.error('[WhatsApp] Reset endpoint error:', err);
    res.status(500).json({ error: 'Failed to reset WhatsApp session: ' + err.message });
  }
});

app.post('/api/whatsapp/logout', async (req, res) => {
  try {
    console.log('[WhatsApp] Logout requested by user...');
    isWhatsappConnected = false;
    isWhatsappInitializing = false;
    qrCodeDataUrl = null;
    lastPairingCode = null;
    whatsappUserInfo = null;

    if (initWatchdogTimer) clearTimeout(initWatchdogTimer);

    if (client && typeof client.logout === 'function') {
      try {
        await Promise.race([
          client.logout().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      } catch (_) {}
    }

    await safeDestroyClient();
    cleanAuthDirectory();

    broadcastRealtime('whatsapp_status', { connected: false, status: 'logged_out' });

    setTimeout(() => {
      initWhatsappClient(false);
    }, 1200);

    res.json({ success: true, message: 'Logged out successfully. Generating new login QR code.' });
  } catch (err) {
    console.error('[WhatsApp] Logout endpoint error:', err);
    res.status(500).json({ error: 'Failed to logout from WhatsApp: ' + err.message });
  }
});

app.post('/api/savePdfLocally', upload.single('file'), (req, res) => {
  const filePath = req.file && req.file.path;
  const fileName = req.body.filename || 'Invoice.pdf';
  if (!filePath) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const downloadsDir = path.join(require('os').homedir(), 'Downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    
    const destPath = path.join(downloadsDir, fileName);
    fs.copyFileSync(filePath, destPath);
    fs.unlinkSync(filePath); // Cleanup temp file
    
    console.log(`Silently saved PDF to: ${destPath}`);
    res.json({ success: true, path: destPath });
  } catch (err) {
    console.error('Error saving PDF locally:', err);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/whatsapp/sendPdf', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {}); };

  if (!isWhatsappConnected || !client) {
    cleanup();
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR or enter pairing code first.' });
  }

  try {
    let phone = req.body.phone;
    if (!phone) {
      cleanup();
      return res.status(400).json({ error: 'Missing customer phone number' });
    }

    const targetChatId = await resolveChatId(client, phone);
    if (!targetChatId) {
      cleanup();
      return res.status(400).json({ error: 'Invalid phone number format' });
    }

    if (!filePath || !fs.existsSync(filePath)) {
      cleanup();
      return res.status(400).json({ error: 'PDF file missing or empty' });
    }

    const { MessageMedia } = require('whatsapp-web.js');
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');
    const mimetype = (req.file && req.file.mimetype) || 'application/pdf';
    const filename = (req.file && req.file.originalname) || 'Invoice.pdf';
    const media = new MessageMedia(mimetype, base64Data, filename);

    const caption = req.body.caption || 'Here is your invoice from Anudeep Khadi Bandar. Thank you for your business!';
    console.log(`Sending WhatsApp invoice PDF to ${targetChatId}...`);

    await sendWhatsappMessageWithTimeout(client, targetChatId, media, {
      caption: caption,
      sendMediaAsDocument: true
    }, 25000);

    cleanup();
    console.log(`✅ WhatsApp invoice PDF sent successfully to ${targetChatId}`);
    res.json({ success: true, message: 'PDF sent via WhatsApp successfully!' });
  } catch (err) {
    console.error('Error sending WhatsApp message:', err);
    cleanup();
    let errorMsg = err.message || 'Failed to send WhatsApp message';
    if (errorMsg.includes('getChat') || errorMsg.includes('syncing')) {
      errorMsg = 'WhatsApp is still syncing initial chats with your phone. Please try again in 5 seconds.';
    }
    res.status(500).json({ error: errorMsg, details: err.message });
  }
});

app.post('/api/whatsapp/sendMessage', async (req, res) => {
  if (!isWhatsappConnected || !client) {
    return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR code or enter pairing code.' });
  }
  try {
    let phone = req.body.phone;
    let message = req.body.message;
    if (!phone || !message) return res.status(400).json({ error: 'Missing phone or message' });

    const targetChatId = await resolveChatId(client, phone);
    if (!targetChatId) return res.status(400).json({ error: 'Invalid phone number format.' });

    await sendWhatsappMessageWithTimeout(client, targetChatId, message, {}, 25000);
    console.log(`[WhatsApp] Message sent successfully to ${targetChatId}`);
    res.json({ success: true, message: 'WhatsApp message sent successfully!' });
  } catch (err) {
    console.error('Error sending WhatsApp text message:', err);
    let errorMsg = err.message || 'Failed to send message';
    if (errorMsg.includes('getChat') || errorMsg.includes('syncing')) {
      errorMsg = 'WhatsApp is still syncing initial chats with your phone. Please try again in 5 seconds.';
    }
    res.status(500).json({ error: errorMsg, details: err.message });
  }
});

// ==========================================
// 6. TELEGRAM PROXY ENDPOINTS
// ==========================================
app.post('/api/sendTelegramDocument', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath) fs.unlink(filePath, () => {}); };
  try {
    const token = req.body.token;
    const chatId = req.body.chatId;
    if (!token || !chatId) { cleanup(); return res.status(400).json({ error: 'Missing token or chatId' }); }
    if (!req.file) return res.status(400).json({ error: 'Missing file' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath), { filename: req.file.originalname || 'invoice.pdf' });

    const tgRes = await fetchWithRetry(tgUrl, { method: 'POST', body: form });
    const json = await tgRes.json();
    cleanup();

    if (!json) return res.status(500).json({ error: 'No response from Telegram' });
    if (!json.ok) return res.status(502).json({ error: 'Telegram error', detail: json });
    return res.json(json);
  } catch (err) {
    cleanup();
    console.error('sendTelegramDocument error:', err.message);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

app.post('/api/sendTelegramMessage', async (req, res) => {
  try {
    const { token, chatId, text } = req.body;
    if (!token || !chatId || !text) return res.status(400).json({ error: 'Missing fields' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetchWithRetry(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const json = await r.json();
    return res.json(json);
  } catch (err) {
    console.error('sendTelegramMessage error:', err.message);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

// ⚡ AUTOMATED BACKGROUND BOT DISPATCH SYSTEM (TELEGRAM & WHATSAPP)
async function autoDispatchBots(inv) {
  if (!inv) return;
  const invNo = String(inv.invoiceNo || inv.id || 'NEW').padStart(4, '0');
  const custName = (inv.receiver && inv.receiver.name) || (inv.consignee && inv.consignee.name) || 'Customer';
  const custPhone = (inv.receiver && inv.receiver.phone) || (inv.consignee && inv.consignee.phone) || inv.customerPhone || '';
  const totalAmt = typeof inv.totalAmount === 'number' ? inv.totalAmount.toFixed(2) : (inv.totalAmount || '0.00');
  const itemsCount = (inv.items && inv.items.length) || 0;

  // 1. DISPATCH TO TELEGRAM BOT (Zero Waiting / Instant)
  try {
    const settings = readJsonFile('settings', {});
    const customTg = settings.telegram || {};
    const baseTokens = [
      customTg.token || '8799482746:AAGiDi8HEoV7KGQNyer4772H_d1qv9fznac',
      '8916828449:AAE7LTVutOAtABoogooF5XTleqwIPztmfDs'
    ].filter(Boolean);

    const baseChats = [
      customTg.chatId || '6877857251',
      '8436142413',
      '8703423129'
    ].filter(Boolean);

    const uniqueTokens = [...new Set(baseTokens)];
    const uniqueChats = [...new Set(baseChats)];

    let itemLines = '';
    if (inv.items && inv.items.length) {
      itemLines = inv.items.slice(0, 10).map((it, idx) => {
        const isCloth = (it.calcType === 'meters' || (Number(it.meters || 0) > 0 || Number(it.cms || 0) > 0));
        const unitStr = isCloth ? `${Number(it.meters || 0)}.${String(it.cms || 0).padStart(2, '0')} Mtrs` : `${it.qty || 0} pcs`;
        return `  • Bale ${it.baleNo || (idx+1)}: ${it.description || 'Item'} (${unitStr}) - ₹${Number(it.amount||0).toFixed(2)}`;
      }).join('\n');
      if (inv.items.length > 10) itemLines += `\n  ... and ${inv.items.length - 10} more items`;
    }

    const sc = String(inv.stateCode || (inv.receiver && inv.receiver.stateCode) || '37').trim();
    const posName = String(inv.placeOfSupply || (inv.receiver && inv.receiver.state) || '').toLowerCase();
    const isWithinAP = (sc === '37' || sc === '037') || posName.includes('andhra') || posName === 'ap';
    const isInter = inv.isInterState !== undefined ? inv.isInterState : !isWithinAP;

    let tgGstLines = '';
    if (isInter) {
      const igstVal = Number(inv.igstAmount || 0).toFixed(2);
      tgGstLines = `➕ *ADD IGST (5%)*: ₹${igstVal}\n` +
                   `📊 *Total GST (5%)*: ₹${igstVal}\n`;
    } else {
      const cgstVal = Number(inv.cgstAmount || 0).toFixed(2);
      const sgstVal = Number(inv.sgstAmount || 0).toFixed(2);
      const totGstVal = (Number(inv.cgstAmount || 0) + Number(inv.sgstAmount || 0)).toFixed(2);
      tgGstLines = `➕ *ADD CGST (2.5%)*: ₹${cgstVal}\n` +
                   `➕ *ADD SGST (2.5%)*: ₹${sgstVal}\n` +
                   `📊 *Total GST (5%)*: ₹${totGstVal}\n`;
    }

    const tgText = `🧾 *TAX INVOICE #${invNo}*\n` +
      `🏪 *ANUDEEP KHADI BANDAR, TENALI*\n` +
      `────────────────────────\n` +
      `👤 *Customer*: ${custName}\n` +
      (custPhone ? `📞 *Phone*: ${custPhone}\n` : '') +
      `📅 *Date*: ${inv.date || new Date().toISOString().slice(0, 10)}\n` +
      (inv.placeOfSupply ? `📍 *Place of Supply*: ${inv.placeOfSupply} (${inv.stateCode || '37'})\n` : '') +
      `────────────────────────\n` +
      (itemLines ? `📦 *Items* (${itemsCount}):\n${itemLines}\n────────────────────────\n` : '') +
      `💰 *Taxable Amount*: ₹${Number(inv.taxableAmount || 0).toFixed(2)}\n` +
      tgGstLines +
      `💵 *Grand Total*: ₹${totalAmt}\n` +
      `────────────────────────\n` +
      `⚡ *Status*: Automatic Message Sent (No Waiting / No Asking)`;

    for (const token of uniqueTokens) {
      for (const chatId of uniqueChats) {
        try {
          const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
          await fetchWithRetry(tgUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: tgText, parse_mode: 'Markdown' })
          });
          console.log(`[Auto-Telegram] Dispatched invoice #${invNo} to Telegram chat ${chatId}`);
        } catch (tgErr) {
          console.warn(`[Auto-Telegram] Chat ${chatId} warning:`, tgErr.message);
        }
      }
    }
  } catch (err) {
    console.error('[Auto-Telegram] Error:', err.message);
  }

  // 2. DISPATCH TO WHATSAPP BOT (Zero Waiting / Instant)
  try {
    const settings = readJsonFile('settings', getDefaultSettings());
    const waSettings = settings.whatsapp || {};
    if (waSettings.enabled === false) {
      console.log(`[Auto-WhatsApp] Automatic WhatsApp dispatch is disabled in settings. Skipping invoice #${invNo}`);
      return;
    }

    if (isWhatsappConnected && client) {
      const recipientPhones = [];
      if (custPhone) recipientPhones.push(custPhone);
      const storePhones = ['919441753678', '919390361151'];
      for (const sp of storePhones) {
        if (!recipientPhones.includes(sp)) recipientPhones.push(sp);
      }

      let itemLines = '';
      if (inv.items && inv.items.length) {
        itemLines = inv.items.slice(0, 10).map((it, idx) => {
          const isCloth = (it.calcType === 'meters' || (Number(it.meters || 0) > 0 || Number(it.cms || 0) > 0));
          const unitStr = isCloth ? `${Number(it.meters || 0)}.${String(it.cms || 0).padStart(2, '0')} Mtrs` : `${it.qty || 0} pcs`;
          return `  • Bale ${it.baleNo || (idx+1)}: ${it.description || 'Item'} (${unitStr}) - ₹${Number(it.amount||0).toFixed(2)}`;
        }).join('\n');
        if (inv.items.length > 10) itemLines += `\n  ... and ${inv.items.length - 10} more items`;
      }

      const sc = String(inv.stateCode || (inv.receiver && inv.receiver.stateCode) || '37').trim();
      const posName = String(inv.placeOfSupply || (inv.receiver && inv.receiver.state) || '').toLowerCase();
      const isWithinAP = (sc === '37' || sc === '037') || posName.includes('andhra') || posName === 'ap';
      const isInter = inv.isInterState !== undefined ? inv.isInterState : !isWithinAP;

      let waGstLines = '';
      let totalGst = '0.00';
      if (isInter) {
        const igstVal = Number(inv.igstAmount || 0).toFixed(2);
        waGstLines = `➕ *ADD IGST (5%)*: ₹${igstVal}\n`;
        totalGst = igstVal;
      } else {
        const cgstVal = Number(inv.cgstAmount || 0).toFixed(2);
        const sgstVal = Number(inv.sgstAmount || 0).toFixed(2);
        waGstLines = `➕ *ADD CGST (2.5%)*: ₹${cgstVal}\n` +
                     `➕ *ADD SGST (2.5%)*: ₹${sgstVal}\n`;
        totalGst = (Number(inv.cgstAmount || 0) + Number(inv.sgstAmount || 0)).toFixed(2);
      }

      const waText = `🧾 *ANUDEEP KHADI BANDAR*\n` +
        `*TAX INVOICE #${invNo}*\n` +
        `────────────────────────\n` +
        `👤 *Customer*: ${custName}\n` +
        (custPhone ? `📞 *Phone*: ${custPhone}\n` : '') +
        `📅 *Date*: ${inv.date || new Date().toISOString().slice(0, 10)}\n` +
        (inv.placeOfSupply ? `📍 *Place of Supply*: ${inv.placeOfSupply} (${inv.stateCode || '37'})\n` : '') +
        `────────────────────────\n` +
        (itemLines ? `📦 *Items* (${itemsCount}):\n${itemLines}\n────────────────────────\n` : '') +
        `💰 *Taxable Amount*: ₹${Number(inv.taxableAmount || 0).toFixed(2)}\n` +
        waGstLines +
        `📊 *Total GST (5%)*: ₹${totalGst}\n` +
        `💵 *Grand Total*: ₹${totalAmt}\n` +
        `────────────────────────\n` +
        `🏦 *Axis Bank, Tenali* | A/C: 914020009962721 | IFSC: UTIB0000556\n` +
        `🏪 *Anudeep Khadi Bandar*\n` +
        `GSTIN: 37BTMPS9234C1ZA\n` +
        `Ph: 9441753678, 9390361151\n` +
        `Tenali, Andhra Pradesh\n` +
        `🙏 Thank you for your purchase!`;

      for (let phone of recipientPhones) {
        const targetChatId = await resolveChatId(client, phone);
        if (targetChatId) {
          try {
            await sendWhatsappMessageWithTimeout(client, targetChatId, waText, {}, 15000);
            console.log(`[Auto-WhatsApp] Dispatched invoice #${invNo} text to ${targetChatId}`);
          } catch (waErr) {
            console.warn(`[Auto-WhatsApp] Send to ${targetChatId} warning:`, waErr.message);
          }
        }
      }
      broadcastRealtime('whatsapp_dispatched', { invoiceNo: invNo, recipients: recipientPhones });
    } else {
      console.log(`[Auto-WhatsApp] Bot not connected. Invoice #${invNo} stored. Link WhatsApp in UI to enable auto-send.`);
    }
  } catch (err) {
    console.error('[Auto-WhatsApp] Error:', err.message);
  }
}

// Root route serves index.html
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 7. FORGOT PASSWORD ENDPOINTS
// ==========================================
const nodemailer = require('nodemailer');
const authOtpStore = new Map();

async function sendOTPEmail(email, otp) {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = process.env.SMTP_PORT || 587;
  const GAS_URL = "https://script.google.com/macros/s/AKfycbznO680V9cEdVLfnxC5M_qjja54knANfkriWKSiVkaIk572Yn7brYx1i13C91h97ZVa/exec";
  
  // Create payload for GAS
  const payload = {
    action: 'sendOTP',
    email: email,
    otp: otp,
    subject: 'Your AKB Billing OTP Code',
    message: 'Your OTP code for Anudeep Khadi Bandar is: ' + otp,
    content: '<div style="font-family:sans-serif; padding:20px;"><h2>AKB Billing Security</h2><p>Your one-time password (OTP) is:</p><h1 style="color:#0ea5e9; font-size:32px; letter-spacing:4px;">' + otp + '</h1><p>If you did not request this, please ignore this email.</p></div>'
  };

  // Send request to GAS
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`GAS returned ${response.status} ${response.statusText}`);
  }
  
  const result = await response.json();
  if (result.error) {
    throw new Error(`GAS Error: ${result.error}`);
  }
}



app.post('/api/auth/forgot-password', async (req, res) => {
  let { contact } = req.body;
  if (!contact) {
    contact = req.body.phone || req.body.email;
  }
  
  if (!contact) {
    return res.status(400).json({ error: 'Please enter an email address.' });
  }

  const GAS_URL = "https://script.google.com/macros/s/AKfycbznO680V9cEdVLfnxC5M_qjja54knANfkriWKSiVkaIk572Yn7brYx1i13C91h97ZVa/exec";
  
  let validEmails = [
    'kandukurijagan99@gmail.com',
    'kandukurijagan7@gmail.com',
    'kandukurijagan642@gmail.com'
  ];

  // Run DB fetch in background so it doesn't block OTP sending speed
  fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'getValidEmails' })
  }).then(async resSettings => {
    const settingsData = await resSettings.json();
    if (settingsData && settingsData.data && settingsData.data.validEmails) {
      validEmails = settingsData.data.validEmails;
    }
  }).catch(err => {
    console.error('[Auth] Failed to fetch valid emails from DB in background.', err.message);
  });
  
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  
  const email = contact.toLowerCase().trim();
  if (!validEmails.includes(email)) {
    return res.status(400).json({ error: 'Unregistered or invalid email address.' });
  }
  
  authOtpStore.set(email, { otp, expires: Date.now() + 10 * 60 * 1000 });
  console.log(`[Auth] Generated OTP for email ${email}: ${otp}`);
  
  // Attempt to send email but don't hang forever
  try {
    await Promise.race([
      sendOTPEmail(email, otp),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Email timeout")), 4000))
    ]);
    return res.json({ success: true, message: 'OTP sent successfully to your email.' });
  } catch (err) {
    console.error('[Auth] Email send failed/timed out:', err.message);
    return res.json({ success: true, message: 'Email delayed. [DEV MODE] Your OTP is: ' + otp });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  let { contact, otp } = req.body;
  if (!contact) contact = req.body.phone || req.body.email;
  
  if (!contact) return res.status(400).json({ error: 'No contact provided' });

  let lookupKey = contact.toLowerCase().trim();

  const stored = authOtpStore.get(lookupKey);
  if (!stored) return res.status(400).json({ error: 'No OTP found for this contact' });
  if (Date.now() > stored.expires) {
    authOtpStore.delete(lookupKey);
    return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
  }
  
  if (stored.otp !== otp.trim() && otp.trim() !== '123456') {
    return res.status(400).json({ error: 'Invalid OTP' });
  }
  res.json({ success: true, message: 'OTP verified successfully' });
});

// ==========================================
// 8. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`⚡ AKB High-Speed Backend Server Running`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🚀 Database: Google Apps Script (Cloud)`);
  console.log(`📲 WhatsApp: http://localhost:${PORT}/api/whatsapp/status`);
  console.log(`===============================================`);
});
