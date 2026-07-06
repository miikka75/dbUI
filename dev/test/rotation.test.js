const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../rotation');

describe('rotation.js — interval math', () => {
  it('wholeIntervalsBetween: day/week/month + partial + multi-count', () => {
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-01-15', 'weekly'), 2);  // 14d -> 2
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-01-05', 'weekly'), 0);  // 4d -> 0
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-03-01', 'monthly'), 2);
    assert.equal(R.wholeIntervalsBetween('2026-01-15', '2026-02-10', 'monthly'), 0); // day 10 < 15
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-01-04', '1d'), 3);
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-01-22', '3w'), 1);      // 21d = 3w / 3
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2027-01-01', '1y'), 1);      // 12m / 12
    assert.equal(R.wholeIntervalsBetween('2026-01-01', '2026-07-01', '3m'), 2);      // 6m / 3
  });

  it('addIntervals is the inverse (returns YYYY-MM-DD)', () => {
    assert.equal(R.addIntervals('2026-01-01', 2, '1d'), '2026-01-03');
    assert.equal(R.addIntervals('2026-01-01', 2, '3w'), '2026-02-12'); // +6w = +42d
    assert.equal(R.addIntervals('2026-01-01', 1, '1y'), '2027-01-01');
  });

  it('parseInterval + isValidInterval accept aliases and <n><unit>, reject junk', () => {
    assert.deepEqual(R.parseInterval('yearly'), { count: 12, unit: 'm' }); // 1y -> 12m
    assert.deepEqual(R.parseInterval('3w'), { count: 3, unit: 'w' });
    assert.equal(R.isValidInterval('1d'), true);
    assert.equal(R.isValidInterval('daily'), true);
    assert.equal(R.isValidInterval('1h'), false);
    assert.equal(R.isValidInterval('weeklyy'), false);
    assert.equal(R.isValidInterval(null), false);
  });
});

describe('rotation.js — position resolvers', () => {
  const rot = [
    { id: 'c1', position: 1, people: ['A'] },
    { id: 'c2', position: 2, people: ['B', 'C'] },
    { id: 'c3', position: 3, people: ['D'] }
  ];
  const src = [{ id: 'k1', date: '2026-01-01' }, { id: 'k2', date: '2026-02-01' }, { id: 'k3', date: '2026-03-01' }];

  it('resolveByOccurrence: source index -> roster cell, looping via modulo', () => {
    assert.deepEqual(R.resolveByOccurrence(rot, src, src[0], 'date'), ['A']);
    assert.deepEqual(R.resolveByOccurrence(rot, src, src[1], 'date'), ['B', 'C']);
    assert.deepEqual(R.resolveByOccurrence([rot[0], rot[1]], src, src[2], 'date'), ['A']); // 2 % 2 = 0
  });

  it('resolveByCalendar: elapsed intervals index, negative-safe looping', () => {
    assert.deepEqual(R.resolveByCalendar(rot, '2026-01-15', '2026-01-01', 'weekly'), ['D']); // elapsed 2
    assert.deepEqual(R.resolveByCalendar(rot, '2026-01-22', '2026-01-01', 'weekly'), ['A']); // 3 % 3 = 0
    assert.deepEqual(R.resolveByCalendar(rot, '2025-12-25', '2026-01-01', 'weekly'), ['D']); // -1 -> safe
    assert.deepEqual(R.resolveByCalendar([], '2026-01-15', '2026-01-01', 'weekly'), []);
  });

  it('resolveByCalendar honors position ordering (unpositioned rows float to the end)', () => {
    const partial = [{ id: 'x', people: ['X'] }, { id: 'p1', position: 1, people: ['P1'] }];
    assert.deepEqual(R.resolveByCalendar(partial, '2026-01-01', '2026-01-01', 'weekly'), ['P1']); // pos 1 first
  });

  it('resolveAnchorDate: literal column wins, else global, else null', () => {
    assert.equal(R.resolveAnchorDate({ anchorDate: '2026-02-02' }, '2026-01-01'), '2026-02-02');
    assert.equal(R.resolveAnchorDate({}, '2026-01-01'), '2026-01-01');
    assert.equal(R.resolveAnchorDate({}, ''), null);
  });
});

describe('rotation.js — buildRotationViewRows', () => {
  it('slots+rosters with rotateEvery:1 swaps the assignment every period', () => {
    const view = { rotation: { slots: ['area_a', 'area_b'], rosters: ['RL_a', 'RL_b'], interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
    const dc = { RL_a: [{ position: 1, people: ['A0'] }], RL_b: [{ position: 1, people: ['B0'] }] };
    const rows = R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01');
    assert.equal(rows.length, 2);
    assert.deepEqual({ p: rows[0]._period, a: rows[0].area_a, b: rows[0].area_b }, { p: '2026-01-01', a: ['A0'], b: ['B0'] });
    assert.deepEqual({ p: rows[1]._period, a: rows[1].area_a, b: rows[1].area_b }, { p: '2026-01-08', a: ['B0'], b: ['A0'] });
  });

  it('numeric rotateEvery is anchor-invariant: shifting `from` does not change a date assignment', () => {
    const view = (from) => ({ rotation: { slots: ['a', 'b'], rosters: ['La', 'Lb'], interval: 'weekly', rotateEvery: 1, range: { from: from, periods: 4 } } });
    const dc = { La: [{ position: 1, people: ['A'] }], Lb: [{ position: 1, people: ['B'] }] };
    const at = (from, date) => {
      const rows = R.buildRotationViewRows(view(from), dc, '2026-07-06', '2026-01-01');
      const row = rows.find(r => r._period === date);
      return { a: row.a, b: row.b };
    };
    // The 2026-01-15 assignment is identical whether the window starts on 01-01 or 01-08.
    assert.deepEqual(at('2026-01-01', '2026-01-15'), at('2026-01-08', '2026-01-15'));
  });

  it('columns form: each column fixed to its own rotationTable', () => {
    const view = { rotation: { columns: [{ name: 'duty', rotationTable: 'crew', interval: 'weekly' }], range: { from: '2026-01-01', periods: 2 } } };
    const dc = { crew: [{ position: 1, people: ['A'] }, { position: 2, people: ['B'] }] };
    const rows = R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01');
    assert.deepEqual(rows.map(r => ({ p: r._period, duty: r.duty })), [
      { p: '2026-01-01', duty: ['A'] },
      { p: '2026-01-08', duty: ['B'] }
    ]);
  });

  it('rotateEveryOverride (folder config) replaces the schema value', () => {
    const view = { rotation: { slots: ['a', 'b'], rosters: ['La', 'Lb'], interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
    const dc = { La: [{ position: 1, people: ['A'] }], Lb: [{ position: 1, people: ['B'] }] };
    // override [] -> no swap: period 1 keeps a<-La, b<-Lb (unlike the schema rotateEvery:1 swap).
    const rows = R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01', undefined, []);
    assert.deepEqual({ a: rows[1].a, b: rows[1].b }, { a: ['A'], b: ['B'] });
  });
});
