// bishopric-calendar.test.js — the bishopric example ships ONE calendar, as a personal feed with no screen.
//
// It used to ship two shared ones. They were removed once a calendar could be defined in the database
// instead: a calendar every member sees alike is a saved question over tables that already exist, so
// putting one in the schema document makes the example carry a decision that belongs to whoever
// installs it.
//
// A PER-PERSON calendar is different, and is why one is back. It cannot be built in Settings — it needs a
// subscriber table with owner gating and privateRoster, which only a schema can declare — and it is the
// one calendar a bishopric member wants from this data: the interviews, callings, reminders and talks
// that are theirs, in their own phone calendar. It is a DECLARATION, not a screen: out of the nav, and
// subscribed to under Settings -> My calendar feeds. So this checks:
//
//   1. the only calendar is that per-person one, it passes the feed guards, and nothing navigates to it;
//   2. no shipped example mints a world-readable URL on install;
//   3. its dated tables are still EXPORTABLE as a database-defined calendar, driven through the real
//      modules (SchemaNormalize -> Events.build -> Ics.build).
//
// (3) matters because it breaks silently — a renamed column leaves the runtime path valid and
// permanently empty.
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

const colsOf = (t) => (schema.tables[t].columns || []).reduce((m, c) => (m[c.name] = c, m), {});
const dateColsOf = (t) => (schema.tables[t].columns || []).filter((c) => c.type === 'date').map((c) => c.name);

describe('bishopric example — one calendar, and it is per-person', () => {
  it('declares exactly one calendar view: personal_calendar, published per person', () => {
    const cals = Object.keys(VIEWS).filter((n) => VIEWS[n].calendar);
    assert.deepEqual(cals, ['personal_calendar']);
    assert.equal(Feeds.isPerPerson(VIEWS.personal_calendar), true);
  });

  // The guards that stop one member's file carrying another's rows: @me on every source, a private,
  // owner-gated subscriber table. Asserted against the shipped schema rather than a fixture.
  it('passes every per-person feed guard', () => {
    assert.deepEqual(Feeds.configErrors(VIEWS, 'personal_calendar', VIEWS.personal_calendar, schema.tables), []);
  });

  // A feed, not a screen: members subscribe in Settings, so the calendar has no nav entry of its own.
  it('and nothing in the nav points at a calendar', () => {
    const inNav = [];
    (function walk(items) { (items || []).forEach((i) => { if (i.view) inNav.push(i.view); walk(i.items); }); })(schema.nav.items);
    assert.deepEqual(inNav.filter((n) => !VIEWS[n]), [], 'every nav entry names a view that exists');
    assert.deepEqual(inNav.filter((n) => VIEWS[n] && VIEWS[n].calendar), []);
  });

  // A SHARED feed publishes the moment a full-access client boots, so shipping one would mint a
  // world-readable URL on install. A per-person feed publishes only for people who subscribed, so it
  // mints nothing until someone opts in — which holds only while the example's sample data carries no
  // subscription rows, and that is asserted too.
  it('publishes nothing — no shipped example mints a world-readable URL on install', () => {
    ['bishopric', 'chores', 'demo'].forEach((name) => {
      const f = path.join(__dirname, '..', '..', 'examples', name + '-schema.json');
      if (!fs.existsSync(f)) return;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const views = SchemaNormalize.flattenViews((d.schema || d).views);
      const feeds = Feeds.names(views);
      assert.deepEqual(feeds.filter((n) => !Feeds.isPerPerson(views[n])), [], name + ': a shared feed');
      const dataFile = path.join(__dirname, '..', '..', 'examples', name + '-data.json');
      const data = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')).tables || {} : {};
      feeds.forEach((n) => {
        const t = Feeds.subscriberTableOf(views[n]);
        assert.deepEqual(data[t] || [], [], name + ': sample subscriptions to ' + n);
      });
    });
  });
});

describe('bishopric example — its dated tables are still exportable at runtime', () => {
  // The tables someone would actually put on a calendar, and the date column each one means. Named
  // rather than derived: admin_interviews has TWO date columns (`meeting` and `expires`) and only one
  // of them is when the thing happens — which is the whole reason a calendar has to be declared
  // somewhere rather than inferred from a table.
  const CANDIDATES = [
    ['meeting_agenda', 'date', ['theme']],
    ['duty_usher_dates', 'date', []],
    ['admin_interviews', 'meeting', ['person', 'topic']],
    ['admin_reminders', 'date', ['item']]
  ];

  it('every table Settings would offer still has the columns a calendar needs', () => {
    CANDIDATES.forEach(function(entry) {
      var table = entry[0], dateCol = entry[1], titles = entry[2];
      assert.ok(schema.tables[table], table + ' exists');
      const cs = colsOf(table);
      assert.ok(cs[dateCol], table + '.' + dateCol + ' exists');
      assert.equal(cs[dateCol].type, 'date', table + '.' + dateCol + ' is a date column');
      assert.ok(dateColsOf(table).includes(dateCol));
      titles.forEach((c) => assert.ok(cs[c], table + '.' + c + ' exists'));
    });
  });

  it('a calendar built the way Settings builds one produces an .ics from this schema', () => {
    // Exactly the shape saveUserCalendar stores and _applyUserCalendars merges into VIEWS.
    const runtime = Object.assign({}, VIEWS, {
      ushers: { name: 'ushers', kind: 'calendar', userDefined: true,
                calendar: { sources: [{ table: 'duty_usher_dates', dateColumn: 'date', titleColumns: [] }] } }
    });
    const dataCache = { duty_usher_dates: [{ id: 'u1', date: '2026-09-13' }, { id: 'u2', date: '2026-09-20' }] };
    const ctx = {
      views: runtime, dataCache, today: () => '2026-09-06',
      t: (k) => k, tOr: (k, fb) => fb,
      displayValue: (c, v) => String(v == null ? '' : v),
      canReachTable: () => true, hashColor: () => '#000', resolveMeTokens: (f) => f,
      rotation: { rangeFor: () => ({}), anchorFor: () => null, rotateEveryFor: () => undefined,
                  mineOnlySlot: () => null, slotsFor: () => [], slotLabel: (n, s) => s, valueColFor: () => '' }
    };
    const ev = Events.build('ushers', { from: '2026-06-06', toExclusive: '2027-09-06' }, ctx);
    assert.deepEqual(Object.keys(ev).sort(), ['2026-09-13', '2026-09-20']);

    const out = Ics.build(ev, { name: 'Ushers', domain: 'test', dtstamp: '20260906T000000Z' });
    assert.ok(out.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.equal((out.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.ok(out.includes('DTSTART;VALUE=DATE:20260913'));
  });
});
