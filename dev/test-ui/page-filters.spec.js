// A page's `filters` narrow every view embedded on it (only rows that HAVE the column), and Settings ->
// Users narrows by search, role and linked list.
const { test, expect } = require('./server-fixture');

const ADMIN = { 'X-User': 'org@x' };
const SCHEMA = {
  defaultLanguage: 'en',
  listSources: { coaches: 'userlink' },
  tables: {
    visits: { columns: [{ name: 'venue', type: 'select', list: 'venues' }] },
    sessions: { columns: [{ name: 'venue', type: 'select', list: 'venues' }, { name: 'coach', type: 'select', list: 'coaches' }] }
  },
  views: [
    { name: 'counts', kind: 'stats', sources: ['visits', 'sessions'], mode: 'union', readonly: true,
      stats: { display: 'number', tiles: [{ label: 'v', agg: 'count', when: { coach: { empty: true } } }, { label: 's', agg: 'count', when: { coach: { notEmpty: true } } }] } },
    { name: 'stats', kind: 'page', filters: ['venue', 'coach'], markdown: '{{view:counts}}' }
  ],
  nav: { items: [{ view: 'stats' }] }
};

async function boot(page) {
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
async function setup(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { venues: ['North', 'South'], coaches: ['Kim', 'Lee'] } }, headers: ADMIN });
  const put = (t, data) => page.request.post('/api/putRow', { data: { tableId: t, tab: 'active', data }, headers: ADMIN });
  await put('visits', { id: 'v1', venue: 'North' }); await put('visits', { id: 'v2', venue: 'South' }); await put('visits', { id: 'v3', venue: 'South' });
  await put('sessions', { id: 's1', venue: 'North', coach: 'Kim' }); await put('sessions', { id: 's2', venue: 'South', coach: 'Lee' });
}

test('page filters narrow the embeds: a venue narrows both tables, a coach only the rows that have one', async ({ page }) => {
  await setup(page);
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  const values = () => page.locator('[data-testid="stat-value"]').allInnerTexts();
  await expect.poll(values).toEqual(['3', '2']);
  await page.locator('[data-testid="page-filter-venue"]').click();
  await page.locator('.v-overlay .v-list-item', { hasText: 'South' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(values).toEqual(['2', '1']);
  await page.locator('[data-testid="page-filter-coach"]').click();
  await page.locator('.v-overlay .v-list-item', { hasText: 'Kim' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(values).toEqual(['2', '0']);          // visits have no coach: left alone
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect.poll(values).toEqual(['2', '0']);          // remembered in this browser
});

test('Settings users: search, role and linked-list filters narrow the list', async ({ page }) => {
  await setup(page);
  for (const [u, role] of [['ann@x', 'viewer'], ['bob@x', 'viewer'], ['kim@x', 'viewer'], ['ed@x', 'editor']]) {
    await page.request.post('/api/setUserRole', { data: { uid: u, role, user: u, tables: {} }, headers: ADMIN });
  }
  await page.request.post('/api/setListUser', { data: { listName: 'coaches', value: 'Kim', email: 'kim@x' }, headers: ADMIN });
  await boot(page);
  await page.evaluate(() => { appInstance.selectTab('__settings'); appInstance.settings._collapseUsers = false; });
  const count = page.locator('[data-testid="users-count"]');
  await expect(count).toHaveText('5 / 5');
  await page.locator('[data-testid="users-search"] input').fill('bo');
  await expect(count).toHaveText('1 / 5');
  await page.locator('[data-testid="users-search"] input').fill('');
  await page.evaluate(() => { appInstance.userFilter.roles = ['viewer']; });
  await expect(count).toHaveText('3 / 5');
  await page.evaluate(() => { appInstance.userFilter.lists = ['coaches']; });
  await expect(count).toHaveText('1 / 5');
});

test('Approve grants the schema\'s newUser access: a viewer with the tables it names', async ({ page }) => {
  await setup(page);
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.newUser = { role: 'viewer', tables: { visits: 'r' } };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await boot(page);
  const mine = await page.evaluate(async () => {
    localStorage.setItem('test_user', 'newbie@x');
    await backend_users.requestAccess('New Bie', '');
    localStorage.setItem('test_user', 'org@x');
    await appInstance.approveRequest({ email: 'newbie@x', name: 'New Bie' });
    localStorage.setItem('test_user', 'newbie@x');
    const m = await backend_users.getMyAccess();
    localStorage.setItem('test_user', 'org@x');
    return m;
  });
  expect(mine.role).toBe('viewer');
  expect(JSON.stringify(mine.tables)).toContain('visits');
  const err = await page.evaluate(() => validateRefs({ tables: { visits: { columns: [] } }, views: [], newUser: { role: 'admin', tables: ['nope'] } }).join(' | '));
  expect(err).toContain('cannot be "admin"');
  expect(err).toContain('missing table "nope"');
});
