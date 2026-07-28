const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Board = require('../../board');

describe('board.js — lane bucketing', () => {
  const rows = [
    { id: '1', tila: 'kutsutaan', henkilö: 'Ann' },
    { id: '2', tila: 'vastaanotettu', henkilö: 'Bob' },
    { id: '3', tila: 'kutsutaan', henkilö: 'Cec' },
    { id: '4', tila: '', henkilö: 'Dan' }
  ];

  it('groups rows into lanes, first-seen order', () => {
    const b = Board.build(rows, { lane: 'tila' });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu', '']);
    assert.deepEqual(b.lanes[0].items.map(r => r.id), ['1', '3']);
    assert.equal(b.lanes[0].count, 2);
  });

  it('laneOrder materializes empty lanes and fixes order', () => {
    const b = Board.build(rows, { lane: 'tila', laneOrder: ['kutsutaan', 'vastaanotettu', 'kiitetään'] });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu', 'kiitetään', '']);
    assert.equal(b.lanes[2].count, 0);          // kiitetään declared but empty -> still present
  });

  it('hidden drops lanes; blank lane hideable', () => {
    const b = Board.build(rows, { lane: 'tila', hidden: [''] });
    assert.deepEqual(b.lanes.map(l => l.key), ['kutsutaan', 'vastaanotettu']);
  });

  it('sortWithin orders cards inside a lane', () => {
    const b = Board.build(rows, { lane: 'tila', sortWithin: (a, c) => a.henkilö.localeCompare(c.henkilö) });
    assert.deepEqual(b.lanes[0].items.map(r => r.henkilö), ['Ann', 'Cec']);
  });

  it('array lane value uses first element; empty array -> unassigned', () => {
    const b = Board.build([{ id: 'a', tila: ['x', 'y'] }, { id: 'b', tila: [] }], { lane: 'tila' });
    assert.deepEqual(b.lanes.map(l => l.key), ['x', '']);
  });

  it('empty input yields declared lanes only (or none)', () => {
    assert.deepEqual(Board.build([], { lane: 'tila' }).lanes, []);
    assert.deepEqual(Board.build([], { lane: 'tila', laneOrder: ['a', 'b'] }).lanes.map(l => l.key), ['a', 'b']);
  });
});
