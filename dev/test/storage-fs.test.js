const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFsBackend } = require('../storage-fs');
const { SCHEMA, getColumns } = require('../schema');

let backend;
const DATA_DIR = path.join(__dirname, '.test-data-' + process.pid);
const TABLES = Object.keys(SCHEMA);
const FIRST_TABLE = TABLES[0];

function makeRow(table, id, overrides) {
  const row = {};
  getColumns(table).forEach(function(c) {
    if (c === 'id') row[c] = id || 'test-' + Math.random().toString(36).slice(2, 8);
    else row[c] = 'val-' + c;
  });
  return Object.assign(row, overrides || {});
}

beforeEach(() => { backend = createFsBackend(DATA_DIR); });
afterEach(() => { backend.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

describe('FS Backend - Basic operations', () => {
  it('validateFolder returns valid', () => {
    assert.equal(backend.validateFolder('test').valid, true);
  });

  it('initSchema creates table files', () => {
    backend.initSchema('local', SCHEMA);
    TABLES.forEach(function(t) {
      var def = SCHEMA[t];
      var tab = (def.partition || 'active');
      var f = path.join(DATA_DIR, t + '__' + tab + '.json');
      assert.ok(fs.existsSync(f), 'Missing file: ' + f);
    });
  });

  it('putRow and getTableData', () => {
    backend.initSchema('local', SCHEMA);
    var row = makeRow(FIRST_TABLE, 'row1');
    backend.putRow(FIRST_TABLE, row, 'active');
    var result = backend.getTableData(FIRST_TABLE, 'active');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'row1');
  });

  it('putRow updates existing row', () => {
    backend.initSchema('local', SCHEMA);
    var row = makeRow(FIRST_TABLE, 'row1');
    backend.putRow(FIRST_TABLE, row, 'active');
    var cols = getColumns(FIRST_TABLE).filter(c => c !== 'id');
    var updated = Object.assign({}, row);
    updated[cols[0]] = 'updated-value';
    backend.putRow(FIRST_TABLE, updated, 'active');
    var result = backend.getTableData(FIRST_TABLE, 'active');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0][cols[0]], 'updated-value');
  });

  it('deleteRow removes row', () => {
    backend.initSchema('local', SCHEMA);
    var row = makeRow(FIRST_TABLE, 'row1');
    backend.putRow(FIRST_TABLE, row, 'active');
    backend.deleteRow(FIRST_TABLE, 'row1', 'active');
    var result = backend.getTableData(FIRST_TABLE, 'active');
    assert.equal(result.rows.length, 0);
  });

  it('moveRow transfers between partitions', () => {
    backend.initSchema('local', SCHEMA);
    var row = makeRow(FIRST_TABLE, 'row1');
    backend.putRow(FIRST_TABLE, row, 'active');
    backend.moveRow(FIRST_TABLE, row, 'active', 'archive');
    assert.equal(backend.getTableData(FIRST_TABLE, 'active').rows.length, 0);
    assert.equal(backend.getTableData(FIRST_TABLE, 'archive').rows.length, 1);
  });
});

describe('FS Backend - Schema persistence', () => {
  it('saveSchema and getSchema', () => {
    backend.saveSchema('local', { tables: SCHEMA });
    var loaded = backend.getSchema('local');
    assert.deepEqual(loaded, { tables: SCHEMA });
  });
});

describe('FS Backend - Lists', () => {
  it('saveLists persists to file', () => {
    var lists = { status: ['open', 'closed'], priority: ['high', 'low'] };
    backend.saveLists('local', lists);
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'lists.json')));
    var loaded = backend.getLists('local');
    assert.deepEqual(loaded, lists);
  });

  it('putListItem appends to list', () => {
    backend.saveLists('local', { status: ['open'] });
    backend.putListItem('local', 'status', 'closed');
    var lists = backend.getLists('local');
    assert.deepEqual(lists.status, ['open', 'closed']);
  });

  it('putListItem does not duplicate', () => {
    backend.saveLists('local', { status: ['open'] });
    backend.putListItem('local', 'status', 'open');
    var lists = backend.getLists('local');
    assert.deepEqual(lists.status, ['open']);
  });
});

describe('FS Backend - Languages', () => {
  it('createLanguage persists language file', () => {
    backend.createLanguage('local', 'fi', 'Finnish', ['hello', 'world']);
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'languages.json')));
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'lang_fi.json')));
    var langs = backend.getAvailableLanguages('local');
    assert.equal(langs.length, 1);
    assert.equal(langs[0].code, 'fi');
  });

  it('getTranslations returns empty keys', () => {
    backend.createLanguage('local', 'fi', 'Finnish', ['hello', 'world']);
    var t = backend.getTranslations('local', 'fi');
    assert.equal(t.hello, '');
    assert.equal(t.world, '');
  });

  it('updateTranslations persists', () => {
    backend.createLanguage('local', 'fi', 'Finnish', ['hello']);
    backend.updateTranslations('local', 'fi', { hello: 'Hello' });
    var t = backend.getTranslations('local', 'fi');
    assert.equal(t.hello, 'Hello');
  });

  it('deleteLanguage removes files', () => {
    backend.createLanguage('local', 'fi', 'Finnish', ['hello']);
    backend.deleteLanguage('local', 'fi');
    assert.equal(backend.getAvailableLanguages('local').length, 0);
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'lang_fi.json')));
  });
});

describe('FS Backend - Folder config', () => {
  it('stores and retrieves config', () => {
    backend.setFolderConfig('local', { theme: 'dark' });
    assert.deepEqual(backend.getFolderConfig('local'), { theme: 'dark' });
    assert.ok(fs.existsSync(path.join(DATA_DIR, '.app-config.json')));
  });
});

describe('FS Backend - Changesets (CRDT sync)', () => {
  it('saveChangesets creates sync file', () => {
    backend.saveChangesets('local', 'site-abc', '{"siteId":"site-abc","changes":[]}');
    var syncDir = path.join(DATA_DIR, '_sync');
    assert.ok(fs.existsSync(path.join(syncDir, 'site-abc.json')));
  });

  it('loadChangesets returns other sites', () => {
    backend.saveChangesets('local', 'site-a', '{"siteId":"site-a","changes":[{"t":"x"}]}');
    backend.saveChangesets('local', 'site-b', '{"siteId":"site-b","changes":[{"t":"y"}]}');
    var results = backend.loadChangesets('local', 'site-a');
    assert.equal(results.length, 1);
    assert.equal(results[0].siteId, 'site-b');
  });

  it('loadChangesets excludes own site', () => {
    backend.saveChangesets('local', 'me', '{"changes":[]}');
    var results = backend.loadChangesets('local', 'me');
    assert.equal(results.length, 0);
  });
});

describe('FS Backend - Reset', () => {
  it('resetData clears all files', () => {
    backend.initSchema('local', SCHEMA);
    backend.saveLists('local', { x: ['y'] });
    backend.createLanguage('local', 'en', 'English', ['hi']);
    backend.resetData();
    assert.equal(fs.readdirSync(DATA_DIR).length, 0);
  });
});

describe('FS Backend - CRDT export/import round-trip', () => {
  it('exported changesets can be imported by another site', () => {
    backend.initSchema('local', SCHEMA);
    // Site A writes rows
    var row1 = makeRow(FIRST_TABLE, 'r1');
    var row2 = makeRow(FIRST_TABLE, 'r2');
    backend.putRow(FIRST_TABLE, row1, 'active');
    backend.putRow(FIRST_TABLE, row2, 'active');

    // Site A exports as changeset
    var changes = [
      { t: FIRST_TABLE, b: 'active', id: 'r1', ts: 1000, d: row1 },
      { t: FIRST_TABLE, b: 'active', id: 'r2', ts: 1001, d: row2 }
    ];
    backend.saveChangesets('local', 'site-a', JSON.stringify({ siteId: 'site-a', changes: changes }));

    // Site B loads changesets (excludes own site-b)
    var loaded = backend.loadChangesets('local', 'site-b');
    assert.equal(loaded.length, 1);
    var parsed = JSON.parse(loaded[0].data);
    assert.equal(parsed.siteId, 'site-a');
    assert.equal(parsed.changes.length, 2);
    assert.equal(parsed.changes[0].id, 'r1');
    assert.deepEqual(parsed.changes[0].d, row1);
  });

  it('multiple sites changesets coexist', () => {
    backend.initSchema('local', SCHEMA);
    backend.saveChangesets('local', 'site-a', JSON.stringify({ siteId: 'site-a', changes: [{ t: FIRST_TABLE, b: 'active', id: 'a1', ts: 1, d: { id: 'a1' } }] }));
    backend.saveChangesets('local', 'site-b', JSON.stringify({ siteId: 'site-b', changes: [{ t: FIRST_TABLE, b: 'active', id: 'b1', ts: 2, d: { id: 'b1' } }] }));

    // Site C sees both A and B
    var loaded = backend.loadChangesets('local', 'site-c');
    assert.equal(loaded.length, 2);
    var siteIds = loaded.map(function(r) { return r.siteId; }).sort();
    assert.deepEqual(siteIds, ['site-a', 'site-b']);
  });

  it('schema + lists + languages survive export/import', () => {
    backend.initSchema('local', SCHEMA);
    backend.saveSchema('local', { tables: SCHEMA });
    backend.saveLists('local', { status: ['open', 'done'], priority: ['high', 'low'] });
    backend.createLanguage('local', 'fi', 'Finnish', ['greeting', 'bye']);
    backend.updateTranslations('local', 'fi', { greeting: 'Hello', bye: 'Goodbye' });

    // Verify all persisted correctly
    var schema = backend.getSchema('local');
    assert.ok(schema.tables);
    assert.ok(schema.tables[FIRST_TABLE]);

    var lists = backend.getLists('local');
    assert.deepEqual(lists.status, ['open', 'done']);
    assert.deepEqual(lists.priority, ['high', 'low']);

    var langs = backend.getAvailableLanguages('local');
    assert.equal(langs.length, 1);
    assert.equal(langs[0].code, 'fi');

    var trans = backend.getTranslations('local', 'fi');
    assert.equal(trans.greeting, 'Hello');
    assert.equal(trans.bye, 'Goodbye');
  });

  it('table data with archive partition round-trips', () => {
    backend.initSchema('local', SCHEMA);
    var row = makeRow(FIRST_TABLE, 'arch1');
    backend.putRow(FIRST_TABLE, row, 'active');
    backend.moveRow(FIRST_TABLE, row, 'active', 'archive');

    assert.equal(backend.getTableData(FIRST_TABLE, 'active').rows.length, 0);
    var archived = backend.getTableData(FIRST_TABLE, 'archive');
    assert.equal(archived.rows.length, 1);
    assert.equal(archived.rows[0].id, 'arch1');
  });
});
