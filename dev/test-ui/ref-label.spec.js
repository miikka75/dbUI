// A labelled ref cell names the row it points at, through an index of the target table that follows the
// table as it changes.
const { test, expect } = require('./server-fixture');
const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    items: { columns: [{ name: 'name', type: 'text' }, { name: 'code', type: 'text' }] },
    orders: { columns: [{ name: 'title', type: 'text' }, { name: 'item', type: 'ref', table: 'items', valueCol: 'id', label: ['name', 'code'] }] }
  },
  views: [{ table: 'orders' }, { table: 'items' }],
  nav: { items: [{ table: 'orders' }, { table: 'items' }] }
};

async function boot(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'items', data: { id: 'i1', name: 'Rope', code: 'R1' }, tab: 'active' } });
  await page.request.post('/api/putRow', { data: { tableId: 'orders', data: { id: 'o1', title: 'First', item: 'i1' }, tab: 'active' } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, null, { timeout: 10000 });
  await page.evaluate(() => appInstance.selectTab('orders'));
}

test.describe('A labelled ref cell', () => {
  test('shows the target row, follows a rename, and finds a row added later', async ({ page }) => {
    await boot(page);
    await expect.poll(() => page.evaluate(() => appInstance.displayValue('item', 'i1'))).toBe('Rope · R1');

    await page.evaluate(() => { appInstance.dataCache.items.find((r) => r.id === 'i1').name = 'Chain'; });
    await expect.poll(() => page.evaluate(() => appInstance.displayValue('item', 'i1'))).toBe('Chain · R1');

    await page.evaluate(() => { appInstance.dataCache.items.push({ id: 'i2', name: 'Hook', code: 'H2' }); });
    await expect.poll(() => page.evaluate(() => appInstance.displayValue('item', 'i2'))).toBe('Hook · H2');
    expect(await page.evaluate(() => appInstance.displayValue('item', 'missing'))).toBe('missing');
  });

  test('stays fast over a large target table', async ({ page }) => {
    await boot(page);
    const ms = await page.evaluate(() => {
      const a = appInstance;
      a.dataCache.items = Array.from({ length: 3000 }, (_, i) => ({ id: 'i' + i, name: 'Item ' + i, code: 'C' + i }));
      a.displayValue('item', 'i1');
      const t0 = performance.now();
      for (let i = 0; i < 4000; i++) a.displayValue('item', 'i' + (i * 7 % 3000));
      return performance.now() - t0;
    });
    expect(ms, '4000 cells over 3000 rows took ' + ms.toFixed(0) + ' ms; a per-cell scan took ~2000').toBeLessThan(500);
  });
});
