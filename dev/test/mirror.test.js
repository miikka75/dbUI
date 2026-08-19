const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { SCHEMA } = require('../schema');
const { createLocalBackend } = require('../backend-local');

// Mirror helper (same logic as app-core.js)
function getTableMirrorSource(tables, tableName) {
  var cols = tables[tableName] && tables[tableName].columns;
  if (!cols) return null;
  for (var c in cols) {
    var def = cols[c];
    if (def && typeof def === 'object' && def.syncFrom) return def.syncFrom;
  }
  return null;
}

describe('Mirror columns', () => {
  let backend;

  before(() => {
    backend = createLocalBackend(':memory:');
    backend.initSchema(SCHEMA);
  });

  it('creating note propagates to tasks (mirror row created)', () => {
    const noteRow = { id: 'n1', date: '2026-01-15', title: 'Hello', content: 'body', author: '', created_at: '', updated_at: '' };
    backend.putRow('notes', noteRow, 'active');

    // Simulate mirror propagation (as app-core does in addRow)
    const source = 'notes';
    for (const mt in SCHEMA) {
      if (getTableMirrorSource(SCHEMA, mt) === source) {
        const mirrorRow = { id: noteRow.id, created_at: '', updated_at: '' };
        Object.keys(SCHEMA[mt].columns).forEach(c => { if (!mirrorRow[c]) mirrorRow[c] = ''; });
        const mirrorCols = SCHEMA[mt].columns;
        for (const mc in mirrorCols) {
          const mdef = mirrorCols[mc];
          if (mdef && typeof mdef === 'object' && mdef.syncFrom) mirrorRow[mc] = noteRow[mc] || '';
        }
        backend.putRow(mt, mirrorRow, SCHEMA[mt].partition);
      }
    }

    const tasks = backend.getTableData('tasks', 'active');
    const mirrored = tasks.rows.find(r => r.id === 'n1');
    assert.ok(mirrored, 'Mirror row should exist in tasks');
    assert.strictEqual(mirrored.date, '2026-01-15');
    assert.strictEqual(mirrored.title, 'Hello');
  });

  it('editing note date updates tasks mirror', () => {
    // Update note's date
    const noteRow = { id: 'n1', date: '2026-02-20', title: 'Hello', content: 'body', author: '', created_at: '', updated_at: '' };
    backend.putRow('notes', noteRow, 'active');

    // Simulate saveField mirror propagation
    const source = 'notes';
    const col = 'date';
    const value = '2026-02-20';
    for (const mt in SCHEMA) {
      const mirrorCols = SCHEMA[mt].columns;
      for (const mc in mirrorCols) {
        const mdef = mirrorCols[mc];
        if (mdef && typeof mdef === 'object' && mdef.syncFrom === source && mc === col) {
          const tasks = backend.getTableData(mt, SCHEMA[mt].partition);
          const mr = tasks.rows.find(r => r.id === 'n1');
          if (mr) {
            mr[mc] = value;
            mr.updated_at = new Date().toISOString();
            backend.putRow(mt, mr, SCHEMA[mt].partition);
          }
        }
      }
    }

    const tasks = backend.getTableData('tasks', 'active');
    const mirrored = tasks.rows.find(r => r.id === 'n1');
    assert.strictEqual(mirrored.date, '2026-02-20');
  });

  it('deleting note deletes tasks mirror row', () => {
    // Delete from source
    backend.deleteRow('notes', 'n1', 'active');

    // Simulate deleteRow mirror propagation
    const source = 'notes';
    for (const mt in SCHEMA) {
      if (getTableMirrorSource(SCHEMA, mt) === source) {
        backend.deleteRow(mt, 'n1', SCHEMA[mt].partition);
      }
    }

    const tasks = backend.getTableData('tasks', 'active');
    const mirrored = tasks.rows.find(r => r.id === 'n1');
    assert.strictEqual(mirrored, undefined);
  });
});

describe('archive propagation to mirror tables', () => {
  let backend;
  beforeEach(() => { backend = createLocalBackend(); backend.initSchema(SCHEMA); });
  afterEach(() => { backend.close(); });

  it('archiving master row also archives mirrored row', () => {
    let masterTable = null, mirrorTable = null;
    for (const t of Object.keys(SCHEMA)) {
      for (const col of Object.keys(SCHEMA[t].columns)) {
        const def = SCHEMA[t].columns[col];
        if (def && typeof def === 'object' && def.syncFrom) {
          mirrorTable = t;
          masterTable = def.syncFrom;
          break;
        }
      }
      if (masterTable) break;
    }
    if (!masterTable || !mirrorTable) return;
    const masterTab = SCHEMA[masterTable].tab || 'active';
    const mirrorTab = SCHEMA[mirrorTable].tab || 'active';
    const masterArchive = SCHEMA[masterTable].archivePartition;
    const mirrorArchive = SCHEMA[mirrorTable].archivePartition;
    if (!masterArchive || !mirrorArchive) return;

    const row = { id: 'arch1', created_at: '2026-01-01', updated_at: '2026-01-01' };
    Object.keys(SCHEMA[masterTable].columns).forEach(c => { if (!row[c]) row[c] = ''; });
    backend.putRow(masterTable, row, masterTab);
    const mirrorRow = { id: 'arch1', created_at: '2026-01-01', updated_at: '2026-01-01' };
    Object.keys(SCHEMA[mirrorTable].columns).forEach(c => { if (!mirrorRow[c]) mirrorRow[c] = ''; });
    backend.putRow(mirrorTable, mirrorRow, mirrorTab);

    backend.moveRow(masterTable, row, masterTab, masterArchive);
    backend.moveRow(mirrorTable, mirrorRow, mirrorTab, mirrorArchive);

    assert.equal(backend.getTableData(masterTable, masterTab).rows.find(r => r.id === 'arch1'), undefined);
    assert.equal(backend.getTableData(mirrorTable, mirrorTab).rows.find(r => r.id === 'arch1'), undefined);
    assert.ok(backend.getTableData(masterTable, masterArchive).rows.find(r => r.id === 'arch1'));
    assert.ok(backend.getTableData(mirrorTable, mirrorArchive).rows.find(r => r.id === 'arch1'));
  });
});

describe('hasMaster (view over mirror-detail suppresses add/archive/delete)', () => {
  // Mirrors app-core.js hasMaster: a view whose EVERY source is a mirror-detail (syncFrom a master)
  // inherits that master, so canMutateRows (= !hasMaster && ...) hides independent add/archive/delete —
  // the detail rows are cloned/archived/deleted with the master (the meeting). Cells stay editable
  // because cellReadonly is gated per-column, independent of hasMaster.
  function hasMaster(currentTable, VIEWS, tables) {
    var v = VIEWS[currentTable];
    if (v) {
      var srcs = v.sources || [];
      return srcs.length > 0 && srcs.every(function(s) { return !!getTableMirrorSource(tables, s); });
    }
    return !!getTableMirrorSource(tables, currentTable);
  }

  const tables = {
    meetings: { columns: { pvm: { type: 'date' }, theme: { type: 'text' } } },                    // master
    music:    { columns: { pvm: { type: 'date', syncFrom: 'meetings' }, pianist: { type: 'text' } } }, // detail
    interp:   { columns: { pvm: { type: 'date', syncFrom: 'meetings' }, who: { type: 'text' } } }      // detail
  };
  const VIEWS = {
    music:   { name: 'music', sources: ['music'] },
    interp:  { name: 'interp', sources: ['interp'] },
    program: { name: 'program', sources: ['meetings', 'music'] }, // mixes the master
    agenda:  { name: 'agenda', sources: ['meetings'] },
    docpage: { name: 'docpage', markdown: '# hi' }               // no sources
  };

  it('view over a single mirror-detail table HAS a master', () => {
    assert.equal(hasMaster('music', VIEWS, tables), true);
    assert.equal(hasMaster('interp', VIEWS, tables), true);
  });
  it('view mixing in a master source stays master-less', () => {
    assert.equal(hasMaster('program', VIEWS, tables), false);
  });
  it('view over the master table itself stays master-less (remains mutable)', () => {
    assert.equal(hasMaster('agenda', VIEWS, tables), false);
  });
  it('doc-view (no sources) has no master', () => {
    assert.equal(hasMaster('docpage', VIEWS, tables), false);
  });
  it('a bare detail table (not a view) still has a master', () => {
    assert.equal(hasMaster('music', {}, tables), true);
  });
});
