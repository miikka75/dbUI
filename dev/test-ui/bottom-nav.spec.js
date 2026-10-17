// The phone's bottom bar: "More" appears whenever the bar cannot hold every page -- more than five asked
// for, or menu pages the bar leaves out -- so nothing is reachable only through the top-left menu.
const { test, expect } = require('./server-fixture');

const page_ = (name) => ({ name, kind: 'page', markdown: '# ' + name });
const schemaWith = (items, bottomNav) => ({ defaultLanguage: 'en', tables: { t: { columns: [{ name: 'a', type: 'text' }] } },
  views: items.map(page_), nav: { layout: 'drawer', items: items.map((v) => ({ view: v })), bottomNav } });
const ADMIN = { 'X-User': 'org@x' };

async function bootWith(page, schema) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.setViewportSize({ width: 400, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}

test('bottom bar: More when the menu has pages the bar leaves out, none when the bar holds them all', async ({ page }) => {
  await bootWith(page, schemaWith(['a', 'b', 'c', 'd', 'e', 'f'], ['a', 'b', 'c', 'd', 'e']));
  await expect(page.locator('[data-testid="bottom-more"]')).toBeVisible();
  expect(await page.evaluate(() => appInstance.bottomNavVisible.map((t) => t.id))).toEqual(['a', 'b', 'c', 'd']);
  await page.locator('[data-testid="bottom-more"]').click();
  await expect.poll(() => page.evaluate(() => appInstance.drawerOpen)).toBe(true);

  await bootWith(page, schemaWith(['a', 'b', 'c'], ['a', 'b', 'c']));   // Settings alone does not call for it
  await expect(page.locator('.v-bottom-navigation')).toBeVisible();
  await expect(page.locator('[data-testid="bottom-more"]')).toHaveCount(0);
});
