// undo.test.js — the local undo/redo stack, and the shipped saveField that feeds it.
//
// Two halves, for the two ways this feature goes wrong:
//   (1) the stack itself — grouping, ordering, the redo branch, replay not recording itself;
//   (2) the before-image — an op whose `inverse` does not hold what the row actually said before is
//       worse than no undo, because it silently writes a value the row never had. That half is
//       asserted against the SHIPPED saveField (lifted by app-core-fn), not a copy of it.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { appCoreFn } = require('./app-core-fn');

const Undo = require('../../undo');

// A fake funnel with the same contract as writes.js: always a promise, records what it was asked to do.
function fakeWrites() {
  const calls = [];
  globalThis.Writes = {
    putRow: (t, r, p) => { calls.push(['put', t, JSON.parse(JSON.stringify(r)), p]); return Promise.resolve(); },
    deleteRow: (t, i, p) => { calls.push(['del', t, i, p]); return Promise.resolve(); }
  };
  return calls;
}

// The clock is stamped at replay time, not carried in the op (see undo.js), so assertions about the
// payload compare everything else.
const stripClock = (call) => { const c = call.slice(); const r = Object.assign({}, c[2]); delete r.updated_at; c[2] = r; return c; };

const put = (table, part, id, before, after, label) => ({
  table, part, label,
  forward: { type: 'put', id, row: Object.assign({ id }, after) },
  inverse: { type: 'put', id, row: Object.assign({ id }, before) }
});

describe('undo — the stack', () => {
  beforeEach(() => { Undo.clear(); Undo.configure({ apply: null, onChange: null }); });

  it('undoes the last action and redoes it', async () => {
    const calls = fakeWrites();
    Undo.record(put('tasks', 'active', 'r1', { title: 'old' }, { title: 'new' }, 'edit'));
    assert.equal(Undo.canUndo(), true);
    assert.equal(Undo.canRedo(), false);

    assert.equal(await Undo.undo(), 'edit');
    assert.deepEqual(stripClock(calls.pop()), ['put', 'tasks', { id: 'r1', title: 'old' }, 'active']);
    assert.equal(Undo.canUndo(), false);
    assert.equal(Undo.canRedo(), true);

    assert.equal(await Undo.redo(), 'edit');
    assert.deepEqual(stripClock(calls.pop()), ['put', 'tasks', { id: 'r1', title: 'new' }, 'active']);
    assert.equal(Undo.canUndo(), true);
  });

  it('an inverse is a PARTIAL patch — it names only what changed', async () => {
    // This is the whole reason undo is safe to run against live data: the backends merge partials, so
    // taking back an edit to `title` must not carry this client's stale copy of every other column.
    const calls = fakeWrites();
    Undo.record(put('tasks', 'active', 'r1', { title: 'old' }, { title: 'new' }));
    await Undo.undo();
    assert.deepEqual(Object.keys(calls[0][2]).sort(), ['id', 'title', 'updated_at']);
  });

  it('one action groups many writes into one press', async () => {
    const calls = fakeWrites();
    Undo.action('rename', () => {
      Undo.record(put('t', 'active', 'a', { g: 'old' }, { g: 'new' }));
      Undo.record(put('t', 'active', 'b', { g: 'old' }, { g: 'new' }));
      Undo.record(put('t', 'active', 'c', { g: 'old' }, { g: 'new' }));
    });
    assert.equal(await Undo.undo(), 'rename');
    assert.equal(calls.length, 3, 'one press must take back all three rows, not one of them');
    assert.equal(Undo.canUndo(), false, 'and must leave nothing behind for a second press');
  });

  it('a nested action joins the outer one rather than opening a second entry', async () => {
    // saveField opens an action and then calls propagateMirror, which opens its own. Two entries here
    // would mean the first Ctrl+Z reverted the mirror and left the row it mirrors untouched.
    fakeWrites();
    Undo.action('edit', () => {
      Undo.record(put('t', 'active', 'a', { x: '1' }, { x: '2' }));
      Undo.action('mirror', () => Undo.record(put('m', 'active', 'a', { x: '1' }, { x: '2' })));
    });
    await Undo.undo();
    assert.equal(Undo.canUndo(), false, 'the mirror write must be part of the same entry');
  });

  it('undo replays ops in reverse and redo replays them forward', async () => {
    const calls = fakeWrites();
    Undo.action('cascade', () => {
      Undo.record(put('t', 'active', 'first', { x: '0' }, { x: '1' }));
      Undo.record(put('t', 'active', 'second', { x: '0' }, { x: '1' }));
    });
    await Undo.undo();
    assert.deepEqual(calls.map((c) => c[2].id), ['second', 'first']);
    calls.length = 0;
    await Undo.redo();
    assert.deepEqual(calls.map((c) => c[2].id), ['first', 'second']);
  });

  it('a replay does not record itself', async () => {
    // The loop this prevents: undo writes, the write records an op, that op is undoable, forever.
    fakeWrites();
    Undo.record(put('t', 'active', 'r1', { x: 'old' }, { x: 'new' }));
    await Undo.undo();
    assert.equal(Undo.canUndo(), false);
    await Undo.redo();
    assert.equal(Undo.canRedo(), false);
  });

  it('a new action drops the redo branch', async () => {
    // Redoing across a divergence would replay a forward patch onto rows that have since moved on.
    fakeWrites();
    Undo.record(put('t', 'active', 'r1', { x: '0' }, { x: '1' }));
    await Undo.undo();
    assert.equal(Undo.canRedo(), true);
    Undo.record(put('t', 'active', 'r2', { x: '0' }, { x: '1' }));
    assert.equal(Undo.canRedo(), false);
  });

  it('a delete inverts to a put of the whole row, and a create inverts to a delete', async () => {
    const calls = fakeWrites();
    const row = { id: 'r1', title: 'gone', note: 'kept' };
    Undo.record({ table: 't', part: 'active', label: 'delete',
      forward: { type: 'delete', id: 'r1', row: null },
      inverse: { type: 'put', id: 'r1', row: row } });
    await Undo.undo();
    assert.deepEqual(stripClock(calls.pop()), ['put', 't', row, 'active'],
      'a deleted row has no partial to merge onto — its inverse must carry every column');

    Undo.record({ table: 't', part: 'active', label: 'add',
      forward: { type: 'put', id: 'r2', row: { id: 'r2' } },
      inverse: { type: 'delete', id: 'r2', row: null } });
    await Undo.undo();
    assert.deepEqual(calls.pop(), ['del', 't', 'r2', 'active']);
  });

  it('patches the local cache before it writes, using the live-sync merge', async () => {
    // Undo has to look instant, and it must not grow a second merge implementation to do it.
    const LiveSync = require('../../live-sync');
    fakeWrites();
    const rows = [{ id: 'r1', title: 'new', note: 'untouched' }];
    Undo.configure({ apply: (table, part, change) => LiveSync.applyChange(rows, change) });
    Undo.record(put('t', 'active', 'r1', { title: 'old' }, { title: 'new' }));
    await Undo.undo();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'old');
    assert.equal(rows[0].note, 'untouched', 'the merge must not disturb a column the op says nothing about');
  });

  it('stamps the clock at replay time rather than replaying a stored one', async () => {
    // An undo is a write happening now. Replaying the timestamp the row carried when it was edited
    // would leave a row the user just touched claiming it had sat still since before the edit — which
    // is what archiveAfter measures age by.
    const calls = fakeWrites();
    const before = new Date().toISOString();
    Undo.record(put('t', 'active', 'r1', { x: 'old', updated_at: '2020-01-01T00:00:00.000Z' }, { x: 'new' }));
    await Undo.undo();
    assert.ok(calls[0][2].updated_at >= before, 'expected a fresh stamp, got ' + calls[0][2].updated_at);
  });

  it('reports depth changes so the buttons can be reactive', () => {
    fakeWrites();
    const seen = [];
    Undo.configure({ onChange: (u, r) => seen.push([u, r]) });
    Undo.record(put('t', 'active', 'r1', { x: '0' }, { x: '1' }));
    assert.deepEqual(seen.pop(), [1, 0]);
  });

  it('undo and redo on an empty stack are no-ops, not errors', async () => {
    delete globalThis.Writes;   // and must not even reach for the funnel
    assert.equal(await Undo.undo(), null);
    assert.equal(await Undo.redo(), null);
  });

  it('clear() empties both stacks', async () => {
    fakeWrites();
    Undo.record(put('t', 'active', 'r1', { x: '0' }, { x: '1' }));
    await Undo.undo();
    Undo.clear();
    assert.equal(Undo.canUndo(), false);
    assert.equal(Undo.canRedo(), false);
  });

  it('abandon() throws the whole action away, including what came before it', async () => {
    // The restore path discovers mid-loop that one source needs a store-to-store move, whose inverse it
    // cannot honestly build. An entry that put back three mirrors of four would look like an undo.
    fakeWrites();
    Undo.action('restore', () => {
      Undo.record(put('a', 'active', 'r1', { s: 'archive' }, { s: 'active' }));
      Undo.abandon();
      Undo.record(put('b', 'active', 'r1', { s: 'archive' }, { s: 'active' }));
    });
    assert.equal(Undo.canUndo(), false, 'a poisoned action must leave nothing behind, before or after');
  });

  it('an action that records nothing leaves no empty entry', () => {
    fakeWrites();
    Undo.action('nothing happened', () => {});
    assert.equal(Undo.canUndo(), false);
  });

  it('the stack is bounded', () => {
    fakeWrites();
    for (let i = 0; i < 80; i++) Undo.record(put('t', 'active', 'r' + i, { x: '0' }, { x: '1' }));
    let n = 0;
    while (Undo.canUndo()) { Undo.undo(); n++; if (n > 200) break; }
    assert.ok(n <= 50, 'expected the stack to be capped, got ' + n);
  });
});

describe('undo — the before-image saveField records', () => {
  // saveField debounces its write by 300ms and opens the undo action inside that callback, because
  // propagateMirror runs there and an action is a synchronous scope. Mocked timers rather than a real
  // wait: four tests x 300ms of sleeping is exactly what e2e-sleep-budget exists to discourage.
  const { mock } = require('node:test');
  const flush = () => mock.timers.tick(300);
  beforeEach(() => { mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout'] }); });

  // The lifted saveField touches these file-scope globals. Anything it reads and we do not supply
  // shows up as a ReferenceError here rather than as a silently wrong op.
  function harness(opts) {
    const recorded = [];
    const written = [];
    const SCHEMA = opts.schema;
    const dataCache = opts.cache;
    const self = {
      dataCache, saveTimers: {}, currentTable: opts.table,
      notify: () => {}, t: (k) => k, propagateMirror: () => {}, _liveFlush: () => {},
      getSource: () => opts.table,
      getTab: () => 'active'
    };
    const fn = appCoreFn('saveField', {
      SCHEMA, VIEWS: {}, aKey: (t) => t + '__archive',
      getColumns: (t) => Object.keys(SCHEMA[t].columns),
      Writes: { putRow: (t, r, p) => { written.push([t, r, p]); return Promise.resolve(); } },
      Undo: {
        action: (label, f) => f(),
        record: (op) => recorded.push(op)
      }
    });
    return { fn, self, recorded, written };
  }

  const schema = { tasks: { columns: { title: 'text', note: 'text' } } };

  it('records the value the cell held BEFORE the edit, not after', () => {
    const row = { id: 'r1', title: 'before', note: 'n' };
    const h = harness({ schema, table: 'tasks', cache: { tasks: [row] } });
    h.fn.call(h.self, row, 'title', 'after');
    flush();

    assert.equal(h.recorded.length, 1, 'a cell edit must record exactly one op');
    const op = h.recorded[0];
    assert.equal(op.table, 'tasks');
    assert.equal(op.part, 'active');
    assert.equal(op.inverse.row.title, 'before',
      'the inverse carries the post-edit value — saveField assigns item[col] before recording');
    assert.equal(op.forward.row.title, 'after');
  });

  it('the recorded inverse names only the edited column', () => {
    const row = { id: 'r1', title: 'before', note: 'keep' };
    const h = harness({ schema, table: 'tasks', cache: { tasks: [row] } });
    h.fn.call(h.self, row, 'title', 'after');
    flush();
    assert.deepEqual(Object.keys(h.recorded[0].inverse.row).sort(), ['id', 'title'],
      'carrying `note` would revert a colleague\'s edit to it');
  });

  it('records nothing when the value did not change', () => {
    const row = { id: 'r1', title: 'same', note: 'n' };
    const h = harness({ schema, table: 'tasks', cache: { tasks: [row] } });
    h.fn.call(h.self, row, 'title', 'same');
    flush();
    assert.equal(h.recorded.length, 0);
  });

  it('a debounce reset keeps the FIRST before-image, not the intermediate one', () => {
    // Typing a -> b -> c inside 300ms cancels two timers and writes once. There must be one entry, and
    // it has to restore 'a' — 'b' is a value no write ever stored.
    const row = { id: 'r1', title: 'a', note: 'n' };
    const h = harness({ schema, table: 'tasks', cache: { tasks: [row] } });
    h.fn.call(h.self, row, 'title', 'b');
    h.fn.call(h.self, row, 'title', 'c');
    flush();
    assert.equal(h.recorded.length, 1, 'one write, so one undo entry');
    assert.equal(h.recorded[0].inverse.row.title, 'a');
    assert.equal(h.recorded[0].forward.row.title, 'c');
  });

  it('a row this table has never seen is a CREATE, so its inverse is a delete', () => {
    // saveField's cache-miss branch writes the whole row; undoing that has to remove it, not blank it.
    const row = { id: 'new1', title: '', note: '' };
    const h = harness({ schema, table: 'tasks', cache: { tasks: [] } });
    h.fn.call(h.self, row, 'title', 'typed');
    flush();
    assert.equal(h.recorded.length, 1);
    assert.equal(h.recorded[0].inverse.type, 'delete');
    assert.equal(h.recorded[0].inverse.id, 'new1');
  });
});

describe('undo — the row lifecycle', () => {
  // These lift the SHIPPED members, so the ops asserted here are the ops the app records. A stub would
  // only prove the test agrees with itself.
  const { appCoreFn } = require('./app-core-fn');
  const Undo = require('../../undo');

  const schema = { notes: { columns: { title: 'text' }, archivable: true },
                   plain: { columns: { title: 'text' } } };

  // Capture what the real Undo is handed, without replacing it: action/record are the shipped ones.
  function capture() {
    const ops = [];
    const orig = Undo.record;
    Undo.record = (op) => { ops.push(op); return orig.call(Undo, op); };
    return { ops, restore: () => { Undo.record = orig; } };
  }

  it('deleting a row records an inverse carrying every column', () => {
    const row = { id: 'r1', title: 'gone', note: 'kept' };
    const cache = { notes: [row] };
    const c = capture();
    try {
      appCoreFn('_deleteFromSources', {
        SCHEMA: schema, aKey: (t) => t + '__archive',
        Writes: { deleteRow: () => Promise.resolve() }
      }).call({ dataCache: cache, currentData: [], notify: () => {}, t: (k) => k }, ['notes'], 'r1');
    } finally { c.restore(); }

    assert.equal(c.ops.length, 1, 'the row was only in the active store, so only that store inverts');
    assert.equal(c.ops[0].part, 'active');
    assert.equal(c.ops[0].forward.type, 'delete');
    assert.deepEqual(c.ops[0].inverse.row, row);
    assert.notEqual(c.ops[0].inverse.row, row, 'must be a copy — the live object is dropped from the cache');
    assert.deepEqual(cache.notes, [], 'and the row really is gone');
  });

  it('deleting records nothing for a partition the row was not in', () => {
    // Inventing an inverse for a store the row never occupied would resurrect it into the archive.
    const cache = { notes: [{ id: 'r1', title: 'x' }], notes__archive: [] };
    const c = capture();
    try {
      appCoreFn('_deleteFromSources', {
        SCHEMA: schema, aKey: (t) => t + '__archive',
        Writes: { deleteRow: () => Promise.resolve() }
      }).call({ dataCache: cache, currentData: [], notify: () => {}, t: (k) => k }, ['notes'], 'r1');
    } finally { c.restore(); }
    assert.deepEqual(c.ops.map((o) => o.part), ['active']);
  });

  it('a reorder records every row it renumbered, with the position each one held', () => {
    const rows = [{ id: 'a', position: '1' }, { id: 'b', position: '2' }, { id: 'c', position: '3' }];
    const c = capture();
    try {
      appCoreFn('moveRowPosition', {
        Writes: { putRow: () => Promise.resolve() }
      }).call({ isReorderable: true, currentTable: 'notes', sortedData: rows }, rows[2], -1);
    } finally { c.restore(); }

    assert.ok(c.ops.length >= 2, 'moving c up renumbers c and b, got ' + c.ops.length);
    const byId = {};
    c.ops.forEach((o) => { byId[o.forward.id] = o; });
    assert.equal(byId.c.inverse.row.position, '3', 'c must go back to where it was');
    assert.equal(byId.b.inverse.row.position, '2');
    for (const o of c.ops) {
      assert.deepEqual(Object.keys(o.inverse.row).sort(), ['id', 'position'],
        'a reorder says nothing about a row other columns and its undo must not either');
    }
  });
});
