// events.test.js — the calendar EVENT MODEL, at unit tier.
//
// This is the tier that did not exist while the model lived on the Vue root, and its absence is why
// faf4d67 shipped: the rotation OVERLAY kept its own copy of how a slot and its value resolve, the
// `rosterRef` fix reached only the matrix, and the deployed chores example showed translated chore
// names in one place and raw stored strings in the other. Nothing failed — the overlay renders
// something either way. The last describe() block below is that bug, asserted against the two
// renderers agreeing rather than against a captured string.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Events = require('../../events');
const Rotation = require('../../rotation');
const Calendar = require('../../calendar');

// A ctx with the root's real answers stubbed to the identity-ish defaults. Tests override what they
// are about. `reach` is the read gate; `strings` backs t/tOr; `display` stands in for displayValue.
function ctx(over) {
  const o = over || {};
  const strings = o.strings || {};
  const base = {
    views: o.views || {},
    dataCache: o.dataCache || {},
    today: () => o.today || '2026-03-01',
    toDateStr: (v) => { if (!v) return ''; const s = String(v); return s.length === 10 ? s : Calendar.fmtDate(new Date(s)); },
    t: (k) => strings[k] || k,
    tOr: (k, fb) => strings[k] || fb,
    displayValue: o.displayValue || ((c, v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v))),
    canReachTable: o.canReachTable || (() => true),
    hashColor: () => '#123456',
    resolveMeTokens: (f) => f,
    rotation: Object.assign({
      rangeFor: () => ({}),
      anchorFor: () => null,
      rotateEveryFor: () => undefined,
      mineOnlySlot: () => null,
      slotsFor: (rv) => Rotation.rosterGroups(rv, base.dataCache).slots,
      slotLabel: (n, slot) => slot,
      valueColFor: () => ''
    }, o.rotation || {})
  };
  return base;
}

describe('events.js — rows from a calendar\'s own sources', () => {
  const views = { cal: { calendar: { sources: [{ table: 'tasks', dateColumn: 'due', titleColumns: ['title'] }] } } };
  const dataCache = { tasks: [
    { id: 'a', due: '2026-03-04', title: 'Pay rent' },
    { id: 'b', due: '2026-03-04', title: 'Call plumber' },
    { id: 'c', due: '', title: 'Someday' }
  ] };

  it('buckets rows by their dateColumn', () => {
    const ev = Events.build('cal', null, ctx({ views, dataCache }));
    assert.deepEqual(ev['2026-03-04'].map((e) => e.title), ['Call plumber', 'Pay rent']);   // sorted
    assert.equal(ev['2026-03-04'][0].table, 'tasks');
    assert.equal(ev['2026-03-04'][0].dateCol, 'due');
  });

  it('keeps an undated row under __undated__ rather than dropping it', () => {
    const ev = Events.build('cal', null, ctx({ views, dataCache }));
    assert.deepEqual(ev['__undated__'].map((e) => e.title), ['Someday']);
  });

  it('fails CLOSED per source: an unreachable table contributes nothing', () => {
    const ev = Events.build('cal', null, ctx({ views, dataCache, canReachTable: () => false }));
    assert.deepEqual(ev, {});
  });

  it('a row whose titleColumns render empty falls back to the source tag', () => {
    const v = { cal: { calendar: { sources: [{ table: 'tasks', dateColumn: 'due', titleColumns: ['nope'], label: 'Chores' }] } } };
    const ev = Events.build('cal', null, ctx({ views: v, dataCache }));
    assert.equal(ev['2026-03-04'][0].title, 'Chores');
  });

  it('the tag is the source label, else the table\'s own tab.* translation', () => {
    const ev = Events.build('cal', null, ctx({ views, dataCache, strings: { 'tab.tasks': 'Tehtävät' } }));
    assert.equal(ev['2026-03-04'][0].label, 'Tehtävät');
  });

  it('a source missing table or dateColumn is skipped, not thrown on', () => {
    const v = { cal: { calendar: { sources: [{ table: 'tasks' }, { dateColumn: 'due' }] } } };
    assert.deepEqual(Events.build('cal', null, ctx({ views: v, dataCache })), {});
  });

  it('the calendar being drawn is what obscures names — its own config, not the page it sits on', () => {
    // displayValue receives the calendar's view config as its 4th argument; an EMBEDDED calendar must
    // pass its own, or a doc page's config would decide what the embed masks.
    let seen = null;
    Events.build('cal', null, ctx({ views, dataCache, displayValue: (c, v, ns, cfg) => { seen = cfg; return String(v); } }));
    assert.equal(seen, views.cal);
  });
});

describe('events.js — the rotation overlay', () => {
  // A rosterRef rotation: slots are the DISTINCT VALUES of `chore` in the lookup, not schema columns.
  const dataCache = { ref_chores: [
    { id: '1', chore: 'dishes', person: 'Ann', position: 1 },
    { id: '2', chore: 'dishes', person: 'Bob', position: 2 },
    { id: '3', chore: 'bins', person: 'Cal', position: 3 }
  ] };
  const views = {
    cal: { calendar: { sources: [], rotationSources: [{ view: 'duties' }] } },
    duties: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person', interval: 'weekly', anchorDate: '2026-03-01' } }
  };
  const win = { from: '2026-03-01', toExclusive: '2026-03-29' };

  it('generates duty events inside the window', () => {
    const ev = Events.build('cal', win, ctx({ views, dataCache }));
    const days = Object.keys(ev);
    assert.ok(days.length > 0, 'the overlay produced events');
    days.forEach((d) => { assert.ok(d >= win.from && d < win.toExclusive, d + ' is inside the window'); });
    assert.ok(ev[days[0]].every((e) => e.readOnly === true && e.table === null),
      'generated duties are read-only and belong to no table — there is no row to edit');
  });

  it('is skipped entirely without a window (unbounded generation is what the window prevents)', () => {
    assert.deepEqual(Events.build('cal', null, ctx({ views, dataCache })), {});
  });

  it('fails CLOSED on per-roster access: no reachable roster, no events', () => {
    const ev = Events.build('cal', win, ctx({ views, dataCache, canReachTable: (t) => t !== 'ref_chores' }));
    assert.deepEqual(ev, {});
  });

  it('honours the rotation\'s own mineOnly — an overlay may not widen what the view narrows', () => {
    const all = Events.build('cal', win, ctx({ views, dataCache }));
    const mine = Events.build('cal', win, ctx({ views, dataCache, rotation: { mineOnlySlot: () => 'bins' } }));
    const slotsOf = (ev) => new Set(Object.values(ev).flat().map((e) => e.id.split(':')[2]));
    assert.deepEqual([...slotsOf(all)].sort(), ['bins', 'dishes']);
    assert.deepEqual([...slotsOf(mine)], ['bins']);
  });

  it('a rotationSource naming a view that is missing or is not a rotation is skipped', () => {
    const v = { cal: { calendar: { sources: [], rotationSources: [{ view: 'gone' }, { view: 'cal' }] } } };
    assert.deepEqual(Events.build('cal', win, ctx({ views: v, dataCache })), {});
  });
});

// The regression. Both screens read the same duties; the question is whether they render them the same.
describe('events.js — the overlay renders a rosterRef duty the way the matrix does (faf4d67)', () => {
  const dataCache = { ref_chores: [
    { id: '1', chore: 'dishes', person: 'Ann', position: 1 },
    { id: '2', chore: 'bins', person: 'Bob', position: 2 }
  ] };
  const views = {
    cal: { calendar: { sources: [], rotationSources: [{ view: 'duties' }] } },
    duties: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person', interval: 'weekly', anchorDate: '2026-03-01' } }
  };
  const win = { from: '2026-03-01', toExclusive: '2026-03-15' };

  // What the MATRIX does: a rosterRef slot is a value of the lookup, so its heading comes from that
  // table's `list.<table>.<value>` namespace (never `field.<slot>`), and its cells resolve in the
  // namespace of the roster's valueCol.
  const strings = { 'list.ref_chores.dishes': 'Tiskit', 'list.ref_chores.bins': 'Roskat' };
  const rotation = {
    slotLabel: (n, slot) => strings['list.ref_chores.' + slot] || slot,
    valueColFor: () => 'person'
  };
  const displayValue = (col, val, ns) => (ns === 'person' ? 'Household:' : 'RAW:') + (Array.isArray(val) ? val.join(', ') : val);

  it('uses the matrix\'s slot heading, not the raw slot name', () => {
    const ev = Events.build('cal', win, ctx({ views, dataCache, strings, rotation, displayValue }));
    const titles = Object.values(ev).flat().map((e) => e.title);
    assert.ok(titles.some((t) => t.startsWith('Tiskit: ')), 'the translated slot label reached the overlay: ' + titles.join(' | '));
    assert.ok(!titles.some((t) => t.startsWith('dishes: ')), 'the raw slot name did not: ' + titles.join(' | '));
  });

  it('resolves the cell in the roster valueCol\'s namespace, not in no namespace at all', () => {
    const ev = Events.build('cal', win, ctx({ views, dataCache, strings, rotation, displayValue }));
    const titles = Object.values(ev).flat().map((e) => e.title);
    assert.ok(titles.every((t) => t.includes('Household:')), 'every cell went through the valueCol namespace');
    assert.ok(!titles.some((t) => t.includes('RAW:')), 'no cell was rendered with an empty namespace: ' + titles.join(' | '));
  });

  it('the two renderers agree cell for cell on the same duties', () => {
    const c = ctx({ views, dataCache, strings, rotation, displayValue });
    const ev = Events.build('cal', win, c);
    // The matrix, built from the same rows through the same resolvers.
    const rows = Rotation.buildRotationViewRows(views.duties, dataCache, c.today(), null, { from: win.from, periods: 2 }, undefined);
    const slots = c.rotation.slotsFor(views.duties.rotation);
    const fromMatrix = [];
    rows.forEach((r) => {
      if (r._period < win.from || r._period >= win.toExclusive) return;
      slots.forEach((slot) => {
        const ppl = r[slot]; if (!(ppl && ppl.length)) return;
        fromMatrix.push(r._period + ' ' + c.rotation.slotLabel('duties', slot) + ': ' +
                        c.displayValue(slot, ppl, c.rotation.valueColFor('duties', slot), views.duties));
      });
    });
    const fromOverlay = Object.keys(ev).sort().flatMap((d) => ev[d].map((e) => d + ' ' + e.title));
    assert.deepEqual(fromOverlay.sort(), fromMatrix.sort());
  });
});

describe('events.js — periodsToCover', () => {
  it('0 when the window ends before the rotation begins', () => {
    assert.equal(Events.periodsToCover('2026-06-01', '2026-03-01', 'weekly'), 0);
  });

  it('covers the span plus the partial periods at each end', () => {
    assert.equal(Events.periodsToCover('2026-03-01', '2026-03-29', 'weekly'), 6);   // 4 whole weeks + 2
  });
});
