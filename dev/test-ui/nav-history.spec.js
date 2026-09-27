// nav-history.spec.js — the open screen lives in the address bar (`?at=`), so Back/Forward and a reload
// keep the user's place. Nav.readAt/withAt are pinned in dev/test/nav.test.js; what only exists here is
// the wiring: that a click pushes an entry, that the browser's Back reaches the app, and that boot reads
// the parameter against the tree THIS user may see.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

async function boot(page, url) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto(url || '/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
}

const drawerItem = (page, text) => page.locator('.v-navigation-drawer .v-list-item', { hasText: text }).first();
const at = (page) => page.evaluate(() => new URLSearchParams(location.search).get('at'));
// The drawer marks the open screen active; that is what the user sees change.
const expectOpen = (page, text) => expect(page.locator('.v-navigation-drawer .v-list-item--active', { hasText: text })).toHaveCount(1);
// The screen the app has open. The first fixture entry is a view WITH children, drawn as a group header
// the drawer never marks active, so screens reached by fallback are asserted on the app's own state.
const current = (page) => page.evaluate(() => window.appInstance.currentTable);

test.describe('Navigation history (?at=)', () => {
  test('boot writes nothing to the address bar', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(() => location.search)).toBe('');
  });

  test('a click pushes an entry; Back and Forward move between screens', async ({ page }) => {
    await boot(page);
    await drawerItem(page, 'tab.tasks').click();
    await expectOpen(page, 'tab.tasks');
    expect(await at(page)).toBe('tasks');
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    expect(await at(page)).toBe('notes');

    await page.goBack();
    await expectOpen(page, 'tab.tasks');
    await page.goForward();
    await expectOpen(page, 'tab.notes');
  });

  test('Back to the landing URL opens the first screen, and stays in the app', async ({ page }) => {
    await boot(page);
    await expect.poll(() => current(page)).toBe('combined');
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    await page.goBack();
    await expect.poll(() => current(page)).toBe('combined');
    expect(await at(page)).toBeNull();
  });

  test('re-clicking the open screen adds no entry', async ({ page }) => {
    await boot(page);
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    const len = await page.evaluate(() => history.length);
    await drawerItem(page, 'tab.notes').click();
    expect(await page.evaluate(() => history.length)).toBe(len);
  });

  test('a reload on ?at= opens that screen', async ({ page }) => {
    await boot(page, '/?at=notes');
    await expectOpen(page, 'tab.notes');
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await expectOpen(page, 'tab.notes');
  });

  test('an ?at= naming nothing in the nav opens the first screen', async ({ page }) => {
    await boot(page, '/?at=no_such_screen');
    await expect.poll(() => current(page)).toBe('combined');
  });

  test('?at= survives beside ?db=, which boot strips', async ({ page }) => {
    await boot(page, '/?db=local&at=notes');
    await expectOpen(page, 'tab.notes');
    expect(await page.evaluate(() => location.search)).toBe('?at=notes');
  });

  test('other parameters are kept when a click writes ?at=', async ({ page }) => {
    await boot(page, '/?foo=bar');
    await drawerItem(page, 'tab.notes').click();
    await expectOpen(page, 'tab.notes');
    expect(await page.evaluate(() => location.search)).toBe('?foo=bar&at=notes');
  });
});

test.describe('A group\'s page', () => {
  const WITH_GROUP = Object.assign({}, SCHEMA, { nav: { items: [
    { view: 'all_items' },
    { group: 'Data', icon: 'mdi-database', items: [{ table: 'tasks' }, { table: 'notes' }] },
  ] } });

  async function bootGroup(page, url) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: WITH_GROUP } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto(url || '/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  }

  test('opening a group in the drawer lists its entries, and one opens from there', async ({ page }) => {
    await bootGroup(page);
    await drawerItem(page, 'Data').click();
    await expect(page.locator('[data-testid="nav-level"]')).toBeVisible();
    await expect(page.locator('[data-testid^="nav-level-item-"]')).toHaveCount(2);
    expect(await at(page)).toBe('grp:Data');

    await page.locator('[data-testid="nav-level-item-notes"]').click();
    await expect.poll(() => current(page)).toBe('notes');
    await page.goBack();
    await expect(page.locator('[data-testid="nav-level"]')).toBeVisible();
  });

  test('a ?at=grp: link opens the group page', async ({ page }) => {
    await bootGroup(page, '/?at=' + encodeURIComponent('grp:Data'));
    await expect(page.locator('[data-testid="nav-level-item-tasks"]')).toBeVisible();
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
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEEP } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    await page.goto('/?at=' + encodeURIComponent('grp:Inner'));
    await expect(page.locator('[data-testid="nav-level-item-notes"]')).toBeVisible();

    await page.goto('/?at=combined');
    await expect(page.locator('[data-testid="nav-level-below"] [data-testid="nav-level-item-attendance"]')).toBeVisible();
  });
});
