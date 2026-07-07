const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Pivot = require('../../pivot');

describe('pivot.js — count grid', () => {
  const log = [
    { person: 'Ann', chore: 'dishes' }, { person: 'Ann', chore: 'dishes' }, { person: 'Ann', chore: 'trash' },
    { person: 'Bob', chore: 'trash' }, { person: 'Bob', chore: 'vacuum' }
  ];

  it('rows x columns with cell counts, sorted keys', () => {
    const p = Pivot.build(log, { row: 'person', column: 'chore', aggregate: 'count' });
    assert.deepEqual(p.columns, ['dishes', 'trash', 'vacuum']);          // sorted
    assert.deepEqual(p.rows.map(r => r.key), ['Ann', 'Bob']);
    assert.deepEqual(p.rows[0].cells, [2, 1, '']);                        // Ann: dishes x2, trash x1, no vacuum
    assert.deepEqual(p.rows[1].cells, ['', 1, 1]);                        // Bob
  });

  it('totals: per-row, per-column and grand marginals', () => {
    const p = Pivot.build(log, { row: 'person', column: 'chore', aggregate: 'count', totals: 'count' });
    assert.deepEqual(p.rows.map(r => r.total), [3, 2]);                   // Ann did 3, Bob 2
    assert.deepEqual(p.columnTotals, [2, 2, 1]);                          // dishes 2, trash 2, vacuum 1
    assert.equal(p.grandTotal, 5);
  });
});

describe('pivot.js — value grid (status matrix)', () => {
  const rsvps = [
    { owner: 'a@x', practice: '2026-07-01', status: 'coming' },
    { owner: 'a@x', practice: '2026-07-08', status: 'out' },
    { owner: 'b@x', practice: '2026-07-01', status: 'maybe' }
  ];

  it('first value per cell; blank where no row exists', () => {
    const p = Pivot.build(rsvps, { row: 'owner', column: 'practice', cell: 'status' });
    assert.deepEqual(p.columns, ['2026-07-01', '2026-07-08']);
    assert.deepEqual(p.rows[0], { key: 'a@x', cells: ['coming', 'out'], total: null });
    assert.deepEqual(p.rows[1], { key: 'b@x', cells: ['maybe', ''], total: null });
  });

  it('totals { eq } counts matching cells per column (e.g. "coming")', () => {
    const p = Pivot.build(rsvps, { row: 'owner', column: 'practice', cell: 'status', totals: { eq: 'coming' } });
    assert.deepEqual(p.columnTotals, [1, 0]);                             // 1 coming on 07-01, 0 on 07-08
    assert.equal(p.grandTotal, 1);
  });

  it('explicit colOrder keeps order + shows empty columns for missing keys', () => {
    const p = Pivot.build(rsvps, { row: 'owner', column: 'practice', cell: 'status', colOrder: ['2026-07-08', '2026-07-01', '2026-07-15'] });
    assert.deepEqual(p.columns, ['2026-07-08', '2026-07-01', '2026-07-15']);
    assert.deepEqual(p.rows[0].cells, ['out', 'coming', '']);            // 07-15 empty (no data), order preserved
  });
});

describe('pivot.js — aggregates + multiselect expansion', () => {
  it('sum aggregates a numeric cell', () => {
    const rows = [{ who: 'A', mo: 'Jan', pts: '3' }, { who: 'A', mo: 'Jan', pts: '2' }, { who: 'A', mo: 'Feb', pts: '5' }];
    const p = Pivot.build(rows, { row: 'who', column: 'mo', cell: 'pts', aggregate: 'sum', colOrder: ['Jan', 'Feb'] });
    assert.deepEqual(p.rows[0].cells, [5, 5]);
  });

  it('list joins distinct cell values', () => {
    const rows = [{ team: 'Red', day: 'Mon', who: 'Ann' }, { team: 'Red', day: 'Mon', who: 'Bob' }, { team: 'Red', day: 'Mon', who: 'Ann' }];
    const p = Pivot.build(rows, { row: 'team', column: 'day', cell: 'who', aggregate: 'list' });
    assert.deepEqual(p.rows[0].cells, ['Ann, Bob']);
  });

  it('array-valued (multiselect) keys expand to multiple rows/columns', () => {
    const rows = [{ crew: ['Ann', 'Bob'], area: 'kitchen' }];
    const p = Pivot.build(rows, { row: 'crew', column: 'area', aggregate: 'count' });
    assert.deepEqual(p.rows.map(r => r.key), ['Ann', 'Bob']);
    assert.deepEqual(p.rows[0].cells, [1]);
    assert.deepEqual(p.rows[1].cells, [1]);
  });

  it('empty row/column keys are skipped', () => {
    const rows = [{ r: 'A', c: 'x' }, { r: '', c: 'x' }, { r: 'A', c: '' }];
    const p = Pivot.build(rows, { row: 'r', column: 'c', aggregate: 'count' });
    assert.deepEqual(p.rows.map(r => r.key), ['A']);
    assert.deepEqual(p.columns, ['x']);
    assert.deepEqual(p.rows[0].cells, [1]);
  });
});
