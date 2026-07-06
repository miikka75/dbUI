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

  it('fmtDate formats a Date as local YYYY-MM-DD', () => {
    assert.equal(Calendar.fmtDate(new Date(2026, 6, 6)), '2026-07-06'); // month is 0-based
    assert.equal(Calendar.fmtDate(new Date(2026, 0, 3)), '2026-01-03'); // zero-padded
  });
});
