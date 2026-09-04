// bishopric-calendar.test.js — the shipped bishopric calendar, driven through the real export path.
//
// The other tests over the shipped examples check their SHAPE: that they parse, that they are written
// in the current schema version, that their vocabulary is closed. None of them asks whether a view
// actually produces anything, so a calendar could name a column that had been renamed out from under it
// and every one of them would still pass while the screen rendered empty.
//
// This drives the real file through the real modules — SchemaNormalize -> Events.build -> Ics.build —
// so the shipped config is checked against the code that consumes it.
//
// It also pins the two things about this particular calendar that are decisions rather than details:
// which sources it draws from, and that it is NOT published.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SchemaNormalize = require('../../schema-normalize');
const Events = require('../../events');
const Ics = require('../../ics');
const Feeds = require('../../feeds');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'bishopric-schema.json'), 'utf8'));
const schema = doc.schema;
const VIEWS = SchemaNormalize.flattenViews(schema.views);
const CAL = 'meeting_calendar';

// Two Sundays, as the shipped agenda table holds them.
const dataCache = {
  meeting_agenda: [
    { id: 'm1', date: '2026-03-01', theme: 'Faith', presiding: 'bishop' },
    { id: 'm2', date: '2026-03-08', theme: 'Service', presiding: 'counselor1' }
  ]
};
const ctx = {
  views: VIEWS, dataCache,
  today: () => '2026-03-01',
  t: (k) => k, tOr: (k, fb) => fb,
  displayValue: (c, v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v)),
  canReachTable: () => true, hashColor: () => '#000', resolveMeTokens: (f) => f,
  rotation: {
    rangeFor: () => ({}), anchorFor: () => null, rotateEveryFor: () => undefined,
    mineOnlySlot: () => null, slotsFor: () => [], slotLabel: (n, s) => s, valueColFor: () => ''
  }
};
const WIN = { from: '2026-02-01', toExclusive: '2026-04-01' };

describe('bishopric example — the calendar is wired to columns that exist', () => {
  it('is a calendar view, in the nav', () => {
    assert.equal(SchemaNormalize.viewKind(VIEWS[CAL]), 'calendar');
    const inNav = [];
    (function walk(items) { (items || []).forEach((i) => { if (i.view) inNav.push(i.view); walk(i.items); }); })(schema.nav.items);
    assert.ok(inNav.includes(CAL), 'reachable from the sidebar');
  });

  it('every source names a real table, a real DATE column and real title columns', () => {
    // The failure this catches: a renamed column leaves the calendar valid JSON and permanently empty.
    const cols = (t) => (schema.tables[t].columns || []).reduce((m, c) => (m[c.name] = c, m), {});
    VIEWS[CAL].calendar.sources.forEach((s) => {
      assert.ok(schema.tables[s.table], s.table + ' exists');
      const cs = cols(s.table);
      assert.ok(cs[s.dateColumn], s.table + '.' + s.dateColumn + ' exists');
      assert.equal(cs[s.dateColumn].type, 'date', s.table + '.' + s.dateColumn + ' is a date');
      (s.titleColumns || []).forEach((c) => assert.ok(cs[c], s.table + '.' + c + ' exists'));
    });
  });

  it('produces events, and serializes to a calendar a client would accept', () => {
    const ev = Events.build(CAL, WIN, ctx);
    assert.deepEqual(Object.keys(ev).sort(), ['2026-03-01', '2026-03-08']);
    assert.equal(ev['2026-03-01'][0].title, 'Faith');

    const doc = Ics.build(ev, { name: 'Bishopric', domain: 'test', dtstamp: '20260301T000000Z' });
    assert.ok(doc.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.equal((doc.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.ok(doc.includes('SUMMARY:Faith'));
    assert.ok(doc.includes('DTSTART;VALUE=DATE:20260301'));
  });
});

describe('bishopric example — what the calendar deliberately leaves out', () => {
  it('draws ONLY from meeting_agenda', () => {
    assert.deepEqual(VIEWS[CAL].calendar.sources.map((s) => s.table), ['meeting_agenda']);
  });

  it('carries nothing confidential, because a feed would serve it to anyone with the URL', () => {
    // These tables are dated and would each look reasonable on a calendar. They are excluded on
    // purpose: interviews name a person and a topic, reminders name who owes what, and the duty
    // rotations carry obscureNames precisely because their names are not for everyone. This example is
    // one switch away from being published, and that switch must not be the moment anyone finds out.
    const tables = VIEWS[CAL].calendar.sources.map((s) => s.table);
    ['admin_interviews', 'admin_reminders', 'admin_callings', 'duty_usher_dates', 'duty_interpreters']
      .forEach((t) => assert.ok(!tables.includes(t), t + ' is not a calendar source'));
  });

  it('is NOT published — installing an example must not mint a world-readable URL', () => {
    // Turning it on is one field in the schema editor. Doing it FOR someone, on install, is a privacy
    // decision that is not the example's to make.
    assert.equal(Feeds.isFeed(VIEWS[CAL]), false);
    assert.deepEqual(Feeds.names(VIEWS), []);
  });

  it('no OTHER shipped view is published either', () => {
    ['chores', 'demo'].forEach((name) => {
      const f = path.join(__dirname, '..', '..', 'examples', name + '-schema.json');
      if (!fs.existsSync(f)) return;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const v = SchemaNormalize.flattenViews((d.schema || d).views);
      assert.deepEqual(Feeds.names(v), [], name + ' ships no feed');
    });
  });
});
