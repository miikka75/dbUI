const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Calendar = require('../../calendar');

// Fixed reference "today" so isToday assertions are deterministic regardless of the run date.
const TODAY = '2026-07-06';

describe('calendar.js — month grid geometry', () => {
  it('builds a 42-cell Monday-start grid bounding the anchor month', () => {
    const cells = Calendar.cellsMonth('2026-07-15', 1, TODAY);
    assert.equal(cells.length, 42);              // 6x7
    assert.equal(cells[0].date, '2026-06-29');   // Monday before Jul 1 (a Wed)
    assert.equal(cells[41].date, '2026-08-09');  // last trailing cell
  });

  it('flags inMonth and isToday correctly', () => {
    const cells = Calendar.cellsMonth('2026-07-15', 1, TODAY);
    assert.equal(cells[0].inMonth, false);       // Jun 29 -> not July
    assert.equal(cells.find(c => c.date === '2026-07-01').inMonth, true);
    assert.equal(cells.find(c => c.date === TODAY).isToday, true);
    assert.equal(cells.find(c => c.date === '2026-07-01').isToday, false);
  });

  it('honors weekStart: Sunday-start shifts the grid one day earlier', () => {
    const cells = Calendar.cellsMonth('2026-07-15', 0, TODAY);
    assert.equal(cells[0].date, '2026-06-28');   // Sunday before Jul 1
  });

  it('defaults the anchor to today', () => {
    const cells = Calendar.cellsMonth(null, 1, TODAY);
    assert.equal(cells.length, 42);
    assert.ok(cells.some(c => c.date === TODAY && c.inMonth));
  });
});

describe('calendar.js — week strip geometry', () => {
  it('builds the 7-day Monday-start strip containing the anchor', () => {
    const cells = Calendar.cellsWeek('2026-07-15', 1, TODAY); // Wed Jul 15
    assert.equal(cells.length, 7);
    assert.equal(cells[0].date, '2026-07-13'); // Monday
    assert.equal(cells[6].date, '2026-07-19'); // Sunday
  });
});

describe('calendar.js — visible window', () => {
  it('month mode spans the whole grid (toExclusive is the day after the last cell)', () => {
    const w = Calendar.windowFor('2026-07-15', 'month', 1, TODAY);
    assert.deepEqual(w, { from: '2026-06-29', toExclusive: '2026-08-10' });
  });

  it('list mode falls back to the month grid', () => {
    assert.deepEqual(
      Calendar.windowFor('2026-07-15', 'list', 1, TODAY),
      Calendar.windowFor('2026-07-15', 'month', 1, TODAY)
    );
  });

  it('week mode spans just the strip', () => {
    const w = Calendar.windowFor('2026-07-15', 'week', 1, TODAY);
    assert.deepEqual(w, { from: '2026-07-13', toExclusive: '2026-07-20' });
  });
});

describe('calendar.js — source resolution', () => {
  const VIEWS = {
    single: { calendar: { source: 't', dateColumn: 'd', titleColumns: ['x'] } },
    multi: { calendar: { sources: [{ table: 't2', dateColumn: 'd2' }] } },
    rota: { calendar: { rotationSources: [{ view: 'r', label: 'Duty' }] } },
    plain: { calendar: {} },
    notcal: { sources: ['t'] }
  };

  it('expands single-source `source` sugar into a one-element spec list', () => {
    const s = Calendar.sources(VIEWS, 'single');
    assert.equal(s.length, 1);
    assert.equal(s[0].table, 't');
    assert.equal(s[0].dateColumn, 'd');
    assert.deepEqual(s[0].titleColumns, ['x']);
  });

  it('passes an explicit sources array through', () => {
    const s = Calendar.sources(VIEWS, 'multi');
    assert.equal(s.length, 1);
    assert.equal(s[0].table, 't2');
  });

  it('returns [] for missing or non-calendar views', () => {
    assert.deepEqual(Calendar.sources(VIEWS, 'missing'), []);
    assert.deepEqual(Calendar.sources(VIEWS, 'notcal'), []);
  });

  it('rotationSources reads calendar.rotationSources or []', () => {
    assert.equal(Calendar.rotationSources(VIEWS, 'rota')[0].view, 'r');
    assert.deepEqual(Calendar.rotationSources(VIEWS, 'plain'), []);
    assert.deepEqual(Calendar.rotationSources(VIEWS, 'missing'), []);
  });
});

describe('calendar.js — primitives', () => {
  it('hashColor is deterministic and returns a palette hex', () => {
    assert.equal(Calendar.hashColor('team-a'), Calendar.hashColor('team-a'));
    assert.match(Calendar.hashColor('team-a'), /^#[0-9a-f]{6}$/);
  });

  // The palette has 10 entries and the old mixer was `h*31 + c`. 31 % 10 === 1, so the multiply was the
  // identity modulo the palette length and the hash collapsed to (sum of char codes) % 10 — Ann, Bob,
  // Cara and Dan all came out the same color on a board that claims to be colored by person.
  it('hashColor does not collapse to a character sum (the h*31 %% 10 degeneracy)', () => {
    // Anagrams have an identical character sum, so the old hash could not tell them apart.
    assert.notEqual(Calendar.hashColor('abc'), Calendar.hashColor('cba'),
      'an anagram must not force the same color — the mixer is order-blind again');
    // Neither could it separate strings whose sums differ by a multiple of ten.
    assert.notEqual(Calendar.hashColor('A'), Calendar.hashColor('K'));   // 65 vs 75
  });

  it('hashColor spreads keys across the palette instead of piling them up', () => {
    // A big enough sample that this is statistics, not luck: 3-char keys over the alphabet.
    const keys = [];
    for (const a of 'abcdefghijklmnopqrstuvwxyz') for (const b of 'aeiou') keys.push(a + b + 'n');
    const slots = new Set();
    for (let i = 0; Calendar.paletteAt(i) !== Calendar.paletteAt(0) || i === 0; i++) slots.add(Calendar.paletteAt(i));
    const buckets = {};
    for (const k of keys) (buckets[Calendar.hashColor(k)] ||= []).push(k);
    const mean = keys.length / slots.size;
    const largest = Math.max(...Object.values(buckets).map((a) => a.length));
    assert.equal(Object.keys(buckets).length, slots.size, 'every palette slot should get used');
    // The old hash collapsed to (char sum) % len, which piles keys onto a few slots. Two the mean is a
    // generous ceiling for a real hash and far under what the degenerate one produced.
    assert.ok(largest <= mean * 2, `largest bucket ${largest} exceeds 2x the mean ${mean.toFixed(1)}`);
  });

  // A hash into a FIXED palette cannot promise distinct colors (10 buckets, birthday paradox: ~70%
  // collision at 5 values), so a caller with a stable ordering indexes the palette instead. That is what
  // a board colored by a list-backed column does.
  it('paletteAt gives distinct colors for every slot, and wraps after', () => {
    const slots = [];
    for (let i = 0; Calendar.paletteAt(i) !== Calendar.paletteAt(0) || i === 0; i++) slots.push(Calendar.paletteAt(i));
    assert.equal(new Set(slots).size, slots.length, 'every slot before the wrap must differ');
    assert.ok(slots.length >= 8, 'at least 8 categorical slots, got ' + slots.length);
    assert.equal(Calendar.paletteAt(slots.length), Calendar.paletteAt(0));   // wraps
    assert.equal(Calendar.paletteAt(-1), Calendar.paletteAt(slots.length - 1)); // negative-safe
    for (const c of slots) assert.match(c, /^#[0-9a-f]{6}$/);
  });

  // Dark is its own stepping of the same hues, not an automatic flip: two of the old colors sat outside
  // the lightness band on the dark surface, which is the whole reason there are two sets.
  it('the dark palette is a distinct, complete stepping', () => {
    const light = Array.from({ length: 8 }, (_, i) => Calendar.paletteAt(i));
    const dark = Array.from({ length: 8 }, (_, i) => Calendar.paletteAt(i, 'dark'));
    assert.equal(new Set(dark).size, 8, 'dark slots must be distinct too');
    assert.ok(dark.filter((c, i) => c !== light[i]).length >= 6, 'dark must be re-stepped, not the same list');
    assert.equal(Calendar.hashColor('x'), Calendar.hashColor('x', 'light'), 'light is the default mode');
  });

  // The palette was replaced because the previous one FAILED these gates: #8d6e63 was under the chroma
  // floor (it read gray) and gave CVD dE 4.6 against #ec407a, below the floor of 6. Pin the shipped
  // values so a future edit cannot quietly reintroduce a failing set — re-run the dataviz validator
  // (scripts/validate_palette.js) against both modes before changing them.
  it('ships the validated palette (both modes)', () => {
    assert.deepEqual(Array.from({ length: 8 }, (_, i) => Calendar.paletteAt(i)),
      ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']);
    assert.deepEqual(Array.from({ length: 8 }, (_, i) => Calendar.paletteAt(i, 'dark')),
      ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']);
    // the colors that failed the gates must not come back
    const all = [...Array(8)].flatMap((_, i) => [Calendar.paletteAt(i), Calendar.paletteAt(i, 'dark')]);
    for (const gone of ['#8d6e63', '#ec407a', '#66bb6a', '#ef6c00']) assert.ok(!all.includes(gone), gone + ' failed a gate and must stay out');
  });

  it('fmtDate formats a Date as local YYYY-MM-DD', () => {
    assert.equal(Calendar.fmtDate(new Date(2026, 6, 6)), '2026-07-06'); // month is 0-based
    assert.equal(Calendar.fmtDate(new Date(2026, 0, 3)), '2026-01-03'); // zero-padded
  });
});
