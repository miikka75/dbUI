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
  // A per-person feed also needs somewhere to read subscribers from; that half is its own suite
  // below, so these views carry a valid one and vary only the filtering.
  const SCHEMA = { subs: { columns: { owner: { type: 'owner' }, lang: 'text', url: 'text', fid: 'text', active: 'text' },
                           ownerWritable: ['lang', 'active'], ownerWritableWhile: { active: 'yes' } },
                   a: { columns: {} }, b: { columns: {} }, events: { columns: {} }, trips: { columns: {} }, salaries: { columns: {} } };
  const SUBS = { table: 'subs', langColumn: 'lang', urlColumn: 'url', idColumn: 'fid', activeColumn: 'active' };
  const errs = (views, name) => Feeds.configErrors(views, name, views[name], SCHEMA);

  it('accepts one where every source is filtered', () => {
    const v = { calendar: { sources: [
      { table: 'events', dateColumn: 'on', filter: { who: '@me' } },
      { table: 'trips', dateColumn: 'starts', filter: { owner: { eq: '@me' } } }
    ] }, feed: 'per-person', feedSubscribers: SUBS };
    assert.deepEqual(errs({ x: v }, 'x'), []);
  });

  // The whole reason this guard exists: two filtered sources and one that is not reads as a working
  // calendar and ships the third table to every subscriber.
  it('refuses when ONE source of several is unfiltered, and names that source', () => {
    const v = { calendar: { sources: [
      { table: 'events', dateColumn: 'on', filter: { who: '@me' } },
      { table: 'salaries', dateColumn: 'on' }
    ] }, feed: 'per-person', feedSubscribers: SUBS };
    const e = errs({ x: v }, 'x');
    assert.equal(e.length, 1);
    assert.match(e[0], /source 2/);
    assert.match(e[0], /salaries/);
  });

  it('names every unfiltered source rather than only the first', () => {
    const v = { calendar: { sources: [
      { table: 'a', dateColumn: 'on' }, { table: 'b', dateColumn: 'on' }
    ] }, feed: 'per-person', feedSubscribers: SUBS };
    assert.equal(errs({ x: v }, 'x').length, 2);
  });

  // A view-level filter is not applied to a calendar's rows at all (events.js rowEvents reads
  // s.filter only), so accepting one here would accept a guard that never runs.
  it('a view-level @me does not satisfy the rule, because a calendar never applies it', () => {
    const v = { calendar: { sources: [{ table: 'events', dateColumn: 'on' }] }, filter: { who: '@me' }, feed: 'per-person', feedSubscribers: SUBS };
    assert.match(errs({ x: v }, 'x').join('\n'), /source 1/);
  });

  it('refuses a rotation overlay that is not mineOnly', () => {
    const views = {
      x: { calendar: { sources: [], rotationSources: [{ view: 'matrix' }] }, feed: 'per-person', feedSubscribers: SUBS },
      matrix: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person' } }
    };
    const e = errs(views, 'x');
    assert.match(e.join('\n'), /matrix/);
    assert.match(e.join('\n'), /mineOnly/);
  });

  it('accepts a mineOnly rotation overlay', () => {
    const views = {
      x: { calendar: { sources: [], rotationSources: [{ view: 'matrix' }] }, feed: 'per-person', feedSubscribers: SUBS },
      matrix: { mineOnly: true, rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person' } }
    };
    assert.deepEqual(errs(views, 'x'), []);
  });

  it('refuses a per-person feed with nothing to filter', () => {
    const v = { calendar: { sources: [] }, feed: 'per-person', feedSubscribers: SUBS };
    assert.match(errs({ x: v }, 'x').join('\n'), /nothing to filter/);
  });
});

// --- who a per-person feed is rendered FOR -----------------------------------------------------
//
// Subscribing is a row the person creates in an owner-stamped table, so the list is opt-in by
// construction. The guards below are about the row's two halves having different writers: the
// subscriber owns the request (that they subscribe, in which language), the publisher owns the grant
// (the minted URL). A subscriber who can write their own url column can point it somewhere the
// publisher will never blank, so the link outlives every revocation the feature offers.
describe('feeds.js — the subscriber list', () => {
  const SCHEMA = {
    subs: { columns: { owner: { type: 'owner' }, feed: 'text', lang: 'text', url: 'text', fid: 'text', active: 'text' },
            ownerWritable: ['lang', 'feed', 'active'], ownerWritableWhile: { active: 'yes' } },
    events: { columns: {} }
  };
  const SUBS = { table: 'subs', langColumn: 'lang', urlColumn: 'url', idColumn: 'fid', activeColumn: 'active' };
  const view = (extra) => Object.assign({
    calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: '@me' } }] },
    feed: 'per-person', feedSubscribers: SUBS
  }, extra || {});
  const errs = (v, name) => Feeds.configErrors({ [name || 'x']: v }, name || 'x', v, SCHEMA);

  it('lists one subscriber per owner, lowercased and sorted', () => {
    const rows = [{ owner: 'Zoe@x.test' }, { owner: 'anna@X.test' }];
    const subs = Feeds.subscribersOf(view(), rows, 'x');
    assert.deepEqual(subs.map((s) => s.owner), ['anna@x.test', 'zoe@x.test']);
  });

  it('carries each subscriber\'s language and url', () => {
    const subs = Feeds.subscribersOf(view(), [{ owner: 'a@x.test', lang: 'fi', url: 'https://s/1.ics' }], 'x');
    assert.equal(subs[0].lang, 'fi');
    assert.equal(subs[0].url, 'https://s/1.ics');
  });

  it('a row with no owner is nobody, and is skipped', () => {
    assert.deepEqual(Feeds.subscribersOf(view(), [{ owner: '' }, { lang: 'fi' }], 'x'), []);
  });

  it('one file per person however many rows they have', () => {
    const subs = Feeds.subscribersOf(view(), [{ owner: 'a@x.test' }, { owner: 'a@x.test' }], 'x');
    assert.equal(subs.length, 1);
  });

  it('a shared feed has no subscriber list at all', () => {
    const v = { calendar: { sources: [] }, feed: true, feedSubscribers: SUBS };
    assert.deepEqual(Feeds.subscribersOf(v, [{ owner: 'a@x.test' }], 'x'), []);
  });

  it('viewColumn lets one table serve several feeds', () => {
    const v = view({ feedSubscribers: Object.assign({ viewColumn: 'feed' }, SUBS) });
    const rows = [{ owner: 'a@x.test', feed: 'x' }, { owner: 'b@x.test', feed: 'other' }];
    assert.deepEqual(Feeds.subscribersOf(v, rows, 'x').map((s) => s.owner), ['a@x.test']);
  });

  // The narrow trigger. forTable answers "whose content changed" and returns nothing for a subscriber
  // table, so without this a language change would republish nothing at all.
  it('a write to the subscriber table names the feed, though forTable does not', () => {
    const views = { x: view() };
    assert.deepEqual(Feeds.forTable(views, 'subs'), []);
    assert.deepEqual(Feeds.forSubscriberTable(views, 'subs'), ['x']);
  });

  it('a shared feed has no subscriber table to write to', () => {
    assert.deepEqual(Feeds.forSubscriberTable({ x: { calendar: {}, feed: true, feedSubscribers: SUBS } }, 'subs'), []);
  });
});

describe('feeds.js — the subscriber table has to be able to hold a secret', () => {
  const base = { columns: { owner: { type: 'owner' }, lang: 'text', url: 'text', fid: 'text', active: 'text' },
                 ownerWritable: ['lang', 'active'], ownerWritableWhile: { active: 'yes' } };
  const view = { calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: '@me' } }] },
                 feed: 'per-person', feedSubscribers: { table: 'subs', langColumn: 'lang', urlColumn: 'url', idColumn: 'fid', activeColumn: 'active' } };
  const errs = (schema, v) => Feeds.configErrors({ x: v || view }, 'x', v || view, schema);
  const withSubs = (o) => ({ events: { columns: {} }, subs: Object.assign({}, base, o) });

  it('accepts a correctly gated table', () => {
    assert.deepEqual(errs(withSubs({})), []);
  });

  it('refuses a per-person feed that names no subscriber table', () => {
    const v = Object.assign({}, view); delete v.feedSubscribers;
    assert.match(errs(withSubs({}), v).join('\n'), /nobody to render for/);
  });

  it('refuses a subscriber table that does not exist', () => {
    assert.match(errs({ events: { columns: {} } }).join('\n'), /is not a table/);
  });

  it('refuses a table whose owner column is not an `owner` column', () => {
    assert.match(errs(withSubs({ columns: { owner: 'text', lang: 'text', url: 'text' } })).join('\n'), /must be an `owner` column/);
  });

  it('refuses a table with no owner column at all', () => {
    assert.match(errs(withSubs({ columns: { lang: 'text', url: 'text' } })).join('\n'), /has no "owner" column/);
  });

  // The one that cannot be recovered from: no ownerWritable is no gate, not a weak one.
  it('refuses a table declaring no ownerWritable', () => {
    const s = withSubs({}); delete s.subs.ownerWritable;
    assert.match(errs(s).join('\n'), /not a weak gate but no gate/);
  });

  it('refuses a subscriber-writable url column', () => {
    assert.match(errs(withSubs({ ownerWritable: ['lang', 'url'] })).join('\n'), /must not include "url"/);
  });

  it('refuses a subscriber-writable owner column', () => {
    assert.match(errs(withSubs({ ownerWritable: ['lang', 'owner'] })).join('\n'), /must not include "owner"/);
  });

  // The opposite direction: a language the subscriber cannot change is a picker that does nothing.
  it('refuses a language column the subscriber may NOT write', () => {
    assert.match(errs(withSubs({ ownerWritable: [] })).join('\n'), /should include "lang"/);
  });

  it('refuses a urlColumn that is not a column', () => {
    const v = Object.assign({}, view, { feedSubscribers: { table: 'subs', urlColumn: 'nope', idColumn: 'fid', activeColumn: 'active' } });
    assert.match(errs(withSubs({}), v).join('\n'), /`feedSubscribers.urlColumn` "nope" is not a column/);
  });

  it('refuses a missing urlColumn — the subscriber could not learn their link', () => {
    const v = Object.assign({}, view, { feedSubscribers: { table: 'subs' } });
    assert.match(errs(withSubs({}), v).join('\n'), /needs a `urlColumn`/);
  });
});

// --- unsubscribing, and the orphan it must not create ------------------------------------------
//
// A subscriber may delete their own self-service row. Their url column is the ONLY record of where
// their file lives, and they cannot blank it themselves (uploading needs full access) — so a plain
// delete leaves a public file frozen on its last snapshot that nothing can ever name again. These
// assert the two halves that prevent it: unsubscribing is a STATE the publisher can see, and the
// schema has to freeze the row so the tombstone survives.
describe('feeds.js — unsubscribing is a state, not a deletion', () => {
  const SUBS = { table: 'subs', langColumn: 'lang', urlColumn: 'url', idColumn: 'fid', activeColumn: 'active' };
  const view = { calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: '@me' } }] },
                 feed: 'per-person', feedSubscribers: SUBS };

  it('an inactive subscriber is still LISTED, because the publisher owes them a blank file', () => {
    const rows = [{ owner: 'a@x.test', url: 'https://s/a.ics', active: 'no' }];
    const subs = Feeds.subscribersOf(view, rows, 'x');
    assert.equal(subs.length, 1);
    assert.equal(subs[0].active, false);
  });

  it('pendingRevocation is the publisher\'s to-do list', () => {
    const rows = [
      { owner: 'a@x.test', url: 'https://s/a.ics', active: 'no' },   // unsubscribed, file still live
      { owner: 'b@x.test', url: 'https://s/b.ics', active: 'yes' },  // still subscribed
      { owner: 'c@x.test', url: '', active: 'no' }                   // already blanked and cleared
    ];
    assert.deepEqual(Feeds.pendingRevocation(view, rows, 'x').map((s) => s.owner), ['a@x.test']);
  });

  // Absent/blank means subscribed: reading a yes as no stops a calendar updating for a reason nobody
  // can see, while reading a no as yes leaves one file the next revocation pass blanks anyway.
  it('an absent or blank flag counts as subscribed', () => {
    [undefined, null, '', 'yes', 'true', 'anything'].forEach((v) => {
      assert.equal(Feeds.isActive(v), true, JSON.stringify(v));
    });
  });

  it('the recognised spellings of "no" all count as unsubscribed', () => {
    ['no', 'No', ' FALSE ', 'off', '0', 'unsubscribed', 'inactive'].forEach((v) => {
      assert.equal(Feeds.isActive(v), false, JSON.stringify(v));
    });
  });

  it('with no activeColumn configured, everyone is subscribed', () => {
    const v = { calendar: view.calendar, feed: 'per-person',
                feedSubscribers: { table: 'subs', urlColumn: 'url', idColumn: 'fid' } };
    assert.equal(Feeds.subscribersOf(v, [{ owner: 'a@x.test', active: 'no' }], 'x')[0].active, true);
  });
});

describe('feeds.js — the schema must freeze a row that unsubscribed', () => {
  const cols = { owner: { type: 'owner' }, lang: 'text', url: 'text', fid: 'text', active: 'text' };
  const view = (subs) => ({ calendar: { sources: [{ table: 'events', dateColumn: 'on', filter: { who: '@me' } }] },
                            feed: 'per-person', feedSubscribers: subs });
  const SUBS = { table: 'subs', langColumn: 'lang', urlColumn: 'url', idColumn: 'fid', activeColumn: 'active' };
  const errs = (tbl, subs) => Feeds.configErrors({ x: view(subs || SUBS) }, 'x', view(subs || SUBS),
                                                 { events: { columns: {} }, subs: tbl });

  const good = { columns: cols, ownerWritable: ['lang', 'active'], ownerWritableWhile: { active: 'yes' } };

  it('accepts a table that freezes on the active column', () => {
    assert.deepEqual(errs(good), []);
  });

  it('refuses a url column with no activeColumn to unsubscribe through', () => {
    const subs = { table: 'subs', langColumn: 'lang', urlColumn: 'url' };
    assert.match(errs(good, subs).join('\n'), /needs an `activeColumn`/);
  });

  // The orphan: without the freeze, the subscriber deletes the row and the file outlives every
  // revocation the feature has.
  it('refuses a table with no ownerWritableWhile at all', () => {
    const t = { columns: cols, ownerWritable: ['lang', 'active'] };
    assert.match(errs(t).join('\n'), /strands their published file/);
  });

  it('refuses an ownerWritableWhile that gates on the wrong column', () => {
    const t = { columns: cols, ownerWritable: ['lang', 'active'], ownerWritableWhile: { lang: 'fi' } };
    assert.match(errs(t).join('\n'), /must gate on "active"/);
  });

  it('refuses an active column the subscriber may not write', () => {
    const t = { columns: cols, ownerWritable: ['lang'], ownerWritableWhile: { active: 'yes' } };
    assert.match(errs(t).join('\n'), /should include "active"/);
  });

  it('refuses an activeColumn that is not a column', () => {
    const subs = { table: 'subs', urlColumn: 'url', idColumn: 'fid', activeColumn: 'nope' };
    assert.match(errs(good, subs).join('\n'), /`feedSubscribers.activeColumn` "nope" is not a column/);
  });
});
