// owner-fields-coercion.test.js — the owner-bounds field comparison, and the coercion the three
// implementations have to agree on.
//
// "May this owner-scoped write touch the fields it touches?" is answered in three languages and cannot
// be reduced to one: `firestore.rules` uses `diff().affectedKeys().hasOnly()`, `supabase-schema.sql` a
// `jsonb_each` union with `is distinct from`, and JS for the dev server's HTTP gate. Three languages,
// so the comparison is irreducible — but the COERCION is a choice, and the three had made different
// ones with nothing recording it.
//
// The JS copy used `String(a) !== String(b)`, which turns `null` into the string 'null'. The SQL uses
// `coalesce(x ->> k, '')`, which turns it into ''. So a field going from absent to null was a forbidden
// change on the dev server and a no-op under the RLS — the dev server stricter than production, which
// is the safe direction but was drift all the same.
//
// THE CONTRACT IS THE SQL'S, because the RLS is what runs in production. This file is where it is
// written down; if any of the three moves, this is what should be updated first and the other two
// brought to it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const H = require('../../backend-helpers');

// One owner-writable column (`note`); everything else on the row is frozen for an owner.
const BOUNDS = { cols: ['note'], locked: {} };
const ok = (incoming, existing) => H.ownerFieldsOk(BOUNDS, incoming, existing);

describe('ownerFieldsOk — what an owner may change', () => {
  it('lets an owner change a listed column', () => {
    assert.equal(ok({ note: 'after', status: 'logged' }, { note: 'before', status: 'logged' }), true);
  });

  it('an OMITTED frozen column reads as clearing it, and is refused', () => {
    // Not a partial-update convenience: absent and '' are the same value under this contract (see
    // below), so omitting a frozen column that holds something IS a change to it. The write path never
    // hits this — putRow sends the merged row, so every frozen column comes back with its stored value
    // — and the SQL behaves identically, which is the point of writing it down here rather than
    // leaving it to be discovered from a 403.
    assert.equal(ok({ note: 'after' }, { note: 'before', status: 'logged' }), false);
    assert.equal(ok({ note: 'after' }, { note: 'before', status: '' }), true, 'nothing to clear');
  });

  it('refuses a column that is not listed', () => {
    assert.equal(ok({ status: 'approved' }, { note: 'x', status: 'logged' }), false);
  });

  it('lets an unlisted column through when it is UNCHANGED', () => {
    // A partial update normally omits it, but a client that round-trips the whole row must not be
    // refused for sending back what is already stored.
    assert.equal(ok({ note: 'after', status: 'logged' }, { note: 'before', status: 'logged' }), true);
  });

  it('sees a key that is only in the STORED row', () => {
    // Dropping a frozen field is a change to it. Comparing only the incoming keys would let an owner
    // delete an approval by omitting it.
    assert.equal(ok({ note: 'x' }, { note: 'x', status: 'approved' }), false);
  });

  it('lets the system columns through, listed or not', () => {
    // The app stamps these itself on every write; refusing them would refuse every create.
    const row = {};
    H.OWNER_SYSTEM_COLS.forEach((k) => { row[k] = 'v'; });
    assert.equal(ok(row, {}), true);
  });

  it('passes when the table has no owner bounds at all', () => {
    assert.equal(H.ownerFieldsOk(null, { anything: 1 }, {}), true);
  });

  it('compares a create against `locked`, not against nothing', () => {
    // On a create there is no stored row, so the bound's starting state is the baseline: "you may not
    // start a row already approved".
    const bounds = { cols: ['note'], locked: { status: 'logged' } };
    assert.equal(H.ownerFieldsOk(bounds, { note: 'n', status: 'logged' }, null), true);
    assert.equal(H.ownerFieldsOk(bounds, { note: 'n', status: 'approved' }, null), false);
  });
});

describe('ownerFieldsOk — the coercion contract (matches supabase-schema.sql)', () => {
  // Each row: two values for the same frozen column, and whether they count as THE SAME value.
  // Read this as the spec, not as a description of the code.
  const SAME = [
    ['absent and empty string', undefined, '', true],
    ['absent and null', undefined, null, true],
    ['null and empty string', null, '', true],
    ['number and its text', 0, '0', true],
    ['nonzero number and its text', 7, '7', true],
    ['boolean and its text', false, 'false', true],
    ['true and its text', true, 'true', true],

    ['zero and empty string', 0, '', false],
    ['false and empty string', false, '', false],
    ['false and zero', false, 0, false],
    ['different text', 'a', 'b', false],
  ];

  for (const [name, a, b, same] of SAME) {
    it((same ? 'treats as equal: ' : 'treats as different: ') + name, () => {
      const incoming = {}, existing = {};
      if (a !== undefined) incoming.status = a;
      if (b !== undefined) existing.status = b;
      // `status` is not owner-writable, so "unchanged" is the only way this passes.
      assert.equal(ok(incoming, existing), same);
      assert.equal(ok(existing, incoming), same, 'the comparison must be symmetric');
    });
  }

  it('the rules layer is allowed to be STRICTER than this, never looser', () => {
    // firestore.rules compares structurally, so `0` -> `'0'` IS an affected key there and the write is
    // refused. That direction is safe — the Firestore mirror may refuse what the RLS permits — and it
    // is what dev/test-emulator/policy-differential.mjs enforces across the whole matrix. Recorded here
    // so nobody "fixes" the rules to match this file and loosens them.
    assert.equal(ok({ status: 0 }, { status: '0' }), true, 'the SQL contract: equal');
  });
});
