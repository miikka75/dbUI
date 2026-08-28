// backend-kv.js — the app's backend contract, expressed once over a key-value storage adapter.
//
// Firestore's document model is reproduced on a single key-value table (`kv`, one row per doc), so each
// per-doc Firestore rule becomes a per-row RLS policy — see supabase-schema.sql. Everything in this file
// is that mapping and nothing else: which store a row lives in, what shape it has, and which
// schema-derived facts the schema-blind policies need mirrored alongside it.
//
// It is deliberately ignorant of WHERE the kv table is. Two hosts run it today:
//   backend-supabase.js      — kv in a hosted Supabase project, over the network, RLS enforced by Postgres.
//   backend-local-pglite.js  — kv in PostgreSQL-in-WASM in the visitor's own browser (IndexedDB), the
//                              same supabase-schema.sql applied by storage-pglite.js.
// The two differ in their PLATFORM (who the caller is, how a file is uploaded, whether other clients
// exist to hear about a change) and in nothing else. That is the whole argument for this file: the
// alternative was a second copy of ~400 lines of access-shaped mapping, drifting from the first.
//
// Browser: <script src="/backend-kv.js"> defines the global createKvBackend.
// Node   : require('../backend-kv') -> { createKvBackend } (used by the contract tests).
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  var H = isNode ? require('./backend-helpers') : root.BackendHelpers;
  var LA = isNode ? require('./list-access') : root.ListAccess;
  var AF = isNode ? require('./access-features') : root.AccessFeatures;
  var Cols = isNode ? require('./columns') : root.Columns;

  // S: the storage adapter (storage-supabase.js / storage-pglite.js) — get/put/delete/getAll/getMeta/
  //    setMeta/_all/_replace/_merge over kv.
  // P: the platform —
  //    myEmail()                     the signed-in identity, lowercased ('' when there is none)
  //    noUsers()                     Promise<bool>, authoritative "the member registry is empty", used
  //                                  for bootstrap. Must NOT be inferred from an empty read: an
  //                                  RLS-forbidden SELECT returns zero rows rather than throwing, so a
  //                                  permission denial and a first boot look identical from outside.
  //    subscribeTable(store, fn)     optional; returns an unsubscribe. Omit when there are no other
  //                                  clients to hear from (a browser-local database).
  //    uploadFile(file, opts)        optional; resolves to a URL. Its presence enables the image uploader.
  //    subscribeLoads                optional flag, see app-core's _liveWatch.
  function createKvBackend(S, P) {
    function storeName(table, tab) { return H.storeName(table, tab); }

    var backend = {
      getSchema: function () {
        return S.getMeta('schema').then(function (d) { return H.unwrapSchemaDoc(d); });
      },
      saveSchema: function (schema) {
        // Mirror the schema-derived facts the schema-blind RLS needs, kept in sync on every schema write:
        // _meta/ownerTables (owner-column tables -> gates owner-create), _meta/pageAccess (restricted
        // doc-views -> gates _pages__active reads), _meta/ownerWritable (which columns an owner-scoped
        // write may touch), _meta/listTables (which tables own each list -> authorizes a _lists CREATE,
        // where there is no existing row to read the ownership label from). Same contract as
        // backend-firebase.js — the two must mirror the SAME set or the rules layers diverge.
        return Promise.all([
          S.setMeta('schema', schema),
          S.setMeta('ownerTables', { tables: H.ownerTablesOf(schema) }),
          S.setMeta('pageAccess', H.pageAccessOf(schema)),
          S.setMeta('ownerWritable', H.ownerWritableOf(schema)),
          S.setMeta('stamped', H.stampedOf(schema)),
          S.setMeta('listTables', LA.listOwnershipMap((schema && schema.tables) || {})),
          S.setMeta('listWritable', H.userWritableListsOf(schema))
        ]);
      },
      // Single doc-view body by name (RLS authorizes a single-row read of a restricted page by its own rule).
      getPage: function (name) {
        return S.get('_pages__active', name)
          .then(function (d) { return d ? { markdown: d.markdown || '' } : null; })
          .catch(function () { return null; });
      },
      // Single stored asset by id (view background / image-cell bytes). Mirrors backend-firebase getAsset.
      getAsset: function (id) {
        return S.get('_assets__active', id)
          .then(function (d) { return d ? { src: d.src || '' } : null; })
          .catch(function () { return null; });
      },
      validateFolder: function () { return Promise.resolve({ valid: true, name: P.name || 'kv' }); },
      getFolderConfig: function () {
        return S.getMeta('config').then(function (d) { return d || null; });
      },
      setFolderConfig: function (config) { return S.setMeta('config', config); },
      // Table ids ARE table names on every remaining backend, so there is nothing to map and nothing to
      // create up front -- a Firestore collection / kv row springs into being on first write.
      initSchema: function () { return Promise.resolve(null); },
      // One-round-trip boot: schema + languages + lists, concurrently. Unlike Firestore (a denied read
      // throws), an RLS-forbidden Postgres SELECT returns 0 rows — so we can't infer "not registered"
      // from an empty schema read. Instead we PRE-CHECK registration (getMyAccess), then read.
      bootData: function () {
        var self = this;
        return users.getMyAccess().then(function (access) {
          // Signed in but not a member: skip schema/data, let the caller show the request-access banner.
          if (access && access.registered === false) return { schema: null, denied: true };
          return Promise.all([
            S.getMeta('schema').catch(function () { return null; }),
            S.getMeta('languages').catch(function () { return null; }),
            self.getLists().catch(function () { return {}; }),
            self._myTables()           // null = unrestricted; [] = none; [..] = restricted set
          ]).then(function (r) {
            if (!r[0]) return { schema: null }; // first boot -> client saves the bundled default
            var parsed = H.unwrapSchemaDoc(r[0]);
            var tables = (parsed && parsed.tables) || {};
            var languages = (r[1] && (r[1].list || [])) || [];
            var lists = r[2] || {};
            var allowed = r[3];
            // Boot fetches NO table data -- see the same note in backend-firebase.js. It used to read
            // every granted table before a view opened; a view now loads its own through app-core's
            // _ensureCached. Costs less on Postgres (rows are not billed per document) but the three
            // backends keep one boot shape, which is why they stopped drifting in the first place.
            return { schema: parsed, tableOrder: Object.keys(tables), languages: languages, lists: lists, data: {}, unrestricted: allowed === null };
          });
        });
      },
      getAvailableTables: function () { return Promise.resolve([]); },
      getAvailableLanguages: function () {
        return S.getMeta('languages').then(function (d) { return d ? (d.list || []) : []; });
      },
      // `opts.constraints` is the pushed-down half of a view filter. Optional: a backend that ignores it
      // returns a superset, which the caller re-filters with the residual anyway.
      getTableData: function (tableId, tab, opts) {
        return S.getAll(storeName(tableId, tab), opts && opts.constraints).then(function (rows) {
          return { headers: H.deriveHeaders(rows), rows: rows };
        });
      },
      putRow: function (tableId, data, tab) {
        if (!data || !data.id) return Promise.resolve();
        return S.put(storeName(tableId, tab), data.id, data);
      },
      deleteRow: function (tableId, id, tab) { return S.delete(storeName(tableId, tab), id); },
      moveRow: function (tableId, rowData, fromTab, toTab) {
        var self = this;
        return self.deleteRow(tableId, rowData.id, fromTab).then(function () { return self.putRow(tableId, rowData, toTab); });
      },

      // --- Per-list storage: store `_lists`, one row per list { name, items, tables }. `tables` = owning
      // tables (from schema), used by the /_lists RLS to gate reads. Admin reads all; a restricted user reads
      // only the list rows their table grants allow (RLS filters the rows). ---
      _myTables: function () {
        // null = unrestricted (admin or bootstrap); [] = registered-but-no-access; [..] = restricted set.
        var email = P.myEmail();
        if (!email) return Promise.resolve([]);
        return S.get('_users', email).then(function (v) {
          if (v) return (v.role === 'admin') ? null : AF.readableTables(v.tables);
          // No per-user row: /_users is authoritative (setUserRole always writes it), so a missing row
          // means either bootstrap (no users at all -> admin) or not-a-member (fail closed).
          return P.noUsers().then(function (none) { return none ? null : []; });
        }).catch(function () { return []; });
      },
      _legacyGetLists: function () {
        return S.getMeta('lists').then(function (d) { return (d && !d._value) ? d : {}; });
      },
      getLists: function () {
        var self = this;
        return self._myTables().then(function (tabs) {
          if (tabs !== null && !tabs.length) return {};
          if (tabs === null) {
            return S._all('_lists').then(function (rows) {
              if (rows && rows.length) { var o = {}; rows.forEach(function (row) { var v = row.value; o[v.name || row.key] = v.items || []; }); return o; }
              // one-time additive migration of a legacy _meta/lists doc -> per-list _lists rows (admin only)
              return self._legacyGetLists().then(function (legacy) {
                if (!Object.keys(legacy).length) return {};
                return self.saveLists(legacy).then(function () { return legacy; });
              });
            });
          }
          // restricted: read each accessible list row by name (single-row reads authorized by RLS). Candidate
          // names are exactly the lists referenced by the user's accessible tables' columns.
          return S.getMeta('schema').then(function (sd) {
            var parsed = H.unwrapSchemaDoc(sd) || {};
            var schemaTables = parsed.tables || {};
            var wanted = {};
            tabs.forEach(function (t) {
              Cols.columnDefList(schemaTables[t]).forEach(function (d) {
                if (d && typeof d === 'object') {
                  if (d.list) wanted[d.list] = 1;
                  if (d.listSwitch && d.listSwitch.list) wanted[d.listSwitch.list] = 1;
                }
              });
            });
            var names = Object.keys(wanted);
            if (!names.length) return {};
            return Promise.all(names.map(function (name) {
              return S.get('_lists', name)
                .then(function (d) { return d ? { name: (d.name || name), items: (d.items || []) } : null; })
                .catch(function () { return null; });
            })).then(function (arr) {
              var o = {}; arr.forEach(function (x) { if (x) o[x.name] = x.items; }); return o;
            });
          });
        });
      },
      saveLists: function (lists) {
        var self = this;
        return Promise.all([S.getMeta('schema'), self._myTables()]).then(function (r) {
          var tables = (r[0] && r[0].tables) || {}, myTabs = r[1];
          var jobs = Object.keys(lists || {}).map(function (name) {
            return S._replace('_lists', name, { name: name, items: lists[name] || [], tables: LA.listOwningTables(tables, name) });
          });
          if (myTabs === null) { // only an admin (full view) may prune lists absent from the map
            return S._all('_lists').then(function (rows) {
              (rows || []).forEach(function (row) { if (!((lists || {})[row.key])) jobs.push(S.delete('_lists', row.key)); });
              return Promise.all(jobs);
            });
          }
          return Promise.all(jobs);
        });
      },
      putListItem: function (listName, value) {
        return Promise.all([S.getMeta('schema'), S.get('_lists', listName)]).then(function (r) {
          var tables = (r[0] && r[0].tables) || {};
          var doc = r[1] || { name: listName, items: [], tables: LA.listOwningTables(tables, listName) };
          var items = doc.items || [];
          if (items.indexOf(value) < 0) items = items.concat([value]); // arrayUnion
          return S._replace('_lists', listName, { name: listName, items: items, tables: LA.listOwningTables(tables, listName) });
        });
      },

      // --- User-linked lists: each row `_list_users/<id>` links a list VALUE to a user's email + cached
      // `shared` flag, mirroring backend-firebase.js. Only avatars (never emails) reach non-admin viewers. ---
      _linkDocId: function (listName, value) {
        return encodeURIComponent(String(listName)) + '~' + encodeURIComponent(String(value));
      },
      getListAvatars: function () {
        function join(rows, profiles) {
          profiles = profiles || {}; var out = {};
          (rows || []).forEach(function (row) {
            var v = row.value, p = profiles[String(v.email || '').toLowerCase()] || {}, entry = {};
            if (p.picture) entry.picture = p.picture;
            if (p.name) entry.name = p.name;   // `userlink-name` lists display this instead of the value
            if (entry.picture || entry.name) { (out[v.list] || (out[v.list] = {}))[v.value] = entry; }
          });
          return out;
        }
        // RLS returns only shared links to non-admins and every link to admins; join against whatever profiles
        // are readable (admins: all via getProfiles; others: the shared set).
        return S._all('_list_users').then(function (rows) {
          return users.getProfiles().then(function (p) {
            if (p && Object.keys(p).length) return join(rows, p);
            return users.getSharedProfiles().then(function (sp) { return join(rows, sp); });
          }).catch(function () {
            return users.getSharedProfiles().then(function (sp) { return join(rows, sp); });
          });
        }).catch(function () { return {}; });
      },
      getListUserLinks: function () {   // admin-only raw { list: { value: email } }
        return S._all('_list_users').then(function (rows) {
          var out = {}; (rows || []).forEach(function (row) { var v = row.value; (out[v.list] || (out[v.list] = {}))[v.value] = v.email; }); return out;
        });
      },
      // SELF-scoped mirror of the Firebase method: { listName: myValue }, the link that names ME. RLS lets a
      // member read their own link (see the _list_users read predicate), so `@me` can resolve to a curated
      // list value without exposing anyone else's mapping.
      getMyListValues: function () {
        var email = P.myEmail();
        if (!email) return Promise.resolve({});
        return S._all('_list_users').then(function (rows) {
          var out = {};
          (rows || []).forEach(function (row) {
            var v = row.value;
            if (v && String(v.email || '').toLowerCase() === email && v.list && !(v.list in out)) out[v.list] = v.value;
          });
          return out;
        }).catch(function () { return {}; });
      },
      setListUser: function (listName, value, email) {
        var self = this, id = self._linkDocId(listName, value);
        if (!email) return S.delete('_list_users', id).then(function () { return self._mirrorIdentity(listName, value, ''); });
        var e = String(email).toLowerCase();
        return S.get('_profiles', e).then(function (d) {
          return S._replace('_list_users', id, { list: String(listName), value: String(value), email: e, shared: !!(d && d.shared) });
        }).then(function () { return self._mirrorIdentity(listName, value, e); });
      },
      // See backend-firebase._mirrorIdentity: the rules need the caller's own value for a list and cannot
      // query for it, so it rides on the admin-write-only grant doc they already read.
      _mirrorIdentity: function (listName, value, email) {
        return S._all('_users').then(function (rows) {
          var writes = [];
          (rows || []).forEach(function (r) {
            var d = r.value || r, key = r.key || r.id, ident = Object.assign({}, d.identity || {});
            var had = ident[listName];
            if (email && key === email) { if (had === value) return; ident[listName] = value; }
            else if (had === value) { delete ident[listName]; }
            else return;
            writes.push(S._replace('_users', key, Object.assign({}, d, { identity: ident })));
          });
          return Promise.all(writes);
        }).catch(function () { /* non-admin or offline: the link itself is already written */ });
      },

      getTranslations: function (langCode) {
        return S.getMeta('lang_' + langCode).then(function (d) { return d || {}; });
      },
      updateTranslations: function (langCode, updates) {
        return S._merge('_meta', 'lang_' + langCode, updates);   // merge (Firestore set{merge:true})
      },
      createLanguage: function (code, name, keys) {
        return S.getMeta('languages').then(function (d) {
          var langs = H.addLanguage(d ? (d.list || []) : [], code, name);
          return S.setMeta('languages', { list: langs });
        }).then(function () {
          // Read first: an existing language keeps every string it already has, and every key the
          // caller did not mention. Import calls this for each language in the file, so writing the
          // blank seed straight over the document erased whichever translation pack was imported
          // first -- schema strings wiped by an app pack, or the reverse.
          return S.getMeta('lang_' + code).then(function (existing) {
            return S.setMeta('lang_' + code, H.seedTranslations(existing, keys));
          });
        });
      },
      deleteLanguage: function (code) {
        return S.getMeta('languages').then(function (d) {
          var langs = H.removeLanguage(d ? (d.list || []) : [], code);
          return S.setMeta('languages', { list: langs });
        }).then(function () {
          return S.delete('_meta', 'lang_' + code);
        });
      },
      renameLanguage: function (code, name) {
        return S.getMeta('languages').then(function (d) {
          var langs = H.renameLanguage(d ? (d.list || []) : [], code, name);
          return S.setMeta('languages', { list: langs });
        });
      }
    };

    // --- membership, profiles and access requests (the `backend_users` half of the contract) ------------
    var users = {
      // The CURRENT user's own access only (self-scoped) so non-admins never read the whole users map.
      getMyAccess: function () {
        var email = P.myEmail();
        if (!email) return Promise.resolve({ registered: false });
        return S.get('_users', email).then(function (v) {
          if (v) return { role: v.role, tables: v.tables || 'all' };
          return P.noUsers().then(function (none) { return none ? { bootstrap: true } : { registered: false }; });
        }).catch(function () { return { registered: false }; });
      },
      // Admin roster for the Users tab. Lists per-user rows; if empty, one-time ADDITIVE migration from a
      // legacy _meta/users map (e.g. data imported from a Firestore export) then returns it.
      getUsers: function () {
        return S._all('_users').then(function (rows) {
          if (rows && rows.length) {
            var o = {}; rows.forEach(function (row) { var v = row.value; o[row.key] = { role: v.role, user: v.user || row.key, tables: v.tables || 'all' }; });
            return o;
          }
          return S.getMeta('users').then(function (map) {
            if (!map || map._value) return {};
            var jobs = [], o = {};
            Object.keys(map).forEach(function (k) {
              var v = map[k] || {}, key = String(k).toLowerCase();
              var rec = { role: v.role, user: v.user || key, tables: v.tables || 'all' };
              jobs.push(S._replace('_users', key, rec)); o[key] = rec;
            });
            return Promise.all(jobs).then(function () { return o; }).catch(function () { return o; });
          }).catch(function () { return {}; });
        });
      },
      setUserRole: function (uid, role, user, tables) {
        var key = String(uid || '').toLowerCase();
        // READ FIRST -- see backend-firebase's setUserRole for why. `_replace` writes the whole row, so the
        // `identity` mirror setListUser put on this grant is gone unless it is carried forward, and the RLS
        // identity check treats a missing mirror as migration grace and permits any value.
        return S.get('_users', key).then(function (prev) {
          var rec = H.userGrantDoc(key, role, user, tables, (prev || {}).identity);
          // Source of truth = /_users/<key>; also mirror into the legacy _meta/users map so an admin
          // importing from / exporting to a Firestore deployment stays consistent.
          var patch = {}; patch[key] = rec;
          return Promise.all([
            S._replace('_users', key, rec),
            S._merge('_meta', 'users', patch)
          ]);
        });
      },
      removeUser: function (uid) {
        var key = String(uid || '').toLowerCase();
        return Promise.all([
          S.delete('_users', key),
          (key !== uid ? S.delete('_users', uid).catch(function () {}) : Promise.resolve()),
          S.getMeta('users').then(function (map) {
            if (!map || map._value) return;
            var changed = false;
            [uid, key].forEach(function (k) { if (k in map) { delete map[k]; changed = true; } });
            return changed ? S._replace('_meta', 'users', map) : undefined;
          }).catch(function () {})
        ]);
      },
      // --- Membership requests (self-service; admin approves) ---
      requestAccess: function (name, note) {
        var email = P.myEmail();
        if (!email) return Promise.reject(new Error('not signed in'));
        return S._replace('_access_requests', email, { email: email, name: name || '', note: note || '', ts: Date.now() });
      },
      getAccessRequests: function () {   // admin only
        return S._all('_access_requests').then(function (rows) {
          var o = {}; (rows || []).forEach(function (row) { o[row.key] = row.value; }); return o;
        });
      },
      removeAccessRequest: function (email) {
        return S.delete('_access_requests', String(email || '').toLowerCase());
      },
      // --- Opt-in display-name profiles (for user-backed lists / leaderboard identity) ---
      getMyProfile: function () {
        var email = P.myEmail();
        if (!email) return Promise.resolve({ name: '', shared: false, picture: '' });
        return S.get('_profiles', email)
          .then(function (d) { return d ? { name: d.name || '', shared: !!d.shared, picture: d.picture || '' } : { name: '', shared: false, picture: '' }; })
          .catch(function () { return { name: '', shared: false, picture: '' }; });
      },
      setMyProfile: function (name, shared, picture) {
        var email = P.myEmail();
        if (!email) return Promise.reject(new Error('not signed in'));
        return S._replace('_profiles', email, { name: name || '', shared: !!shared, picture: picture || '' });
      },
      // Names of users who opted to share. RLS returns shared profiles (plus own/admin); filter to shared.
      // Deliberately does NOT catch — a rejection is distinguishable from "nobody opted in".
      getSharedNames: function () {
        return S._all('_profiles').then(function (rows) {
          var out = [];
          (rows || []).forEach(function (row) { var v = row.value; if (v && v.shared) { var n = (v.name || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); } });
          return out.sort(function (a, b) { return a.localeCompare(b); });
        });
      },
      getSharedProfiles: function () {
        return S._all('_profiles').then(function (rows) {
          var o = {}; (rows || []).forEach(function (row) { var v = row.value; if (v && v.shared) o[row.key] = { name: v.name || '', picture: v.picture || '' }; }); return o;
        }).catch(function () { return {}; });
      },
      // Admin-only: seed/rename another user's profile display name. Merges name only so `shared` survives.
      setProfileName: function (email, name) {
        var k = String(email || '').toLowerCase();
        if (!k) return Promise.resolve();
        return S._merge('_profiles', k, { name: name || '' });
      },
      // Admin-only: every user's profile keyed by email, for the Users management table.
      getProfiles: function () {
        return S._all('_profiles').then(function (rows) {
          var o = {}; (rows || []).forEach(function (row) { o[row.key] = row.value; }); return o;
        }).catch(function () { return {}; });
      }
    };

    // --- optional platform capabilities ------------------------------------------------------------
    // Advertised only when the platform actually provides them: app-core probes for the METHOD (the image
    // uploader appears iff backend.uploadFile exists, live sync starts iff subscribeTable does), so a
    // stub that resolves to nothing would light up UI for something the host cannot do.
    if (typeof P.uploadFile === 'function') {
      backend.uploadFile = function (file, opts) { return P.uploadFile(file, opts); };
    }
    if (typeof P.subscribeTable === 'function') {
      backend.subscribeTable = function (tableId, tab, onChange) {
        return P.subscribeTable(storeName(tableId, tab), onChange);
      };
      if (P.subscribeLoads) backend.subscribeLoads = true;
    }

    return { backend: backend, users: users };
  }

  var M = { createKvBackend: createKvBackend };
  if (isNode) module.exports = M;
  else root.createKvBackend = createKvBackend;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
