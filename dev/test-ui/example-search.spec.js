// Search, exercised against the REAL example schemas rather than a hand-written fixture.
//
// The synthetic fixtures in app.spec.js are written by whoever is writing the test, so they agree
// with the implementation by construction. These are the schemas people actually import from
// examples/, with a filtered view, a select column backed by a list, and Finnish data -- which is
// where the diacritic folding stops being a unit-test detail and starts being the point.
//
// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');
const CHORES = require('../../examples/chores-schema.json');
const BISHOP = require('../../examples/bishopric-schema.json').schema;

async function boot(page, schema, rows) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema } });
  for (const [tableId, data] of rows) {
    await page.request.post('/api/putRow', { data: { tableId, data, tab: 'active' } });
  }
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 20000 });
}
const open = async (page, name) => {
  await page.evaluate((n) => window.appInstance.selectTab(n), name);
  await page.waitForFunction((n) => {
    const a = window.appInstance;
    return a && !a.loading && (a._viewTables(n) || []).every((t) => Array.isArray(a.dataCache[t]));
  }, name, { timeout: 10000 });
};
const shown = (page) => page.evaluate(() => (appInstance.sortedData || []).map((r) => r.id));
const box = (page) => page.locator('[data-testid="view-search"]');

test('chores: the box renders where the example asks for it, and not elsewhere', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page, CHORES, [
    ['home_shopping', { id: 's1', item: 'Maito', qty: '2', added_by: 'Ann', shop_status: 'needed' }],
    ['home_shopping', { id: 's2', item: 'Leipä', qty: '1', added_by: 'Bob', shop_status: 'needed' }],
    ['home_shopping', { id: 's3', item: 'Juusto', qty: '1', added_by: 'Ann', shop_status: 'needed' }]
  ]);
  await open(page, 'shop_todo');
  await expect(box(page)).toBeVisible();
  expect((await shown(page)).length).toBe(3);

  // `search: ["item"]` -- so a term in `item` matches...
  await box(page).locator('input').fill('leipa');           // and diacritics fold: leipa -> Leipä
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(['s2']);
  // ...but `added_by` is NOT searched by this view.
  await box(page).locator('input').fill('Ann');
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual([]);

  await open(page, 'reward_shop');            // no `search` in the example
  await expect(box(page)).toHaveCount(0);
});

test('bishopric: search:true over a real people view folds Finnish diacritics', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page, BISHOP, [
    ['admin_callings', { id: 'c1', person: 'Kati Tuppurainen', calling: 'Opettaja', notes: 'Hyväksytty' }],
    ['admin_callings', { id: 'c2', person: 'Säestäjä Testi', calling: 'Pianisti', notes: '' }],
    ['admin_callings', { id: 'c3', person: 'Bob Smith', calling: 'Opettaja', notes: '' }]
  ]);
  await open(page, 'admin_callings');
  await expect(box(page)).toBeVisible();

  await box(page).locator('input').fill('saestaja');        // typed without diacritics
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(['c2']);
  await box(page).locator('input').fill('opettaja');        // search:true reaches other columns
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(['c1', 'c3']);
  await box(page).locator('input').fill('');
  await expect.poll(() => shown(page), { timeout: 5000 }).toEqual(['c1', 'c2', 'c3']);
});
