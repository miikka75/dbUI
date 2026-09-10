// rotation-columns.test.js — what a rotation view shows when it has been narrowed down to nothing.
//
// `rotationColsFor` used to end `return ['_period'].concat(names)` unconditionally, so a viewer the
// narrowing left with no slot got a lone column of dates: a heading with a date list under it, which
// reads as a schedule that failed to load rather than as one that has nothing for you. It has a real
// trigger — a household member who does chores but is not on the duty roster (a parent) holds no slot,
// so `mineOnly` matches none of them.
//
// Lifted out of the SHIPPED app-core.js rather than re-implemented, because a mirrored copy of a
// narrowing rule is exactly what drifts.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { appCoreFn } = require('./app-core-fn');

const VIEWS = {
  duty_matrix: { name: 'duty_matrix', kind: 'rotation', mineOnly: { list: 'members' },
                 rotation: { rosterRef: 'roster', rosterBy: 'person', valueCol: 'tasks', interval: 'weekly' } }
};
const colsFor = appCoreFn('rotationColsFor', { VIEWS });

// A stand-in root: the two helpers the member calls, and nothing else it touches.
const app = (slots, mine) => ({
  rotationSlotsFor: () => slots,
  mineOnlySlot: () => mine
});

describe('rotationColsFor — a rotation narrowed to no slot has no columns', () => {
  it('the whole matrix for an exempt viewer (mineOnly does not apply)', () => {
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], null), 'duty_matrix', []),
      ['_period', 'Ann', 'Bob']);
  });

  it('one column for a viewer who holds a slot', () => {
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], 'ann'), 'duty_matrix', []),
      ['_period', 'Ann']);
  });

  it('NOTHING for a viewer who holds none — not a bare date column', () => {
    // The parent case: a member of the household, not a member of the roster.
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], 'parent'), 'duty_matrix', []), []);
  });

  it('nothing for an identity that could not be resolved, which fails closed to no slot', () => {
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], ''), 'duty_matrix', []), []);
  });

  it('nothing when the roster itself is empty', () => {
    assert.deepEqual(colsFor.call(app([], null), 'duty_matrix', []), []);
  });

  it('nothing when hideEmpty removes the last remaining slot', () => {
    const v = Object.assign({ hideEmpty: true }, VIEWS.duty_matrix);
    const rows = [{ _period: '2026-01-05', Ann: [], Bob: [] }];
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], null), 'duty_matrix', rows, v), []);
    // ...but keeps the one that still carries something.
    const rows2 = [{ _period: '2026-01-05', Ann: ['Wash up'], Bob: [] }];
    assert.deepEqual(colsFor.call(app(['Ann', 'Bob'], null), 'duty_matrix', rows2, v), ['_period', 'Ann']);
  });

  it('a view that is not a rotation is still nothing', () => {
    assert.deepEqual(colsFor.call(app(['Ann'], null), 'duty_matrix', [], { name: 'x' }), []);
  });
});
