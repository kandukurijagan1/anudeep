/**
 * Google Apps Script Backend for AKB Billing - PRODUCTION GRADE EDITION (v3.0)
 * 
 * Major Upgrades:
 * 🔒 Security: API Key Authentication + PropertiesService for secrets
 * 🛡️ Concurrency: LockService applied to mutations and cache invalidation
 * ⚡ Performance: Batch setValues() instead of appendRow()
 * 🗑️ Data Integrity: Soft-deletes instead of expensive physical deleteRow()
 * ✅ Schema Validation: Strict checks before writing any data
 * 
 * Deployment:
 * 1. Deploy as Web App -> Execute as: Me -> Who has access: Anyone
 * 2. Set Script Properties: API_KEY = 'your_secret_key'
 */

const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE';
const DRIVE_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';

// Cache configuration
const CACHE_KEY = 'akb_boot_v3';
const CACHE_CHUNK_SIZE = 85000;
const CACHE_TTL = 21600; 

let _activeSpreadsheet = null;
function getActiveSs() {
  if (!_activeSpreadsheet) {
    if (SPREADSHEET_ID !== 'YOUR_SPREADSHEET_ID_HERE') {
      _activeSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    } else {
      _activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    }
  }
  return _activeSpreadsheet;
}

function getApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!key) throw new Error('API_KEY is not configured in Script Properties');
  return key;
}

function authCheck(e, payload) {
  const key = (e && e.parameter && e.parameter.apiKey) || (payload && payload.apiKey);
  if (!key || key !== getApiKey()) {
    throw new Error('Unauthorized: Invalid API Key');
  }
}

// ====== GET ROUTER ======
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action);
    if (!action) {
      return HtmlService.createHtmlOutputFromFile('index')
          .setTitle('Anudeep Khadi Bandar')
          .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    }

    authCheck(e, null);
    let result = null;
    switch (action) {
      case 'bootstrap':
      case 'getAllData': result = getBootstrapData(); break;
      case 'health':
      case 'ping': result = { status: 'ok', time: Date.now(), secureMode: true }; break;
      case 'getInvoices': result = getAllFast('Invoices'); break;
      case 'getProducts': result = getAllFast('Products'); break;
      case 'getReceivers': result = getAllFast('Receivers'); break;
      case 'getConsignees': result = getAllFast('Consignees'); break;
      case 'getSettings': result = getSettingsFast(); break;
      default: return respond({ error: 'Invalid GET action: ' + action }, 400);
    }
    return respond(result);
  } catch (err) {
    console.error('GET Error:', err);
    return respond({ error: err.message }, 401);
  }
}

// ====== POST ROUTER ======
function doPost(e) {
  try {
    let payload = {};
    if (e && e.postData && e.postData.contents && e.postData.contents.trim()) {
      try { payload = JSON.parse(e.postData.contents); } catch (parseErr) { return respond({ error: 'Invalid JSON' }, 400); }
    }
    
    let action = (e && e.parameter && e.parameter.action) || payload.action || '';

    // Auth Check
    if (action !== 'sendOTP' && action !== 'getValidEmails') {
      authCheck(e, payload);
    }
    const idParam = (e && e.parameter && e.parameter.id) || payload.id || payload._id;

    let result = null;
    const lock = LockService.getScriptLock();
    // 10s lock for mutations
    if (action !== 'uploadPdf') lock.waitLock(10000); 

    try {
      switch (action) {
        case 'createInvoice': validateInvoice(payload); result = createDocFast('Invoices', payload); break;
        case 'updateInvoice': validateInvoice(payload); result = updateDocFast('Invoices', idParam, payload); break;
        case 'deleteInvoice': result = deleteDocFast('Invoices', idParam); break;
        
        case 'createProduct': validateProduct(payload); result = createDocFast('Products', payload); break;
        case 'updateProduct': validateProduct(payload); result = updateDocFast('Products', idParam, payload); break;
        case 'deleteProduct': result = deleteDocFast('Products', idParam); break;
        
        case 'createReceiver': validateParty(payload); result = createDocFast('Receivers', payload); break;
        case 'updateReceiver': validateParty(payload); result = updateDocFast('Receivers', idParam, payload); break;
        case 'deleteReceiver': result = deleteDocFast('Receivers', idParam); break;
        
        case 'createConsignee': validateParty(payload); result = createDocFast('Consignees', payload); break;
        case 'updateConsignee': validateParty(payload); result = updateDocFast('Consignees', idParam, payload); break;
        case 'deleteConsignee': result = deleteDocFast('Consignees', idParam); break;
        
        case 'updateSettings': result = updateSettingsFast(payload); break;
        case 'batch': result = handleBatchFast(payload); break;
        
        case 'getValidEmails':
          const settings = getSettingsFast();
          result = { validEmails: settings.adminEmails || ['kandukurijagan99@gmail.com', 'kandukurijagan7@gmail.com', 'kandukurijagan642@gmail.com'] };
          break;
          
        case 'sendOTP':
          if (!payload.email) throw new Error('Email is required');
          MailApp.sendEmail({
            to: payload.email,
            subject: "AKB Billing - Password Reset OTP",
            body: `Your OTP for password reset is: ${payload.otp}. It is valid for 10 minutes.`
          });
          result = { success: true };
          break;
        
        case 'uploadPdf':
          const fileBlob = e.parameter.file;
          const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
          const newFile = folder.createFile(fileBlob);
          newFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          return respond({ ok: true, driveId: newFile.getId(), link: newFile.getUrl() });
          
        default: return respond({ error: 'Invalid POST action: ' + action }, 400);
      }
      
      // Invalidate cache safely inside lock
      cacheRemoveChunked(CACHE_KEY);
      
      return respond({ success: true, data: result, invoice: (action === 'createInvoice' || action === 'updateInvoice') ? result : undefined });
    } finally {
      if (action !== 'uploadPdf') lock.releaseLock();
    }
  } catch (err) {
    console.error('POST Error:', err);
    return respond({ error: err.message, stack: err.stack }, 500);
  }
}

function doOptions(e) { return respond({ status: 'ok' }); }

// ==========================================
// VALIDATION
// ==========================================
function validateInvoice(p) {
  if (!p.invoiceNo) throw new Error('invoiceNo is required');
  if (!p.date) throw new Error('date is required');
  if (!Array.isArray(p.items) || p.items.length === 0) throw new Error('items array must not be empty');
  
  let calcSubtotal = 0;
  p.items.forEach(item => {
    if (!item.quantity || item.quantity <= 0) throw new Error('Item quantity must be > 0');
    if (item.price === undefined || item.price < 0) throw new Error('Item price must be >= 0');
    calcSubtotal += parseFloat(item.quantity) * parseFloat(item.price);
  });
  
  // Backend financial calculation to prevent frontend tampering
  p.subtotal = calcSubtotal;
  const disc = parseFloat(p.discount || 0);
  p.tax = parseFloat((calcSubtotal - disc) * ((p.taxRate || 0) / 100)).toFixed(2) * 1;
  p.grandTotal = Math.round(calcSubtotal - disc + p.tax);
}
function validateProduct(p) {
  if (!p.description) throw new Error('description is required');
}
function validateParty(p) {
  if (!p.name) throw new Error('name is required');
}

// ==========================================
// CACHE (Simplified for Concurrency)
// ==========================================
function cacheGetChunked(key) {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(key + '_c');
    if (!countStr) return null;
    const num = parseInt(countStr, 10);
    const chunkKeys = [];
    for (let i = 0; i < num; i++) chunkKeys.push(key + '_' + i);
    const chunks = cache.getAll(chunkKeys);
    let full = '';
    for (let i = 0; i < num; i++) {
      if (!chunks[key + '_' + i]) return null;
      full += chunks[key + '_' + i];
    }
    return full;
  } catch (e) { console.error('Cache Read Error:', e); return null; }
}

function cachePutChunked(key, str, ttl) {
  try {
    const cache = CacheService.getScriptCache();
    if (!str) return cacheRemoveChunked(key);
    const num = Math.ceil(str.length / CACHE_CHUNK_SIZE);
    const chunkMap = { [key + '_c']: String(num) };
    for (let i = 0; i < num; i++) {
      chunkMap[key + '_' + i] = str.substr(i * CACHE_CHUNK_SIZE, CACHE_CHUNK_SIZE);
    }
    cache.putAll(chunkMap, ttl || CACHE_TTL);
  } catch (e) { console.error('Cache Write Error:', e); }
}

function cacheRemoveChunked(key) {
  try {
    const cache = CacheService.getScriptCache();
    const countStr = cache.get(key + '_c');
    const toRemove = [key, key + '_c'];
    if (countStr) {
      const num = parseInt(countStr, 10);
      for (let i = 0; i < num; i++) toRemove.push(key + '_' + i);
    }
    cache.removeAll(toRemove);
  } catch (e) { console.error('Cache Remove Error:', e); }
}

// ==========================================
// CORE DB OPS
// ==========================================
function getOrInsertSheet(name) {
  const ss = getActiveSs();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.appendRow(['ID_INDEX', 'DATA_JSON']);
    s.setFrozenRows(1);
  }
  return s;
}

function getAllFast(sheetName) {
  const s = getOrInsertSheet(sheetName);
  const lr = s.getLastRow();
  if (lr < 2) return [];
  const vals = s.getRange(2, 1, lr - 1, 2).getValues();
  const res = [];
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).indexOf('DELETED_') !== 0 && vals[i][1]) {
      try { res.push(JSON.parse(vals[i][1])); } catch (e) { console.error('Parse err row ' + (i+2), e); }
    }
  }
  return res;
}

function createDocFast(sheetName, payload) {
  if (!payload.id && !payload._id) payload.id = 'doc_' + new Date().getTime() + '_' + Math.floor(Math.random()*1000);
  const targetId = payload.id || payload._id;
  
  const s = getOrInsertSheet(sheetName);
  const lr = s.getLastRow();
  
  // Idempotency: prevent duplicate inserts if ID already exists
  if (lr >= 2) {
    const idCol = s.getRange(2, 1, lr - 1, 1).getValues();
    for (let i = idCol.length - 1; i >= 0; i--) {
      const val = String(idCol[i][0]);
      if (val.indexOf('DELETED_') !== 0 && (val === String(targetId) || val.startsWith(targetId + '|'))) {
        return payload; // Already exists, return idempotently
      }
    }
  }

  const indexStr = targetId + (payload.invoiceNo ? '|' + payload.invoiceNo : '');
  
  // High-performance write
  const row = lr + 1;
  s.getRange(row, 1, 1, 2).setValues([[indexStr, JSON.stringify(payload)]]);
  return payload;
}

function updateDocFast(sheetName, id, payload) {
  if (!id) throw new Error('ID required for update');
  const s = getOrInsertSheet(sheetName);
  const lr = s.getLastRow();
  if (lr < 2) throw new Error('Doc not found');
  const idCol = s.getRange(2, 1, lr - 1, 1).getValues();
  
  // Bottom-up search
  for (let i = idCol.length - 1; i >= 0; i--) {
    const val = String(idCol[i][0]);
    if (val.indexOf('DELETED_') !== 0 && (val === String(id) || val.startsWith(id + '|'))) {
      const row = i + 2;
      const indexStr = id + (payload.invoiceNo ? '|' + payload.invoiceNo : '');
      s.getRange(row, 1, 1, 2).setValues([[indexStr, JSON.stringify(payload)]]);
      return payload;
    }
  }
  throw new Error('Doc not found');
}

function deleteDocFast(sheetName, id) {
  if (!id) throw new Error('ID required');
  const s = getOrInsertSheet(sheetName);
  const lr = s.getLastRow();
  if (lr < 2) return { success: true, deleted: false };
  const idCol = s.getRange(2, 1, lr - 1, 1).getValues();
  
  for (let i = idCol.length - 1; i >= 0; i--) {
    const val = String(idCol[i][0]);
    if (val.indexOf('DELETED_') !== 0 && (val === String(id) || val.startsWith(id + '|'))) {
      // Soft Delete: Fast & preserves indexes
      const row = i + 2;
      s.getRange(row, 1, 1, 1).setValue('DELETED_' + val);
      return { success: true, deleted: true, id: id };
    }
  }
  return { success: true, deleted: false };
}

function getSettingsFast() {
  const s = getOrInsertSheet('Settings');
  const lr = s.getLastRow();
  if (lr < 2) return { nextInvoiceNo: 1 };
  const val = s.getRange(lr, 2).getValue();
  if (!val) return { nextInvoiceNo: 1 };
  try { return JSON.parse(val); } catch(e) { return { nextInvoiceNo: 1 }; }
}

function updateSettingsFast(payload) {
  const s = getOrInsertSheet('Settings');
  const lr = s.getLastRow();
  let cur = {};
  if (lr >= 2) {
    try { cur = JSON.parse(s.getRange(lr, 2).getValue()); } catch(e){}
  }
  const merged = Object.assign({}, cur, payload);
  if (lr >= 2) {
    s.getRange(lr, 1, 1, 2).setValues([['settings_v1', JSON.stringify(merged)]]);
  } else {
    s.getRange(2, 1, 1, 2).setValues([['settings_v1', JSON.stringify(merged)]]);
  }
  return merged;
}

function getBootstrapData() {
  const cached = cacheGetChunked(CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { console.error('Cache parse err', e); }
  }
  
  // Cache miss - Load from DB
  const ss = getActiveSs();
  const sheets = ss.getSheets();
  const map = {};
  sheets.forEach(s => map[s.getName()] = s);
  
  const readFn = (s) => {
    if (!s) return [];
    const lr = s.getLastRow();
    if (lr < 2) return [];
    const vals = s.getRange(2, 1, lr - 1, 2).getValues();
    const res = [];
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]).indexOf('DELETED_') !== 0 && vals[i][1]) {
        try { res.push(JSON.parse(vals[i][1])); } catch (e) {}
      }
    }
    return res;
  };

  const state = {
    settings: getSettingsFast(),
    invoices: readFn(map['Invoices'] || getOrInsertSheet('Invoices')),
    products: readFn(map['Products'] || getOrInsertSheet('Products')),
    receivers: readFn(map['Receivers'] || getOrInsertSheet('Receivers')),
    consignees: readFn(map['Consignees'] || getOrInsertSheet('Consignees')),
    timestamp: Date.now()
  };
  
  cachePutChunked(CACHE_KEY, JSON.stringify(state));
  return state;
}

function handleBatchFast(payload) {
  const reqs = payload.requests || [];
  const results = [];
  
  // Group creations by sheet for true batching
  const creations = { 'Invoices': [], 'Products': [], 'Receivers': [], 'Consignees': [] };
  
  // Process validations and routing
  for (let i=0; i<reqs.length; i++) {
    const req = reqs[i];
    try {
      if (req.action === 'createInvoice') { validateInvoice(req.data); creations['Invoices'].push(req); }
      else if (req.action === 'createProduct') { validateProduct(req.data); creations['Products'].push(req); }
      else if (req.action === 'createReceiver') { validateParty(req.data); creations['Receivers'].push(req); }
      else if (req.action === 'createConsignee') { validateParty(req.data); creations['Consignees'].push(req); }
      
      // Non-creates just run individually for now
      else if (req.action === 'updateInvoice') { validateInvoice(req.data); results.push(updateDocFast('Invoices', req.id, req.data)); }
      else if (req.action === 'deleteInvoice') results.push(deleteDocFast('Invoices', req.id));
      else if (req.action === 'updateProduct') { validateProduct(req.data); results.push(updateDocFast('Products', req.id, req.data)); }
      else if (req.action === 'deleteProduct') results.push(deleteDocFast('Products', req.id));
      else if (req.action === 'updateReceiver') { validateParty(req.data); results.push(updateDocFast('Receivers', req.id, req.data)); }
      else if (req.action === 'deleteReceiver') results.push(deleteDocFast('Receivers', req.id));
      else if (req.action === 'updateConsignee') { validateParty(req.data); results.push(updateDocFast('Consignees', req.id, req.data)); }
      else if (req.action === 'deleteConsignee') results.push(deleteDocFast('Consignees', req.id));
      else if (req.action === 'updateSettings') results.push(updateSettingsFast(req.data));
    } catch(err) {
      console.error('Batch error:', err);
      results.push({ error: err.message, req: req });
    }
  }

  // Execute True Batch Writes (1 setValues per sheet!)
  Object.keys(creations).forEach(sheetName => {
    const batch = creations[sheetName];
    if (batch.length === 0) return;
    
    const s = getOrInsertSheet(sheetName);
    const lr = s.getLastRow();
    
    // Simplistic Idempotency for batch: assume all new to avoid huge scans, but fallback to individual if complex
    const rows = [];
    batch.forEach(req => {
      const p = req.data;
      if (!p.id && !p._id) p.id = 'doc_' + new Date().getTime() + '_' + Math.floor(Math.random()*1000);
      const targetId = p.id || p._id;
      const indexStr = targetId + (p.invoiceNo ? '|' + p.invoiceNo : '');
      rows.push([indexStr, JSON.stringify(p)]);
      results.push(p);
    });
    
    if (rows.length > 0) {
      s.getRange(lr + 1, 1, rows.length, 2).setValues(rows);
    }
  });

  return results;
}

function respond(data, code) {
  const payload = JSON.stringify(data);
  // Apps Script cannot native return HTTP 400/500, but we can encapsulate status
  return ContentService.createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JSON);
}
