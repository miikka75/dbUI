const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The rotation helpers now live in the requireable /rotation.js module (extracted from schema-loader.js),
// so this no longer needs to scrape the <script> block out of the HTML fragment via a vm sandbox.
const { sortRosterRows } = require('../../rotation');

const names = rows => sortRosterRows(rows).map(r => r.people[0]).join(',');

describe('sortRosterRows (position ordering, robust to partial data)', () => {
  it('all positioned -> numeric order (not string/localeCompare)', () => {
    assert.equal(names([
      { id: 'b', position: '2', people: ['B'] },
      { id: 'a', position: '1', people: ['A'] },
      { id: 'j', position: '10', people: ['J'] },
    ]), 'A,B,J'); // 10 after 2, numeric
  });

  it('PARTIAL positions: positioned rows first (by number), unpositioned keep insertion order AFTER', () => {
    // Partial-position bug: only the first rows had positions; the rest were "".
    assert.equal(names([
      { id: '1', position: '1', people: ['Alice'] },
      { id: '2', position: '2', people: ['Bob'] },
      { id: '3', position: '3', people: ['Carol'] },
      { id: '4', position: '', people: ['Dave'] },
      { id: '5', position: '', people: ['Eve'] },
    ]), 'Alice,Bob,Carol,Dave,Eve'); // NOT Dave,Eve,... (old `||0` bug floated empties to front)
  });

  it('all unpositioned -> stable insertion order', () => {
    assert.equal(names([
      { id: 'x', position: '', people: ['X'] },
      { id: 'y', position: undefined, people: ['Y'] },
      { id: 'z', people: ['Z'] },
    ]), 'X,Y,Z');
  });

  it('non-numeric position is treated as unpositioned (sorts after, insertion order)', () => {
    assert.equal(names([
      { id: 'a', position: '1', people: ['A'] },
      { id: 'b', position: 'abc', people: ['B'] },
      { id: 'c', position: '2', people: ['C'] },
    ]), 'A,C,B');
  });

  it('does not mutate the input array', () => {
    const input = [{ id: 'b', position: '2', people: ['B'] }, { id: 'a', position: '1', people: ['A'] }];
    sortRosterRows(input);
    assert.equal(input[0].id, 'b'); // original order untouched
  });
});

describe('roster order — one sort, not four', () => {
  // `sortRosterRows` was hardened once: a missing or empty `position` must sort LAST, keeping insertion
  // order, because `(Number(position) || 0)` reads it as 0 and floats those rows ahead of every
  // positioned one. Three other callers kept inlining the old coercion — rosterGroups, the Lookup
  // editor, and the ref-hierarchy builder — so the same roster could come out in a different order
  // depending on which screen was asking, which is precisely what rosterGroups' own comment warns of.
  const rows = [
    { id: 'c', position: '2', people: ['Cal'] },
    { id: 'new', people: ['Newcomer'] },          // added, never reordered: no position at all
    { id: 'a', position: '1', people: ['Ann'] },
    { id: 'blank', position: '', people: ['Blank'] }
  ];

  it('unpositioned rows sort AFTER positioned ones, in insertion order', () => {
    assert.deepEqual(sortRosterRows(rows).map((r) => r.id), ['a', 'c', 'new', 'blank']);
  });

  it('and rosterGroups agrees, rather than floating them to the front', () => {
    const rv = { rosterRef: 'roster', rosterBy: 'grp', valueCol: 'people' };
    const withGroup = rows.map((r) => Object.assign({ grp: 'g' }, r));
    const g = require('../../rotation').rosterGroups(rv, { roster: withGroup });
    assert.deepEqual(g.groups[0].map((r) => r.id), ['a', 'c', 'new', 'blank']);
  });

  it('does not mutate its input, since dataCache arrays are shared', () => {
    const before = rows.map((r) => r.id);
    sortRosterRows(rows);
    assert.deepEqual(rows.map((r) => r.id), before);
  });
});
