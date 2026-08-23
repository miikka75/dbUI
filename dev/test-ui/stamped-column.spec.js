// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');

// The server refuses a write to a stamped column from anyone but an admin. The UI half of that is not
// decoration: an editable-looking cell here produces a refused write, or worse an optimistic value
// that never lands, and the user is left with a grid that disagrees with the database.
const SCHEMA = {
  defaultLanguage: 'en',
  listSources: { members: 'userlink' },
  tables: {
    shopping: {
      columns: [
        { name: 'item', type: 'text' },
        { name: 'qty', type: 'text' },
        { name: 'added_by', type: 'select', list: 'members', defaultFrom: '@me', stamped: true }
      ]
    },
    plain: { columns: [{ name: 'item', type: 'text' }, { name: 'added_by', type: 'select', list: 'members' }] }
  },
  views: [{ table: 'shopping' }, { table: 'plain' }],
  nav: { items: [{ table: 'shopping' }, { table: 'plain' }] }
};

async function boot(page, user) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/' + (user ? '?user=' + encodeURIComponent(user) : ''));
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
const open = async (page, name) => {
  await page.evaluate((n) => window.appInstance.selectTab(n), name);
  await page.waitForFunction((n) => {
    const a = window.appInstance;
    return a && !a.loading && (a._viewTables(n) || []).every((t) => Array.isArray(a.dataCache[t]));
  }, name, { timeout: 10000 });
};
// Ask the app the same question the grid asks before it renders a cell editable.
const ro = (page, col, table) => page.evaluate(([c, t]) => {
  const a = window.appInstance;
  const row = (a.dataCache[t] || [])[0];
  return a.cellReadonly(row, c, t);
}, [col, table]);

test('a stamped column is read-only for a member, and editable for an admin', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/saveLists', { data: { lists: { members: ['Ann', 'Bob'] } } });
  await page.request.post('/api/putRow', { data: { tableId: 'shopping', tab: 'active', data: { id: 's1', item: 'Milk', qty: '2', added_by: 'Bob' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'plain', tab: 'active', data: { id: 'p1', item: 'Bread', added_by: 'Bob' } } });

  // The first identity to sign in bootstraps as admin.
  await boot(page, 'boss@dev');
  expect(await page.evaluate(() => appInstance.isAdmin), 'first identity should bootstrap admin').toBe(true);
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@dev', role: 'editor', user: 'ann@dev', tables: { shopping: 'rw', plain: 'rw' } }, headers: { 'X-User': 'boss@dev' } });
  await page.request.post('/api/setListUser', { data: { listName: 'members', value: 'Ann', email: 'ann@dev' }, headers: { 'X-User': 'boss@dev' } });

  await open(page, 'shopping');
  expect(await ro(page, 'added_by', 'shopping'), 'an admin can correct a wrong stamp').toBe(false);
  expect(await ro(page, 'item', 'shopping'), 'an ordinary column stays editable').toBe(false);

  // ...and now as an ordinary member holding a WRITE grant on the table. That grant is exactly what
  // makes `ownerWritable` inert, so if the cell is read-only here it is `stamped` doing it.
  await boot(page, 'ann@dev');
  expect(await page.evaluate(() => appInstance.isAdmin)).toBe(false);
  await open(page, 'shopping');
  expect(await ro(page, 'added_by', 'shopping'), 'THE POINT: a stamped column is read-only despite an rw grant').toBe(true);
  expect(await ro(page, 'item', 'shopping'), 'the rest of the row stays editable — the sharing is the point').toBe(false);
  expect(await ro(page, 'qty', 'shopping')).toBe(false);

  // A column with the same name on a table that does NOT declare `stamped` is untouched (opt-in).
  await open(page, 'plain');
  expect(await ro(page, 'added_by', 'plain'), 'the bound leaked to a table that never asked for it').toBe(false);
});
