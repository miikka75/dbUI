const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The rotation helpers now live in the requireable /rotation.js module (extracted from schema-loader.html),
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
