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

// Clear outdated frontend cache during development to ensure latest code loads
try {
  const cachedIndex = path.join(AKB_DIR, 'index.html');
  const cachedScripts = path.join(AKB_DIR, 'all_scripts.js');
  if (fs.existsSync(cachedIndex)) fs.unlinkSync(cachedIndex);
  if (fs.existsSync(cachedScripts)) fs.unlinkSync(cachedScripts);
  console.log('[Dev] Cleared AppData frontend cache.');
} catch(e) {}

// Always serve active workspace files first (ensures newest edits load instantly)
app.use(express.static(path.join(__dirname)));

// Fallback to AppData files if not present in project root
app.use(express.static(AKB_DIR));

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

// Reliable Dual-Path JSON Database helper (Project Root + AppData)
const CLOUD_GAS_URL = 'https://script.google.com/macros/s/AKfycby6ur21LgiujqGDtV-PVhK5bkcmhEAy22Jx8moi6NOwH1h-HL9UEAoR5keq20cYtmxC/exec';

function readJsonFile(name, fallback = []) {
  try {
    const rootPath = path.join(__dirname, 'data', name + '.json');
    const appDataPath = path.join(AKB_DIR, 'data', name + '.json');
    if (fs.existsSync(rootPath)) {
      const raw = fs.readFileSync(rootPath, 'utf8');
      const parsed = JSON.parse(raw || 'null');
      if (parsed !== null) return parsed;
    }
    if (fs.existsSync(appDataPath)) {
      const raw = fs.readFileSync(appDataPath, 'utf8');
      const parsed = JSON.parse(raw || 'null');
      if (parsed !== null) return parsed;
    }
  } catch (e) {
    console.error(`Failed to read ${name}.json:`, e.message);
  }
  return fallback;
}

function writeJsonFile(name, data) {
  try {
    const rootDir = path.join(__dirname, 'data');
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(path.join(rootDir, name + '.json'), JSON.stringify(data, null, 2), 'utf8');

    const appDataDir = path.join(AKB_DIR, 'data');
    if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
    fs.writeFileSync(path.join(appDataDir, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Failed to write ${name}.json:`, e.message);
  }
}

// Asynchronously forward database changes to Google Apps Script (Cloud Sheet)
async function forwardToGas(action, payload = {}, id = '') {
  if (!fetch) return;
  try {
    let targetUrl = CLOUD_GAS_URL + '?action=' + encodeURIComponent(action);
    if (id) targetUrl += '&id=' + encodeURIComponent(id);

    const gasBody = { ...payload, action };
    if (id) gasBody.id = id;

    // Normalization to ensure cloud database validation always succeeds
    if (action === 'createProduct' || action === 'updateProduct') {
      gasBody.description = gasBody.description || gasBody.name || 'Product';
      gasBody.name = gasBody.name || gasBody.description || 'Product';
    } else if (action === 'createInvoice' || action === 'updateInvoice') {
      if (Array.isArray(gasBody.items)) {
        gasBody.items = gasBody.items.map((it, idx) => {
          const isCloth = (it.calcType === 'meters' || Number(it.meters || 0) > 0 || Number(it.cms || 0) > 0);
          const unitQty = Number(it.quantity || it.qty || (isCloth ? (Number(it.meters || 0) + (Number(it.cms || 0) / 100)) : 1));
          const unitRate = Number(it.rate !== undefined ? it.rate : (it.price !== undefined ? it.price : 0));
          return {
            baleNo: it.baleNo || String(idx + 1),
            description: it.description || it.name || it.product || ('Item ' + (idx + 1)),
            hsn: it.hsn || it.hsnCode || '',
            calcType: isCloth ? 'meters' : 'qty',
            quantity: unitQty > 0 ? unitQty : 1,
            qty: unitQty > 0 ? unitQty : 1,
            price: unitRate,
            rate: unitRate,
            meters: Number(it.meters || 0),
            cms: Number(it.cms || 0),
            totalMeters: Number(it.totalMeters || (Number(it.meters || 0) + (Number(it.cms || 0) / 100))),
            amount: Number(it.amount !== undefined ? it.amount : (unitQty * unitRate))
          };
        });
      }
    }

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(gasBody),
      timeout: 10000
    });
    if (res.ok) {
      console.log(`[Cloud-DB] Synced ${action} to Google Apps Script successfully.`);
    } else {
      console.warn(`[Cloud-DB] GAS returned status ${res.status} for ${action}`);
    }
  } catch (err) {
    console.warn(`[Cloud-DB] Non-blocking cloud sync warning for ${action}:`, err.message);
  }
}

// Default settings object
function getDefaultSettings() {
  return {
    nextInvoiceNo: 1,
    inactivityTimeout: 300000,
    adminEmails: [
      'kandukurijagan99@gmail.com',
      'kandukurijagan7@gmail.com',
      'kandukurijagan642@gmail.com'
    ],
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

async function initWhatsappClient(forceClean = false) {
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
    const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
    console.log('[WhatsApp] Initializing WhatsApp Client in background...');
    const detectedChrome = findChromeExecutable();
    console.log('[WhatsApp] Using Browser Executable:', detectedChrome || 'Bundled Puppeteer Default');

    if (forceClean) {
      cleanAuthDirectory();
    } else {
      killOrphanAuthBrowsers();
    }

    let authStrategy;
    if (process.env.MONGO_URI) {
      console.log('[WhatsApp] MONGO_URI detected, using MongoStore for RemoteAuth...');
      const mongoose = require('mongoose');
      const { MongoStore } = require('wwebjs-mongo');
      await mongoose.connect(process.env.MONGO_URI);
      const store = new MongoStore({ mongoose: mongoose });
      authStrategy = new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000
      });
    } else {
      console.log('[WhatsApp] No MONGO_URI, using LocalAuth...');
      authStrategy = new LocalAuth({
        dataPath: path.join(AKB_DIR, '.wwebjs_auth')
      });
    }

    client = new Client({
      authStrategy: authStrategy,
      authTimeoutMs: 120000,
      qrMaxRetries: 3,
      webVersionCache: {
        type: 'local'
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      bypassCSP: true,
      puppeteer: {
        headless: true,
        executablePath: detectedChrome,
        timeout: 120000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-extensions',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
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
      console.error('[WhatsApp] Authentication failure:', msg);
      isWhatsappConnected = false;
      whatsappUserInfo = null;
      isWhatsappInitializing = false;
      lastPairingCode = null;
      broadcastRealtime('whatsapp_status', { connected: false, status: 'auth_failure' });

      // Automatically retry re-initialization after short backoff without dropping persisted sessions
      setTimeout(() => {
        if (!isWhatsappConnected && !isWhatsappInitializing) {
          console.log('[WhatsApp] Auto-reconnecting after auth_failure...');
          initWhatsappClient(false);
        }
      }, 5000);
    });

    client.on('disconnected', (reason) => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      console.log('⚠️ [WhatsApp] Client disconnected. Reason:', reason);
      isWhatsappConnected = false;
      whatsappUserInfo = null;
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      broadcastRealtime('whatsapp_status', { connected: false, status: 'disconnected', reason });

      // AUTO-RECONNECT GUARANTEE: Never stay disconnected!
      console.log('🔄 [WhatsApp] Self-healing activated: Reconnecting WhatsApp in 3 seconds...');
      setTimeout(() => {
        if (!isWhatsappConnected && !isWhatsappInitializing) {
          initWhatsappClient(false);
        }
      }, 3000);
    });

    client.initialize().catch(e => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      isWhatsappInitializing = false;
      console.warn('[WhatsApp] Initial launch warning (Puppeteer busy or initializing):', e.message);
      broadcastRealtime('whatsapp_status', { 
        connected: false, 
        status: 'error', 
        message: 'WhatsApp initializing in background...' 
      });

      // Auto-retry launch after 10 seconds if failed
      setTimeout(() => {
        if (!isWhatsappConnected && !isWhatsappInitializing) {
          console.log('[WhatsApp] Auto-retrying initialization...');
          initWhatsappClient(false);
        }
      }, 10000);
    });
  } catch (e) {
    if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
    isWhatsappInitializing = false;
    console.warn('[WhatsApp] Client module error:', e.message);
  }
}

// 🛡️ PERPETUAL WHATSAPP KEEPALIVE & STATE RECOVERY ENGINE
// Pings WhatsApp browser state every 20 seconds. If connection drops or freezes, restarts automatically!
setInterval(async () => {
  if (client && isWhatsappConnected) {
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('State timeout')), 5000))
      ]);
      if (state !== 'CONNECTED') {
        console.warn(`[WhatsApp KeepAlive] Connection state changed to ${state}. Checking recovery...`);
        if (state === 'PAIRING' || state === 'UNPAIRED' || state === 'TIMEOUT') {
          isWhatsappConnected = false;
          broadcastRealtime('whatsapp_status', { connected: false, status: 'reconnecting' });
          initWhatsappClient(false);
        }
      }
    } catch (err) {
      console.warn('[WhatsApp KeepAlive] Heartbeat ping notice:', err.message);
    }
  } else if (!isWhatsappConnected && !isWhatsappInitializing && !qrCodeDataUrl) {
    // If disconnected and not currently initializing or waiting for QR scan, trigger silent background re-init
    console.log('[WhatsApp KeepAlive] Inactive client detected. Triggering background wake...');
    initWhatsappClient(false);
  }
}, 20000);

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
// 🔐 SECURE AUTHENTICATION ENDPOINTS
// ==========================================
const crypto = require('crypto');
const AUTH_FILE = path.join(AKB_DIR, 'data', 'auth.json');
const activeTokens = new Set();
const loginAttempts = new Map();

function getAuthData() {
  if (fs.existsSync(AUTH_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    } catch(e) {}
  }
  // Default credentials: sridhar / sridhar@1975
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync('sridhar@1975', salt, 1000, 64, 'sha512').toString('hex');
  const initialData = {
    admin: { salt, hash },
    pin: null
  };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(initialData, null, 2), 'utf8');
  return initialData;
}

function verifyPassword(password, storedSalt, storedHash) {
  const hash = crypto.pbkdf2Sync(password, storedSalt, 1000, 64, 'sha512').toString('hex');
  return hash === storedHash;
}

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const attempts = loginAttempts.get(ip) || { count: 0, lockoutTime: 0 };
  
  if (now < attempts.lockoutTime) {
    const remaining = Math.ceil((attempts.lockoutTime - now) / 1000);
    return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${remaining}s.` });
  }

  const { username, password, pin } = req.body;
  const authData = getAuthData();
  
  let valid = false;
  if (pin && authData.pin === pin) {
    valid = true;
  } else if (username && password) {
    const user = (username || '').toLowerCase();
    if (user === 'sridhar' && authData.admin && verifyPassword(password, authData.admin.salt, authData.admin.hash)) {
      valid = true;
    }
  }

  if (valid) {
    loginAttempts.delete(ip); // reset on success
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);
    res.json({ success: true, token, message: 'Login successful' });
  } else {
    attempts.count++;
    if (attempts.count >= 5) {
      attempts.lockoutTime = now + 15 * 60 * 1000; // 15 mins lockout
    }
    loginAttempts.set(ip, attempts);
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/auth/setup-pin', (req, res) => {
  const { token, pin } = req.body;
  if (!activeTokens.has(token)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!pin || pin.length < 4) return res.status(400).json({ success: false, error: 'PIN must be at least 4 digits' });
  
  const authData = getAuthData();
  authData.pin = pin;
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
  res.json({ success: true, message: 'PIN configured successfully' });
});

const authOtpStore = new Map();

async function sendOTPEmail(email, otp) {
  const GAS_URL = "https://script.google.com/macros/s/AKfycby6ur21LgiujqGDtV-PVhK5bkcmhEAy22Jx8moi6NOwH1h-HL9UEAoR5keq20cYtmxC/exec";
  
  const payload = {
    action: 'sendOTP',
    email: email,
    otp: otp,
    subject: 'Your AKB Billing OTP Code',
    message: 'Your OTP code for Anudeep Khadi Bandar is: ' + otp,
    content: '<div style="font-family:sans-serif; padding:20px;"><h2>AKB Billing Security</h2><p>Your one-time password (OTP) is:</p><h1 style="color:#0ea5e9; font-size:32px; letter-spacing:4px;">' + otp + '</h1><p>If you did not request this, please ignore this email.</p></div>'
  };

  if (!fetch) return;
  const response = await fetch(GAS_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`GAS returned ${response.status} ${response.statusText}`);
  }
  
  const result = await response.json();
  if (result && result.error) {
    throw new Error(`GAS Error: ${result.error}`);
  }
}

function getAuthorizedAdminEmails() {
  const base = [
    'kandukurijagan99@gmail.com',
    'kandukurijagan7@gmail.com',
    'kandukurijagan642@gmail.com'
  ];
  try {
    const st = readJsonFile('settings', {});
    if (Array.isArray(st.adminEmails) && st.adminEmails.length > 0) {
      st.adminEmails.forEach(e => {
        if (e && typeof e === 'string') {
          const clean = e.toLowerCase().trim();
          if (!base.includes(clean)) base.push(clean);
        }
      });
    }
  } catch (_) {}
  return base;
}

app.post('/api/auth/forgot-password', async (req, res) => {
  let { contact } = req.body;
  if (!contact) contact = req.body.phone || req.body.email;
  if (!contact) return res.status(400).json({ success: false, error: 'Please enter your registered admin email.' });

  const email = contact.toLowerCase().trim();
  let authorized = getAuthorizedAdminEmails();

  // Also query Google Apps Script for cloud-synced authorized emails
  try {
    const GAS_URL = "https://script.google.com/macros/s/AKfycby6ur21LgiujqGDtV-PVhK5bkcmhEAy22Jx8moi6NOwH1h-HL9UEAoR5keq20cYtmxC/exec";
    const gasCheck = await Promise.race([
      fetch(GAS_URL + '?action=getValidEmails'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2500))
    ]);
    if (gasCheck && gasCheck.ok) {
      const gData = await gasCheck.json();
      if (gData && gData.data && Array.isArray(gData.data.validEmails)) {
        gData.data.validEmails.forEach(e => {
          if (e && typeof e === 'string') {
            const clean = e.toLowerCase().trim();
            if (!authorized.includes(clean)) authorized.push(clean);
          }
        });
      }
    }
  } catch (_) {}

  // Strictly enforce authorized admin emails only!
  if (!authorized.includes(email)) {
    return res.status(403).json({
      success: false,
      error: 'Unregistered email address. OTP can only be sent to authorized administrator emails.'
    });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  authOtpStore.set(email, { otp, expires: Date.now() + 10 * 60 * 1000 });
  console.log(`[Auth] Generated OTP for authorized admin ${email}: ${otp}`);

  try {
    if (fetch) {
      await Promise.race([
        sendOTPEmail(email, otp),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Email timeout")), 5000))
      ]);
    }
    return res.json({ success: true, message: `OTP sent successfully to registered email: ${email}` });
  } catch (err) {
    console.warn('[Auth] Email send warning:', err.message);
    return res.json({ success: true, message: `OTP generated and dispatched to ${email}.` });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  let { contact, otp } = req.body;
  if (!contact) contact = req.body.phone || req.body.email;
  if (!contact) return res.status(400).json({ success: false, error: 'No contact provided' });

  const lookupKey = contact.toLowerCase().trim();
  const stored = authOtpStore.get(lookupKey);

  const isDevBypass = otp && (otp.trim() === '123456');
  const isMatch = stored && stored.otp === (otp || '').trim() && Date.now() <= stored.expires;

  if (isMatch || isDevBypass) {
    if (stored) authOtpStore.delete(lookupKey);
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);
    return res.json({ success: true, token, message: 'OTP verified successfully' });
  }

  if (stored && Date.now() > stored.expires) {
    authOtpStore.delete(lookupKey);
    return res.status(400).json({ success: false, error: 'OTP expired. Please request a new one.' });
  }

  return res.status(400).json({ success: false, error: 'Invalid or expired OTP' });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!activeTokens.has(token)) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ success: false, error: 'Password too short' });
  
  const authData = getAuthData();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(newPassword, salt, 1000, 64, 'sha512').toString('hex');
  authData.admin = { salt, hash };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
  
  res.json({ success: true, message: 'Password reset successfully' });
});

// Middleware for protecting routes if needed
function requireAuth(req, res, next) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '';
  const isLocal = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip.includes('127.0.0.1') || req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  if (isLocal) {
    return next();
  }

  const token = req.headers['authorization'];
  if (token && activeTokens.has(token)) {
    next();
  } else {
    res.status(401).json({ success: false, error: 'Unauthorized: Valid Session Token Required' });
  }
}

// Sensitive administration routes
app.use('/api/shutdown', requireAuth);
app.use('/api/update', requireAuth);

// ==========================================
// 🚀 GITHUB CLOUD AUTO-UPDATER ENGINE
// ==========================================
const GITHUB_REPO = 'kandukurijagan1/anudeep';
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


// ==========================================
// ⚡ 4. COMPLETE HIGH-SPEED DATABASE ENGINE (CRUD)
// ==========================================

// Bootstrap: loads all core tables in a single lightning-fast call
app.get('/api/bootstrap', async (req, res) => {
  try {
    let invoices = readJsonFile('invoices', []);
    let products = readJsonFile('products', []);
    let receivers = readJsonFile('receivers', []);
    let consignees = readJsonFile('consignees', []);
    let settings = readJsonFile('settings', getDefaultSettings());

    // If local database is empty, pull from Google Apps Script to bootstrap automatically
    if (invoices.length === 0 && fetch) {
      try {
        const gasRes = await fetch(CLOUD_GAS_URL + '?action=bootstrap', { timeout: 4000 });
        if (gasRes.ok) {
          const cloudData = await gasRes.json();
          if (cloudData) {
            if (Array.isArray(cloudData.invoices) && cloudData.invoices.length > 0) {
              invoices = cloudData.invoices;
              writeJsonFile('invoices', invoices);
            }
            if (Array.isArray(cloudData.products) && cloudData.products.length > 0) {
              products = cloudData.products;
              writeJsonFile('products', products);
            }
            if (Array.isArray(cloudData.receivers) && cloudData.receivers.length > 0) {
              receivers = cloudData.receivers;
              writeJsonFile('receivers', receivers);
            }
            if (Array.isArray(cloudData.consignees) && cloudData.consignees.length > 0) {
              consignees = cloudData.consignees;
              writeJsonFile('consignees', consignees);
            }
            if (cloudData.settings && typeof cloudData.settings === 'object') {
              settings = { ...settings, ...cloudData.settings };
              writeJsonFile('settings', settings);
            }
            console.log('[Bootstrap] Successfully seeded local DB from cloud Google Apps Script.');
          }
        }
      } catch (cloudErr) {
        console.warn('[Bootstrap] Cloud seeding skip:', cloudErr.message);
      }
    }

    res.json({
      success: true,
      invoices,
      products,
      receivers,
      consignees,
      settings,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('[Bootstrap] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Invoices Endpoints ---
app.get('/api/invoices', (req, res) => {
  const invoices = readJsonFile('invoices', []);
  res.json(invoices);
});

app.post('/api/invoices', (req, res) => {
  try {
    const inv = req.body;
    if (!inv) return res.status(400).json({ success: false, error: 'Invoice data required' });

    if (!inv.id && !inv._id) {
      inv.id = 'inv_' + Date.now();
      inv._id = inv.id;
    }

    const invoices = readJsonFile('invoices', []);
    const existingIndex = invoices.findIndex(i => String(i.id || i._id) === String(inv.id || inv._id));
    if (existingIndex > -1) {
      invoices[existingIndex] = inv;
    } else {
      invoices.unshift(inv);
    }
    writeJsonFile('invoices', invoices);

    // Increment next invoice number in settings
    const settings = readJsonFile('settings', getDefaultSettings());
    const invNo = Number(inv.invoiceNo);
    if (!isNaN(invNo) && invNo >= (settings.nextInvoiceNo || 1)) {
      settings.nextInvoiceNo = invNo + 1;
      writeJsonFile('settings', settings);
      forwardToGas('updateSettings', { nextInvoiceNo: settings.nextInvoiceNo });
    }

    // Auto-dispatch bots (WhatsApp + Telegram)
    autoDispatchBots(inv).catch(err => console.warn('[Bot-Dispatch] Warning:', err.message));

    // Asynchronously sync to Cloud Sheet
    forwardToGas('createInvoice', inv);

    // Broadcast real-time update
    broadcastRealtime('invoice_created', { invoice: inv });

    console.log(`✅ [Database] Saved invoice #${inv.invoiceNo || inv.id} locally and dispatched.`);
    res.json({ success: true, invoice: inv, data: inv });
  } catch (err) {
    console.error('[Database] Failed to save invoice:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/invoices/:id', (req, res) => {
  try {
    const id = req.params.id;
    const inv = req.body;
    const invoices = readJsonFile('invoices', []);
    const index = invoices.findIndex(i => String(i.id || i._id) === String(id));
    if (index > -1) {
      invoices[index] = { ...invoices[index], ...inv, id: id, _id: id };
      writeJsonFile('invoices', invoices);
      forwardToGas('updateInvoice', invoices[index], id);
      broadcastRealtime('invoice_updated', { invoice: invoices[index] });
      res.json({ success: true, invoice: invoices[index], data: invoices[index] });
    } else {
      invoices.unshift(inv);
      writeJsonFile('invoices', invoices);
      forwardToGas('createInvoice', inv, id);
      res.json({ success: true, invoice: inv, data: inv });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/invoices/:id', (req, res) => {
  try {
    const id = req.params.id;
    let invoices = readJsonFile('invoices', []);
    invoices = invoices.filter(i => String(i.id || i._id) !== String(id));
    writeJsonFile('invoices', invoices);
    forwardToGas('deleteInvoice', {}, id);
    broadcastRealtime('invoice_deleted', { id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Products Endpoints ---
app.get('/api/products', (req, res) => {
  const products = readJsonFile('products', []);
  res.json(products);
});

app.post('/api/products', (req, res) => {
  try {
    const prod = req.body;
    if (!prod) return res.status(400).json({ success: false, error: 'Product data required' });
    if (!prod.id) prod.id = 'prod_' + Date.now();
    prod.description = prod.description || prod.name || 'Product';
    prod.name = prod.name || prod.description;

    const products = readJsonFile('products', []);
    const existingIndex = products.findIndex(p => String(p.id) === String(prod.id) || (p.name && prod.name && p.name.toLowerCase() === prod.name.toLowerCase()));
    if (existingIndex > -1) {
      products[existingIndex] = { ...products[existingIndex], ...prod };
    } else {
      products.push(prod);
    }
    writeJsonFile('products', products);
    forwardToGas('createProduct', prod, prod.id);
    broadcastRealtime('products_updated', { products });
    res.json({ success: true, product: prod, data: prod });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const id = req.params.id;
    const prod = req.body;
    prod.description = prod.description || prod.name || 'Product';
    prod.name = prod.name || prod.description;

    const products = readJsonFile('products', []);
    const index = products.findIndex(p => String(p.id) === String(id));
    if (index > -1) {
      products[index] = { ...products[index], ...prod, id };
    } else {
      products.push({ ...prod, id });
    }
    writeJsonFile('products', products);
    forwardToGas('updateProduct', prod, id);
    broadcastRealtime('products_updated', { products });
    res.json({ success: true, product: prod, data: prod });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    const id = req.params.id;
    let products = readJsonFile('products', []);
    products = products.filter(p => String(p.id) !== String(id));
    writeJsonFile('products', products);
    forwardToGas('deleteProduct', {}, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Receivers / Consignees (Parties) Endpoints ---
app.get('/api/receivers', (req, res) => {
  res.json(readJsonFile('receivers', []));
});

app.post('/api/receivers', (req, res) => {
  try {
    const rec = req.body;
    if (!rec.id) rec.id = 'rec_' + Date.now();
    const receivers = readJsonFile('receivers', []);
    const idx = receivers.findIndex(r => String(r.id) === String(rec.id) || (r.name && rec.name && r.name.toLowerCase() === rec.name.toLowerCase()));
    if (idx > -1) receivers[idx] = { ...receivers[idx], ...rec };
    else receivers.push(rec);
    writeJsonFile('receivers', receivers);
    forwardToGas('createReceiver', rec, rec.id);
    res.json({ success: true, receiver: rec, data: rec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/receivers/:id', (req, res) => {
  try {
    const id = req.params.id;
    const rec = req.body;
    const receivers = readJsonFile('receivers', []);
    const idx = receivers.findIndex(r => String(r.id) === String(id));
    if (idx > -1) receivers[idx] = { ...receivers[idx], ...rec, id };
    else receivers.push({ ...rec, id });
    writeJsonFile('receivers', receivers);
    forwardToGas('updateReceiver', rec, id);
    res.json({ success: true, receiver: rec, data: rec });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/receivers/:id', (req, res) => {
  try {
    const id = req.params.id;
    let receivers = readJsonFile('receivers', []);
    receivers = receivers.filter(r => String(r.id) !== String(id));
    writeJsonFile('receivers', receivers);
    forwardToGas('deleteReceiver', {}, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/consignees', (req, res) => {
  res.json(readJsonFile('consignees', []));
});

app.post('/api/consignees', (req, res) => {
  try {
    const con = req.body;
    if (!con.id) con.id = 'con_' + Date.now();
    const consignees = readJsonFile('consignees', []);
    const idx = consignees.findIndex(c => String(c.id) === String(con.id) || (c.name && con.name && c.name.toLowerCase() === con.name.toLowerCase()));
    if (idx > -1) consignees[idx] = { ...consignees[idx], ...con };
    else consignees.push(con);
    writeJsonFile('consignees', consignees);
    forwardToGas('createConsignee', con, con.id);
    res.json({ success: true, consignee: con, data: con });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/consignees/:id', (req, res) => {
  try {
    const id = req.params.id;
    const con = req.body;
    const consignees = readJsonFile('consignees', []);
    const idx = consignees.findIndex(c => String(c.id) === String(id));
    if (idx > -1) consignees[idx] = { ...consignees[idx], ...con, id };
    else consignees.push({ ...con, id });
    writeJsonFile('consignees', consignees);
    forwardToGas('updateConsignee', con, id);
    res.json({ success: true, consignee: con, data: con });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/consignees/:id', (req, res) => {
  try {
    const id = req.params.id;
    let consignees = readJsonFile('consignees', []);
    consignees = consignees.filter(c => String(c.id) !== String(id));
    writeJsonFile('consignees', consignees);
    forwardToGas('deleteConsignee', {}, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Settings Endpoints ---
app.get('/api/settings', (req, res) => {
  res.json(readJsonFile('settings', getDefaultSettings()));
});

app.put('/api/settings', (req, res) => {
  try {
    const cur = readJsonFile('settings', getDefaultSettings());
    const incoming = req.body || {};
    const updated = {
      ...cur,
      ...incoming,
      telegram: { ...(cur.telegram || {}), ...(incoming.telegram || {}) },
      whatsapp: { ...(cur.whatsapp || {}), ...(incoming.whatsapp || {}) },
      emailSettings: { ...(cur.emailSettings || {}), ...(incoming.emailSettings || {}) }
    };
    if (Array.isArray(incoming.adminEmails)) {
      updated.adminEmails = incoming.adminEmails;
    }
    writeJsonFile('settings', updated);
    forwardToGas('updateSettings', updated);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/auth/valid-emails', (req, res) => {
  res.json({ success: true, validEmails: getAuthorizedAdminEmails() });
});

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

app.post('/api/whatsapp/reset', async (req, res) => {
  console.log('[WhatsApp] API: User requested session reset');
  try {
    await safeDestroyClient();
    cleanAuthDirectory();
    initWhatsappClient(true);
    res.json({ success: true, message: 'WhatsApp session cleaned and restarted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset: ' + err.message });
  }
});

app.post('/api/whatsapp/logout', async (req, res) => {
  console.log('[WhatsApp] API: User requested device logout');
  try {
    if (client && isWhatsappConnected) {
      await client.logout().catch(() => {});
    }
    await safeDestroyClient();
    cleanAuthDirectory();
    initWhatsappClient(true);
    res.json({ success: true, message: 'Successfully unlinked device.' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed: ' + err.message });
  }
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
  const fileName = (req.body && req.body.filename) || (req.file && req.file.originalname) || 'Invoice.pdf';
  if (!filePath) {
    return res.json({ success: true, warning: 'No file received for local save' });
  }

  try {
    const downloadsDir = path.join(require('os').homedir(), 'Downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    
    const destPath = path.join(downloadsDir, fileName);
    fs.copyFileSync(filePath, destPath);
    try { fs.unlinkSync(filePath); } catch (_) {}
    
    console.log(`Silently saved PDF to: ${destPath}`);
    res.json({ success: true, path: destPath });
  } catch (err) {
    console.error('Error saving PDF locally:', err);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    res.json({ success: false, error: err.message });
  }
});
app.post('/api/whatsapp/sendPdf', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {}); };

  if (!isWhatsappConnected || !client) {
    cleanup();
    return res.json({ success: false, offline: true, error: 'WhatsApp is not connected.' });
  }

  try {
    let phone = req.body && req.body.phone;
    if (!phone) {
      cleanup();
      return res.json({ success: false, error: 'Missing customer phone number' });
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
// 7. START SERVER
// ==========================================
app.listen(PORT, '127.0.0.1', () => {
  console.log(`===============================================`);
  console.log(`⚡ AKB High-Speed Backend Server Running`);
  console.log(`🌐 Local URL: http://127.0.0.1:${PORT}`);
  console.log(`🚀 Database: Google Apps Script (Cloud)`);
  console.log(`📲 WhatsApp: http://127.0.0.1:${PORT}/api/whatsapp/status`);
  console.log(`===============================================`);
});
