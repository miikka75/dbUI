// backend-local.js — Local SQLite backend implementing same interface as Code.gs
const Database = require('better-sqlite3');
const H = require('../backend-helpers');

function createLocalBackend(dbPath) {
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');

  // Quote a SQL identifier safely: wrap in "" and escape embedded quotes (blocks identifier injection).
  function qid(n) { return '"' + String(n).replace(/"/g, '""') + '"'; }

  // multiselect columns are stored as JSON-encoded arrays in TEXT cells (SQLite has no array type).
  // Return a set of multiselect column names for a table, read from the stored schema.
  function msMultiCols(tableId) {
    try {
      var row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('schema');
      if (!row) return {};
      var def = (JSON.parse(row.value).tables || {})[tableId];
      var out = {}, cols = def && def.columns;
      if (Array.isArray(cols)) {
        // Authored/stored form: columns is an array of {name,type,...} objects.
        cols.forEach(function(d) { if (d && typeof d === 'object' && d.type === 'multiselect' && d.name) out[d.name] = true; });
      } else if (cols) {
        // Normalized colMap form: { <name>: {type,...} }.
        Object.keys(cols).forEach(function(c) { var d = cols[c]; if (d && typeof d === 'object' && d.type === 'multiselect') out[c] = true; });
      }
      return out;
    } catch (e) { return {}; }
  }

  // Owning tables of a list = tables with a column referencing it (list or listSwitch.list).
  // Mirrors listOwningTables in schema-loader.html; used to stamp each per-list row.
  function _listOwning(listName) {
    try {
      var row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('schema');
      var tables = row ? (JSON.parse(row.value).tables || {}) : {};
      var out = [];
      Object.keys(tables).forEach(function(t) {
        var cols = (tables[t] && tables[t].columns) || {};
        var defs = Array.isArray(cols) ? cols : Object.keys(cols).map(function(k) { return cols[k]; });
        if (defs.some(function(d) { return d && typeof d === 'object' && (d.list === listName || (d.listSwitch && d.listSwitch.list === listName)); })) out.push(t);
      });
      return out;
    } catch (e) { return []; }
  }
  // Per-list storage: one row per list { name PRIMARY KEY, items JSON, tables JSON } — shape parity
  // with Firebase _lists/{name}. Lazily migrates the legacy (name, value) one-row-per-item table.
  function _ensureLists() {
    db.exec('CREATE TABLE IF NOT EXISTS _lists (name TEXT PRIMARY KEY, items TEXT, tables TEXT)');
    var cols = db.pragma('table_info(_lists)');
    var hasValue = cols.some(function(c) { return c.name === 'value'; });
    var hasItems = cols.some(function(c) { return c.name === 'items'; });
    if (hasValue && !hasItems) {
      var old = db.prepare('SELECT name, value FROM _lists').all();
      var map = {};
      old.forEach(function(r) { (map[r.name] = map[r.name] || []).push(r.value); });
      db.transaction(function() {
        db.exec('DROP TABLE _lists');
        db.exec('CREATE TABLE _lists (name TEXT PRIMARY KEY, items TEXT, tables TEXT)');
        var ins = db.prepare('INSERT INTO _lists (name, items, tables) VALUES (?, ?, ?)');
        Object.keys(map).forEach(function(n) { ins.run(n, JSON.stringify(map[n]), JSON.stringify(_listOwning(n))); });
      })();
    }
  }

  // Internal: folder config storage
  db.exec('CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT)');
  // Internal: track table metadata
  db.exec('CREATE TABLE IF NOT EXISTS _tables (name TEXT PRIMARY KEY, columns TEXT)');
  // Internal: language files
  db.exec('CREATE TABLE IF NOT EXISTS _languages (code TEXT PRIMARY KEY, name TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS _translations (code TEXT, key TEXT, text TEXT, PRIMARY KEY(code, key))');

  // Schema storage table
  db.exec('CREATE TABLE IF NOT EXISTS _schema (key TEXT PRIMARY KEY, value TEXT)');

  return {
    getSchema(folderId) {
      const row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('schema');
      if (row) return JSON.parse(row.value);
      return null;
    },

    saveSchema(folderId, schema) {
      db.prepare('INSERT OR REPLACE INTO _schema (key, value) VALUES (?, ?)').run('schema', JSON.stringify(schema));
    },

    validateFolder(folderId) {
      // Locally, any non-empty ID is valid
      if (!folderId) return { valid: false, name: null };
      return { valid: true, name: 'Local Folder' };
    },

    getFolderConfig(folderId) {
      const row = db.prepare('SELECT value FROM _config WHERE key = ?').get('folder-config');
      return row ? JSON.parse(row.value) : null;
    },

    setFolderConfig(folderId, config) {
      db.prepare('INSERT OR REPLACE INTO _config (key, value) VALUES (?, ?)').run('folder-config', JSON.stringify(config));
    },

    initSchema(folderId, schema) {
      const result = {};
      for (const [table, def] of Object.entries(schema)) {
        const declared = Array.isArray(def.columns) ? def.columns.map(c => typeof c === 'object' ? c.name : c).filter(Boolean) : Object.keys(def.columns);
        const columns = ['id'].concat(declared.filter(c => c !== 'id')); // id is implicit -> always present, first, PK
        const cols = columns.map(c => c === 'id' ? qid(c) + ' TEXT PRIMARY KEY' : qid(c) + ' TEXT').join(', ');
        // Create base + tab-suffixed tables
        const tabs = [table];
        if (def.partition) tabs.push(table + '__' + def.partition);
        if (def.archivePartition) tabs.push(table + '__' + def.archivePartition);
        for (const t of tabs) {
          db.exec('CREATE TABLE IF NOT EXISTS ' + qid(t) + ' (' + cols + ')');
          const info = db.pragma('table_info(' + qid(t) + ')');
          const existing = info.map(r => r.name);
          for (const col of columns) {
            if (!existing.includes(col)) {
              db.exec('ALTER TABLE ' + qid(t) + ' ADD COLUMN ' + qid(col) + ' TEXT');
            }
          }
        }
        db.prepare('INSERT OR REPLACE INTO _tables (name, columns) VALUES (?, ?)').run(table, JSON.stringify(columns));
        result[table] = table;
      }
      return result;
    },

    getAvailableTables(folderId) {
      const rows = db.prepare('SELECT name, columns FROM _tables').all();
      return rows.map(r => ({ id: r.name, name: r.name }));
    },

    resetData() {
      const tables = db.prepare('SELECT name FROM _tables').all();
      for (const t of tables) {
        const stmts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ?").all(t.name + '%');
        for (const s of stmts) db.exec('DROP TABLE IF EXISTS ' + qid(s.name));
      }
      try { db.exec('DELETE FROM _lists'); } catch(e) {}
      try { db.exec('DELETE FROM _schema'); } catch(e) {}
      try { db.exec('DELETE FROM _tables'); } catch(e) {}
      try { db.exec('DELETE FROM _config'); } catch(e) {}
      try { db.exec('DELETE FROM _languages'); } catch(e) {}
      try { db.exec('DELETE FROM _translations'); } catch(e) {}
      try { db.exec('DELETE FROM _changesets'); } catch(e) {}
      try { db.exec('DELETE FROM _files'); } catch(e) {}
    },

    getAvailableLanguages(folderId) {
      const langs = [];
      const rows = db.prepare('SELECT code, name FROM _languages').all();
      rows.forEach(r => langs.push({ code: r.code, name: r.name }));
      return langs;
    },

    getTableData(tableId, tab) {
      const actualTable = tab ? tableId + '__' + tab : tableId;
      try {
        const rows = db.prepare('SELECT * FROM ' + qid(actualTable)).all();
        const meta = db.prepare('SELECT columns FROM _tables WHERE name = ?').get(tableId);
        const headers = meta ? JSON.parse(meta.columns) : H.deriveHeaders(rows);
        const msc = Object.keys(msMultiCols(tableId));
        if (msc.length) rows.forEach(function(r) { msc.forEach(function(c) {
          if (typeof r[c] === 'string' && r[c]) { try { var p = JSON.parse(r[c]); r[c] = Array.isArray(p) ? p : r[c]; } catch (e) {} }
          else if (r[c] == null || r[c] === '') r[c] = [];
        }); });
        return { headers, rows };
      } catch (e) {
        return { headers: [], rows: [] };
      }
    },

    putRow(tableId, rowData, tab) {
      const actualTable = tab ? tableId + '__' + tab : tableId;
      let meta = db.prepare('SELECT columns FROM _tables WHERE name = ?').get(tableId);
      if (!meta) {
        // Auto-register table from row data
        const cols = Object.keys(rowData).filter(k => k !== undefined);
        db.prepare('INSERT OR REPLACE INTO _tables (name, columns) VALUES (?, ?)').run(tableId, JSON.stringify(cols));
        const colDefs = cols.map(c => c === 'id' ? qid(c) + ' TEXT PRIMARY KEY' : qid(c) + ' TEXT').join(', ');
        db.exec('CREATE TABLE IF NOT EXISTS ' + qid(actualTable) + ' (' + colDefs + ')');
        meta = { columns: JSON.stringify(cols) };
      }
      const columns = JSON.parse(meta.columns);
      if (tab) {
        const cols = columns.map(c => c === 'id' ? qid(c) + ' TEXT PRIMARY KEY' : qid(c) + ' TEXT').join(', ');
        db.exec('CREATE TABLE IF NOT EXISTS ' + qid(actualTable) + ' (' + cols + ')');
      }
      const values = columns.map(c => { const v = rowData[c]; if (Array.isArray(v)) return JSON.stringify(v); return v !== undefined ? v : ''; });
      if (values.length !== columns.length) console.error('putRow mismatch:', tableId, 'cols:', columns.length, 'vals:', values.length);
      const badVals = values.filter(v => typeof v === 'object' && v !== null);
      if (badVals.length) console.error('putRow has object values:', badVals, 'for cols:', columns.filter((c,i) => typeof values[i] === 'object'));
      const colList = columns.map(c => qid(c)).join(',');
      const placeholders = columns.map(() => '?').join(',');
      try {
        db.prepare('INSERT OR REPLACE INTO ' + qid(actualTable) + ' (' + colList + ') VALUES (' + placeholders + ')').run(...values);
      } catch(e) {
        console.error('putRow SQL error:', e.message, 'table:', actualTable, 'cols:', columns, 'rowData keys:', Object.keys(rowData));
        throw e;
      }
    },

    deleteRow(tableId, id, tab) {
      const actualTable = tab ? tableId + '__' + tab : tableId;
      try {
        return db.prepare('DELETE FROM ' + qid(actualTable) + ' WHERE id = ?').run(id).changes > 0;
      } catch (e) { return false; } // table not created yet (e.g. delete-before-put on import) -> nothing to delete
    },

    moveRow(tableId, rowData, fromTab, toTab) {
      this.deleteRow(tableId, rowData.id, fromTab);
      this.putRow(tableId, rowData, toTab);
    },

    getTranslations(folderId, code) {
      const rows = db.prepare('SELECT key, text FROM _translations WHERE code = ?').all(code);
      const translations = {};
      rows.forEach(r => { if (r.key && r.text) translations[r.key] = r.text; });
      return translations;
    },

    updateTranslations(folderId, code, updates) {
      const stmt = db.prepare('INSERT OR REPLACE INTO _translations (code, key, text) VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(updates)) {
        stmt.run(code, key, value);
      }
    },

    createLanguage(folderId, code, name, keys) {
      db.prepare('INSERT OR REPLACE INTO _languages (code, name) VALUES (?, ?)').run(code, name);
      if (keys && keys.length) {
        const stmt = db.prepare('INSERT OR IGNORE INTO _translations (code, key, text) VALUES (?, ?, ?)');
        keys.forEach(k => stmt.run(code, k, ''));
      }
      return code;
    },

    deleteLanguage(folderId, code) {
      db.prepare('DELETE FROM _languages WHERE code = ?').run(code);
      db.prepare('DELETE FROM _translations WHERE code = ?').run(code);
    },

    // Rename display name only; code + translations (keyed by code) are preserved.
    renameLanguage(folderId, code, name) {
      db.prepare('UPDATE _languages SET name = ? WHERE code = ?').run(name, code);
    },

    getFileModifiedTime(fileId) {
      return new Date().toISOString();
    },

    getLists(folderId) {
      _ensureLists();
      const rows = db.prepare('SELECT name, items FROM _lists').all();
      const result = {};
      rows.forEach(r => { try { result[r.name] = JSON.parse(r.items) || []; } catch (e) { result[r.name] = []; } });
      return result;
    },

    saveLists(folderId, lists) {
      _ensureLists();
      db.transaction(() => {
        db.exec('DELETE FROM _lists');
        const stmt = db.prepare('INSERT INTO _lists (name, items, tables) VALUES (?, ?, ?)');
        for (const [name, values] of Object.entries(lists)) {
          const items = (values || []).filter(v => typeof v === 'string');
          stmt.run(name, JSON.stringify(items), JSON.stringify(_listOwning(name)));
        }
      })();
    },

    putListItem(folderId, listName, value) {
      if (typeof value !== 'string') return;
      _ensureLists();
      const row = db.prepare('SELECT items FROM _lists WHERE name = ?').get(listName);
      let items = [];
      if (row) { try { items = JSON.parse(row.items) || []; } catch (e) { items = []; } }
      if (items.indexOf(value) === -1) items.push(value);
      db.prepare('INSERT OR REPLACE INTO _lists (name, items, tables) VALUES (?, ?, ?)')
        .run(listName, JSON.stringify(items), JSON.stringify(_listOwning(listName)));
    },

    saveChangesets(folderId, siteId, json) {
      db.exec('CREATE TABLE IF NOT EXISTS _changesets (site_id TEXT PRIMARY KEY, data TEXT)');
      db.prepare('INSERT OR REPLACE INTO _changesets (site_id, data) VALUES (?, ?)').run(siteId, json);
    },

    loadChangesets(folderId, excludeSiteId) {
      db.exec('CREATE TABLE IF NOT EXISTS _changesets (site_id TEXT PRIMARY KEY, data TEXT)');
      return db.prepare('SELECT site_id as siteId, data FROM _changesets WHERE site_id != ?').all(excludeSiteId || '');
    },

    // Generic named-file store (for unified CRDT transport). name = full filename e.g. 'schema.json'
    readFile(folderId, name) {
      db.exec('CREATE TABLE IF NOT EXISTS _files (name TEXT PRIMARY KEY, data TEXT)');
      const row = db.prepare('SELECT data FROM _files WHERE name = ?').get(name);
      return row ? JSON.parse(row.data) : null;
    },
    writeFile(folderId, name, data) {
      db.exec('CREATE TABLE IF NOT EXISTS _files (name TEXT PRIMARY KEY, data TEXT)');
      db.prepare('INSERT OR REPLACE INTO _files (name, data) VALUES (?, ?)').run(name, JSON.stringify(data));
    },
    deleteFile(folderId, name) {
      try { db.prepare('DELETE FROM _files WHERE name = ?').run(name); } catch(e) {}
    },

    // Test helper: close DB
    close() { db.close(); }
  };
}

module.exports = { createLocalBackend };
