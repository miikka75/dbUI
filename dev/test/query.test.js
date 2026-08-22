// query.test.js — the split between what a backend can be asked for and what is filtered here.
//
// One property carries the whole thing:
//
//   filter(rows, cond)  ===  filter(applyConstraints(rows, constraints), residual)
//
// If that holds, pushing `constraints` into a real query is safe. If it does not, a view quietly loses
// rows — which nobody notices until someone trusts the screen. So the equivalence is asserted over every
// condition shape the language has, against a row set built to include the awkward cases: a missing
// field, a null, an empty string, a false, an array value.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Query = require('../../query');
const Rows = require('../../rows');

// Rows chosen so that the differences between "missing", "empty" and "falsy" actually show up.
const ROWS = [
  { id: '1', status: 'open',   owner: 'a@x', n: 1,  tags: ['red'] },
  { id: '2', status: 'done',   owner: 'b@x', n: 10, tags: ['red', 'blue'] },
  { id: '3', status: 'open',   owner: 'a@x', n: 2 },                       // tags missing
  { id: '4', status: '',       owner: 'a@x', n: 0,  tags: [] },            // empty / zero
  { id: '5',                   owner: null,  n: null },                    // status missing, null owner
  { id: '6', status: 'open',   owner: 'a@x', n: 3,  flag: false }
];

const CONDITIONS = [
  {},
  { status: 'open' },
  { status: 'open', owner: 'a@x' },
  { status: '' },
  { status: 'nope' },
  { flag: false },
  { n: 0 },
  { owner: null },
  { status: { notEmpty: true } },
  { status: { empty: true } },
  { status: { ne: 'open' } },
  { n: { gt: 1 } },
  { n: { lte: 2 } },
  { status: 'open', n: { gt: 1 } },
  { $or: [{ status: 'open' }, { status: 'done' }] },
  { $and: [{ status: 'open' }, { owner: 'a@x' }] },
  { $or: [{ status: 'open' }, { owner: 'b@x' }] },
  { status: 'open', $or: [{ n: 1 }, { n: 3 }] }
];

const direct = (rows, cond) => rows.filter((r) => Rows.condMatches(r, cond));
const viaSplit = (rows, cond) => {
  const { constraints, residual } = Query.compile(cond);
  return Query.applyConstraints(rows, constraints).filter((r) => Rows.condMatches(r, residual));
};

describe('query — the split preserves the result exactly', () => {
  for (const cond of CONDITIONS) {
    it(JSON.stringify(cond), () => {
      assert.deepEqual(viaSplit(ROWS, cond).map((r) => r.id), direct(ROWS, cond).map((r) => r.id));
    });
  }
});

describe('query — constraints only ever narrow to a superset', () => {
  // The direction that matters. A constraint set that returns FEWER rows than the condition matches is
  // a row missing from a view; one that returns more is merely work for the residual.
  for (const cond of CONDITIONS) {
    it(JSON.stringify(cond) + ' keeps every matching row', () => {
      const { constraints } = Query.compile(cond);
      const kept = Query.applyConstraints(ROWS, constraints).map((r) => r.id);
      for (const r of direct(ROWS, cond)) {
        assert.ok(kept.includes(r.id),
          'row ' + r.id + ' matches the condition but the constraints excluded it');
      }
    });
  }
});

describe('query — what it does and does not push down', () => {
  it('pushes a plain equality', () => {
    const { constraints, residual } = Query.compile({ status: 'open' });
    assert.deepEqual(constraints, [{ field: 'status', op: '==', value: 'open' }]);
    assert.equal(residual, null, 'nothing should be left to re-filter');
  });

  it('pushes several equalities from one conjunction', () => {
    const { constraints, residual } = Query.compile({ status: 'open', owner: 'a@x' });
    assert.equal(constraints.length, 2);
    assert.equal(residual, null);
  });

  it('splits a mixed condition, keeping the operator part as residual', () => {
    const { constraints, residual } = Query.compile({ status: 'open', n: { gt: 1 } });
    assert.deepEqual(constraints, [{ field: 'status', op: '==', value: 'open' }]);
    assert.deepEqual(residual, { n: { gt: 1 } });
  });

  it('refuses to push any branch of an $or', () => {
    // Narrowing to one branch would discard the rows the other branch matches — the exact shape of a
    // silently-lossy pushdown.
    const cond = { $or: [{ status: 'open' }, { status: 'done' }] };
    const { constraints, residual } = Query.compile(cond);
    assert.deepEqual(constraints, []);
    assert.deepEqual(residual, cond);
  });

  it('does not push `ne`, because a backend disagrees about a missing field', () => {
    // Firestore's != excludes documents lacking the field; condMatches treats missing as not-equal and
    // KEEPS them. Row 5 has no status, and { status: { ne: 'open' } } must match it.
    const { constraints } = Query.compile({ status: { ne: 'open' } });
    assert.deepEqual(constraints, []);
    assert.ok(direct(ROWS, { status: { ne: 'open' } }).some((r) => r.id === '5'),
      'the row with no status must match ne — which is why this cannot be pushed down');
  });

  it('does not push ordered comparisons, because _cmp is not SQL ordering', () => {
    // _cmp compares numerically when both sides parse as numbers and lexically otherwise. No backend
    // reproduces that, so pushing it would change which rows come back.
    assert.deepEqual(Query.compile({ n: { gt: 1 } }).constraints, []);
  });

  it('leaves a runtime-resolved list to the residual', () => {
    // matchList reads _listsCache, which the database has never heard of.
    const cond = { owner: { matchList: 'leads' } };
    assert.deepEqual(Query.compile(cond).constraints, []);
    assert.deepEqual(Query.compile(cond).residual, cond);
  });
});

describe('query — a compiled filter is worth compiling', () => {
  it('the common case — a plain equality view filter — pushes down entirely', () => {
    // If this stopped holding, the whole exercise would buy nothing: the filters real schemas use are
    // overwhelmingly flat equality.
    const real = [{ status: 'open' }, { status: 'logged', person: 'Ann' }, { city: 'X' }];
    for (const cond of real) {
      const { constraints, residual } = Query.compile(cond);
      assert.equal(constraints.length, Object.keys(cond).length, JSON.stringify(cond));
      assert.equal(residual, null, JSON.stringify(cond) + ' should need no re-filtering');
    }
  });
});
