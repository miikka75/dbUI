const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');
const { SCHEMA, VIEWS, getColumns } = require('../schema');

// A join view whose rows span multiple source tables, matched by id
const joinView = Object.values(VIEWS).find(v => v.mode === 'join' && v.sources && v.sources.length > 1);

let backend;
beforeEach(() => { backend = createLocalBackend(); backend.initSchema('local', SCHEMA); });
afterEach(() => { backend.close(); });

// archiveRow/restoreRow fan-out: iterate the view's sources (mirrors app-core.html)
function fanMove(id, sources, dir) {
  sources.forEach(function(src) {
    var active = SCHEMA[src].partition, archive = SCHEMA[src].archivePartition;
    if (!archive) return;
    var from = dir === 'archive' ? active : archive, to = dir === 'archive' ? archive : active;
    var row = backend.getTableData(src, from).rows.find(function(r) { return r.id === id; });
    if (row) backend.moveRow(src, row, from, to);
  });
}
function presentIn(id, sources, where) {
  return sources.map(function(src) {
    var tab = where === 'active' ? SCHEMA[src].partition : SCHEMA[src].archivePartition;
    return !!backend.getTableData(src, tab).rows.find(function(r) { return r.id === id; });
  });
}

describe('Multi-table row lifecycle (join view)', () => {
  it('add -> archive -> restore -> delete stays in sync across all source tables', () => {
    assert.ok(joinView, 'expected a join view spanning multiple tables');
    var sources = joinView.sources, id = 'lc1';
    var all = sources.map(function() { return true; }), none = sources.map(function() { return false; });
    // master = the source others syncFrom (downstream mirror creation, as app-core addRow does)
    var master = sources.find(function(s) {
      return sources.some(function(o) { return Object.values(SCHEMA[o].columns).some(function(d) { return d && typeof d === 'object' && d.syncFrom === s; }); });
    }) || sources[0];

    // ADD: create master row + propagate to mirror sources
    var mrow = { id: id }; getColumns(master).forEach(function(c) { mrow[c] = mrow[c] || (c === 'title' ? 'Hello' : ''); });
    backend.putRow(master, mrow, SCHEMA[master].partition);
    sources.filter(function(s) { return s !== master; }).forEach(function(s) {
      var cols = SCHEMA[s].columns, row = { id: id };
      getColumns(s).forEach(function(c) { if (c === 'id') return; row[c] = (cols[c] && cols[c].syncFrom) ? (mrow[c] || '') : ''; });
      backend.putRow(s, row, SCHEMA[s].partition);
    });
    assert.deepEqual(presentIn(id, sources, 'active'), all, 'row exists in ALL sources after add');

    // ARCHIVE: all sources active -> archive
    fanMove(id, sources, 'archive');
    assert.deepEqual(presentIn(id, sources, 'active'), none, 'gone from active in all sources');
    assert.deepEqual(presentIn(id, sources, 'archive'), all, 'present in archive in all sources');

    // RESTORE: all sources archive -> active
    fanMove(id, sources, 'active');
    assert.deepEqual(presentIn(id, sources, 'active'), all, 'restored to active in all sources');
    assert.deepEqual(presentIn(id, sources, 'archive'), none, 'gone from archive in all sources');

    // DELETE: remove from all sources
    sources.forEach(function(s) { backend.deleteRow(s, id, SCHEMA[s].partition); });
    assert.deepEqual(presentIn(id, sources, 'active'), none, 'removed from all sources');
  });
});
