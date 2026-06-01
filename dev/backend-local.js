// backend-local.js — Local SQLite backend implementing same interface as Code.gs
const Database = require('better-sqlite3');
const H = require('../backend-helpers');

function createLocalBackend(dbPath) {
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');

  // Quote a SQL identifier safely: wrap in "" and escape embedded quotes (blocks identifier injection).
  function qid(n) { return '"' + String(n).replace(/"/g, '""') + '"'; }

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
        const columns = Array.isArray(def.columns) ? def.columns.map(c => typeof c === 'object' ? c.name : c).filter(Boolean) : Object.keys(def.columns);
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
      const values = columns.map(c => rowData[c] !== undefined ? rowData[c] : '');
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
      const result = db.prepare('DELETE FROM ' + qid(actualTable) + ' WHERE id = ?').run(id);
      return result.changes > 0;
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

    getFileModifiedTime(fileId) {
      return new Date().toISOString();
    },

    getLists(folderId) {
      // Local: read from _lists table
      db.exec('CREATE TABLE IF NOT EXISTS _lists (name TEXT, value TEXT)');
      const rows = db.prepare('SELECT name, value FROM _lists').all();
      const result = {};
      rows.forEach(r => { if (!result[r.name]) result[r.name] = []; result[r.name].push(r.value); });
      return result;
    },

    saveLists(folderId, lists) {
      db.exec('CREATE TABLE IF NOT EXISTS _lists (name TEXT, value TEXT)');
      db.exec('DELETE FROM _lists');
      const stmt = db.prepare('INSERT INTO _lists (name, value) VALUES (?, ?)');
      for (const [name, values] of Object.entries(lists)) {
        values.forEach(v => stmt.run(name, v));
      }
    },

    putListItem(folderId, listName, value) {
      db.exec('CREATE TABLE IF NOT EXISTS _lists (name TEXT, value TEXT)');
      db.prepare('INSERT INTO _lists (name, value) VALUES (?, ?)').run(listName, value);
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
