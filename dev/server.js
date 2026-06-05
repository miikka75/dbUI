// server.js — Local dev server with pluggable storage backend
// Usage: node server.js          (SQLite, default)
//        node server.js --fs     (JSON files in dev/data/)
const http = require('http');
const fs = require('fs');
const path = require('path');
const defaultSchema = require('./schema.json');
const SCHEMA = defaultSchema.tables;

const PORT = 3000;
const USE_FS = process.argv.includes('--fs');
const backend = USE_FS
  ? require('./storage-fs').createFsBackend(path.join(__dirname, 'data'))
  : require('./backend-local').createLocalBackend(path.join(__dirname, 'local.db'));
const STATIC_DIR = path.join(__dirname, '..');

// No auto-init -- schema must be imported explicitly

// Persist users to file
const USERS_PATH = path.join(__dirname, 'users.json');
if (fs.existsSync(USERS_PATH)) backend._users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
function saveUsers() { fs.writeFileSync(USERS_PATH, JSON.stringify(backend._users || {}, null, 2)); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
  });
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS: only allow loopback origins (same-origin needs no ACAO). Blocks cross-site drive-by requests.
  const origin = req.headers.origin;
  const allowOrigin = (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ? origin : null;
  if (req.method === 'OPTIONS') {
    const h = { 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type,X-User' };
    if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
    res.writeHead(204, h);
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  // API routes
  if (url.pathname.startsWith('/api/')) {
    const body = req.method === 'POST' ? await parseBody(req) : {};
    const route = url.pathname.slice(5);

    // Access control: resolve user's allowed tables
    const userEmail = req.headers['x-user'] || 'local@dev';
    function getAllowedTables() {
      if (!backend._users) return null; // no users = no restrictions
      const u = Object.values(backend._users).find(v => v.user === userEmail);
      if (!u) return []; // unknown user = no access
      if (u.role === 'admin' || u.tables === 'all') return null; // null = unrestricted
      return u.tables || [];
    }
    function checkTableAccess(tableId) {
      const allowed = getAllowedTables();
      if (!allowed) return true;
      // tableId may be "tasks__active" -> extract base name
      const base = tableId ? tableId.split('__')[0] : '';
      return allowed.indexOf(base) >= 0;
    }

    try {
    switch (route) {
      case 'getSchema': return json(res, backend.getSchema('local'));
      case 'saveSchema': backend.saveSchema('local', body.schema); return json(res, { ok: true });
      case 'validateFolder': return json(res, backend.validateFolder(body.id || 'local'));
      case 'getFolderConfig': return json(res, backend.getFolderConfig('local'));
      case 'setFolderConfig': backend.setFolderConfig('local', body.config); return json(res, { ok: true });
      case 'initSchema': if (!body.schema) return json(res, {}); return json(res, backend.initSchema('local', body.schema));
      case 'resetData': backend.resetData(); backend._users = undefined; saveUsers(); return json(res, { ok: true });
      case 'getAvailableTables': return json(res, backend.getAvailableTables('local'));
      case 'serverInfo': return json(res, { storage: USE_FS ? 'fs' : 'sqlite' });
      case 'getAvailableLanguages': return json(res, backend.getAvailableLanguages('local'));
      case 'getTableData': if (!checkTableAccess(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } return json(res, backend.getTableData(body.tableId, body.tab));
      case 'putRow': if (!checkTableAccess(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } backend.putRow(body.tableId, body.data, body.tab); return json(res, { ok: true });
      case 'deleteRow': if (!checkTableAccess(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } return json(res, { deleted: backend.deleteRow(body.tableId, body.id, body.tab) });
      case 'getTranslations': return json(res, backend.getTranslations(body.folderId || 'local', body.langCode));
      case 'updateTranslations': backend.updateTranslations(body.folderId || 'local', body.langCode, body.updates); return json(res, { ok: true });
      case 'createLanguage': return json(res, { id: backend.createLanguage(body.folderId || 'local', body.code, body.name, body.keys) });
      case 'deleteLanguage': backend.deleteLanguage(body.folderId || 'local', body.code); return json(res, { ok: true });
      case 'getFileModifiedTime': return json(res, { time: backend.getFileModifiedTime(body.fileId) });
      case 'getLists': return json(res, backend.getLists('local'));
      case 'saveLists': backend.saveLists('local', body.lists); return json(res, { ok: true });
      case 'putListItem': if (!checkTableAccess(body.listName)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } backend.putListItem('local', body.listName, body.value); return json(res, { ok: true });
      case 'moveRow': if (!checkTableAccess(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } backend.moveRow(body.tableId, body.rowData, body.fromTab, body.toTab); return json(res, { ok: true });
      case 'saveChangesets': backend.saveChangesets('local', body.siteId, body.json); return json(res, { ok: true });
      case 'loadChangesets': return json(res, backend.loadChangesets('local', body.excludeSiteId));
      case 'readFile': return json(res, { data: backend.readFile('local', body.name) });
      case 'writeFile': backend.writeFile('local', body.name, body.data); return json(res, { ok: true });
      case 'deleteFile': backend.deleteFile('local', body.name); return json(res, { ok: true });
      case 'saveConfig': { var allowed = ['firebase-config.json', 'config.json']; var fn = path.basename(body.filename || 'config.json'); if (!allowed.includes(fn)) return json(res, { error: 'filename not allowed' }, 403); fs.writeFileSync(path.join(STATIC_DIR, fn), JSON.stringify(body.data, null, 2)); return json(res, { ok: true }); }
      case 'getUsers': return json(res, backend._users || {});
      case 'setUserRole': { if (!backend._users) backend._users = {}; backend._users[body.uid] = { role: body.role, user: body.user || '', tables: body.tables || 'all' }; saveUsers(); return json(res, { ok: true }); }
      case 'removeUser': { if (backend._users) delete backend._users[body.uid]; saveUsers(); return json(res, { ok: true }); }
      default: res.writeHead(404); return res.end('Not found');
    }
    } catch (err) {
      console.error('API error:', route, err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Serve static files from project root (fallback to dev/ for local backend)
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  let filePath = path.join(STATIC_DIR, rel);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, rel);
  // Path-traversal guard: resolved file must stay under STATIC_DIR or dev/
  const rp = path.resolve(filePath);
  if (!rp.startsWith(path.resolve(STATIC_DIR) + path.sep) && !rp.startsWith(path.resolve(__dirname) + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Local dev server: http://127.0.0.1:' + PORT);
  console.log('Storage backend: ' + (USE_FS ? 'JSON files (dev/data/)' : 'SQLite (dev/local.db)'));
});
