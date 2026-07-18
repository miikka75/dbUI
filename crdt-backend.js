// crdt-backend.js -- Unified CRDT backend (data via CrdtEngine+StorageIDB, files via Transport)
// Requires: crdt-engine.js, storage-idb.js, and a Transport (TransportDrive or TransportLocal).
// Metadata files (Drive-compatible names): schema.json, .app-config.json, lists.json,
// languages.json, lang_{code}.json. Table data lives in IDB + _sync changesets.
backend = {
  getSchema: function(folderId) { return Transport.readJson('schema.json'); },
  saveSchema: function(folderId, schema) { return Transport.writeJson('schema.json', schema); },
  validateFolder: function(id) { return Transport.validateFolder(id); },
  getFolderConfig: function(folderId) { return Transport.readJson('.app-config.json'); },
  setFolderConfig: function(folderId, config) { return Transport.writeJson('.app-config.json', config); },
  initSchema: function(folderId, schema) {
    if (Transport.setFolder) Transport.setFolder(folderId);
    var tables = Object.keys(schema);
    var needed = [];
    tables.forEach(function(t) {
      var def = schema[t];
      needed.push(t + '__active');
      if (def && def.archivable) needed.push(t + '__archive');
    });
    return (window._crdtReady || Promise.resolve()).then(function() {
      return StorageIDB.ensureStores(needed);
    }).then(function() {
      return CrdtEngine.startSync(30000);
    }).then(function() {
      var result = {}; tables.forEach(function(t) { result[t] = t; }); return result;
    });
  },
  getAvailableTables: function() { return Promise.resolve([]); },
  getAvailableLanguages: function(folderId) { return Transport.readJson('languages.json').then(function(l) { return l || []; }); },
  getTableData: function(tableId, tab) { return CrdtEngine.getTableData(tableId, tab); },
  putRow: function(tableId, data, tab) { return CrdtEngine.putRow(tableId, data, tab); },
  deleteRow: function(tableId, id, tab) { return CrdtEngine.deleteRow(tableId, id, tab); },
  moveRow: function(tableId, rowData, fromTab, toTab) { return CrdtEngine.moveRow(tableId, rowData, fromTab, toTab); },
  getLists: function(folderId) { return Transport.readJson('lists.json').then(function(l) { return l || {}; }); },
  saveLists: function(folderId, lists) { return Transport.writeJson('lists.json', lists); },
  putListItem: function(folderId, listName, value) {
    return Transport.readJson('lists.json').then(function(lists) {
      lists = lists || {};
      lists[listName] = lists[listName] || [];
      if (lists[listName].indexOf(value) === -1) lists[listName].push(value);
      return Transport.writeJson('lists.json', lists);
    });
  },
  getTranslations: function(folderId, langCode) { return Transport.readJson('lang_' + langCode + '.json').then(function(t) { return t || {}; }); },
  updateTranslations: function(folderId, langCode, updates) {
    return Transport.readJson('lang_' + langCode + '.json').then(function(t) {
      t = t || {};
      Object.keys(updates).forEach(function(k) { t[k] = updates[k]; });
      return Transport.writeJson('lang_' + langCode + '.json', t);
    });
  },
  createLanguage: function(folderId, code, name, keys) {
    return Transport.readJson('languages.json').then(function(langs) {
      return Transport.writeJson('languages.json', BackendHelpers.addLanguage(langs, code, name));
    }).then(function() {
      return Transport.writeJson('lang_' + code + '.json', BackendHelpers.emptyTranslations(keys));
    });
  },
  deleteLanguage: function(folderId, code) {
    return Transport.readJson('languages.json').then(function(langs) {
      return Transport.writeJson('languages.json', BackendHelpers.removeLanguage(langs, code));
    }).then(function() { return Transport.deleteFile('lang_' + code + '.json'); });
  },
  renameLanguage: function(folderId, code, name) {
    // Update only the languages index entry; the lang_<code>.json translations file is untouched.
    return Transport.readJson('languages.json').then(function(langs) {
      return Transport.writeJson('languages.json', BackendHelpers.renameLanguage(langs, code, name));
    });
  },
  getFileModifiedTime: function() { return Promise.resolve(new Date().toISOString()); },
  saveChangesets: function() { return CrdtEngine.pushChanges(); },
  loadChangesets: function() { return CrdtEngine.pullChanges(); }
};
