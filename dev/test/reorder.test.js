// reorder.test.js — the three position-renumbering paths, and the pure core they now share.
//
// CHARACTERISATION FIRST. The tests in the first describe below were written against the ORIGINAL
// hand-rolled implementations and had to pass before reorder.js existed, so they pin behaviour rather
// than describe an intention. That matters here because reordering writes to every row between the old
// slot and the new one, and a refactor that quietly changed which rows get written would be invisible
// until somebody's roster came back in a different order.
//
// The paths: moveRowPosition (a data grid), moveRefChild (a value inside one lookup group) and
// moveRefGroup (a whole lookup group). All three end the same way — walk the final display order,
// assign 1..n, write only what changed — which is what Reorder.renumber now owns.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Reorder = require('../../reorder');
const Undo = require('../../undo');
const { appCoreFn } = require('./app-core-fn');

// Record what a reorder would write, without a backend.
function capture() {
  const ops = [], writes = [];
  const realRecord = Undo.record, realAction = Undo.action;
  Undo.record = (op) => ops.push(op);
  Undo.action = (_name, fn) => fn();
  return {
    ops, writes,
    Writes: { putRow: (t, row, tab) => { writes.push({ t, row, tab }); return Promise.resolve(); } },
    restore: () => { Undo.record = realRecord; Undo.action = realAction; },
  };
}

const row = (id, position) => ({ id, position });

// The three move* methods delegate the WRITING to _writeReorder, so lift that from the shipped file
// too and hang it on the ctx. Stubbing it instead would leave the assertions below measuring a stub:
// the undo records and the position-only write shape are exactly what is being pinned.
function withWriter(ctx, Writes) {
  ctx._writeReorder = appCoreFn('_writeReorder', { Writes, Undo });
  return ctx;
}

describe('Reorder.move — the bounds-checked array move', () => {
  it('moves an item one slot and returns a NEW array', () => {
    const src = ['a', 'b', 'c'];
    assert.deepEqual(Reorder.move(src, 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(src, ['a', 'b', 'c'], 'the caller still holds the original');
  });

  it('moves down as well as up', () => {
    assert.deepEqual(Reorder.move(['a', 'b', 'c'], 0, +1), ['b', 'a', 'c']);
  });

  // Returning null rather than clamping: the callers use it as "this arrow does nothing", and a clamp
  // would make the top item's up-arrow silently rewrite every position to the values they already had.
  it('returns null at either edge, and for an index that is not in the list', () => {
    assert.equal(Reorder.move(['a', 'b'], 0, -1), null);
    assert.equal(Reorder.move(['a', 'b'], 1, +1), null);
    assert.equal(Reorder.move(['a', 'b'], -1, -1), null);
    assert.equal(Reorder.move([], 0, -1), null);
  });
});

describe('Reorder.renumber — which rows a reorder actually has to write', () => {
  it('numbers from 1 and reports only the rows whose position changed', () => {
    const rows = [row('a', '1'), row('c', '3'), row('b', '2')];
    assert.deepEqual(Reorder.renumber(rows), [
      { row: rows[1], id: 'c', from: '3', to: '2' },
      { row: rows[2], id: 'b', from: '2', to: '3' },
    ]);
  });

  it('writes nothing when the order already matches the positions', () => {
    assert.deepEqual(Reorder.renumber([row('a', '1'), row('b', '2')]), []);
  });

  // THE BUG THIS LOGIC WAS WRITTEN FOR, per the comment moveRefChild carried: an earlier version
  // SWAPPED the two rows' position values, which moves nothing when neither row has one. A roster whose
  // rows arrived by import or seeding has no positions at all, and the arrows silently did nothing.
  it('numbers rows that have NO position, which is the import/seed case that broke before', () => {
    const rows = [row('a', undefined), row('b', undefined), row('c', '')];
    assert.deepEqual(Reorder.renumber(rows).map((c) => [c.id, c.to]), [['a', '1'], ['b', '2'], ['c', '3']]);
  });

  it('normalises a numerically-equal but differently-written position', () => {
    // '01' and 1 are the same number and a different string. sortedData orders by localeCompare, so a
    // stored '01' sorts before '1' and the display order stops matching the stored one -- rewriting it
    // is the fix. The three original implementations disagreed here (two compared with Number(), one
    // with String()); sharing one comparison is what makes them agree.
    assert.deepEqual(Reorder.renumber([row('a', '01')]).map((c) => [c.id, c.from, c.to]), [['a', '01', '1']]);
  });

  it('always stores the position as a string', () => {
    // sortedData sorts via localeCompare, which throws on a number.
    for (const c of Reorder.renumber([row('a', 5), row('b', 1)])) assert.equal(typeof c.to, 'string');
  });
});

describe('the three reorder paths, through the shipped code', () => {
  it('moveRowPosition: moving a row up renumbers it and the row it passed', () => {
    const rows = [row('a', '1'), row('b', '2'), row('c', '3')];
    const c = capture();
    try {
      appCoreFn('moveRowPosition', { Writes: c.Writes, Undo, Reorder })
        .call(withWriter({ isReorderable: true, currentTable: 'notes', sortedData: rows }, c.Writes), rows[2], -1);
    } finally { c.restore(); }

    const byId = Object.fromEntries(c.ops.map((o) => [o.forward.id, o]));
    assert.deepEqual(Object.keys(byId).sort(), ['b', 'c']);
    assert.equal(byId.c.forward.row.position, '2');
    assert.equal(byId.c.inverse.row.position, '3');
    assert.equal(byId.b.forward.row.position, '3');
    assert.equal(byId.b.inverse.row.position, '2');
    // A reorder says nothing about a row's other columns, so neither the write nor the undo may carry them.
    for (const o of c.ops) assert.deepEqual(Object.keys(o.inverse.row).sort(), ['id', 'position']);
    for (const w of c.writes) assert.deepEqual(Object.keys(w.row).sort(), ['id', 'position', 'updated_at']);
  });

  it('moveRowPosition: does nothing at the edge, and nothing when the view is not reorderable', () => {
    const rows = [row('a', '1'), row('b', '2')];
    for (const [ctx, item, dir] of [
      [{ isReorderable: true, currentTable: 'n', sortedData: rows }, rows[0], -1],
      [{ isReorderable: false, currentTable: 'n', sortedData: rows }, rows[1], -1],
    ]) {
      const c = capture();
      try {
        appCoreFn('moveRowPosition', { Writes: c.Writes, Undo, Reorder }).call(withWriter(ctx, c.Writes), item, dir);
      } finally { c.restore(); }
      assert.deepEqual(c.writes, [], 'no write');
    }
  });

  // A lookup's rows are numbered across the WHOLE table, not 1..n per group: moveRefGroup numbers
  // globally, so per-group numbering would give every group its own 1..n and collide them.
  const refCtx = (tree, table) => {
    const rows = [];
    tree.forEach((n) => n.children.forEach((ch) => rows.push(ch.row)));
    return {
      refReorderable: true, canEditCurrentRef: true, currentRefTable: table || 'ref_duties',
      refParentCol: 'parent', refTree: tree, refTableData: rows,
      _refGroupRows: function(parentVal) {
        const key = parentVal == null ? '' : String(parentVal);
        const node = this.refTree.find((n) => n.value === key);
        return node ? node.children.map((ch) => ch.row) : [];
      },
    };
  };
  const node = (value, rows) => ({ value, children: rows.map((r) => ({ row: r })) });

  it('moveRefChild: reorders inside its group, keeping the slots the group already held', () => {
    const g1 = [row('a', '1'), row('b', '2')];
    const g2 = [row('c', '3'), row('d', '4')];
    g1.concat(g2).forEach((r) => { r.parent = g1.includes(r) ? 'G1' : 'G2'; });
    const ctx = refCtx([node('G1', g1), node('G2', g2)]);
    const c = capture();
    try {
      appCoreFn('moveRefChild', { Writes: c.Writes, Undo, Reorder }).call(withWriter(ctx, c.Writes), g2[1], -1);
    } finally { c.restore(); }

    // d and c swap, inside slots 3 and 4. G1 is untouched.
    const byId = Object.fromEntries(c.ops.map((o) => [o.forward.id, o.forward.row.position]));
    assert.deepEqual(byId, { d: '3', c: '4' });
  });

  it('moveRefChild: does nothing at the edge of its own group', () => {
    const g1 = [row('a', '1'), row('b', '2')];
    g1.forEach((r) => { r.parent = 'G1'; });
    const c = capture();
    try {
      appCoreFn('moveRefChild', { Writes: c.Writes, Undo, Reorder }).call(withWriter(refCtx([node('G1', g1)]), c.Writes), g1[0], -1);
    } finally { c.restore(); }
    assert.deepEqual(c.writes, []);
  });

  it('moveRefGroup: swaps two groups and renumbers every row across the table', () => {
    const g1 = [row('a', '1'), row('b', '2')];
    const g2 = [row('c', '3')];
    const ctx = refCtx([node('G1', g1), node('G2', g2)]);
    const c = capture();
    try {
      appCoreFn('moveRefGroup', { Writes: c.Writes, Undo, Reorder }).call(withWriter(ctx, c.Writes), 'G2', -1);
    } finally { c.restore(); }

    // G2 moves above G1: c becomes 1, a becomes 2, b becomes 3.
    const byId = Object.fromEntries(c.ops.map((o) => [o.forward.id, o.forward.row.position]));
    assert.deepEqual(byId, { c: '1', a: '2', b: '3' });
  });

  it('moveRefGroup: does nothing at the edge, or without the edit grant', () => {
    const g1 = [row('a', '1')], g2 = [row('b', '2')];
    const tree = [node('G1', g1), node('G2', g2)];
    for (const ctx of [refCtx(tree), Object.assign(refCtx(tree), { canEditCurrentRef: false })]) {
      const c = capture();
      try {
        appCoreFn('moveRefGroup', { Writes: c.Writes, Undo, Reorder })
          .call(withWriter(ctx, c.Writes), ctx.canEditCurrentRef ? 'G1' : 'G2', -1);
      } finally { c.restore(); }
      assert.deepEqual(c.writes, []);
    }
  });
});
