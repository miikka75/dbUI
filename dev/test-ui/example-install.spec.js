// example-install.spec.js — installing a shipped example from inside the browser.
//
// The claim under test is that examples/ is reachable BY THE RUNNING APP: same origin, no CORS, and
// legal under the enforcing Content-Security-Policy (the fixture serves with CSP=1, so a blocked
// fetch here would fail the test rather than silently look like an empty manifest in production).
//
// Then the two things the feature exists for: an empty database offers the examples rather than
// leaving a blank nav, and a database that installed one is told when the deployment's copy moves on.
const { test, expect } = require('./server-fixture');
const MANIFEST = require('../../examples/index.json');

// A database with NO schema — which is exactly what setup leaves behind (it writes the empty default
// and reloads). No saveSchema call here, deliberately.
async function emptyApp(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post('/api/resetData');
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 20000 });
}

test('the manifest and every file it names are fetchable from the app itself', async ({ page }) => {
  await emptyApp(page);
  const fetched = await page.evaluate(() => window.appInstance.fetchExampleManifest());
  expect(fetched.bundles.map((b) => b.id).sort()).toEqual(MANIFEST.bundles.map((b) => b.id).sort());

  // Every file, not just the index: a bundle whose language pack 404s installs as raw keys.
  const names = [...MANIFEST.appLanguages.map((l) => l.file)];
  for (const b of MANIFEST.bundles) {
    names.push(b.schema.file, ...b.languages.map((l) => l.file));
    if (b.data) names.push(b.data.file);
  }
  for (const name of names) {
    const res = await page.request.get('/examples/' + name);
    expect(res.status(), name).toBe(200);
  }
});

test('an empty database offers the examples, and installing one fills it', async ({ page }) => {
  test.setTimeout(120000);
  await emptyApp(page);

  await expect(page.locator('[data-testid="empty-db-offer"]')).toBeVisible();
  await page.locator('[data-testid="empty-db-examples"]').click();
  await expect(page.locator('[data-testid="example-picker"]')).toBeVisible();

  // The chores bundle: small, and the only one shipping sample rows AND a single language, so the
  // assertions below stay about the mechanism rather than about which files happen to exist.
  await page.locator('[data-testid="example-chores"]').click();
  await expect(page.locator('[data-testid="example-with-data"]')).toBeVisible();

  // The import RELOADS when it finishes, and the schema lands in the running app several steps before
  // that — so a plain "does it have tables yet" wait reads a half-applied database. Mark this document
  // and wait for the mark to be gone.
  await page.evaluate(() => { window.__beforeInstall = true; });
  await page.locator('[data-testid="example-install"]').click();
  await expect(page.locator('[data-testid="import-progress"]')).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => !window.__beforeInstall && window.appInstance && !appInstance.loading,
    { timeout: 60000 });

  const state = await page.evaluate(() => ({
    tables: Object.keys(appInstance.schemaData.tables),
    title: appInstance.t('app.title'),
    example: appInstance.appConfig.example
  }));
  expect(state.tables).toContain('chore_log');
  expect(state.title).toBe('Our Home');                 // its own language pack landed, not raw keys

  // The sample rows, read from the server rather than from a view the test would have to open.
  const data = await (await page.request.post('/api/getTableData', { data: { tableId: 'chore_log', tab: 'active' } })).json();
  expect(data.rows.length).toBeGreaterThan(0);

  // Provenance: what was installed, and the fingerprints a later merge needs.
  expect(state.example.bundle).toBe('chores');
  expect(Object.keys(state.example.files)).toContain('chores-schema.json');
  expect(Object.keys(state.example.files)).toContain('app-lang-en.json');
  expect(state.example.units['views/_tree']).toBeTruthy();
  expect(state.example.units['tables/chore_log/columns/person']).toBeTruthy();
});

test('Settings reports an example the deployment has moved on from', async ({ page }) => {
  test.setTimeout(60000);
  await emptyApp(page);

  // Install by hand — the point here is the NOTICE, so skip the picker and write the provenance a
  // real install would have written, with one file's hash deliberately stale.
  await page.evaluate(async () => {
    const manifest = await appInstance.fetchExampleManifest();
    const chores = manifest.bundles.find((b) => b.id === 'chores');
    const files = Examples.fileHashes(chores, manifest);
    files['chores-schema.json'] = 'staleaaaaaaaaaaa';
    appInstance.appConfig = Object.assign({}, appInstance.appConfig, {
      example: { bundle: 'chores', revision: 1, files: files, units: {} }
    });
  });

  await page.evaluate(() => appInstance.selectTab('__settings'));
  const notice = page.locator('[data-testid="example-update"]');
  await expect(notice).toBeVisible({ timeout: 10000 });
  await expect(notice).toContainText('chores-schema.json');
  await expect(notice).toContainText('Our Home');

  // Acting on it opens the picker with that bundle chosen and its sample rows OFF — a database in use
  // must not have demo rows laid back over it.
  await page.locator('[data-testid="example-update-apply"]').click();
  await expect(page.locator('[data-testid="example-picker"]')).toBeVisible();
  expect(await page.evaluate(() => appInstance.examples.pick.id)).toBe('chores');
  expect(await page.evaluate(() => appInstance.examples.withData)).toBe(false);
});
