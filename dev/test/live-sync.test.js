const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const LiveSync = require('../../live-sync');

// The reconciler behind backend.subscribeTable (Firestore onSnapshot / Supabase realtime / the dev
// server's SSE stream all normalize to the same change shape). What is actually load-bearing here is
// not "does the row update" but the two things that make live updates safe to switch on at all:
// row-object IDENTITY survives an update, and changes arriving mid-edit are held rather than applied.

describe('live-sync — store to dataCache key', () => {
  it('maps the active partition to the bare table name and leaves archive alone', () => {
    // aKey(table) in schema-loader.js produces exactly 'tasks__archive', so the archive store name IS
    // its cache key; only the active suffix has to come off.
    assert.equal(LiveSync.cacheKeyFor('tasks__active'), 'tasks');
    assert.equal(LiveSync.cacheKeyFor('tasks__archive'), 'tasks__archive');
    assert.equal(LiveSync.cacheKeyFor('_pages__active'), '_pages');
  });

  it('leaves a name it does not recognize untouched rather than guessing', () => {
    assert.equal(LiveSync.cacheKeyFor('weird'), 'weird');
    assert.equal(LiveSync.cacheKeyFor(''), '');
  });
});

describe('live-sync — applyChange', () => {
  it('MERGES onto the existing row object without replacing it', () => {
    // The invariant the whole feature rests on: currentData, an open <data-cell>'s `item` prop and the
    // mirror lookups all hold this same object. Replacing it is what repaints a cell mid-keystroke.
    const row = { id: 'r1', a: 'A', b: 'B' };
    const rows = [row];
    const changed = LiveSync.applyChange(rows, { type: 'put', id: 'r1', row: { id: 'r1', a: 'A2' } });
    assert.equal(changed, true);
    assert.equal(rows[0], row, 'same object identity');
    assert.equal(row.a, 'A2', 'changed field applied');
    assert.equal(row.b, 'B', 'field absent from the change is preserved');
  });

  it('appends a row it has never seen', () => {
    const rows = [{ id: 'r1' }];
    assert.equal(LiveSync.applyChange(rows, { type: 'put', id: 'r2', row: { id: 'r2', a: 'A' } }), true);
    assert.deepEqual(rows.map(r => r.id), ['r1', 'r2']);
  });

  it('reports no change when every field already matches (our own echo)', () => {
    // Every backend echoes the writer's own change back. Applying it is harmless, but it must not
    // report a change, or each local edit would schedule a full view rebuild for nothing.
    const rows = [{ id: 'r1', a: 'A' }];
    assert.equal(LiveSync.applyChange(rows, { type: 'put', id: 'r1', row: { id: 'r1', a: 'A' } }), false);
  });

  it('removes a deleted row, and shrugs at one that is already gone', () => {
    const rows = [{ id: 'r1' }, { id: 'r2' }];
    assert.equal(LiveSync.applyChange(rows, { type: 'delete', id: 'r1' }), true);
    assert.deepEqual(rows.map(r => r.id), ['r2']);
    // Supabase broadcasts DELETEs unfiltered by RLS, so a client can receive a delete for a row it was
    // never allowed to see and never cached. That has to be a silent no-op.
    assert.equal(LiveSync.applyChange(rows, { type: 'delete', id: 'nope' }), false);
  });

  it('ignores a malformed change instead of corrupting the array', () => {
    const rows = [{ id: 'r1' }];
    assert.equal(LiveSync.applyChange(rows, { type: 'put', id: 'r2', row: null }), false);
    assert.equal(LiveSync.applyChange(rows, null), false);
    assert.equal(LiveSync.applyChange(null, { type: 'put', id: 'r1', row: {} }), false);
    assert.deepEqual(rows.map(r => r.id), ['r1']);
  });
});

describe('live-sync — hold and flush', () => {
  const cacheOf = (tables) => (key) => tables[key];

  it('applies immediately when nothing is held', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }] };
    const st = LiveSync.createState();
    const r = LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { a: 'A2' } }, false, cacheOf(tables));
    assert.deepEqual(r, { applied: true, queued: false });
    assert.equal(tables.tasks[0].a, 'A2');
  });

  it('queues instead of applying while an edit is in flight', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }] };
    const st = LiveSync.createState();
    const r = LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { a: 'A2' } }, true, cacheOf(tables));
    assert.deepEqual(r, { applied: false, queued: true });
    assert.equal(tables.tasks[0].a, 'A', 'untouched until flush');

    assert.deepEqual(LiveSync.flush(st, cacheOf(tables)), ['tasks']);
    assert.equal(tables.tasks[0].a, 'A2', 'landed on flush');
  });

  it('collapses a burst on one row into a single merged put', () => {
    // A remote client saving three columns arrives as three changes. They must replay as one merge, or
    // a held burst turns into N rebuilds of the calendar/rotation/pivot the moment focus leaves.
    const tables = { tasks: [{ id: 'r1' }] };
    const st = LiveSync.createState();
    ['a', 'b', 'c'].forEach(col => {
      const patch = {}; patch[col] = col.toUpperCase();
      LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: patch }, true, cacheOf(tables));
    });
    assert.equal(st.order.length, 1, 'one queue entry for one row');
    assert.deepEqual(LiveSync.flush(st, cacheOf(tables)), ['tasks']);
    assert.deepEqual(tables.tasks[0], { id: 'r1', a: 'A', b: 'B', c: 'C' });
  });

  it('lets a queued delete win over an earlier queued put on the same row', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }] };
    const st = LiveSync.createState();
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { a: 'A2' } }, true, cacheOf(tables));
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'delete', id: 'r1' }, true, cacheOf(tables));
    LiveSync.flush(st, cacheOf(tables));
    assert.deepEqual(tables.tasks, [], 'row is gone; the stale put did not resurrect it');
  });

  it('lets a queued put win over an earlier queued delete (unarchive, re-create)', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }] };
    const st = LiveSync.createState();
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'delete', id: 'r1' }, true, cacheOf(tables));
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { id: 'r1', a: 'A3' } }, true, cacheOf(tables));
    LiveSync.flush(st, cacheOf(tables));
    assert.deepEqual(tables.tasks.map(r => r.id), ['r1']);
    assert.equal(tables.tasks[0].a, 'A3');
  });

  it('keeps rows of different tables and partitions apart', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }], tasks__archive: [{ id: 'r1', a: 'OLD' }] };
    const st = LiveSync.createState();
    LiveSync.queueOrApply(st, 'tasks__archive', { type: 'put', id: 'r1', row: { a: 'ARCHIVED' } }, true, cacheOf(tables));
    LiveSync.flush(st, cacheOf(tables));
    assert.equal(tables.tasks[0].a, 'A', 'active partition untouched');
    assert.equal(tables.tasks__archive[0].a, 'ARCHIVED');
  });

  it('drops changes for a table that is not cached at all', () => {
    // An unwatched/uncached table is fetched fresh (already current) whenever something opens it, so
    // holding changes for it would only grow the queue forever.
    const st = LiveSync.createState();
    const r = LiveSync.queueOrApply(st, 'other__active', { type: 'put', id: 'r1', row: { a: 'A' } }, false, cacheOf({}));
    assert.deepEqual(r, { applied: false, queued: false });
  });

  it('flush reports nothing when the queue held only echoes, so no rebuild is scheduled', () => {
    const tables = { tasks: [{ id: 'r1', a: 'A' }] };
    const st = LiveSync.createState();
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { a: 'A' } }, true, cacheOf(tables));
    assert.deepEqual(LiveSync.flush(st, cacheOf(tables)), []);
  });

  it('empties the queue after a flush', () => {
    const tables = { tasks: [{ id: 'r1' }] };
    const st = LiveSync.createState();
    LiveSync.queueOrApply(st, 'tasks__active', { type: 'put', id: 'r1', row: { a: 'A' } }, true, cacheOf(tables));
    LiveSync.flush(st, cacheOf(tables));
    assert.deepEqual(st.order, []);
    assert.deepEqual(LiveSync.flush(st, cacheOf(tables)), [], 'a second flush is a no-op');
  });
});
