// nav-history.spec.js — every screen the user opens is a browser history entry, so Back/Forward move
// between screens instead of leaving the app, and a reload keeps the screen. The screen travels in the
// entry's state: the address bar never changes. What only exists here is the wiring — that a click
// pushes an entry, that the browser's Back reaches the app, and that a reload reads the entry back.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

async function boot(page, schema) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: schema || SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
}

const drawerItem = (page, text) => page.locator('.v-navigation-drawer .v-list-item', { hasText: text }).first();
// The drawer marks the open screen active; that is what the user sees change.
const expectOpen = (page, text) => expect(page.locator('.v-navigation-drawer .v-list-item--active', { hasText: text })).toHaveCount(1);
// The screen the app has open. The first fixture entry is a view WITH children, drawn as a group header
// the drawer never marks active, so screens reached by fallback are asserted on the app's own state.
const current = (page) => page.evaluate(() => window.appInstance && window.appInstance.currentTable);
const open = (page, id) => page.evaluate((i) => window.appInstance.selectTab(i), id);

test.describe('Navigation history', () => {
  test('a click pushes an entry; Back and Forward move between screens', async ({ page }) => {
    await boot(page);
    await drawerItem(page, 'tab.tasks').click();
    await expectOpen(page, 'tab.tasks');
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');

    await page.goBack();
    await expectOpen(page, 'tab.tasks');
    await page.goForward();
    await expectOpen(page, 'tab.notes');
  });

  test('the address bar never changes', async ({ page }) => {
    await boot(page);
    const url = page.url();
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    expect(page.url()).toBe(url);
    await page.goBack();
    await expect.poll(() => current(page)).toBe('combined');
    expect(page.url()).toBe(url);
  });

  test('Back to the entry the app opened on shows the first screen, and stays in the app', async ({ page }) => {
    await boot(page);
    await expect.poll(() => current(page)).toBe('combined');
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    await page.goBack();
    await expect.poll(() => current(page)).toBe('combined');
  });

  test('re-clicking the open screen adds no entry', async ({ page }) => {
    await boot(page);
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    const len = await page.evaluate(() => history.length);
    await drawerItem(page, 'tab.notes').click();
    expect(await page.evaluate(() => history.length)).toBe(len);
  });

  test('a reload keeps the open screen', async ({ page }) => {
    await boot(page);
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await expectOpen(page, 'tab.notes');
  });

  test('an entry naming a screen that is no longer in the nav opens the first screen', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => history.replaceState({ screen: 'no_such_screen' }, ''));
    await page.reload();
    await expect.poll(() => current(page)).toBe('combined');
  });
});

test.describe('A group\'s page', () => {
  const WITH_GROUP = Object.assign({}, SCHEMA, { nav: { items: [
    { view: 'all_items' },
    { group: 'Data', icon: 'mdi-database', items: [{ table: 'tasks' }, { table: 'notes' }] },
  ] } });

  test('opening a group in the drawer lists its entries, and one opens from there', async ({ page }) => {
    await boot(page, WITH_GROUP);
    await drawerItem(page, 'Data').click();
    await expect(page.locator('[data-testid="nav-level"]')).toBeVisible();
    await expect(page.locator('[data-testid^="nav-level-item-"]')).toHaveCount(2);
    expect(await current(page)).toBe('grp:Data');

    await page.locator('[data-testid="nav-level-item-notes"]').click();
    await expect.poll(() => current(page)).toBe('notes');
    await page.goBack();
    await expect(page.locator('[data-testid="nav-level"]')).toBeVisible();
  });
});

test.describe('Deeper than the drawer draws', () => {
  // The drawer draws two levels. A third is still reachable: a second-level group opens as its page, and
  // a second-level view with entries of its own lists them beneath itself.
  const DEEP = Object.assign({}, SCHEMA, { nav: { items: [
    { group: 'Outer', items: [
      { group: 'Inner', items: [{ table: 'notes' }] },
      { view: 'combined', items: [{ view: 'attendance' }] },
    ] },
  ] } });

  test('a second-level group and a second-level view both lead on to the third level', async ({ page }) => {
    await boot(page, DEEP);
    await open(page, 'grp:Inner');
    await expect(page.locator('[data-testid="nav-level-item-notes"]')).toBeVisible();

    await open(page, 'combined');
    await expect(page.locator('[data-testid="nav-level-below"] [data-testid="nav-level-item-attendance"]')).toBeVisible();
  });
});
