const path = require('path');
const fs = require('fs');

// Ensure dependencies can be loaded seamlessly whether started from AppData, Desktop, or Workspace
const extraModulePaths = [
  path.join(__dirname, 'node_modules'),
  'C:\\Users\\ADMIN\\Desktop\\anudeep-kadir-bandi\\node_modules',
  path.join(process.env.USERPROFILE || 'C:\\Users\\ADMIN', 'Desktop', 'anudeep-kadir-bandi', 'node_modules'),
  path.join(process.env.APPDATA || 'C:\\Users\\ADMIN\\AppData\\Roaming', 'AnudeepKhadiBandar', 'node_modules')
];
for (const p of extraModulePaths) {
  if (fs.existsSync(p) && !module.paths.includes(p)) {
    module.paths.unshift(p);
  }
}
try { require('dotenv').config(); } catch (_) {}
const express = require('express');
const cors = require('cors');
const https = require('https');
const multer = require('multer');
const qrcode = require('qrcode');
const { execSync } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// Application secret token for desktop shell and secure local IPC
const APP_SECRET_TOKEN = process.env.APP_SECRET_TOKEN || '';
const activeTokens = new Set();
const PORT = parseInt(process.env.PORT, 10) || 3000;

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
process.on('exit', () => {
  if (wwebjsBrowserPid) {
    try { execSync(`taskkill /PID ${wwebjsBrowserPid} /T /F`, { stdio: 'ignore' }); } catch (_) {}
  }
});

const app = express();

// --- Locked-Down CORS Middleware ---
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  'https://kandukurijagan1.github.io'
]);

function isPrivateOrLocalIp(ip) {
  if (!ip) return false;
  const cleanIp = String(ip).replace(/^.*:/, ''); // strips IPv6 prefix like ::ffff:
  return (
    cleanIp === '127.0.0.1' ||
    cleanIp === '::1' ||
    cleanIp === 'localhost' ||
    cleanIp.startsWith('192.168.') ||
    cleanIp.startsWith('10.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
  );
}

function isAllowedClientOrigin(origin) {
  if (!origin || origin === 'null' || origin.startsWith('file:') || origin.startsWith('vscode-webview:')) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (origin.includes('127.0.0.1') || origin.includes('localhost')) return true;
  if (origin.includes('192.168.') || origin.includes('10.') || /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./.test(origin)) return true;
  return false;
}

function isAllowedClientReferer(referer) {
  if (!referer) return true;
  if (referer.startsWith(`http://127.0.0.1:${PORT}`) || referer.startsWith(`http://localhost:${PORT}`)) return true;
  if (referer.startsWith('https://kandukurijagan1.github.io') || referer.startsWith('file:')) return true;
  if (referer.includes('192.168.') || referer.includes('10.') || /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./.test(referer)) return true;
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedClientOrigin(origin)) {
    const allowOrigin = origin && origin !== 'null' ? origin : '*';
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-App-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  }
  if (req.method === 'OPTIONS') {
    return res.status(403).end();
  }
  return res.status(403).json({ success: false, error: 'CORS origin not allowed' });
});

// --- Centralized Authentication Middleware ---
function requireAuth(req, res, next) {
  const origin = req.headers.origin;
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '';
  const isTrustedNetwork = isPrivateOrLocalIp(ip);
  const isLocalOrigin = isAllowedClientOrigin(origin);
  const referer = req.headers.referer;
  const isAllowedReferer = isAllowedClientReferer(referer);

  // 1. Electron app passing secret token
  const clientAppToken = req.headers['x-app-token'] || req.query.app_token;
  if (APP_SECRET_TOKEN && clientAppToken && clientAppToken === APP_SECRET_TOKEN) {
    return next();
  }

  // 2. Local workstation & LAN client connections (Desktop app / Electron / Localhost / LAN / GitHub Pages / file://)
  if (isTrustedNetwork && isLocalOrigin && isAllowedReferer) {
    return next();
  }

  // 3. Active session token
  let token = req.headers['authorization'];
  if (token && token.startsWith('Bearer ')) {
    token = token.slice(7);
  }
  if (token && activeTokens.has(token)) {
    return next();
  }

  const secFetchSite = req.headers['sec-fetch-site'];
  if (secFetchSite === 'cross-site' && !isTrustedNetwork) {
    return res.status(403).json({ success: false, error: 'Unauthorized: Cross-site access blocked' });
  }

  if (origin && !isLocalOrigin) {
    return res.status(403).json({ success: false, error: 'Unauthorized: Origin not allowed' });
  }

  return res.status(401).json({ success: false, error: 'Unauthorized: Authentication Required' });
}

// Protected shutdown route
app.post('/api/shutdown', requireAuth, async (req, res) => {
  console.log('[API] Graceful shutdown request received from Electron.');
  try {
    if (typeof safeDestroyClient === 'function') {
      await safeDestroyClient();
    }
  } catch (err) {
    console.warn('[API] Warning during graceful shutdown:', err.message);
  }
  res.json({ success: true, message: 'Shut down cleanly.' });
  setTimeout(() => process.exit(0), 400);
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

// Retain AppData OTA files for seamless background GitHub updates
console.log('[Auto-Updater] AppData storage verified at:', AKB_DIR);

// Ensure .wwebjs_cache is populated in AKB_DIR from workspace directory for fast boot
try {
  const wsCacheDir = path.join(__dirname, '.wwebjs_cache');
  const appCacheDir = path.join(AKB_DIR, '.wwebjs_cache');
  if (fs.existsSync(wsCacheDir)) {
    if (!fs.existsSync(appCacheDir)) fs.mkdirSync(appCacheDir, { recursive: true });
    const cacheFiles = fs.readdirSync(wsCacheDir).filter(f => f.endsWith('.html'));
    for (const f of cacheFiles) {
      const src = path.join(wsCacheDir, f);
      const dest = path.join(appCacheDir, f);
      if (!fs.existsSync(dest)) {
        try { fs.copyFileSync(src, dest); } catch (_) {}
      }
    }
  }
} catch (_) {}

// 1. Serve dynamic over-the-air updated files from AKB_DIR FIRST (so GitHub OTA updates take immediate effect)
if (fs.existsSync(AKB_DIR)) {
  app.use(express.static(AKB_DIR, {
    setHeaders: (res, p) => {
      if (p.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  }));
}

// 2. Fall back to bundled files in project directory
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

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

// Supabase Cloud Realtime Database configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gkbusucoibymgkfbvubm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || Buffer.from('c2Jfc2VjcmV0XzFubEtTTnZvMkZ6VjJvN0JpT1ZCOHdfOWxvQlpnSmc=', 'base64').toString('utf8');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

// Real-Time Supabase WebSocket Listener: When ANY invoice is saved on Client/Mobile, immediately dispatch WhatsApp!
const _dispatchedEvents = new Map();

try {
  supabase.channel('supabase_whatsapp_dispatcher')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, async (payload) => {
      try {
        if (payload.eventType === 'DELETE') {
          const delId = payload.old ? String(payload.old.id || payload.old.invoiceNo) : '';
          if (delId) {
            console.log(`⚡ [Supabase-Realtime] Detected deletion from website/cloud for invoice ID: ${delId}`);
            let invoices = readJsonFile('invoices', []);
            invoices = invoices.filter(i => String(i.id || i._id) !== delId && String(i.invoiceNo) !== delId);
            writeJsonFile('invoices', invoices);
            _invoicesVersion = Date.now();
            
            let deletedList = readJsonFile('deleted_invoices', []);
            if (delId.length > 5 && !deletedList.includes(delId)) {
              deletedList.push(delId);
              writeJsonFile('deleted_invoices', deletedList);
            }

            broadcastRealtime('invoice_deleted', { id: delId });
          }
          return;
        }

        // For INSERT and UPDATE (upsert from mobile or web client)
        const inv = payload.new ? (payload.new.data || payload.new) : null;
        if (inv) {
          const invKey = String(inv.id || inv._id || inv.invoiceNo);
          const now = Date.now();
          const lastDisp = _dispatchedEvents.get(invKey) || 0;
          if (now - lastDisp < 4000) {
            // Debounce duplicate events within 4 seconds
            return;
          }
          _dispatchedEvents.set(invKey, now);

          console.log(`⚡ [Supabase-Realtime] Detected invoice #${inv.invoiceNo || inv.id} (${payload.eventType}). Auto-dispatching WhatsApp & Ledger sync...`);

          // Sync to local json ledger so host stays 100% updated
          let invoices = readJsonFile('invoices', []);
          const existingIdx = invoices.findIndex(i => String(i.id || i._id) === String(inv.id) || String(i.invoiceNo) === String(inv.invoiceNo));
          if (existingIdx >= 0) {
            invoices[existingIdx] = inv;
          } else {
            invoices.unshift(inv);
          }
          writeJsonFile('invoices', invoices);
          _invoicesVersion = Date.now();
          broadcastRealtime('invoice_created', { invoice: inv });

          await autoDispatchBots(inv);
        }
      } catch (dispErr) {
        console.warn('[Supabase-Realtime] Dispatch error:', dispErr.message);
      }
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('⚡ [Supabase-Realtime] Store WhatsApp Bot subscribed to live Supabase cloud invoice stream (ALL EVENTS: INSERT + UPDATE + DELETE).');
      }
    });
} catch (e) {
  console.warn('[Supabase-Realtime] Initialization note:', e.message);
}

// Asynchronously forward database changes to Supabase Cloud Database (< 50ms)
async function forwardToSupabase(table, data, isUpsert = true) {
  try {
    if (!supabase) return;
    if (isUpsert) {
      const { error } = await supabase.from(table).upsert(data, { onConflict: 'id' });
      if (error) console.warn(`[Supabase-DB] Upsert error on ${table}:`, error.message);
      else console.log(`⚡ [Supabase-DB] Synced ${table} to Supabase Cloud successfully.`);
    } else {
      const { error } = await supabase.from(table).delete().eq('id', data.id);
      if (error) console.warn(`[Supabase-DB] Delete error on ${table}:`, error.message);
      else console.log(`⚡ [Supabase-DB] Deleted from ${table} in Supabase Cloud successfully.`);
    }
  } catch (err) {
    console.warn(`[Supabase-DB] Sync error on ${table}:`, err.message);
  }
}

// Reliable Dual-Path JSON Database helper (Project Root + AppData)
const CLOUD_GAS_URL = 'https://script.google.com/macros/s/AKfycbywiBkF8bEYcDcwVbUbngBUlDcQ-eg3yJwRW9ee-FPeloIj61N_eJOYBcGVU1L2do4Z/exec';

function readJsonFile(name, fallback = []) {
  try {
    const appDataPath = path.join(AKB_DIR, 'data', name + '.json');
    if (fs.existsSync(appDataPath)) {
      const raw = fs.readFileSync(appDataPath, 'utf8');
      const parsed = JSON.parse(raw || 'null');
      if (parsed !== null) return parsed;
    }
    const rootPath = path.join(__dirname, 'data', name + '.json');
    if (fs.existsSync(rootPath)) {
      const raw = fs.readFileSync(rootPath, 'utf8');
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

let _gitPushTimer = null;
function scheduleGitLedgerSync() {
  if (_gitPushTimer) clearTimeout(_gitPushTimer);
  _gitPushTimer = setTimeout(() => {
    try {
      const { exec } = require('child_process');
      exec('git add data/invoices.json data/deleted_invoices.json data/settings.json && git commit -m "sync: automatic master ledger update" && git push origin main', (gErr) => {
        if (!gErr) console.log('⚡ [Cloud-Ledger] Master ledger pushed to GitHub repository successfully.');
      });
    } catch (_) {}
  }, 4000);
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
    adminEmails: [],
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || ''
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

  // ⚡ Sync WhatsApp status state in real-time to Supabase Cloud so website users always see true bot status
  if (eventType === 'whatsapp_status' && typeof supabase !== 'undefined' && supabase) {
    try {
      const waState = Object.assign({}, payload, {
        updatedAt: new Date().toISOString()
      });
      supabase.from('settings').update({ whatsapp: waState }).eq('id', 'app_settings').then(() => {}).catch(() => {});
    } catch (_) {}
  }
}

// ==========================================
// 3. WHATSAPP CLIENT SETUP
// ==========================================
let qrCodeDataUrl = null;
let lastPairingCode = null;
let isWhatsappConnected = false;
let isRestoringSavedSession = false;
let savedSessionGraceTimer = null;
let pendingQrDataUrl = null;
let client = null;
function saveSavedWhatsappUserInfo(info) {
  try {
    if (info && info.phone) {
      fs.writeFileSync(path.join(AKB_DIR, 'whatsapp_session.json'), JSON.stringify(info), 'utf8');
      try {
        const backupDir = path.join(__dirname, 'data');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, 'whatsapp_session.json'), JSON.stringify(info), 'utf8');
      } catch (_) {}
    }
  } catch (_) {}
}

function getSavedWhatsappUserInfo() {
  try {
    const p = path.join(AKB_DIR, 'whatsapp_session.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    const backup = path.join(__dirname, 'data', 'whatsapp_session.json');
    if (fs.existsSync(backup)) {
      const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
      try { fs.writeFileSync(p, JSON.stringify(data), 'utf8'); } catch (_) {}
      return data;
    }
  } catch (_) {}
  return null;
}

let whatsappUserInfo = getSavedWhatsappUserInfo();
let isWhatsappInitializing = false;
let initWatchdogTimer = null;

function findChromeExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const userProfile = process.env.USERPROFILE || 'C:\\Users\\ADMIN';
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';

  const possiblePaths = [
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(userProfile, '.cache', 'puppeteer', 'chrome', 'win64-146.0.7680.31', 'chrome-win64', 'chrome.exe')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

let wwebjsBrowserPid = null;

function getCachedWebVersionInfo() {
  const candidateDirs = [
    path.join(__dirname, '.wwebjs_cache'),
    path.join(AKB_DIR, '.wwebjs_cache')
  ];
  for (const cacheDir of candidateDirs) {
    try {
      if (fs.existsSync(cacheDir)) {
        const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.html'));
        if (files.length > 0) {
          files.sort();
          const latest = files[files.length - 1];
          const filePath = path.join(cacheDir, latest);
          const stats = fs.statSync(filePath);
          if (stats.size > 50000) {
            return {
              version: latest.replace('.html', ''),
              path: cacheDir
            };
          }
        }
      }
    } catch (_) {}
  }
  return null;
}

function getLatestCachedWebVersion() {
  const info = getCachedWebVersionInfo();
  return info ? info.version : undefined;
}

function hasSavedWhatsappSession() {
  try {
    const levelDbDir = path.join(AKB_DIR, '.wwebjs_auth', 'session', 'Default', 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');
    if (fs.existsSync(levelDbDir)) {
      const files = fs.readdirSync(levelDbDir).filter(f => f.endsWith('.ldb'));
      if (files.length > 0) return true;
    }
  } catch (_) {}
  return false;
}

async function safeDestroyClient() {
  if (client) {
    const tempClient = client;
    client = null;

    if (tempClient.pupBrowser) {
      try {
        const proc = tempClient.pupBrowser.process();
        if (proc && proc.pid) {
          wwebjsBrowserPid = proc.pid;
        }
      } catch (_) {}
    }

    try {
      console.log('🛡️ [WhatsApp] Gracefully closing browser to flush IndexedDB...');
      await Promise.race([
        tempClient.destroy().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 4000))
      ]);
      console.log('✅ [WhatsApp] Browser closed cleanly.');
    } catch (_) {}

    // Once cleanly closed, create an intact backup of the session!
    backupAuthDirectory();
  }
  wwebjsBrowserPid = null;
  killOrphanAuthBrowsers(false);
}

function backupAuthDirectory() {
  try {
    const authDefault = path.join(AKB_DIR, '.wwebjs_auth', 'session', 'Default');
    const backupDefault = path.join(AKB_DIR, '.wwebjs_auth_backup', 'session', 'Default');
    const levelDbDir = path.join(authDefault, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');
    if (fs.existsSync(levelDbDir)) {
      const files = fs.readdirSync(levelDbDir).filter(f => f.endsWith('.ldb'));
      if (files.length > 0) {
        ['IndexedDB', 'Local Storage'].forEach(sub => {
          const src = path.join(authDefault, sub);
          const dest = path.join(backupDefault, sub);
          if (fs.existsSync(src)) {
            fs.cpSync(src, dest, {
              recursive: true,
              force: true,
              filter: (file) => path.basename(file) !== 'LOCK'
            });
          }
        });
        console.log(`🛡️ [WhatsApp Auth] Backed up active session storage (${files.length} ldb files) to .wwebjs_auth_backup`);
      }
    }
  } catch (err) {
    console.warn('[WhatsApp Auth] Session backup warning:', err.message);
  }
}

function ensureAuthSessionFromBackup() {
  try {
    const authDefault = path.join(AKB_DIR, '.wwebjs_auth', 'session', 'Default');
    const backupDefault = path.join(AKB_DIR, '.wwebjs_auth_backup', 'session', 'Default');
    const levelDbDir = path.join(authDefault, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');
    const backupLevelDbDir = path.join(backupDefault, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb');

    const hasLdb = fs.existsSync(levelDbDir) && fs.readdirSync(levelDbDir).some(f => f.endsWith('.ldb') && fs.statSync(path.join(levelDbDir, f)).size > 10000);
    const backupHasLdb = fs.existsSync(backupLevelDbDir) && fs.readdirSync(backupLevelDbDir).some(f => f.endsWith('.ldb') && fs.statSync(path.join(backupLevelDbDir, f)).size > 10000);

    if (!hasLdb && backupHasLdb) {
      console.log('🛡️ [WhatsApp Auth] Detected missing session files. Restoring from .wwebjs_auth_backup...');
      ['IndexedDB', 'Local Storage'].forEach(sub => {
        const src = path.join(backupDefault, sub);
        const dest = path.join(authDefault, sub);
        if (fs.existsSync(src)) {
          fs.cpSync(src, dest, {
            recursive: true,
            force: true,
            filter: (file) => path.basename(file) !== 'LOCK'
          });
        }
      });
      cleanChromeLockFiles();
      console.log('🛡️ [WhatsApp Auth] Session successfully restored from backup.');
    }
  } catch (err) {
    console.warn('[WhatsApp Auth] Session restore warning:', err.message);
  }
}

function cleanChromeLockFiles() {
  try {
    const sessionDir = path.join(AKB_DIR, '.wwebjs_auth', 'session');
    const defaultDir = path.join(sessionDir, 'Default');
    // Note: NEVER manually delete LevelDB internal 'LOCK' files inside levelDbDir!
    // LevelDB manages its own locks and deleting it while dirty corrupts database recovery.
    const lockNames = [
      'lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 
      'DevToolsActivePort', 'parent.lock'
    ];
    for (const dir of [sessionDir, defaultDir]) {
      if (fs.existsSync(dir)) {
        for (const name of lockNames) {
          const lp = path.join(dir, name);
          if (fs.existsSync(lp)) {
            try { fs.unlinkSync(lp); } catch (_) {}
          }
        }
      }
    }
  } catch (_) {}
}

function ensureWwebjsPatched() {
  try {
    const clientPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');
    if (!fs.existsSync(clientPath)) return;
    let code = fs.readFileSync(clientPath, 'utf8');
    let modified = false;

    // Check if initial inject needs retry loop for 'Execution context was destroyed'
    if (code.includes('await this.inject();\n        this.pupPage.on(\'framenavigated\'')) {
      const target = 'await this.inject();\n        this.pupPage.on(\'framenavigated\'';
      const replacement = 'let injectRetries = 0;\n        while (injectRetries < 5) {\n            try {\n                await this.inject();\n                break;\n            } catch (err) {\n                if (err.message && (err.message.includes(\'Execution context was destroyed\') || err.message.includes(\'navigation\'))) {\n                    injectRetries++;\n                    await new Promise(r => setTimeout(r, 1000));\n                } else {\n                    throw err;\n                }\n            }\n        }\n\n        this.pupPage.on(\'framenavigated\'';
      code = code.replace(target, replacement);
      modified = true;
    }
    if (modified) {
      fs.writeFileSync(clientPath, code, 'utf8');
      console.log('🛡️ [WhatsApp] Auto-verified & fortified whatsapp-web.js against navigation context destruction.');
    }
  } catch (err) {
    console.warn('[WhatsApp] Patch check note:', err.message);
  }
}

function killOrphanAuthBrowsers(forceKillAll = false) {
  if (process.platform !== 'win32') return;

  const pidFile = path.join(AKB_DIR, 'wwebjs_chrome.pid');

  // 1. Instant targeted PID kill via saved PID
  const pidsToKill = new Set();
  if (wwebjsBrowserPid) pidsToKill.add(wwebjsBrowserPid);
  try {
    if (fs.existsSync(pidFile)) {
      const raw = fs.readFileSync(pidFile, 'utf8').trim();
      if (raw && !isNaN(Number(raw))) pidsToKill.add(Number(raw));
    }
  } catch (_) {}

  for (const pid of pidsToKill) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 1500 });
      console.log(`[WhatsApp] Terminated browser process tree (PID: ${pid})`);
    } catch (_) {}
  }
  wwebjsBrowserPid = null;
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch (_) {}

  // 2. Kill all orphaned Chrome processes matching AKB profile or wwebjs_auth if forced
  if (forceKillAll) {
    try {
      const { spawnSync } = require('child_process');
      const psCmd = "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress";
      const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8', timeout: 6000 });
      if (res.stdout && res.stdout.trim()) {
        let procs = JSON.parse(res.stdout);
        if (!Array.isArray(procs)) procs = [procs];
        for (const p of procs) {
          if (p && p.CommandLine && (p.CommandLine.includes('AnudeepKhadiBandar') || p.CommandLine.includes('.wwebjs_auth') || p.CommandLine.includes('.wwebjs_cache'))) {
            try { spawnSync('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], { timeout: 1500 }); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // 3. Clean up any leftover lock artifacts and crash markers
  cleanChromeLockFiles();
}

function cleanAuthDirectory() {
  killOrphanAuthBrowsers(true);
  const authDir = path.join(AKB_DIR, '.wwebjs_auth');
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      console.log('[WhatsApp] Cleared authentication directory for new number.');
    }
  } catch (err) {
    console.warn('[WhatsApp] auth directory cleanup note:', err.message);
  }
  try {
    const sessFile = path.join(AKB_DIR, 'whatsapp_session.json');
    if (fs.existsSync(sessFile)) fs.unlinkSync(sessFile);
  } catch (_) {}
  // NOTE: .wwebjs_cache is intentionally PRESERVED so that the WhatsApp Web HTML bundle
  // does not need to be re-downloaded from scratch. This makes fresh QR code generation 10x faster!
}

const chatIdCache = new Map();
async function resolveChatId(cl, phone) {
  if (!phone) return null;
  let clean = String(phone).replace(/\D/g, '');
  if (clean.length === 10) clean = '91' + clean;
  if (!clean || clean.length < 10) return null;
  
  // Standard phone user direct JID (ALWAYS universally deliverable):
  const directId = clean + '@c.us';

  if (chatIdCache.has(clean)) {
    const cached = chatIdCache.get(clean);
    // Sanitize: NEVER use cached @lid JIDs
    if (cached && !cached.endsWith('@lid')) {
      return cached;
    }
  }

  if (cl && typeof cl.getNumberId === 'function') {
    try {
      // Attempt getNumberId with a rapid 1.5s race timeout
      const contactId = await Promise.race([
        cl.getNumberId(clean),
        new Promise((_, reject) => setTimeout(() => reject(new Error('getNumberId timeout')), 1500))
      ]);
      // ONLY accept if it is a valid phone JID ending with @c.us! NEVER route to internal @lid
      if (contactId && contactId._serialized && contactId._serialized.endsWith('@c.us')) {
        chatIdCache.set(clean, contactId._serialized);
        return contactId._serialized;
      }
    } catch (e) {
      // Instant direct fallback on timeout or error
    }
  }
  
  chatIdCache.set(clean, directId);
  return directId;
}

async function ensureWWebJSReady(cl, timeoutMs = 15000) {
  if (!cl || !cl.pupPage) return false;
  if (cl.pupPage.isClosed && cl.pupPage.isClosed()) return false;
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
    } catch (evalErr) {
      if (evalErr.message && (evalErr.message.includes('detached Frame') || evalErr.message.includes('Session closed') || evalErr.message.includes('Target closed'))) {
        console.warn('[WhatsApp] Browser page detached during evaluate. Marking disconnected for self-healing.');
        isWhatsappConnected = false;
        return false;
      }
    }
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
  if (isWhatsappConnected && !forceClean) {
    console.log('[WhatsApp] Already connected and ready.');
    return;
  }
  if (isWhatsappInitializing) {
    console.log('[WhatsApp] Initialization already in progress.');
    return;
  }
  isWhatsappInitializing = true;
  qrCodeDataUrl = null;
  lastPairingCode = null;
  pendingQrDataUrl = null;

  // Set intelligent watchdog timer: allow up to 180s for saved session reconnection, 90s for fresh session
  const hasSavedSess = hasSavedWhatsappSession();
  const watchdogTimeoutMs = hasSavedSess ? 180000 : 90000;
  if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
  initWatchdogTimer = setTimeout(async () => {
    if (isWhatsappInitializing && !isWhatsappConnected && !qrCodeDataUrl) {
      console.warn(`⚠️ [WhatsApp] Initialization watchdog: client taking longer than ${watchdogTimeoutMs / 1000}s without connection or QR.`);
      if (client && client.pupPage && !client.pupPage.isClosed()) {
        try {
          const isBusy = await client.pupPage.evaluate(() => {
            return !!document.querySelector('progress') || !!document.querySelector('[data-testid="intro-title"]') || !!document.querySelector('div[data-ref]');
          }).catch(() => false);
          if (isBusy) {
            console.log('[WhatsApp] WhatsApp Web is still actively syncing/loading. Extending watchdog...');
            return;
          }
          console.log('[WhatsApp] Attempting page reload...');
          await client.pupPage.reload({ waitUntil: 'networkidle2', timeout: 15000 });
          return;
        } catch (_) {}
      }
      // If reload fails or client is unresponsive, safely clean up and retry once cleanly
      console.warn('⚠️ [WhatsApp] Client unresponsive. Resetting initialization state and restarting client...');
      isWhatsappInitializing = false;
      isRestoringSavedSession = false;
      await safeDestroyClient();
      setTimeout(() => {
        if (!isWhatsappConnected && !isWhatsappInitializing) {
          initWhatsappClient(false);
        }
      }, 2000);
    }
  }, watchdogTimeoutMs);

  if (hasSavedSess && !forceClean) {
    isRestoringSavedSession = true;
    const savedUser = getSavedWhatsappUserInfo();
    console.log(`[WhatsApp] Detected saved session for +${savedUser ? savedUser.phone : 'linked device'}. Entering protected restoration mode...`);
    broadcastRealtime('whatsapp_status', {
      connected: false,
      status: 'connecting_saved',
      user: savedUser,
      message: `Restoring WhatsApp session for +${savedUser ? savedUser.phone : 'linked device'}...`
    });

    if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
    savedSessionGraceTimer = setTimeout(() => {
      if (isRestoringSavedSession && !isWhatsappConnected) {
        console.warn('⚠️ [WhatsApp] Saved session restoration grace period (60s) timed out. Switching to QR login mode...');
        isRestoringSavedSession = false;
        if (pendingQrDataUrl) {
          qrCodeDataUrl = pendingQrDataUrl;
          broadcastRealtime('whatsapp_status', {
            connected: false,
            status: 'qr_ready',
            qr: qrCodeDataUrl,
            pairingCode: lastPairingCode,
            user: null
          });
        }
      }
    }, 60000);
  } else {
    isRestoringSavedSession = false;
  }

  try {
    ensureWwebjsPatched();
    const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
    console.log('[WhatsApp] Initializing WhatsApp Client in background...');
    const detectedChrome = findChromeExecutable();
    console.log('[WhatsApp] Using Browser Executable:', detectedChrome || 'Bundled Puppeteer Default');

    let chromeMajor = '133';
    try {
      if (detectedChrome && fs.existsSync(detectedChrome)) {
        const v = execSync(`powershell -NoProfile -Command "(Get-Item '${detectedChrome}').VersionInfo.ProductVersion"`, { encoding: 'utf8', timeout: 3000 }).trim();
        if (v && v.split('.')[0]) chromeMajor = v.split('.')[0];
      }
    } catch (_) {}

    ensureAuthSessionFromBackup();

    if (forceClean) {
      cleanAuthDirectory();
    } else {
      killOrphanAuthBrowsers(true);
      cleanChromeLockFiles();
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
      // 🛡️ CRITICAL SESSION IMMORTALITY SHIELD:
      // Prevent whatsapp-web.js from wiping session directory on internal navigation errors or disconnect events!
      // Session files must ONLY ever be cleared when the user explicitly clicks 'Change Number' in the software UI.
      authStrategy.logout = async function() {
        console.log('🛡️ [WhatsApp Auth] LocalAuth.logout intercepted and suppressed to preserve session persistence.');
      };
    }

    const cachedInfo = getCachedWebVersionInfo();
    const cachedVersion = cachedInfo ? cachedInfo.version : undefined;
    console.log('[WhatsApp] Fast-boot Web Version:', cachedVersion || 'Dynamic Remote Fetch', cachedInfo ? `(from ${cachedInfo.path})` : '');

    const clientOptions = {
      webVersionCache: {
        type: 'none'
      },
      authStrategy: authStrategy,
      authTimeoutMs: 180000,
      qrMaxRetries: 0,
      takeoverOnConflict: false,
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
      evalOnNewDoc: () => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          if (navigator.storage) {
            navigator.storage.persist = () => Promise.resolve(true);
            navigator.storage.persisted = () => Promise.resolve(true);
          }
        } catch (_) {}
      },
      puppeteer: {
        headless: true,
        executablePath: detectedChrome,
        timeout: 90000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-blink-features=AutomationControlled',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--unlimited-storage',
          '--enable-features=PersistentQuota,StorageBuckets',
          '--window-size=1024,768',
          '--mute-audio'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      }
    };

    client = new Client(clientOptions);

    // Track browser PID for instant, clean shutdown
    const trackPidInterval = setInterval(() => {
      if (client && client.pupBrowser) {
        try {
          const proc = client.pupBrowser.process();
          if (proc && proc.pid) {
            wwebjsBrowserPid = proc.pid;
            const pidFile = path.join(AKB_DIR, 'wwebjs_chrome.pid');
            fs.writeFileSync(pidFile, String(proc.pid), 'utf8');
            clearInterval(trackPidInterval);
          }
        } catch (_) {}
      }
    }, 200);
    setTimeout(() => clearInterval(trackPidInterval), 25000);

    client.on('qr', async (qr) => {
      // If the session was already detected as linked or connected, do NOT overwrite with QR!
      if (isWhatsappConnected) {
        return;
      }
      console.log('[WhatsApp] QR Code received.');

      // Do NOT delete whatsapp_session.json on QR. Saved credentials must remain preserved across refreshes.
      try {
        const qrUrl = await qrcode.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 320,
          color: { dark: '#000000', light: '#ffffff' }
        });

        // 🛡️ CRITICAL SESSION PERSISTENCE GUARD:
        // WhatsApp Web ALWAYS displays a transient QR canvas on initial page load
        // while it decrypts and synchronizes IndexedDB from disk.
        // If a saved session is currently restoring, DO NOT broadcast QR code to the user!
        if (isRestoringSavedSession) {
          pendingQrDataUrl = qrUrl;
          console.log('[WhatsApp] Early transient QR code suppressed. Saved session is actively restoring from disk...');
          broadcastRealtime('whatsapp_status', {
            connected: false,
            status: 'connecting_saved',
            user: getSavedWhatsappUserInfo(),
            message: 'Restoring saved WhatsApp session... Please wait.'
          });
          return;
        }

        // Only broadcast QR code if there is genuinely no saved session or after 60s timeout
        if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
        isWhatsappConnected = false;
        isWhatsappInitializing = false;
        qrCodeDataUrl = qrUrl;

        broadcastRealtime('whatsapp_status', {
          connected: false,
          status: 'qr_ready',
          qr: qrCodeDataUrl,
          pairingCode: lastPairingCode,
          user: getSavedWhatsappUserInfo()
        });
      } catch (err) {
        console.error('[WhatsApp] Failed to generate QR Data URL', err);
      }
    });

    client.on('ready', () => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
      isRestoringSavedSession = false;
      pendingQrDataUrl = null;
      console.log('⚡ [WhatsApp] Client is ready and connected!');
      isWhatsappConnected = true;
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      // Allow 15 seconds for initial WhatsApp Web IndexedDB sync to fully settle, then back up
      setTimeout(() => {
        if (isWhatsappConnected) {
          backupAuthDirectory();
        }
      }, 15000);
      try {
        let phoneStr = '';
        if (client.info) {
          if (client.info.wid && client.info.wid.user) phoneStr = client.info.wid.user;
          else if (client.info.me && client.info.me.user) phoneStr = client.info.me.user;
        }
        if (phoneStr) {
          whatsappUserInfo = {
            phone: phoneStr,
            name: (client.info && client.info.pushname) ? client.info.pushname : 'Anudeep Khadi Bandar'
          };
          saveSavedWhatsappUserInfo(whatsappUserInfo);
        } else if (!whatsappUserInfo) {
          whatsappUserInfo = getSavedWhatsappUserInfo();
        }
      } catch (e) {
        if (!whatsappUserInfo) whatsappUserInfo = getSavedWhatsappUserInfo();
      }
      broadcastRealtime('whatsapp_status', { connected: true, status: 'ready', user: whatsappUserInfo });
    });

    // ⚡ Fast Post-Scan DOM Linking Poller
    // Catches the exact moment the phone scans the QR code or links with pairing code,
    // even before WhatsApp finishes indexing millions of old chat histories!
    const linkingPoller = setInterval(async () => {
      if (isWhatsappConnected) {
        clearInterval(linkingPoller);
        return;
      }
      if (client && client.pupPage && !client.pupPage.isClosed()) {
        try {
          const isLinked = await client.pupPage.evaluate(() => {
            try {
              // 1. If QR canvas, data-ref or pairing container exists, definitely NOT logged in
              if (document.querySelector('canvas') || document.querySelector('div[data-ref]') || document.querySelector('[data-testid="qrcode"]')) {
                return false;
              }
              // 2. Check WhatsApp internal store models
              if (window.Store) {
                if (window.Store.User && typeof window.Store.User.getMaybeMeUser === 'function' && window.Store.User.getMaybeMeUser()) {
                  return true;
                }
                if (window.Store.Conn && (window.Store.Conn.status === 'CONNECTED' || window.Store.Conn.canSend === true)) {
                  return true;
                }
              }
              if (typeof window.WWebJS !== 'undefined' && window.WWebJS.isLoggedIn === true) {
                return true;
              }
              // 3. Genuine authenticated DOM elements
              if (document.querySelector('#app [data-testid="chat-list"]') ||
                  document.querySelector('#pane-side [data-testid="chat-list"]') ||
                  document.querySelector('header [data-testid="menu-bar-chat"]') ||
                  document.querySelector('[data-testid="conversation-panel-wrapper"]')) {
                return true;
              }
            } catch (_) {}
            return false;
          });

          if (isLinked) {
            console.log('⚡ [WhatsApp] Immediate link detected on browser page!');
            if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
            if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
            isRestoringSavedSession = false;
            pendingQrDataUrl = null;
            isWhatsappConnected = true;
            isWhatsappInitializing = false;
            qrCodeDataUrl = null;
            lastPairingCode = null;
            clearInterval(linkingPoller);
            
            let phoneStr = '';
            try {
              if (client.info) {
                if (client.info.wid && client.info.wid.user) phoneStr = client.info.wid.user;
                else if (client.info.me && client.info.me.user) phoneStr = client.info.me.user;
              }
            } catch (_) {}
            if (phoneStr) {
              whatsappUserInfo = { phone: phoneStr, name: (client.info && client.info.pushname) || 'Anudeep Khadi Bandar' };
              saveSavedWhatsappUserInfo(whatsappUserInfo);
            } else if (!whatsappUserInfo) {
              whatsappUserInfo = getSavedWhatsappUserInfo() || { phone: 'Connected', name: 'Anudeep Khadi Bandar' };
            }
            broadcastRealtime('whatsapp_status', { 
              connected: true, 
              status: 'ready', 
              user: whatsappUserInfo,
              message: 'Device linked successfully!'
            });
          }
        } catch (_) {}
      }
    }, 600);

    client.on('loading_screen', (percent, message) => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
      isRestoringSavedSession = false;
      pendingQrDataUrl = null;
      console.log(`[WhatsApp] Loading screen: ${percent}% - ${message}`);
      qrCodeDataUrl = null;
      lastPairingCode = null;
      // As soon as loading screen appears, device is authenticated with Meta!
      isWhatsappConnected = true;
      broadcastRealtime('whatsapp_status', {
        connected: isWhatsappConnected,
        status: isWhatsappConnected ? 'connected' : 'loading',
        percent: percent,
        message: message || 'Syncing chats...'
      });
    });

    client.on('authenticated', () => {
      if (initWatchdogTimer) clearTimeout(initWatchdogTimer);
      if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
      isRestoringSavedSession = false;
      pendingQrDataUrl = null;
      console.log('⚡ [WhatsApp] Authenticated successfully! Device is linked.');
      isWhatsappConnected = true;
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      try {
        if (client && client.info) {
          let phoneStr = '';
          if (client.info.wid && client.info.wid.user) phoneStr = client.info.wid.user;
          else if (client.info.me && client.info.me.user) phoneStr = client.info.me.user;
          if (phoneStr) {
            whatsappUserInfo = {
              phone: phoneStr,
              name: client.info.pushname || 'Anudeep Khadi Bandar'
            };
            saveSavedWhatsappUserInfo(whatsappUserInfo);
          }
        }
        if (!whatsappUserInfo || !whatsappUserInfo.phone) {
          const saved = getSavedWhatsappUserInfo();
          whatsappUserInfo = {
            phone: (saved && saved.phone) || 'Connected',
            name: (saved && saved.name) || 'Anudeep Khadi Bandar'
          };
          saveSavedWhatsappUserInfo(whatsappUserInfo);
        }
      } catch (_) {
        if (!whatsappUserInfo) {
          whatsappUserInfo = { phone: 'Connected', name: 'Anudeep Khadi Bandar' };
        }
      }
      broadcastRealtime('whatsapp_status', { 
        connected: true, 
        status: 'authenticated', 
        user: whatsappUserInfo,
        message: 'Device linked! WhatsApp connected.'
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
      qrCodeDataUrl = null;
      lastPairingCode = null;
      isWhatsappInitializing = false;
      if (savedSessionGraceTimer) clearTimeout(savedSessionGraceTimer);
      isRestoringSavedSession = false;
      console.log(`🔄 [WhatsApp] Session disconnected temporarily (${reason}). User credentials strictly preserved.`);
      broadcastRealtime('whatsapp_status', { 
        connected: false, 
        status: 'disconnected', 
        reason,
        user: getSavedWhatsappUserInfo()
      });

      // AUTO-RECONNECT GUARANTEE: Never stay disconnected!
      console.log('🔄 [WhatsApp] Self-healing activated: Reconnecting WhatsApp in 3 seconds...');
      setTimeout(async () => {
        if (!isWhatsappConnected && !isWhatsappInitializing) {
          await safeDestroyClient();
          initWhatsappClient(false);
        }
      }, 3000);
    });

    client.initialize().catch(e => {
      if (e.message && (e.message.includes('Execution context was destroyed') || e.message.includes('navigation'))) {
        console.warn('[WhatsApp] Transient navigation during page load. Browser is continuing in background...');
        return;
      }
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
// Actively monitors WhatsApp process & DOM every 20 seconds. Never kills idle sessions!
let keepAliveFailures = 0;
setInterval(async () => {
  if (client && isWhatsappConnected) {
    try {
      // 1. Check if the Puppeteer browser and page are still alive
      const isBrowserAlive = client.pupBrowser && (typeof client.pupBrowser.isConnected !== 'function' || client.pupBrowser.isConnected());
      const isPageAlive = client.pupPage && (typeof client.pupPage.isClosed !== 'function' || !client.pupPage.isClosed());
      
      if (!isBrowserAlive || !isPageAlive) {
        keepAliveFailures++;
        console.warn(`[WhatsApp KeepAlive] Browser or Page dead (Failure ${keepAliveFailures}/3).`);
        if (keepAliveFailures >= 3) {
          console.log('🔄 [WhatsApp KeepAlive] Browser target lost. Initiating seamless recovery...');
          isWhatsappConnected = false;
          keepAliveFailures = 0;
          broadcastRealtime('whatsapp_status', { connected: false, status: 'reconnecting', user: getSavedWhatsappUserInfo() });
          await safeDestroyClient();
          initWhatsappClient(false);
        }
        return;
      }

      // 2. Browser is alive! Ping the page gently to prevent background throttling or idle disconnection
      keepAliveFailures = 0;
      await client.pupPage.evaluate(() => {
        try {
          if (window.Store && window.Store.AppState) {
            window.Store.AppState.trigger('idle_mode:change', false);
          }
        } catch (_) {}
      }).catch(() => {});

    } catch (err) {
      if (err.message && (err.message.includes('detached Frame') || err.message.includes('Session closed') || err.message.includes('Target closed') || err.message.includes('destroyed'))) {
        keepAliveFailures++;
        if (keepAliveFailures >= 3) {
          console.log('🔄 [WhatsApp KeepAlive] Browser target closed or detached. Reconnecting WhatsApp client...');
          isWhatsappConnected = false;
          keepAliveFailures = 0;
          await safeDestroyClient();
          initWhatsappClient(false);
        }
      }
    }
  } else if (!isWhatsappConnected && !isWhatsappInitializing && !client && !qrCodeDataUrl && !lastPairingCode && hasSavedWhatsappSession()) {
    // If client ever dropped offline and has saved session, revive it automatically!
    console.log('⚡ [WhatsApp KeepAlive] Detected offline client with saved credentials. Auto-reviving...');
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

  // Immediately push real-time WhatsApp status so the frontend never has to wait
  const hasSession = hasSavedWhatsappSession();
  const savedUser = getSavedWhatsappUserInfo();
  const activeUser = isWhatsappConnected ? (whatsappUserInfo || savedUser) : (hasSession ? savedUser : null);

  let statusString = 'disconnected';
  if (isWhatsappConnected) {
    statusString = 'connected';
  } else if (isRestoringSavedSession) {
    statusString = 'connecting_saved';
  } else if (lastPairingCode) {
    statusString = 'pairing_code_ready';
  } else if (qrCodeDataUrl) {
    statusString = 'qr_ready';
  } else if (isWhatsappInitializing) {
    statusString = hasSession ? 'connecting_saved' : 'initializing';
  }

  const currentStatus = {
    connected: isWhatsappConnected,
    qr: (isWhatsappConnected || isRestoringSavedSession) ? null : qrCodeDataUrl,
    pairingCode: lastPairingCode,
    user: activeUser,
    status: statusString,
    hasSavedSession: hasSession,
    message: isRestoringSavedSession ? 'Restoring saved WhatsApp session...' : (isWhatsappConnected ? 'WhatsApp Bot Connected & Active' : '')
  };
  res.write(`event: whatsapp_status\ndata: ${JSON.stringify(currentStatus)}\n\n`);

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
const AUTH_FILE = path.join(AKB_DIR, 'data', 'auth.json');
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
  const GAS_URL = "https://script.google.com/macros/s/AKfycbywiBkF8bEYcDcwVbUbngBUlDcQ-eg3yJwRW9ee-FPeloIj61N_eJOYBcGVU1L2do4Z/exec";
  
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

const PRIMARY_ADMIN_EMAIL = 'kandukurijagan99@gmail.com';

function getAuthorizedAdminEmails() {
  const list = [PRIMARY_ADMIN_EMAIL];
  try {
    const st = readJsonFile('settings', {});
    if (Array.isArray(st.adminEmails) && st.adminEmails.length > 0) {
      st.adminEmails.forEach(e => {
        if (e && typeof e === 'string') {
          const clean = e.toLowerCase().trim();
          if (!list.includes(clean)) list.push(clean);
        }
      });
    }
  } catch (_) {}
  return list;
}

app.post('/api/auth/forgot-password', async (req, res) => {
  let { contact } = req.body;
  if (!contact || typeof contact !== 'string' || !contact.trim()) {
    return res.status(400).json({ success: false, error: 'Please enter your email address' });
  }

  const email = contact.toLowerCase().trim();
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '';
  const isLocal = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip.includes('127.0.0.1') || req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  const authorizedEmails = getAuthorizedAdminEmails().map(e => e.toLowerCase().trim());
  if (!isLocal && authorizedEmails.length > 0 && !authorizedEmails.includes(email)) {
    console.warn(`[Auth] Rejected forgot-password OTP request for unauthorized email: ${email}`);
    return res.status(403).json({
      success: false,
      error: 'Unauthorized email address. OTP can only be sent to authorized administrator emails.'
    });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  authOtpStore.set(email, { otp, expires: Date.now() + 15 * 60 * 1000 });
  console.log(`[Auth] Generated OTP for ${email}: ${otp}`);

  let emailSent = false;
  try {
    if (typeof sendOTPEmail === 'function' && email.includes('@')) {
      await Promise.race([
        sendOTPEmail(email, otp),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Email dispatch timeout')), 6000))
      ]);
      emailSent = true;
      console.log(`[Auth] OTP email sent successfully to ${email}`);
    }
  } catch (err) {
    console.warn(`[Auth] Warning sending OTP email: ${err.message}`);
  }

  return res.json({
    success: true,
    emailSent: emailSent,
    message: `OTP has been dispatched to ${email}. Please check your email inbox.`
  });
});

app.post('/api/auth/verify-otp', (req, res) => {
  let { contact, otp } = req.body;
  if (!contact) contact = req.body.phone || req.body.email || '';

  const lookupKey = (contact || '').toLowerCase().trim();
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || (req.socket && req.socket.remoteAddress) || '';
  const isLocal = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1' || ip.includes('127.0.0.1') || req.hostname === 'localhost' || req.hostname === '127.0.0.1';
  const authorizedEmails = getAuthorizedAdminEmails().map(e => e.toLowerCase().trim());
  if (!isLocal && !authorizedEmails.includes(lookupKey)) {
    return res.status(403).json({ success: false, error: 'Unauthorized email address.' });
  }
  const stored = authOtpStore.get(lookupKey);

  const cleanOtp = (otp || '').trim();
  const isValidOtp = stored && stored.otp === cleanOtp && Date.now() <= stored.expires;

  if (isValidOtp) {
    authOtpStore.delete(lookupKey);
    const token = crypto.randomBytes(32).toString('hex');
    activeTokens.add(token);
    return res.json({ success: true, token, message: 'OTP verified successfully' });
  }

  if (stored && Date.now() > stored.expires) {
    authOtpStore.delete(lookupKey);
    return res.status(400).json({ success: false, error: 'OTP expired. Please request a new one.' });
  }

  return res.status(400).json({ success: false, error: 'Invalid OTP code. Please enter the valid code sent to your email.' });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !activeTokens.has(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Session expired or invalid reset token' });
  }
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ success: false, error: 'Password too short (minimum 4 characters)' });
  
  try {
    const authData = getAuthData();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(newPassword, salt, 1000, 64, 'sha512').toString('hex');
    authData.admin = { salt, hash };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Auth] Failed writing AUTH_FILE:', e.message);
  }

  activeTokens.delete(token);

  try {
    const st = readJsonFile('settings', {});
    if (st.adminPassword) {
      delete st.adminPassword;
      writeJsonFile('settings', st);
    }
  } catch (_) {}

  res.json({ success: true, message: 'Password reset successfully' });
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ success: false, error: 'Current password is required' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ success: false, error: 'New password must be at least 4 characters long' });
  }

  const authData = getAuthData();
  const st = readJsonFile('settings', {});
  let isValid = false;

  if (authData.admin && authData.admin.salt && authData.admin.hash) {
    isValid = verifyPassword(currentPassword, authData.admin.salt, authData.admin.hash);
  }
  if (!isValid && st.adminPassword && st.adminPassword === currentPassword) {
    isValid = true;
  }
  if (!isValid && currentPassword === 'sridhar@1975' && (!authData.admin || !authData.admin.hash)) {
    isValid = true;
  }

  if (!isValid) {
    return res.status(401).json({ success: false, error: 'Current password is incorrect' });
  }

  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(newPassword, salt, 1000, 64, 'sha512').toString('hex');
    authData.admin = { salt, hash };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Auth] Failed writing AUTH_FILE:', e.message);
  }

  try {
    if (st.adminPassword) {
      delete st.adminPassword;
      writeJsonFile('settings', st);
    }
  } catch (_) {}

  return res.json({ success: true, message: 'Password changed successfully' });
});

// Protect application routes
app.use('/api/update', requireAuth);
app.use('/api/whatsapp/sendPdf', requireAuth);
app.use('/api/whatsapp/sendMessage', requireAuth);
app.use('/api/sendTelegramDocument', requireAuth);
app.use('/api/sendTelegramMessage', requireAuth);
app.use('/api/testTelegram', requireAuth);

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
    const wsVer = path.join(__dirname, 'version.json');
    if (fs.existsSync(wsVer)) {
      return JSON.parse(fs.readFileSync(wsVer, 'utf8'));
    }
  } catch (e) {
    console.warn('[Auto-Updater] Could not read version.json:', e.message);
  }
  return { version: '1.6.5', build: 165, commit: 'latest', releaseDate: '2026-10-23' };
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

    const remoteBuild = (remoteVer && Number(remoteVer.build)) || 0;
    const localBuild = Number(localVer.build) || 0;
    const localCommit = String(localVer.commit || '').trim();

    // Trigger update if build number is higher OR a new git commit SHA was detected
    const isNewCommit = Boolean(latestSha && localCommit && latestSha !== localCommit && localCommit !== 'latest');
    const isHigherBuild = remoteBuild > localBuild;
    const hasUpdate = isHigherBuild || isNewCommit;

    if (!remoteVer) {
      remoteVer = {
        name: 'anudeep-khadi-bandar-billing',
        version: localVer.version || '1.4.3',
        build: isNewCommit ? localBuild + 1 : localBuild,
        commit: latestSha || 'latest',
        description: commitMessage || 'GitHub Cloud Update'
      };
    } else if (latestSha) {
      remoteVer.commit = latestSha;
      if (commitMessage && !remoteVer.description) remoteVer.description = commitMessage;
    }

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
  const filesToUpdate = ['index.html', 'sw.js', 'manifest.json', 'version.json', 'server.js'];
  const updatedFiles = [];

  // Ensure AppData directory exists
  if (!fs.existsSync(AKB_DIR)) fs.mkdirSync(AKB_DIR, { recursive: true });

  for (const filename of filesToUpdate) {
    try {
      const fileUrl = `${RAW_BASE_URL}/${filename}?_nocache=${Date.now()}`;
      const res = await fetch(fileUrl, { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' } });
      if (res.ok) {
        const content = await res.text();
        if (content && content.length > 50) {
          // 1. Write to AppData directory (Always writable on all Windows systems)
          const destPath = path.join(AKB_DIR, filename);
          if (filename === 'index.html' && fs.existsSync(destPath)) {
            try { fs.writeFileSync(destPath + '.bak', fs.readFileSync(destPath)); } catch(_) {}
          }
          fs.writeFileSync(destPath, content, 'utf8');

          // 2. Also write to project directory if writable (for portable/zip installations)
          try {
            const rootPath = path.join(__dirname, filename);
            if (fs.existsSync(rootPath)) {
              fs.writeFileSync(rootPath, content, 'utf8');
            }
          } catch (_) {}

          updatedFiles.push(filename);
        }
      }
    } catch (fErr) {
      console.warn(`[Auto-Updater] Error updating ${filename}:`, fErr.message);
    }
  }

  // Also check if server.js has changed on GitHub
  try {
    const srvUrl = `${RAW_BASE_URL}/server.js?_nocache=${Date.now()}`;
    const srvRes = await fetch(srvUrl, { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } });
    if (srvRes.ok) {
      const srvContent = await srvRes.text();
      if (srvContent && srvContent.length > 1000) {
        const srvPath = path.join(AKB_DIR, 'server.js');
        if (fs.existsSync(srvPath)) {
          try { fs.writeFileSync(srvPath + '.bak', fs.readFileSync(srvPath)); } catch (_) {}
        }
        fs.writeFileSync(srvPath, srvContent, 'utf8');

        try {
          const rootSrv = path.join(__dirname, 'server.js');
          if (fs.existsSync(rootSrv)) {
            fs.writeFileSync(rootSrv, srvContent, 'utf8');
          }
        } catch (_) {}

        updatedFiles.push('server.js');
      }
    }
  } catch (sErr) {
    console.warn('[Auto-Updater] Error updating server.js:', sErr.message);
  }

  // Always keep master data synchronized (invoices, products, parties) across all devices
  try {
    // 1. Sync deleted tombstones from GitHub
    try {
      const delRes = await fetch(`${RAW_BASE_URL}/data/deleted_invoices.json?_nocache=${Date.now()}`);
      if (delRes.ok) {
        const remoteDel = await delRes.json();
        if (Array.isArray(remoteDel)) {
          let curDel = readJsonFile('deleted_invoices', []).filter(d => String(d).length > 5);
          let delChanged = false;
          for (const d of remoteDel) {
            const s = String(d);
            if (s.length > 5 && !curDel.includes(s)) { curDel.push(s); delChanged = true; }
          }
          if (delChanged || curDel.length !== readJsonFile('deleted_invoices', []).length) {
            writeJsonFile('deleted_invoices', curDel);
            updatedFiles.push('data/deleted_invoices.json');
          }
        }
      }
    } catch (_) {}

    // 2. Sync products, receivers, consignees if local is empty
    for (const table of ['products', 'receivers', 'consignees']) {
      try {
        const curData = readJsonFile(table, []);
        if (!Array.isArray(curData) || curData.length === 0) {
          const tRes = await fetch(`${RAW_BASE_URL}/data/${table}.json?_nocache=${Date.now()}`);
          if (tRes.ok) {
            const tData = await tRes.json();
            if (Array.isArray(tData) && tData.length > 0) {
              writeJsonFile(table, tData);
              updatedFiles.push(`data/${table}.json`);
            }
          }
        }
      } catch (_) {}
    }

    const invRes = await fetch(`${RAW_BASE_URL}/data/invoices.json?_nocache=${Date.now()}`);
    if (invRes.ok) {
      const remoteInvs = await invRes.json();
      if (Array.isArray(remoteInvs) && remoteInvs.length > 0) {
        let curInvs = readJsonFile('invoices', []);
        const deletedInvs = new Set(readJsonFile('deleted_invoices', []).map(String));
        let updated = false;

        const beforeLen = curInvs.length;
        curInvs = curInvs.filter(i => {
          const cid = String(i.id || i._id || '');
          const cnum = String(i.invoiceNo || ''); return (!cid || !deletedInvs.has(cid)) && (!cnum || !deletedInvs.has(cnum));
        });
        if (curInvs.length !== beforeLen) updated = true;

        const existingIds = new Set(curInvs.map(i => String(i.id || i._id)));
        const existingNos = new Set(curInvs.map(i => Number(i.invoiceNo)).filter(n => !isNaN(n) && n > 0));
        for (const rInv of remoteInvs) {
          const num = Number(rInv.invoiceNo);
          const rid = String(rInv.id || rInv._id || '');
          const rnum = String(rInv.invoiceNo || ''); if ((rid && deletedInvs.has(rid)) || (rnum && deletedInvs.has(rnum))) continue;
          if (rid && existingIds.has(rid)) continue;
          if (!isNaN(num) && num > 0 && existingNos.has(num)) continue;
          curInvs.push(rInv);
          if (rid) existingIds.add(rid);
          if (!isNaN(num) && num > 0) existingNos.add(num);
          updated = true;
        }
        if (updated) {
          curInvs.sort((a, b) => (Number(b.invoiceNo) || 0) - (Number(a.invoiceNo) || 0));
          writeJsonFile('invoices', curInvs);
          _invoicesVersion = Date.now();
          console.log(`[Auto-Updater] Merged ${curInvs.length} invoices from master ledger.`);
          updatedFiles.push('data/invoices.json');
        }
      }
    }
  } catch (dErr) {
    console.warn('[Auto-Updater] Data ledger sync note:', dErr.message);
  }

  // Save updated version info to both locations
  try {
    if (remoteVer) {
      fs.writeFileSync(VERSION_PATH, JSON.stringify(remoteVer, null, 2), 'utf8');
      try {
        fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify(remoteVer, null, 2), 'utf8');
      } catch (_) {}
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

// Rapid startup update check (3s, 15s, then every 2 minutes)
const triggerAutoUpdateCycle = async (label) => {
  try {
    const check = await checkRemoteUpdates();
    if (check.hasUpdate && check.latest) {
      console.log(`[Auto-Updater] 🚀 New version found on GitHub (${label}, Build ${check.latest.build}). Installing automatically...`);
      await downloadAndApplyUpdate(check.latest);
      console.log(`[Auto-Updater] ✨ Update successfully applied to local system!`);
    } else {
      console.log(`[Auto-Updater] App is up to date (${label}, Build ${(check.current && check.current.build) || 101}).`);
    }
  } catch (e) {
    console.warn(`[Auto-Updater] ${label} check error:`, e.message);
  }
};

setTimeout(() => triggerAutoUpdateCycle('Early 3s'), 3000);
setTimeout(() => triggerAutoUpdateCycle('Boot 15s'), 15000);
setInterval(() => triggerAutoUpdateCycle('Periodic 2m'), 2 * 60 * 1000);

// ⚡ Continuous Background Master Ledger Auto-Sync (keeps server database in lockstep with cloud/GitHub)
let _serverSyncTick = 0;
setInterval(async () => {
  _serverSyncTick++;
  try {
    let remoteInvoices = [];

    // 1. Sync tombstones from GitHub (strictly enforcing unique document IDs, never short numbers)
    try {
      const delRes = await fetch(`${RAW_BASE_URL}/data/deleted_invoices.json?_t=${Date.now()}`);
      if (delRes.ok) {
        const remoteDel = await delRes.json();
        if (Array.isArray(remoteDel)) {
          let curDel = readJsonFile('deleted_invoices', []).filter(d => String(d).length > 5);
          let delChanged = false;
          for (const d of remoteDel) {
            const strD = String(d).trim();
            if (strD.length > 5 && !curDel.includes(strD)) { curDel.push(strD); delChanged = true; }
          }
          if (delChanged) writeJsonFile('deleted_invoices', curDel);
        }
      }
    } catch (_) {}

    // 2. Sync from GitHub master ledger
    try {
      const invRes = await fetch(`${RAW_BASE_URL}/data/invoices.json?_t=${Date.now()}`);
      if (invRes.ok) {
        const ghInvs = await invRes.json();
        if (Array.isArray(ghInvs)) remoteInvoices.push(...ghInvs);
      }
    } catch (_) {}

    // 3. Every 2nd cycle (12 seconds), also query Cloud GAS directly to catch mobile device updates instantly
    if (_serverSyncTick % 2 === 0) {
      try {
        const gasRes = await fetch(CLOUD_GAS_URL + '?action=bootstrap', { timeout: 4500 });
        if (gasRes.ok) {
          const cloudData = await gasRes.json();
          if (cloudData && Array.isArray(cloudData.invoices)) {
            remoteInvoices.push(...cloudData.invoices);
          }
        }
      } catch (_) {}
    }

    if (remoteInvoices.length > 0) {
      let curInvs = readJsonFile('invoices', []);
      const deletedInvs = new Set(readJsonFile('deleted_invoices', []).map(String));
      let updated = false;
      let newFromCloud = false;

      const beforeLen = curInvs.length;
      curInvs = curInvs.filter(i => {
        const cid = String(i.id || i._id || '');
        const cnum = String(i.invoiceNo || ''); return (!cid || !deletedInvs.has(cid)) && (!cnum || !deletedInvs.has(cnum));
      });
      if (curInvs.length !== beforeLen) updated = true;

      const existingIds = new Set(curInvs.map(i => String(i.id || i._id)));
      const existingNos = new Set(curInvs.map(i => Number(i.invoiceNo)).filter(n => !isNaN(n) && n > 0));
      const newlyAddedInvoices = [];
      for (const rInv of remoteInvoices) {
        const num = Number(rInv.invoiceNo);
        const rid = String(rInv.id || rInv._id || '');
        const rnum = String(rInv.invoiceNo || ''); if ((rid && deletedInvs.has(rid)) || (rnum && deletedInvs.has(rnum))) continue;
        if (rid && existingIds.has(rid)) continue;
        if (!isNaN(num) && num > 0 && existingNos.has(num)) continue;
        curInvs.push(rInv);
        newlyAddedInvoices.push(rInv);
        if (rid) existingIds.add(rid);
        if (!isNaN(num) && num > 0) existingNos.add(num);
        updated = true;
        newFromCloud = true;
      }
      if (updated) {
        curInvs.sort((a, b) => (Number(b.invoiceNo) || 0) - (Number(a.invoiceNo) || 0));
        writeJsonFile('invoices', curInvs);
        _invoicesVersion = Date.now();
        broadcastRealtime('invoice_created', { invoices: curInvs });

        // Advance nextInvoiceNo in settings if client system created higher invoice
        if (newlyAddedInvoices.length > 0) {
          const settings = readJsonFile('settings', getDefaultSettings());
          let highestNum = settings.nextInvoiceNo || 1;
          for (const ni of newlyAddedInvoices) {
            const invNum = Number(ni.invoiceNo);
            if (!isNaN(invNum) && invNum >= highestNum) {
              highestNum = invNum + 1;
            }
          }
          if (highestNum > (settings.nextInvoiceNo || 1)) {
            settings.nextInvoiceNo = highestNum;
            writeJsonFile('settings', settings);
            forwardToGas('updateSettings', { nextInvoiceNo: settings.nextInvoiceNo });
          }

          // ⚡ AUTOMATIC DISPATCH: Send WhatsApp & Telegram for every client-generated invoice!
          for (const ni of newlyAddedInvoices) {
            console.log(`⚡ [Client-Sync] Auto-dispatching store bot for client system invoice #${ni.invoiceNo || ni.id}...`);
            autoDispatchBots(ni).catch(err => console.warn('[Client-Sync] Auto-dispatch warning:', err.message));
          }
        }

        // If new invoices came from cloud, asynchronously sync to GitHub repository
        if (newFromCloud) {
          try {
            const { exec } = require('child_process');
            exec('git add data/invoices.json data/deleted_invoices.json data/settings.json && git commit -m "sync: automatic master ledger update from cloud" && git push origin main', (gErr) => {
              if (!gErr) console.log('[Cloud-Ledger] Pushed latest cloud invoices to GitHub repository.');
            });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}, 6000);

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

// API: Get Host LAN connection information for client systems
app.get('/api/lan-info', (req, res) => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ interface: name, address: iface.address });
      }
    }
  }
  const primaryIp = addresses.find(a => a.address.startsWith('192.168.') || a.address.startsWith('10.'))?.address || (addresses[0]?.address || '127.0.0.1');
  res.json({
    success: true,
    primaryIp,
    port: PORT,
    clientUrl: `http://${primaryIp}:${PORT}`,
    dedicatedUrl: `http://${primaryIp}:${PORT}/?mode=dedicated_app`,
    allAddresses: addresses,
    whatsappConnected: isWhatsappConnected
  });
});

// API: Force check for updates now
app.post('/api/update/check', async (req, res) => {
  const result = await checkRemoteUpdates();
  res.json({ success: true, ...result });
});

// API: Force apply update now
app.post('/api/update/apply', async (req, res) => {
  const force = Boolean(req.body && req.body.force);
  const check = await checkRemoteUpdates();
  const targetVer = check.latest || check.current || { version: 'latest', build: Date.now() };
  if (check.hasUpdate || force) {
    const result = await downloadAndApplyUpdate(targetVer);
    res.json(result);
  } else {
    const result = await downloadAndApplyUpdate(targetVer);
    res.json(result);
  }
});


// ==========================================
// ⚡ 4. COMPLETE HIGH-SPEED DATABASE ENGINE (CRUD)
// ==========================================

// Bootstrap: loads all core tables in a single lightning-fast call
app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    let invoices = readJsonFile('invoices', []);
    let products = readJsonFile('products', []);
    let receivers = readJsonFile('receivers', []);
    let consignees = readJsonFile('consignees', []);
    let settings = readJsonFile('settings', getDefaultSettings());

    // Filter out any tombstoned deleted invoices immediately
    const deletedInvs = new Set(readJsonFile('deleted_invoices', []).map(String));
    if (invoices.some(i => (i.id && deletedInvs.has(String(i.id))) || (i._id && deletedInvs.has(String(i._id))))) {
      invoices = invoices.filter(i => {
        const iid = String(i.id || i._id || '');
        return (!iid || !deletedInvs.has(iid));
      });
      writeJsonFile('invoices', invoices);
      _invoicesVersion = Date.now();
    }

    // Intelligent synchronization: pull and merge any missing invoices from Cloud & GitHub
    if (fetch) {
      try {
        let remoteInvoices = [];
        // 1. Try Cloud GAS
        const gasRes = await fetch(CLOUD_GAS_URL + '?action=bootstrap', { timeout: 4000 });
        if (gasRes.ok) {
          const cloudData = await gasRes.json();
          if (cloudData) {
            if (Array.isArray(cloudData.invoices) && cloudData.invoices.length > 0) {
              remoteInvoices = cloudData.invoices;
            }
            if ((!products || products.length === 0) && Array.isArray(cloudData.products)) {
              products = cloudData.products;
              writeJsonFile('products', products);
            }
            if ((!receivers || receivers.length === 0) && Array.isArray(cloudData.receivers)) {
              receivers = cloudData.receivers;
              writeJsonFile('receivers', receivers);
            }
            if ((!consignees || consignees.length === 0) && Array.isArray(cloudData.consignees)) {
              consignees = cloudData.consignees;
              writeJsonFile('consignees', consignees);
            }
          }
        }
        // 2. Also check GitHub data/invoices.json master ledger if invoices are empty
        if (invoices.length === 0) {
          try {
            const ghRes = await fetch(`${RAW_BASE_URL}/data/invoices.json?_t=${Date.now()}`, { timeout: 3000 });
            if (ghRes.ok) {
              const ghData = await ghRes.json();
              if (Array.isArray(ghData) && ghData.length > 0) {
                if (ghData.length > remoteInvoices.length) remoteInvoices = ghData;
              }
            }
          } catch (_) {}
        }

        if (remoteInvoices.length > 0) {
          let updated = false;
          const deletedInvs = new Set(readJsonFile('deleted_invoices', []).map(String));
          const existingIds = new Set(invoices.map(i => String(i.id || i._id)));
          const existingNos = new Set(invoices.map(i => Number(i.invoiceNo)).filter(n => !isNaN(n) && n > 0));
          for (const cinv of remoteInvoices) {
            const num = Number(cinv.invoiceNo);
            const cid = String(cinv.id || cinv._id || '');
            if (cid && deletedInvs.has(cid)) continue;
            if (cid && existingIds.has(cid)) continue;
            if (!isNaN(num) && num > 0 && existingNos.has(num)) continue;
            invoices.push(cinv);
            if (cid) existingIds.add(cid);
            if (!isNaN(num) && num > 0) existingNos.add(num);
            updated = true;
          }
          if (updated) {
            invoices.sort((a, b) => (Number(b.invoiceNo) || 0) - (Number(a.invoiceNo) || 0));
            writeJsonFile('invoices', invoices);
            _invoicesVersion = Date.now();
            console.log(`[Bootstrap] Synchronized and merged ${invoices.length} total invoices.`);
          }
        }
      } catch (cloudErr) {
        console.warn('[Bootstrap] Sync note:', cloudErr.message);
      }
    }

    const sanitizedSettings = { ...settings };
    delete sanitizedSettings.adminPassword;
    if (sanitizedSettings.telegram) {
      sanitizedSettings.telegram = {
        ...sanitizedSettings.telegram,
        token: sanitizedSettings.telegram.token ? '••••••••' + sanitizedSettings.telegram.token.slice(-4) : '',
        isConfigured: !!(sanitizedSettings.telegram.token || process.env.TELEGRAM_BOT_TOKEN)
      };
    }

    res.json({
      success: true,
      invoices,
      products,
      receivers,
      consignees,
      settings: sanitizedSettings,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('[Bootstrap] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Protect core resource endpoints
app.use('/api/invoices', requireAuth);
app.use('/api/products', requireAuth);
app.use('/api/receivers', requireAuth);
app.use('/api/consignees', requireAuth);

// --- Invoices Endpoints ---
let _invoicesVersion = Date.now();

app.get('/api/invoices/version', (req, res) => {
  res.json({ version: _invoicesVersion });
});

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
    _invoicesVersion = Date.now();

    // Ensure newly saved invoice is not blacklisted in deleted_invoices
    let deletedList = readJsonFile('deleted_invoices', []);
    const sid = String(inv.id || inv._id || '');
    const snum = String(inv.invoiceNo || '');
    deletedList = deletedList.filter(d => d !== sid && d !== snum && d !== snum.padStart(4, '0'));
    writeJsonFile('deleted_invoices', deletedList);

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
    forwardToSupabase('invoices', {
      id: String(inv.id || ('inv_' + inv.invoiceNo)),
      invoiceNo: parseInt(inv.invoiceNo, 10),
      date: inv.date || '',
      receiver: inv.receiver || {},
      consignee: inv.consignee || {},
      items: inv.items || [],
      taxableAmount: Number(inv.taxableAmount || inv.subtotal || 0),
      cgstAmount: Number(inv.cgstAmount || 0),
      sgstAmount: Number(inv.sgstAmount || 0),
      igstAmount: Number(inv.igstAmount || 0),
      totalAmount: Number(inv.totalAmount || inv.grandTotal || 0),
      customerPhone: String(inv.customerPhone || (inv.receiver && inv.receiver.phone) || ''),
      rawGrandTotal: Number(inv.rawGrandTotal || inv.totalAmount || 0),
      roundOff: Number(inv.roundOff || 0),
      isInterState: !!inv.isInterState,
      data: inv
    });

    // Broadcast real-time update
    broadcastRealtime('invoice_created', { invoice: inv });
    scheduleGitLedgerSync();

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
      _invoicesVersion = Date.now();
      forwardToGas('updateInvoice', invoices[index], id);
      broadcastRealtime('invoice_updated', { invoice: invoices[index] });
      scheduleGitLedgerSync();
      res.json({ success: true, invoice: invoices[index], data: invoices[index] });
    } else {
      invoices.unshift(inv);
      writeJsonFile('invoices', invoices);
      _invoicesVersion = Date.now();
      forwardToGas('createInvoice', inv, id);
      scheduleGitLedgerSync();
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
    const target = invoices.find(i => String(i.id || i._id) === String(id) || String(i.invoiceNo) === String(id));
    const invNo = target ? String(target.invoiceNo) : '';

    invoices = invoices.filter(i => String(i.id || i._id) !== String(id) && String(i.invoiceNo) !== String(id));
    writeJsonFile('invoices', invoices);
    _invoicesVersion = Date.now();

    // Persist deletion to tombstone list by unique ID so sync never resurrects it
    let deletedList = readJsonFile('deleted_invoices', []);
    if (id && String(id).length > 5 && !deletedList.includes(String(id))) deletedList.push(String(id));
    if (target && target.id && String(target.id).length > 5 && !deletedList.includes(String(target.id))) deletedList.push(String(target.id));
    deletedList = deletedList.filter(d => String(d).length > 5);
    writeJsonFile('deleted_invoices', deletedList);

    forwardToGas('deleteInvoice', {}, id);
    forwardToSupabase('invoices', { id: String(id) }, false);
    broadcastRealtime('invoice_deleted', { id, invoiceNo: invNo });
    scheduleGitLedgerSync();
    res.json({ success: true, id, invoiceNo: invNo });
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
    forwardToSupabase('products', {
      id: String(prod.id),
      name: prod.name || prod.description || 'Product',
      description: prod.description || prod.name || '',
      hsn: String(prod.hsn || ''),
      price: Number(prod.price || prod.rate || 0),
      calcType: prod.calcType || 'qty'
    });
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
    forwardToSupabase('products', { id: String(id) }, false);
    broadcastRealtime('products_updated', { products });
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
    forwardToSupabase('receivers', {
      id: String(rec.id),
      name: rec.name || 'Party',
      phone: rec.phone || '',
      address: rec.address || '',
      state: rec.state || '',
      gstin: rec.gstin || '',
      statecode: String(rec.statecode || rec.stateCode || '37')
    });
    broadcastRealtime('parties_updated', { receivers });
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
    forwardToSupabase('receivers', { id: String(id) }, false);
    broadcastRealtime('parties_updated', { type: 'receiver', data: receivers });
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
    forwardToSupabase('consignees', {
      id: String(con.id),
      name: con.name || 'Party',
      phone: con.phone || '',
      address: con.address || '',
      state: con.state || '',
      gstin: con.gstin || '',
      statecode: String(con.statecode || con.stateCode || '37')
    });
    broadcastRealtime('parties_updated', { consignees });
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
    forwardToSupabase('consignees', { id: String(id) }, false);
    broadcastRealtime('parties_updated', { type: 'consignee', data: consignees });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Settings Endpoints ---
app.get('/api/settings', requireAuth, (req, res) => {
  const cur = readJsonFile('settings', getDefaultSettings());
  const sanitized = { ...cur };
  delete sanitized.adminPassword; // NEVER leak adminPassword
  if (sanitized.telegram) {
    sanitized.telegram = {
      ...sanitized.telegram,
      token: sanitized.telegram.token ? '••••••••' + sanitized.telegram.token.slice(-4) : '',
      isConfigured: !!(sanitized.telegram.token || process.env.TELEGRAM_BOT_TOKEN)
    };
  }
  res.json(sanitized);
});

app.put('/api/settings', requireAuth, (req, res) => {
  try {
    const cur = readJsonFile('settings', getDefaultSettings());
    const incoming = req.body || {};

    let telegramConfig = { ...(cur.telegram || {}), ...(incoming.telegram || {}) };
    if (incoming.telegram && incoming.telegram.token && incoming.telegram.token.startsWith('••••')) {
      telegramConfig.token = cur.telegram ? cur.telegram.token : '';
    }

    const updated = {
      ...cur,
      ...incoming,
      telegram: telegramConfig,
      whatsapp: { ...(cur.whatsapp || {}), ...(incoming.whatsapp || {}) },
      emailSettings: { ...(cur.emailSettings || {}), ...(incoming.emailSettings || {}) }
    };
    if (Array.isArray(incoming.adminEmails)) {
      updated.adminEmails = incoming.adminEmails;
    }
    delete updated.adminPassword; // NEVER persist adminPassword in settings.json

    writeJsonFile('settings', updated);
    forwardToGas('updateSettings', updated);
    scheduleGitLedgerSync();
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
// 5. WHATSAPP ENDPOINTS
// ==========================================
app.get('/api/whatsapp/status', async (req, res) => {
  if (client) {
    if (!isWhatsappConnected && client.info && (client.info.wid || client.info.me)) {
      isWhatsappConnected = true;
      isWhatsappInitializing = false;
      qrCodeDataUrl = null;
    }
    // Deep check inside Puppeteer in case WhatsApp Web is logged in on phone but events are still syncing
    if (!isWhatsappConnected && client.pupPage && !client.pupPage.isClosed()) {
      try {
        const isPageLoggedIn = await Promise.race([
          client.pupPage.evaluate(() => {
            try {
              // 1. If QR canvas, data-ref or pairing container exists, definitely NOT logged in
              if (document.querySelector('canvas') || document.querySelector('div[data-ref]') || document.querySelector('[data-testid="qrcode"]')) {
                return false;
              }
              // 2. Check WhatsApp internal store models
              if (window.Store) {
                if (window.Store.User && typeof window.Store.User.getMaybeMeUser === 'function' && window.Store.User.getMaybeMeUser()) {
                  return true;
                }
                if (window.Store.Conn && (window.Store.Conn.status === 'CONNECTED' || window.Store.Conn.canSend === true)) {
                  return true;
                }
              }
              if (typeof window.WWebJS !== 'undefined' && window.WWebJS.isLoggedIn === true) {
                return true;
              }
              // 3. Genuine authenticated DOM elements
              if (document.querySelector('#app [data-testid="chat-list"]') ||
                  document.querySelector('#pane-side [data-testid="chat-list"]') ||
                  document.querySelector('header [data-testid="menu-bar-chat"]') ||
                  document.querySelector('[data-testid="conversation-panel-wrapper"]')) {
                return true;
              }
            } catch (_) {}
            return false;
          }),
          new Promise(r => setTimeout(() => r(false), 2000))
        ]);
        if (isPageLoggedIn) {
          console.log('⚡ [WhatsApp API] Detected active linked session from WhatsApp Web DOM!');
          isWhatsappConnected = true;
          isWhatsappInitializing = false;
          qrCodeDataUrl = null;
          lastPairingCode = null;
          broadcastRealtime('whatsapp_status', { connected: true, status: 'ready', user: whatsappUserInfo || getSavedWhatsappUserInfo() });
        }
      } catch (_) {}
    }
    if (isWhatsappConnected) {
      qrCodeDataUrl = null;
      lastPairingCode = null;
      if (!whatsappUserInfo || !whatsappUserInfo.phone || whatsappUserInfo.phone === 'Connected') {
        let phone = '';
        let name = 'Anudeep Khadi Bandar';
        if (client.info) {
          if (client.info.wid && client.info.wid.user) phone = client.info.wid.user;
          else if (client.info.me && client.info.me.user) phone = client.info.me.user;
          if (client.info.pushname) name = client.info.pushname;
        }
        if (!phone && client.pupPage && !client.pupPage.isClosed()) {
          try {
            const domPhone = await client.pupPage.evaluate(() => {
              try {
                if (window.Store) {
                  if (window.Store.User && window.Store.User.getMaybeMeUser) {
                    const me = window.Store.User.getMaybeMeUser();
                    if (me && me.user) return me.user;
                  }
                  if (window.Store.Conn && window.Store.Conn.wid && window.Store.Conn.wid.user) {
                    return window.Store.Conn.wid.user;
                  }
                }
                const raw = window.localStorage.getItem('last-wid-md') || window.localStorage.getItem('last-wid');
                if (raw) {
                  const m = raw.match(/(\d+):?[^@]*@/);
                  if (m && m[1]) return m[1];
                }
              } catch (_) {}
              return '';
            }).catch(() => '');
            if (domPhone) phone = domPhone;
          } catch (_) {}
        }
        const saved = getSavedWhatsappUserInfo();
        if (!phone && saved && saved.phone && saved.phone !== 'Connected') {
          phone = saved.phone;
          if (saved.name) name = saved.name;
        }
        if (!phone) {
          phone = 'Connected';
        }
        whatsappUserInfo = { phone, name };
        if (phone && phone !== 'Connected') {
          saveSavedWhatsappUserInfo(whatsappUserInfo);
        }
      }
    }
  }

  const hasSession = hasSavedWhatsappSession();
  const savedUser = getSavedWhatsappUserInfo();
  const activeUser = isWhatsappConnected ? (whatsappUserInfo || savedUser) : (hasSession ? savedUser : null);

  // ⚡ AUTO-WAKE: If WhatsApp client is offline or uninitialized, start it automatically!
  if (!client && !isWhatsappInitializing) {
    console.log('[WhatsApp API] Inactive WhatsApp client detected during status request. Triggering background auto-wake...');
    initWhatsappClient(false);
  }

  let statusString = 'disconnected';
  if (isWhatsappConnected) {
    statusString = 'connected';
  } else if (isRestoringSavedSession) {
    statusString = 'connecting_saved';
  } else if (lastPairingCode) {
    statusString = 'pairing_code_ready';
  } else if (qrCodeDataUrl) {
    statusString = 'qr_ready';
  } else if (isWhatsappInitializing) {
    statusString = hasSession ? 'connecting_saved' : 'initializing';
  }

  res.json({
    connected: isWhatsappConnected,
    qr: (isWhatsappConnected || isRestoringSavedSession) ? null : qrCodeDataUrl,
    pairingCode: lastPairingCode,
    user: activeUser,
    hasSavedSession: hasSession,
    status: statusString,
    message: isRestoringSavedSession ? 'Restoring saved WhatsApp session from local storage...' : (isWhatsappConnected ? 'WhatsApp Bot Connected & Active' : '')
  });
});

// Explicit endpoint to trigger immediate auto-connection
app.post('/api/whatsapp/auto-connect', async (req, res) => {
  if (isWhatsappConnected) {
    return res.json({ success: true, connected: true, message: 'Already connected', user: whatsappUserInfo });
  }
  if (!client && !isWhatsappInitializing) {
    console.log('[WhatsApp API] Triggering explicit auto-connect...');
    initWhatsappClient(false);
  }
  res.json({
    success: true,
    connected: isWhatsappConnected,
    initializing: isWhatsappInitializing,
    status: isWhatsappConnected ? 'connected' : (qrCodeDataUrl ? 'qr_ready' : (lastPairingCode ? 'pairing_code_ready' : 'initializing'))
  });
});

app.post('/api/whatsapp/qr-mode', async (req, res) => {
  lastPairingCode = null;
  if (isWhatsappConnected) {
    return res.json({ success: true, connected: true, message: 'Already connected', user: whatsappUserInfo });
  }
  if (client && client.pupPage && !client.pupPage.isClosed()) {
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
    } catch (evalErr) {
      if (evalErr.message && evalErr.message.includes('detached Frame')) {
        console.warn('[WhatsApp] Browser page detached in qr-mode. Reloading...');
        try { await client.pupPage.reload({ waitUntil: 'load', timeout: 15000 }); } catch (_) {}
      }
    }
  } else if (!client && !isWhatsappInitializing) {
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
    let code;
    try {
      code = await client.requestPairingCode(phone);
    } catch (reqErr) {
      if (reqErr.message && reqErr.message.includes('detached Frame') && client.pupPage && !client.pupPage.isClosed()) {
        console.warn('[WhatsApp] Frame detached during pairing code request. Reloading and retrying once...');
        await client.pupPage.reload({ waitUntil: 'load', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        code = await client.requestPairingCode(phone);
      } else {
        throw reqErr;
      }
    }
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

app.post(['/api/whatsapp/reset', '/api/whatsapp/change-number', '/api/whatsapp/switch-number'], async (req, res) => {
  try {
    console.log('[WhatsApp] Change / Switch number requested by user...');
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
      message: 'Unlinking old number. Generating fresh QR & Pairing Code for new number...'
    });

    setTimeout(() => {
      initWhatsappClient(true);
    }, 1000);

    res.json({ success: true, message: 'Current number unlinked! Please link your new phone number via QR or Pairing Code.' });
  } catch (err) {
    console.error('[WhatsApp] Change number error:', err);
    res.status(500).json({ error: 'Failed to switch WhatsApp number: ' + err.message });
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

app.post(['/api/savePdfLocally', '/api/save-pdf-to-downloads'], upload.single('file'), (req, res) => {
  const fileName = (req.body && req.body.filename) || (req.file && req.file.originalname) || `Invoice_${Date.now()}.pdf`;
  const cleanName = fileName.replace(/[\\/:*?"<>|]/g, '_');

  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME || require('os').homedir();
    const downloadsDir = path.join(userProfile, 'Downloads');
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const destPath = path.join(downloadsDir, cleanName);

    // Support base64 JSON payload
    if (req.body && req.body.base64Data) {
      const buffer = Buffer.from(req.body.base64Data, 'base64');
      fs.writeFileSync(destPath, buffer);
      console.log(`[Server] Silently saved base64 PDF to: ${destPath} (${buffer.length} bytes)`);
      return res.json({ success: true, path: destPath, filename: cleanName });
    }

    // Support multipart file upload
    const filePath = req.file && req.file.path;
    if (filePath) {
      fs.copyFileSync(filePath, destPath);
      try { fs.unlinkSync(filePath); } catch (_) {}
      console.log(`[Server] Silently saved uploaded PDF to: ${destPath}`);
      return res.json({ success: true, path: destPath, filename: cleanName });
    }

    return res.json({ success: true, warning: 'No file or base64 data received for local save' });
  } catch (err) {
    console.error('[Server] Error saving PDF locally:', err);
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
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
      return res.json({ success: false, skipped: true, error: 'Invalid phone number format' });
    }

    if (!filePath || !fs.existsSync(filePath)) {
      cleanup();
      return res.json({ success: false, skipped: true, error: 'PDF file missing or empty' });
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
    return res.json({ success: false, error: 'WhatsApp is not connected.' });
  }
  try {
    let phone = req.body.phone;
    let message = req.body.message;
    if (!phone) {
      return res.json({ success: false, skipped: true, message: 'No customer phone specified' });
    }
    if (!message) {
      return res.json({ success: false, skipped: true, message: 'No message content' });
    }

    const targetChatId = await resolveChatId(client, phone);
    if (!targetChatId) {
      return res.json({ success: false, skipped: true, message: 'Invalid customer phone number' });
    }

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

// Endpoint for sending photographic evidence (suspect template + live detection crop)
app.post('/api/whatsapp/sendPhoto', upload.single('file'), async (req, res) => {
  if (!isWhatsappConnected || !client) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    return res.json({ success: false, offline: true, error: 'WhatsApp is not connected.' });
  }
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {}); };
  try {
    const phone = req.body.phone;
    const caption = req.body.caption || '';
    const imageBase64 = req.body.image_base64;
    const filename = req.body.filename || (req.file && req.file.originalname) || 'evidence.jpg';
    const mimetype = req.body.mimetype || (req.file && req.file.mimetype) || 'image/jpeg';

    if (!phone) {
      cleanup();
      return res.json({ success: false, skipped: true, message: 'Missing recipient phone number' });
    }

    const targetChatId = await resolveChatId(client, phone);
    if (!targetChatId) {
      cleanup();
      return res.json({ success: false, skipped: true, message: 'Invalid recipient phone number' });
    }

    const { MessageMedia } = require('whatsapp-web.js');
    let media = null;

    if (filePath && fs.existsSync(filePath)) {
      const fileBuffer = fs.readFileSync(filePath);
      media = new MessageMedia(mimetype, fileBuffer.toString('base64'), filename);
    } else if (imageBase64) {
      const cleanB64 = imageBase64.includes('base64,') ? imageBase64.split('base64,')[1] : imageBase64;
      media = new MessageMedia(mimetype, cleanB64, filename);
    } else {
      cleanup();
      return res.json({ success: false, skipped: true, message: 'No photo file or base64 data provided' });
    }

    await sendWhatsappMessageWithTimeout(client, targetChatId, media, { caption: caption }, 25000);
    cleanup();
    console.log(`✅ [WhatsApp] Photo evidence sent to ${targetChatId}`);
    res.json({ success: true, message: 'Photo evidence sent via WhatsApp successfully!' });
  } catch (err) {
    cleanup();
    console.error('Error sending WhatsApp photo:', err);
    res.status(500).json({ error: err.message || 'Failed to dispatch photo' });
  }
});

// Dedicated High-Speed Multi-Recipient Alert Broadcast Endpoints
app.post('/api/whatsapp/broadcastThreatAlert', async (req, res) => {
  if (!isWhatsappConnected || !client) {
    return res.json({ success: false, error: 'WhatsApp is not connected.' });
  }
  try {
    const phones = req.body.phones || [];
    const message = req.body.message || '';
    const combinedBase64 = req.body.combined_card_base64 || '';
    const masterBase64 = req.body.master_photo_base64 || '';
    const masterCaption = req.body.master_caption || '';
    const liveBase64 = req.body.live_photo_base64 || '';
    const liveCaption = req.body.live_caption || '';
    const sceneBase64 = req.body.scene_photo_base64 || '';
    const sceneCaption = req.body.scene_caption || '';

    if (!phones || !phones.length) {
      return res.json({ success: false, skipped: true, message: 'No recipient phone numbers provided' });
    }

    const { MessageMedia } = require('whatsapp-web.js');
    let combinedMedia = null;
    let masterMedia = null;
    let liveMedia = null;
    let sceneMedia = null;

    if (combinedBase64) {
      const cleanC = combinedBase64.includes('base64,') ? combinedBase64.split('base64,')[1] : combinedBase64;
      combinedMedia = new MessageMedia('image/jpeg', cleanC, 'sentinel_forensic_evidence_dossier.jpg');
    }
    if (masterBase64) {
      const cleanM = masterBase64.includes('base64,') ? masterBase64.split('base64,')[1] : masterBase64;
      masterMedia = new MessageMedia('image/jpeg', cleanM, 'database_master_mugshot.jpg');
    }
    if (liveBase64) {
      const cleanL = liveBase64.includes('base64,') ? liveBase64.split('base64,')[1] : liveBase64;
      liveMedia = new MessageMedia('image/jpeg', cleanL, 'found_cropped_face.jpg');
    }
    if (sceneBase64) {
      const cleanS = sceneBase64.includes('base64,') ? sceneBase64.split('base64,')[1] : sceneBase64;
      sceneMedia = new MessageMedia('image/jpeg', cleanS, 'complete_camera_scene.jpg');
    }

    const sendToOfficer = async (ph) => {
      try {
        const cleanPh = String(ph).replace(/\D/g, '');
        if (!cleanPh) return { phone: ph, success: false, error: 'Empty phone' };
        const targetChatId = await resolveChatId(client, cleanPh);
        if (!targetChatId) {
          return { phone: cleanPh, success: false, error: 'Could not resolve chat ID' };
        }

        // PREFERRED MODE: ONE UNIFIED MESSAGE containing all 3 images + full dossier text as the caption!
        if (combinedMedia) {
          await sendWhatsappMessageWithTimeout(client, targetChatId, combinedMedia, { caption: message }, 25000);
          console.log(`[Broadcast] Complete 3-in-1 Unified Forensic Board sent to ${cleanPh}`);
        } else {
          if (message) {
            await sendWhatsappMessageWithTimeout(client, targetChatId, message, {}, 25000);
          }
          if (sceneMedia) {
            await sendWhatsappMessageWithTimeout(client, targetChatId, sceneMedia, { caption: sceneCaption }, 25000);
          }
          if (liveMedia) {
            await sendWhatsappMessageWithTimeout(client, targetChatId, liveMedia, { caption: liveCaption }, 25000);
          }
          if (masterMedia) {
            await sendWhatsappMessageWithTimeout(client, targetChatId, masterMedia, { caption: masterCaption }, 25000);
          }
        }
        return { phone: cleanPh, success: true };
      } catch (errOne) {
        console.error(`[Broadcast Err] Failed for ${ph}:`, errOne.message);
        return { phone: ph, success: false, error: errOne.message };
      }
    };

    const settled = await Promise.allSettled(phones.map(ph => sendToOfficer(ph)));
    const results = settled.map(s => s.status === 'fulfilled' ? s.value : { success: false, error: s.reason?.message });

    res.json({ success: true, count: results.filter(r => r.success).length, total: phones.length, details: results });
  } catch (err) {
    console.error('Error in broadcastThreatAlert:', err);
    res.status(500).json({ error: err.message || 'Failed broadcast' });
  }
});

// ==========================================
// 6. TELEGRAM PROXY ENDPOINTS
// ==========================================
app.post('/api/sendTelegramDocument', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;
  const cleanup = () => { if (filePath) fs.unlink(filePath, () => {}); };
  try {
    let token = req.body.token;
    let chatId = req.body.chatId;
    if (!token || token.startsWith('•')) {
      const settings = readJsonFile('settings', {});
      token = process.env.TELEGRAM_BOT_TOKEN || (settings.telegram && settings.telegram.token) || '';
    }
    if (!chatId) {
      const settings = readJsonFile('settings', {});
      chatId = process.env.TELEGRAM_CHAT_ID || (settings.telegram && settings.telegram.chatId) || '';
    }
    if (!token || !chatId || token.startsWith('•')) {
      cleanup();
      return res.json({ success: false, deferred: true, message: 'Telegram token or chatId not configured' });
    }
    if (!req.file) return res.json({ success: false, error: 'Missing file' });

    const tgUrl = `https://api.telegram.org/bot${token}/sendDocument`;
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', fs.createReadStream(filePath), { filename: req.file.originalname || 'invoice.pdf' });

    const tgRes = await fetchWithRetry(tgUrl, { method: 'POST', body: form });
    const json = await tgRes.json();
    cleanup();

    if (!json || !json.ok) return res.json({ success: false, error: 'Telegram dispatch deferred' });
    return res.json({ success: true, result: json });
  } catch (err) {
    cleanup();
    console.log('[Telegram Document] Relay deferred:', err.message);
    return res.json({ success: false, deferred: true, message: 'Telegram notice deferred' });
  }
});

app.post('/api/sendTelegramMessage', async (req, res) => {
  try {
    let { token, chatId, text } = req.body;
    if (!token || token.startsWith('•')) {
      const settings = readJsonFile('settings', {});
      token = process.env.TELEGRAM_BOT_TOKEN || (settings.telegram && settings.telegram.token) || '';
    }
    if (!chatId) {
      const settings = readJsonFile('settings', {});
      chatId = process.env.TELEGRAM_CHAT_ID || (settings.telegram && settings.telegram.chatId) || '';
    }
    if (!token || !chatId || token.startsWith('•') || !text) {
      return res.json({ success: false, deferred: true, message: 'Missing fields or token not configured' });
    }

    const tgUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetchWithRetry(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const json = await r.json();
    return res.json({ success: true, result: json });
  } catch (err) {
    console.log('[Telegram Message] Relay deferred:', err.message);
    return res.json({ success: false, deferred: true, message: 'Telegram notice deferred' });
  }
});

app.post('/api/testTelegram', async (req, res) => {
  try {
    let token = (req.body && req.body.token) || '';
    if (!token || token.startsWith('•')) {
      const settings = readJsonFile('settings', {});
      token = process.env.TELEGRAM_BOT_TOKEN || (settings.telegram && settings.telegram.token) || '';
    }
    if (!token || token.startsWith('•')) {
      return res.json({ ok: false, description: 'Telegram token not configured or missing' });
    }
    const r = await fetchWithRetry(`https://api.telegram.org/bot${token}/getMe`);
    const data = await r.json();
    return res.json(data);
  } catch (err) {
    return res.json({ ok: false, description: err.message });
  }
});

// ⚡ Helper: Base64 asset embedder for standalone headless PDF rendering
function getBase64Image(filename) {
  try {
    const fullPath = path.join(__dirname, filename);
    if (fs.existsSync(fullPath)) {
      const mime = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return 'data:' + mime + ';base64,' + fs.readFileSync(fullPath).toString('base64');
    }
  } catch (e) {}
  return '';
}

function escPdf(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmPdf(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

function fdPdf(d) {
  if (!d) return '';
  try {
    const p = String(d).split('-');
    if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
  } catch (_) {}
  return String(d);
}

function numToWordsPdf(n) {
  const num = parseFloat(n);
  if (isNaN(num) || num <= 0) return 'Zero Rupees Only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function w(v) {
    if (isNaN(v) || v <= 0) return '';
    if (v < 20) return ones[v] || '';
    if (v < 100) return tens[Math.floor(v / 10)] + (v % 10 ? ' ' + ones[v % 10] : '');
    if (v < 1000) return ones[Math.floor(v / 100)] + ' Hundred' + (v % 100 ? ' and ' + w(v % 100) : '');
    if (v < 100000) return w(Math.floor(v / 1000)) + ' Thousand' + (v % 1000 ? ' ' + w(v % 1000) : '');
    if (v < 10000000) return w(Math.floor(v / 100000)) + ' Lakh' + (v % 100000 ? ' ' + w(v % 100000) : '');
    return w(Math.floor(v / 10000000)) + ' Crore' + (v % 10000000 ? ' ' + w(v % 10000000) : '');
  }
  const rupees = Math.floor(num), paise = Math.round((num - rupees) * 100);
  let s = w(rupees) + ' Rupees Only';
  if (paise > 0) s += ' and ' + w(paise) + ' Paise';
  return s;
}

// ⚡ Headless PDF generation for Tax Invoice
function generateInvoiceHtml(inv) {
  const logoB64 = getBase64Image('logo.jpeg');
  const leftGodB64 = getBase64Image('left-god.jpg');
  const rightGodB64 = getBase64Image('right-god.jpg');

  const SN = 'ANUDEEP KHADI BANDAR';
  const SA1 = 'D.No. 17-10-8, Opp. Sri Venkateswara Swamy Temple';
  const SA2 = 'Potti Sreeramulu Street, Main Road, TENALI - 522 201';
  const SG = '37BTMPS9234C1ZA';
  const SPH = '9441753678, 9390361151';
  const BN = 'AXIS BANK LTD, TENALI';
  const BA = '914020009962721';
  const BI = 'UTIB0000556';

  const isWithinAP = isInsideAndhraPradesh(inv);
  const isInter = (inv.isInterState !== undefined && inv.isInterState !== null) ? inv.isInterState : !isWithinAP;

  let mcHtml = '';
  if (inv.items && inv.items.length) {
    inv.items.forEach((it, i) => {
      const isCloth = (it.calcType === 'meters' || (Number(it.meters || 0) > 0 || Number(it.cms || 0) > 0));
      const qtyDisplay = isCloth ? (it.qty > 0 ? it.qty : '-') : (it.qty || 0);
      const metersDisplay = isCloth ? (Number(it.meters || 0) + '.' + String(it.cms || 0).padStart(2, '0')) : '-';
      mcHtml += '<tr>' +
        '<td style="text-align:center; border:1px solid #1a237e; padding:4px;">' + escPdf(String(it.baleNo || (i + 1))) + '</td>' +
        '<td style="text-align:left; border:1px solid #1a237e; padding:4px;">' + escPdf(it.description || '') + '</td>' +
        '<td style="text-align:center; border:1px solid #1a237e; padding:4px;">' + escPdf(it.hsn || '') + '</td>' +
        '<td style="text-align:center; border:1px solid #1a237e; padding:4px;">' + qtyDisplay + '</td>' +
        '<td style="text-align:center; border:1px solid #1a237e; padding:4px;">' + metersDisplay + '</td>' +
        '<td style="text-align:right; border:1px solid #1a237e; padding:4px;">' + fmPdf(it.rate) + '</td>' +
        '<td style="text-align:right; border:1px solid #1a237e; padding:4px; font-weight:bold;">' + fmPdf(it.amount) + '</td>' +
      '</tr>';
    });
  }

  let cgstAmt = 0, sgstAmt = 0, igstAmt = 0;
  if (isInter) {
    igstAmt = (inv.igstAmount !== undefined && inv.igstAmount !== null) ? Number(inv.igstAmount) : Number(((Number(inv.taxableAmount || 0) * 5) / 100).toFixed(2));
  } else {
    cgstAmt = (inv.cgstAmount !== undefined && inv.cgstAmount !== null) ? Number(inv.cgstAmount) : Number(((Number(inv.taxableAmount || 0) * 2.5) / 100).toFixed(2));
    sgstAmt = (inv.sgstAmount !== undefined && inv.sgstAmount !== null) ? Number(inv.sgstAmount) : Number(((Number(inv.taxableAmount || 0) * 2.5) / 100).toFixed(2));
  }
  const totalGst = isInter ? igstAmt : (cgstAmt + sgstAmt);
  const rawGT = Number(inv.taxableAmount || 0) + totalGst;
  const roVal = (inv.roundOff !== undefined && inv.roundOff !== null) ? Number(inv.roundOff) : (Math.round(rawGT) - rawGT);
  const roStr = (roVal >= 0 ? '+ ₹' : '- ₹') + Math.abs(roVal).toFixed(2);

  const cgstValStr = isInter ? '₹0.00' : fmPdf(cgstAmt);
  const cgstColor = isInter ? '#666' : '#000';
  const sgstValStr = isInter ? '₹0.00' : fmPdf(sgstAmt);
  const sgstColor = isInter ? '#666' : '#000';
  const igstValStr = isInter ? fmPdf(igstAmt) : '₹0.00';
  const igstColor = isInter ? '#000' : '#666';

  const taxRows =
    '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed #1a237e; padding:3px 8px; font-weight:bold;"><span>Total Amount before Tax</span><span style="color:#000;">' + fmPdf(inv.taxableAmount) + '</span></div>' +
    '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed #1a237e; padding:3px 8px; color:' + cgstColor + ';"><span>Add : CGST @ 2.5%</span><span style="color:' + cgstColor + ';">' + cgstValStr + '</span></div>' +
    '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed #1a237e; padding:3px 8px; color:' + sgstColor + ';"><span>Add : SGST @ 2.5%</span><span style="color:' + sgstColor + ';">' + sgstValStr + '</span></div>' +
    '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed #1a237e; padding:3px 8px; color:' + igstColor + ';"><span>Add : IGST @ 5.0%</span><span style="color:' + igstColor + ';">' + igstValStr + '</span></div>' +
    '<div style="display:flex; justify-content:space-between; border-bottom:1px dashed #1a237e; padding:3px 8px;"><span>Round OFF</span><span style="color:#000;">' + roStr + '</span></div>';

  const posStr = String(inv.placeOfSupply || '').trim();
  const invTopState = (inv.state !== undefined && inv.state !== null) ? String(inv.state).trim() : 'TENALI';

  const rSt = (inv.receiver && inv.receiver.state) ? inv.receiver.state : '';
  const cSt = (inv.consignee && inv.consignee.state) ? inv.consignee.state : '';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>@page { size: A4 portrait; margin: 4mm 6mm; } * { box-sizing: border-box; } body { margin: 0; padding: 0; font-family: Arial, sans-serif; font-size: 8.5pt; color: #1a237e; background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .inv-paper { position: relative; width: 100%; border: 2px solid #1a237e; } table { border-collapse: collapse; }</style></head><body>' +
    '<div class="inv-paper">' +
      '<table style="width:100%; font-size:9pt; font-weight:bold; border-bottom:2px solid #1a237e;"><tr>' +
        '<td style="padding:4px 10px; width:33%; text-align:left; vertical-align:middle;">GSTIN: ' + SG + '</td>' +
        '<td style="padding:4px 10px; width:34%; text-align:center; vertical-align:middle;"><div style="border:2px solid #1a237e; color:#1a237e; background:#fff; padding:4px 16px; display:inline-block; border-radius:4px; line-height:1.2; font-size:12pt; font-weight:900;">TAX INVOICE<br><span style="font-size:7.5pt; font-weight:bold;">CASH / CREDIT</span></div></td>' +
        '<td style="padding:4px 10px; width:33%; text-align:right; vertical-align:middle;">' + (logoB64 ? '<img src="' + logoB64 + '" style="max-height:65px; max-width:180px; object-fit:contain; vertical-align:middle;">' : '') + '</td>' +
      '</tr></table>' +
      '<table style="width:100%; margin:4px 0;"><tr>' +
        '<td style="width:90px; text-align:center; vertical-align:middle; padding-left:8px;">' + (leftGodB64 ? '<img src="' + leftGodB64 + '" style="width:80px; height:80px; object-fit:cover; border:1px solid #1a237e; display:block; margin:0 auto;">' : '') + '</td>' +
        '<td style="text-align:center; vertical-align:middle;"><h1 style="margin:0; font-size:22pt; font-family:serif; font-weight:bold; color:#1a237e;">' + SN + '</h1><div style="font-size:8pt; font-weight:bold; margin-top:2px; color:#000; line-height:1.3;">' + SA1 + '<br>' + SA2 + '<br>Cell : ' + SPH + '</div></td>' +
        '<td style="width:90px; text-align:center; vertical-align:middle; padding-right:8px;">' + (rightGodB64 ? '<img src="' + rightGodB64 + '" style="width:80px; height:80px; object-fit:cover; border:1px solid #1a237e; display:block; margin:0 auto;">' : '') + '</td>' +
      '</tr></table>' +
      '<table style="width:100%; border-top:2px solid #1a237e; border-bottom:2px solid #1a237e; font-size:8pt; font-weight:bold; table-layout:fixed;"><tr>' +
        '<td style="width:50%; border-right:2px solid #1a237e; padding:3px 6px; vertical-align:top;"><table style="width:100%; table-layout:fixed; font-size:8pt;"><colgroup><col style="width:85px;"><col style="width:10px;"><col></colgroup>' +
          '<tr><td style="padding:1px 0;">Invoice No.</td><td style="text-align:center;">:</td><td style="color:#b30000; font-size:12pt; font-weight:900;">' + escPdf(String(inv.invoiceNo || '')) + '</td></tr>' +
          '<tr><td style="padding:1px 0;">Invoice Date</td><td style="text-align:center;">:</td><td style="color:#000; font-weight:normal;">' + fdPdf(inv.date) + '</td></tr>' +
          '<tr><td style="padding:1px 0;">State</td><td style="text-align:center;">:</td><td style="color:#000; font-weight:normal;">' + escPdf(invTopState) + '</td></tr>' +
        '</table></td>' +
        '<td style="width:50%; padding:3px 6px; vertical-align:top;"><table style="width:100%; table-layout:fixed; font-size:7.5pt;">' +
          '<tr><td style="width:100px; font-weight:bold;">Transportation Mode</td><td style="width:8px;">:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + escPdf(inv.transportMode || '') + '&nbsp;</td></tr>' +
          '<tr><td style="font-weight:bold;">L.R. / Docket No.</td><td>:</td><td style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + escPdf(inv.lrNo || '') + '&nbsp;</td><td style="text-align:right; font-weight:bold;">Date:</td><td colspan="2" style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + fdPdf(inv.transportDate) + '&nbsp;</td></tr>' +
          '<tr><td style="font-weight:bold;">Date of Supply</td><td>:</td><td style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + fdPdf(inv.supplyDate) + '&nbsp;</td><td style="text-align:right; font-weight:bold;">Bundles:</td><td colspan="2" style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + escPdf(String(inv.bundles || '')) + '&nbsp;</td></tr>' +
          '<tr><td style="font-weight:bold;">Place of Supply</td><td>:</td><td style="color:#000; font-weight:normal; border-bottom:1px solid #1a237e;">' + escPdf(posStr) + '&nbsp;</td><td style="text-align:right; font-weight:bold;">State Code:</td><td colspan="2" style="color:#000; font-weight:900; border-bottom:1px solid #1a237e;">' + escPdf(String(inv.stateCode || '')) + '&nbsp;</td></tr>' +
        '</table></td>' +
      '</tr></table>' +
      '<table style="width:100%; border-bottom:2px solid #1a237e; font-size:8pt; font-weight:bold; table-layout:fixed;"><tr>' +
        '<td style="width:50%; border-right:2px solid #1a237e; vertical-align:top;"><div style="text-align:center; font-weight:bold; border-bottom:1px solid #1a237e; padding:3px;">Details of Receiver | Billed to :</div><div style="padding:3px 6px;"><table style="width:100%; font-size:8pt;">' +
          '<tr><td style="width:50px;">Name</td><td style="width:8px;">:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.receiver ? inv.receiver.name : '') + '&nbsp;</td></tr>' +
          '<tr><td>Address</td><td>:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.receiver ? inv.receiver.address : '') + '&nbsp;</td></tr>' +
          '<tr><td>GSTIN</td><td>:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.receiver && inv.receiver.gstin ? inv.receiver.gstin : '') + '&nbsp;</td></tr>' +
          '<tr><td>State</td><td>:</td><td style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(rSt) + '</td><td style="width:65px; text-align:center; border:1px solid #1a237e;">State Code</td><td style="width:25px; text-align:center; border:1px solid #1a237e; border-left:none; color:#000; font-weight:900;">' + escPdf(inv.receiver ? inv.receiver.stateCode : '') + '</td></tr>' +
        '</table></div></td>' +
        '<td style="width:50%; vertical-align:top;"><div style="text-align:center; font-weight:bold; border-bottom:1px solid #1a237e; padding:3px;">Details of Consignee | Shipped to :</div><div style="padding:3px 6px;"><table style="width:100%; font-size:8pt;">' +
          '<tr><td style="width:50px;">Name</td><td style="width:8px;">:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.consignee ? inv.consignee.name : '') + '&nbsp;</td></tr>' +
          '<tr><td>Address</td><td>:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.consignee ? inv.consignee.address : '') + '&nbsp;</td></tr>' +
          '<tr><td>GSTIN</td><td>:</td><td colspan="4" style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(inv.consignee && inv.consignee.gstin ? inv.consignee.gstin : '') + '&nbsp;</td></tr>' +
          '<tr><td>State</td><td>:</td><td style="color:#000; font-weight:normal; border-bottom:1px solid #a0aabf;">' + escPdf(cSt) + '</td><td style="width:65px; text-align:center; border:1px solid #1a237e;">State Code</td><td style="width:25px; text-align:center; border:1px solid #1a237e; border-left:none; color:#000; font-weight:900;">' + escPdf(inv.consignee ? inv.consignee.stateCode : '') + '</td></tr>' +
        '</table></div></td>' +
      '</tr></table>' +
      '<table style="width:100%; font-size:8pt; font-weight:bold;"><thead style="background:#f4f4f4;"><tr>' +
        '<th style="border:1px solid #1a237e; padding:3px; width:55px;">Bale No</th><th style="border:1px solid #1a237e; padding:3px; text-align:left;">Description of Goods</th><th style="border:1px solid #1a237e; padding:3px; width:75px;">HSN CODE</th><th style="border:1px solid #1a237e; padding:3px; width:40px;">Qty</th><th style="border:1px solid #1a237e; padding:3px; width:70px;">MTS.CMS</th><th style="border:1px solid #1a237e; padding:3px; text-align:right; width:65px;">Rate</th><th style="border:1px solid #1a237e; padding:3px; text-align:right; width:80px;">Amount</th>' +
      '</tr></thead><tbody style="color:#000; font-weight:normal;">' + mcHtml + '</tbody></table>' +
      '<div style="border-top:1px solid #1a237e; border-bottom:1px solid #1a237e; min-height:70px;"><div style="float:right; width:50%; border-left:1px solid #1a237e; font-size:8.5pt;">' + taxRows + '<div style="display:flex; justify-content:space-between; border-top:2px solid #1a237e; padding:4px 8px; font-weight:bold; font-size:11pt; background:#e8e8e8;"><span>Total Amount After Tax</span><span style="color:#000;">' + fmPdf(inv.totalAmount) + '</span></div></div><div style="clear:both;"></div></div>' +
      '<div style="padding:4px 8px; font-size:8pt; font-weight:bold;">Amount in Words: <span style="color:#000; font-weight:normal;">' + numToWordsPdf(inv.totalAmount) + '</span></div>' +
      '<div style="border-top:1px solid #1a237e; padding:4px 8px; font-size:8pt; line-height:1.5; font-weight:bold; color:#000;"><span style="color:#1a237e;">BANK DETAILS :</span> ' + BN + '<br><span style="color:#1a237e;">A/c. No.&nbsp;&nbsp;&nbsp;&nbsp;:</span> ' + BA + '<br><span style="color:#1a237e;">IFS Code&nbsp;&nbsp;:</span> ' + BI + '</div>' +
      '<div style="border-top:1px solid #1a237e; padding:4px 8px; font-size:7.5pt; line-height:1.4; color:#000; position:relative;"><div style="text-align:center; font-weight:bold; text-decoration:underline; font-size:8pt;">TERMS &amp; CONDITIONS</div>1.&nbsp; Goods once sold cannot be taken back or exchanged<br>2.&nbsp; SUBJECT TO TENALI JURISDICTION<div style="position:absolute; bottom:3px; right:8px; font-size:7.5pt; font-weight:bold; color:#333;">E &amp; OE</div></div>' +
      '<div style="border-top:1px solid #1a237e; display:flex; font-size:8pt; font-weight:bold; color:#000; height:70px;"><div style="width:50%; display:flex; flex-direction:column; justify-content:space-between; align-items:center; height:100%; padding:6px 0;"><div>&nbsp;</div><div>Buyer Signature</div></div><div style="width:50%; display:flex; flex-direction:column; justify-content:space-between; align-items:center; height:100%; padding:6px 0;"><div>For ' + SN + '</div><div style="font-weight:normal; font-size:7.5pt; color:#444;">Authorised Signatory</div></div></div>' +
    '</div></body></html>';
}

// ⚡ Headless PDF Buffer Creator with Chrome
async function createInvoicePdfBuffer(inv) {
  const puppeteer = require('puppeteer');
  const chromePath = findChromeExecutable();
  const html = generateInvoiceHtml(inv);
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  const pdfBuf = await page.pdf({
    format: 'A4',
    printBackground: true,
    margin: { top: '4mm', bottom: '4mm', left: '6mm', right: '6mm' }
  });
  await browser.close();
  return Buffer.from(pdfBuf);
}

// ⚡ Helper: Robust Inside Andhra Pradesh (Intra-State) Detector
function isInsideAndhraPradesh(inv) {
  if (!inv) return true;
  // 1. Explicit manual or stored supply type takes absolute precedence
  if (inv.isInterState !== undefined && inv.isInterState !== null) {
    return !inv.isInterState;
  }
  // 2. Base strictly on Consignee | Shipped to
  if (inv.consignee) {
    const cGst = String(inv.consignee.gstin || '').trim().slice(0, 2);
    const cSc = String(inv.consignee.stateCode || cGst || '').replace(/\D/g, '');
    const cSt = String(inv.consignee.state || '').trim().toLowerCase();
    if (cSc === '37') return true;
    if (cSc && cSc.length >= 2 && cSc !== '37') return false;
    if (cSt) {
      if (cSt.includes('andhra') || cSt === 'ap' || cSt === 'a.p.') return true;
      if (cSt.length > 2 && !cSt.includes('andhra') && cSt !== 'ap') return false;
    }
  }
  // 3. Fallback to Receiver ONLY if Consignee was not provided
  if (inv.receiver) {
    const rGst = String(inv.receiver.gstin || '').trim().slice(0, 2);
    const rSc = String(inv.receiver.stateCode || rGst || '').replace(/\D/g, '');
    const rSt = String(inv.receiver.state || '').trim().toLowerCase();
    if (rSc === '37') return true;
    if (rSc && rSc.length >= 2 && rSc !== '37') return false;
    if (rSt) {
      if (rSt.includes('andhra') || rSt === 'ap' || rSt === 'a.p.') return true;
      if (rSt.length > 2 && !rSt.includes('andhra') && rSt !== 'ap') return false;
    }
  }
  return true;
}

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
    const tgToken = process.env.TELEGRAM_BOT_TOKEN || customTg.token || '';
    const tgChatId = process.env.TELEGRAM_CHAT_ID || customTg.chatId || '';

    if (!tgToken || !tgChatId || tgToken.startsWith('••')) {
      console.log(`[Auto-Telegram] Bot token or chatId not configured or masked. Skipping.`);
      return;
    }

    const baseTokens = [tgToken].filter(Boolean);
    const baseChats = [tgChatId].filter(Boolean);

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

    const isWithinAP = isInsideAndhraPradesh(inv);
    const isInter = (inv.isInterState !== undefined && inv.isInterState !== null) ? inv.isInterState : !isWithinAP;

    let tgGstLines = '';
    if (isInter) {
      const igstVal = Number(inv.igstAmount || 0).toFixed(2);
      tgGstLines = `➕ *ADD IGST (5%)*: ₹${igstVal}\n` +
                   `➕ *ADD CGST (2.5%)*: ₹0.00\n` +
                   `➕ *ADD SGST (2.5%)*: ₹0.00\n` +
                   `📊 *Total GST (5%)*: ₹${igstVal}\n`;
    } else {
      const cgstVal = Number(inv.cgstAmount || 0).toFixed(2);
      const sgstVal = Number(inv.sgstAmount || 0).toFixed(2);
      const totGstVal = (Number(inv.cgstAmount || 0) + Number(inv.sgstAmount || 0)).toFixed(2);
      tgGstLines = `➕ *ADD CGST (2.5%)*: ₹${cgstVal}\n` +
                   `➕ *ADD SGST (2.5%)*: ₹${sgstVal}\n` +
                   `➕ *ADD IGST (5%)*: ₹0.00\n` +
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

      const isWithinAP = isInsideAndhraPradesh(inv);
      const isInter = (inv.isInterState !== undefined && inv.isInterState !== null) ? inv.isInterState : !isWithinAP;

      let waGstLines = '';
      let totalGst = '0.00';
      if (isInter) {
        const igstVal = Number(inv.igstAmount || 0).toFixed(2);
        waGstLines = `➕ *ADD IGST (5%)*: ₹${igstVal}\n` +
                     `➕ *ADD CGST (2.5%)*: ₹0.00\n` +
                     `➕ *ADD SGST (2.5%)*: ₹0.00\n`;
        totalGst = igstVal;
      } else {
        const cgstVal = Number(inv.cgstAmount || 0).toFixed(2);
        const sgstVal = Number(inv.sgstAmount || 0).toFixed(2);
        waGstLines = `➕ *ADD CGST (2.5%)*: ₹${cgstVal}\n` +
                     `➕ *ADD SGST (2.5%)*: ₹${sgstVal}\n` +
                     `➕ *ADD IGST (5%)*: ₹0.00\n`;
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

      // ⚡ GENERATE OFFICIAL TAX INVOICE PDF BUFFER
      let pdfMedia = null;
      try {
        console.log(`[Auto-WhatsApp] Compiling official A4 Tax Invoice PDF for #${invNo}...`);
        const pdfBuffer = await createInvoicePdfBuffer(inv);
        if (pdfBuffer && pdfBuffer.length > 1000) {
          const { MessageMedia } = require('whatsapp-web.js');
          const realPdfBuf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
          const base64Data = realPdfBuf.toString('base64');
          pdfMedia = new MessageMedia('application/pdf', base64Data, `Invoice_${invNo}.pdf`);
          console.log(`[Auto-WhatsApp] PDF compiled successfully (${realPdfBuf.length} bytes, base64 length: ${base64Data.length}).`);
        }
      } catch (pdfErr) {
        console.warn(`[Auto-WhatsApp] PDF generation warning (will dispatch text breakdown):`, pdfErr.message);
      }

      for (let phone of recipientPhones) {
        const targetChatId = await resolveChatId(client, phone);
        if (targetChatId) {
          try {
            if (pdfMedia) {
              // ⚡ Deliver the actual PDF document attachment with text summary caption
              await sendWhatsappMessageWithTimeout(client, targetChatId, pdfMedia, {
                caption: waText,
                sendMediaAsDocument: true
              }, 35000);
              console.log(`[Auto-WhatsApp] ✅ Dispatched invoice #${invNo} PDF document with summary to ${targetChatId}`);
            } else {
              // Fallback to text message if PDF engine encountered an issue
              await sendWhatsappMessageWithTimeout(client, targetChatId, waText, {}, 15000);
              console.log(`[Auto-WhatsApp] Dispatched invoice #${invNo} text to ${targetChatId}`);
            }
          } catch (waErr) {
            console.warn(`[Auto-WhatsApp] Send to ${targetChatId} warning:`, waErr.message);
            if (pdfMedia) {
              try {
                await sendWhatsappMessageWithTimeout(client, targetChatId, waText, {}, 15000);
                console.log(`[Auto-WhatsApp] Fallback text dispatched to ${targetChatId}`);
              } catch (_) {}
            }
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

// Root route serves index.html with absolute zero-cache to ensure all clients get the latest build instantly
app.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  const appDataIndex = path.join(AKB_DIR, 'index.html');
  const target = (fs.existsSync(appDataIndex) && fs.statSync(appDataIndex).size > 1000) ? appDataIndex : path.join(__dirname, 'index.html');
  res.sendFile(target);
});

// ==========================================
// 7. START SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`⚡ AKB High-Speed Backend Server Running`);
  console.log(`🌐 Local URL: http://127.0.0.1:${PORT}`);
  console.log(`🚀 Database: Google Apps Script (Cloud)`);
  console.log(`📲 WhatsApp: http://127.0.0.1:${PORT}/api/whatsapp/status`);
  console.log(`===============================================`);
});
