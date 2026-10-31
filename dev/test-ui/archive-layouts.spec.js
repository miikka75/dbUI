// The Past tab offers Restore, not archive, in every layout (the card, split and list layouts used to
// show the archive button there, which did nothing).
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

for (const layout of ['card', 'split', 'list']) {
  test('Past tab in the ' + layout + ' layout restores a row', async ({ page }) => {
    const schema = JSON.parse(JSON.stringify(SCHEMA));
    schema.views.push({ name: 'tickets_' + layout, sources: ['tickets'], mode: 'join', layout, columns: ['title', 'status'] });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema } });
    await page.request.post('/api/putRow', { data: { tableId: 'tickets', data: { id: 'tk1', title: 'Alpha', status: 'open', _status: 'archive' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
    await page.evaluate((n) => appInstance.selectTab(n), 'tickets_' + layout);
    await page.locator('.v-tab:nth-child(2)').click();
    if (layout === 'split') await page.locator('[data-testid="split-row-tk1"]').click();

    await expect(page.locator('[data-testid="row-restore"]')).toHaveCount(1);
    await expect(page.locator('button:has(.mdi-archive-outline)')).toHaveCount(0);
    await page.locator('[data-testid="row-restore"]').click();

    await expect.poll(async () => {
      const s = await (await page.request.post('/api/getTableData', { data: { tableId: 'tickets', tab: 'active' } })).json();
      return ((s.rows || s.data || s).find((r) => r.id === 'tk1') || {})._status;
    }).toBe('active');
  });
}
