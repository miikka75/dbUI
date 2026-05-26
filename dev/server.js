// server.js — Local dev server with SQLite backend
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLocalBackend } = require('./backend-local');
const defaultSchema = require('../schema.json');
const SCHEMA = defaultSchema.tables;

const PORT = 3000;
const DB_PATH = path.join(__dirname, 'local.db');
const backend = createLocalBackend(DB_PATH);
const STATIC_DIR = path.join(__dirname, '..');

// Auto-init schema on start
backend.initSchema('local', SCHEMA);

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  // API routes
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST' ? await parseBody(req) : {};
    const route = url.pathname.slice(5);

    try {
    switch (route) {
      case 'getSchema': return json(res, backend.getSchema('local'));
      case 'saveSchema': backend.saveSchema('local', body.schema); return json(res, { ok: true });
      case 'validateFolder': return json(res, backend.validateFolder(body.id || 'local'));
      case 'getFolderConfig': return json(res, backend.getFolderConfig('local'));
      case 'setFolderConfig': backend.setFolderConfig('local', body.config); return json(res, { ok: true });
      case 'initSchema': return json(res, backend.initSchema('local', body.schema || SCHEMA));
      case 'resetData': backend.resetData(); return json(res, { ok: true });
      case 'getAvailableTables': return json(res, backend.getAvailableTables('local'));
      case 'getAvailableLanguages': return json(res, backend.getAvailableLanguages('local'));
      case 'getTableData': return json(res, backend.getTableData(body.tableId, body.tab));
      case 'putRow': backend.putRow(body.tableId, body.data, body.tab); return json(res, { ok: true });
      case 'deleteRow': return json(res, { deleted: backend.deleteRow(body.tableId, body.id, body.tab) });
      case 'getTranslations': return json(res, backend.getTranslations(body.folderId || 'local', body.langCode));
      case 'updateTranslations': backend.updateTranslations(body.folderId || 'local', body.langCode, body.updates); return json(res, { ok: true });
      case 'createLanguage': return json(res, { id: backend.createLanguage(body.folderId || 'local', body.code, body.name, body.keys) });
      case 'deleteLanguage': backend.deleteLanguage(body.folderId || 'local', body.code); return json(res, { ok: true });
      case 'getFileModifiedTime': return json(res, { time: backend.getFileModifiedTime(body.fileId) });
      case 'getLists': return json(res, backend.getLists('local'));
      case 'saveLists': backend.saveLists('local', body.lists); return json(res, { ok: true });
      case 'putListItem': backend.putListItem('local', body.listName, body.value); return json(res, { ok: true });
      case 'moveRow': backend.moveRow(body.tableId, body.rowData, body.fromTab, body.toTab); return json(res, { ok: true });
      case 'saveConfig': fs.writeFileSync(path.join(STATIC_DIR, body.filename), JSON.stringify(body.data, null, 2)); return json(res, { ok: true });
      default: res.writeHead(404); return res.end('Not found');
    }
    } catch (err) {
      console.error('API error:', route, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Serve static files from project root (fallback to dev/ for local backend)
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(STATIC_DIR, filePath);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, url.pathname);
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Local dev server: http://127.0.0.1:' + PORT);
  console.log('Database: ' + DB_PATH);
});
