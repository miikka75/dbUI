const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const { SCHEMA } = require('../schema');
const { createLocalBackend } = require('../backend-local');

describe('Reference tables', () => {
  let backend;

  before(() => {
    backend = createLocalBackend(':memory:');
    backend.initSchema(SCHEMA);
  });

  it('initSchema creates ref tables without tab suffix', () => {
    // cities is ref:true with no tab property
    const result = backend.getTableData('cities');
    assert.ok(result);
    assert.deepStrictEqual(result.rows, []);
    assert.ok(result.headers.includes('state'));
    assert.ok(result.headers.includes('city'));
  });

  it('putRow without tab writes to plain table', () => {
    backend.putRow('cities', { id: '1', state: 'California', city: 'LA', created_at: '', updated_at: '' });
    const result = backend.getTableData('cities');
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].state, 'California');
    assert.strictEqual(result.rows[0].city, 'LA');
  });

  it('putRow with tab writes to suffixed table', () => {
    backend.putRow('tasks', { id: 't1', date: '', title: 'Test', status: '', assigned_to: '', city: 'SF', created_at: '', updated_at: '' }, 'active');
    const result = backend.getTableData('tasks', 'active');
    assert.strictEqual(result.rows.length, 1);
    assert.strictEqual(result.rows[0].city, 'SF');
  });

  it('initSchema adds missing columns to all tab variants', () => {
    // tasks has tab:'active' and archiveTab:'archive' — both should have city column
    const active = backend.getTableData('tasks', 'active');
    const archive = backend.getTableData('tasks', 'archive');
    assert.ok(active.headers.includes('city'));
    assert.ok(archive.headers.includes('city'));
  });

  it('deleteRow from ref table works', () => {
    backend.putRow('cities', { id: '2', state: 'Texas', city: 'Houston', created_at: '', updated_at: '' });
    assert.strictEqual(backend.getTableData('cities').rows.length, 2);
    backend.deleteRow('cities', '2');
    assert.strictEqual(backend.getTableData('cities').rows.length, 1);
  });

  it('multiple rows with same parent column', () => {
    backend.putRow('cities', { id: '3', state: 'California', city: 'SF', created_at: '', updated_at: '' });
    const result = backend.getTableData('cities');
    const ca = result.rows.filter(r => r.state === 'California');
    assert.strictEqual(ca.length, 2);
  });
});
