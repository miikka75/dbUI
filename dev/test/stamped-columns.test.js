// stamped-columns.test.js — a column the app fills in and NOBODY rewrites.
//
// `ownerWritable` bounds the OWNER branch: it is what makes "anyone may log, only a parent may
// approve" expressible. It is deliberately inert for an editor holding a table grant, which is right
// for an approval column — a parent has the grant precisely so they can decide.
//
// A stamped column is the other shape. On a SHARED table — a household shopping list everyone may
// tick off — one column records who added the row, and that is not a decision anybody gets to revise,
// grant or no grant. Owner-bounding the table would protect it, but at the cost of the sharing: you
// could no longer tick off somebody else's milk. So this binds the column rather than the row.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const H = require('../../backend-helpers');

const SCHEMA = {
  tables: {
    home_shopping: {
      columns: [
        { name: 'item', type: 'text' },
        { name: 'shop_status', type: 'select', list: 'shop_status', default: 'needed' },
        { name: 'added_by', type: 'select', list: 'members', defaultFrom: '@me', stamped: true }
      ]
    },
    plain: { columns: [{ name: 'a', type: 'text' }] }
  }
};

describe('backend-helpers — stampedOf (the mirror the rules layers read)', () => {
  it('names the column and the list its value is verified against', () => {
    // The list is what lets a write layer resolve "the caller's own value" the same way `@me` does.
    assert.deepEqual(H.stampedOf(SCHEMA).home_shopping, { col: 'added_by', list: 'members' });
  });

  it('a table with no stamped column is absent, not empty', () => {
    // Absent means "unchanged behaviour" to every layer that reads the mirror, the same contract
    // ownerWritable has. An empty entry would be a table that IS bounded, by nothing.
    assert.equal('plain' in H.stampedOf(SCHEMA), false);
    assert.deepEqual(H.stampedOf({ tables: {} }), {});
    assert.deepEqual(H.stampedOf(null), {});
  });

  it('ignores `stamped` without `defaultFrom: "@me"`', () => {
    // There would be nothing to verify the value against, and nothing to fill it in with: the column
    // would simply be unwritable, which is a broken table rather than a protected one. validateSchema
    // rejects it at load; the mirror refuses to carry it in case an older schema slips through.
    const s = { tables: { t: { columns: [{ name: 'who', type: 'text', stamped: true }] } } };
    assert.deepEqual(H.stampedOf(s), {});
  });

  it('ignores a stamped column with no list', () => {
    // Same rule the identity column follows: without a list the identity is the profile display name,
    // which the user writes themselves, so there is nothing to check against.
    const s = { tables: { t: { columns: [{ name: 'who', defaultFrom: '@me', stamped: true }] } } };
    assert.deepEqual(H.stampedOf(s), {});
  });

  it('takes the first stamped column and no more', () => {
    // One per table, like identityCol: neither rules language can loop over a map to resolve a
    // different list per column. validateSchema names the second one rather than let it be dropped.
    const s = { tables: { t: { columns: [
      { name: 'a', defaultFrom: '@me', list: 'members', stamped: true },
      { name: 'b', defaultFrom: '@me', list: 'members', stamped: true }
    ] } } };
    assert.deepEqual(H.stampedOf(s).t, { col: 'a', list: 'members' });
  });

  it('reads a map-shaped columns block too', () => {
    const s = { tables: { t: { columns: { who: { defaultFrom: '@me', list: 'members', stamped: true } } } } };
    assert.deepEqual(H.stampedOf(s).t, { col: 'who', list: 'members' });
  });
});

describe('backend-helpers — stampedOk (the check all four layers share)', () => {
  const B = { col: 'added_by', list: 'members' };

  it('a table with no stamped column is unaffected', () => {
    assert.equal(H.stampedOk(null, null, { added_by: 'Bob' }, 'Ann'), true);
  });

  it('a write that does not carry the column cannot forge it', () => {
    // Ticking off somebody else's item is an ordinary edit that never mentions `added_by`. That has to
    // keep working, or protecting the column would cost the sharing it exists to allow.
    assert.equal(H.stampedOk(B, { added_by: 'Bob' }, { shop_status: 'bought' }, 'Ann'), true);
  });

  it('ON CREATE the value must be the caller\'s own', () => {
    assert.equal(H.stampedOk(B, null, { added_by: 'Ann' }, 'Ann'), true);
    assert.equal(H.stampedOk(B, null, { added_by: 'Bob' }, 'Ann'), false, 'added the row as somebody else');
  });

  it('a caller with no identity cannot stamp one', () => {
    assert.equal(H.stampedOk(B, null, { added_by: 'Ann' }, ''), false);
    assert.equal(H.stampedOk(B, null, { added_by: '' }, ''), false);
  });

  it('ON UPDATE the column may not change — not even to the caller\'s own value', () => {
    // This is the half `ownerWritable` cannot express. Bob holds a grant and may edit Ann's row; he
    // may not relabel it as his. Nor may Ann relabel Bob's as hers.
    assert.equal(H.stampedOk(B, { added_by: 'Bob' }, { added_by: 'Bob' }, 'Ann'), true, 'resending the same value is not a change');
    assert.equal(H.stampedOk(B, { added_by: 'Bob' }, { added_by: 'Ann' }, 'Ann'), false, 'claimed somebody else\'s row');
    assert.equal(H.stampedOk(B, { added_by: 'Ann' }, { added_by: 'Bob' }, 'Ann'), false, 'gave away their own row');
  });

  it('compares as strings, so 0 and "0" are the same stamp', () => {
    assert.equal(H.stampedOk(B, { added_by: 0 }, { added_by: '0' }, 'Ann'), true);
  });

  it('treats null and missing-on-the-stored-row as an empty stamp', () => {
    // A row that predates the column has no value there. Filling it in is a change like any other, so
    // it must be the caller's own — which is the migration path, not a hole.
    assert.equal(H.stampedOk(B, {}, { added_by: 'Ann' }, 'Ann'), true);
    assert.equal(H.stampedOk(B, {}, { added_by: 'Bob' }, 'Ann'), false);
  });
});
