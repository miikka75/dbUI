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
    backend.createLanguage('local', 'xx', 'TestLang', ['hello', 'world']);
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'languages.json')));
    assert.ok(fs.existsSync(path.join(DATA_DIR, 'lang_xx.json')));
    var langs = backend.getAvailableLanguages('local');
    assert.equal(langs.length, 1);
    assert.equal(langs[0].code, 'xx');
  });

  it('getTranslations returns empty keys', () => {
    backend.createLanguage('local', 'xx', 'TestLang', ['hello', 'world']);
    var t = backend.getTranslations('local', 'xx');
    assert.equal(t.hello, '');
    assert.equal(t.world, '');
  });

  it('updateTranslations persists', () => {
    backend.createLanguage('local', 'xx', 'TestLang', ['hello']);
    backend.updateTranslations('local', 'xx', { hello: 'Hello' });
    var t = backend.getTranslations('local', 'xx');
    assert.equal(t.hello, 'Hello');
  });

  it('deleteLanguage removes files', () => {
    backend.createLanguage('local', 'xx', 'TestLang', ['hello']);
    backend.deleteLanguage('local', 'xx');
    assert.equal(backend.getAvailableLanguages('local').length, 0);
    assert.ok(!fs.existsSync(path.join(DATA_DIR, 'lang_xx.json')));
  });

  it('renameLanguage updates name, keeps code + translations file', () => {
    backend.createLanguage('local', 'xx', 'TestLang', ['hello']);
    backend.updateTranslations('local', 'xx', { hello: 'Hi' });
    backend.renameLanguage('local', 'xx', 'Renamed');
    var langs = backend.getAvailableLanguages('local');
    assert.equal(langs[0].code, 'xx');                       // code stable
    assert.equal(langs[0].name, 'Renamed');                    // name renamed
    assert.equal(backend.getTranslations('local', 'xx').hello, 'Hi'); // translations intact
  });
});

describe('FS Backend - Folder config', () => {
  it('stores and retrieves config', () => {
    backend.setFolderConfig('local', { theme: 'dark' });
    assert.deepEqual(backend.getFolderConfig('local'), { theme: 'dark' });
    assert.ok(fs.existsSync(path.join(DATA_DIR, '.app-config.json')));
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
