// backend-firebase.js — Firebase Firestore backend with Google Auth
// Requires: storage-firestore.js loaded before this
// _u(): resolve same-origin paths against the app's own directory (see appUrl in index.html) so the
// app works when hosted under a subpath, e.g. a GitHub Pages project site at /<repo>/.
function _u(p) { return (typeof window !== 'undefined' && window.appUrl) ? window.appUrl(p) : p; }
var _db = null;
var _auth = null;
var _storage = null;

function _storeName(table, tab) { return BackendHelpers.storeName(table, tab); }

// The signed-in user's lowercased email ('' when signed out) — auth first, app state as fallback.
// Was copy-pasted at six call sites across backend/backend_users.
function _myEmail() {
  return (((_auth && _auth.currentUser && _auth.currentUser.email)
    || (typeof appInstance !== 'undefined' && appInstance && appInstance.currentUserEmail)) || '').toLowerCase();
}

backend = {
  getSchema: function(folderId) {
    return StorageFirestore.getMeta('schema').then(function(d) {
      return BackendHelpers.unwrapSchemaDoc(d);
    });
  },
  saveSchema: function(folderId, schema) {
    // Mirror the schema-derived facts the schema-blind firestore rules need, kept in sync on every
    // schema write: _meta/ownerTables (tables with an owner column -> gates owner-create),
    // _meta/pageAccess (restricted doc-views -> gates _pages__active reads; see pageAccessOf),
    // _meta/ownerWritable (which columns an owner-scoped write may touch; see ownerWritableOf) and
    // _meta/listTables (which tables own each list -> lets the /_lists rule authorize a CREATE, where
    // there is no existing doc to read the ownership label from; see listOwnershipMap) and
    // _meta/listWritable (which lists a NON-ADMIN may add to at all; see userWritableListsOf).
    return Promise.all([
      StorageFirestore.setMeta('schema', schema),
      StorageFirestore.setMeta('ownerTables', { tables: BackendHelpers.ownerTablesOf(schema) }),
      StorageFirestore.setMeta('pageAccess', BackendHelpers.pageAccessOf(schema)),
      StorageFirestore.setMeta('ownerWritable', BackendHelpers.ownerWritableOf(schema)),
      StorageFirestore.setMeta('listTables', listOwnershipMap((schema && schema.tables) || {})),
      StorageFirestore.setMeta('listWritable', BackendHelpers.userWritableListsOf(schema))
    ]);
  },
  // Single doc-view body by name. loadPage uses this (not the whole _pages__active collection) so that
  // per-page access can restrict it: Firestore rules aren't filters, so a collection read is denied
  // wholesale once ANY page is restricted, whereas a single-doc get() is authorized by the page's own
  // rule. Returns { markdown } or null (missing / denied).
  getPage: function(name) {
    return StorageFirestore.get('_pages__active', name)
      .then(function(d) { return d ? { markdown: d.markdown || '' } : null; })
      .catch(function() { return null; });
  },
  // Single stored asset (a view background / an image cell's bytes) by id. Same single-doc reasoning as
  // getPage, plus one of its own: _assets is a system store no table grant ever names, so the collection
  // read in getTableData goes through _scopedRead and comes back EMPTY for a non-admin. Ask for the one
  // document instead. Returns { src } or null (missing / denied).
  getAsset: function(id) {
    return StorageFirestore.get('_assets__active', id)
      .then(function(d) { return d ? { src: d.src || '' } : null; })
      .catch(function() { return null; });
  },
  validateFolder: function(id) {
    return Promise.resolve({ valid: true, name: 'Firebase' });
  },
  getFolderConfig: function(folderId) {
    return StorageFirestore.getMeta('config').then(function(d) { return d || null; });
  },
  setFolderConfig: function(folderId, config) {
    return StorageFirestore.setMeta('config', config);
  },
  initSchema: function(folderId, schema) {
    var result = {};
    Object.keys(schema).forEach(function(t) { result[t] = t; });
    return Promise.resolve(result);
  },
  // One-round-trip boot for Firebase: schema + languages + lists + all accessible table data, fetched
  // CONCURRENTLY (Promise.all). Firestore has no Sheets-style per-call rate limit, so concurrency is
  // safe here. Access-scoped via _myTables so denied collections are never queried (rules aren't
  // filters — querying a denied collection would throw). Replaces ~20 sequential round-trips.
  bootData: function(folderId) {
    var self = this;
    var DENIED = { __denied: true };
    return Promise.all([
      // Denied (not just missing) for a not-yet-registered user: /_meta reads require isRegistered().
      // Marked distinctly from "doc doesn't exist" so we don't mistake it for first-boot below and
      // try to write a default schema we have no permission to save.
      StorageFirestore.getMeta('schema').catch(function() { return DENIED; }),
      StorageFirestore.getMeta('languages').catch(function() { return DENIED; }),
      self.getLists(folderId).catch(function() { return {}; }),   // lists are optional — never let one denied read fail-fast the whole boot
      self._myTables()           // null = unrestricted; [] = none; [..] = restricted set
    ]).then(function(r) {
      if (r[0] === DENIED) return { schema: null, denied: true };
      if (!r[0]) return { schema: null }; // first boot -> client saves the bundled default
      var parsed = BackendHelpers.unwrapSchemaDoc(r[0]);
      var tables = (parsed && parsed.tables) || {};
      var tableMap = {}; Object.keys(tables).forEach(function(t) { tableMap[t] = t; });
      var languages = (r[1] !== DENIED && r[1] && (r[1].list || [])) || [];
      var lists = r[2] || {};
      var allowed = r[3];
      // Boot loads granted tables PLUS the owner-column ones, which a member may reach without a grant
      // at all (self-service) — see BackendHelpers.bootTableNames, shared with the Supabase and dev
      // backends so the three boot sets cannot drift again. getTableData scopes each read to the slice
      // the rules allow, so pulling them here costs a member their own rows + the public roster, never
      // a denied request.
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
        // unrestricted: false tells the caller not to auto-seed/write shared list scaffolding -- a
        // restricted editor's writes to lists outside their own tables would be denied wholesale
        // (Firestore batch commits are atomic), whereas an admin/bootstrap (allowed === null) may.
        return { schema: parsed, tableOrder: Object.keys(tables), tableMap: tableMap, languages: languages, lists: lists, data: data, unrestricted: allowed === null };
      });
    });
  },
  getAvailableTables: function() { return Promise.resolve([]); },
  getAvailableLanguages: function(folderId) {
    return StorageFirestore.getMeta('languages').then(function(d) {
      return d ? (d.list || []) : [];
    });
  },
  // Read a table the caller may not hold a blanket grant on. Rules are not filters: with no table
  // grant, the read rule is provable only from a constraint on `owner` or `rosterPublic`, so an
  // unconstrained collection read is DENIED — the whole self-service read (RSVP, sign-ups, a shared
  // chore log) used to fail and get swallowed into an empty table. Ask for exactly the two slices the
  // rules can prove and merge them: my own rows, plus the rows marked public.
  _scopedRead: function(store, tableId) {
    return this._myTables().then(function(tabs) {
      if (tabs === null || tabs.indexOf(tableId) >= 0) return StorageFirestore.getAll(store); // granted: whole collection
      var me = _myEmail();
      if (!me) return [];
      return Promise.all([
        StorageFirestore.getWhere(store, 'owner', '==', me),
        StorageFirestore.getWhere(store, 'rosterPublic', '==', true)
      ]).then(function(parts) {
        var seen = {}, rows = [];
        parts.forEach(function(part) {
          (part || []).forEach(function(r) {
            var k = r && r.id;
            if (k == null || seen[k]) return;        // a row that is BOTH mine and public arrives twice
            seen[k] = true; rows.push(r);
          });
        });
        return rows;
      }).catch(function() { return []; });           // fail closed, never surface a denied read as an error
    });
  },
  getTableData: function(tableId, tab) {
    var store = _storeName(tableId, tab);
    return this._scopedRead(store, tableId).then(function(rows) {
      return { headers: BackendHelpers.deriveHeaders(rows), rows: rows };
    });
  },
  // Live updates (optional backend method — see live-sync.js and app-core's _liveWatch). Emits
  // { type:'put'|'delete', id, row } for every change another client makes to this partition.
  //
  // The query shape MIRRORS _scopedRead and has to: rules are not filters, so a listener without a
  // table grant is provable only when it constrains `owner` / `rosterPublic`. An unconstrained
  // onSnapshot for that user is denied outright — the listener would simply never fire, which is the
  // silent-empty-table failure _scopedRead was written to avoid, only harder to notice.
  subscribeTable: function(tableId, tab, onChange) {
    var store = _storeName(tableId, tab);
    var unsubs = [], stopped = false;
    // Which of the queries currently matches each doc id. In the two-query (self-service) case a doc
    // leaving ONE query fires 'removed' there while it is still visible through the other — e.g. a row
    // whose rosterPublic flips false is still mine. Emitting a delete on that would make the row vanish
    // from a user who can still see it, so a delete is emitted only once the id has left both queries.
    var presence = {};
    function onSnap(qi, snap) {
      snap.docChanges().forEach(function(c) {
        var id = c.doc.id;
        var at = presence[id] || (presence[id] = {});
        if (c.type === 'removed') {
          delete at[qi];
          if (Object.keys(at).length) return;          // still matched by the other query — not a delete
          delete presence[id];
          onChange({ type: 'delete', id: id, row: null });
        } else {
          at[qi] = true;
          onChange({ type: 'put', id: id, row: c.doc.data() });
        }
      });
    }
    this._myTables().then(function(tabs) {
      if (stopped) return;
      var queries;
      if (tabs === null || tabs.indexOf(tableId) >= 0) {
        queries = [_db.collection(store)];
      } else {
        var me = _myEmail();
        if (!me) return;
        queries = [
          _db.collection(store).where('owner', '==', me),
          _db.collection(store).where('rosterPublic', '==', true)
        ];
      }
      queries.forEach(function(q, qi) {
        // Errors are swallowed for the same reason _scopedRead's are: a denied read must degrade to
        // "no live updates", never to an exception thrown out of a snapshot callback.
        unsubs.push(q.onSnapshot(function(snap) { onSnap(qi, snap); }, function() {}));
      });
    }).catch(function() {});
    return function() {
      stopped = true;
      unsubs.forEach(function(u) { try { u(); } catch (e) {} });
      unsubs = [];
    };
  },
  putRow: function(tableId, data, tab) {
    if (!data.id) return Promise.resolve();
    return StorageFirestore.put(_storeName(tableId, tab), data.id, data);
  },
  deleteRow: function(tableId, id, tab) {
    return StorageFirestore.delete(_storeName(tableId, tab), id);
  },
  moveRow: function(tableId, rowData, fromTab, toTab) {
    var self = this;
    return self.deleteRow(tableId, rowData.id, fromTab).then(function() {
      return self.putRow(tableId, rowData, toTab);
    });
  },
  // --- Per-list storage (Phase 1): collection `_lists`, one doc per list { name, items, tables }.
  // `tables` = owning tables (derived from schema), used by the /_lists Firestore rule to gate reads.
  // Reads are rules-safe: admins read the whole collection (and lazily migrate the legacy _meta/lists
  // doc); restricted users query `tables array-contains-any <their tables>` so the query matches the
  // rule (Firestore rules are not filters). Restricted editors only UPSERT their lists — they never
  // prune, since their list map is partial. Migration is additive (legacy _meta/lists is kept). ---
  _myTables: function() {
    // null = unrestricted (admin or no users); [] = known-but-no-access; [..] = restricted set.
    // Memoized: every scoped table read asks, and the answer is one registry doc that only changes when
    // an admin re-grants (setUserRole clears it). Without this a boot reading N tables costs N extra
    // round-trips for a value that cannot change between them.
    if (this._myTablesPromise) return this._myTablesPromise;
    this._myTablesPromise = this._loadMyTables();
    return this._myTablesPromise;
  },
  _loadMyTables: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve([]);
    return _db.collection('_users').doc(email).get().then(function(d) {
      if (d.exists) { var v = d.data(); return (v.role === 'admin') ? null : AccessFeatures.readableTables(v.tables); }
      // No per-user doc yet: bootstrap (no users) or un-migrated -> consult the legacy _meta/users map.
      return _db.collection('_meta').doc('users').get().then(function(doc) {
        if (!doc.exists) return null;                 // bootstrap
        var u = doc.data()[email];
        if (!u) return [];                            // registered but not me
        return (u.role === 'admin') ? null : AccessFeatures.readableTables(u.tables);
      }).catch(function() { return []; });            // map read denied -> fail closed
    }).catch(function() { return []; });
  },
  _legacyGetLists: function() {
    return StorageFirestore.getMeta('lists').then(function(d) { return (d && !d._value) ? d : {}; });
  },
  getLists: function(folderId) {
    var self = this;
    return self._myTables().then(function(tabs) {
      if (tabs !== null && !tabs.length) return {};
      if (tabs === null) {
        return _db.collection('_lists').get().then(function(snap) {
          if (!snap.empty) { var o = {}; snap.forEach(function(d) { var v = d.data(); o[v.name || d.id] = v.items || []; }); return o; }
          // one-time additive migration of the legacy _meta/lists doc -> per-list _lists docs (admin only)
          return self._legacyGetLists().then(function(legacy) {
            if (!Object.keys(legacy).length) return {};
            return self.saveLists(folderId, legacy).then(function() { return legacy; });
          });
        });
      }
      // restricted: Firestore rules can't prove-authorize an `array-contains-any` query against a
      // get()-fetched allow-set (userData().tables), so the collection query is denied. Instead read
      // each accessible list DOC individually — single-doc reads ARE authorized by the /_lists
      // `listAllowed()` rule (it evaluates that one doc's `resource.data.tables`). The candidate list
      // names are exactly the lists referenced by the user's accessible tables' columns.
      return StorageFirestore.getMeta('schema').then(function(sd) {
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
          return _db.collection('_lists').doc(name).get()
            .then(function(d) { return d.exists ? { name: (d.data().name || name), items: (d.data().items || []) } : null; })
            .catch(function() { return null; });   // denied/missing list doc -> skip (fail-closed per list)
        })).then(function(arr) {
          var o = {}; arr.forEach(function(x) { if (x) o[x.name] = x.items; }); return o;
        });
      });
    });
  },
  saveLists: function(folderId, lists) {
    var self = this;
    return Promise.all([StorageFirestore.getMeta('schema'), self._myTables()]).then(function(r) {
      var tables = (r[0] && r[0].tables) || {}, myTabs = r[1];
      var batch = _db.batch();
      Object.keys(lists || {}).forEach(function(name) {
        batch.set(_db.collection('_lists').doc(name), { name: name, items: lists[name] || [], tables: listOwningTables(tables, name) });
      });
      if (myTabs === null) { // only an admin (full view) may prune lists absent from the map
        return _db.collection('_lists').get().then(function(snap) {
          snap.forEach(function(d) { if (!((lists || {})[d.id])) batch.delete(d.ref); });
          return batch.commit();
        });
      }
      return batch.commit();
    });
  },
  putListItem: function(folderId, listName, value) {
    return StorageFirestore.getMeta('schema').then(function(s) {
      var tables = (s && s.tables) || {};
      return _db.collection('_lists').doc(listName).set(
        { name: listName, items: firebase.firestore.FieldValue.arrayUnion(value), tables: listOwningTables(tables, listName) },
        { merge: true });
    });
  },
  // --- User-linked lists (Option C): link a list VALUE to a registered user, for avatar display ---
  // Each link is its own doc { list, value, email, shared }; `shared` caches the linked user's current
  // opt-in so a non-admin can query ONLY shared links (whose emails are already world-readable via
  // /_profiles) — mirroring getSharedProfiles. Admins read all; only admins write.
  _linkDocId: function(listName, value) {
    return encodeURIComponent(String(listName)) + '~' + encodeURIComponent(String(value));
  },
  // Viewer-safe { list: { value: picture } } projection. Tries the admin read (all links, joined against
  // every profile's picture incl. unshared); on denial falls back to the shared-only query any registered
  // user may run. Never returns an email. Join is inline (no list-users.js load-order dependency).
  getListAvatars: function() {
    function join(snap, profiles) {
      profiles = profiles || {}; var out = {};
      snap.forEach(function(d) {
        var v = d.data(); var pic = (profiles[String(v.email || '').toLowerCase()] || {}).picture || '';
        if (pic) { (out[v.list] || (out[v.list] = {}))[v.value] = pic; }
      });
      return out;
    }
    return _db.collection('_list_users').get()
      .then(function(snap) { return backend_users.getProfiles().then(function(p) { return join(snap, p); }); })
      .catch(function() {
        return _db.collection('_list_users').where('shared', '==', true).get()
          .then(function(snap) { return backend_users.getSharedProfiles().then(function(p) { return join(snap, p); }); })
          .catch(function() { return {}; });
      });
  },
  // Admin-only: the raw { list: { value: email } } links, for the Lookup editor's picker.
  getListUserLinks: function() {
    return _db.collection('_list_users').get().then(function(snap) {
      var out = {}; snap.forEach(function(d) { var v = d.data(); (out[v.list] || (out[v.list] = {}))[v.value] = v.email; }); return out;
    });
  },
  // SELF-scoped: { listName: myValue } for every `userlink` list that names me. This is what lets `@me`
  // resolve to a curated list value instead of my profile display name. The whole-collection read above
  // is admin-only; this equality query is rules-provable against the caller's own email (see the
  // _list_users read rule), so any member may run it and learns nothing but their own link.
  getMyListValues: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve({});
    return _db.collection('_list_users').where('email', '==', email).get().then(function(snap) {
      var out = {}; snap.forEach(function(d) { var v = d.data(); if (v.list && !(v.list in out)) out[v.list] = v.value; }); return out;
    }).catch(function() { return {}; });   // never let a denied/missing link break boot
  },
  // Admin-only: link (email set) or unlink (empty) a value. Caches the linked user's current shared flag so
  // the shared-only query stays rules-provable; a later share/unshare needs a re-link to refresh it.
  setListUser: function(listName, value, email) {
    var self = this, id = self._linkDocId(listName, value);
    if (!email) return _db.collection('_list_users').doc(id).delete().then(function() { return self._mirrorIdentity(listName, value, ''); });
    var e = String(email).toLowerCase();
    return _db.collection('_profiles').doc(e).get().then(function(d) {
      return _db.collection('_list_users').doc(id).set({ list: String(listName), value: String(value), email: e, shared: (d.exists && !!d.data().shared) });
    }).then(function() { return self._mirrorIdentity(listName, value, e); });
  },
  // Mirror the link onto the linked user's GRANT doc as `identity: { <list>: <value> }`. The rules need
  // "what is this caller's own value for this list" and cannot QUERY for it; the grant doc is
  // admin-write-only (so a member cannot forge it) and already read on every evaluation, so this is the
  // cheapest place to put the answer. Unlinking clears the key, and re-linking a value to a different
  // user clears it from whoever held it before.
  _mirrorIdentity: function(listName, value, email) {
    var col = _db.collection('_users');
    return col.get().then(function(snap) {
      var writes = [];
      snap.forEach(function(doc) {
        var d = doc.data() || {}, ident = Object.assign({}, d.identity || {});
        var had = ident[listName];
        if (email && doc.id === email) { if (had === value) return; ident[listName] = value; }
        else if (had === value) { delete ident[listName]; }                 // somebody else holds it now
        else return;
        writes.push(doc.ref.set(Object.assign({}, d, { identity: ident }))); // whole doc: grants are small
      });
      return Promise.all(writes);
    }).catch(function() { /* non-admin or offline: the link itself is already written */ });
  },
  getTranslations: function(folderId, langCode) {
    return StorageFirestore.getMeta('lang_' + langCode).then(function(d) { return d || {}; });
  },
  updateTranslations: function(folderId, langCode, updates) {
    return _db.collection('_meta').doc('lang_' + langCode).set(updates, { merge: true });
  },
  createLanguage: function(folderId, code, name, keys) {
    return StorageFirestore.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.addLanguage(d ? (d.list || []) : [], code, name);
      return StorageFirestore.setMeta('languages', { list: langs });
    }).then(function() {
      // Read first: an existing language keeps every string it already has, and every key the
      // caller did not mention. Import calls this for each language in the file, so writing the
      // blank seed straight over the document erased whichever translation pack was imported
      // first -- schema strings wiped by an app pack, or the reverse.
      return StorageFirestore.getMeta('lang_' + code).then(function(existing) {
        return StorageFirestore.setMeta('lang_' + code, BackendHelpers.seedTranslations(existing, keys));
      });
    });
  },
  deleteLanguage: function(folderId, code) {
    return StorageFirestore.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.removeLanguage(d ? (d.list || []) : [], code);
      return StorageFirestore.setMeta('languages', { list: langs });
    }).then(function() {
      return _db.collection('_meta').doc('lang_' + code).delete();
    });
  },
  renameLanguage: function(folderId, code, name) {
    // Update only the languages index; the lang_<code> translations doc is left intact.
    return StorageFirestore.getMeta('languages').then(function(d) {
      var langs = BackendHelpers.renameLanguage(d ? (d.list || []) : [], code, name);
      return StorageFirestore.setMeta('languages', { list: langs });
    });
  },
  saveChangesets: function() { return Promise.resolve(); },
  loadChangesets: function() { return Promise.resolve(); },
  // Upload a file to Firebase Storage under uploads/<user-email>/<ts>_<name>, resolving to its download
  // URL (stored in the row by the image column). The download URL carries an access token, so the <img>
  // renders regardless of Storage read rules. Presence of this method is what enables the image uploader;
  // backends without it fall back to a paste-a-URL input.
  uploadFile: function(file, opts) {
    if (!_storage) return Promise.reject(new Error('Firebase Storage not initialized'));
    var email = _myEmail() || 'anon';
    var safe = String((file && file.name) || 'file').replace(/[^\w.\-]+/g, '_');
    var path = 'uploads/' + email + '/' + Date.now() + '_' + safe;
    return _storage.ref().child(path).put(file).then(function(snap) { return snap.ref.getDownloadURL(); });
  }
};

function initFirebase() {
  var stored = localStorage.getItem('firebase_config');
  var config;
  try { config = (stored && JSON.parse(stored)) || window.FIREBASE_CONFIG || {}; } catch(e) { config = window.FIREBASE_CONFIG || {}; }
  if (config.apiKey) { _startFirebase(config); return; }
  fetch(_u('/firebase-config.json')).then(function(r) { return r.ok ? r.json() : null; }).then(function(c) {
    if (c && c.apiKey) { localStorage.setItem('firebase_config', JSON.stringify(c)); _startFirebase(c); }
    else { appInstance.showSetup = true; appInstance.setupStep = 'firebase'; appInstance.loading = false; }
  }).catch(function() { appInstance.showSetup = true; appInstance.setupStep = 'firebase'; appInstance.loading = false; });
}

// Opt-in local-emulator mode for development: enabled only when localStorage.firebase_emulators==='1'
// AND the app is served from a loopback host (so a real deployment can never accidentally use emulators).
// Ports mirror firebase.json's `emulators` block. Set the flag in devtools, then reload.
function _useEmulators() {
  try {
    if (localStorage.getItem('firebase_emulators') !== '1') return false;
    var h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '';
  } catch (e) { return false; }
}

function _startFirebase(config) {
  firebase.initializeApp(config);
  _db = firebase.firestore();
  _auth = firebase.auth();
  if (firebase.storage) { try { _storage = firebase.storage(); } catch (e) { _storage = null; } }
  if (_useEmulators()) {
    // Compat SDK emulator wiring — must run before any read/write (and before enablePersistence).
    try { _auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true }); } catch (e) {}
    try { _db.useEmulator('127.0.0.1', 8080); } catch (e) {}
    try { if (_storage) _storage.useEmulator('127.0.0.1', 9199); } catch (e) {}
    console.info('[firebase] using local emulators — auth:9099 firestore:8080 storage:9199');
    // Emulator path: useEmulator() already consumed settings(), so keep the legacy persistence call.
    _db.enablePersistence().catch(function() {});
  } else {
    // Enable offline persistence via the modern FirestoreSettings.cache API so the SDK doesn't log
    // the enableIndexedDbPersistence() deprecation warning. persistentLocalCache with no tab manager
    // matches the old single-tab enablePersistence() behavior. settings() must run before any read/write.
    // Fall back to the legacy call on SDK builds that don't expose the cache builders.
    try {
      var ff = firebase.firestore;
      if (ff && ff.persistentLocalCache) { _db.settings({ cache: ff.persistentLocalCache({}) }); }
      else { _db.enablePersistence().catch(function() {}); }
    } catch (e) { try { _db.enablePersistence().catch(function() {}); } catch (e2) {} }
  }
  _auth.onAuthStateChanged(function(user) {
    if (typeof window !== 'undefined' && window.bootMark) window.bootMark('authReady'); // auth RTT resolved
    if (user) { appInstance.currentUserEmail = user.email; init(); }
    else { appInstance.needsReauth = true; appInstance.loading = false; }
  });
}

function triggerOAuth() {
  var provider = new firebase.auth.GoogleAuthProvider();
  _auth.signInWithPopup(provider).catch(function(e) { console.error('Firebase auth error:', e); });
}

var backend_users = {
  // The CURRENT user's own access only (self-scoped) so non-admins never read the whole users map.
  getMyAccess: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve({ registered: false });
    return _db.collection('_users').doc(email).get().then(function(d) {
      if (d.exists) { var v = d.data(); return { role: v.role, tables: v.tables || 'all' }; }
      return _db.collection('_meta').doc('users').get().then(function(m) {
        if (!m.exists) return { bootstrap: true };    // no users configured
        var u = m.data()[email];
        return u ? { role: u.role, tables: u.tables || 'all' } : { registered: false };
      }).catch(function() { return { registered: false }; });  // map denied (non-admin, post-close) -> fail closed
    }).catch(function() { return { registered: false }; });
  },
  // Admin roster for the Users tab. Lists per-user docs; if the collection is empty, one-time
  // ADDITIVE migration from the legacy _meta/users map (admin only) then returns it.
  getUsers: function() {
    return _db.collection('_users').get().then(function(snap) {
      if (!snap.empty) {
        var o = {}; snap.forEach(function(d) { var v = d.data(); o[d.id] = { role: v.role, user: v.user || d.id, tables: v.tables || 'all' }; });
        return o;
      }
      return _db.collection('_meta').doc('users').get().then(function(m) {
        if (!m.exists) return {};
        var map = m.data(), batch = _db.batch(), o = {};
        Object.keys(map).forEach(function(k) {
          var v = map[k] || {}, key = String(k).toLowerCase();
          var doc = { role: v.role, user: v.user || key, tables: v.tables || 'all' };
          batch.set(_db.collection('_users').doc(key), doc); o[key] = doc;
        });
        return batch.commit().then(function() { return o; }).catch(function() { return o; });
      });
    });
  },
  setUserRole: function(uid, role, user, tables) {
    var key = String(uid || '').toLowerCase();
    var doc = BackendHelpers.userGrantDoc(key, role, user, tables);
    backend._myTablesPromise = null;   // re-granting invalidates the memoized read scope
    // Source of truth = /_users/<key>; also mirror into the legacy _meta/users map so a rules
    // rollback keeps working during the transition.
    return Promise.all([
      _db.collection('_users').doc(key).set(doc),
      _db.collection('_meta').doc('users').set(Object.fromEntries([[key, doc]]), { merge: true })
    ]);
  },
  removeUser: function(uid) {
    var key = String(uid || '').toLowerCase();
    var del = firebase.firestore.FieldValue.delete();
    var upd = {}; upd[uid] = del; if (key !== uid) upd[key] = del;
    return Promise.all([
      _db.collection('_users').doc(key).delete(),
      (key !== uid ? _db.collection('_users').doc(uid).delete().catch(function() {}) : Promise.resolve()),
      _db.collection('_meta').doc('users').update(upd).catch(function() {})
    ]);
  },
  // --- Membership requests (self-service; admin approves) ---
  // An unregistered user submits a request for access; only they can write their own request doc.
  requestAccess: function(name, note) {
    var email = _myEmail();
    if (!email) return Promise.reject(new Error('not signed in'));
    return _db.collection('_access_requests').doc(email).set({ email: email, name: name || '', note: note || '', ts: Date.now() });
  },
  getAccessRequests: function() {   // admin only
    return _db.collection('_access_requests').get().then(function(snap) {
      var o = {}; snap.forEach(function(d) { o[d.id] = d.data(); }); return o;
    });
  },
  removeAccessRequest: function(email) {
    return _db.collection('_access_requests').doc(String(email || '').toLowerCase()).delete();
  },
  // --- Opt-in display-name profiles (for user-backed lists / leaderboard identity) ---
  getMyProfile: function() {
    var email = _myEmail();
    if (!email) return Promise.resolve({ name: '', shared: false, picture: '' });
    return _db.collection('_profiles').doc(email).get()
      .then(function(d) { return d.exists ? { name: d.data().name || '', shared: !!d.data().shared, picture: d.data().picture || '' } : { name: '', shared: false, picture: '' }; })
      .catch(function() { return { name: '', shared: false, picture: '' }; });
  },
  // picture: an optional data-URL avatar (resized client-side); '' clears it. Written together with
  // name/shared so a full set() keeps them in sync (setProfileName still merges name only, preserving this).
  setMyProfile: function(name, shared, picture) {
    var email = _myEmail();
    if (!email) return Promise.reject(new Error('not signed in'));
    return _db.collection('_profiles').doc(email).set({ name: name || '', shared: !!shared, picture: picture || '' });
  },
  // Names of users who opted to share -- the query is rules-provable (constant shared==true).
  // Deliberately does NOT catch: a rejection is distinguishable from "nobody opted in", and the caller
  // (_overlayUserLists) leaves the curated list intact on a rejection. Swallowing into [] made a rules
  // denial or an offline read silently empty every user-backed list instead.
  getSharedNames: function() {
    return _db.collection('_profiles').where('shared', '==', true).get().then(function(snap) {
      var out = []; snap.forEach(function(d) { var n = (d.data().name || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); });
      return out.sort(function(a, b) { return a.localeCompare(b); });
    });
  },
  // Every opted-in user's { name, picture } keyed by email — the same rules-provable shared==true query as
  // getSharedNames, but carrying the avatar so any registered user (not just admins) can render other
  // people's faces in the roster / user-backed surfaces. Swallows into {} on a rejection/offline read: the
  // avatar is decorative, so callers keep the plain name fallback rather than blanking anything.
  getSharedProfiles: function() {
    return _db.collection('_profiles').where('shared', '==', true).get().then(function(snap) {
      var o = {}; snap.forEach(function(d) { var v = d.data(); o[d.id] = { name: v.name || '', picture: v.picture || '' }; }); return o;
    }).catch(function() { return {}; });
  },
  // Admin-only: seed/rename another user's profile display name (e.g. from their access request on
  // approval, or from the Users table). Merges name only so an existing `shared` opt-in is preserved.
  // Rules allow admin to write any profile.
  setProfileName: function(email, name) {
    var k = String(email || '').toLowerCase();
    if (!k) return Promise.resolve();
    return _db.collection('_profiles').doc(k).set({ name: name || '' }, { merge: true });
  },
  // Admin-only: every user's profile ({name, shared} keyed by email), for the Users management table.
  // Rules allow admin to read the whole /_profiles collection regardless of each doc's `shared` flag.
  getProfiles: function() {
    return _db.collection('_profiles').get().then(function(snap) {
      var o = {}; snap.forEach(function(d) { o[d.id] = d.data(); }); return o;
    }).catch(function() { return {}; });
  }
};

initFirebase();
