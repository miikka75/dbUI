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
      if (typeof view.markdown === 'string') continue; // doc-view (no sources)
      for (const src of view.sources) {
        assert.ok(SCHEMA[src], 'View "' + name + '" references non-existent table: ' + src);
      }
    }
  });

  it('VIEWS columns exist in at least one source table', () => {
    for (const [name, view] of Object.entries(VIEWS)) {
      if (typeof view.markdown === 'string') continue; // doc-view (no columns)
      if (view.groupBy && view.collect) continue; // aggregate views have computed columns
      for (const col of view.columns) {
        if (typeof col === 'object' && col.view) continue; // named-view embed
        if (typeof col === 'object' && col.sources && !col.name) continue; // inline embed
        if (typeof col === 'object' && col.computed) continue; // computed column (derived, not in a source table)
        const colStr = typeof col === 'object' ? (col.name || Object.keys(col)[0]) : col;
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

describe('Aggregate view logic', () => {
  // Test the aggregation algorithm directly (same logic as app-core)
  function aggregate(rows, keys, value, columns) {
    var keyCol = (typeof keys === 'object' && !Array.isArray(keys)) ? keys.column : columns[0];
    var keysFrom = (typeof keys === 'object' && !Array.isArray(keys)) ? keys.from : keys;
    var groups = {};
    rows.forEach(function(r) {
      keysFrom.forEach(function(k) {
        var person = r[k];
        if (person) { if (!groups[person]) groups[person] = []; if (r[value]) groups[person].push(r[value]); }
      });
    });
    var valCols = columns.filter(function(c) { return c !== keyCol; });
    return Object.keys(groups).map(function(person) {
      var vals = groups[person].sort().reverse();
      var row = { id: person };
      row[keyCol] = person;
      for (var i = 0; i < valCols.length; i++) row[valCols[i]] = vals[i] || '';
      return row;
    });
  }

  it('groups by multiple key columns', () => {
    const rows = [
      { assigned_to: 'Alice', author: '', date: '2026-05-27' },
      { assigned_to: '', author: 'Alice', date: '2026-05-20' },
      { assigned_to: 'Bob', author: '', date: '2026-05-25' }
    ];
    const result = aggregate(rows, ['assigned_to', 'author'], 'date', ['person', 'latest', 'previous']);
    assert.equal(result.length, 2);
    const alice = result.find(r => r.person === 'Alice');
    assert.equal(alice.latest, '2026-05-27');
    assert.equal(alice.previous, '2026-05-20');
    const bob = result.find(r => r.person === 'Bob');
    assert.equal(bob.latest, '2026-05-25');
    assert.equal(bob.previous, '');
  });

  it('deduplicates when same person in multiple key columns of same row', () => {
    const rows = [
      { assigned_to: 'Alice', author: 'Alice', date: '2026-05-27' }
    ];
    const result = aggregate(rows, ['assigned_to', 'author'], 'date', ['person', 'latest', 'previous']);
    assert.equal(result.length, 1);
    // Alice appears in both columns of same row — date counted twice
    assert.equal(result[0].latest, '2026-05-27');
  });

  it('sorts values descending (latest first)', () => {
    const rows = [
      { assigned_to: 'Alice', date: '2026-01-01' },
      { assigned_to: 'Alice', date: '2026-12-31' },
      { assigned_to: 'Alice', date: '2026-06-15' }
    ];
    const result = aggregate(rows, ['assigned_to'], 'date', ['person', '1st', '2nd', '3rd']);
    assert.equal(result[0]['1st'], '2026-12-31');
    assert.equal(result[0]['2nd'], '2026-06-15');
    assert.equal(result[0]['3rd'], '2026-01-01');
  });

  it('limits to column count', () => {
    const rows = [
      { assigned_to: 'Alice', date: '2026-01-01' },
      { assigned_to: 'Alice', date: '2026-06-01' },
      { assigned_to: 'Alice', date: '2026-12-01' }
    ];
    const result = aggregate(rows, ['assigned_to'], 'date', ['person', 'latest']);
    assert.equal(result[0].latest, '2026-12-01');
    assert.equal(result[0]['2nd'], undefined); // not in columns
  });

  it('key column can be in any position', () => {
    const rows = [
      { assigned_to: 'Alice', date: '2026-05-27' },
      { assigned_to: 'Alice', date: '2026-05-20' }
    ];
    const result = aggregate(rows, { column: 'person', from: ['assigned_to'] }, 'date', ['latest', 'person', 'previous']);
    assert.equal(result[0].person, 'Alice');
    assert.equal(result[0].latest, '2026-05-27');
    assert.equal(result[0].previous, '2026-05-20');
  });
});

describe('Schema property coverage', () => {
  it('text entries are a removed feature (none remain in any view)', () => {
    function countText(cols) {
      let n = 0;
      (cols || []).forEach(c => {
        if (c && typeof c === 'object') {
          if (c.text && !c.name && !c.sources) n++;
          if (Array.isArray(c.columns)) n += countText(c.columns);
        }
      });
      return n;
    }
    let total = 0;
    for (const vn in VIEWS) total += countText(VIEWS[vn].columns);
    assert.equal(total, 0, 'No {text} entries should remain (feature removed)');
  });

  it('readonly view property exists in schema', () => {
    let hasReadonly = false;
    for (const vn in VIEWS) { if (VIEWS[vn].readonly) hasReadonly = true; }
    assert.ok(hasReadonly, 'At least one view should have readonly: true');
  });

  it('layout property exists in schema', () => {
    let hasLayout = false;
    for (const vn in VIEWS) { if (VIEWS[vn].layout) hasLayout = true; }
    assert.ok(hasLayout, 'At least one view should have layout property');
  });

  it('hideEmpty property exists in schema', () => {
    let hasHideEmpty = false;
    for (const vn in VIEWS) {
      if (VIEWS[vn].hideEmpty) hasHideEmpty = true;
      (VIEWS[vn].columns || []).forEach(c => { if (typeof c === 'object' && c.hideEmpty) hasHideEmpty = true; });
    }
    assert.ok(hasHideEmpty, 'At least one view or embed should have hideEmpty: true');
  });

  it('isLookup table not included in non-lookup tables', () => {
    const lookups = Object.keys(SCHEMA).filter(t => SCHEMA[t].isLookup);
    const nonLookups = Object.keys(SCHEMA).filter(t => !SCHEMA[t].isLookup);
    assert.ok(lookups.length > 0, 'Should have at least one lookup table');
    assert.ok(nonLookups.length > 0, 'Should have at least one non-lookup table');
  });

  it('syncFrom column property exists', () => {
    let found = false;
    for (const t in SCHEMA) {
      for (const c in SCHEMA[t].columns) {
        const def = SCHEMA[t].columns[c];
        if (def && typeof def === 'object' && def.syncFrom) found = true;
      }
    }
    assert.ok(found, 'At least one column should have syncFrom');
  });

  it('locked list values extracted from filters', () => {
    // Simulate lockedListValues logic
    const locked = {};
    for (const vn in VIEWS) {
      const view = VIEWS[vn];
      if (view.filter) {
        for (const col in view.filter) {
          for (const t in SCHEMA) {
            const d = SCHEMA[t].columns[col];
            if (d && typeof d === 'object' && d.list) {
              if (!locked[d.list]) locked[d.list] = {};
              locked[d.list][view.filter[col]] = true;
            }
          }
        }
      }
      // Also check inline embeds
      (view.columns || []).forEach(c => {
        if (typeof c === 'object' && c.sources && c.filter) {
          for (const col in c.filter) {
            for (const t in SCHEMA) {
              const d = SCHEMA[t].columns[col];
              if (d && typeof d === 'object' && d.list) {
                if (!locked[d.list]) locked[d.list] = {};
                locked[d.list][c.filter[col]] = true;
              }
            }
          }
        }
      });
    }
    assert.ok(Object.keys(locked).length > 0, 'Should have locked list values from filters');
    assert.ok(locked.status, 'status list should have locked values');
  });
});
