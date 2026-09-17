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

// --- the `feed` declaration itself -------------------------------------------------------------
//
// These are the guard that has to exist BEFORE per-person rendering does. A shared feed and a
// per-person one are checked in opposite directions, and only one of the two failures is loud: a
// shared feed carrying @me renders the publisher's own calendar for everyone, which somebody notices,
// while a per-person feed with ONE unfiltered source renders a perfectly plausible calendar that
// happens to contain everybody's rows.
describe('feeds.js — what kind of feed a view declares', () => {
  it('true and "shared" are the same mode', () => {
    assert.equal(Feeds.modeOf({ calendar: {}, feed: true }), 'shared');
    assert.equal(Feeds.modeOf({ calendar: {}, feed: 'shared' }), 'shared');
  });

  it('"per-person" is its own mode', () => {
    assert.equal(Feeds.modeOf({ calendar: {}, feed: 'per-person' }), 'per-person');
    assert.equal(Feeds.isPerPerson({ calendar: {}, feed: 'per-person' }), true);
    assert.equal(Feeds.isPerPerson(VIEWS.fam), false);
  });

  // The direction that matters: a typo must not resolve to "shared", which would publish an @me
  // calendar rendered against whoever pressed publish.
  it('an unrecognised value is not a feed at all', () => {
    const v = { calendar: {}, feed: 'per-pesron' };
    assert.equal(Feeds.modeOf(v), '');
    assert.equal(Feeds.isFeed(v), false);
  });

  it('feed on a non-calendar is not a feed, whatever the value says', () => {
    assert.equal(Feeds.modeOf({ sources: ['events'], feed: 'per-person' }), '');
    assert.equal(Feeds.modeOf(VIEWS.notcal), '');
  });

  it('isFeed and modeOf cannot disagree', () => {
    [true, 'shared', 'per-person', 'nonsense', false, undefined].forEach((f) => {
      const v = { calendar: {}, feed: f };
      assert.equal(Feeds.isFeed(v), !!Feeds.modeOf(v), JSON.stringify(f));
    });
  });
});

describe('feeds.js — a SHARED feed refuses @me', () => {
  const errs = (views, name) => Feeds.configErrors(views, name, views[name]);

  it('accepts an ordinary shared feed', () => {
    assert.deepEqual(errs(VIEWS, 'fam'), []);
    assert.deepEqual(errs(VIEWS, 'duty'), []);
  });

  it('says nothing about a calendar that is not published', () => {
    assert.deepEqual(errs(VIEWS, 'private_cal'), []);
  });

  it('refuses feed on a view that is not a calendar', () => {
    const e = errs(VIEWS, 'notcal');
    assert.equal(e.length, 1);
    assert.match(e[0], /not a calendar/);
  });

  it('refuses an unrecognised feed value, and names it', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on' }] }, feed: 'yes please' };
    const e = errs({ x: v }, 'x');
    assert.equal(e.length, 1);
    assert.match(e[0], /"yes please"/);
    assert.match(e[0], /publishes nothing at all/);
  });

  it('refuses mineOnly, and points at per-person', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on' }] }, feed: true, mineOnly: true };
    const e = errs({ x: v }, 'x');
    assert.match(e.join('\n'), /mineOnly/);
    assert.match(e.join('\n'), /per-person/);
  });

  it('refuses an @me filter on a source', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: '@me' } }] }, feed: true };
    assert.match(errs({ x: v }, 'x').join('\n'), /@me/);
  });

  // The spelling a String(cond) check would miss.
  it('refuses @me written as an operator object', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: { eq: '@me' } } }] }, feed: true };
    assert.match(errs({ x: v }, 'x').join('\n'), /@me/);
  });

  it('refuses @me nested inside $or', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { $or: [{ who: '@me' }, { who: 'x' }] } }] }, feed: true };
    assert.match(errs({ x: v }, 'x').join('\n'), /@me/);
  });
});

describe('feeds.js — a PER-PERSON feed requires @me on every source', () => {
  const errs = (views, name) => Feeds.configErrors(views, name, views[name]);

  it('accepts one where every source is filtered', () => {
    const v = { calendar: { sources: [
      { table: 'events', dateColumn: 'on', filter: { who: '@me' } },
      { table: 'trips', dateColumn: 'starts', filter: { owner: { eq: '@me' } } }
    ] }, feed: 'per-person' };
    assert.deepEqual(errs({ x: v }, 'x'), []);
  });

  // The whole reason this guard exists: two filtered sources and one that is not reads as a working
  // calendar and ships the third table to every subscriber.
  it('refuses when ONE source of several is unfiltered, and names that source', () => {
    const v = { calendar: { sources: [
      { table: 'events', dateColumn: 'on', filter: { who: '@me' } },
      { table: 'salaries', dateColumn: 'on' }
    ] }, feed: 'per-person' };
    const e = errs({ x: v }, 'x');
    assert.equal(e.length, 1);
    assert.match(e[0], /source 2/);
    assert.match(e[0], /salaries/);
  });

  it('names every unfiltered source rather than only the first', () => {
    const v = { calendar: { sources: [
      { table: 'a', dateColumn: 'on' }, { table: 'b', dateColumn: 'on' }
    ] }, feed: 'per-person' };
    assert.equal(errs({ x: v }, 'x').length, 2);
  });

  // A view-level filter is not applied to a calendar's rows at all (events.js rowEvents reads
  // s.filter only), so accepting one here would accept a guard that never runs.
  it('a view-level @me does not satisfy the rule, because a calendar never applies it', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on' }] }, filter: { who: '@me' }, feed: 'per-person' };
    assert.match(errs({ x: v }, 'x').join('\n'), /source 1/);
  });

  it('refuses a rotation overlay that is not mineOnly', () => {
    const views = {
      x: { calendar: { sources: [], rotationSources: [{ view: 'matrix' }] }, feed: 'per-person' },
      matrix: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person' } }
    };
    const e = errs(views, 'x');
    assert.match(e.join('\n'), /matrix/);
    assert.match(e.join('\n'), /mineOnly/);
  });

  it('accepts a mineOnly rotation overlay', () => {
    const views = {
      x: { calendar: { sources: [], rotationSources: [{ view: 'matrix' }] }, feed: 'per-person' },
      matrix: { mineOnly: true, rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person' } }
    };
    assert.deepEqual(errs(views, 'x'), []);
  });

  it('refuses a per-person feed with nothing to filter', () => {
    const v = { calendar: { sources: [] }, feed: 'per-person' };
    assert.match(errs({ x: v }, 'x').join('\n'), /nothing to filter/);
  });
});
