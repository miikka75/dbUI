// A stats tile with `series`: one tile per period, the last N ending now, captioned by the period.
const { test, expect } = require('./server-fixture');

const SCHEMA = {
  defaultLanguage: 'en',
  tables: { logs: { columns: [{ name: 'done_on', type: 'date' }, { name: 'min', type: 'number' }] } },
  views: [
    { name: 'weeks', kind: 'stats', sources: ['logs'], mode: 'union',
      stats: { tiles: [{ agg: 'sum', column: 'min', goal: 'max', series: { column: 'done_on', interval: 'weekly', count: 3 } }] } }
  ],
  nav: { items: [{ view: 'weeks' }] }
};

test('a series draws one tile per week, oldest first, captioned by its Monday', async ({ page }) => {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  for (const [id, d, min] of [['a', '2026-06-30', 20], ['b', '2026-07-13', 30], ['c', '2026-07-15', 10], ['old', '2026-06-01', 99]]) {
    await page.request.post('/api/putRow', { data: { tableId: 'logs', tab: 'active', data: { id, done_on: d, min } } });
  }
  await page.clock.setFixedTime(new Date('2026-07-15T12:00:00'));   // a Wednesday
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('weeks'));

  await expect(page.locator('[data-testid="stat-value"]')).toHaveText(['20', '0', '40']);
  await expect(page.locator('[data-testid="stat-period"]')).toHaveText(['Jun 29', 'Jul 6', 'Jul 13']);
  await expect(page.locator('[data-testid="stat-bar"]')).toHaveCount(3);   // scaled against the busiest week

  const errs = await page.evaluate(() => {
    VIEWS.weeks.stats.tiles[0].series = { column: 'done_on', interval: 'yearly', count: 0 };
    return validateSchema().filter((e) => e.indexOf('weeks') >= 0).join(' | ');
  });
  expect(errs).toContain('`series.interval` is "yearly"');
  expect(errs).toContain('`series.count` must be a whole number from 1 to 60');
});
