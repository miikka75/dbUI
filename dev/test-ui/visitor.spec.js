// Visitors, open sign-up and member-only pages: a signed-out visitor sees the public tables and a Sign in
// button; signing in registers the account with the schema's newUser grant, no approval; a page that
// `requires` a membership appears once one covers today.
const { test, expect } = require('./server-fixture');

const ADMIN = { 'X-User': 'org@x' };
const today = new Date().toISOString().slice(0, 10);
const SCHEMA = {
  defaultLanguage: 'en',
  newUser: { role: 'viewer', tables: { classes: 'r' }, open: true },
  tables: {
    classes: { public: true, columns: [{ name: 'title', type: 'text' }] },
    diary: { ownerWritable: ['text'], columns: [{ name: 'owner', type: 'owner' }, { name: 'text', type: 'text' }] },
    memberships: { ownerWritable: ['from_on'], columns: [{ name: 'owner', type: 'owner' }, { name: 'from_on', type: 'date' }, { name: 'to_on', type: 'date' }, { name: 'state', type: 'text' }] }
  },
  views: [
    { name: 'timetable', kind: 'data', sources: ['classes'], mode: 'union', layout: 'table', columns: ['title'] },
    { name: 'mine', kind: 'data', sources: ['diary'], mode: 'union', layout: 'table', columns: ['text'],
      requires: { table: 'memberships', from: 'from_on', to: 'to_on', where: { state: 'active' } } },
    { name: 'home', kind: 'page', markdown: '# Home\n\n{{view:timetable}}\n\n{{view:mine}}' }
  ],
  nav: { items: [{ view: 'home' }, { view: 'timetable' }, { view: 'mine' }] }
};

async function setup(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'classes', tab: 'active', data: { id: 'c1', title: 'Spin' } }, headers: ADMIN });
}
async function bootAs(browser, user) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((u) => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', u); }, user);
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.goto('/');
  await p.waitForFunction(() => window.appInstance && !appInstance.loading && appInstance.usersLoaded, { timeout: 30000 });
  return { ctx, p };
}
const navIds = (p) => p.evaluate(() => Nav.flatten(appInstance.sidebarTabs).map((t) => t.id));

test('a visitor sees the public tables and a Sign in button, and nothing that is not public', async ({ page, browser }) => {
  await setup(page);
  await page.request.post('/api/putRow', { data: { tableId: 'diary', tab: 'active', data: { id: 'd1', owner: 'org@x', text: 'secret' } }, headers: ADMIN });
  const { ctx, p } = await bootAs(browser, '');
  await expect(p.locator('[data-testid="visitor-sign-in"]')).toBeVisible();
  const ids = await navIds(p);
  expect(ids).toContain('timetable');
  expect(ids).not.toContain('mine');
  await p.evaluate(() => appInstance.selectTab('home'));
  await expect(p.locator('main')).toContainText('Spin');
  await expect(p.locator('main')).not.toContainText('secret');
  // The server agrees: an empty X-User is a visitor, who reads the public table and not the others.
  const read = async (t) => (await page.request.post('/api/getTableData', { data: { tableId: t, tab: 'active' }, headers: { 'X-User': '' } })).json();
  expect(((await read('classes')).rows || []).map((r) => r.id)).toEqual(['c1']);
  expect(((await read('diary')).rows || []).length).toBe(0);
  await ctx.close();
});

test('open sign-up: signing in registers the account with newUser; the member page waits for a membership', async ({ page, browser }) => {
  await setup(page);
  let s = await bootAs(browser, 'new@x');
  await expect.poll(() => s.p.evaluate(() => appInstance.currentUserRole)).toBe('viewer');
  expect(await navIds(s.p)).not.toContain('mine');
  const users = await (await page.request.post('/api/getUsers', { data: {}, headers: ADMIN })).json();
  expect(users['new@x'].role).toBe('viewer');
  expect(users['new@x'].tables).toEqual({ classes: 'r' });
  await s.ctx.close();
  await page.request.post('/api/putRow', { data: { tableId: 'memberships', tab: 'active', data: { id: 'm1', owner: 'new@x', from_on: today, to_on: '2100-01-01', state: 'active' } }, headers: ADMIN });
  s = await bootAs(browser, 'new@x');
  await expect.poll(() => navIds(s.p)).toContain('mine');
  await s.ctx.close();
});

test('nobody signs themselves up for more than newUser', async ({ page }) => {
  await setup(page);
  const r = await page.request.post('/api/setUserRole', { data: { uid: 'greedy@x', role: 'admin', user: 'greedy@x', tables: 'all' }, headers: { 'X-User': 'greedy@x' } });
  expect(r.status()).toBe(403);
  const users = await (await page.request.post('/api/getUsers', { data: {}, headers: ADMIN })).json();
  expect(users['greedy@x']).toBeUndefined();
});
