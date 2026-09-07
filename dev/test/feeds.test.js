// feeds.test.js — which calendar views publish as .ics, and what invalidates one.
//
// `forTable` is the part worth testing: it decides when a feed is republished, and its failure is
// SILENT in the direction that matters. Miss a table and the feed is stale forever — nobody looks at an
// .ics until it is already wrong on someone's phone.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Feeds = require('../../feeds');

const VIEWS = {
  // A feed with two sources.
  fam: { calendar: { sources: [{ table: 'events', dateColumn: 'on' }, { table: 'trips', dateColumn: 'starts' }] }, feed: true },
  // A feed whose content also comes from a rotation overlay — whose rows live in a ROSTER table the
  // calendar never names.
  duty: { calendar: { sources: [{ table: 'events', dateColumn: 'on' }], rotationSources: [{ view: 'matrix' }] }, feed: true },
  matrix: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person' } },
  // A calendar that is NOT published.
  private_cal: { calendar: { sources: [{ table: 'secrets', dateColumn: 'on' }] } },
  // `feed` on something that is not a calendar is not a feed.
  notcal: { sources: ['events'], feed: true }
};

describe('feeds.js — which views are feeds', () => {
  it('a calendar with feed:true is one; a calendar without it is not', () => {
    assert.equal(Feeds.isFeed(VIEWS.fam), true);
    assert.equal(Feeds.isFeed(VIEWS.private_cal), false);
  });

  it('feed:true on a non-calendar view is not a feed', () => {
    assert.equal(Feeds.isFeed(VIEWS.notcal), false);
  });

  it('names lists exactly the published calendars', () => {
    assert.deepEqual(Feeds.names(VIEWS).sort(), ['duty', 'fam']);
  });

  it('tolerates rubbish without throwing', () => {
    assert.equal(Feeds.isFeed(null), false);
    assert.deepEqual(Feeds.names(null), []);
    assert.deepEqual(Feeds.tablesOf(VIEWS, 'nope'), []);
    assert.deepEqual(Feeds.forTable(VIEWS, ''), []);
  });
});

describe('feeds.js — what a feed depends on', () => {
  it('every calendar source table', () => {
    assert.deepEqual(Feeds.tablesOf(VIEWS, 'fam').sort(), ['events', 'trips']);
  });

  it('and the ROSTER behind a rotation overlay, which the calendar never names', () => {
    // The one a hand-written list forgets: editing ref_chores changes what the feed says while the
    // calendar's own `sources` are untouched.
    assert.deepEqual(Feeds.tablesOf(VIEWS, 'duty').sort(), ['events', 'ref_chores']);
  });

  it('a rotationSource naming a missing view contributes nothing rather than throwing', () => {
    const v = Object.assign({}, VIEWS, { broken: { calendar: { sources: [], rotationSources: [{ view: 'gone' }] }, feed: true } });
    assert.deepEqual(Feeds.tablesOf(v, 'broken'), []);
  });

  it('answers for ANY calendar, published or not — three callers share this one question', () => {
    // What to preload when the view opens, what to wait for before writing a file from it, and what
    // invalidates a published feed. Gating this on `feed` is what let the export path wait on a helper
    // that returned nothing for a calendar, and write an empty file.
    assert.deepEqual(Feeds.tablesOf(VIEWS, 'private_cal'), ['secrets']);
  });

  it('but an unpublished calendar still republishes nothing', () => {
    // The gate belongs on forTable, which is about FEEDS, not on the table list.
    assert.deepEqual(Feeds.forTable(VIEWS, 'secrets'), []);
  });

  it('a view that is not a calendar at all reads no calendar tables', () => {
    assert.deepEqual(Feeds.tablesOf(VIEWS, 'notcal'), []);
  });
});

describe('feeds.js — what a write invalidates', () => {
  it('a write to a shared table invalidates every feed that reads it', () => {
    assert.deepEqual(Feeds.forTable(VIEWS, 'events').sort(), ['duty', 'fam']);
  });

  it('a write to a roster invalidates only the feed overlaying it', () => {
    assert.deepEqual(Feeds.forTable(VIEWS, 'ref_chores'), ['duty']);
  });

  it('a write to a table only an UNPUBLISHED calendar reads invalidates nothing', () => {
    assert.deepEqual(Feeds.forTable(VIEWS, 'secrets'), []);
  });

  it('a write to an unrelated table invalidates nothing', () => {
    assert.deepEqual(Feeds.forTable(VIEWS, 'unrelated'), []);
  });
});

describe('feeds.js — the storage path', () => {
  it('is stable for an id — a subscription URL that moves is a broken subscription', () => {
    assert.equal(Feeds.pathFor('abc123'), 'feeds/abc123.ics');
    assert.equal(Feeds.pathFor('abc123'), Feeds.pathFor('abc123'));
  });

  it('mints a long random id, and never repeats one', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(Feeds.newId());
    assert.equal(ids.size, 200);
    assert.match([...ids][0], /^[0-9a-f]{32}$/);
  });

  it('REFUSES to mint without a CSPRNG rather than falling back to Math.random', () => {
    // A predictable id is a readable calendar. There is no degraded mode worth having here.
    assert.throws(() => Feeds.newId({}), /CSPRNG/);
  });
});
