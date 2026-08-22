const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

let backend;

// Schema with custom partition names
const CUSTOM_SCHEMA = {
  music: { columns: ['id', 'date', 'topic'], partition: 'upcoming', archivePartition: 'past' },
  meetings: { columns: ['id', 'date', 'place'], partition: 'upcoming', archivePartition: 'past' }
};

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('Import - initSchema creates tables for custom partitions', () => {
  it('creates partition + archivePartition tables', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    // putRow must succeed (no "no such table") for custom partition
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'Test' }, 'upcoming');
    backend.putRow('music', { id: 'm2', date: '2026-05-01', topic: 'Old' }, 'past');
    assert.equal(backend.getTableData('music', 'upcoming').rows.length, 1);
    assert.equal(backend.getTableData('music', 'past').rows.length, 1);
  });

  it('getTableData returns correct rows by partition', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    backend.putRow('meetings', { id: 'k1', date: '2026-06-01', place: 'Hall' }, 'upcoming');
    var result = backend.getTableData('meetings', 'upcoming');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].place, 'Hall');
  });
});

describe('Import - stored image assets (_assets system store)', () => {
  // Stored assets are the no-bucket image tier: a view background / image-cell bytes kept as a data URI
  // in the database. The architectural claim being tested is that this needs NO per-backend work —
  // putRow/getTableData map '_assets' + 'active' to the _assets__active store generically, the same way
  // doc-view bodies reach _pages__active. If that stopped holding, the export/import path (which reads
  // and writes these rows explicitly, since system stores are outside the schema's table map) breaks.
  const DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  it('putRow + getTableData round-trip an asset row without any schema registration', () => {
    backend.initSchema(CUSTOM_SCHEMA);          // note: _assets is NOT part of the schema
    backend.putRow('_assets', { id: 'bg_frontPage', src: DATA_URI }, 'active');
    const rows = backend.getTableData('_assets', 'active').rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'bg_frontPage');
    assert.equal(rows[0].src, DATA_URI);
  });

  it('a deterministic id overwrites in place, so replacing a background leaves no orphan', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    backend.putRow('_assets', { id: 'bg_frontPage', src: DATA_URI }, 'active');
    backend.putRow('_assets', { id: 'bg_frontPage', src: 'data:image/jpeg;base64,AAAA' }, 'active');
    const rows = backend.getTableData('_assets', 'active').rows;
    assert.equal(rows.length, 1, 'a replacement should not accumulate a second row');
    assert.equal(rows[0].src, 'data:image/jpeg;base64,AAAA');
  });

  it('holds several independently-keyed assets (one background + image cells)', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    backend.putRow('_assets', { id: 'bg_music', src: DATA_URI }, 'active');
    backend.putRow('_assets', { id: 'img_1720000000000_a1b2c3', src: DATA_URI }, 'active');
    const ids = backend.getTableData('_assets', 'active').rows.map((r) => r.id).sort();
    assert.deepEqual(ids, ['bg_music', 'img_1720000000000_a1b2c3']);
  });
});

describe('Import - schema persistence and reset', () => {
  it('saveSchema + getSchema round-trips imported schema', () => {
    backend.saveSchema({ tables: CUSTOM_SCHEMA, defaultLanguage: 'xx' });
    var s = backend.getSchema();
    assert.equal(s.defaultLanguage, 'xx');
    assert.ok(s.tables.music);
  });

  it('getSchema returns null when nothing saved (no schema.json fallback)', () => {
    assert.equal(backend.getSchema(), null);
  });

  it('resetData drops tables, schema, lists and languages', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    backend.saveSchema({ tables: CUSTOM_SCHEMA });
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'X' }, 'upcoming');
    backend.saveLists({ genre: ['hymn'] });
    backend.createLanguage('xx', 'TestLang', ['hello']);

    backend.resetData();

    // Everything cleared
    assert.equal(backend.getSchema(), null);
    assert.deepEqual(backend.getLists(), {});
    assert.equal(backend.getAvailableLanguages().length, 0);
    // Table dropped -> getTableData returns empty (no rows)
    assert.equal(backend.getTableData('music', 'upcoming').rows.length, 0);
  });

  it('after reset, re-import works cleanly', () => {
    backend.initSchema(CUSTOM_SCHEMA);
    backend.putRow('music', { id: 'm1', date: '2026-06-01', topic: 'X' }, 'upcoming');
    backend.resetData();
    // Re-import
    backend.initSchema(CUSTOM_SCHEMA);
    backend.putRow('music', { id: 'm2', date: '2026-06-02', topic: 'Y' }, 'upcoming');
    var result = backend.getTableData('music', 'upcoming');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].id, 'm2');
  });
});
