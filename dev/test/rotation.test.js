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

  // A roster that holds TASKS rather than people names its column something else; `valueCol` points
  // the resolvers at it. Without this the column had to be called `people` whatever it contained.
  it('valueCol reads a non-`people` roster column, and a missing one yields [] not undefined', () => {
    const tasks = [
      { id: 'w1', position: 1, tasks: ['dishes', 'trash'] },
      { id: 'w2', position: 2, tasks: ['vacuum'] }
    ];
    assert.deepEqual(R.resolveByCalendar(tasks, '2026-01-01', '2026-01-01', 'weekly', 'tasks'), ['dishes', 'trash']);
    assert.deepEqual(R.resolveByCalendar(tasks, '2026-01-08', '2026-01-01', 'weekly', 'tasks'), ['vacuum']);
    assert.deepEqual(R.resolveByOccurrence(tasks, src, src[1], 'date', 'tasks'), ['vacuum']);
    assert.deepEqual(R.resolveByCalendar(tasks, '2026-01-01', '2026-01-01', 'weekly', 'nope'), []);
    assert.deepEqual(R.resolveByCalendar(tasks, '2026-01-01', '2026-01-01', 'weekly'), []); // default `people` absent
    assert.deepEqual(R.resolveByCalendar(rot, '2026-01-22', '2026-01-01', 'weekly'), ['A']); // default unchanged
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

  // The person-x-task matrix: slots ARE the people, rosters hold each person's task sets, and
  // rotateEvery hands one person's set to the next. A 1-row roster never advances -> fixed chores.
  it('slots-as-people + valueCol: each person gets their own task list per period', () => {
    const view = { rotation: {
      slots: ['anna', 'bob'], rosters: ['tasks_anna', 'tasks_bob'],
      interval: 'weekly', valueCol: 'tasks', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 }
    } };
    const dc = {
      tasks_anna: [{ position: 1, tasks: ['dishes', 'trash'] }, { position: 2, tasks: ['vacuum'] }],
      tasks_bob: [{ position: 1, tasks: ['laundry'] }]   // single row -> same task every week
    };
    const rows = R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01');
    // Week 1: anna <- tasks_anna row 1, bob <- tasks_bob.
    assert.deepEqual({ anna: rows[0].anna, bob: rows[0].bob }, { anna: ['dishes', 'trash'], bob: ['laundry'] });
    // Week 2: the rosters swap slots, AND tasks_anna has advanced to its second row.
    assert.deepEqual({ anna: rows[1].anna, bob: rows[1].bob }, { anna: ['laundry'], bob: ['vacuum'] });
  });

  it('columns form takes valueCol per column', () => {
    const view = { rotation: { columns: [{ name: 'duty', rotationTable: 'crew', interval: 'weekly', valueCol: 'tasks' }], range: { from: '2026-01-01', periods: 1 } } };
    const dc = { crew: [{ position: 1, tasks: ['mop'], people: ['ignored'] }] };
    assert.deepEqual(R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01')[0].duty, ['mop']);
  });

  it('rotateEveryOverride (folder config) replaces the schema value', () => {
    const view = { rotation: { slots: ['a', 'b'], rosters: ['La', 'Lb'], interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
    const dc = { La: [{ position: 1, people: ['A'] }], Lb: [{ position: 1, people: ['B'] }] };
    // override [] -> no swap: period 1 keeps a<-La, b<-Lb (unlike the schema rotateEvery:1 swap).
    const rows = R.buildRotationViewRows(view, dc, '2026-07-06', '2026-01-01', undefined, []);
    assert.deepEqual({ a: rows[1].a, b: rows[1].b }, { a: ['A'], b: ['B'] });
  });
});

describe('rotation — rosters from one 2-D lookup (rosterRef)', () => {
  // parent = person (the slot), child = the duty. Deliberately interleaved and out of position order
  // in the array, because dataCache holds whatever the backend returned.
  const DUTIES = [
    { id: 'd3', position: 3, person: 'Bob', task: 'Bins' },
    { id: 'd1', position: 1, person: 'Ann', task: 'Wash up' },
    { id: 'd5', position: 5, person: 'Cara', task: 'Plants' },
    { id: 'd2', position: 2, person: 'Ann', task: 'Hoover' },
    { id: 'd4', position: 4, person: 'Cara', task: 'Dusting' }
  ];
  const cache = { ref_duties: DUTIES };
  const rv = { rosterRef: 'ref_duties', rosterBy: 'person' };

  it('slots are the distinct parent values, in position order', () => {
    // Position order, not array order — it is what the Lookup editor renders and reorders, and the
    // rotation assigns slot k <- group (k+s)%N, so a different order silently reassigns everyone.
    const g = R.rosterGroups(rv, cache);
    assert.deepEqual(g.slots, ['Ann', 'Bob', 'Cara']);
    assert.deepEqual(g.groups.map((rows) => rows.map((r) => r.task)),
      [['Wash up', 'Hoover'], ['Bins'], ['Dusting', 'Plants']]);
  });

  it('a row with no slot value belongs to no group', () => {
    const g = R.rosterGroups(rv, { ref_duties: DUTIES.concat([{ id: 'x', position: 9, person: '', task: 'orphan' }]) });
    assert.deepEqual(g.slots, ['Ann', 'Bob', 'Cara']);
    assert.equal(g.groups.reduce((n, rows) => n + rows.length, 0), DUTIES.length);
  });

  it('missing table / missing dataCache yields no slots rather than throwing', () => {
    assert.deepEqual(R.rosterGroups(rv, {}), { slots: [], groups: [] });
    assert.deepEqual(R.rosterGroups(rv, undefined), { slots: [], groups: [] });
  });

  it('the slots+rosters form still resolves through the same helper', () => {
    const g = R.rosterGroups({ slots: ['a', 'b'], rosters: ['t1', 't2'] }, { t1: [{ v: 1 }], t2: [] });
    assert.deepEqual(g.slots, ['a', 'b']);
    assert.deepEqual(g.groups, [[{ v: 1 }], []]);
  });

  it('produces exactly the rotation the equivalent slots+rosters config does', () => {
    // The whole point of the change is that it is a RESOLVER swap: same duties, same anchor, same
    // interval must mean the same matrix, or migrating a schema silently reshuffles the household.
    const opts = { valueCol: 'task', interval: 'weekly', rotateEvery: 1, range: { from: '2026-08-24', periods: 6 } };
    const viaRef = R.buildRotationViewRows({ rotation: Object.assign({}, rv, opts) }, cache, '2026-08-24', '2026-08-03');
    const split = {
      t_ann: DUTIES.filter((r) => r.person === 'Ann'),
      t_bob: DUTIES.filter((r) => r.person === 'Bob'),
      t_cara: DUTIES.filter((r) => r.person === 'Cara')
    };
    const viaTables = R.buildRotationViewRows(
      { rotation: Object.assign({ slots: ['Ann', 'Bob', 'Cara'], rosters: ['t_ann', 't_bob', 't_cara'] }, opts) },
      split, '2026-08-24', '2026-08-03');
    assert.deepEqual(viaRef, viaTables);
  });

  it('adding a person adds a slot — no schema change involved', () => {
    // The reason the shape exists: a fifth group appears from a row, and the rotation widens to it.
    const withEve = { ref_duties: DUTIES.concat([{ id: 'd6', position: 6, person: 'Eve', task: 'Recycling' }]) };
    assert.deepEqual(R.rosterGroups(rv, withEve).slots, ['Ann', 'Bob', 'Cara', 'Eve']);
  });
});
