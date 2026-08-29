const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Stats = require('../../stats');

describe('stats.js — explicit tiles', () => {
  const signins = [
    { who: 'ann', minutes: 30, day: '2026-08-29' },
    { who: 'bob', minutes: 45, day: '2026-08-29' },
    { who: 'cara', minutes: '', day: '2026-08-28' },
    { who: 'dan', minutes: 15, day: '2026-08-28' }
  ];

  it('count needs no column', () => {
    const s = Stats.build(signins, { tiles: [{ label: 'Sign-ins', agg: 'count' }] });
    assert.equal(s.tiles[0].value, 4);
    assert.equal(s.tiles[0].label, 'Sign-ins');
  });

  it('sum / min / max / avg over a column', () => {
    const s = Stats.build(signins, { tiles: [
      { label: 'Total', agg: 'sum', column: 'minutes' },
      { label: 'Shortest', agg: 'min', column: 'minutes' },
      { label: 'Longest', agg: 'max', column: 'minutes' },
      { label: 'Average', agg: 'avg', column: 'minutes' }
    ]});
    assert.deepEqual(s.tiles.map(t => t.value), [90, 15, 45, 30]);
  });

  it('blank cells are skipped, not read as zero', () => {
    // cara's blank minutes must not drag the average toward 0 — that reads as a real decline rather
    // than as a row that never filled the field in. 90/3 = 30, not 90/4 = 22.5.
    const s = Stats.build(signins, { tiles: [{ label: 'Average', agg: 'avg', column: 'minutes' }] });
    assert.equal(s.tiles[0].value, 30);
  });

  it('avg is rounded (and only avg)', () => {
    const rows = [{ n: 1 }, { n: 1 }, { n: 2 }];
    assert.equal(Stats.build(rows, { tiles: [{ agg: 'avg', column: 'n' }] }).tiles[0].value, 1.3);
    assert.equal(Stats.build(rows, { tiles: [{ agg: 'avg', column: 'n', decimals: 3 }] }).tiles[0].value, 1.333);
    // A sum keeps every digit the data had: rounding it to look tidy would corrupt a decimal quantity.
    assert.equal(Stats.build([{ n: 0.1 }, { n: 0.25 }], { tiles: [{ agg: 'sum', column: 'n' }] }).tiles[0].value, 0.35);
  });

  it('an empty bucket: sum is 0, avg/min/max are null', () => {
    const s = Stats.build([], { tiles: [
      { agg: 'sum', column: 'n' }, { agg: 'avg', column: 'n' }, { agg: 'max', column: 'n' }, { agg: 'count' }
    ]});
    assert.deepEqual(s.tiles.map(t => t.value), [0, null, null, 0]);
  });

  it('latest takes the last non-empty value in the given row order, without re-sorting', () => {
    // The view has already been through sortByCol by the time rows arrive; sorting again here would
    // silently disagree with what the same view shows as a list.
    const s = Stats.build(signins, { tiles: [{ agg: 'latest', column: 'day' }] });
    assert.equal(s.tiles[0].value, '2026-08-28');
  });

  it('`when` narrows one tile without touching the others', () => {
    const s = Stats.build(signins, { tiles: [
      { label: 'All', agg: 'count' },
      { label: 'Today', agg: 'count', when: { day: '2026-08-29' } }
    ]});
    assert.deepEqual(s.tiles.map(t => t.value), [4, 2]);
  });
});

describe('stats.js — goals and bars', () => {
  it('a numeric goal yields a clamped percentage', () => {
    const s = Stats.build([{}, {}, {}], { tiles: [{ agg: 'count', goal: 4 }] });
    assert.equal(s.tiles[0].pct, 75);
    assert.equal(s.tiles[0].over, false);
  });

  it('exceeding the goal clamps the bar but records `over`', () => {
    // The bar must not overflow its track, and the tile must not pretend the goal was met exactly —
    // pct caps at 100 and `over` carries the fact that the real number is higher.
    const s = Stats.build([{}, {}, {}, {}, {}], { tiles: [{ agg: 'count', goal: 4 }] });
    assert.equal(s.tiles[0].pct, 100);
    assert.equal(s.tiles[0].over, true);
    assert.equal(s.tiles[0].value, 5);
  });

  it('no goal means no bar', () => {
    const s = Stats.build([{}], { tiles: [{ agg: 'count' }] });
    assert.equal(s.tiles[0].goal, null);
    assert.equal(s.tiles[0].pct, null);
  });

  it('goal "max" scales every tile to the largest value', () => {
    const s = Stats.build([{ n: 5 }, { n: 10 }], { tiles: [
      { agg: 'min', column: 'n' }, { agg: 'max', column: 'n' }
    ], goal: 'max' });
    assert.deepEqual(s.tiles.map(t => t.pct), [50, 100]);
  });

  it('goal "max" over an all-zero set draws no bars rather than dividing by zero', () => {
    const s = Stats.build([{ n: 0 }, { n: 0 }], { perRow: { label: 'n', value: 'n' }, goal: 'max' });
    assert.deepEqual(s.tiles.map(t => t.pct), [null, null]);
    assert.deepEqual(s.tiles.map(t => t.goal), [null, null]);
  });

  it('a non-numeric value gets no bar even when a goal is set', () => {
    const s = Stats.build([{ d: '2026-08-29' }], { tiles: [{ agg: 'latest', column: 'd', goal: 10 }] });
    assert.equal(s.tiles[0].pct, null);
    assert.equal(s.tiles[0].value, '2026-08-29');
  });
});

describe('stats.js — perRow (an existing leaderboard as bars)', () => {
  // Exactly the shape chore_points_week already produces: one row per person, with a summed total.
  const leaderboard = [{ person: 'Ann', total: 12 }, { person: 'Bob', total: 8 }, { person: 'Cara', total: 3 }];

  it('one tile per row, labelled from a column', () => {
    const s = Stats.build(leaderboard, { perRow: { label: 'person', value: 'total' }, goal: 'max' });
    assert.equal(s.tiles.length, 3);
    assert.deepEqual(s.tiles.map(t => t.label), ['Ann', 'Bob', 'Cara']);
    assert.deepEqual(s.tiles.map(t => t.value), [12, 8, 3]);
    // The leader's bar is full and everyone else is drawn relative to them.
    assert.deepEqual(s.tiles.map(t => t.pct), [100, 67, 25]);
  });

  it('labelCol is carried through so the renderer can format the label like a cell', () => {
    const s = Stats.build(leaderboard, { perRow: { label: 'person', value: 'total' } });
    assert.equal(s.tiles[0].labelCol, 'person');
  });

  it('an absolute goal applies to every row', () => {
    const s = Stats.build(leaderboard, { perRow: { label: 'person', value: 'total' }, goal: 24 });
    assert.deepEqual(s.tiles.map(t => t.pct), [50, 33, 13]);
  });

  it('limit caps the tile count (a top-N board)', () => {
    const s = Stats.build(leaderboard, { perRow: { label: 'person', value: 'total' }, limit: 2 });
    assert.deepEqual(s.tiles.map(t => t.label), ['Ann', 'Bob']);
  });

  it('no rows means no tiles, not a crash', () => {
    assert.deepEqual(Stats.build([], { perRow: { label: 'person', value: 'total' } }).tiles, []);
  });
});

describe('stats.js — defensive', () => {
  it('no rows / no opts', () => {
    assert.deepEqual(Stats.build(null, null).tiles, []);
    assert.deepEqual(Stats.build([], {}).tiles, []);
  });

  it('an unknown agg yields null rather than throwing (validateSchema rejects it at load)', () => {
    const s = Stats.build([{ n: 1 }], { tiles: [{ agg: 'median', column: 'n' }] });
    assert.equal(s.tiles[0].value, null);
  });
});

describe('stats.js — tiered goals (bronze / silver / gold)', () => {
  const TIERS = [{ at: 100, label: 'Bronze' }, { at: 200, label: 'Silver' }, { at: 300, label: 'Gold' }];
  const at = (v, goal = TIERS) => Stats.build([{ n: v }], { tiles: [{ agg: 'sum', column: 'n', goal }] }).tiles[0];

  it('targets the next rung up, and re-targets once one is reached', () => {
    assert.equal(at(50).goal, 100);
    assert.equal(at(100).goal, 200);   // bronze reached -> aim at silver
    assert.equal(at(200).goal, 300);   // silver reached -> aim at gold
  });

  it('reports the highest rung actually reached', () => {
    assert.equal(at(50).tier, null);
    assert.deepEqual(at(100).tier, { at: 100, label: 'Bronze' });
    assert.deepEqual(at(250).tier, { at: 200, label: 'Silver' });
    assert.deepEqual(at(300).tier, { at: 300, label: 'Gold' });
  });

  it('the bar runs from zero to the next rung, not within the band', () => {
    // 250 is 83% of the way up a 300-point scheme. The other reading (halfway through the 200-300
    // band, 50%) is defensible and is deliberately not what this does.
    assert.equal(at(250).pct, 83);
    assert.equal(at(150).pct, 75);
  });

  it('past the top rung the goal stays there and `over` carries the overshoot', () => {
    assert.equal(at(300).pct, 100);
    assert.equal(at(300).over, false);
    assert.equal(at(350).goal, 300);
    assert.equal(at(350).pct, 100);
    assert.equal(at(350).over, true);
    assert.equal(at(350).value, 350);
  });

  it('bare numbers work as a ladder too — the rung is then its own name', () => {
    const t = at(150, [100, 200, 300]);
    assert.deepEqual(t.tier, { at: 100, label: null });
    assert.equal(t.goal, 200);
  });

  it('an out-of-order ladder is sorted rather than picking a nonsense rung', () => {
    // validateSchema rejects this at load; the engine still has to be total.
    assert.equal(at(150, [300, 100, 200]).goal, 200);
  });

  it('a non-numeric value sits below every rung', () => {
    const t = Stats.build([{ d: '2026-08-29' }], { tiles: [{ agg: 'latest', column: 'd', goal: TIERS }] }).tiles[0];
    assert.equal(t.tier, null);
    assert.equal(t.pct, null);
  });

  it('per-row: each row is measured against the rung IT is working toward', () => {
    // The difference from goal:"max" -- these bars answer "how close am I to the next level", not
    // "how do I compare to the leader", so two rows can have different scales.
    const s = Stats.build([{ who: 'Ann', total: 250 }, { who: 'Bob', total: 40 }],
      { perRow: { label: 'who', value: 'total' }, goal: TIERS });
    assert.deepEqual(s.tiles.map(t => t.goal), [300, 100]);
    assert.deepEqual(s.tiles.map(t => t.tier && t.tier.label), ['Silver', null]);
  });

  it('an empty ladder yields no bar rather than throwing', () => {
    assert.equal(at(50, []).goal, null);
    assert.equal(at(50, []).pct, null);
  });
});
