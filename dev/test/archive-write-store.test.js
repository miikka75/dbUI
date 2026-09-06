// archive-write-store.test.js — a write goes to the store the ROW is in, not the tab on screen.
//
// The bug this pins, seen in a live deployment: the same meeting id existed twice — once in
// `meeting_agenda` carrying `_status: 'archive'`, once as a full document in `meeting_agenda__archive`
// — and every edit made to it on the archive tab silently reverted.
//
// One cause. Under partition-as-field an archived row never leaves the ACTIVE store; `_status` says
// which partition it belongs to. But the write paths still chose their collection from
// `viewingArchive`, so editing an archived row wrote to `<table>__archive`. The row was not there, so
// the write CREATED it (a whole-row create, since the cache-miss branch reads that as a new row) — and
// partitionRows, which resolves a duplicate id in favour of the active store, went on showing the old
// copy. Hence both symptoms at once: a ghost document, and an edit that did nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Rows = require('../../rows');
const { appCoreFn } = require('./app-core-fn');

describe('rows — storeOf', () => {
  const cache = {
    meetings: [{ id: 'live' }, { id: 'filed', _status: 'archive' }],
    meetings__archive: [{ id: 'legacy' }, { id: 'filed' }]
  };

  it('an active row is in the active store', () => {
    assert.equal(Rows.storeOf(cache, 'meetings', 'live'), 'active');
  });

  it('a row FILED AWAY by field is still in the active store', () => {
    // The whole point. `_status: 'archive'` moves nothing.
    assert.equal(Rows.storeOf(cache, 'meetings', 'filed'), 'active');
  });

  it('a row filed away under the old model is in the archive store', () => {
    assert.equal(Rows.storeOf(cache, 'meetings', 'legacy'), 'archive');
  });

  it('an id in BOTH stores resolves to active, matching partitionRows', () => {
    // partitionRows lets the active copy win a duplicate id, so a write must land on that same copy —
    // otherwise it edits the copy nobody reads, which is exactly what happened.
    assert.equal(Rows.storeOf(cache, 'meetings', 'filed'), 'active');
    const archived = Rows.partitionRows(cache, 'meetings', 'archive');
    assert.deepEqual(archived.map((r) => r.id), ['filed', 'legacy']);
    assert.equal(archived.filter((r) => r.id === 'filed').length, 1);
  });

  it('an unknown row, an unloaded table and a missing id all answer active', () => {
    // Where a row goes when nothing says otherwise: the store the field model writes to.
    assert.equal(Rows.storeOf(cache, 'meetings', 'nosuch'), 'active');
    assert.equal(Rows.storeOf(cache, 'not_loaded', 'x'), 'active');
    assert.equal(Rows.storeOf(cache, 'meetings', null), 'active');
    assert.equal(Rows.storeOf(null, 'meetings', 'live'), 'active');
  });
});

describe('app-core getTab — the write store ignores the tab on screen', () => {
  // The SHIPPED member, lifted out of app-core.js: a copy of it here would have stayed correct while
  // the real one went wrong, which is the failure mode this whole style of test exists for.
  const getTab = appCoreFn('getTab');
  const ctx = (dataCache) => ({ dataCache: dataCache, viewingArchive: true });

  it('an archived row viewed on the archive tab still writes to the active store', () => {
    // REGRESSION: this returned 'archive' — the write that created the ghost document.
    const app = ctx({ meetings: [{ id: 'm1', _status: 'archive' }] });
    assert.equal(getTab.call(app, 'meetings', 'm1'), 'active');
  });

  it('a legacy row that really is in the archive store still writes there', () => {
    const app = ctx({ meetings: [], meetings__archive: [{ id: 'old' }] });
    assert.equal(getTab.call(app, 'meetings', 'old'), 'archive');
  });

  it('an active row on the active tab is unchanged', () => {
    const app = { dataCache: { meetings: [{ id: 'm1' }] }, viewingArchive: false };
    assert.equal(getTab.call(app, 'meetings', 'm1'), 'active');
  });
});

describe('app-core _deleteFromSources — delete means gone from the table', () => {
  // Lifted with the file-scope globals the body reads.
  const build = (schema, writes) => appCoreFn('_deleteFromSources', {
    SCHEMA: schema,
    aKey: (t) => t + '__archive',
    Writes: { deleteRow: (t, id, tab) => writes.push([t, id, tab]) }
  });

  it('clears both stores of an archivable table, so a ghost cannot resurface', () => {
    // REGRESSION: it deleted from ONE store, chosen by the tab. With the same id in both — the state
    // the ghost above leaves behind — deleting the visible copy promoted the ghost into view.
    const writes = [];
    const fn = build({ meetings: { archivable: true } }, writes);
    const app = {
      dataCache: { meetings: [{ id: 'm1' }], meetings__archive: [{ id: 'm1' }] },
      currentData: [{ id: 'm1' }],
      notify: () => {}, t: (k) => k
    };
    fn.call(app, ['meetings'], 'm1');
    assert.deepEqual(writes, [['meetings', 'm1', 'active'], ['meetings', 'm1', 'archive']]);
    assert.deepEqual(app.dataCache.meetings, []);
    assert.deepEqual(app.dataCache.meetings__archive, []);
    assert.deepEqual(app.currentData, []);
  });

  it('touches only the active store when the table has no archive', () => {
    const writes = [];
    const fn = build({ roster: { } }, writes);
    const app = { dataCache: { roster: [{ id: 'r1' }] }, currentData: [], notify: () => {}, t: (k) => k };
    fn.call(app, ['roster'], 'r1');
    assert.deepEqual(writes, [['roster', 'r1', 'active']]);
  });

  it('does not seed an empty archive cache for a store that was never loaded', () => {
    // Seeding [] would tell partitionRows the archive store is loaded and empty, hiding every legacy
    // archived row until the next reload.
    const writes = [];
    const fn = build({ meetings: { archivable: true } }, writes);
    const app = { dataCache: { meetings: [{ id: 'm1' }] }, currentData: [], notify: () => {}, t: (k) => k };
    fn.call(app, ['meetings'], 'm1');
    assert.equal(app.dataCache.meetings__archive, undefined);
  });
});
