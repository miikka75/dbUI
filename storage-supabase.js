// storage-supabase.js -- Supabase (Postgres) storage adapter.
// Same interface as StorageFirestore / StorageIDB so backends are interchangeable. Firestore is a
// document store; Supabase is Postgres. We model the identical shape with ONE generic key-value table so
// every per-doc Firestore rule maps to a per-ROW RLS policy (see supabase-schema.sql):
//
//   create table kv ( store text, key text, value jsonb, primary key (store, key) );
//   Firestore  _col(store).doc(key).data   <->   kv row (store, key, value)
//
// Browser: <script src="/storage-supabase.js"> defines the global createSupabaseStorage(sb); backend-
//          supabase.js builds StorageSupabase from it once the client exists (mirrors how storage-
//          firestore.js's IIFE closes over the _db global).
// Node   : require('../storage-supabase') -> { createSupabaseStorage } (used by the unit test).
function createSupabaseStorage(sb) {
  var TABLE = 'kv';

  // Unwrap a PostgREST result, throwing on error so callers' .catch() fires like Firestore's.
  function _unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  function _row(store, key) {
    return sb.from(TABLE).select('value').eq('store', store).eq('key', key).maybeSingle()
      .then(_unwrap).then(function(r) { return r ? r.value : undefined; });
  }

  // Whole-row replace (Firestore set() WITHOUT merge — used by setMeta).
  function _replace(store, key, value) {
    return sb.from(TABLE).upsert({ store: store, key: key, value: value }, { onConflict: 'store,key' })
      .then(_unwrap);
  }

  // Shallow top-level merge (Firestore set(value, { merge: true })). Read-modify-write: per-doc payloads
  // are small, so the extra round-trip is negligible and keeps merge semantics exact.
  function _merge(store, key, patch) {
    return _row(store, key).then(function(existing) {
      return _replace(store, key, Object.assign({}, existing || {}, patch || {}));
    });
  }

  return {
    // --- interface shared with StorageFirestore / StorageIDB ---
    open: function() { return Promise.resolve(); },
    ensureStore: function() { return Promise.resolve(); },
    get: function(store, key) { return _row(store, key); },
    // Firestore's put() merges; mirror that so partial row/meta updates don't drop fields.
    put: function(store, key, value) { return _merge(store, key, value); },
    delete: function(store, key) {
      return sb.from(TABLE).delete().eq('store', store).eq('key', key).then(_unwrap);
    },
    getAll: function(store) {
      return sb.from(TABLE).select('value').eq('store', store).then(_unwrap).then(function(rows) {
        return (rows || []).map(function(r) { return r.value; });
      });
    },
    getMeta: function(key) { return _row('_meta', key); },
    // setMeta REPLACES the doc (no merge), matching StorageFirestore.setMeta. Non-object values are boxed
    // as { _value } so BackendHelpers unwrapping is identical.
    setMeta: function(key, value) {
      return _replace('_meta', key, (typeof value === 'object' && value !== null) ? value : { _value: value });
    },
    // No pending queue -- Supabase writes go straight to Postgres (like Firestore).
    getPending: function() { return Promise.resolve([]); },
    addPending: function() { return Promise.resolve(); },
    clearPending: function() { return Promise.resolve(); },

    // --- Supabase-only helpers for the collection-style queries backend-supabase.js needs
    // (Firestore exposes _db.collection(...).where(...); these are the kv-table equivalents). ---
    _all: function(store) {
      return sb.from(TABLE).select('key,value').eq('store', store).then(_unwrap).then(function(r) { return r || []; });
    },
    _replace: _replace,
    _merge: _merge
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createSupabaseStorage: createSupabaseStorage };
