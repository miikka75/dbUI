// timeline.test.js — the timeline/gantt engine: rows with a start and an end, as bars over periods.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Timeline = require('../../timeline');

// A four-week window starting on a Sunday, so week boundaries are easy to read in the assertions.
const WIN = { from: '2026-03-01', periods: 4, interval: 'weekly', start: 'from', end: 'to' };
const build = (rows, over) => Timeline.build(rows, Object.assign({}, WIN, over || {}));

describe('timeline.js — the period axis', () => {
  it('builds `periods` period starts from `from`', () => {
    assert.deepEqual(build([]).periods, ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22']);
  });

  it('honours the interval vocabulary rotation.js already defines', () => {
    assert.deepEqual(build([], { interval: 'daily', periods: 3 }).periods, ['2026-03-01', '2026-03-02', '2026-03-03']);
    assert.deepEqual(build([], { interval: 'monthly', periods: 3 }).periods, ['2026-03-01', '2026-04-01', '2026-05-01']);
    assert.deepEqual(build([], { interval: '2w', periods: 2 }).periods, ['2026-03-01', '2026-03-15']);
  });

  it('returns nothing usable without a `from` or a `start` column', () => {
    assert.deepEqual(Timeline.build([{ from: '2026-03-02' }], { periods: 4, start: 'from' }), { periods: [], bars: [] });
    assert.deepEqual(Timeline.build([{ from: '2026-03-02' }], { periods: 4, from: '2026-03-01' }), { periods: [], bars: [] });
  });
});

describe('timeline.js — placing a bar', () => {
  it('offset is the period it starts in; span counts periods covered', () => {
    const t = build([{ id: 'a', from: '2026-03-09', to: '2026-03-17' }]);
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0].offset, 1);        // the 03-08 week
    assert.equal(t.bars[0].span, 2);          // into the 03-15 week
    assert.equal(t.bars[0].clippedStart, false);
    assert.equal(t.bars[0].clippedEnd, false);
  });

  it('a range inside ONE period is a one-period bar, not a zero-width one', () => {
    const t = build([{ id: 'a', from: '2026-03-09', to: '2026-03-11' }]);
    assert.equal(t.bars[0].span, 1);
  });

  it('a row with no end is one period — a start alone is a point, not an open range', () => {
    const t = build([{ id: 'a', from: '2026-03-09' }]);
    assert.equal(t.bars[0].span, 1);
    assert.equal(t.bars[0].end, '2026-03-09');
  });

  it('works with no `end` column configured at all (a single-date table)', () => {
    const t = build([{ id: 'a', from: '2026-03-09' }], { end: undefined });
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0].span, 1);
  });

  it('a bar ending inside the LAST period still reaches it', () => {
    // The regression this guards: bounding the window by the last period's START clips a bar that ends
    // later that same period down to nothing.
    const t = build([{ id: 'a', from: '2026-03-23', to: '2026-03-27' }]);
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0].offset, 3);
    assert.equal(t.bars[0].span, 1);
    assert.equal(t.bars[0].clippedEnd, false);
  });
});

describe('timeline.js — the window edges', () => {
  it('clips a bar that starts before the window, and says so', () => {
    const t = build([{ id: 'a', from: '2026-01-15', to: '2026-03-10' }]);
    assert.equal(t.bars[0].offset, 0);
    assert.equal(t.bars[0].clippedStart, true);
    assert.equal(t.bars[0].start, '2026-01-15', 'the real start is still reported');
  });

  it('clips a bar that runs past the window, and says so', () => {
    const t = build([{ id: 'a', from: '2026-03-20', to: '2026-09-01' }]);
    assert.equal(t.bars[0].offset + t.bars[0].span, 4, 'it reaches the last period and stops');
    assert.equal(t.bars[0].clippedEnd, true);
    assert.equal(t.bars[0].end, '2026-09-01');
  });

  it('a bar spanning the whole window is clipped at BOTH ends', () => {
    const t = build([{ id: 'a', from: '2025-01-01', to: '2027-01-01' }]);
    assert.deepEqual([t.bars[0].offset, t.bars[0].span], [0, 4]);
    assert.equal(t.bars[0].clippedStart, true);
    assert.equal(t.bars[0].clippedEnd, true);
  });

  it('DROPS a row that does not intersect the window at all', () => {
    // Both sides, and adjacent-but-outside rather than far away -- an off-by-one here would draw a
    // zero-width bar at the edge, which reads as "this is happening now" and is the misreading a chart
    // exists to prevent.
    const t = build([
      { id: 'before', from: '2026-02-01', to: '2026-02-28' },
      { id: 'after', from: '2026-03-29', to: '2026-04-10' },
      { id: 'inside', from: '2026-03-02', to: '2026-03-03' }
    ]);
    assert.deepEqual(t.bars.map((b) => b.row.id), ['inside']);
  });

  it('keeps a row that ends exactly on the window start', () => {
    const t = build([{ id: 'a', from: '2026-02-01', to: '2026-03-01' }]);
    assert.equal(t.bars.length, 1);
    assert.equal(t.bars[0].span, 1);
  });
});

describe('timeline.js — bad and missing data', () => {
  it('drops a row with no start', () => {
    assert.deepEqual(build([{ id: 'a', to: '2026-03-10' }, { id: 'b', from: '', to: '2026-03-10' }]).bars, []);
  });

  it('collapses an end BEFORE its start rather than drawing a negative span', () => {
    const t = build([{ id: 'a', from: '2026-03-10', to: '2026-03-01' }]);
    assert.equal(t.bars.length, 1);
    assert.ok(t.bars[0].span >= 1, 'span is never negative or zero');
  });

  it('accepts a full timestamp in either column', () => {
    const t = build([{ id: 'a', from: '2026-03-09T08:30:00', to: '2026-03-17T17:00:00' }]);
    assert.deepEqual([t.bars[0].offset, t.bars[0].span], [1, 2]);
  });

  it('ignores an unparseable date instead of placing the row at the epoch', () => {
    assert.equal(Timeline.dateOf('not a date'), '');
    assert.deepEqual(build([{ id: 'a', from: 'not a date', to: '2026-03-10' }]).bars, []);
  });

  it('an empty row list yields an axis and no bars', () => {
    const t = build([]);
    assert.equal(t.periods.length, 4);
    assert.deepEqual(t.bars, []);
  });
});

describe('timeline.js — ordering', () => {
  it('earliest first, then longest, then input order', () => {
    const t = build([
      { id: 'late', from: '2026-03-20', to: '2026-03-21' },
      { id: 'early-short', from: '2026-03-02', to: '2026-03-03' },
      { id: 'early-long', from: '2026-03-02', to: '2026-03-20' }
    ]);
    assert.deepEqual(t.bars.map((b) => b.row.id), ['early-long', 'early-short', 'late']);
  });

  it('equal offset and span keep the order they arrived in (the view\'s own sort decides)', () => {
    const t = build([
      { id: 'first', from: '2026-03-02', to: '2026-03-03' },
      { id: 'second', from: '2026-03-03', to: '2026-03-04' }
    ]);
    assert.deepEqual(t.bars.map((b) => b.row.id), ['first', 'second']);
  });
});
