// server.js — Local dev server with pluggable storage backend
// Usage: node server.js          (SQLite, default)
//        node server.js --fs     (JSON files in dev/data/)
const http = require('http');
const fs = require('fs');
const path = require('path');
// Per-list access model — shared module (also loaded by the browser app + backend-local), no more copies.
const { listOwningTables, filterLists } = require('../list-access');

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

// CSP=1 -> compute the enforced policy once at startup (inline-script hashes come from the real
// index.html, so an edited inline block is immediately reflected here — and guarded by csp.test.js).
const CSP_POLICY = process.env.CSP === '1' ? (() => {
  const crypto = require('crypto');
  const Csp = require('../csp');
  const indexSrc = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  const hashes = Csp.inlineScriptHashes(indexSrc, (s) => crypto.createHash('sha256').update(s).digest('base64'));
  return Csp.buildPolicy({ scriptHashes: hashes });
})() : null;

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

function json(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json' });
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

    // DEV-ONLY access scoping. Identity comes from the client-supplied X-User header — it is TRUSTED,
    // NOT AUTHENTICATED (any client can claim any email). This is acceptable only because the server
    // binds to 127.0.0.1 (see server.listen below), so it is unreachable off the local machine. This is
    // NOT the production access model — that is Firestore security rules (firestore.rules), which key on
    // the real, unspoofable request.auth.token.email. Never expose this server to a network.
    const userEmail = req.headers['x-user'] || 'local@dev';
    // The one lookup for "who is this user" — previously getAllowedTables and getMyAccess each rolled
    // their own with different fallbacks (getMyAccess also tried key lookups), a latent access split.
    function userRecord() {
      if (!backend._users) return undefined;
      return Object.values(backend._users).find(v => v.user === userEmail)
        || backend._users[userEmail] || backend._users[(userEmail || '').toLowerCase()];
    }
    function getAllowedTables() {
      if (!backend._users) return null; // no users = no restrictions
      const u = userRecord();
      if (!u) return []; // unknown user = no access
      if (u.role === 'admin' || u.tables === 'all') return null; // null = unrestricted
      return u.tables || [];
    }
    // Doc-view bodies (_pages) mirror firestore.rules' dedicated block: any REGISTERED user reads
    // (content pages; each embedded table's rows stay gated by their own access), admins/editors write.
    // Without this, hasTableAccess('_pages') — which no grant ever satisfies — denied restricted reads.
    function pagesTable(tableId) { return (tableId ? tableId.split('__')[0] : '') === '_pages'; }
    function canReadPages() { return !backend._users || !!userRecord(); }
    // Per-page access parity with firestore.rules: a restricted caller (allowed != null) may read only
    // pages whose schema view has no `access`, or whose `access` intersects their grants. Computed from
    // the schema directly (the dev server reads it), so no mirror doc is needed here. Returns the
    // filtered { headers, rows } for a whole-_pages read.
    function filterPages(data) {
      const allowed = getAllowedTables();
      if (!allowed) return data;                          // admin / unrestricted -> all pages
      const views = ((backend.getSchema('local') || {}).views) || [];
      const acc = {};
      (function walk(arr) { (arr || []).forEach(v => {
        if (v && v.name && typeof v.markdown === 'string' && Array.isArray(v.access) && v.access.length) acc[v.name] = v.access;
        if (v && v.views) walk(v.views);
      }); })(views);
      const rows = (data.rows || []).filter(r => !acc[r.id] || acc[r.id].some(t => allowed.indexOf(t) >= 0));
      return Object.assign({}, data, { rows });
    }
    function canWritePages() { const u = userRecord(); return !backend._users || !!(u && (u.role === 'admin' || u.role === 'editor')); }
    function checkTableAccess(tableId) {
      const allowed = getAllowedTables();
      if (!allowed) return true;
      // tableId may be "tasks__active" -> extract base name
      const base = tableId ? tableId.split('__')[0] : '';
      return allowed.indexOf(base) >= 0;
    }
    // Self-service (mirrors firestore.rules on the unauthenticated dev backend so the local demo behaves
    // like Firebase): a member with NO grant on a table that declares an `owner` column may still read
    // their own rows (+ rosterPublic) and create/update/delete their own owned rows. Returns that table's
    // owner column name, or null if the caller is granted/unrestricted or the table has no owner column.
    function selfServiceOwnerCol(tableId) {
      const base = tableId ? tableId.split('__')[0] : '';
      const allowed = getAllowedTables();
      if (!allowed || allowed.indexOf(base) >= 0) return null;      // unrestricted or granted -> normal path
      const cols = (((backend.getSchema('local') || {}).tables || {})[base] || {}).columns;
      if (!cols) return null;
      if (Array.isArray(cols)) { const o = cols.find(c => c && c.type === 'owner'); return o ? o.name : null; }
      for (const n in cols) { const d = cols[n]; if (d && typeof d === 'object' && d.type === 'owner') return n; }
      return null;
    }
    const _mine = (v) => String(v == null ? '' : v).toLowerCase() === String(userEmail || '').toLowerCase();
    const _rowById = (tableId, tab, id) => ((backend.getTableData(tableId, tab) || {}).rows || []).find(r => r.id === id);

    try {
    switch (route) {
      case 'getSchema': return json(res, backend.getSchema('local'));
      case 'saveSchema': backend.saveSchema('local', body.schema); return json(res, { ok: true });
      case 'validateFolder': return json(res, backend.validateFolder(body.id || 'local'));
      case 'getFolderConfig': return json(res, backend.getFolderConfig('local'));
      case 'setFolderConfig': backend.setFolderConfig('local', body.config); return json(res, { ok: true });
      case 'initSchema': if (!body.schema) return json(res, {}); return json(res, backend.initSchema('local', body.schema));
      case 'bootData': {
        // One-round-trip boot: schema + tableMap + languages + lists + all accessible table data, read
        // in-process (SQLite). Scoped per-table + per-list by X-User — a DEV convenience (trusted header,
        // localhost-only), not authenticated access control; see getAllowedTables above.
        const schemaB = backend.getSchema('local');
        if (!schemaB) return json(res, { schema: null }); // first boot: client saves the default schema
        const tablesB = schemaB.tables || {};
        const tableMapB = backend.initSchema('local', tablesB);
        const languagesB = backend.getAvailableLanguages('local');
        const allowedB = getAllowedTables(); // null => unrestricted (admin / no users)
        const listsB = filterLists(backend.getLists('local'), tablesB, allowedB);
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
      case 'getTableData': {
        if (pagesTable(body.tableId)) {
          if (canReadPages()) return json(res, filterPages(backend.getTableData(body.tableId, body.tab) || { headers: [], rows: [] }));
          return json(res, { error: 'Access denied' }, 403);
        }
        if (checkTableAccess(body.tableId)) return json(res, backend.getTableData(body.tableId, body.tab));
        const oc = selfServiceOwnerCol(body.tableId);                 // self-service: own rows + public roster only
        if (!oc) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        const data = backend.getTableData(body.tableId, body.tab) || { headers: [], rows: [] };
        return json(res, Object.assign({}, data, { rows: (data.rows || []).filter(r => _mine(r[oc]) || r.rosterPublic === true) }));
      }
      case 'putRow': {
        if (pagesTable(body.tableId)) {
          if (!canWritePages()) return json(res, { error: 'Access denied' }, 403);
          backend.putRow(body.tableId, body.data, body.tab); return json(res, { ok: true });
        }
        if (checkTableAccess(body.tableId)) { backend.putRow(body.tableId, body.data, body.tab); return json(res, { ok: true }); }
        const oc = selfServiceOwnerCol(body.tableId);
        const existing = oc ? _rowById(body.tableId, body.tab, body.data && body.data.id) : null;
        // Must stamp myself as owner AND (on update) not overwrite a row owned by someone else.
        if (!oc || !_mine(body.data && body.data[oc]) || (existing && !_mine(existing[oc]))) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        backend.putRow(body.tableId, body.data, body.tab); return json(res, { ok: true });
      }
      case 'uploadFile': {
        // Dev-only file store for the image column (the local counterpart of Firebase Storage): write the
        // base64 body to dev/uploads/ and return a same-origin URL. The row stores only that URL, not bytes.
        const uName = String(body.name || 'file').replace(/[^\w.\-]+/g, '_');
        const b64 = String(body.base64 || '');
        if (!b64) { res.writeHead(400); return res.end(JSON.stringify({ error: 'no file data' })); }
        const upDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
        const fname = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + uName;
        fs.writeFileSync(path.join(upDir, fname), Buffer.from(b64, 'base64'));
        const host = req.headers.host || (HOST + ':' + PORT);
        return json(res, { url: 'http://' + host + '/uploads/' + fname });
      }
      case 'deleteRow': {
        if (pagesTable(body.tableId)) {
          if (!canWritePages()) return json(res, { error: 'Access denied' }, 403);
          return json(res, { deleted: backend.deleteRow(body.tableId, body.id, body.tab) });
        }
        if (checkTableAccess(body.tableId)) return json(res, { deleted: backend.deleteRow(body.tableId, body.id, body.tab) });
        const oc = selfServiceOwnerCol(body.tableId);
        const existing = oc ? _rowById(body.tableId, body.tab, body.id) : null;   // may delete only my own owned row
        if (!oc || !existing || !_mine(existing[oc])) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        return json(res, { deleted: backend.deleteRow(body.tableId, body.id, body.tab) });
      }
      case 'getTranslations': return json(res, backend.getTranslations(body.folderId || 'local', body.langCode));
      case 'updateTranslations': backend.updateTranslations(body.folderId || 'local', body.langCode, body.updates); return json(res, { ok: true });
      case 'createLanguage': return json(res, { id: backend.createLanguage(body.folderId || 'local', body.code, body.name, body.keys) });
      case 'deleteLanguage': backend.deleteLanguage(body.folderId || 'local', body.code); return json(res, { ok: true });
      case 'renameLanguage': backend.renameLanguage(body.folderId || 'local', body.code, body.name); return json(res, { ok: true });
      case 'getFileModifiedTime': return json(res, { time: backend.getFileModifiedTime(body.fileId) });
      case 'getLists': {
        // Per-list access: return only lists owned by a table the user can access (admin: all).
        const allowed = getAllowedTables();          // null => unrestricted (admin/no users)
        const schemaTables = (backend.getSchema('local') || {}).tables || {};
        return json(res, filterLists(backend.getLists('local'), schemaTables, allowed));
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
      case 'putListItem': {
        // Per-list access: a list is writable if ANY of its owning tables is granted (same ownership
        // model as saveLists above) — the list NAME is not a table id, so checkTableAccess was wrong here.
        const allowedLi = getAllowedTables();
        const schemaTablesLi = (backend.getSchema('local') || {}).tables || {};
        if (allowedLi && !listOwningTables(schemaTablesLi, body.listName).some(t => allowedLi.indexOf(t) >= 0)) {
          return json(res, { error: 'Access denied' }, 403);
        }
        backend.putListItem('local', body.listName, body.value); return json(res, { ok: true });
      }
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
        const mine = userRecord();
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
      case 'getMyProfile': { const p = (backend._profiles || {})[(userEmail || '').toLowerCase()]; return json(res, p ? { name: p.name || '', shared: !!p.shared, picture: p.picture || '' } : { name: '', shared: false, picture: '' }); }
      case 'setMyProfile': { if (!backend._profiles) backend._profiles = {}; backend._profiles[(userEmail || '').toLowerCase()] = { name: body.name || '', shared: !!body.shared, picture: body.picture || '' }; saveProfiles(); return json(res, { ok: true }); }
      case 'getSharedNames': {
        const names = Object.values(backend._profiles || {}).filter(p => p && p.shared && (p.name || '').trim()).map(p => p.name.trim());
        return json(res, Array.from(new Set(names)).sort((a, b) => a.localeCompare(b)));
      }
      case 'getSharedProfiles': {
        const out = {};
        for (const [email, p] of Object.entries(backend._profiles || {})) { if (p && p.shared) out[email] = { name: p.name || '', picture: p.picture || '' }; }
        return json(res, out);
      }
      case 'setProfileName': {
        if (!backend._profiles) backend._profiles = {};
        const k = (body.email || '').toLowerCase();
        const ex = backend._profiles[k] || {};
        backend._profiles[k] = { name: body.name || '', shared: !!ex.shared, picture: ex.picture || '' };  // merge: preserve opt-in + avatar
        saveProfiles(); return json(res, { ok: true });
      }
      case 'getProfiles': return json(res, backend._profiles || {});
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const hdrs = { 'Content-Type': types[ext] || 'text/plain' };
  // CSP=1: serve HTML with the app's Content-Security-Policy ENFORCED (see /csp.js). The Playwright
  // suite runs with this on (playwright.config.js webServer env), so every E2E run proves the policy
  // doesn't break the app — the gate before production flips its Report-Only header to enforcing.
  if (CSP_POLICY && hdrs['Content-Type'] === 'text/html') hdrs['Content-Security-Policy'] = CSP_POLICY;
  res.writeHead(200, hdrs);
  res.end(fs.readFileSync(filePath));
});

// The loopback bind is load-bearing security: identity is a trusted (unauthenticated) X-User header, so
// this server must never be reachable off the local machine. HOST is overridable for special dev setups,
// but a non-loopback bind requires ALLOW_INSECURE_HOST=1 to acknowledge it exposes an unauthenticated server.
const HOST = process.env.HOST || '127.0.0.1';
const _loopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
if (!_loopback && process.env.ALLOW_INSECURE_HOST !== '1') {
  console.error('Refusing to bind ' + HOST + ': this dev server has NO authentication (it trusts the X-User header)');
  console.error('and is safe only on loopback. To bind a non-loopback host anyway, set ALLOW_INSECURE_HOST=1.');
  process.exit(1);
}
server.listen(PORT, HOST, () => {
  console.log('Local dev server: http://' + HOST + ':' + PORT + (_loopback ? '' : '  [INSECURE: unauthenticated, exposed off-host]'));
  console.log('Storage backend: ' + (USE_FS ? 'JSON files (dev/data/)' : 'SQLite (dev/local.db)'));
});
