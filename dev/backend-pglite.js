// backend-pglite.js — the dev server's storage contract, served from PostgreSQL-in-WASM.
//
// This is the pair to dev/backend-local.js (SQLite), and the point of it is that access control is NOT
// implemented here. storage-pglite.js runs the real supabase-schema.sql, so every read and write below
// is already gated by the same RLS policies production uses. Anything this file did to re-check a grant
// would be a fourth implementation of the access model — exactly what phase 02 exists to remove.
//
// The mapping from the contract onto kv(store, key, value) is the one backend-supabase.js already
// defines, deliberately reused rather than reinvented: rows live in `<table>__<tab>`, app metadata in
// `_meta/<name>`, lists in `_lists/<name>`.
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BackendHelpers = require(path.join(ROOT, 'backend-helpers'));
const ListAccess = require(path.join(ROOT, 'list-access'));
const { createPgliteStorage } = require('./storage-pglite');

const store = (table, tab) => BackendHelpers.storeName(table, tab);

async function createPgliteBackend(opts) {
  const S = await createPgliteStorage(opts || {});

  const backend = {
    // The dev server sets this per request, from the trusted X-User header. Everything after it runs
    // under that identity inside Postgres.
    setCaller(email) { S.setCaller(email); },

    // --- schema -------------------------------------------------------------------------------------
    async getSchema() {
      return BackendHelpers.unwrapSchemaDoc(await S.getMeta('schema'));
    },

    // The RLS policies are schema-BLIND: they cannot parse a schema document at query time, so the
    // facts they need are mirrored into _meta alongside it on every write. This must mirror the SAME
    // set as backend-supabase.js and backend-firebase.js, or the policy layers diverge — which is the
    // failure the parity tests exist to catch.
    async saveSchema(schema) {
      const tables = (schema && schema.tables) || {};
      await S.setMeta('schema', schema);
      await S.setMeta('ownerTables', { tables: BackendHelpers.ownerTablesOf(schema) });
      await S.setMeta('pageAccess', BackendHelpers.pageAccessOf(schema));
      await S.setMeta('ownerWritable', BackendHelpers.ownerWritableOf(schema));
      await S.setMeta('listTables', ListAccess.listOwnershipMap(tables));
      await S.setMeta('listWritable', BackendHelpers.userWritableListsOf(schema));
    },

    // Nothing to create up front: a kv row springs into being on first write, exactly as a Firestore
    // collection does. Kept because the contract still names it.
    async initSchema() { return null; },

    // The dev-server probe ("is there a database here?"), the one method that still takes a handle.
    async validateFolder(id) {
      return id ? { valid: true, name: 'pglite' } : { valid: false, name: null };
    },

    async getAvailableTables() {
      const schema = await backend.getSchema();
      return Object.keys((schema && schema.tables) || {}).map((n) => ({ id: n, name: n }));
    },

    // --- app config ---------------------------------------------------------------------------------
    async getFolderConfig() { return (await S.getMeta('config')) || null; },
    async setFolderConfig(config) { return S.setMeta('config', config); },

    // --- rows ---------------------------------------------------------------------------------------
    // No scoping here on purpose: RLS already returned only the rows this caller may see.
    async getTableData(tableId, tab) {
      const rows = await S.getAll(store(tableId, tab));
      return { headers: BackendHelpers.deriveHeaders(rows), rows: rows };
    },
    async putRow(tableId, data, tab) {
      if (!data || !data.id) return null;
      return S.put(store(tableId, tab), data.id, data);
    },
    async deleteRow(tableId, id, tab) { return S.delete(store(tableId, tab), id); },
    async moveRow(tableId, rowData, fromTab, toTab) {
      // Delete-then-put, matching backend-local. Not atomic on any backend; the contract says so.
      await backend.deleteRow(tableId, rowData.id, fromTab);
      return backend.putRow(tableId, rowData, toTab);
    },

    // --- lists --------------------------------------------------------------------------------------
    async getLists() {
      const rows = await S._all('_lists');
      const out = {};
      (rows || []).forEach((r) => { const v = r.value || {}; out[v.name || r.key] = v.items || []; });
      return out;
    },
    async saveLists(lists) {
      const schema = await backend.getSchema();
      const tables = (schema && schema.tables) || {};
      const wanted = lists || {};
      for (const name of Object.keys(wanted)) {
        // `tables` is the ownership label the _lists policy reads to authorize the write. It has to be
        // written WITH the row: on a create there is no existing row to read it from.
        await S.put('_lists', name, { name: name, items: wanted[name] || [], tables: ListAccess.listOwningTables(tables, name) });
      }
      // Prune lists the caller submitted away. A non-admin's submission is a filtered subset, so RLS
      // refusing the delete of a list they cannot see is the correct outcome, not an error.
      const existing = await S._all('_lists');
      for (const row of existing || []) {
        if (!(row.key in wanted)) { try { await S.delete('_lists', row.key); } catch (e) {} }
      }
    },
    async putListItem(listName, value) {
      const schema = await backend.getSchema();
      const tables = (schema && schema.tables) || {};
      const doc = (await S.get('_lists', listName)) || { name: listName, items: [], tables: ListAccess.listOwningTables(tables, listName) };
      const items = (doc.items || []).indexOf(value) < 0 ? (doc.items || []).concat([value]) : (doc.items || []);
      return S.put('_lists', listName, { name: listName, items: items, tables: ListAccess.listOwningTables(tables, listName) });
    },

    // --- user-linked lists --------------------------------------------------------------------------
    async getListUsers() { return (await S.getMeta('listusers')) || {}; },
    async saveListUsers(map) { return S.setMeta('listusers', map || {}); },

    // --- languages + translations -------------------------------------------------------------------
    async getAvailableLanguages() {
      const d = await S.getMeta('languages');
      return d ? (d.list || []) : [];
    },
    async getTranslations(code) { return (await S.getMeta('lang_' + code)) || {}; },
    async updateTranslations(code, updates) {
      // put() merges, which is what an update of some keys means; setMeta would replace the whole map.
      return S.put('_meta', 'lang_' + code, updates || {});
    },
    async createLanguage(code, name, keys) {
      const d = await S.getMeta('languages');
      const langs = BackendHelpers.addLanguage(d ? (d.list || []) : [], code, name);
      await S.setMeta('languages', { list: langs });
      await S.setMeta('lang_' + code, BackendHelpers.emptyTranslations(keys));
      return code;
    },
    async deleteLanguage(code) {
      const d = await S.getMeta('languages');
      const langs = (d ? (d.list || []) : []).filter((l) => (l.code || l) !== code);
      await S.setMeta('languages', { list: langs });
      await S.delete('_meta', 'lang_' + code);
    },
    async renameLanguage(code, name) {
      const d = await S.getMeta('languages');
      const langs = (d ? (d.list || []) : []).map((l) => ((l.code || l) === code ? { code: code, name: name } : l));
      return S.setMeta('languages', { list: langs });
    },

    // --- lifecycle ----------------------------------------------------------------------------------
    async resetData() { return S._resetData(); },
    async close() { return S.close(); },

    // Seeding fixtures (tests, the member registry) is not a user action; it bypasses RLS by design.
    _seed(st, key, value) { return S._seed(st, key, value); },
    _storage: S
  };

  return backend;
}

module.exports = { createPgliteBackend };
