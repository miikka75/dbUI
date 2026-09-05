// bishopric-calendar.test.js — the bishopric example ships NO calendar view, and does not need one.
//
// It used to ship two. They were removed once a calendar could be defined in the database instead: a
// calendar is a saved question over tables that already exist, so putting one in the schema document
// makes the example carry a decision that belongs to whoever installs it.
//
// What has to stay true is that removing them cost nothing, so this checks both halves:
//
//   1. the schema really is minimal — no calendar view, nothing in the nav pointing at one;
//   2. its dated tables are still EXPORTABLE, by building a calendar the way Settings does and driving
//      it through the real modules (SchemaNormalize -> Events.build -> Ics.build).
//
// (2) is the half worth having. "No calendar in the schema" stays true by accident; "you can still get
// an .ics out of this data" is the property actually being relied on, and it breaks silently — a
// renamed column leaves the runtime path valid and permanently empty.
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

describe('bishopric example — ships no calendar, and no feed', () => {
  it('declares no calendar view', () => {
    const cals = Object.keys(VIEWS).filter((n) => VIEWS[n].calendar);
    assert.deepEqual(cals, [], 'a calendar in the schema is a decision the installer should make');
  });

  it('and nothing in the nav points at one', () => {
    const inNav = [];
    (function walk(items) { (items || []).forEach((i) => { if (i.view) inNav.push(i.view); walk(i.items); }); })(schema.nav.items);
    assert.deepEqual(inNav.filter((n) => !VIEWS[n]), [], 'every nav entry names a view that exists');
    assert.deepEqual(inNav.filter((n) => VIEWS[n] && VIEWS[n].calendar), []);
  });

  it('publishes nothing — no shipped example mints a world-readable URL on install', () => {
    assert.deepEqual(Feeds.names(VIEWS), []);
    ['chores', 'demo'].forEach((name) => {
      const f = path.join(__dirname, '..', '..', 'examples', name + '-schema.json');
      if (!fs.existsSync(f)) return;
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.deepEqual(Feeds.names(SchemaNormalize.flattenViews((d.schema || d).views)), [], name);
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
