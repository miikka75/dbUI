// backend-local.js — Local SQLite backend implementing same interface as Code.gs
const Database = require('better-sqlite3');
const H = require('../backend-helpers');
const LA = require('../list-access');
const Columns = require('../columns');

function createLocalBackend(dbPath) {
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');

  // Quote a SQL identifier safely: wrap in "" and escape embedded quotes (blocks identifier injection).
  function qid(n) { return '"' + String(n).replace(/"/g, '""') + '"'; }

  // Parsed-schema cache: msMultiCols/_listOwning run on EVERY getTableData/list write, and each used
  // to re-SELECT + JSON.parse the whole stored schema — O(tables x schema size) per boot. Parse once,
  // invalidate on saveSchema/resetData. undefined = not loaded yet; null = no schema stored.
  var _schemaCache;
  function _storedSchema() {
    if (_schemaCache === undefined) {
      var row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('schema');
      _schemaCache = row ? JSON.parse(row.value) : null;
    }
    return _schemaCache;
  }

  // multiselect columns are stored as JSON-encoded arrays in TEXT cells (SQLite has no array type).
  // Return a set of multiselect column names for a table, read from the stored schema.
  function msMultiCols(tableId) {
    try {
      var stored = _storedSchema();
      if (!stored) return {};
      // Both column shapes (authored array / normalized colMap) through the shared reader.
      var defs = Columns.columnDefs((stored.tables || {})[tableId]), out = {};
      Object.keys(defs).forEach(function(c) { var d = defs[c]; if (d && typeof d === 'object' && d.type === 'multiselect') out[c] = true; });
      return out;
    } catch (e) { return {}; }
  }

  // Owning tables of a list, read from the stored schema; used to stamp each per-list row.
  // The scan itself is the shared list-access module (no more copied logic).
  function _listOwning(listName) {
    try {
      var stored = _storedSchema();
      return LA.listOwningTables((stored && stored.tables) || {}, listName);
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
    getSchema() {
      // Fresh parse per call (callers may mutate the result); the internal helpers use _storedSchema.
      const row = db.prepare('SELECT value FROM _schema WHERE key = ?').get('schema');
      if (row) return JSON.parse(row.value);
      return null;
    },

    saveSchema(schema) {
      db.prepare('INSERT OR REPLACE INTO _schema (key, value) VALUES (?, ?)').run('schema', JSON.stringify(schema));
      _schemaCache = undefined; // invalidate the parsed-schema cache
    },

    validateFolder(folderId) {
      // Locally, any non-empty ID is valid
      if (!folderId) return { valid: false, name: null };
      return { valid: true, name: 'Local Folder' };
    },

    getFolderConfig() {
      const row = db.prepare('SELECT value FROM _config WHERE key = ?').get('folder-config');
      return row ? JSON.parse(row.value) : null;
    },

    setFolderConfig(config) {
      db.prepare('INSERT OR REPLACE INTO _config (key, value) VALUES (?, ?)').run('folder-config', JSON.stringify(config));
    },

    // User-linked lists (Option C): the admin-only { listName: { value: email } } link map, stored whole in
    // the generic _config KV. The server derives the viewer-safe projection from it (see list-users.js).
    getListUsers() {
      const row = db.prepare('SELECT value FROM _config WHERE key = ?').get('list-users');
      try { return row ? JSON.parse(row.value) : {}; } catch (e) { return {}; }
    },

    saveListUsers(map) {
      db.prepare('INSERT OR REPLACE INTO _config (key, value) VALUES (?, ?)').run('list-users', JSON.stringify(map || {}));
    },

    initSchema(schema) {
      const result = {};
      for (const [table, def] of Object.entries(schema)) {
        // NOT Columns.columnDefs, deliberately: initSchema takes a STORAGE schema, and a storage schema
        // may name its columns as a plain list of strings (`columns: ['id', 'v']`) as well as in the two
        // app shapes. The shared reader answers "what is each column's DEFINITION", which a bare name
        // does not have; this asks only for the names, over a third shape the app never produces.
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

    getAvailableTables() {
      const rows = db.prepare('SELECT name, columns FROM _tables').all();
      return rows.map(r => ({ id: r.name, name: r.name }));
    },

    resetData() {
      const tables = db.prepare('SELECT name FROM _tables').all();
      for (const t of tables) {
        // Match the table itself + its partition tables (name__tab) EXACTLY. A raw `name + '%'` LIKE
        // over-matched: table "task" would drop "tasks__active", and `_` is a LIKE single-char wildcard
        // (so "a_b%" also matched "axb..."). Escape the literals and anchor the partition separator.
        const esc = t.name.replace(/[\\%_]/g, '\\$&');
        const stmts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name = ? OR name LIKE ? ESCAPE '\\')").all(t.name, esc + '\\_\\_%');
        for (const s of stmts) db.exec('DROP TABLE IF EXISTS ' + qid(s.name));
      }
      _schemaCache = undefined; // schema rows are deleted below -> drop the parsed cache too
      try { db.exec('DELETE FROM _lists'); } catch(e) {}
      try { db.exec('DELETE FROM _schema'); } catch(e) {}
      try { db.exec('DELETE FROM _tables'); } catch(e) {}
      try { db.exec('DELETE FROM _config'); } catch(e) {}
      try { db.exec('DELETE FROM _languages'); } catch(e) {}
      try { db.exec('DELETE FROM _translations'); } catch(e) {}
      try { db.exec('DELETE FROM _changesets'); } catch(e) {}
      try { db.exec('DELETE FROM _files'); } catch(e) {}
    },

    getAvailableLanguages() {
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
        // A partition table (e.g. tilat__active) is created lazily and initSchema only ALTERs the base/
        // declared-partition tables — so a column added to the schema afterwards (e.g. a reorderable
        // table's `position`) never reaches it. Add any missing columns here so writes don't silently drop them.
        const have = db.pragma('table_info(' + qid(actualTable) + ')').map(r => r.name);
        for (const c of columns) if (!have.includes(c)) db.exec('ALTER TABLE ' + qid(actualTable) + ' ADD COLUMN ' + qid(c) + ' TEXT');
      }
      // MERGE semantics (parity with storage-fs Object.assign, Firestore {merge:true}, and the CRDT
      // engine's per-field LWW): a partial rowData must not blank the columns it omits. INSERT OR
      // REPLACE writes the full column list, so absent keys fall back to the stored row's values.
      let existing = null;
      try { existing = db.prepare('SELECT * FROM ' + qid(actualTable) + ' WHERE id = ?').get(rowData.id); } catch (e) {}
      const values = columns.map(c => {
        const v = rowData[c] !== undefined ? rowData[c] : (existing ? existing[c] : undefined);
        if (Array.isArray(v)) return JSON.stringify(v);
        return v !== undefined ? v : '';
      });
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

    getTranslations(code) {
      const rows = db.prepare('SELECT key, text FROM _translations WHERE code = ?').all(code);
      const translations = {};
      rows.forEach(r => { if (r.key && r.text) translations[r.key] = r.text; });
      return translations;
    },

    updateTranslations(code, updates) {
      const stmt = db.prepare('INSERT OR REPLACE INTO _translations (code, key, text) VALUES (?, ?, ?)');
      for (const [key, value] of Object.entries(updates)) {
        stmt.run(code, key, value);
      }
    },

    createLanguage(code, name, keys) {
      db.prepare('INSERT OR REPLACE INTO _languages (code, name) VALUES (?, ?)').run(code, name);
      if (keys && keys.length) {
        const stmt = db.prepare('INSERT OR IGNORE INTO _translations (code, key, text) VALUES (?, ?, ?)');
        keys.forEach(k => stmt.run(code, k, ''));
      }
      return code;
    },

    deleteLanguage(code) {
      db.prepare('DELETE FROM _languages WHERE code = ?').run(code);
      db.prepare('DELETE FROM _translations WHERE code = ?').run(code);
    },

    // Rename display name only; code + translations (keyed by code) are preserved.
    renameLanguage(code, name) {
      db.prepare('UPDATE _languages SET name = ? WHERE code = ?').run(name, code);
    },

    getLists() {
      _ensureLists();
      const rows = db.prepare('SELECT name, items FROM _lists').all();
      const result = {};
      rows.forEach(r => { try { result[r.name] = JSON.parse(r.items) || []; } catch (e) { result[r.name] = []; } });
      return result;
    },

    saveLists(lists) {
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

    putListItem(listName, value) {
      if (typeof value !== 'string') return;
      _ensureLists();
      const row = db.prepare('SELECT items FROM _lists WHERE name = ?').get(listName);
      let items = [];
      if (row) { try { items = JSON.parse(row.items) || []; } catch (e) { items = []; } }
      if (items.indexOf(value) === -1) items.push(value);
      db.prepare('INSERT OR REPLACE INTO _lists (name, items, tables) VALUES (?, ?, ?)')
        .run(listName, JSON.stringify(items), JSON.stringify(_listOwning(listName)));
    },

    // Test helper: close DB
    close() { db.close(); }
  };
}

module.exports = { createLocalBackend };
