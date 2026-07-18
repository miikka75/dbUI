// backend-crdt.js -- Drive CRDT initializer.
// Wires the shared crdt-backend.js to TransportDrive.
// Requires (loaded before): auth-oauth.js (_token/_fetch), crdt-engine.js,
// storage-idb.js, transport-drive.js, crdt-backend.js.
Transport = TransportDrive;

// Open IDB + init the CRDT engine; initSchema awaits this via _crdtReady.
// init() is triggered by index.html's OAuth flow once a token is available.
window._crdtReady = StorageIDB.open().then(function() {
  return CrdtEngine.init(StorageIDB, TransportDrive);
});
