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
    getAll: function(store) {
      return _col(store).get().then(function(snap) {
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
