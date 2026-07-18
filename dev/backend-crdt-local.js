// backend-crdt-local.js -- Local CRDT initializer.
// Wires the shared crdt-backend.js to TransportLocal (local dev server).
// Requires (loaded before): dev-client.js (_post, backend_users), crdt-engine.js,
// storage-idb.js, transport-local.js, crdt-backend.js.
Transport = TransportLocal;
if (typeof _devUploadFile === 'function' && typeof backend !== 'undefined') backend.uploadFile = _devUploadFile; // image-column upload (dev store)

// Open IDB + init engine, then boot the app. initSchema also awaits _crdtReady.
window._crdtReady = StorageIDB.open().then(function() {
  return CrdtEngine.init(StorageIDB, TransportLocal);
});
window._crdtReady.then(function() { init(); });
