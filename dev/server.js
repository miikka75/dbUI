// server.js — Local dev server with pluggable storage backend
// Usage: node server.js          (SQLite, default)
//        node server.js --fs     (JSON files in dev/data/)
const http = require('http');
const fs = require('fs');
const path = require('path');
const defaultSchema = require('./schema.json');
const SCHEMA = defaultSchema.tables;

// Owning tables of a list = tables with a column referencing it (list or listSwitch.list).
// Mirrors listOwningTables in schema-loader.html (shape-agnostic: object-map or array columns).
function listOwningTables(schemaTables, listName) {
  const out = [];
  Object.keys(schemaTables || {}).forEach(t => {
    const cols = (schemaTables[t] && schemaTables[t].columns) || {};
    const defs = Array.isArray(cols) ? cols : Object.keys(cols).map(k => cols[k]);
    if (defs.some(d => d && typeof d === 'object' && (d.list === listName || (d.listSwitch && d.listSwitch.list === listName)))) out.push(t);
  });
  return out;
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const USE_FS = process.argv.includes('--fs');
// APP_DB overrides the SQLite path; ":memory:" (or empty) uses an isolated in-memory DB — tests set
// this so they never read or clobber the real dev local.db. Default stays dev/local.db.
const APP_DB = process.env.APP_DB;
const DB_PATH = (APP_DB && APP_DB !== ':memory:') ? path.resolve(__dirname, APP_DB) : undefined;
const backend = USE_FS
  ? require('./storage-fs').createFsBackend(path.join(__dirname, 'data'))
  : require('./backend-local').createLocalBackend(APP_DB === ':memory:' ? undefined : (DB_PATH || path.join(__dirname, 'local.db')));
const STATIC_DIR = path.join(__dirname, '..');

// No auto-init -- schema must be imported explicitly

// Persist users to file. In isolated (in-memory test) mode use a throwaway path so resetData/test
// runs never overwrite the real dev users.json.
const USERS_PATH = (APP_DB === ':memory:')
  ? path.join(__dirname, 'test-ui', '.test-users.json')
  : path.join(__dirname, 'users.json');
if (fs.existsSync(USERS_PATH)) backend._users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
function saveUsers() { fs.writeFileSync(USERS_PATH, JSON.stringify(backend._users || {}, null, 2)); }

// Membership requests (self-service; admin approves). Isolated file in in-memory test mode.
const REQ_PATH = (APP_DB === ':memory:')
  ? path.join(__dirname, 'test-ui', '.test-access-requests.json')
  : path.join(__dirname, 'access-requests.json');
if (fs.existsSync(REQ_PATH)) backend._accessRequests = JSON.parse(fs.readFileSync(REQ_PATH, 'utf8'));
function saveRequests() { fs.writeFileSync(REQ_PATH, JSON.stringify(backend._accessRequests || {}, null, 2)); }

// Opt-in display-name profiles. Isolated file in in-memory test mode.
const PROF_PATH = (APP_DB === ':memory:')
  ? path.join(__dirname, 'test-ui', '.test-profiles.json')
  : path.join(__dirname, 'profiles.json');
if (fs.existsSync(PROF_PATH)) backend._profiles = JSON.parse(fs.readFileSync(PROF_PATH, 'utf8'));
function saveProfiles() { fs.writeFileSync(PROF_PATH, JSON.stringify(backend._profiles || {}, null, 2)); }

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
      case 'bootData': {
        // One-round-trip boot: schema + tableMap + languages + lists + all accessible table data,
        // read in-process (SQLite). Access-filtered server-side (per-table + per-list) by X-User.
        const schemaB = backend.getSchema('local');
        if (!schemaB) return json(res, { schema: null }); // first boot: client saves the default schema
        const tablesB = schemaB.tables || {};
        const tableMapB = backend.initSchema('local', tablesB);
        const languagesB = backend.getAvailableLanguages('local');
        const allowedB = getAllowedTables(); // null => unrestricted (admin / no users)
        let listsB = backend.getLists('local');
        if (allowedB) {
          const f = {};
          Object.keys(listsB).forEach(name => { if (listOwningTables(tablesB, name).some(t => allowedB.indexOf(t) >= 0)) f[name] = listsB[name]; });
          listsB = f;
        }
        const dataB = {};
        Object.keys(tableMapB).forEach(name => {
          if (allowedB && allowedB.indexOf(name) < 0) return; // skip tables the user can't access
          try { dataB[name] = backend.getTableData(tableMapB[name], 'active'); } catch (e) {}
          const def = tablesB[name];
          if (def && def.archivable) { try { dataB[name + '__archive'] = backend.getTableData(tableMapB[name], 'archive'); } catch (e) {} }
        });
        return json(res, { schema: schemaB, tableOrder: Object.keys(tablesB), tableMap: tableMapB, languages: languagesB, lists: listsB, data: dataB });
      }
      case 'resetData': backend.resetData(); backend._users = undefined; saveUsers(); backend._accessRequests = undefined; saveRequests(); backend._profiles = undefined; saveProfiles(); return json(res, { ok: true });
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
      case 'renameLanguage': backend.renameLanguage(body.folderId || 'local', body.code, body.name); return json(res, { ok: true });
      case 'getFileModifiedTime': return json(res, { time: backend.getFileModifiedTime(body.fileId) });
      case 'getLists': {
        const all = backend.getLists('local');
        const allowed = getAllowedTables();          // null => unrestricted (admin/no users)
        if (!allowed) return json(res, all);
        // Per-list access: return only lists owned by a table the user can access.
        const schemaTables = (backend.getSchema('local') || {}).tables || {};
        const filtered = {};
        Object.keys(all).forEach(name => {
          const owners = listOwningTables(schemaTables, name);
          if (owners.some(t => allowed.indexOf(t) >= 0)) filtered[name] = all[name];
        });
        return json(res, filtered);
      }
      case 'saveLists': {
        const allowedW = getAllowedTables();
        if (!allowedW) { backend.saveLists('local', body.lists); return json(res, { ok: true }); }
        // Restricted user: merge their (owned) lists over the existing set — never drop lists they
        // can't see (their submitted map is a filtered subset). Also ignore writes to lists they don't own.
        const schemaTablesW = (backend.getSchema('local') || {}).tables || {};
        const merged = backend.getLists('local');
        const submitted = body.lists || {};
        Object.keys(submitted).forEach(name => {
          if (listOwningTables(schemaTablesW, name).some(t => allowedW.indexOf(t) >= 0)) merged[name] = submitted[name];
        });
        backend.saveLists('local', merged);
        return json(res, { ok: true });
      }
      case 'putListItem': if (!checkTableAccess(body.listName)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } backend.putListItem('local', body.listName, body.value); return json(res, { ok: true });
      case 'moveRow': if (!checkTableAccess(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); } backend.moveRow(body.tableId, body.rowData, body.fromTab, body.toTab); return json(res, { ok: true });
      case 'saveChangesets': backend.saveChangesets('local', body.siteId, body.json); return json(res, { ok: true });
      case 'loadChangesets': return json(res, backend.loadChangesets('local', body.excludeSiteId));
      case 'readFile': return json(res, { data: backend.readFile('local', body.name) });
      case 'writeFile': backend.writeFile('local', body.name, body.data); return json(res, { ok: true });
      case 'deleteFile': backend.deleteFile('local', body.name); return json(res, { ok: true });
      case 'saveConfig': { var allowed = ['firebase-config.json', 'config.json']; var fn = path.basename(body.filename || 'config.json'); if (!allowed.includes(fn)) return json(res, { error: 'filename not allowed' }, 403); fs.writeFileSync(path.join(STATIC_DIR, fn), JSON.stringify(body.data, null, 2)); return json(res, { ok: true }); }
      case 'getUsers': return json(res, backend._users || {});
      case 'getMyAccess': {
        if (!backend._users || !Object.keys(backend._users).length) return json(res, { bootstrap: true });
        const mine = Object.values(backend._users).find(v => v.user === userEmail)
          || backend._users[userEmail] || backend._users[(userEmail || '').toLowerCase()];
        return json(res, mine ? { role: mine.role, tables: mine.tables || 'all' } : { registered: false });
      }
      case 'setUserRole': { if (!backend._users) backend._users = {}; backend._users[body.uid] = { role: body.role, user: body.user || '', tables: body.tables || 'all' }; saveUsers(); return json(res, { ok: true }); }
      case 'removeUser': { if (backend._users) delete backend._users[body.uid]; saveUsers(); return json(res, { ok: true }); }
      case 'requestAccess': {
        if (!backend._accessRequests) backend._accessRequests = {};
        const rk = (userEmail || '').toLowerCase();
        backend._accessRequests[rk] = { email: rk, name: body.name || '', note: body.note || '', ts: Date.now() };
        saveRequests(); return json(res, { ok: true });
      }
      case 'getAccessRequests': return json(res, backend._accessRequests || {});
      case 'removeAccessRequest': { if (backend._accessRequests) delete backend._accessRequests[(body.email || '').toLowerCase()]; saveRequests(); return json(res, { ok: true }); }
      case 'getMyProfile': { const p = (backend._profiles || {})[(userEmail || '').toLowerCase()]; return json(res, p ? { name: p.name || '', shared: !!p.shared } : { name: '', shared: false }); }
      case 'setMyProfile': { if (!backend._profiles) backend._profiles = {}; backend._profiles[(userEmail || '').toLowerCase()] = { name: body.name || '', shared: !!body.shared }; saveProfiles(); return json(res, { ok: true }); }
      case 'getSharedNames': {
        const names = Object.values(backend._profiles || {}).filter(p => p && p.shared && (p.name || '').trim()).map(p => p.name.trim());
        return json(res, Array.from(new Set(names)).sort((a, b) => a.localeCompare(b)));
      }
      case 'setProfileName': {
        if (!backend._profiles) backend._profiles = {};
        const k = (body.email || '').toLowerCase();
        const ex = backend._profiles[k] || {};
        backend._profiles[k] = { name: body.name || '', shared: !!ex.shared };  // merge: preserve opt-in
        saveProfiles(); return json(res, { ok: true });
      }
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
  res.end(fs.readFileSync(filePath));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Local dev server: http://127.0.0.1:' + PORT);
  console.log('Storage backend: ' + (USE_FS ? 'JSON files (dev/data/)' : 'SQLite (dev/local.db)'));
});
