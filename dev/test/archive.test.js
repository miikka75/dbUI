const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');
const { SCHEMA, getColumns } = require('../schema');

let backend;
const TABLE = Object.keys(SCHEMA)[0]; // first table

beforeEach(() => { backend = createLocalBackend(); backend.initSchema('local', SCHEMA); });
afterEach(() => { backend.close(); });

describe('Archive (tab parameter)', () => {
  it('putRow with tab creates row in archive table', () => {
    const row = { id: 'a1', title: 'Archived' };
    getColumns(TABLE).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(TABLE, row, 'archive');
    const data = backend.getTableData(TABLE, 'archive');
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].id, 'a1');
    assert.equal(data.rows[0].title, 'Archived');
  });

  it('archive does not affect active table', () => {
    const row = { id: 'a1', title: 'Active' };
    getColumns(TABLE).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(TABLE, row);
    backend.putRow(TABLE, { ...row, title: 'Archived' }, 'archive');
    assert.equal(backend.getTableData(TABLE).rows[0].title, 'Active');
    assert.equal(backend.getTableData(TABLE, 'archive').rows[0].title, 'Archived');
  });

  it('deleteRow with tab removes from archive only', () => {
    const row = { id: 'a1', title: 'Test' };
    getColumns(TABLE).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(TABLE, row);
    backend.putRow(TABLE, row, 'archive');
    backend.deleteRow(TABLE, 'a1', 'archive');
    assert.equal(backend.getTableData(TABLE).rows.length, 1); // active untouched
    assert.equal(backend.getTableData(TABLE, 'archive').rows.length, 0);
  });

  it('full archive flow: move from active to archive', () => {
    const row = { id: 'a1', title: 'Task' };
    getColumns(TABLE).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(TABLE, row);
    // Archive: copy to archive tab, delete from active
    backend.putRow(TABLE, row, 'archive');
    backend.deleteRow(TABLE, 'a1');
    assert.equal(backend.getTableData(TABLE).rows.length, 0);
    assert.equal(backend.getTableData(TABLE, 'archive').rows.length, 1);
  });

  it('full restore flow: move from archive to active', () => {
    const row = { id: 'a1', title: 'Task' };
    getColumns(TABLE).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(TABLE, row, 'archive');
    // Restore: copy to active, delete from archive
    backend.putRow(TABLE, row);
    backend.deleteRow(TABLE, 'a1', 'archive');
    assert.equal(backend.getTableData(TABLE).rows.length, 1);
    assert.equal(backend.getTableData(TABLE, 'archive').rows.length, 0);
  });

  it('getTableData with non-existent tab returns empty', () => {
    const data = backend.getTableData(TABLE, 'nonexistent');
    assert.deepEqual(data.rows, []);
  });
});

describe('moveRow', () => {
  it('moves row from source tab to target tab', () => {
    const table = Object.keys(SCHEMA)[0];
    const row = { id: 'mv1', created_at: '2026-01-01', updated_at: '2026-01-01' };
    Object.keys(SCHEMA[table].columns).forEach(c => { if (!row[c]) row[c] = ''; });
    const srcTab = SCHEMA[table].partition || 'active';
    const arcTab = SCHEMA[table].archivePartition;
    if (!arcTab) return;
    backend.putRow(table, row, srcTab);
    backend.moveRow(table, row, srcTab, arcTab);
    assert.equal(backend.getTableData(table, srcTab).rows.find(r => r.id === 'mv1'), undefined);
    assert.ok(backend.getTableData(table, arcTab).rows.find(r => r.id === 'mv1'));
  });

  it('moveRow to non-existent tab creates it', () => {
    const table = Object.keys(SCHEMA)[0];
    const row = { id: 'mv2', created_at: '2026-01-01', updated_at: '2026-01-01' };
    Object.keys(SCHEMA[table].columns).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(table, row, SCHEMA[table].partition || 'active');
    backend.moveRow(table, row, SCHEMA[table].partition || 'active', 'newtab');
    assert.ok(backend.getTableData(table, 'newtab').rows.find(r => r.id === 'mv2'));
  });
});

describe('deleteRow on missing partition table', () => {
  it('returns false and does not throw (import delete-before-put on fresh DB)', () => {
    const b = createLocalBackend();
    // No initSchema/putRow for this partition -> table does not exist yet
    assert.equal(b.deleteRow('notes', 'nope', 'active'), false);
    b.close();
  });
});
