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

// The documents are the ones backend-kv.js maps, so the contract is built from it. What stays below is
// where Firestore differs: the rules refuse a list query they cannot prove, a denied read throws, and it
// has batches, arrayUnion, field deletes and transactions.
var _kv = createKvBackend(StorageFirestore, {
  name: 'Firebase',
  myEmail: _myEmail,
  noUsers: function() { return Promise.resolve(false); },   // unread: _myTables and getMyAccess are Firestore's own
  // Upload a file to Firebase Storage under uploads/<user-email>/<ts>_<name>, resolving to its download
  // URL (stored in the row by the image column). The download URL carries an access token, so the <img>
  // renders regardless of Storage read rules. Presence of this method is what enables the image uploader;
  // backends without it fall back to a paste-a-URL input.
  uploadFile: function(file, opts) {
    if (!_storage) return Promise.reject(new Error('Firebase Storage not initialized'));
    var o = opts || {};
    var path;
    if (o.path) {
      // A caller-chosen STABLE path, overwritten in place. An image must never collide, so it gets the
      // timestamped path below; a calendar feed is the opposite -- its URL is a subscription, and a new
      // path per publish would silently strand every subscriber on the previous file.
      path = String(o.path);
    } else {
      var email = _myEmail() || 'anon';
      var safe = String((file && file.name) || 'file').replace(/[^\w.\-]+/g, '_');
      path = 'uploads/' + email + '/' + Date.now() + '_' + safe;
    }
    var meta = o.contentType ? { contentType: o.contentType } : undefined;
    return _storage.ref().child(path).put(file, meta).then(function(snap) { return snap.ref.getDownloadURL(); });
  },
  // Every stored path under `prefix`, for the feed sweep. listAll pages internally; files only.
  listFiles: function(prefix) {
    if (!_storage) return Promise.reject(new Error('Firebase Storage not initialized'));
    return _storage.ref().child(String(prefix || '').replace(/\/+$/, '')).listAll()
      .then(function(res) { return res.items.map(function(r) { return r.fullPath; }); });
  }
});
backend = _kv.backend;
var _kvSaveSchema = backend.saveSchema;
Object.assign(backend, {
  saveSchema: function(schema) {
    this._capacityMirror = null;   // re-read by _capacityFor: the capacity config is part of what this rewrites
    return _kvSaveSchema.call(this, schema);
  },
  getFolderConfig: function() {
    // A visitor may not read the config (it can hold a shared feed's link): they get none, not an error.
    return StorageFirestore.getMeta('config').then(function(d) { return d || null; }, function(e) { if (!_myEmail()) return null; throw e; });
  },
  // One-round-trip boot for Firebase: schema + languages + lists + all accessible table data, fetched
  // CONCURRENTLY (Promise.all). Firestore has no Sheets-style per-call rate limit, so concurrency is
  // safe here. Access-scoped via _myTables so denied collections are never queried (rules aren't
  // filters — querying a denied collection would throw). Replaces ~20 sequential round-trips.
  bootData: function() {
    var self = this;
    var DENIED = { __denied: true };
    return Promise.all([
      // Denied (not just missing) for a not-yet-registered user: /_meta reads require isRegistered().
      // Marked distinctly from "doc doesn't exist" so we don't mistake it for first-boot below and
      // try to write a default schema we have no permission to save.
      StorageFirestore.getMeta('schema').catch(function() { return DENIED; }),
      StorageFirestore.getMeta('languages').catch(function() { return DENIED; }),
      self.getLists().catch(function() { return {}; }),   // lists are optional — never let one denied read fail-fast the whole boot
      self._myTables()           // null = unrestricted; [] = none; [..] = restricted set
    ]).then(function(r) {
      if (r[0] === DENIED) return { schema: null, denied: true };
      if (!r[0]) return { schema: null }; // first boot -> client saves the bundled default
      var parsed = BackendHelpers.unwrapSchemaDoc(r[0]);
      var tables = (parsed && parsed.tables) || {};
      var languages = (r[1] !== DENIED && r[1] && (r[1].list || [])) || [];
      var lists = r[2] || {};
      var allowed = r[3];
      // Boot fetches NO table data. This used to read the active partition of every granted table (plus
      // the archive of every archivable one) before a single view opened, which was the whole Firestore
      // read bill -- tables nobody looked at, read on every boot, against the free plan's scarcest
      // quota. A view now loads its own tables when it opens, through app-core's _ensureCached, which
      // already had to exist for navigation.
      //
      // Deliberately not "fetch what the LANDING view needs": that question already has an
      // implementation in app-core (_viewTables), which understands every view kind including a
      // doc-view's markdown embeds and the page body an admin has edited since. Answering it a second
      // time here -- in a layer that can see neither -- would be a second implementation free to drift,
      // and a view whose tables were never fetched renders blank exactly like one that was denied.
      // unrestricted: false tells the caller not to auto-seed/write shared list scaffolding -- a
      // restricted editor's writes to lists outside their own tables would be denied wholesale
      // (Firestore batch commits are atomic), whereas an admin/bootstrap (allowed === null) may.
      return { schema: parsed, tableOrder: Object.keys(tables), languages: languages, lists: lists, data: {}, unrestricted: allowed === null };
    });
  },
  // Read a table the caller may not hold a blanket grant on. Rules are not filters: with no table
  // grant, the read rule is provable only from a constraint on `owner` or `rosterPublic`, so an
  // unconstrained collection read is DENIED — the whole self-service read (RSVP, sign-ups, a shared
  // chore log) used to fail and get swallowed into an empty table. Ask for exactly the two slices the
  // rules can prove and merge them: my own rows, plus the rows marked public.
  // `constraints` are pushed ONLY on the granted branch. The scoped branch already spends Firestore's
  // single-field budget on owner/rosterPublic, and a second field there needs a composite index this
  // project does not ship -- it would fail in production while the emulator waved it through. Returning
  // a superset from that branch is explicitly allowed by the contract: the caller re-filters.
  _scopedRead: function(store, tableId, constraints) {
    return this._myTables().then(function(tabs) {
      if (tabs === null || tabs.indexOf(tableId) >= 0) return StorageFirestore.getAll(store, constraints); // granted: whole collection
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
  getTableData: function(tableId, tab, opts) {
    var store = _storeName(tableId, tab);
    return this._scopedRead(store, tableId, opts && opts.constraints).then(function(rows) {
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
  // A listener's FIRST snapshot carries every matching document, and Firestore bills a read for each
  // one of them. So a table that was fetched and then subscribed was paid for twice, in full. This
  // emits that first snapshot as a single { type:'sync', rows } and the caller uses it as the load,
  // which is why `subscribeLoads` is advertised below.
  subscribeLoads: true,
  subscribeTable: function(tableId, tab, onChange) {
    var store = _storeName(tableId, tab);
    var unsubs = [], stopped = false;
    // Which of the queries currently matches each doc id. In the two-query (self-service) case a doc
    // leaving ONE query fires 'removed' there while it is still visible through the other — e.g. a row
    // whose rosterPublic flips false is still mine. Emitting a delete on that would make the row vanish
    // from a user who can still see it, so a delete is emitted only once the id has left both queries.
    var presence = {};
    // First-snapshot bookkeeping. `pending` counts the queries yet to deliver theirs; until it reaches
    // zero the docs are accumulated by id rather than emitted, so the two self-service queries merge
    // into ONE sync instead of racing each other to half-populate the cache.
    var pending = 0, delivered = 0, first = {}, merged = {};
    function emitSync() {
      var rows = Object.keys(merged).map(function(k) { return merged[k]; });
      merged = {};
      onChange({ type: 'sync', rows: rows });
    }
    function onSnap(qi, snap) {
      if (!first[qi]) {
        first[qi] = true;
        // Populate `presence` here too: a later 'removed' for one of these docs has to know the doc was
        // matched, or the delete would be dropped as unknown.
        snap.docChanges().forEach(function(c) {
          (presence[c.doc.id] || (presence[c.doc.id] = {}))[qi] = true;
          merged[c.doc.id] = c.doc.data();
        });
        delivered++;
        if (--pending === 0) emitSync();
        return;
      }
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
    // Every path that ends without a live subscription must say so, or the caller waits for a load that
    // is never coming and the view stays blank with nothing to explain it.
    function giveUp() { if (!stopped) onChange({ type: 'sync-failed' }); }
    this._myTables().then(function(tabs) {
      if (stopped) return;
      var queries;
      if (tabs === null || tabs.indexOf(tableId) >= 0) {
        queries = [_db.collection(store)];
      } else {
        var me = _myEmail();
        if (!me) { giveUp(); return; }
        queries = [
          _db.collection(store).where('owner', '==', me),
          _db.collection(store).where('rosterPublic', '==', true)
        ];
      }
      pending = queries.length;
      queries.forEach(function(q, qi) {
        // A denied read must degrade to "no live updates", never to an exception thrown out of a
        // snapshot callback — but it must no longer degrade SILENTLY, now that the caller may be
        // waiting on this snapshot for its rows.
        unsubs.push(q.onSnapshot(function(snap) { onSnap(qi, snap); }, function() {
          if (first[qi]) return;                       // already delivered once; just stop updating
          first[qi] = true;
          // One query denied does not mean no rows: in the self-service pair, `owner` may be readable
          // while `rosterPublic` is not. Fall back only when NOTHING arrived.
          if (--pending === 0) { if (delivered) emitSync(); else giveUp(); }
        }));
      });
    }).catch(giveUp);
    return function() {
      stopped = true;
      unsubs.forEach(function(u) { try { u(); } catch (e) {} });
      unsubs = [];
    };
  },
  putRow: function(tableId, data, tab) {
    if (!data.id) return Promise.resolve();
    var self = this;
    return self._capacityFor(tableId, tab).then(function(cfg) {
      return cfg ? self._capacityWrite(tableId, cfg, data.id, data)
                 : StorageFirestore.put(_storeName(tableId, tab), data.id, data);
    });
  },
  deleteRow: function(tableId, id, tab) {
    var self = this;
    return self._capacityFor(tableId, tab).then(function(cfg) {
      return cfg ? self._capacityWrite(tableId, cfg, id, null)
                 : StorageFirestore.delete(_storeName(tableId, tab), id);
    });
  },
  // CAPACITY (a response table's `capacity`; the config rides in _meta/ownerTables). The rules cannot
  // count, so a response that takes or gives up a place is written TOGETHER with the event's count,
  // moved by one, and `lastBooking` naming the response -- the batch firestore.rules checks from both
  // sides (capCreateOk/capUpdateOk/capDeleteOk and capacityBump). A transaction rather than a batch so
  // the count it moves is the one stored now: two members taking the last place are serialized, and the
  // second retries, re-reads, and is refused here as full rather than by a bare rules denial.
  // Only the `active` partition holds places, as in the rules and the Postgres trigger.
  _capacityFor: function(tableId, tab) {
    if ((tab || 'active') !== 'active') return Promise.resolve(null);
    var self = this;
    if (!self._capacityMirror) {
      self._capacityMirror = StorageFirestore.getMeta('ownerTables')
        .then(function(d) { return (d && d.capacity) || null; }, function() { return null; });
    }
    return self._capacityMirror.then(function(c) { return (c && c.responses && c.responses[tableId]) || null; });
  },
  _capacityWrite: function(tableId, cfg, id, data) {
    var bRef = _db.collection(_storeName(tableId, 'active')).doc(id);
    var holds = function(r) { return !!r && BackendHelpers.capacityHolds(cfg, r[cfg.status]); };
    // The stored response is read OUTSIDE the transaction: a member may not read a response that does
    // not exist yet (the read rule needs a row to test), and a transaction read that is refused aborts
    // the whole transaction. A row only its owner writes cannot change under them anyway.
    return bRef.get().then(function(s) { return s.exists ? s.data() : null; }, function() { return null; }).then(function(old) {
      var next = data === null ? null : Object.assign({}, old || {}, data);
      var was = holds(old), now = holds(next), ev = (next || old || {})[cfg.link];
      var write = function(tx) { if (data === null) tx.delete(bRef); else tx.set(bRef, data, { merge: true }); };
      if (was === now || !ev) return _db.runTransaction(function(tx) { write(tx); return Promise.resolve(); });
      var eRef = _db.collection(_storeName(cfg.events, 'active')).doc(ev);
      return _db.runTransaction(function(tx) {
        return tx.get(eRef).then(function(es) {
          var e = es.exists ? es.data() : {}, n = Number(e[cfg.count]) || 0, cap = e[cfg.capacity], d = now ? 1 : -1;
          var res = cfg.reserved && typeof e[cfg.reserved] === 'number' ? e[cfg.reserved] : 0;   // walk-ins
          if (d > 0 && typeof cap === 'number' && n + res + 1 > cap) throw new Error('capacity: ' + ev + ' is full');
          var bump = { lastBooking: id, updated_at: new Date().toISOString() };
          bump[cfg.count] = n + d;
          tx.set(eRef, bump, { merge: true });
          write(tx);
        });
      });
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
  saveLists: function(lists) {
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
  putListItem: function(listName, value) {
    return StorageFirestore.getMeta('schema').then(function(s) {
      var tables = (s && s.tables) || {};
      return _db.collection('_lists').doc(listName).set(
        { name: listName, items: firebase.firestore.FieldValue.arrayUnion(value), tables: listOwningTables(tables, listName) },
        { merge: true });
    });
  },
  // Viewer-safe { list: { value: { picture, name } } } projection. Tries the admin read (all links,
  // joined against every profile incl. unshared); on denial falls back to the shared-only query any
  // registered user may run. Never returns an email.
  //
  // The join is ListUsers.projectLinks -- the one this file used to keep an inline copy of, on the
  // grounds of a load-order dependency that no longer exists: index.html awaits appModulesReady (which
  // carries list-users.js) BEFORE it loads any backend file. Both reads are gated by the rules before
  // they get here, so what arrives is already the viewer's slice.
  getListAvatars: function() {
    function records(snap) { var out = []; snap.forEach(function(d) { out.push(d.data()); }); return out; }
    return _db.collection('_list_users').get()
      .then(function(snap) { return backend_users.getProfiles().then(function(p) { return ListUsers.projectLinks(records(snap), p); }); })
      .catch(function() {
        return _db.collection('_list_users').where('shared', '==', true).get()
          .then(function(snap) { return backend_users.getSharedProfiles().then(function(p) { return ListUsers.projectLinks(records(snap), p); }); })
          .catch(function() { return {}; });
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
  // update(), not set(merge): only update() removes a field. Each key as a FieldPath, because a string
  // path reads `field.topic` as a nested field. A missing doc has nothing to remove.
  deleteTranslations: function(langCode, keys) {
    if (!keys || !keys.length) return Promise.resolve();
    var ref = _db.collection('_meta').doc('lang_' + langCode), args = [];
    keys.forEach(function(k) { args.push(new firebase.firestore.FieldPath(k), firebase.firestore.FieldValue.delete()); });
    return ref.update.apply(ref, args).catch(function(e) { if (!e || e.code !== 'not-found') throw e; });
  }
});

function initFirebase() {
  // The ACTIVE database's config (Databases.config), not a single global key: one browser profile may
  // hold several Firebase projects, and which one this is was decided before the backend loaded.
  var config = Databases.config('firebase') || window.FIREBASE_CONFIG || {};
  if (config.apiKey) { _startFirebase(config); return; }
  fetch(_u('/firebase-config.json')).then(function(r) { return r.ok ? r.json() : null; }).then(function(c) {
    if (c && c.apiKey) { Databases.remember('firebase', c); _startFirebase(c); }
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
  // Arrived from an emailed sign-in link: finish it here (the auth listener below then boots the account),
  // or -- opened in another browser, with no address remembered -- ask for the address first.
  if (_auth.isSignInWithEmailLink && _auth.isSignInWithEmailLink(location.href)) {
    var linkEmail = ''; try { linkEmail = localStorage.getItem(EMAIL_FOR_LINK) || ''; } catch (e) {}
    if (linkEmail) authEmailVerify(linkEmail).catch(function(e) { appInstance.authError = (e && e.message) || String(e); appInstance.signInOpen = true; });
    else { appInstance.authLinkPending = true; appInstance.signInOpen = true; }
  }
  _auth.onAuthStateChanged(function(user) {
    if (typeof window !== 'undefined' && window.bootMark) window.bootMark('authReady'); // auth RTT resolved
    // Signed in after browsing as a visitor: start again as the account rather than booting twice.
    if (user && appInstance.visitorMode) { location.reload(); return; }
    if (user) { appInstance.currentUserEmail = user.email; init(); return; }
    // Signed out. A database with public tables lets a visitor in (its schema is then readable with no
    // account); any other asks them to sign in, exactly as before.
    // The answer is ignored if someone signed in meanwhile: a probe that resolves after a sign-in would
    // otherwise switch the signed-in session into visitor mode (and the next sign-in would reload the page).
    _db.collection('_meta').doc('schema').get().then(function(d) {
      if (_auth.currentUser) return;
      if (!d.exists) throw new Error('no public schema');
      appInstance.currentUserEmail = ''; appInstance.visitorMode = true; init();
    }).catch(function() { if (_auth.currentUser) return; appInstance.needsReauth = true; appInstance.loading = false; });
  });
}

// Email sign-in: Firebase emails a sign-in LINK (no code), which proves the mailbox -- the token then says
// email_verified, which is what the rules require. The address is kept to finish the sign-in when the link
// opens in this browser; opened elsewhere, the dialog asks for it again.
var EMAIL_FOR_LINK = 'dbui_email_for_link';
function authEmailStart(email) {
  try { localStorage.setItem(EMAIL_FOR_LINK, email); } catch (e) {}
  return _auth.sendSignInLinkToEmail(email, { url: location.origin + location.pathname, handleCodeInApp: true })
    .then(function() { return { code: false }; });
}
// Finish a link sign-in (`code` is unused: Firebase has none). Called on load, or from the dialog.
function authEmailVerify(email) {
  return _auth.signInWithEmailLink(email, location.href).then(function() {
    try { localStorage.removeItem(EMAIL_FOR_LINK); } catch (e) {}
    history.replaceState(null, '', location.origin + location.pathname);
  });
}

function triggerOAuth() {
  var provider = new firebase.auth.GoogleAuthProvider();
  _auth.signInWithPopup(provider).catch(function(e) { console.error('Firebase auth error:', e); });
}

var backend_users = _kv.users;
var _kvSetUserRole = backend_users.setUserRole, _kvSelfRegister = backend_users.selfRegister;
Object.assign(backend_users, {
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
  // Re-granting or registering changes the memoized read scope (_myTables).
  setUserRole: function() { backend._myTablesPromise = null; return _kvSetUserRole.apply(this, arguments); },
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
  selfRegister: function() { backend._myTablesPromise = null; return _kvSelfRegister.apply(this, arguments); },
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
  }
});

initFirebase();
