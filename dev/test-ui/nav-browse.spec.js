// nav-browse.spec.js — `nav.layout: "browse"`: the nav tree as the page itself. Home lists the top
// level, a group opens as a list of its entries, a breadcrumb leads back up, and the system screens sit
// behind a cog because there is no drawer to hold them.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

const BROWSE = Object.assign({}, SCHEMA, { nav: { layout: 'browse', items: [
  { view: 'combined', items: [{ view: 'attendance' }] },
  { group: 'Data', icon: 'mdi-database', items: [{ table: 'tasks' }, { group: 'More', items: [{ table: 'notes' }] }] },
] } });

async function boot(page, { url = '/', width = 1280 } = {}) {
  await page.setViewportSize({ width, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: BROWSE } });
  await page.addInitScript(() => {
    localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
    localStorage.removeItem('app_nav_layout');
  });
  await page.goto(url);
  await page.waitForSelector('[data-testid="nav-level"], [data-testid="breadcrumb"]', { timeout: 6000 });
}

const current = (page) => page.evaluate(() => window.appInstance && window.appInstance.currentTable);
const item = (page, id) => page.locator('[data-testid="nav-level-item-' + id + '"]');

test.describe('Browse layout', () => {
  test('boots to home: the top level, no drawer, no hamburger, no breadcrumb', async ({ page }) => {
    await boot(page);
    await expect.poll(() => current(page)).toBe('__home');
    await expect(item(page, 'combined')).toBeVisible();
    await expect(item(page, 'grp:Data')).toBeVisible();
    await expect(page.locator('[data-testid^="nav-level-item-"]')).toHaveCount(2);   // no system screens on home
    await expect(page.locator('.v-navigation-drawer')).toHaveCount(0);
    await expect(page.locator('.v-app-bar-nav-icon')).toHaveCount(0);
    await expect(page.locator('[data-testid="breadcrumb"]')).toHaveCount(0);
  });

  test('drill two levels down, then the breadcrumb and Back lead up again', async ({ page }) => {
    await boot(page);
    await item(page, 'grp:Data').click();
    await item(page, 'grp:More').click();
    await item(page, 'notes').click();
    await expect.poll(() => current(page)).toBe('notes');
    await expect(page.locator('[data-testid="breadcrumb"]')).toContainText('Data');
    await expect(page.locator('[data-testid="breadcrumb"]')).toContainText('More');

    await page.locator('[data-testid="crumb-grp:Data"]').click();
    await expect.poll(() => current(page)).toBe('grp:Data');
    await page.goBack();
    await expect.poll(() => current(page)).toBe('notes');
    await page.locator('[data-testid="crumb-__home"]').click();
    await expect.poll(() => current(page)).toBe('__home');
  });

  test('a view with entries of its own lists them beneath itself', async ({ page }) => {
    await boot(page);
    await item(page, 'combined').click();
    await expect.poll(() => current(page)).toBe('combined');
    await expect(page.locator('[data-testid="nav-level-below"]')).toBeVisible();
    await item(page, 'attendance').click();
    await expect.poll(() => current(page)).toBe('attendance');
  });

  test('the system screens are behind the cog', async ({ page }) => {
    await boot(page);
    await page.locator('[data-testid="browse-system-menu"]').click();
    await page.locator('[data-testid="browse-system-__settings"]').click();
    await expect.poll(() => current(page)).toBe('__settings');
    await expect(page.locator('[data-testid="breadcrumb"]')).toBeVisible();
  });

  test('a deep link opens its screen with the path above it; an unknown one opens home', async ({ page }) => {
    await boot(page, { url: '/?at=notes' });
    await expect.poll(() => current(page)).toBe('notes');
    await expect(page.locator('[data-testid="crumb-grp:More"]')).toBeVisible();
    await page.goto('/?at=nope');
    await expect.poll(() => current(page)).toBe('__home');
  });

  test('a phone gets one step up instead of the whole path', async ({ page }) => {
    await boot(page, { url: '/?at=notes', width: 390 });
    await expect(page.locator('[data-testid="crumb-up"]')).toContainText('More');
    await page.locator('[data-testid="crumb-up"]').click();
    await expect.poll(() => current(page)).toBe('grp:More');
    await expect(page.locator('.v-bottom-navigation')).toHaveCount(0);
  });

  test('Settings switches a drawer schema into browse, live', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.removeItem('app_nav_layout'); });
    await page.goto('/?at=__settings');
    await page.waitForSelector('[data-testid="nav-layout-browse"]', { timeout: 6000 });
    await page.locator('[data-testid="nav-layout-browse"]').click();
    await expect(page.locator('.v-navigation-drawer')).toHaveCount(0);
    await expect(page.locator('[data-testid="browse-system-menu"]')).toBeVisible();
  });
});
