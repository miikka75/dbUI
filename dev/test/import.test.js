const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

let backend;

// Schema with custom partition names (like the Finnish church schema)
const CUSTOM_SCHEMA = {
  music: { columns: ['id', 'date', 'topic'], partition: 'upcoming', archivePartition: 'past' },
  meetings: { columns: ['id', 'date', 'place'], partition: 'upcoming', archivePartition: 'past' }
};

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('Import - initSchema creates tables for custom partitions', () => {
  it('creates partition + archivePartition tables', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    // putRow must succeed (no "no such table") for custom partition
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'Test' }, 'upcoming');
    backend.putRow('music', { id: 'm2', date: '2026-05-01', topic: 'Old' }, 'past');
    assert.equal(backend.getTableData('music', 'upcoming').rows.length, 1);
    assert.equal(backend.getTableData('music', 'past').rows.length, 1);
  });

  it('getTableData returns correct rows by partition', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('meetings', { id: 'k1', date: '2026-06-01', place: 'Hall' }, 'upcoming');
    var result = backend.getTableData('meetings', 'upcoming');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].place, 'Hall');
  });
});

describe('Import - schema persistence and reset', () => {
  it('saveSchema + getSchema round-trips imported schema', () => {
    backend.saveSchema('local', { tables: CUSTOM_SCHEMA, defaultLanguage: 'fi' });
    var s = backend.getSchema('local');
    assert.equal(s.defaultLanguage, 'fi');
    assert.ok(s.tables.music);
  });

  it('getSchema returns null when nothing saved (no schema.json fallback)', () => {
    assert.equal(backend.getSchema('local'), null);
  });

  it('resetData drops tables, schema, lists, languages, changesets', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.saveSchema('local', { tables: CUSTOM_SCHEMA });
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'X' }, 'upcoming');
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
    assert.equal(backend.getTableData('music', 'upcoming').rows.length, 0);
  });

  it('after reset, re-import works cleanly', () => {
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'X' }, 'upcoming');
    backend.resetData();
    // Re-import
    backend.initSchema('local', CUSTOM_SCHEMA);
    backend.putRow('music', { id: 'm2', date: '2026-06-02', topic: 'Y' }, 'upcoming');
    var result = backend.getTableData('music', 'upcoming');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'm2');
  });
});
