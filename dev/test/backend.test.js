const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');
const { SCHEMA, getColumns } = require('../schema');

let backend;
const TABLES = Object.keys(SCHEMA);
const FIRST_TABLE = TABLES[0];

// Generate a row with all columns filled for any table
function makeRow(table, id, overrides) {
  const row = {};
  getColumns(table).forEach(function(c) {
    if (c === 'id') row[c] = id || 'test-' + Math.random().toString(36).slice(2, 8);
    else row[c] = 'val-' + c;
  });
  return Object.assign(row, overrides || {});
}

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('validateFolder', () => {
  it('returns valid for non-empty ID', () => {
    assert.equal(backend.validateFolder('abc').valid, true);
  });
  it('returns invalid for empty/null', () => {
    assert.equal(backend.validateFolder('').valid, false);
    assert.equal(backend.validateFolder(null).valid, false);
  });
});

describe('folderConfig', () => {
  it('returns null when no config set', () => {
    assert.equal(backend.getFolderConfig('f1'), null);
  });
  it('stores and retrieves config', () => {
    backend.setFolderConfig('f1', { mode: 'sheets' });
    assert.deepEqual(backend.getFolderConfig('f1'), { mode: 'sheets' });
  });
  it('overwrites existing config', () => {
    backend.setFolderConfig('f1', { mode: 'sheets' });
    backend.setFolderConfig('f1', { mode: 'crdt' });
    assert.deepEqual(backend.getFolderConfig('f1'), { mode: 'crdt' });
  });
});

describe('initSchema', () => {
  it('creates all tables from SCHEMA', () => {
    const result = backend.initSchema('f1', SCHEMA);
    TABLES.forEach(function(t) { assert.ok(result[t]); });
  });
  it('is idempotent', () => {
    backend.initSchema('f1', SCHEMA);
    const result = backend.initSchema('f1', SCHEMA);
    TABLES.forEach(function(t) { assert.ok(result[t]); });
  });
  it('adds missing columns on re-init', () => {
    // Init with subset, then full
    const partial = {};
    partial[FIRST_TABLE] = { columns: ['id', getColumns(FIRST_TABLE)[1]], primaryKey: 'id' };
    backend.initSchema('f1', partial);
    backend.initSchema('f1', SCHEMA);
    const data = backend.getTableData(FIRST_TABLE);
    getColumns(FIRST_TABLE).forEach(function(c) {
      assert.ok(data.headers.includes(c), 'missing column: ' + c);
    });
  });
});

describe('getAvailableTables', () => {
  it('returns empty before init', () => {
    assert.deepEqual(backend.getAvailableTables('f1'), []);
  });
  it('returns all SCHEMA tables after init', () => {
    backend.initSchema('f1', SCHEMA);
    const tables = backend.getAvailableTables('f1');
    assert.equal(tables.length, TABLES.length);
  });
});

describe('getTableData', () => {
  it('returns correct headers for each table', () => {
    backend.initSchema('f1', SCHEMA);
    TABLES.forEach(function(t) {
      const data = backend.getTableData(t);
      assert.deepEqual(data.headers, getColumns(t));
      assert.deepEqual(data.rows, []);
    });
  });
  it('returns rows after insert', () => {
    backend.initSchema('f1', SCHEMA);
    const row = makeRow(FIRST_TABLE, 'r1');
    backend.putRow(FIRST_TABLE, row);
    const data = backend.getTableData(FIRST_TABLE);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].id, 'r1');
  });
  it('returns empty for non-existent table', () => {
    assert.deepEqual(backend.getTableData('nonexistent'), { headers: [], rows: [] });
  });
});

describe('putRow', () => {
  it('inserts new row with all columns', () => {
    backend.initSchema('f1', SCHEMA);
    const row = makeRow(FIRST_TABLE, 'p1');
    backend.putRow(FIRST_TABLE, row);
    const data = backend.getTableData(FIRST_TABLE);
    assert.equal(data.rows.length, 1);
    getColumns(FIRST_TABLE).forEach(function(c) {
      assert.equal(data.rows[0][c], row[c]);
    });
  });
  it('updates existing row by id', () => {
    backend.initSchema('f1', SCHEMA);
    const row = makeRow(FIRST_TABLE, 'p2');
    backend.putRow(FIRST_TABLE, row);
    const col = getColumns(FIRST_TABLE)[1]; // first non-id column
    row[col] = 'updated';
    backend.putRow(FIRST_TABLE, row);
    const data = backend.getTableData(FIRST_TABLE);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0][col], 'updated');
  });
  it('handles missing fields as empty string', () => {
    backend.initSchema('f1', SCHEMA);
    backend.putRow(FIRST_TABLE, { id: 'p3' });
    const data = backend.getTableData(FIRST_TABLE);
    getColumns(FIRST_TABLE).forEach(function(c) {
      if (c !== 'id') assert.equal(data.rows[0][c], '');
    });
  });
});

describe('deleteRow', () => {
  it('deletes existing row', () => {
    backend.initSchema('f1', SCHEMA);
    backend.putRow(FIRST_TABLE, makeRow(FIRST_TABLE, 'd1'));
    assert.equal(backend.deleteRow(FIRST_TABLE, 'd1'), true);
    assert.equal(backend.getTableData(FIRST_TABLE).rows.length, 0);
  });
  it('returns false for non-existent row', () => {
    backend.initSchema('f1', SCHEMA);
    assert.equal(backend.deleteRow(FIRST_TABLE, 'nope'), false);
  });
  it('does not affect other rows', () => {
    backend.initSchema('f1', SCHEMA);
    backend.putRow(FIRST_TABLE, makeRow(FIRST_TABLE, 'd2'));
    backend.putRow(FIRST_TABLE, makeRow(FIRST_TABLE, 'd3'));
    backend.deleteRow(FIRST_TABLE, 'd3');
    const data = backend.getTableData(FIRST_TABLE);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].id, 'd2');
  });
});

describe('languages', () => {
  it('returns empty by default', () => {
    assert.equal(backend.getAvailableLanguages('f1').length, 0);
  });
  it('createLanguage adds a language', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', ['app.title']);
    const langs = backend.getAvailableLanguages('f1');
    assert.equal(langs.length, 1);
    assert.equal(langs[0].code, 'fi');
  });
  it('getTranslations returns empty for new language', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', ['app.title']);
    assert.deepEqual(backend.getTranslations('f1', 'fi'), {});
  });
  it('updateTranslations stores and retrieves', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', []);
    backend.updateTranslations('f1', 'fi', { 'app.title': 'App' });
    assert.equal(backend.getTranslations('f1', 'fi')['app.title'], 'App');
  });
  it('updateTranslations overwrites existing', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', []);
    backend.updateTranslations('f1', 'fi', { 'k': 'v1' });
    backend.updateTranslations('f1', 'fi', { 'k': 'v2' });
    assert.equal(backend.getTranslations('f1', 'fi')['k'], 'v2');
  });
  it('deleteLanguage removes language and translations', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', []);
    backend.updateTranslations('f1', 'fi', { 'k': 'v' });
    backend.deleteLanguage('f1', 'fi');
    assert.equal(backend.getAvailableLanguages('f1').length, 0);
    assert.deepEqual(backend.getTranslations('f1', 'fi'), {});
  });
  it('renameLanguage changes the display name but keeps code + translations', () => {
    backend.createLanguage('f1', 'fi', 'Finnish', []);
    backend.updateTranslations('f1', 'fi', { 'app.title': 'Sovellus' });
    backend.renameLanguage('f1', 'fi', 'Suomi');
    const langs = backend.getAvailableLanguages('f1');
    assert.equal(langs.length, 1);
    assert.equal(langs[0].code, 'fi');                 // code unchanged (stable key)
    assert.equal(langs[0].name, 'Suomi');              // display name updated
    assert.equal(backend.getTranslations('f1', 'fi')['app.title'], 'Sovellus'); // translations preserved
  });
});

describe('changesets (CRDT sync)', () => {
  it('saveChangesets stores data', () => {
    backend.saveChangesets('f1', 'site-a', '{"x":1}');
    const r = backend.loadChangesets('f1', 'site-b');
    assert.equal(r.length, 1);
    assert.equal(r[0].siteId, 'site-a');
  });
  it('loadChangesets excludes own site', () => {
    backend.saveChangesets('f1', 'site-a', '1');
    backend.saveChangesets('f1', 'site-b', '2');
    assert.equal(backend.loadChangesets('f1', 'site-a').length, 1);
    assert.equal(backend.loadChangesets('f1', 'site-a')[0].siteId, 'site-b');
  });
  it('saveChangesets overwrites existing', () => {
    backend.saveChangesets('f1', 'site-a', 'v1');
    backend.saveChangesets('f1', 'site-a', 'v2');
    assert.equal(backend.loadChangesets('f1', 'x')[0].data, 'v2');
  });
  it('loadChangesets returns empty when none', () => {
    assert.deepEqual(backend.loadChangesets('f1', 'x'), []);
  });
});

describe('getFileModifiedTime', () => {
  it('returns ISO date string', () => {
    assert.ok(backend.getFileModifiedTime('any').match(/^\d{4}-\d{2}-\d{2}T/));
  });
});

describe('schema storage', () => {
  it('getSchema returns null when no schema saved', () => {
    const result = backend.getSchema('f1');
    assert.equal(result, null);
  });
  it('saveSchema stores and retrieves schema', () => {
    const schema = { tables: { t1: { columns: { id: 'text' } } }, views: {}, i18n: {} };
    backend.saveSchema('f1', schema);
    assert.deepEqual(backend.getSchema('f1'), schema);
  });
  it('saveSchema overwrites existing', () => {
    backend.saveSchema('f1', { tables: {}, views: {}, i18n: { a: '1' } });
    backend.saveSchema('f1', { tables: {}, views: {}, i18n: { b: '2' } });
    assert.deepEqual(backend.getSchema('f1').i18n, { b: '2' });
  });
});

describe('parseTableResult', () => {
  function parseTableResult(r) {
    if (!r) return { headers: [], rows: [] };
    if (typeof r === 'string') return JSON.parse(r);
    return r;
  }

  it('handles null', () => {
    assert.deepEqual(parseTableResult(null), { headers: [], rows: [] });
  });

  it('handles object', () => {
    const obj = { headers: ['a'], rows: [{ a: 1 }] };
    assert.deepEqual(parseTableResult(obj), obj);
  });

  it('handles JSON string', () => {
    const obj = { headers: ['a'], rows: [{ a: 1 }] };
    assert.deepEqual(parseTableResult(JSON.stringify(obj)), obj);
  });
});
