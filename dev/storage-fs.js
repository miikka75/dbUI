// storage-fs.js -- JSON file storage adapter
// Implements the same data interface as backend-local.js (SQLite) but stores as JSON files
const fs = require('fs');
const path = require('path');
const H = require('../backend-helpers');

function createFsBackend(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  var ROOT = path.resolve(dataDir);
  // Resolve a name under dataDir, rejecting any path that escapes it (path traversal guard).
  function safePath(name) {
    var p = path.resolve(ROOT, name);
    if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw new Error('Invalid path: ' + name);
    return p;
  }
  function filePath(name) { return safePath(name + '.json'); }
  function readJSON(name) { try { return JSON.parse(fs.readFileSync(filePath(name), 'utf8')); } catch(e) { return null; } }
  function writeJSON(name, data) { fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2)); }
  // Drive-compatible metadata filenames (so the local folder mirrors a Drive folder)
  var F_SCHEMA = 'schema', F_CONFIG = '.app-config', F_LISTS = 'lists', F_LANGS = 'languages', F_LISTUSERS = 'listusers';
  function fLang(code) { return 'lang_' + code; }

  return {
    getSchema() {
      return readJSON(F_SCHEMA) || null;
    },
    saveSchema(schema) {
      writeJSON(F_SCHEMA, schema);
    },
    validateFolder(folderId) {
      return { valid: true, name: 'Local FS: ' + dataDir };
    },
    getFolderConfig() {
      return readJSON(F_CONFIG) || null;
    },
    setFolderConfig(config) {
      writeJSON(F_CONFIG, config);
    },
    initSchema(schema) {
      var result = {};
      for (var table of Object.keys(schema)) {
        var def = schema[table];
        var tabs = [(def.partition || 'active')];
        if (def.archivePartition) tabs.push(def.archivePartition);
        for (var tab of tabs) {
          var f = table + '__' + tab;
          if (!readJSON(f)) writeJSON(f, []);
        }
        result[table] = table;
      }
      return result;
    },
    getAvailableTables() { return []; },
    getAvailableLanguages() {
      return readJSON(F_LANGS) || [];
    },
    getTableData(tableId, tab) {
      var f = H.storeName(tableId, tab);
      var rows = readJSON(f) || [];
      return { headers: H.deriveHeaders(rows), rows: rows };
    },
    putRow(tableId, data, tab) {
      var f = H.storeName(tableId, tab);
      var rows = readJSON(f) || [];
      var idx = rows.findIndex(function(r) { return r.id === data.id; });
      if (idx >= 0) Object.assign(rows[idx], data); else rows.push(data);
      writeJSON(f, rows);
    },
    deleteRow(tableId, id, tab) {
      var f = H.storeName(tableId, tab);
      var rows = readJSON(f) || [];
      var filtered = rows.filter(function(r) { return r.id !== id; });
      writeJSON(f, filtered);
      return filtered.length < rows.length;
    },
    moveRow(tableId, rowData, fromTab, toTab) {
      this.deleteRow(tableId, rowData.id, fromTab);
      this.putRow(tableId, rowData, toTab);
    },
    getLists() {
      return readJSON(F_LISTS) || {};
    },
    saveLists(lists) {
      writeJSON(F_LISTS, lists);
    },
    putListItem(listName, value) {
      var lists = readJSON(F_LISTS) || {};
      lists[listName] = lists[listName] || [];
      if (lists[listName].indexOf(value) === -1) lists[listName].push(value);
      writeJSON(F_LISTS, lists);
    },
    // User-linked lists (Option C): the admin-only { listName: { value: email } } link map. Stored whole;
    // the server derives the viewer-safe projection from it (see list-users.js / getListAvatars).
    getListUsers() {
      return readJSON(F_LISTUSERS) || {};
    },
    saveListUsers(map) {
      writeJSON(F_LISTUSERS, map || {});
    },
    getTranslations(code) {
      return readJSON(fLang(code)) || {};
    },
    updateTranslations(code, updates) {
      var t = readJSON(fLang(code)) || {};
      Object.assign(t, updates);
      writeJSON(fLang(code), t);
    },
    createLanguage(code, name, keys) {
      writeJSON(F_LANGS, H.addLanguage(readJSON(F_LANGS), code, name));
      writeJSON(fLang(code), H.emptyTranslations(keys));
      return code;
    },
    deleteLanguage(code) {
      writeJSON(F_LANGS, H.removeLanguage(readJSON(F_LANGS), code));
      try { fs.unlinkSync(filePath(fLang(code))); } catch(e) {}
    },
    renameLanguage(code, name) {
      writeJSON(F_LANGS, H.renameLanguage(readJSON(F_LANGS), code, name));
    },
    resetData() {
      var files = fs.readdirSync(dataDir);
      files.forEach(function(f) {
        var p = path.join(dataDir, f);
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
        else fs.rmSync(p, { recursive: true });
      });
    },
    close() {}
  };
}

module.exports = { createFsBackend };
