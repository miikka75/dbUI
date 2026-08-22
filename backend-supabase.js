// backend-supabase.js — Supabase (Postgres) backend with Google Auth.
// A drop-in sibling of backend-firebase.js (classic script, same globals: backend / backend_users /
// triggerOAuth). Firestore's document model is reproduced on a single Postgres key-value table (`kv`,
// one row per doc), so each per-doc Firestore rule becomes a per-row RLS policy (see supabase-schema.sql).
// Requires: storage-supabase.js loaded before this, and the supabase-js UMD global window.supabase.
// _u(): resolve same-origin paths against the app's own directory (see appUrl in index.html) so the
// app works when hosted under a subpath, e.g. a GitHub Pages project site at /<repo>/.
function _u(p) { return (typeof window !== 'undefined' && window.appUrl) ? window.appUrl(p) : p; }

var _sb = null;                 // supabase client
var _sbUser = null;             // current auth user ({ email, ... }) or null
var _sbAuthInited = false;      // guard: boot the app once, not on every auth event
var StorageSupabase = null;     // built from _sb in _startSupabase (mirrors StorageFirestore)
var SUPABASE_BUCKET = 'uploads';

function _storeName(table, tab) { return BackendHelpers.storeName(table, tab); }

// --- Realtime (see backend.subscribeTable) -----------------------------------------------------------
var _sbChannel = null;          // the ONE postgres_changes channel over `kv`
var _sbHandlers = {};           // store name -> [onChange, ...]

// Fan a kv row change out to whoever subscribed to that store. `value` is the whole row document, which
// is exactly the shape getTableData returns, so subscribers need no second read.
function _sbDispatch(payload) {
  var rec = payload && (payload.new && payload.new.store ? payload.new : payload.old);
  if (!rec || !rec.store || !rec.key) return;
  var handlers = _sbHandlers[rec.store];
  if (!handlers || !handlers.length) return;
  var isDelete = payload.eventType === 'DELETE';
  var change = { type: isDelete ? 'delete' : 'put', id: rec.key, row: isDelete ? null : (rec.value || null) };
  if (!isDelete && !change.row) return;
  handlers.slice().forEach(function(fn) { try { fn(change); } catch (e) {} });
}

function _ensureRealtime() {
  if (_sbChannel || !_sb) return;
  _sbChannel = _sb.channel('kv-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv' }, _sbDispatch)
    .subscribe();
}

// The signed-in user's lowercased email ('' when signed out) — auth first, app state as fallback.
function _myEmail() {
  return (((_sbUser && _sbUser.email)
    || (typeof appInstance !== 'undefined' && appInstance && appInstance.currentUserEmail)) || '').toLowerCase();
}

// Bootstrap detection via a SECURITY DEFINER RPC: an unregistered user can't read /_meta/users (RLS), and
// — unlike Firestore, where a denied read THROWS and is distinguishable — a forbidden Supabase SELECT just
// returns zero rows. This RPC bypasses RLS to answer "are there zero users?" authoritatively, so we never
// mistake a permission denial for first-boot. Fail-closed (false) on error.
function _noUsers() {
  return _sb.rpc('app_no_users').then(function(r) { return r && !r.error ? !!r.data : false; })
    .catch(function() { return false; });
}

backend = {
  getSchema: function(folderId) {
    return StorageSupabase.getMeta('schema').then(function(d) { return BackendHelpers.unwrapSchemaDoc(d); });
  },
  saveSchema: function(folderId, schema) {
    // Mirror the schema-derived facts the schema-blind RLS needs, kept in sync on every schema write:
    // _meta/ownerTables (owner-column tables -> gates owner-create), _meta/pageAccess (restricted
    // doc-views -> gates _pages__active reads), _meta/ownerWritable (which columns an owner-scoped
    // write may touch), _meta/listTables (which tables own each list -> authorizes a _lists CREATE,
    // where there is no existing row to read the ownership label from). Same contract as
    // backend-firebase.js — the two must mirror the SAME set or the rules layers diverge.
    return Promise.all([
      StorageSupabase.setMeta('schema', schema),
      StorageSupabase.setMeta('ownerTables', { tables: BackendHelpers.ownerTablesOf(schema) }),
      StorageSupabase.setMeta('pageAccess', BackendHelpers.pageAccessOf(schema)),
      StorageSupabase.setMeta('ownerWritable', BackendHelpers.ownerWritableOf(schema)),
      StorageSupabase.setMeta('listTables', listOwnershipMap((schema && schema.tables) || {})),
      StorageSupabase.setMeta('listWritable', BackendHelpers.userWritableListsOf(schema))
    ]);
  },
  // Single doc-view body by name (RLS authorizes a single-row read of a restricted page by its own rule).
  getPage: function(name) {
    return StorageSupabase.get('_pages__active', name)
      .then(function(d) { return d ? { markdown: d.markdown || '' } : null; })
      .catch(function() { return null; });
  },
  // Single stored asset by id (view background / image-cell bytes). Mirrors backend-firebase getAsset.
  getAsset: function(id) {
    return StorageSupabase.get('_assets__active', id)
      .then(function(d) { return d ? { src: d.src || '' } : null; })
      .catch(function() { return null; });
  },
  validateFolder: function(id) { return Promise.resolve({ valid: true, name: 'Supabase' }); },
  getFolderConfig: function(folderId) {
    return StorageSupabase.getMeta('config').then(function(d) { return d || null; });
  },
  setFolderConfig: function(folderId, config) { return StorageSupabase.setMeta('config', config); },
  initSchema: function(folderId, schema) {
    var result = {};
    Object.keys(schema).forEach(function(t) { result[t] = t; });
    return Promise.resolve(result);
  },
  // One-round-trip boot: schema + languages + lists + all accessible table data, concurrently. Unlike
  // Firestore (denied read throws), an RLS-forbidden Postgres SELECT returns 0 rows — so we can't infer
  // "not registered" from an empty schema read. Instead we PRE-CHECK registration (getMyAccess), then read.
  bootData: function(folderId) {
    var self = this;
    return backend_users.getMyAccess().then(function(access) {
      // Signed in but not a member: skip schema/data, let the caller show the request-access banner.
      if (access && access.registered === false) return { schema: null, denied: true };
      return Promise.all([
        StorageSupabase.getMeta('schema').catch(function() { return null; }),
        StorageSupabase.getMeta('languages').catch(function() { return null; }),
        self.getLists(folderId).catch(function() { return {}; }),
        self._myTables()           // null = unrestricted; [] = none; [..] = restricted set
      ]).then(function(r) {
        if (!r[0]) return { schema: null }; // first boot -> client saves the bundled default
        var parsed = BackendHelpers.unwrapSchemaDoc(r[0]);
        var tables = (parsed && parsed.tables) || {};
        var tableMap = {}; Object.keys(tables).forEach(function(t) { tableMap[t] = t; });
        var languages = (r[1] && (r[1].list || [])) || [];
        var lists = r[2] || {};
        var allowed = r[3];
        // Granted tables PLUS the owner-column (self-service) ones — the shared predicate, so this boot
        // set matches Firebase's. RLS filters rather than denies, so an owner table read here returns
        // exactly the caller's own rows + the public roster.
        var names = BackendHelpers.bootTableNames(parsed, allowed);
        var jobs = [];
        names.forEach(function(name) {
          jobs.push(self.getTableData(name, 'active').then(function(res) { return { key: name, res: res }; }).catch(function() { return { key: name, res: { rows: [] } }; }));
          if (tables[name] && tables[name].archivable) {
            jobs.push(self.getTableData(name, 'archive').then(function(res) { return { key: name + '__archive', res: res }; }).catch(function() { return { key: name + '__archive', res: { rows: [] } }; }));
          }
        });
        return Promise.all(jobs).then(function(results) {
          var data = {};
          results.forEach(function(x) { data[x.key] = x.res; });
          return { schema: parsed, tableOrder: Object.keys(tables), tableMap: tableMap, languages: languages, lists: lists, data: data, unrestricted: allowed === null };
        });
      });
    });
  },
  getAvailableTables: function() { return Promise.resolve([]); },
  getAvailableLanguages: function(folderId) {
    return StorageSupabase.getMeta('languages').then(function(d) { return d ? (d.list || []) : []; });
  },
  getTableData: function(tableId, tab) {
    var store = _storeName(tableId, tab);
    return StorageSupabase.getAll(store).then(function(rows) {
      return { headers: BackendHelpers.deriveHeaders(rows), rows: rows };
    });
  },
  putRow: function(tableId, data, tab) {
    if (!data.id) return Promise.resolve();
    return StorageSupabase.put(_storeName(tableId, tab), data.id, data);
  },
  // Live updates (optional backend method — see live-sync.js and app-core's _liveWatch). Every store
  // is a slice of the SAME `kv` table, so this is one channel with a store -> handlers dispatch map
  // rather than a channel (and a WebSocket subscription) per table.
  //
  // No filter is applied: RLS filters postgres_changes per subscriber, so a member receives exactly
  // the INSERT/UPDATE events they could have read themselves — the same gate as the initial fetch,
  // enforced in the same place. DELETE events are the documented exception (see supabase-schema.sql):
  // they are broadcast unfiltered and carry only the primary key, (store, key). A delete for a row the
  // client never cached is a no-op in the reconciler, so this leaks the fact that some row id under
  // some store was removed, and nothing about its contents.
  subscribeTable: function(tableId, tab, onChange) {
    var store = _storeName(tableId, tab);
    if (!_sbHandlers[store]) _sbHandlers[store] = [];
    _sbHandlers[store].push(onChange);
    _ensureRealtime();
    return function() {
      var arr = _sbHandlers[store] || [];
      var i = arr.indexOf(onChange);
      if (i >= 0) arr.splice(i, 1);
    };
  },
  deleteRow: function(tableId, id, tab) { return StorageSupabase.delete(_storeName(tableId, tab), id); },
  moveRow: function(tableId, rowData, fromTab, toTab) {
    var self = this;
    return self.deleteRow(tableId, rowData.id, fromTab).then(function() { return self.putRow(tableId, rowData, toTab); });
  },

  // --- Per-list storage: store `_lists`, one row per list { name, items, tables }. `tables` = owning
  // tables (from schema), used by the /_lists RLS to gate reads. Admin reads all; a restricted user reads
  // only the list rows their table grants allow (RLS filters the rows). ---
  _myTables: function() {
    // null = unrestricted (admin or bootstrap); [] = registered-but-no-access; [..] = restricted set.
    var email = _myEmail();
    if (!email) return Promise.resolve([]);
    return StorageSupabase.get('_users', email).then(function(v) {
      if (v) return (v.role === 'admin') ? null : AccessFeatures.readableTables(v.tables);
      // No per-user row: on Supabase /_users is authoritative (setUserRole always writes it), so a missing
      // row means either bootstrap (no users at all -> admin) or not-a-member (fail closed).
      return _noUsers().then(function(none) { return none ? null : []; });
    }).catch(function() { return []; });
  },
  _legacyGetLists: function() {
    return StorageSupabase.getMeta('lists').then(function(d) { return (d && !d._value) ? d : {}; });
  },
  getLists: function(folderId) {
    var self = this;
    return self._myTables().then(function(tabs) {
      if (tabs !== null && !tabs.length) return {};
      if (tabs === null) {
        return StorageSupabase._all('_lists').then(function(rows) {
          if (rows && rows.length) { var o = {}; rows.forEach(function(row) { var v = row.value; o[v.name || row.key] = v.items || []; }); return o; }
          // one-time additive migration of a legacy _meta/lists doc -> per-list _lists rows (admin only)
          return self._legacyGetLists().then(function(legacy) {
            if (!Object.keys(legacy).length) return {};
            return self.saveLists(folderId, legacy).then(function() { return legacy; });
          });
        });
      }
      // restricted: read each accessible list row by name (single-row reads authorized by RLS). Candidate
      // names are exactly the lists referenced by the user's accessible tables' columns.
      return StorageSupabase.getMeta('schema').then(function(sd) {
        var parsed = BackendHelpers.unwrapSchemaDoc(sd) || {};
        var schemaTables = parsed.tables || {};
        var wanted = {};
        tabs.forEach(function(t) {
          var cols = (schemaTables[t] && schemaTables[t].columns) || {};
          var defs = Array.isArray(cols) ? cols : Object.keys(cols).map(function(k) { return cols[k]; });
          defs.forEach(function(d) {
            if (d && typeof d === 'object') {
              if (d.list) wanted[d.list] = 1;
              if (d.listSwitch && d.listSwitch.list) wanted[d.listSwitch.list] = 1;
            }
          });
        });
        var names = Object.keys(wanted);
        if (!names.length) return {};
        return Promise.all(names.map(function(name) {
          return StorageSupabase.get('_lists', name)
            .then(function(d) { return d ? { name: (d.name || name), items: (d.items || []) } : null; })
            .catch(function() { return null; });
        })).then(function(arr) {
          var o = {}; arr.forEach(function(x) { if (x) o[x.name] = x.items; }); return o;
        });
      });
    });
  },
  saveLists: function(folderId, lists) {
    var self = this;
    return Promise.all([StorageSupabase.getMeta('schema'), self._myTables()]).then(function(r) {
      var tables = (r[0] && r[0].tables) || {}, myTabs = r[1];
      var jobs = Object.keys(lists || {}).map(function(name) {
        return StorageSupabase._replace('_lists', name, { name: name, items: lists[name] || [], tables: listOwningTables(tables, name) });
      });
      if (myTabs === null) { // only an admin (full view) may prune lists absent from the map
        return StorageSupabase._all('_lists').then(function(rows) {
          (rows || []).forEach(function(row) { if (!((lists || {})[row.key])) jobs.push(StorageSupabase.delete('_lists', row.key)); });
          return Promise.all(jobs);
        });
      }
      return Promise.all(jobs);
    });
  },
  putListItem: function(folderId, listName, value) {
    return Promise.all([StorageSupabase.getMeta('schema'), StorageSupabase.get('_lists', listName)]).then(function(r) {
      var tables = (r[0] && r[0].tables) || {};
      var doc = r[1] || { name: listName, items: [], tables: listOwningTables(tables, listName) };
      var items = doc.items || [];
      if (items.indexOf(value) < 0) items = items.concat([value]); // arrayUnion
      return StorageSupabase._replace('_lists', listName, { name: listName, items: items, tables: listOwningTables(tables, listName) });
    });
  },

  // --- User-linked lists: each row `_list_users/<id>` links a list VALUE to a user's email + cached
  // `shared` flag, mirroring backend-firebase.js. Only avatars (never emails) reach non-admin viewers. ---
  _linkDocId: function(listName, value) {
    return encodeURIComponent(String(listName)) + '~' + encodeURIComponent(String(value));
  },
  getListAvatars: function() {
    function join(rows, profiles) {
      profiles = profiles || {}; var out = {};
      (rows || []).forEach(function(row) {
        var v = row.value; var pic = (profiles[String(v.email || '').toLowerCase()] || {}).picture || '';
        if (pic) { (out[v.list] || (out[v.list] = {}))[v.value] = pic; }
      });
      return out;
    }
    // RLS returns only shared links to non-admins and every link to admins; join against whatever profiles
    // are readable (admins: all via getProfiles; others: the shared set).
    return StorageSupabase._all('_list_users').then(function(rows) {
      return backend_users.getProfiles().then(function(p) {
        if (p && Object.keys(p).length) return join(rows, p);
        return backend_users.getSharedProfiles().then(function(sp) { return join(rows, sp); });
      }).catch(function() {
        return backend_users.getSharedProfiles().then(function(sp) { return join(rows, sp); });
      });
    }).catch(function() { return {}; });
  },
  getListUserLinks: function() {   // admin-only raw { list: { value: email } }
    return StorageSupabase._all('_list_users').then(function(rows) {
      var out = {}; (rows || []).forEach(function(row) { var v = row.value; (out[v.list] || (out[v.list] = {}))[v.value] = v.email; }); return out;
    });
  },
  // SELF-scoped mirror of the Firebase method: { listName: myValue }, the link that names ME. RLS lets a
  // member read their own link (see the _list_users read predicate), so `@me` can resolve to a curated
  // list value without exposing anyone else's mapping.
  getMyListValues: function() {
    var email = (_myEmail && _myEmail()) || '';
    if (!email) return Promise.resolve({});
    return StorageSupabase._all('_list_users').then(function(rows) {
      var out = {};
      (rows || []).forEach(function(row) {
        var v = row.value;
        if (v && String(v.email || '').toLowerCase() === email && v.list && !(v.list in out)) out[v.list] = v.value;
      });
      return out;
    }).catch(function() { return {}; });
  },
  setListUser: function(listName, value, email) {
    var self = this, id = self._linkDocId(listName, value);
    if (!email) return StorageSupabase.delete('_list_users', id).then(function() { return self._mirrorIdentity(listName, value, ''); });
    var e = String(email).toLowerCase();
    return StorageSupabase.get('_profiles', e).then(function(d) {
      return StorageSupabase._replace('_list_users', id, { list: String(listName), value: String(value), email: e, shared: !!(d && d.shared) });
    }).then(function() { return self._mirrorIdentity(listName, value, e); });
  },
  // See backend-firebase._mirrorIdentity: the rules need the caller's own value for a list and cannot
  // query for it, so it rides on the admin-write-only grant doc they already read.
  _mirrorIdentity: function(listName, value, email) {
    return StorageSupabase._all('_users').then(function(rows) {
      var writes = [];
      (rows || []).forEach(function(r) {
        var d = r.value || r, key = r.key || r.id, ident = Object.assign({}, d.identity || {});
        var had = ident[listName];
        if (email && key === email) { if (had === value) return; ident[listName] = value; }
        else if (had === value) { delete ident[listName]; }
        else return;
        writes.push(StorageSupabase._replace('_users', key, Object.assign({}, d, { identity: ident })));
      });
      return Promise.all(writes);
    }).catch(function() { /* non-admin or offline: the link itself is already written */ });
  },

  getTranslations: function(folderId, langCode) {
    return StorageSupabase.getMeta('lang_' + langCode).then(function(d) { return d || {}; });
  },
  updateTranslations: function(folderId, langCode, updates) {
    return StorageSupabase._merge('_meta', 'lang_' + langCode, updates);   // merge (Firestore set{merge:true})
  },
  createLanguage: function(folderId, code, name, keys) {
    return StorageSupabase.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.addLanguage(d ? (d.list || []) : [], code, name);
      return StorageSupabase.setMeta('languages', { list: langs });
    }).then(function() {
      // Read first: an existing language keeps every string it already has, and every key the
      // caller did not mention. Import calls this for each language in the file, so writing the
      // blank seed straight over the document erased whichever translation pack was imported
      // first -- schema strings wiped by an app pack, or the reverse.
      return StorageSupabase.getMeta('lang_' + code).then(function(existing) {
        return StorageSupabase.setMeta('lang_' + code, BackendHelpers.seedTranslations(existing, keys));
      });
    });
  },
  deleteLanguage: function(folderId, code) {
    return StorageSupabase.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.removeLanguage(d ? (d.list || []) : [], code);
      return StorageSupabase.setMeta('languages', { list: langs });
    }).then(function() {
      return StorageSupabase.delete('_meta', 'lang_' + code);
    });
  },
  renameLanguage: function(folderId, code, name) {
    return StorageSupabase.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.renameLanguage(d ? (d.list || []) : [], code, name);
      return StorageSupabase.setMeta('languages', { list: langs });
    });
  },
  saveChangesets: function() { return Promise.resolve(); },
  loadChangesets: function() { return Promise.resolve(); },
  // Upload to the public Supabase Storage bucket `uploads` under <email>/<ts>_<name>, resolving to the
  // public URL (stored in the row by the image column). Presence of this method enables the image uploader.
  uploadFile: function(file, opts) {
    if (!_sb) return Promise.reject(new Error('Supabase not initialized'));
    var email = _myEmail() || 'anon';
    var safe = String((file && file.name) || 'file').replace(/[^\w.\-]+/g, '_');
    var path = email + '/' + Date.now() + '_' + safe;
    return _sb.storage.from(SUPABASE_BUCKET).upload(path, file, { upsert: false }).then(function(res) {
      if (res && res.error) throw res.error;
      return _sb.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl;
    });
  }
};

function initSupabase() {
  var stored = localStorage.getItem('supabase_config');
  var config;
  try { config = (stored && JSON.parse(stored)) || window.SUPABASE_CONFIG || {}; } catch (e) { config = window.SUPABASE_CONFIG || {}; }
  if (config.url && config.anonKey) { _startSupabase(config); return; }
  fetch(_u('/supabase-config.json')).then(function(r) { return r.ok ? r.json() : null; }).then(function(c) {
    if (c && c.url && c.anonKey) { localStorage.setItem('supabase_config', JSON.stringify(c)); _startSupabase(c); }
    else { appInstance.showSetup = true; appInstance.setupStep = 'supabase'; appInstance.loading = false; }
  }).catch(function() { appInstance.showSetup = true; appInstance.setupStep = 'supabase'; appInstance.loading = false; });
}

function _startSupabase(config) {
  _sb = window.supabase.createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  StorageSupabase = createSupabaseStorage(_sb);

  function onUser(user) {
    if (typeof window !== 'undefined' && window.bootMark) window.bootMark('authReady');
    _sbUser = user || null;
    if (user) {
      appInstance.currentUserEmail = user.email;
      appInstance.needsReauth = false;   // clear any transient prompt raised before the redirect resolved
      if (!_sbAuthInited) { _sbAuthInited = true; init(); }   // boot once
    } else {
      appInstance.needsReauth = true; appInstance.loading = false;
    }
  }
  // Resolve the initial session (handles the OAuth redirect return), then keep in sync.
  _sb.auth.getSession().then(function(res) {
    onUser(res && res.data && res.data.session ? res.data.session.user : null);
  }).catch(function() { onUser(null); });
  _sb.auth.onAuthStateChange(function(_event, session) {
    var user = session ? session.user : null;
    if (user && _sbAuthInited) { _sbUser = user; return; }   // ignore token-refresh churn once booted
    onUser(user);
  });
}

function triggerOAuth() {
  if (!_sb) return;
  _sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })
    .catch(function(e) { console.error('Supabase auth error:', e); });
}

var backend_users = {
  // The CURRENT user's own access only (self-scoped) so non-admins never read the whole users map.
  getMyAccess: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve({ registered: false });
    return StorageSupabase.get('_users', email).then(function(v) {
      if (v) return { role: v.role, tables: v.tables || 'all' };
      return _noUsers().then(function(none) { return none ? { bootstrap: true } : { registered: false }; });
    }).catch(function() { return { registered: false }; });
  },
  // Admin roster for the Users tab. Lists per-user rows; if empty, one-time ADDITIVE migration from a
  // legacy _meta/users map (e.g. data imported from a Firestore export) then returns it.
  getUsers: function() {
    return StorageSupabase._all('_users').then(function(rows) {
      if (rows && rows.length) {
        var o = {}; rows.forEach(function(row) { var v = row.value; o[row.key] = { role: v.role, user: v.user || row.key, tables: v.tables || 'all' }; });
        return o;
      }
      return StorageSupabase.getMeta('users').then(function(map) {
        if (!map || map._value) return {};
        var jobs = [], o = {};
        Object.keys(map).forEach(function(k) {
          var v = map[k] || {}, key = String(k).toLowerCase();
          var rec = { role: v.role, user: v.user || key, tables: v.tables || 'all' };
          jobs.push(StorageSupabase._replace('_users', key, rec)); o[key] = rec;
        });
        return Promise.all(jobs).then(function() { return o; }).catch(function() { return o; });
      }).catch(function() { return {}; });
    });
  },
  setUserRole: function(uid, role, user, tables) {
    var key = String(uid || '').toLowerCase();
    var rec = BackendHelpers.userGrantDoc(key, role, user, tables);
    // Source of truth = /_users/<key>; also mirror into the legacy _meta/users map so an admin importing
    // from / exporting to a Firestore deployment stays consistent.
    var patch = {}; patch[key] = rec;
    return Promise.all([
      StorageSupabase._replace('_users', key, rec),
      StorageSupabase._merge('_meta', 'users', patch)
    ]);
  },
  removeUser: function(uid) {
    var key = String(uid || '').toLowerCase();
    return Promise.all([
      StorageSupabase.delete('_users', key),
      (key !== uid ? StorageSupabase.delete('_users', uid).catch(function() {}) : Promise.resolve()),
      StorageSupabase.getMeta('users').then(function(map) {
        if (!map || map._value) return;
        var changed = false;
        [uid, key].forEach(function(k) { if (k in map) { delete map[k]; changed = true; } });
        return changed ? StorageSupabase._replace('_meta', 'users', map) : undefined;
      }).catch(function() {})
    ]);
  },
  // --- Membership requests (self-service; admin approves) ---
  requestAccess: function(name, note) {
    var email = _myEmail();
    if (!email) return Promise.reject(new Error('not signed in'));
    return StorageSupabase._replace('_access_requests', email, { email: email, name: name || '', note: note || '', ts: Date.now() });
  },
  getAccessRequests: function() {   // admin only
    return StorageSupabase._all('_access_requests').then(function(rows) {
      var o = {}; (rows || []).forEach(function(row) { o[row.key] = row.value; }); return o;
    });
  },
  removeAccessRequest: function(email) {
    return StorageSupabase.delete('_access_requests', String(email || '').toLowerCase());
  },
  // --- Opt-in display-name profiles (for user-backed lists / leaderboard identity) ---
  getMyProfile: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve({ name: '', shared: false, picture: '' });
    return StorageSupabase.get('_profiles', email)
      .then(function(d) { return d ? { name: d.name || '', shared: !!d.shared, picture: d.picture || '' } : { name: '', shared: false, picture: '' }; })
      .catch(function() { return { name: '', shared: false, picture: '' }; });
  },
  setMyProfile: function(name, shared, picture) {
    var email = _myEmail();
    if (!email) return Promise.reject(new Error('not signed in'));
    return StorageSupabase._replace('_profiles', email, { name: name || '', shared: !!shared, picture: picture || '' });
  },
  // Names of users who opted to share. RLS returns shared profiles (plus own/admin); filter to shared.
  // Deliberately does NOT catch — a rejection is distinguishable from "nobody opted in".
  getSharedNames: function() {
    return StorageSupabase._all('_profiles').then(function(rows) {
      var out = [];
      (rows || []).forEach(function(row) { var v = row.value; if (v && v.shared) { var n = (v.name || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); } });
      return out.sort(function(a, b) { return a.localeCompare(b); });
    });
  },
  getSharedProfiles: function() {
    return StorageSupabase._all('_profiles').then(function(rows) {
      var o = {}; (rows || []).forEach(function(row) { var v = row.value; if (v && v.shared) o[row.key] = { name: v.name || '', picture: v.picture || '' }; }); return o;
    }).catch(function() { return {}; });
  },
  // Admin-only: seed/rename another user's profile display name. Merges name only so `shared` survives.
  setProfileName: function(email, name) {
    var k = String(email || '').toLowerCase();
    if (!k) return Promise.resolve();
    return StorageSupabase._merge('_profiles', k, { name: name || '' });
  },
  // Admin-only: every user's profile keyed by email, for the Users management table.
  getProfiles: function() {
    return StorageSupabase._all('_profiles').then(function(rows) {
      var o = {}; (rows || []).forEach(function(row) { o[row.key] = row.value; }); return o;
    }).catch(function() { return {}; });
  }
};

initSupabase();
