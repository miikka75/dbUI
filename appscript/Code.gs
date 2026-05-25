// Code.gs — Server-side (runs on Google's servers)
// Deploy as: Web app → Execute as: User accessing the web app

const DEFAULT_TAB = 'active';

let _langFileId = null;
function getLangSpreadsheet(folderId) {
  if (_langFileId) try { return SpreadsheetApp.openById(_langFileId); } catch(e) { _langFileId = null; }
  const files = DriveApp.getFolderById(folderId).getFilesByName('languages');
  if (!files.hasNext()) return null;
  _langFileId = files.next().getId();
  return SpreadsheetApp.openById(_langFileId);
}

function doGet() {
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('Drive Sync App')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// --- Shared helpers ---

/** Get sheet by tab name */
function getSheet(spreadsheetId, tabName) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  const tab = tabName || DEFAULT_TAB;
  return ss.getSheetByName(tab) || ss.getSheets()[0];
}

/** Get or create a tab within a spreadsheet */
function getOrCreateTab(spreadsheetId, tabName, headers) {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  let sheet = ss.getSheetByName(tabName);
  if (sheet) return sheet;
  sheet = ss.insertSheet(tabName);
  if (headers) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

// --- Folder helpers ---

function validateFolderId(folderId) {
  try {
    return { valid: true, name: DriveApp.getFolderById(folderId).getName() };
  } catch (e) {
    return { valid: false, name: null };
  }
}

function getFolderConfig(folderId) {
  const files = DriveApp.getFolderById(folderId).getFilesByName('.app-config.json');
  return files.hasNext() ? JSON.parse(files.next().getBlob().getDataAsString()) : null;
}

function setFolderConfig(folderId, config) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName('.app-config.json');
  const content = JSON.stringify(config);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile('.app-config.json', content, 'application/json');
}

// --- Schema file (schema.json in Drive folder) ---

function getSchema(folderId) {
  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFilesByName('schema.json');
  if (!files.hasNext()) return null;
  return JSON.parse(files.next().getBlob().getDataAsString());
}

function saveSchema(folderId, schema) {
  var folder = DriveApp.getFolderById(folderId);
  var files = folder.getFilesByName('schema.json');
  var content = typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile('schema.json', content, 'application/json');
}

// --- Boot batch (single call replaces 8+ sequential calls) ---

function bootData(folderId, schema) {
  try {
  if (!schema) schema = getSchema(folderId);
  var parsed = typeof schema === 'string' ? JSON.parse(schema) : schema;
  var tables = parsed ? (parsed.tables || parsed) : {};
  var tableMap = initSchema(folderId, tables);
  var languages = getAvailableLanguages(folderId);
  var lists = getLists(folderId);
  var data = {};
  for (var name in tableMap) {
    var def = tables[name];
    data[name] = getTableData(tableMap[name], def.tab || 'active');
    if (def.archiveTab) { try { data[name + '__archive'] = getTableData(tableMap[name], def.archiveTab); } catch(e2) {} }
  }
  // Return schema as object + explicit key order arrays (google.script.run scrambles object keys)
  return { schema: parsed, tableOrder: Object.keys(tables), columnOrders: Object.keys(tables).reduce(function(acc, t) { acc[t] = Object.keys(tables[t].columns); return acc; }, {}), tableMap: tableMap, languages: languages, lists: lists, data: data };
  } catch(e) { return { error: e.message }; }
}

// --- Schema & CRUD ---

function initSchema(folderId, schema) {
  if (typeof schema === 'string') schema = JSON.parse(schema);
  const folder = DriveApp.getFolderById(folderId);
  const result = {};
  for (const [table, def] of Object.entries(schema)) {
    result[table] = ensureTable(folder, table, def.columns, def.tab);
  }
  return result;
}

function ensureTable(folder, tableName, columns, tabName) {
  // Normalize: columns can be object {name: type} or array [name]
  const cols = Array.isArray(columns) ? columns : Object.keys(columns);
  const files = folder.getFilesByName(tableName);
  if (files.hasNext()) {
    const ss = SpreadsheetApp.openById(files.next().getId());
    const sheet = getSheet(ss.getId());
    const lastCol = sheet.getLastColumn();
    const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    const missing = cols.filter(c => !existing.includes(c));
    if (missing.length > 0) {
      sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
    return ss.getId();
  }
  // Create new
  const ss = SpreadsheetApp.create(tableName);
  const sheet = ss.getSheets()[0];
  if (tabName) sheet.setName(tabName);
  sheet.getRange(1, 1, 1, cols.length).setValues([cols]);
  const file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  return ss.getId();
}

function getTableData(spreadsheetId, tabName) {
  try {
    const sheet = getSheet(spreadsheetId, tabName);
    if (!sheet || sheet.getLastRow() < 1) return { headers: [], rows: [] };
    var values = sheet.getDataRange().getValues();
    if (!values || values.length < 2) return { headers: (values && values[0]) || [], rows: [] };
    var headers = values[0].map(function(h) { return String(h || ''); }).filter(function(h) { return h; });
    var rows = values.slice(1).map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) {
        var val = row[i];
        // Force all values to strings for safe serialization
        if (val instanceof Date) val = val.getFullYear() + '-' + String(val.getMonth()+1).padStart(2,'0') + '-' + String(val.getDate()).padStart(2,'0');
        else if (val === null || val === undefined) val = '';
        else val = String(val);
        obj[h] = val;
      });
      return obj;
    });
    return { headers: headers, rows: rows };
  } catch (e) {
    return { headers: [], rows: [] };
  }
}

function moveRow(spreadsheetId, rowData, fromTab, toTab) {
  deleteRow(spreadsheetId, rowData.id, fromTab);
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var srcSheet = ss.getSheetByName(fromTab) || ss.getSheets()[0];
  var lastCol = srcSheet.getLastColumn();
  if (lastCol < 1) return;
  var headers = srcSheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var tgtSheet = ss.getSheetByName(toTab);
  if (!tgtSheet) { tgtSheet = ss.insertSheet(toTab); tgtSheet.getRange(1, 1, 1, headers.length).setValues([headers]); }
  else if (tgtSheet.getLastColumn() < 1) { tgtSheet.getRange(1, 1, 1, headers.length).setValues([headers]); }
  var values = headers.map(function(h) { return rowData[h] !== undefined ? rowData[h] : ''; });
  tgtSheet.appendRow(values);
}

function putRow(spreadsheetId, rowData, tabName) {
  let sheet;
  if (tabName) {
    const activeSheet = getSheet(spreadsheetId);
    const lastCol = activeSheet.getLastColumn();
    if (lastCol < 1) return;
    const activeHeaders = activeSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    sheet = getOrCreateTab(spreadsheetId, tabName, activeHeaders);
  } else {
    sheet = getSheet(spreadsheetId);
  }
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (!headers || !headers.length || !headers[0]) return;
  const values = headers.map(h => rowData[h] !== undefined ? rowData[h] : '');
  const data = sheet.getDataRange().getValues();
  const idCol = headers.indexOf('id');
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(rowData.id)) { rowIdx = i + 1; break; }
  }
  if (rowIdx > 0) sheet.getRange(rowIdx, 1, 1, values.length).setValues([values]);
  else sheet.appendRow(values);
}

function deleteRow(spreadsheetId, id, tabName) {
  const sheet = tabName ? getOrCreateTab(spreadsheetId, tabName) : getSheet(spreadsheetId);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const data = sheet.getDataRange().getValues();
  const idCol = data[0].indexOf('id');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) { sheet.deleteRow(i + 1); return true; }
  }
  return false;
}

// --- i18n (single 'languages' file, one tab per language) ---

function getLists(folderId) {
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFilesByName('lists');
  if (!files.hasNext()) return {};
  const ss = SpreadsheetApp.openById(files.next().getId());
  const result = {};
  ss.getSheets().forEach(sheet => {
    const name = sheet.getName();
    if (name === 'Sheet1') return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 1) return;
    const values = sheet.getRange(1, 1, lastRow, 1).getValues();
    result[name] = values.map(r => r[0]).filter(v => v);
  });
  return result;
}

function saveLists(folderId, lists) {
  const folder = DriveApp.getFolderById(folderId);
  let ss;
  const files = folder.getFilesByName('lists');
  if (files.hasNext()) {
    ss = SpreadsheetApp.openById(files.next().getId());
  } else {
    ss = SpreadsheetApp.create('lists');
    const file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  for (const [name, values] of Object.entries(lists)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    sheet.clear();
    if (values.length) sheet.getRange(1, 1, values.length, 1).setValues(values.map(v => [v]));
  }
  // Remove tabs not in lists (except Sheet1)
  ss.getSheets().forEach(s => { const n = s.getName(); if (n !== 'Sheet1' && !lists[n] && ss.getSheets().length > 1) ss.deleteSheet(s); });
}

function putListItem(folderId, listName, value) {
  const folder = DriveApp.getFolderById(folderId);
  let ss;
  const files = folder.getFilesByName('lists');
  if (files.hasNext()) ss = SpreadsheetApp.openById(files.next().getId());
  else { ss = SpreadsheetApp.create('lists'); const f = DriveApp.getFileById(ss.getId()); folder.addFile(f); DriveApp.getRootFolder().removeFile(f); }
  let sheet = ss.getSheetByName(listName);
  if (!sheet) sheet = ss.insertSheet(listName);
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1).setValue(value);
}

function getAvailableLanguages(folderId) {
  const langs = [];
  const ss = getLangSpreadsheet(folderId);
  if (!ss) return langs;
  ss.getSheets().forEach(s => {
    const name = s.getName();
    if (name !== 'Sheet1') langs.push({ code: name, name: name });
  });
  return langs;
}

function getTranslations(folderId, langCode) {
  const ss = getLangSpreadsheet(folderId);
  if (!ss) return {};
  const sheet = ss.getSheetByName(langCode);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const values = sheet.getDataRange().getValues();
  const translations = {};
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] && values[i][1]) translations[values[i][0]] = values[i][1];
  }
  return translations;
}

function updateTranslations(folderId, langCode, updates) {
  const ss = getLangSpreadsheet(folderId);
  if (!ss) return;
  const sheet = ss.getSheetByName(langCode);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (const [key, value] of Object.entries(updates)) {
    let found = false;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) { sheet.getRange(i + 1, 2).setValue(value); found = true; break; }
    }
    if (!found) sheet.appendRow([key, value]);
  }
}

function createLanguage(folderId, code, name, keys) {
  let ss = getLangSpreadsheet(folderId);
  if (!ss) {
    const folder = DriveApp.getFolderById(folderId);
    ss = SpreadsheetApp.create('languages');
    const file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
    _langFileId = ss.getId();
    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
  }
  let sheet = ss.getSheetByName(code);
  if (!sheet) sheet = ss.insertSheet(code);
  sheet.getRange(1, 1, 1, 2).setValues([['key', 'text']]);
  if (keys && keys.length) {
    sheet.getRange(2, 1, keys.length, 2).setValues(keys.map(k => [k, '']));
  }
  return ss.getId();
}

function deleteLanguage(folderId, code) {
  const ss = getLangSpreadsheet(folderId);
  if (!ss) return;
  const sheet = ss.getSheetByName(code);
  if (sheet && ss.getSheets().length > 1) ss.deleteSheet(sheet);
}

// --- CRDT sync ---

function saveChangesets(folderId, siteId, changesJson) {
  const folder = DriveApp.getFolderById(folderId);
  const folders = folder.getFoldersByName('changesets');
  const syncFolder = folders.hasNext() ? folders.next() : folder.createFolder('changesets');
  const fileName = siteId + '.json';
  const files = syncFolder.getFilesByName(fileName);
  if (files.hasNext()) files.next().setContent(changesJson);
  else syncFolder.createFile(fileName, changesJson, 'application/json');
}

function loadChangesets(folderId, excludeSiteId) {
  const folder = DriveApp.getFolderById(folderId);
  const folders = folder.getFoldersByName('changesets');
  if (!folders.hasNext()) return [];
  const files = folders.next().getFiles();
  const result = [];
  while (files.hasNext()) {
    const f = files.next();
    const id = f.getName().replace('.json', '');
    if (id !== excludeSiteId) result.push({ siteId: id, data: f.getBlob().getDataAsString() });
  }
  return result;
}
