// search.test.js — the runtime search primitive.
//
// The schema's `filter` is authored: it decides what a view IS. This is the other kind — what the
// person looking at it wants to see right now — and the app had no way to express it at all. It is
// deliberately a substring match over the row's text rather than the condition language: somebody
// typing into a box is not writing a filter, and `condMatches` cannot express "appears anywhere".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Rows = require('../../rows');

const ROWS = [
  { id: '1', nimi: 'Kati Tuppurainen', teema: 'Usko', vastuussa: 'piispa' },
  { id: '2', nimi: 'Säestäjä Testi', teema: 'Toivo', vastuussa: '1na' },
  { id: '3', nimi: 'Bob', tags: ['Hämeen', 'muu'] },
  { id: '4', nimi: '', teema: 'Rakkaus' }
];
const ids = (rows) => rows.map((r) => r.id);

describe('rows — searchRows', () => {
  it('matches a plain substring, case-insensitively', () => {
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'usko')), ['1']);
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'USKO')), ['1']);
  });

  it('every token must appear SOMEWHERE in the row, not all in one column', () => {
    // "kati tup" is how people type a name they half remember. A single substring over the whole term
    // would find nothing here, because no one column contains it.
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'kati tup')), ['1']);
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'kati usko')), ['1']);   // across two columns
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'kati toivo')), []);     // both must match
  });

  it('folds diacritics, in both directions', () => {
    // The data is Finnish. Without folding, a name is findable only by someone who can type the
    // diacritic — which on a phone keyboard is most of the point of searching.
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'saestaja')), ['2']);
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'säestäjä')), ['2']);
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'hameen')), ['3']);
  });

  it('searches inside multi-value columns', () => {
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'muu')), ['3']);
  });

  it('an empty or blank term is not a filter', () => {
    // It must return everything, not nothing: a cleared box has to give the list back.
    for (const t of ['', '   ', null, undefined]) {
      assert.equal(Rows.searchRows(ROWS, t).length, ROWS.length, JSON.stringify(t));
    }
  });

  it('restricted to named columns when the schema names them', () => {
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'usko', ['teema'])), ['1']);
    assert.deepEqual(ids(Rows.searchRows(ROWS, 'kati', ['teema'])), [], 'searched a column it was not given');
  });

  it('skips bookkeeping columns when searching everything', () => {
    // Otherwise a term matches ids and timestamps, which is never what somebody typing means — and
    // `owner` would surface e-mail addresses in a view that deliberately shows display names.
    const rows = [{ id: 'abc123', owner: 'kati@x.com', created_at: '2026-08-01', nimi: 'Bob' }];
    assert.deepEqual(Rows.searchRows(rows, 'abc123'), []);
    assert.deepEqual(Rows.searchRows(rows, 'kati@x.com'), []);
    assert.deepEqual(Rows.searchRows(rows, '2026-08'), []);
    assert.deepEqual(ids(Rows.searchRows(rows, 'bob')), ['abc123'], 'and still finds the real content');
  });

  it('...but searches a bookkeeping-named column when the schema asks for it explicitly', () => {
    // The skip list is a default for "search everything", not a prohibition. An admin view that names
    // `owner` means it.
    const rows = [{ id: 'a', owner: 'kati@x.com' }];
    assert.deepEqual(ids(Rows.searchRows(rows, 'kati', ['owner'])), ['a']);
  });

  it('survives rows that are not objects, and an empty set', () => {
    assert.deepEqual(Rows.searchRows([null, 0, 'x', { nimi: 'Bob' }], 'bob').length, 1);
    assert.deepEqual(Rows.searchRows([], 'bob'), []);
    assert.deepEqual(Rows.searchRows(null, 'bob'), []);
  });

  it('never mutates or reorders what it is given', () => {
    const before = ROWS.map((r) => r.id);
    const out = Rows.searchRows(ROWS, 'o');
    assert.deepEqual(ROWS.map((r) => r.id), before);
    assert.deepEqual(ids(out), ids(out).slice().sort((a, b) => a.localeCompare(b)), 'input order is preserved');
  });
});

describe('rows — searchColumns reads the schema setting', () => {
  it('absent or false means no search box at all', () => {
    // null, not [] — the difference between "search everything" and "do not offer search" is exactly
    // what decides whether the box renders.
    assert.equal(Rows.searchColumns({}), null);
    assert.equal(Rows.searchColumns({ search: false }), null);
    assert.equal(Rows.searchColumns(null), null);
  });

  it('true means every column the row carries', () => {
    assert.deepEqual(Rows.searchColumns({ search: true }), []);
  });

  it('an array names the columns', () => {
    assert.deepEqual(Rows.searchColumns({ search: ['nimi', 'teema'] }), ['nimi', 'teema']);
  });

  it('drops malformed entries rather than searching a column called "null"', () => {
    assert.deepEqual(Rows.searchColumns({ search: ['nimi', '', null, 3] }), ['nimi']);
  });

  it('an empty array behaves as `true`, which is the harmless reading', () => {
    // `"search": []` is most likely a half-finished edit. Offering the box over everything is better
    // than offering one that can never match.
    assert.deepEqual(Rows.searchColumns({ search: [] }), []);
  });
});
