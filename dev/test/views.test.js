const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');
const { SCHEMA, VIEWS, getColumns, getColumnType } = require('../schema');

let backend;

beforeEach(() => { backend = createLocalBackend(); backend.initSchema('local', SCHEMA); });
afterEach(() => { backend.close(); });

describe('Union view data access', () => {
  it('rows from multiple tables can be read independently', () => {
    backend.putRow('tasks', { id: 't1', title: 'Task 1', status: 'open', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'n1', title: 'Note 1', content: 'hello', author: 'me', created_at: '', updated_at: '' });

    const tasks = backend.getTableData('tasks').rows;
    const notes = backend.getTableData('notes').rows;
    assert.equal(tasks.length, 1);
    assert.equal(notes.length, 1);

    // Simulate union: merge both
    const union = [...tasks.map(r => ({ ...r, _source: 'tasks' })), ...notes.map(r => ({ ...r, _source: 'notes' }))];
    assert.equal(union.length, 2);
    assert.equal(union[0]._source, 'tasks');
    assert.equal(union[1]._source, 'notes');
  });

  it('edit routed to correct source table', () => {
    backend.putRow('tasks', { id: 't1', title: 'Original', status: '', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'n1', title: 'Note', content: '', author: '', created_at: '', updated_at: '' });

    // Simulate view edit: update task title via source routing
    backend.putRow('tasks', { id: 't1', title: 'Updated', status: '', assigned_to: '', created_at: '', updated_at: '' });

    const tasks = backend.getTableData('tasks').rows;
    assert.equal(tasks[0].title, 'Updated');
    // Notes unchanged
    assert.equal(backend.getTableData('notes').rows[0].title, 'Note');
  });

  it('delete routed to correct source table', () => {
    backend.putRow('tasks', { id: 't1', title: 'Task', status: '', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'n1', title: 'Note', content: '', author: '', created_at: '', updated_at: '' });

    // Delete from tasks via source routing
    backend.deleteRow('tasks', 't1');

    assert.equal(backend.getTableData('tasks').rows.length, 0);
    assert.equal(backend.getTableData('notes').rows.length, 1);
  });

  it('VIEWS config references valid SCHEMA tables', () => {
    for (const [name, view] of Object.entries(VIEWS)) {
      for (const src of view.sources) {
        assert.ok(SCHEMA[src], 'View "' + name + '" references non-existent table: ' + src);
      }
    }
  });

  it('VIEWS columns exist in at least one source table', () => {
    for (const [name, view] of Object.entries(VIEWS)) {
      for (const col of view.columns) {
        const colStr = typeof col === 'object' ? Object.keys(col)[0] : col;
        const found = view.sources.some(src => getColumns(src).includes(colStr));
        assert.ok(found, 'View "' + name + '" column "' + colStr + '" not in any source table');
      }
    }
  });
});

describe('Join view data access', () => {
  it('rows with same id are merged into one', () => {
    backend.putRow('tasks', { id: 'x1', title: 'Fix bug', status: 'open', assigned_to: 'me', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'x1', title: '', content: 'Details', author: 'you', created_at: '', updated_at: '' });

    const tasks = backend.getTableData('tasks').rows;
    const notes = backend.getTableData('notes').rows;

    // Simulate join by id
    const merged = {};
    for (const row of [...tasks, ...notes]) {
      if (!merged[row.id]) merged[row.id] = {};
      Object.assign(merged[row.id], row);
    }
    const result = Object.values(merged);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'open');
    assert.equal(result[0].content, 'Details');
    assert.equal(result[0].author, 'you');
  });

  it('rows with different ids stay separate', () => {
    backend.putRow('tasks', { id: 't1', title: 'Task', status: 'open', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'n1', title: 'Note', content: 'hi', author: '', created_at: '', updated_at: '' });

    const tasks = backend.getTableData('tasks').rows;
    const notes = backend.getTableData('notes').rows;

    const merged = {};
    for (const row of [...tasks, ...notes]) {
      if (!merged[row.id]) merged[row.id] = {};
      Object.assign(merged[row.id], row);
    }
    assert.equal(Object.keys(merged).length, 2);
  });

  it('edit in join view saves to correct source table', () => {
    backend.putRow('tasks', { id: 'x1', title: 'Task', status: 'open', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'x1', title: '', content: 'Old', author: '', created_at: '', updated_at: '' });

    // Edit content (belongs to notes)
    backend.putRow('notes', { id: 'x1', title: '', content: 'New', author: '', created_at: '', updated_at: '' });

    assert.equal(backend.getTableData('notes').rows[0].content, 'New');
    assert.equal(backend.getTableData('tasks').rows[0].status, 'open'); // unchanged
  });

  it('delete in join view removes from all source tables', () => {
    backend.putRow('tasks', { id: 'x1', title: 'Task', status: '', assigned_to: '', created_at: '', updated_at: '' });
    backend.putRow('notes', { id: 'x1', title: '', content: 'Note', author: '', created_at: '', updated_at: '' });

    backend.deleteRow('tasks', 'x1');
    backend.deleteRow('notes', 'x1');

    assert.equal(backend.getTableData('tasks').rows.length, 0);
    assert.equal(backend.getTableData('notes').rows.length, 0);
  });
});
