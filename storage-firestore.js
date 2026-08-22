// storage-firestore.js -- Firestore storage adapter
// Same interface as StorageIDB so backends are interchangeable.
// Requires: firebase SDK loaded, _db set to firebase.firestore() instance
var StorageFirestore = (function() {
  function _col(store) { return _db.collection(store); }

  return {
    open: function() { return Promise.resolve(); },
    ensureStore: function(name) { return Promise.resolve(); },
    get: function(store, key) {
      return _col(store).doc(key).get().then(function(doc) {
        return doc.exists ? doc.data() : undefined;
      });
    },
    put: function(store, key, value) {
      return _col(store).doc(key).set(value, { merge: true });
    },
    delete: function(store, key) {
      return _col(store).doc(key).delete();
    },
    // `constraints` (from query.js) narrow the read in Firestore instead of in the browser, which on the
    // free plan is the difference between spending the daily document-read quota on rows the user sees
    // and on rows they do not.
    //
    // ONLY EVER CALLED FOR THE WHOLE-COLLECTION READ, and that restriction is load-bearing rather than
    // tidy. Firestore needs a COMPOSITE INDEX for any query constraining two or more fields, and this
    // project ships no firestore.indexes.json. The access-scoped read already spends its one field on
    // `owner`/`rosterPublic`, so adding a filter there would produce a two-field query that fails in
    // production with FAILED_PRECONDITION. Worse, the EMULATOR does not enforce index requirements --
    // it accepts the query and moves on -- so the test suite would stay green while the app broke for
    // real users. See backend-firebase._scopedRead, which deliberately does not pass constraints.
    getAll: function(store, constraints) {
      var q = _col(store);
      (constraints || []).forEach(function(c) {
        if (!c || c.op !== '==') return;              // unknown op: the caller's residual handles it
        q = q.where(c.field, '==', c.value);
      });
      return q.get().then(function(snap) {
        var rows = [];
        snap.forEach(function(doc) { rows.push(doc.data()); });
        return rows;
      });
    },
    // A single-constraint read. Firestore rules are not filters: a rule that tests document fields is
    // provable for a QUERY only when the query constrains those same fields, so a caller without a
    // blanket grant has to ask for the slice it is allowed to see rather than the whole collection
    // (which is denied outright, not filtered). See backend-firebase _scopedRead.
    getWhere: function(store, field, op, value) {
      return _col(store).where(field, op, value).get().then(function(snap) {
        var rows = [];
        snap.forEach(function(doc) { rows.push(doc.data()); });
        return rows;
      });
    },
    getMeta: function(key) {
      return _db.collection('_meta').doc(key).get().then(function(doc) {
        return doc.exists ? doc.data() : undefined;
      });
    },
    setMeta: function(key, value) {
      return _db.collection('_meta').doc(key).set(typeof value === 'object' ? value : { _value: value });
    },
    // No pending queue needed -- Firestore syncs directly
    getPending: function() { return Promise.resolve([]); },
    addPending: function() { return Promise.resolve(); },
    clearPending: function() { return Promise.resolve(); }
  };
})();
