// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');

// A grant on a MIRROR DETAIL must actually let you edit that detail.
//
// `withMirrors()` is a transitive closure in both directions: from one detail it reaches the master and
// every sibling detail. `grantAllowsWrite` then demands write on ALL of them, and `.every()` means one
// missing table greys out the whole grid. That is right for add/delete/archive, which fan out across the
// cluster — deleting a meeting deletes its music row — and wrong for a cell edit, which does not:
// propagateMirror writes a mirror table only when a MIRRORED column's value actually changes, and the
// mirrored columns are already read-only in a detail. So the UI was refusing writes firestore.rules
// permits (hasTableWrite() asks about one table), and "may edit the music" could not be granted without
// also handing over write on the meetings table.
const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    // The master. Its details mirror `date` and `theme` from it.
    meetings: { columns: [
      { name: 'date', type: 'date' },
      { name: 'theme', type: 'text' }
    ] },
    music: { columns: [
      { name: 'date', type: 'date', syncFrom: 'meetings' },
      { name: 'theme', type: 'text', syncFrom: 'meetings' },
      { name: 'accompanist', type: 'text' },
      { name: 'hymn', type: 'text' }
    ] },
    // A SIBLING detail of the same master — the table that made the closure bite.
    interpreters: { columns: [
      { name: 'date', type: 'date', syncFrom: 'meetings' },
      { name: 'interpreter', type: 'text' }
    ] },
    // Unrelated to the cluster, and NOT granted: proves the new check is per-table, not "anything goes".
    notes: { columns: [{ name: 'body', type: 'text' }] }
  },
  views: [{ table: 'meetings' }, { table: 'music' }, { table: 'interpreters' }, { table: 'notes' }],
  nav: { items: [{ table: 'meetings' }, { table: 'music' }, { table: 'interpreters' }, { table: 'notes' }] }
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
// The same question the grid asks before rendering a cell editable.
const ro = (page, col, table) => page.evaluate(([c, t]) => {
  const a = window.appInstance;
  const row = (a.dataCache[t] || [])[0];
  return a.cellReadonly(row, c, t);
}, [col, table]);

test('a grant on one mirror detail opens that detail, and nothing else', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'meetings', tab: 'active', data: { id: 'm1', date: '2026-08-01', theme: 'Faith' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'music', tab: 'active', data: { id: 'm1', date: '2026-08-01', theme: 'Faith', accompanist: 'Ann', hymn: '19' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'interpreters', tab: 'active', data: { id: 'm1', date: '2026-08-01', interpreter: 'Bob' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'notes', tab: 'active', data: { id: 'n1', body: 'hello' } } });

  // First identity bootstraps as admin; use it to grant the member music + interpreters ONLY —
  // deliberately not the master, which is the shape that used to lock everything.
  await boot(page, 'boss@dev');
  expect(await page.evaluate(() => appInstance.isAdmin)).toBe(true);
  await page.request.post('/api/setUserRole', {
    data: { uid: 'kati@dev', role: 'editor', user: 'kati@dev', tables: { music: 'rw', interpreters: 'rw', meetings: 'r' } },
    headers: { 'X-User': 'boss@dev' }
  });

  await boot(page, 'kati@dev');
  expect(await page.evaluate(() => appInstance.isAdmin)).toBe(false);
  expect(await page.evaluate(() => appInstance.userWritableTables)).toEqual(['music', 'interpreters']);

  await open(page, 'music');
  // THE FIX: her own granted table is editable even though the cluster reaches tables she cannot write.
  expect(await ro(page, 'accompanist', 'music'), 'a granted detail table must be editable').toBe(false);
  expect(await ro(page, 'hymn', 'music')).toBe(false);

  // ...and the guard that keeps this from quietly opening the master: a MIRRORED column stays
  // read-only, so she can never reach `meetings` through the detail she was granted.
  expect(await ro(page, 'date', 'music'), 'a mirrored column must stay read-only').toBe(true);
  expect(await ro(page, 'theme', 'music'), 'a mirrored column must stay read-only').toBe(true);

  // The row CONTROLS keep the cluster rule: add/delete/archive fan out, so they stay withheld.
  expect(await page.evaluate(() => appInstance.hasMaster), 'music is a mirror detail').toBe(true);
  expect(await page.evaluate(() => appInstance.canMutateRows), 'row controls still require the whole cluster').toBe(false);

  // The sibling detail she was also granted is editable on its own terms.
  await open(page, 'interpreters');
  expect(await ro(page, 'interpreter', 'interpreters')).toBe(false);

  // A table she holds no grant on stays read-only — the check is per-table, not a blanket opening.
  await open(page, 'notes');
  expect(await ro(page, 'body', 'notes'), 'an ungranted table must stay read-only').toBe(true);

  // And the master, which she holds only READ on, stays read-only.
  await open(page, 'meetings');
  expect(await ro(page, 'theme', 'meetings'), 'a read-only grant must stay read-only').toBe(true);
});

test('the edit actually lands, and does not write the master', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'meetings', tab: 'active', data: { id: 'm1', date: '2026-08-01', theme: 'Faith' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'music', tab: 'active', data: { id: 'm1', date: '2026-08-01', theme: 'Faith', accompanist: 'Ann', hymn: '19' } } });

  await boot(page, 'boss@dev');
  await page.request.post('/api/setUserRole', {
    data: { uid: 'kati@dev', role: 'editor', user: 'kati@dev', tables: { music: 'rw', meetings: 'r' } },
    headers: { 'X-User': 'boss@dev' }
  });

  await boot(page, 'kati@dev');
  await open(page, 'music');
  // Save through the app's own path, so propagateMirror runs exactly as it would for a real edit.
  await page.evaluate(() => {
    const a = window.appInstance;
    const row = a.dataCache.music.find((r) => r.id === 'm1');
    a.saveField(row, 'accompanist', 'Kati');
  });
  await expect.poll(async () => {
    const r = await (await page.request.post('/api/getTableData',
      { data: { tableId: 'music', tab: 'active' }, headers: { 'X-User': 'boss@dev' } })).json();
    return (r.rows || []).find((x) => x.id === 'm1').accompanist;
  }, { timeout: 8000 }).toBe('Kati');

  // The master must be untouched: propagateMirror writes upstream only when a MIRRORED value changes,
  // and `accompanist` is not one. If this ever fails, the cluster rule was load-bearing after all.
  const meetings = await (await page.request.post('/api/getTableData',
    { data: { tableId: 'meetings', tab: 'active' }, headers: { 'X-User': 'boss@dev' } })).json();
  const master = (meetings.rows || []).find((r) => r.id === 'm1');
  expect(master.theme, 'the master was rewritten by a detail-only edit').toBe('Faith');
  expect(master.date).toBe('2026-08-01');
});
