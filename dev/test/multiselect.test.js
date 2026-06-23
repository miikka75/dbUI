const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

// multiselect cells are stored as JSON-encoded arrays in TEXT columns (SQLite has no array type).
// Verify the encode-on-write / decode-on-read round-trip and that scalar columns are unaffected.
let backend;
const SCHEMA = {
  tables: {
    duty: {
      columns: {
        title: 'text',
        people: { type: 'multiselect', list: 'people', allowNew: true }
      }
    }
  }
};

beforeEach(() => { backend = createLocalBackend(); backend.saveSchema('f', SCHEMA); });
afterEach(() => { backend.close(); });

describe('multiselect array storage', () => {
  it('round-trips an array value through put/get', () => {
    backend.putRow('duty', { id: 'r1', title: 'Doormen', people: ['Matti', 'Liisa'] }, 'active');
    const row = backend.getTableData('duty', 'active').rows.find(r => r.id === 'r1');
    assert.deepEqual(row.people, ['Matti', 'Liisa']);
    assert.equal(row.title, 'Doormen');
  });

  it('decodes an empty/absent multiselect cell to []', () => {
    backend.putRow('duty', { id: 'r2', title: 'Empty', people: [] }, 'active');
    const row = backend.getTableData('duty', 'active').rows.find(r => r.id === 'r2');
    assert.deepEqual(row.people, []);
  });

  it('preserves a single-element array (not collapsed to scalar)', () => {
    backend.putRow('duty', { id: 'r3', title: 'One', people: ['Pekka'] }, 'active');
    const row = backend.getTableData('duty', 'active').rows.find(r => r.id === 'r3');
    assert.deepEqual(row.people, ['Pekka']);
  });

  it('leaves scalar (non-multiselect) columns untouched', () => {
    backend.putRow('duty', { id: 'r4', title: 'Scalar', people: ['X'] }, 'active');
    const row = backend.getTableData('duty', 'active').rows.find(r => r.id === 'r4');
    assert.equal(row.title, 'Scalar');
    assert.equal(typeof row.title, 'string');
  });

  it('decodes multiselect when the stored schema uses array-of-objects columns (authored form)', () => {
    // The authored/exported schema form stores columns as an array, not a colMap object.
    backend.saveSchema('f', { tables: { duty: { columns: [
      { name: 'title', type: 'text' },
      { name: 'people', type: 'multiselect', list: 'people', allowNew: true }
    ] } } });
    backend.putRow('duty', { id: 'a1', title: 'Crew', people: ['Aino', 'Sari'] }, 'active');
    const row = backend.getTableData('duty', 'active').rows.find(r => r.id === 'a1');
    assert.deepEqual(row.people, ['Aino', 'Sari']); // not the raw JSON string
  });
});
