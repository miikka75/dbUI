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
      // moveRowPosition builds the new order; _writeReorder records and writes it. Lift both, so this
      // still measures the shipped undo records rather than a stub standing in for them.
      const Writes = { putRow: () => Promise.resolve() };
      appCoreFn('moveRowPosition', { Writes }).call({
        isReorderable: true, currentTable: 'notes', sortedData: rows,
        _writeReorder: appCoreFn('_writeReorder', { Writes }),
      }, rows[2], -1);
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

describe('undo — a write that is not a row', () => {
  // A rename writes three stores with no putRow between them (a list array, a translation key, an
  // account link). undo.js must hand those to the app without learning what any of them is.
  beforeEach(() => { Undo.clear(); Undo.configure({ apply: null, vocab: null, onChange: null }); });

  it('routes a non-row change to the vocab handler, and not to the funnel or the cache', async () => {
    const calls = fakeWrites();
    const seen = [], patched = [];
    Undo.configure({ vocab: (c) => { seen.push(c); }, apply: (t, p, c) => patched.push(c) });
    Undo.record({
      forward: { type: 'lists', list: 'status', values: ['a', 'b'] },
      inverse: { type: 'lists', list: 'status', values: ['a'] } });

    await Undo.undo();
    assert.deepEqual(seen, [{ type: 'lists', list: 'status', values: ['a'] }]);
    assert.equal(calls.length, 0, 'a list array is not a row and must not reach putRow');
    assert.equal(patched.length, 0, 'nor the row cache — there is no id to merge onto');

    await Undo.redo();
    assert.deepEqual(seen.pop(), { type: 'lists', list: 'status', values: ['a', 'b'] });
  });

  it('fails loudly when no handler is registered, rather than dropping the change', async () => {
    fakeWrites();
    Undo.record({ forward: { type: 'trans' }, inverse: { type: 'trans' } });
    await assert.rejects(() => Undo.undo(), /no handler/);
  });

  it('an action stays open across an await, so one cascade is one entry', async () => {
    // The real shape: a rename rewrites the archive partition, and an uncached partition is FETCHED
    // first. A synchronous-only scope would push every one of those rows as its own entry.
    fakeWrites();
    await Undo.action('rename', () => {
      Undo.record(put('t', 'active', 'a', { g: 'old' }, { g: 'new' }));
      return Promise.resolve().then(() => {
        Undo.record(put('t', 'archive', 'b', { g: 'old' }, { g: 'new' }));
        Undo.record(put('t', 'archive', 'c', { g: 'old' }, { g: 'new' }));
      });
    });
    assert.equal(Undo.canUndo(), true);
    await Undo.undo();
    assert.equal(Undo.canUndo(), false, 'the rows fetched after the await belong to the same press');
  });

  it('closes the entry when the body rejects, rather than leaving it open forever', async () => {
    fakeWrites();
    await assert.rejects(() => Undo.action('rename', () => {
      Undo.record(put('t', 'active', 'a', { g: 'old' }, { g: 'new' }));
      return Promise.reject(new Error('fetch failed'));
    }));
    assert.equal(Undo.canUndo(), true, 'what did happen is still undoable');
    Undo.record(put('t', 'active', 'z', { g: '0' }, { g: '1' }));
    await Undo.undo();
    assert.equal(Undo.canUndo(), true, 'and the next write is its OWN entry, not a guest in the open one');
  });

  it('_undoVocab sends each change to the store it belongs to', async () => {
    const { appCoreFn } = require('./app-core-fn');
    const saved = [], moved = [], linked = [];
    const self = {
      listsCache: { status: ['open'] },
      saveLists: function() { saved.push(this.listsCache.status.slice()); },
      migrateListTranslation: (ns, from, to) => moved.push([ns, from, to]),
      setListUserLink: (list, value, email) => linked.push([list, value, email])
    };
    const fn = appCoreFn('_undoVocab', {});

    await fn.call(self, { type: 'lists', list: 'status', values: ['open', 'done'] });
    assert.deepEqual(saved.pop(), ['open', 'done'], 'the whole array, because saveLists writes the whole blob');

    await fn.call(self, { type: 'trans', ns: 'status', from: 'new', to: 'old' });
    assert.deepEqual(moved.pop(), ['status', 'new', 'old']);

    await fn.call(self, { type: 'link', list: 'status', value: 'open', email: 'a@b.c' });
    assert.deepEqual(linked.pop(), ['status', 'open', 'a@b.c'],
      'a link is SET, not moved: after a delete there is nothing left to move from');

    assert.throws(() => fn.call(self, { type: 'nonsense' }), /unknown change/);
  });
});

describe('undo — the value cascades', () => {
  // The shipped members, lifted. A rename is one gesture across four stores, and the failure this
  // guards is the half-undo: rows put back to a value the vocabulary no longer contains.
  const { appCoreFn } = require('./app-core-fn');

  function capture() {
    const ops = [];
    const orig = Undo.record;
    Undo.record = (op) => { ops.push(op); return orig.call(Undo, op); };
    return { ops, restore: () => { Undo.record = orig; } };
  }

  // _rewriteValueInColumns is the shared engine under every cascade — list rename, list delete, lookup
  // rename, group rename — so recording there is what makes all four reversible.
  const rewriter = () => appCoreFn('_rewriteValueInColumns', {
    aKey: (t) => t + '__archive',
    Writes: { putRow: () => Promise.resolve() },
    backend: { getTableData: () => Promise.resolve({ rows: [] }) },
    parseTableResult: (r) => ({ rows: (r && r.rows) || [] })
  });

  it('records a partial inverse per rewritten row, carrying the value it held before', async () => {
    const rows = [{ id: 'r1', status: 'open', title: 'keep' }, { id: 'r2', status: 'done' }];
    const c = capture();
    try {
      await rewriter().call({ dataCache: { tasks: rows }, listsCache: {} },
        [{ table: 'tasks', col: 'status', multi: false, altList: null }], 'open', 'started');
    } finally { c.restore(); }

    assert.equal(c.ops.length, 1, 'only the row that held the old value is rewritten, so only it records');
    assert.equal(c.ops[0].inverse.row.status, 'open');
    assert.equal(c.ops[0].forward.row.status, 'started');
    assert.deepEqual(Object.keys(c.ops[0].inverse.row).sort(), ['id', 'status'],
      'carrying `title` would revert a colleague\'s edit to it');
    assert.equal(rows[0].status, 'started', 'and the rewrite really happened');
  });

  it('leaves a row that already held the new value alone — which is why renaming back is not the inverse', async () => {
    // Renaming A onto an existing B and then re-running the cascade B -> A would drag this row back
    // with it, and it had nothing to do with the edit.
    const rows = [{ id: 'r1', status: 'open' }, { id: 'r2', status: 'done' }];
    const c = capture();
    try {
      await rewriter().call({ dataCache: { tasks: rows }, listsCache: {} },
        [{ table: 'tasks', col: 'status', multi: false, altList: null }], 'open', 'done');
    } finally { c.restore(); }

    assert.deepEqual(c.ops.map((o) => o.forward.id), ['r1']);
    assert.equal(rows[1].status, 'done');
  });

  it('a delete cascade inverts to the value it blanked, and to the whole array for a multiselect', async () => {
    // This is the sharpest unrecoverable edit in the Lists tab: removing a value empties every cell
    // that held it.
    const rows = [{ id: 'r1', people: ['ann', 'bob'] }, { id: 'r2', lead: 'ann' }];
    const c = capture();
    try {
      await rewriter().call({ dataCache: { crew: rows }, listsCache: {} }, [
        { table: 'crew', col: 'people', multi: true, altList: null },
        { table: 'crew', col: 'lead', multi: false, altList: null }
      ], 'ann', null);
    } finally { c.restore(); }

    const byId = {};
    c.ops.forEach((o) => { byId[o.forward.id] = o; });
    assert.deepEqual(byId.r1.inverse.row.people, ['ann', 'bob'], 'the array as it was, not the pruned one');
    assert.deepEqual(rows[0].people, ['bob']);
    assert.equal(byId.r2.inverse.row.lead, 'ann');
    assert.equal(rows[1].lead, '');
  });

  it('a list rename is ONE entry covering the array, the label, the link and the rows', async () => {
    // The half-undo this exists to prevent: rows back to a value the list no longer contains.
    Undo.clear();
    const written = [], vocab = [];
    globalThis.Writes = { putRow: () => Promise.resolve(), deleteRow: () => Promise.resolve() };
    Undo.configure({ apply: null, vocab: (ch) => { vocab.push(ch); } });

    const rows = [{ id: 'r1', status: 'open' }];
    const self = {
      canEditList: () => true, isLockedValue: () => false,
      listsCache: { status: ['open', 'done'] },
      listUserLinks: { status: { open: 'a@b.c' } },
      saveLists: () => {},
      migrateListUserLink: () => {}, migrateListTranslation: () => {},
      propagateListChange: function() {
        // Stands in for the real cascade: async (it fetches uncached partitions) and it records rows.
        return Promise.resolve().then(() => {
          rows[0].status = 'started';
          Undo.record({ table: 'tasks', part: 'active',
            forward: { type: 'put', id: 'r1', row: { id: 'r1', status: 'started' } },
            inverse: { type: 'put', id: 'r1', row: { id: 'r1', status: 'open' } } });
          written.push('cascade');
        });
      }
    };

    await appCoreFn('updateListItem2', {}).call(self, 'status', 0, 'started');
    assert.equal(Undo.canUndo(), true);

    await Undo.undo();
    assert.equal(Undo.canUndo(), false, 'one gesture, one press — the cascade must not be a second entry');
    const kinds = vocab.map((v) => v.type);
    assert.ok(kinds.indexOf('lists') >= 0 && kinds.indexOf('trans') >= 0 && kinds.indexOf('link') >= 0,
      'the array, the label and the link all have to come back, got ' + kinds.join(','));
    assert.deepEqual(vocab.find((v) => v.type === 'lists').values, ['open', 'done'],
      'the list array as it was before the rename');
    assert.deepEqual(vocab.filter((v) => v.type === 'link').map((v) => [v.value, v.email]),
      [['started', ''], ['open', 'a@b.c']],
      'the pair inverts as two state sets: clear the new key, restore the old one');
  });

  it('a group rename records a partial parent-column inverse for every child', () => {
    Undo.clear();
    globalThis.Writes = { putRow: () => Promise.resolve() };
    const kids = [{ id: 'c1', org: 'Music', calling: 'chorister' },
                  { id: 'c2', org: 'Music', calling: 'organist' },
                  { id: 'c3', org: 'Primary', calling: 'teacher' }];
    const c = capture();
    try {
      appCoreFn('renameRefParent', {}).call({
        canEditCurrentRef: true, isLockedRefValue: () => false,
        currentRefTable: 'ref_callings', refParentCol: 'org',
        dataCache: { ref_callings: kids },
        notify: () => {}, t: (k) => k,
        migrateListTranslation: () => {},
        propagateListChange: () => Promise.resolve(0)
      }, 'Music', 'Music and Choirs');
    } finally { c.restore(); }

    const rowOps = c.ops.filter((o) => o.forward.type === 'put');
    assert.deepEqual(rowOps.map((o) => o.forward.id), ['c1', 'c2'], 'only the group\'s own children move');
    assert.equal(rowOps[0].inverse.row.org, 'Music');
    assert.deepEqual(Object.keys(rowOps[0].inverse.row).sort(), ['id', 'org'],
      'a group rename says nothing about a child\'s other columns');
    assert.equal(kids[0].org, 'Music and Choirs');
    assert.ok(c.ops.some((o) => o.forward.type === 'trans' && o.inverse.from === 'Music and Choirs'),
      'the group label has to travel back too');
  });

  it('a lookup rename records the row and its label in one entry, at blur rather than on the timer', () => {
    // Recorded at blur because the cascade runs there; the row write stays debounced behind it.
    const { mock } = require('node:test');
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    Undo.clear();
    globalThis.Writes = { putRow: () => Promise.resolve() };

    const item = { id: 'x1', city: 'Tampre' };
    const c = capture();
    try {
      appCoreFn('saveRefField', {}).call({
        canEditCurrentRef: true, lockedListValues: {},
        currentRefTable: 'cities', dataCache: { cities: [item] },
        saveTimers: {}, notify: () => {}, t: (k) => k, _liveFlush: () => {},
        migrateListTranslation: () => {},
        propagateRefChange: () => Promise.resolve(0)
      }, item, 'city', 'Tampere');
    } finally { c.restore(); mock.timers.reset(); }

    assert.equal(c.ops.length, 2, 'the row and its translation key, in one entry');
    assert.equal(c.ops[0].inverse.row.city, 'Tampre');
    assert.deepEqual(Object.keys(c.ops[0].inverse.row).sort(), ['city', 'id']);
    assert.deepEqual([c.ops[1].forward.from, c.ops[1].forward.to], ['Tampre', 'Tampere']);
    assert.deepEqual([c.ops[1].inverse.from, c.ops[1].inverse.to], ['Tampere', 'Tampre']);
  });

  it('a lookup edit that retires nothing records the row but no rename', () => {
    // "president" is a calling of nine organizations: changing the one under Music renames nothing.
    const { mock } = require('node:test');
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    Undo.clear();
    globalThis.Writes = { putRow: () => Promise.resolve() };

    const item = { id: 'x1', calling: 'president' };
    const other = { id: 'x2', calling: 'president' };
    const c = capture();
    try {
      appCoreFn('saveRefField', {}).call({
        canEditCurrentRef: true, lockedListValues: {},
        currentRefTable: 'ref_callings', dataCache: { ref_callings: [item, other] },
        saveTimers: {}, notify: () => {}, t: (k) => k, _liveFlush: () => {},
        migrateListTranslation: () => { throw new Error('must not migrate a value still in use'); },
        propagateRefChange: () => { throw new Error('must not cascade a value still in use'); }
      }, item, 'calling', 'branch president');
    } finally { c.restore(); mock.timers.reset(); }

    assert.equal(c.ops.length, 1, 'the row edit alone');
    assert.equal(c.ops[0].inverse.row.calling, 'president');
  });
});
