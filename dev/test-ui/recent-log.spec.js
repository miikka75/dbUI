// A log that shows the recent past: a rolling date filter (`@today-6`), newest first (`defaultSortDesc`),
// the latest N (`limit`), and a new row dated today (`defaultFrom: "@today"`) so it stays in view.
const { test, expect } = require('./server-fixture');

const ymd = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); };
const SCHEMA = {
  defaultLanguage: 'en',
  tables: { logs: { ownerWritable: ['done_on', 'what'], columns: [{ name: 'owner', type: 'owner' }, { name: 'done_on', type: 'date', defaultFrom: '@today' }, { name: 'what', type: 'text' }] } },
  views: [
    { name: 'recent', kind: 'data', sources: ['logs'], mode: 'union', layout: 'table', columns: ['done_on', 'what'], defaultSort: 'done_on', defaultSortDesc: true, filter: { done_on: { gte: '@today-6' } } },
    { name: 'latest', kind: 'data', sources: ['logs'], mode: 'union', layout: 'table', columns: ['done_on', 'what'], defaultSort: 'done_on', defaultSortDesc: true, limit: 2 },
    { name: 'page', kind: 'page', markdown: '{{view:recent}}' }
  ],
  nav: { items: [{ view: 'page' }, { view: 'recent' }, { view: 'latest' }] }
};
const ADMIN = { 'X-User': 'org@x' };

test('a recent log: the last 7 days newest first, the latest N, and a new row dated today', async ({ page }) => {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  for (const [id, n] of [['a', -3], ['b', 0], ['c', -10]]) {
    await page.request.post('/api/putRow', { data: { tableId: 'logs', tab: 'active', data: { id, owner: 'org@x', done_on: ymd(n), what: 'w' + n } }, headers: ADMIN });
  }
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('page'));
  await expect(page.locator('main')).toContainText('w-3');
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('w-10');
  expect(text.indexOf('w0')).toBeLessThan(text.indexOf('w-3'));            // newest first
  await page.evaluate(() => appInstance.selectTab('latest'));
  await expect.poll(() => page.evaluate(() => appInstance.sortedData.map((r) => r.what))).toEqual(['w0', 'w-3']);
  await page.evaluate(() => appInstance.selectTab('recent'));
  await expect.poll(() => page.evaluate(() => appInstance.sortedData.map((r) => r.what))).toEqual(['w0', 'w-3']);
  await page.evaluate(() => appInstance.addRow());
  await expect.poll(async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'logs', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => r.done_on).filter((d) => d === ymd(0)).length).toBe(2);
});

test('a log and a report follow the calendar on their page: week, month, year, and ‹ a year back', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  const inCal = { within: { calendar: 'cal' } };
  schema.views = [
    { name: 'cal', kind: 'calendar', calendar: { sources: [{ table: 'logs', dateColumn: 'done_on', titleColumns: ['what'] }], defaultView: 'month' } },
    { name: 'log', kind: 'data', sources: ['logs'], mode: 'union', layout: 'table', columns: ['done_on', 'what'], defaultSort: 'done_on', filter: { done_on: inCal } },
    { name: 'sum', kind: 'stats', sources: ['logs'], mode: 'union', filter: { done_on: inCal }, stats: { tiles: [{ label: 'n', agg: 'count' }], display: 'number' } },
    { name: 'page', kind: 'page', markdown: '{{view:cal}}\n\n{{view:sum}}\n\n{{view:log}}' }
  ];
  schema.nav = { items: [{ view: 'page' }] };
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  for (const [id, d] of [['wk', '2026-07-14'], ['mo', '2026-07-02'], ['yr', '2026-02-10'], ['old', '2025-12-31']]) {
    await page.request.post('/api/putRow', { data: { tableId: 'logs', tab: 'active', data: { id, owner: 'org@x', done_on: d, what: 'is-' + id } }, headers: ADMIN });
  }
  await page.clock.setFixedTime(new Date('2026-07-15T12:00:00'));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('page'));
  const logged = () => page.evaluate(() => appInstance.embedRows('view', 'log').map((r) => r.id).sort());
  const count = page.locator('[data-testid="stat-value"]');
  await expect.poll(logged).toEqual(['mo', 'wk']);
  await expect(count).toHaveText('2');
  await page.locator('button', { hasText: 'cal.week' }).click();
  await expect.poll(logged).toEqual(['wk']);
  await expect(count).toHaveText('1');
  await page.locator('[data-testid="cal-mode-year"]').click();
  await expect.poll(logged).toEqual(['mo', 'wk', 'yr']);
  await expect(page.locator('[data-testid="cal-year-2026-02"]')).toBeVisible();
  await page.locator('button .mdi-chevron-left').first().click();
  await expect.poll(logged).toEqual(['old']);
  await expect(count).toHaveText('1');
  await page.locator('[data-testid="cal-year-2025-12"] div').first().click();   // the month's name opens it
  await expect.poll(() => page.evaluate(() => appInstance.calendarPeriod('cal'))).toEqual({ from: '2025-12-01', toExclusive: '2026-01-01' });
  // validateSchema names a calendar that is not one.
  const err = await page.evaluate(() => { VIEWS.log.filter = { done_on: { within: { calendar: 'nope' } } }; return validateSchema().join(' | '); });
  expect(err).toContain('must name a calendar view (got "nope")');
});

test('on a phone, Month is the month grid, not the list', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.views = [{ name: 'cal', kind: 'calendar', calendar: { sources: [{ table: 'logs', dateColumn: 'done_on', titleColumns: ['what'] }], defaultView: 'month' } }];
  schema.nav = { items: [{ view: 'cal' }] };
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('cal'));
  await expect(page.locator('[data-testid="cal-cell-' + ymd(0) + '"]')).toBeVisible();
});
