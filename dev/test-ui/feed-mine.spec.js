// A member's own calendar as a per-person feed: their booked classes (narrowed by `owner: "@me"`, timed,
// with the class's length read through a reference path) and nothing from a source marked `feed: false`.
const { test, expect } = require('./server-fixture');

const ADMIN = { 'X-User': 'org@x' };
const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    ref_types: { isLookup: true, hierarchy: false, columns: [{ name: 'name', type: 'text' }, { name: 'minutes', type: 'number' }] },
    classes: { columns: [{ name: 'starts_at', type: 'datetime' }, { name: 'type', type: 'ref', table: 'ref_types', valueCol: 'name' }] },
    bookings: { ownerWritable: ['class', 'booking'], columns: [{ name: 'owner', type: 'owner' }, { name: 'class', type: 'ref', table: 'classes', valueCol: 'id' }, { name: 'booking', type: 'text' },
      { name: 'class_start', type: 'datetime', computed: { lookup: { table: 'classes', match: 'class', on: 'id', field: 'starts_at' } } }] },
    visits: { ownerWritable: ['on'], columns: [{ name: 'owner', type: 'owner' }, { name: 'on', type: 'date' }] },
    subs: { privateRoster: true, ownerWritable: ['lang', 'active'], ownerWritableWhile: { active: 'yes' },
      columns: [{ name: 'owner', type: 'owner' }, { name: 'lang', type: 'text' }, { name: 'active', type: 'text' }, { name: 'fid', type: 'text' }, { name: 'url', type: 'text' }] }
  },
  views: [
    { name: 'mycal', kind: 'calendar', feed: 'per-person', feedSubscribers: { table: 'subs', langColumn: 'lang', activeColumn: 'active', idColumn: 'fid', urlColumn: 'url' },
      calendar: { sources: [
        { table: 'bookings', dateColumn: 'class_start', titleColumns: ['class'], label: 'Class', filter: { booking: 'booked', owner: '@me' }, durationColumn: 'class.type.minutes' },
        { table: 'visits', dateColumn: 'on', label: 'Visit', feed: false }
      ] } },
    { name: 'page', kind: 'page', markdown: '{{view:mycal}}' },
    { name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'classes', dateColumn: 'starts_at', titleColumns: ['type'] }], export: false } }
  ],
  nav: { items: [{ view: 'page' }, { view: 'timetable' }] }
};

test('per-person feed of my booked classes: Subscribe on the embedded calendar, timed events, left-out sources stay out', async ({ page, browser }) => {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'viewer', user: 'ann@x', tables: { classes: 'r', ref_types: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  const put = (tableId, data) => page.request.post('/api/putRow', { data: { tableId, tab: 'active', data }, headers: ADMIN });
  await put('ref_types', { id: 't1', name: 'Spinning', minutes: 45 });
  await put('classes', { id: 'c1', starts_at: '2026-10-20T04:00:00.000Z', type: 'Spinning' });
  await put('classes', { id: 'c2', starts_at: '2026-10-21T04:00:00.000Z', type: 'Spinning' });
  await put('bookings', { id: 'b1', owner: 'ann@x', class: 'c1', booking: 'booked' });
  await put('bookings', { id: 'b2', owner: 'bob@x', class: 'c2', booking: 'booked' });
  await put('visits', { id: 'v1', owner: 'ann@x', on: '2026-10-19' });

  // The member: Subscribe sits on the calendar inside the page; the timetable has no download.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'ann@x'); });
  await p.goto('/');
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await p.evaluate(() => appInstance.selectTab('page'));
  await expect(p.locator('[data-testid="cal-subscribe-btn"]')).toBeVisible();
  await p.evaluate(() => appInstance.selectTab('timetable'));
  await expect(p.locator('[data-testid="cal-view"]')).toBeVisible();
  await expect(p.locator('[data-testid="cal-export-ics"]')).toHaveCount(0);
  await ctx.close();

  // The publisher renders Ann's file.
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  const ics = await page.evaluate(async () => {
    await appInstance._awaitViewData('mycal');
    return appInstance._renderIcs('mycal', appInstance.calendarCoverFor('mycal'), null, appInstance.identityFor('ann@x'), true);
  });
  expect(ics).toContain('DTSTART:20261020T040000Z');
  expect(ics).toContain('DTEND:20261020T044500Z');
  expect(ics).not.toContain('20261021');       // Bob's class
  expect(ics).not.toContain('Visit');          // feed: false
  expect(await page.evaluate(() => validateSchema())).toEqual([]);
});
