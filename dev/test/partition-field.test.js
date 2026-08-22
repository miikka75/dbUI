// partition-field.test.js — a row's partition is a FIELD, and used to be a STORE.
//
// `tasks` held the active rows and `tasks__archive` the filed-away ones, so "which partition is this
// row in" was answered by which of the two it came out of. That costs a cross-collection move to
// archive anything (non-atomic, as the backend contract admits), a second read to see history, and a
// special case in every view kind that has to look at both. `_status` on the row replaces it.
//
// Both shapes exist at once for as long as rows written under the old one are around, so every case
// below is really about the rule that covers both: the FIELD wins where present, the STORE decides
// where it is not.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Rows = require('../../rows');

const ids = (rows) => rows.map((r) => r.id);

describe('rows — partitionOf', () => {
  it('reads the field when the row carries one', () => {
    assert.equal(Rows.partitionOf({ id: '1', _status: 'archive' }, 'active'), 'archive');
    assert.equal(Rows.partitionOf({ id: '1', _status: 'active' }, 'archive'), 'active');
  });

  it('falls back to the store when the row does not', () => {
    // This is what makes the whole change a no-op on existing data: rows written before `_status`
    // existed keep answering exactly as they did.
    assert.equal(Rows.partitionOf({ id: '1' }, 'active'), 'active');
    assert.equal(Rows.partitionOf({ id: '1' }, 'archive'), 'archive');
  });

  it('treats an empty or non-string _status as absent', () => {
    // A blank is what a cleared cell leaves behind, and it must not read as a partition named "".
    for (const bad of ['', null, undefined, 0, false, {}, []]) {
      assert.equal(Rows.partitionOf({ id: '1', _status: bad }, 'archive'), 'archive', JSON.stringify(bad));
    }
  });

  it('defaults to active with no row and no store', () => {
    assert.equal(Rows.partitionOf(null, null), 'active');
    assert.equal(Rows.partitionOf(undefined, undefined), 'active');
  });
});

describe('rows — partitionRows reads both shapes at once', () => {
  const cache = {
    t: [
      { id: 'a' },                        // old shape, active store -> active
      { id: 'b', _status: 'archive' }     // new shape, filed away without moving
    ],
    t__archive: [
      { id: 'c' },                        // old shape, archive store -> archive
      { id: 'd', _status: 'active' }      // restored by field, not yet moved
    ]
  };

  it('collects the active rows from both stores', () => {
    assert.deepEqual(ids(Rows.partitionRows(cache, 't', 'active')), ['a', 'd']);
  });

  it('collects the archived rows from both stores', () => {
    assert.deepEqual(ids(Rows.partitionRows(cache, 't', 'archive')), ['b', 'c']);
  });

  it('every row lands in exactly one partition', () => {
    // The property that matters. A row appearing in both would be double-counted in any total; a row
    // in neither would vanish from the app with nothing to show for it.
    const all = [...cache.t, ...cache.t__archive].map((r) => r.id).sort();
    const split = [...ids(Rows.partitionRows(cache, 't', 'active')),
                   ...ids(Rows.partitionRows(cache, 't', 'archive'))].sort();
    assert.deepEqual(split, all);
  });

  it('defaults to the active partition', () => {
    assert.deepEqual(ids(Rows.partitionRows(cache, 't')), ['a', 'd']);
  });

  it('returns [] rather than throwing for a source that is not loaded', () => {
    // Boot no longer fetches the archive store unless preload_archive is on, so "not loaded" is the
    // normal state for it, not an error.
    assert.deepEqual(Rows.partitionRows(cache, 'nosuch', 'active'), []);
    assert.deepEqual(Rows.partitionRows({}, 't', 'archive'), []);
    assert.deepEqual(Rows.partitionRows(null, 't', 'active'), []);
  });

  it('an unloaded archive store still yields the active-store rows', () => {
    const partial = { t: [{ id: 'a' }, { id: 'b', _status: 'archive' }] };
    assert.deepEqual(ids(Rows.partitionRows(partial, 't', 'active')), ['a']);
    assert.deepEqual(ids(Rows.partitionRows(partial, 't', 'archive')), ['b']);
  });
});

describe('rows — data written before _status behaves exactly as it did', () => {
  // The regression that matters most: every schema in the wild is the old shape, and none of it should
  // notice this change at all.
  const legacy = { t: [{ id: '1' }, { id: '2' }], t__archive: [{ id: '3' }] };

  it('the active store is the active partition, whole', () => {
    assert.deepEqual(ids(Rows.partitionRows(legacy, 't', 'active')), ['1', '2']);
  });

  it('the archive store is the archive partition, whole', () => {
    assert.deepEqual(ids(Rows.partitionRows(legacy, 't', 'archive')), ['3']);
  });

  it('buildRows sees the same rows it always did', () => {
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'] }, legacy)), ['1', '2']);
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'], includeArchive: true }, legacy)), ['1', '2', '3']);
  });
});

describe('rows — buildRows honours the field', () => {
  const cache = {
    t: [{ id: 'a' }, { id: 'b', _status: 'archive' }],
    t__archive: [{ id: 'c' }]
  };

  it('a filed-away row drops out of a plain view without moving stores', () => {
    // The point of the change: archiving becomes a field write, and the worklist stops showing the row
    // with no cross-collection move involved.
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'] }, cache)), ['a']);
  });

  it('includeArchive still totals everything exactly once', () => {
    // `includeArchive` exists so a balance does not go wrong when a row ages out. Double-counting `b`
    // here would break the very sums it was added for.
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'], includeArchive: true }, cache)), ['a', 'b', 'c']);
  });

  it('a filter still applies on top of the partition split', () => {
    const c2 = { t: [{ id: 'a', s: 'open' }, { id: 'b', s: 'open', _status: 'archive' }, { id: 'c', s: 'done' }] };
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'], filter: { s: 'open' } }, c2)), ['a']);
  });
});

describe('rows — a row that exists in both stores is counted once', () => {
  // Migrating a row means writing it to the active store and clearing it from the archive one: two
  // writes with nothing joining them, so a failure between leaves the same id in both. Counting it
  // twice would corrupt every total that uses includeArchive, silently. The stale copy is ignored
  // instead, until the next migration pass clears it.
  const dup = {
    t: [{ id: '1', _status: 'archive', v: 'migrated' }],
    t__archive: [{ id: '1', v: 'stale' }, { id: '2', v: 'other' }]
  };

  it('the active store wins', () => {
    const rows = Rows.partitionRows(dup, 't', 'archive');
    assert.deepEqual(ids(rows), ['1', '2']);
    assert.equal(rows.find((r) => r.id === '1').v, 'migrated', 'the stale archive copy won');
  });

  it('and it is still counted exactly once across both partitions', () => {
    const split = [...ids(Rows.partitionRows(dup, 't', 'active')),
                   ...ids(Rows.partitionRows(dup, 't', 'archive'))];
    assert.deepEqual(split.sort(), ['1', '2']);
  });

  it('includeArchive does not double it', () => {
    // The sums this option exists for are exactly what a duplicate would break.
    assert.deepEqual(ids(Rows.buildRows({ sources: ['t'], includeArchive: true }, dup)).sort(), ['1', '2']);
  });

  it('a row with no id is not deduped away', () => {
    // Rows without an id are not identifiable, so they cannot be duplicates of each other.
    const noid = { t: [{ _status: 'archive' }], t__archive: [{}] };
    assert.equal(Rows.partitionRows(noid, 't', 'archive').length, 2);
  });
});
