// A write the backend refuses is reported, and nothing claims it was saved.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

const PAGE_SCHEMA = {
  defaultLanguage: 'en',
  tables: { tasks: { columns: [{ name: 'title', type: 'text' }] } },
  views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '# Seed' }],
  nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
};

async function boot(page, schema) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
}

// Every later write to `table` rejects, as a refusing policy or a dropped connection would.
const refuseWrites = (page, table) => page.evaluate((t) => {
  window.__realPut = backend.putRow;
  backend.putRow = function(tbl) {
    if (tbl === t) return Promise.reject(new Error('refused by policy'));
    return window.__realPut.apply(this, arguments);
  };
}, table);
const allowWrites = (page) => page.evaluate(() => { backend.putRow = window.__realPut; });
const snack = (page) => page.locator('.v-snackbar');
const text = (page, key) => page.evaluate((k) => appInstance.t(k), key);

const storedNotes = async (page) => {
  const d = await (await page.request.post('/api/getTableData', { data: { tableId: 'notes', tab: 'active' } })).json();
  return d.rows || [];
};

test.describe('A refused write', () => {
  test('a cell edit says it failed and shows the stored value again', async ({ page }) => {
    await boot(page, SCHEMA);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
    await page.locator('button:has(.mdi-plus)').click();
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('Kept');
    await cell.blur();
    await expect.poll(async () => JSON.stringify(await storedNotes(page))).toContain('Kept');

    await refuseWrites(page, 'notes');
    await cell.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Lost');
    await cell.blur();

    await expect(snack(page)).toContainText(await text(page, 'msg.save_failed'));
    await expect(page.locator('.v-table tbody')).toContainText('Kept');
    await expect(page.locator('.v-table tbody')).not.toContainText('Lost');
    expect(JSON.stringify(await storedNotes(page))).not.toContain('Lost');
  });

  test('a page save keeps the editor open with the text until the body is stored', async ({ page }) => {
    await boot(page, PAGE_SCHEMA);
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.locator('.v-card [data-testid="page-edit"]').click();
    await page.locator('.v-card textarea').first().fill('# Draft that must survive');

    await refuseWrites(page, '_pages');
    await page.locator('.v-card button:has-text("Save")').click();
    await expect(snack(page)).toContainText(await text(page, 'msg.save_failed'));
    await expect(page.locator('.v-card textarea').first()).toHaveValue('# Draft that must survive');

    await allowWrites(page);
    await page.locator('.v-card button:has-text("Save")').click();
    await expect(page.locator('.v-card textarea')).toHaveCount(0);
    await expect(page.locator('.v-main')).toContainText('Draft that must survive');
    const pages = await (await page.request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' } })).json();
    expect((pages.rows.find((r) => r.id === 'home') || {}).markdown).toBe('# Draft that must survive');
  });
});
