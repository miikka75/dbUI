// server.js — Local dev server with pluggable storage backend
// Usage: node server.js          (SQLite, default)
//        node server.js --fs     (JSON files in dev/data/)
const http = require('http');
const fs = require('fs');
const path = require('path');
// Per-list access model — shared module (also loaded by the browser app + backend-local), no more copies.
const { filterLists } = require('../list-access');
const AccessFeatures = require('../access-features');
const BackendHelpers = require('../backend-helpers');
// User-linked lists (Option C): pure link/projection logic, shared with the browser app.
const LU = require('../list-users');

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

// The registry/requests/profiles live in JSON files beside the database, and they must travel WITH it:
// APP_DB used to isolate only the SQLite file, so a second instance on its own DB still read and (on
// resetData) overwrote the real dev users.json — the registration you were running as. A custom APP_DB
// now derives its own sidecars (chores-demo.db -> chores-demo.users.json). Defaults and the in-memory
// test paths are unchanged.
function sidecarPath(name) {
  if (APP_DB === ':memory:') return path.join(__dirname, 'test-ui', '.test-' + name + '.json');
  if (DB_PATH) return DB_PATH.replace(/\.db$/i, '') + '.' + name + '.json';
  return path.join(__dirname, name + '.json');
}

// Persist users to file. In isolated (in-memory test) mode use a throwaway path so resetData/test
// runs never overwrite the real dev users.json.
const USERS_PATH = sidecarPath('users');
if (fs.existsSync(USERS_PATH)) backend._users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
function saveUsers() { fs.writeFileSync(USERS_PATH, JSON.stringify(backend._users || {}, null, 2)); }

// Membership requests (self-service; admin approves). Isolated file in in-memory test mode.
const REQ_PATH = sidecarPath('access-requests');
if (fs.existsSync(REQ_PATH)) backend._accessRequests = JSON.parse(fs.readFileSync(REQ_PATH, 'utf8'));
function saveRequests() { fs.writeFileSync(REQ_PATH, JSON.stringify(backend._accessRequests || {}, null, 2)); }

// Opt-in display-name profiles. Isolated file in in-memory test mode.
const PROF_PATH = sidecarPath('profiles');
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

// --- Identity + read scope, hoisted out of the request handler ---------------------------------------
// These answer "who is this user" and "what may they SEE" from the registry alone. They live out here
// because the SSE broadcaster below has no request in hand — only a long-lived subscriber and the email
// it connected with — and asking the same functions the routes ask is the only way the live stream and
// getTableData cannot drift into two different answers. The in-request wrappers bind them to X-User.
function userRecordFor(email) {
  if (!backend._users) return undefined;
  return Object.values(backend._users).find(v => v.user === email)
    || backend._users[email] || backend._users[(email || '').toLowerCase()];
}
function allowedTablesFor(email) {
  if (!backend._users) return null;            // no users = no restrictions
  const u = userRecordFor(email);
  if (!u) return [];                           // unknown user = no access
  if (u.role === 'admin' || u.tables === 'all') return null;  // null = unrestricted
  return AccessFeatures.readableTables(u.tables) || [];
}
function ownerColNameOf(base) {
  const cols = (((backend.getSchema('local') || {}).tables || {})[base] || {}).columns;
  if (!cols) return null;
  if (Array.isArray(cols)) { const o = cols.find(c => c && c.type === 'owner'); return o ? o.name : null; }
  for (const n in cols) { const d = cols[n]; if (d && typeof d === 'object' && d.type === 'owner') return n; }
  return null;
}

// --- Live sync: an SSE stream of row changes ---------------------------------------------------------
// The production backends push through Firestore onSnapshot / Supabase realtime; the dev server's
// equivalent is this. Every mutating route calls broadcast(), which fans the change out to the
// subscribers ALLOWED TO SEE IT — a live stream that ignored the access model would be a read channel
// around it, which is precisely the mistake this file exists to not make (see the DEV-ONLY note below:
// the identity is trusted, not authenticated, but the SHAPE of the gate still has to match production).
const sseClients = new Set();   // { res, email }

// Would this subscriber have received this row from getTableData? Mirrors, in order: the grant check,
// the _pages/_assets registered-user carve-out, and the self-service slice (own rows + public roster).
function canSeeRow(email, store, value) {
  const base = store ? store.split('__')[0] : '';
  const allowed = allowedTablesFor(email);
  if (!allowed) return true;                                        // admin / unrestricted
  if (allowed.indexOf(base) >= 0) return true;                      // granted
  if (base === '_pages' || base === '_assets') return !!userRecordFor(email);
  const oc = ownerColNameOf(base);
  if (!oc || !value) return false;                                  // fail closed
  return String(value[oc] || '').toLowerCase() === String(email || '').toLowerCase()
    || value.rosterPublic === true;
}

// `value` is the row after the write, or null for a delete. Deletes pass the row as it was JUST BEFORE
// removal (the routes read it first) — without it there is nothing left to evaluate ownership against,
// and a restricted member would stop seeing deletions of rows they could see perfectly well.
function broadcast(store, key, value, priorValue) {
  if (!sseClients.size || !store || !key) return;
  const payload = JSON.stringify({ store, key, value: value === undefined ? null : value });
  for (const c of Array.from(sseClients)) {
    if (!canSeeRow(c.email, store, value || priorValue || null)) continue;
    try { c.res.write('data: ' + payload + '\n\n'); }
    catch (e) { sseClients.delete(c); }
  }
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

  // Live-sync stream. GET, not POST, and identity arrives as ?user= rather than X-User: EventSource
  // cannot set headers. Same trusted-not-authenticated model as every other route here (loopback bind),
  // and the same source the dev client already reads its identity from (dev/dev-client.js).
  if (url.pathname === '/api/events') {
    const h = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    };
    if (allowOrigin) h['Access-Control-Allow-Origin'] = allowOrigin;
    res.writeHead(200, h);
    res.write('retry: 2000\n\n');                 // EventSource reconnects on its own; pace it
    const client = { res, email: url.searchParams.get('user') || 'local@dev' };
    sseClients.add(client);
    // Comment frames keep the connection from being reaped by an idle timeout; they are ignored by
    // EventSource. unref() so a live subscriber can't hold the process open (the test suite starts and
    // stops this server in-process).
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    if (ping.unref) ping.unref();
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
    return;
  }

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
    // Bound to this request's identity; the implementations are hoisted to module scope so the SSE
    // broadcaster asks the same questions (see userRecordFor / allowedTablesFor above).
    function userRecord() { return userRecordFor(userEmail); }
    // Tables the caller may SEE. Mirrors firestore.rules hasTableAccess: a grant map { t:'r'|'rw' } is
    // read-visible on every key, exactly as the rules' `x in <map>` membership test is.
    function getAllowedTables() { return allowedTablesFor(userEmail); }
    // Tables the caller may WRITE — the 'rw' subset. Mirrors hasTableWrite / app_has_table_write.
    function getWritableTables() {
      if (!backend._users) return null;
      const u = userRecord();
      if (!u) return [];
      if (u.role === 'admin' || u.tables === 'all') return null;
      return AccessFeatures.writableTables(u.tables) || [];
    }
    // Admin for the profile-visibility rule (can see unshared users). Bootstrap (no users) counts as admin.
    // Note this is stricter than getAllowedTables()===null, which also passes tables:'all' editors.
    function isAdminReq() {
      if (!backend._users || !Object.keys(backend._users).length) return true;
      const u = userRecord();
      return !!(u && u.role === 'admin');
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
    // Stored image assets (_assets) mirror firestore.rules' _assets__active block: any REGISTERED user
    // reads (decoration; the referencing row stays gated by its own access), admins/editors write. Needs
    // the same carve-out _pages does — hasTableAccess('_assets'), which no grant ever satisfies, would
    // deny every read. Read/write reuse the page predicates: identical role tests on both sides.
    function assetsTable(tableId) { return (tableId ? tableId.split('__')[0] : '') === '_assets'; }
    function checkTableAccess(tableId) {
      const allowed = getAllowedTables();
      if (!allowed) return true;
      // tableId may be "tasks__active" -> extract base name
      const base = tableId ? tableId.split('__')[0] : '';
      return allowed.indexOf(base) >= 0;
    }
    // Write gate: the 'rw' subset only, so a read-only grant can be seen and not changed.
    function checkTableWrite(tableId) {
      const writable = getWritableTables();
      if (!writable) return true;
      const base = tableId ? tableId.split('__')[0] : '';
      return writable.indexOf(base) >= 0;
    }
    // Which columns an owner-scoped write may touch (mirrors firestore.rules ownerCreateOk/ownerUpdateOk).
    // null = the table sets no bound. Read straight from the schema here; the rules layers read the
    // _meta mirror because they cannot see the schema.
    const OWNER_SYSTEM = ['id', 'owner', 'created_at', 'updated_at', 'rosterPublic'];
    // Same comparison the rules make: diff the incoming row against what it is allowed to differ from —
    // the existing row on an update, the gated columns' create-time defaults on a create — and require
    // every field that actually changes to be listed (or system bookkeeping).
    // The caller's own value for a list, resolved exactly as the client's `@me` does: the curated value
    // linked to their account on a userlink list, else their profile display name.
    function myIdentityFor(listName) {
      if (listName) {
        const links = (backend.getListUsers ? backend.getListUsers('local') : {})[listName] || {};
        for (const value of Object.keys(links)) if (_mine(links[value])) return value;
        return '';
      }
      const p = (backend._profiles || {})[(userEmail || '').toLowerCase()];
      return (p && p.name) || '';
    }
    function ownerFieldsOk(tableId, incoming, existing) {
      const base = tableId ? tableId.split('__')[0] : '';
      const bounds = BackendHelpers.ownerWritableOf(backend.getSchema('local') || {})[base];
      if (!bounds) return true;
      // An identity column (`defaultFrom: "@me"`, owner-writable) may only ever carry the CALLER'S own
      // identity. It has to be owner-writable for the owner to create the row at all, which otherwise
      // left them free to log the work as somebody else.
      if (!BackendHelpers.ownerIdentityOk(bounds, incoming, myIdentityFor(bounds.identityList))) return false;
      // `ownerWritableWhile`: once the STORED row leaves its editable states the owner branch stops
      // reaching it at all — no field of it, not even a listed one. Checked against `existing`, so the
      // owner cannot escape the gate by sending a compliant new state in the same write.
      if (!BackendHelpers.ownerRowInState(bounds, existing)) return false;
      const baseline = existing || bounds.locked;
      const keys = new Set([...Object.keys(incoming || {}), ...Object.keys(baseline || {})]);
      for (const k of keys) {
        if (bounds.cols.includes(k) || OWNER_SYSTEM.includes(k)) continue;
        const a = incoming && incoming[k], b = baseline && baseline[k];
        if (String(a === undefined ? '' : a) !== String(b === undefined ? '' : b)) return false;
      }
      return true;
    }
    // Self-service (mirrors firestore.rules on the unauthenticated dev backend so the local demo behaves
    // like Firebase): a member with no WRITE grant on a table that declares an `owner` column may still
    // create/update/delete their own owned rows. Keyed on the writable set, not the readable one, so a
    // read-only grant on an owner table gives the useful combination: see every row, write only my own.
    // Returns that table's owner column name, or null if the caller may write it anyway / it has none.
    // A table's `owner` column name, whoever is asking (both stored column shapes). Split out of
    // selfServiceOwnerCol so the boot path can ask the plain question -- "does this table have an owner
    // column" -- without the writable-set answer folded in.
    function ownerColOf(tableId) {
      const base = tableId ? tableId.split('__')[0] : '';
      const cols = (((backend.getSchema('local') || {}).tables || {})[base] || {}).columns;
      if (!cols) return null;
      if (Array.isArray(cols)) { const o = cols.find(c => c && c.type === 'owner'); return o ? o.name : null; }
      for (const n in cols) { const d = cols[n]; if (d && typeof d === 'object' && d.type === 'owner') return n; }
      return null;
    }
    function selfServiceOwnerCol(tableId) {
      const base = tableId ? tableId.split('__')[0] : '';
      const allowed = getWritableTables();
      if (!allowed || allowed.indexOf(base) >= 0) return null;      // unrestricted or writable -> normal path
      return ownerColOf(tableId);
    }
    const _mine = (v) => String(v == null ? '' : v).toLowerCase() === String(userEmail || '').toLowerCase();
    const _rowById = (tableId, tab, id) => ((backend.getTableData(tableId, tab) || {}).rows || []).find(r => r.id === id);
    const _store = (tableId, tab) => BackendHelpers.storeName((tableId || '').split('__')[0], tab || 'active');
    // Answer the caller AND tell the live subscribers. Broadcasts the STORED row, re-read after the
    // write, never the request payload: a partial putRow's patch is not a row, and a subscriber applies
    // what it receives as that row's new state — handing it the patch would be fine for the columns it
    // names and silently wrong about nothing else, but re-reading costs a dev-server map lookup and
    // removes the question entirely.
    function putOk(b) {
      const id = b.data && b.data.id;
      if (id) broadcast(_store(b.tableId, b.tab), id, _rowById(b.tableId, b.tab, id) || b.data);
      return json(res, { ok: true });
    }
    // The self-service read slice: my own owned rows plus the ones flagged public. Mirrors the two
    // rules-provable Firestore queries (_scopedRead) and the Supabase read predicate, and is what the
    // getTableData route already returns for an ungranted owner table -- boot has to say the same thing.
    function scopeToOwnRows(tableId, data) {
      const oc = ownerColOf(tableId);
      if (!oc) return { headers: (data && data.headers) || [], rows: [] };   // no owner column -> nothing readable
      const rows = ((data && data.rows) || []).filter(r => _mine(r[oc]) || r.rosterPublic === true);
      return Object.assign({}, data, { rows });
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
        // Granted tables PLUS the owner-column (self-service) ones — the shared predicate, so this boot
        // set matches Firebase's and Supabase's. A self-service table the caller has no READ grant on
        // comes back as their own rows + the public roster, exactly as the getTableData route scopes it;
        // without that slice, boot would hand a grantless member the whole table.
        const namesB = BackendHelpers.bootTableNames(schemaB, allowedB);
        const scopedB = (name) => !!(allowedB && allowedB.indexOf(name) < 0);
        namesB.forEach(name => {
          try {
            const d = backend.getTableData(tableMapB[name], 'active');
            dataB[name] = scopedB(name) ? scopeToOwnRows(name, d) : d;
          } catch (e) {}
          const def = tablesB[name];
          if (def && def.archivable) {
            try {
              const a = backend.getTableData(tableMapB[name], 'archive');
              dataB[name + '__archive'] = scopedB(name) ? scopeToOwnRows(name, a) : a;
            } catch (e) {}
          }
        });
        return json(res, { schema: schemaB, tableOrder: Object.keys(tablesB), tableMap: tableMapB, languages: languagesB, lists: listsB, data: dataB });
      }
      case 'resetData': backend.resetData(); backend._users = undefined; saveUsers(); backend._accessRequests = undefined; saveRequests(); backend._profiles = undefined; saveProfiles(); if (backend.saveListUsers) backend.saveListUsers('local', {}); return json(res, { ok: true });
      case 'getAvailableTables': return json(res, backend.getAvailableTables('local'));
      case 'serverInfo': return json(res, { storage: USE_FS ? 'fs' : 'sqlite' });
      case 'getAvailableLanguages': return json(res, backend.getAvailableLanguages('local'));
      case 'getTableData': {
        if (pagesTable(body.tableId)) {
          if (canReadPages()) return json(res, filterPages(backend.getTableData(body.tableId, body.tab) || { headers: [], rows: [] }));
          return json(res, { error: 'Access denied' }, 403);
        }
        if (assetsTable(body.tableId)) {
          if (canReadPages()) return json(res, backend.getTableData(body.tableId, body.tab) || { headers: [], rows: [] });
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
          backend.putRow(body.tableId, body.data, body.tab); return putOk(body);
        }
        if (assetsTable(body.tableId)) {
          if (!canWritePages()) return json(res, { error: 'Access denied' }, 403);
          // Same 900000-char cap the two production rule layers enforce, so a payload that would be
          // rejected in production doesn't quietly succeed in dev (where the cap is the only bound).
          if (typeof (body.data && body.data.src) !== 'string' || body.data.src.length > 900000) {
            return json(res, { error: 'Asset too large' }, 400);
          }
          backend.putRow(body.tableId, body.data, body.tab); return putOk(body);
        }
        if (checkTableWrite(body.tableId)) { backend.putRow(body.tableId, body.data, body.tab); return putOk(body); }
        const oc = selfServiceOwnerCol(body.tableId);
        const existing = oc ? _rowById(body.tableId, body.tab, body.data && body.data.id) : null;
        // Gate the MERGED row, not the submitted payload. putRow merges (the pinned conformance
        // contract), so a cell edit now sends only { id, <col>, updated_at } — the owner column it must
        // be judged on lives on the stored row, not in the patch. Judging the patch alone would 403
        // every partial write by a self-service member while the production layers, which see
        // `request.resource.data` AFTER the merge, allow it. This keeps the three gates saying the same
        // thing; it is parity, not a loosening (a create still has no existing row to inherit from, so
        // it must still carry the owner itself).
        const merged = Object.assign({}, existing || {}, body.data || {});
        // Must stamp myself as owner AND (on update) not overwrite a row owned by someone else.
        if (!oc || !_mine(merged[oc]) || (existing && !_mine(existing[oc]))
            || !ownerFieldsOk(body.tableId, merged, existing)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        backend.putRow(body.tableId, body.data, body.tab); return putOk(body);
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
        // The row is read BEFORE the delete in every branch — broadcast needs it to decide who was
        // allowed to see it, and after the delete there is nothing left to ask.
        const prior = _rowById(body.tableId, body.tab, body.id);
        const delOk = () => {
          const deleted = backend.deleteRow(body.tableId, body.id, body.tab);
          broadcast(_store(body.tableId, body.tab), body.id, null, prior);
          return json(res, { deleted });
        };
        if (pagesTable(body.tableId)) {
          if (!canWritePages()) return json(res, { error: 'Access denied' }, 403);
          return delOk();
        }
        if (checkTableWrite(body.tableId)) return delOk();
        const oc = selfServiceOwnerCol(body.tableId);
        const existing = oc ? prior : null;   // may delete only my own owned row
        // ...and only while it is still in an owner-writable state: an approved row is out of my hands,
        // so deleting it must be refused for exactly the reason editing it is.
        const dBounds = BackendHelpers.ownerWritableOf(backend.getSchema('local') || {})[String(body.tableId || '').split('__')[0]];
        if (!oc || !existing || !_mine(existing[oc]) || !BackendHelpers.ownerRowInState(dBounds, existing)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        return delOk();
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
        if (isAdminReq()) { backend.saveLists('local', body.lists); return json(res, { ok: true }); }
        // A non-admin may write ONLY the lists the schema opens (`userWritableLists`) — editing a list
        // is editing shared vocabulary, so it is admin-only by default. A table grant is deliberately
        // NOT part of the question: a list belongs to every table whose columns reference it, so keying
        // on the grant handed one rw table every list its columns touched. See userWritableListsOf.
        // Merge over the existing set rather than replacing it: their submitted map is a filtered subset,
        // so a plain save would drop every list they cannot see.
        const openW = BackendHelpers.userWritableListsOf(backend.getSchema('local') || {}).lists;
        const merged = backend.getLists('local');
        const submitted = body.lists || {};
        Object.keys(submitted).forEach(name => { if (openW.includes(name)) merged[name] = submitted[name]; });
        backend.saveLists('local', merged);
        return json(res, { ok: true });
      }
      case 'putListItem': {
        // Per-list access: a list is writable if ANY of its owning tables is granted (same ownership
        // model as saveLists above) — the list NAME is not a table id, so checkTableAccess was wrong here.
        // Admin-only unless the schema opens this list to everyone (userWritableLists).
        const openLi = BackendHelpers.userWritableListsOf(backend.getSchema('local') || {}).lists;
        if (!isAdminReq() && !openLi.includes(body.listName)) {
          return json(res, { error: 'Access denied' }, 403);
        }
        backend.putListItem('local', body.listName, body.value); return json(res, { ok: true });
      }
      // --- User-linked lists (Option C) ---
      case 'getListAvatars': {
        // Viewer-safe projection: { listName: { value: pictureDataUrl } }. Non-admins get only SHARED
        // linked users; no email is ever included. Safe for everyone to read.
        const links = backend.getListUsers ? backend.getListUsers('local') : {};
        return json(res, LU.buildAvatarProjection(links, backend._profiles || {}, isAdminReq()));
      }
      case 'getListUserLinks': {
        // Admin-only: the raw { value: email } links, for the Lookup editor's picker.
        if (!isAdminReq()) return json(res, { error: 'Access denied' }, 403);
        return json(res, backend.getListUsers ? backend.getListUsers('local') : {});
      }
      case 'getMyListValues': {
        // Self-scoped: only the links naming the caller. Not admin-gated — it is their own identity, and
        // it is what lets `@me` resolve to a curated value on a `userlink` list.
        const all = backend.getListUsers ? backend.getListUsers('local') : {};
        const mine = {};
        Object.keys(all || {}).forEach(list => {
          const links = all[list] || {};
          Object.keys(links).forEach(val => { if (_mine(links[val]) && !(list in mine)) mine[list] = val; });
        });
        return json(res, mine);
      }
      case 'setListUser': {
        // Admin-only: link (email set) or unlink (email empty) a list value to a registered user.
        if (!isAdminReq()) return json(res, { error: 'Access denied' }, 403);
        const cur = backend.getListUsers ? backend.getListUsers('local') : {};
        backend.saveListUsers('local', LU.setLink(cur, body.listName, body.value, body.email || ''));
        return json(res, { ok: true });
      }
      case 'moveRow': {
        if (!checkTableWrite(body.tableId)) { res.writeHead(403); return res.end(JSON.stringify({ error: 'Access denied' })); }
        const moved = body.rowData || {};
        const priorMove = _rowById(body.tableId, body.fromTab, moved.id);
        backend.moveRow(body.tableId, moved, body.fromTab, body.toTab);
        // An archive/unarchive is a delete from one partition and a put into the other — two stores, so
        // two events. A client watching only the active partition (the usual case) sees the row leave.
        if (moved.id) {
          broadcast(_store(body.tableId, body.fromTab), moved.id, null, priorMove);
          broadcast(_store(body.tableId, body.toTab), moved.id, _rowById(body.tableId, body.toTab, moved.id) || moved);
        }
        return json(res, { ok: true });
      }
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
      case 'setUserRole': { if (!backend._users) backend._users = {}; backend._users[body.uid] = BackendHelpers.userGrantDoc(body.uid, body.role, body.user || '', body.tables); saveUsers(); return json(res, { ok: true }); }
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
  // Print the database ACTUALLY in use, not the default: with APP_DB set this line was still claiming
  // dev/local.db, which is the one thing you check when you are running an isolated instance on purpose.
  console.log('Storage backend: ' + (USE_FS
    ? 'JSON files (dev/data/)'
    : 'SQLite (' + (APP_DB === ':memory:' ? ':memory:' : path.relative(STATIC_DIR, DB_PATH || path.join(__dirname, 'local.db')).replace(/\\/g, '/')) + ')'));
});
