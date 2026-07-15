const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Rows = require('../../rows');

// rows.js resolves the named-list cache and the column->list resolver through the global scope at call
// time (browser: window._listsCache / window.getColumnList). Node tests set them on globalThis.
beforeEach(() => { delete globalThis._listsCache; delete globalThis.getColumnList; });

describe('rows.js — condMatches (the unified filter/when matcher)', () => {
  it('scalar equality, $or / $and groups, ne / empty / notEmpty operators', () => {
    assert.equal(Rows.condMatches({ s: 'open' }, { s: 'open' }), true);
    assert.equal(Rows.condMatches({ s: 'done' }, { s: 'open' }), false);
    assert.equal(Rows.condMatches({ s: 'b' }, { $or: [{ s: 'a' }, { s: 'b' }] }), true);
    assert.equal(Rows.condMatches({ s: 'a', t: 'y' }, { $and: [{ s: 'a' }, { t: 'x' }] }), false);
    assert.equal(Rows.condMatches({ s: 'a' }, { s: { ne: 'a' } }), false);
    assert.equal(Rows.condMatches({ s: '' }, { s: { empty: true } }), true);
    assert.equal(Rows.condMatches({ s: '' }, { s: { notEmpty: true } }), false);
    assert.equal(Rows.condMatches({ anything: 1 }, null), true); // absent cond => match
  });

  it('matchList / notMatchList read the live named-list cache (array values: ANY element)', () => {
    globalThis._listsCache = { crew: ['Ann', 'Bob'] };
    assert.equal(Rows.condMatches({ who: 'Ann' }, { who: { matchList: 'crew' } }), true);
    assert.equal(Rows.condMatches({ who: 'Zed' }, { who: { matchList: 'crew' } }), false);
    assert.equal(Rows.condMatches({ who: ['Zed', 'Bob'] }, { who: { matchList: 'crew' } }), true);
    assert.equal(Rows.condMatches({ who: 'Ann' }, { who: { notMatchList: 'crew' } }), false);
    delete globalThis._listsCache;
    assert.equal(Rows.condMatches({ who: 'Ann' }, { who: { matchList: 'crew' } }), false); // no cache -> fail closed
  });

  it('within: relative period tokens computed from now', () => {
    const today = require('../../calendar').fmtDate(new Date());
    assert.equal(Rows.condMatches({ d: today }, { d: { within: '@today' } }), true);
    assert.equal(Rows.condMatches({ d: '2000-01-01' }, { d: { within: '@month' } }), false);
    assert.equal(Rows.condMatches({ d: '' }, { d: { within: '@month' } }), false);   // no date -> no match
    assert.equal(Rows.condMatches({ d: today }, { d: { within: 'garbage' } }), false); // bad token -> no match
  });
});

describe('rows.js — filterToOr / convertViewFilters (legacy array-IN upgrade)', () => {
  it('rewrites {col:[a,b]} into $or of equalities; leaves flat objects alone', () => {
    assert.deepEqual(Rows.filterToOr({ s: ['a', 'b'] }), { $or: [{ s: 'a' }, { s: 'b' }] });
    assert.deepEqual(Rows.filterToOr({ s: 'a', t: 'b' }), { s: 'a', t: 'b' });
    assert.deepEqual(Rows.filterToOr({ s: ['a'], t: 'x' }), { $and: [{ $or: [{ s: 'a' }] }, { t: 'x' }] });
  });

  it('convertViewFilters canonicalizes the shorthand conditional column to {name, when}', () => {
    const views = [{ filter: { s: ['a', 'b'] }, columns: ['x', { hidden_col: { s: 'done' } }] }];
    Rows.convertViewFilters(views);
    assert.deepEqual(views[0].filter, { $or: [{ s: 'a' }, { s: 'b' }] });
    assert.deepEqual(views[0].columns[1], { name: 'hidden_col', when: { s: 'done' } });
  });
});

describe('rows.js — buildRows (union / join / filter)', () => {
  const cache = {
    tasks: [{ id: 't1', title: 'T', status: 'open' }],
    notes: [{ id: 'n1', title: 'N' }, { id: 't1', author: 'me' }]
  };

  it('union tags each row with _source', () => {
    const rows = Rows.buildRows({ sources: ['tasks', 'notes'] }, cache);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r._source), ['tasks', 'notes', 'notes']);
  });

  it('join merges same-id rows across sources', () => {
    const rows = Rows.buildRows({ sources: ['tasks', 'notes'], mode: 'join' }, cache);
    const joined = rows.find(r => r.id === 't1');
    assert.equal(rows.length, 2);              // t1 merged, n1 separate
    assert.equal(joined.status, 'open');       // from tasks
    assert.equal(joined.author, 'me');         // merged in from notes
  });

  it('applies the view filter through condMatches', () => {
    const rows = Rows.buildRows({ sources: ['tasks', 'notes'], filter: { status: 'open' } }, cache);
    assert.deepEqual(rows.map(r => r.id), ['t1']);
  });
});

describe('rows.js — aggregateRows (the real logic, no more simulated copies)', () => {
  it('count aggregate: one row per key, ranked highest-first', () => {
    const view = { aggregate: { count: true }, groupBy: { column: 'who', from: ['who'] } };
    const rows = Rows.aggregateRows(view, [{ who: 'Ann' }, { who: 'Ann' }, { who: 'Bob' }]);
    assert.deepEqual(rows.map(r => ({ who: r.who, total: r.total })), [
      { who: 'Ann', total: 2 }, { who: 'Bob', total: 1 }
    ]);
  });

  it('sum aggregate with custom `into` + groupBy.filter gating keys via condMatches', () => {
    globalThis._listsCache = { crew: ['Ann'] };
    const view = { aggregate: { sum: 'pts', into: 'score' }, groupBy: { column: 'who', from: ['who'], filter: { who: { matchList: 'crew' } } } };
    const rows = Rows.aggregateRows(view, [{ who: 'Ann', pts: '3' }, { who: 'Ann', pts: '2' }, { who: 'Zed', pts: '9' }]);
    assert.deepEqual(rows.map(r => ({ who: r.who, score: r.score })), [{ who: 'Ann', score: 5 }]); // Zed filtered out
  });

  it('groupBy+collect: latest-first values spread across the view columns', () => {
    const view = { groupBy: { column: 'person', from: ['person'] }, collect: 'date', columns: ['person', 'latest', 'previous'] };
    const rows = Rows.aggregateRows(view, [
      { person: 'Ann', date: '2026-01-01' }, { person: 'Ann', date: '2026-03-01' }, { person: 'Bob', date: '2026-02-01' }
    ]);
    const ann = rows.find(r => r.person === 'Ann');
    assert.equal(ann.latest, '2026-03-01');    // sorted descending
    assert.equal(ann.previous, '2026-01-01');
  });

  it('collectWith annotates each value with the source column (role)', () => {
    const view = { groupBy: { column: 'person', from: ['lead', 'helper'] }, collect: 'date', collectWith: 'role', columns: ['person', 'latest'] };
    const rows = Rows.aggregateRows(view, [{ lead: 'Ann', helper: 'Bob', date: '2026-01-05' }]);
    assert.equal(rows.find(r => r.person === 'Ann').latest, '2026-01-05 (lead)');
    assert.equal(rows.find(r => r.person === 'Bob').latest, '2026-01-05 (helper)');
  });
});

describe('rows.js — sortByCol', () => {
  it('locale sort with blanks last (no list backing)', () => {
    const rows = [{ n: 'b' }, { n: '' }, { n: 'a' }];
    assert.deepEqual(Rows.sortByCol(rows, 'n').map(r => r.n), ['a', 'b', '']);
  });

  it('list-backed column follows the authored list order (via getColumnList + _listsCache)', () => {
    globalThis.getColumnList = (t, col) => (col === 'status' ? 'statuses' : null);
    globalThis._listsCache = { statuses: ['open', 'in_progress', 'done'] };
    const rows = [{ status: 'done' }, { status: 'open' }, { status: 'in_progress' }];
    assert.deepEqual(Rows.sortByCol(rows, 'status').map(r => r.status), ['open', 'in_progress', 'done']);
  });
});

describe('rows.js — resolveComputed', () => {
  it('rotation calendar column resolves through the real rotation.js resolver', () => {
    const cache = { crew: [{ id: 'c1', position: 1, people: ['A'] }, { id: 'c2', position: 2, people: ['B'] }] };
    const cols = [{ name: 'duty', computed: { rotationTable: 'crew', advanceBy: 'calendar', interval: 'weekly', dateField: 'date' } }];
    const rows = [{ id: 'r1', date: '2026-01-08' }]; // 1 week after anchor -> position 1 -> B
    Rows.resolveComputed(rows, cols, { dataCache: cache, rotationAnchor: '2026-01-01' });
    assert.deepEqual(rows[0].duty, ['B']);
  });

  it('lookup denormalizes one field from a keyed table (with default)', () => {
    const cache = { chores: [{ name: 'dishes', points: 3 }] };
    const cols = [{ name: 'pts', computed: { lookup: { table: 'chores', match: 'chore', on: 'name', field: 'points', default: 0 } } }];
    const rows = [{ chore: 'dishes' }, { chore: 'unknown' }];
    Rows.resolveComputed(rows, cols, { dataCache: cache });
    assert.equal(rows[0].pts, 3);
    assert.equal(rows[1].pts, 0);
  });

  it('matchList string collects list members; object form categorizes by list', () => {
    globalThis._listsCache = { adults: ['Ann', 'Bob'], kids: ['Cara'] };
    const cols = [
      { name: 'grown', computed: { matchList: 'adults', fromColumns: ['a', 'b'] } },
      { name: 'kind', computed: { matchList: { adults: 'adult', kids: 'kid' }, fromColumn: 'a' } }
    ];
    const rows = [{ a: 'Cara', b: ['Ann', 'Zed'] }];
    Rows.resolveComputed(rows, cols, {});
    assert.equal(rows[0].grown, 'Ann');   // Cara/Zed not in adults; Ann collected from the array value
    assert.equal(rows[0].kind, 'kid');    // Cara categorized via the kids list
  });
});

describe('rows.js — isFilterToken', () => {
  it('@me is a token, not a literal list value', () => {
    assert.equal(Rows.isFilterToken('@me'), true);
  });
  it('ordinary values (including other @-strings) are literal', () => {
    // Deliberately narrow: only tokens the resolver actually rewrites. A list value that merely
    // starts with '@' (a handle, say) is real data and must still seed/lock.
    for (const v of ['Ann', '', 'me', '@meeting', '@ann', '@Me', 'open']) {
      assert.equal(Rows.isFilterToken(v), false, JSON.stringify(v) + ' should be literal');
    }
  });
});

describe('rows.js — compareValues (the one comparator: grid, embeds, rsvp, pivot)', () => {
  const sort = (vals, asc, lo) => vals.slice().sort((a, b) => Rows.compareValues(a, b, asc, lo));

  it('numbers compare numerically, both directions', () => {
    assert.deepEqual(sort([11, 4, 5], true), [4, 5, 11]);
    assert.deepEqual(sort([11, 4, 5], false), [11, 5, 4]);
  });
  it('string-stored numbers order numerically too, so both storage shapes agree', () => {
    assert.deepEqual(sort(['10', '2', '9'], true), ['2', '9', '10']);   // not lexicographic
    assert.deepEqual(sort(['10', '2', '9'], false), ['10', '9', '2']);
  });
  it('blanks sort last in BOTH directions', () => {
    assert.deepEqual(sort(['b', '', 'a'], true), ['a', 'b', '']);
    assert.deepEqual(sort(['b', '', 'a'], false), ['b', 'a', '']);
    assert.deepEqual(sort([2, null, 1], false), [2, 1, null]);
  });
  it('a non-string never throws (it is coerced, not .localeCompare-d)', () => {
    assert.doesNotThrow(() => sort([1, 'a', true, 2], true));
  });
  it('listOrder follows the list\'s authored order, and reverses', () => {
    const lo = { open: 0, in_progress: 1, done: 2 };
    assert.deepEqual(sort(['done', 'open', 'in_progress'], true, lo), ['open', 'in_progress', 'done']);
    assert.deepEqual(sort(['done', 'open', 'in_progress'], false, lo), ['done', 'in_progress', 'open']);
  });
});

describe('rows.js — sortByCol direction', () => {
  it('defaults to ascending (embed defaultSort passes no direction) and honours asc=false', () => {
    const rows = [{ n: 'b' }, { n: 'a' }, { n: 'c' }];
    assert.deepEqual(Rows.sortByCol(rows, 'n').map(r => r.n), ['a', 'b', 'c']);
    assert.deepEqual(Rows.sortByCol(rows, 'n', null, true).map(r => r.n), ['a', 'b', 'c']);
    assert.deepEqual(Rows.sortByCol(rows, 'n', null, false).map(r => r.n), ['c', 'b', 'a']);
  });
});
