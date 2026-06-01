const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

let backend;

// Schema with custom partition names (like the Finnish church schema)
const CUSTOM_SCHEMA = {
  musiikki: { columns: ['id', 'pvm', 'aihe'], partition: 'tulevat', archivePartition: 'menneet' },
  kokoukset: { columns: ['id', 'pvm', 'paikka'], partition: 'tulevat', archivePartition: 'menneet' }
};

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('Import - initSchema creates tables for custom partitions', () => {
  it('creates partition + archivePartition tables', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    // putRow must succeed (no "no such table") for custom partition
    backend.putRow('musiikki', { id: 'm1', pvm: '2026-06-01', aihe: 'Test' }, 'tulevat');
    backend.putRow('musiikki', { id: 'm2', pvm: '2026-05-01', aihe: 'Old' }, 'menneet');
    assert.equal(backend.getTableData('musiikki', 'tulevat').rows.length, 1);
    assert.equal(backend.getTableData('musiikki', 'menneet').rows.length, 1);
  });

  it('getTableData returns correct rows by partition', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('kokoukset', { id: 'k1', pvm: '2026-06-01', paikka: 'Hall' }, 'tulevat');
    var result = backend.getTableData('kokoukset', 'tulevat');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].paikka, 'Hall');
  });
});

describe('Import - schema persistence and reset', () => {
  it('saveSchema + getSchema round-trips imported schema', () => {
    backend.saveSchema('local', { tables: CUSTOM_SCHEMA, defaultLanguage: 'fi' });
    var s = backend.getSchema('local');
    assert.equal(s.defaultLanguage, 'fi');
    assert.ok(s.tables.musiikki);
  });

  it('getSchema returns null when nothing saved (no schema.json fallback)', () => {
    assert.equal(backend.getSchema('local'), null);
  });

  it('resetData drops tables, schema, lists, languages, changesets', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.saveSchema('local', { tables: CUSTOM_SCHEMA });
    backend.putRow('musiikki', { id: 'm1', pvm: '2026-06-01', aihe: 'X' }, 'tulevat');
    backend.saveLists('local', { genre: ['hymn'] });
    backend.createLanguage('local', 'fi', 'Finnish', ['hello']);
    backend.saveChangesets('local', 'site-a', '{"changes":[]}');

    backend.resetData();

    // Everything cleared
    assert.equal(backend.getSchema('local'), null);
    assert.deepEqual(backend.getLists('local'), {});
    assert.equal(backend.getAvailableLanguages('local').length, 0);
    assert.equal(backend.loadChangesets('local', '').length, 0);
    // Table dropped -> getTableData returns empty (no rows)
    assert.equal(backend.getTableData('musiikki', 'tulevat').rows.length, 0);
  });

  it('after reset, re-import works cleanly', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('musiikki', { id: 'm1', pvm: '2026-06-01', aihe: 'X' }, 'tulevat');
    backend.resetData();
    // Re-import
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('musiikki', { id: 'm2', pvm: '2026-06-02', aihe: 'Y' }, 'tulevat');
    var result = backend.getTableData('musiikki', 'tulevat');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'm2');
  });
});
