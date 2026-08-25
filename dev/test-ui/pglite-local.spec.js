// pglite-local.spec.js — the "In this browser" backend, in a real browser.
//
// dev/test/backend-kv-pglite.test.js already drives the same stack in Node, and it is the faster place
// to assert what the policies do. What only a browser can establish is the half that test cannot reach,
// which is precisely the half that was new: the vendored ESM dist imports, the WebAssembly compiles
// under the app's ENFORCING Content-Security-Policy (the fixture starts the server with CSP=1), the
// cluster persists into IndexedDB, and the boot path in index.html wires all of it to app-core without
// a server having answered a single /api call.
//
// The dev server here is a plain static host as far as these tests are concerned. That is the point: it
// serves the same files GitHub Pages would, and nothing in this spec posts to /api.
const { test, expect } = require('./server-fixture');

// First boot fetches ~17 MB of WASM + data and then runs initdb and the whole policy file. That is well
// past the suite's 8s default and is not a hang.
test.describe.configure({ timeout: 180_000 });

// Enter the mode the way the setup dialog does: store the identity and the mode, then load index.html,
// which sees app_mode=pglite and loads storage-pglite + backend-kv + the platform file.
async function bootLocal(page, email = 'you@local') {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((e) => {
    localStorage.setItem('app_mode', 'pglite');
    localStorage.setItem('app_folder', 'pglite');
    localStorage.setItem('pglite_user', e);
  }, email);
  await page.goto('/');
  // The sidebar renders only once the schema is in hand, which here means Postgres started, the policies
  // applied, and the default schema was written and read back.
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 170_000 });
}

// The same boot, for a caller the policies will REFUSE. A non-member gets no schema and so no sidebar,
// which is the correct outcome and not something to wait for — wait for the backend to exist instead.
async function bootLocalAs(page, email) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((e) => { localStorage.setItem('pglite_user', e); }, email);
  await page.goto('/');
  await page.waitForFunction(() => !!(window.backend && window.backend_users), null, { timeout: 170_000 });
}

test('boots an app with no server, no account and no install', async ({ page }) => {
  const failures = [];
  page.on('console', (m) => { if (m.type() === 'error') failures.push(m.text()); });

  // Any /api request would mean the app fell back to the dev server — the one thing this mode must not
  // need. Recorded rather than blocked, so a failure names what was requested.
  const apiCalls = [];
  await page.route('**/api/**', (route) => { apiCalls.push(route.request().url()); route.continue(); });

  await bootLocal(page);

  await expect(page.locator('.v-app-bar-title')).not.toBeEmpty();
  expect(apiCalls, 'the local mode must not call the dev server').toEqual([]);
  // A CSP violation reports as a console error; the fixture runs the policy ENFORCING, so this is the
  // check that WebAssembly and the vendored ES module are actually allowed by it.
  expect(failures.filter((t) => /Content Security Policy|Refused to/i.test(t))).toEqual([]);

  // It really is Postgres, not a stand-in: ask the server itself.
  const version = await page.evaluate(() => window._pgStorage._query('select version()')
    .then((r) => r.rows[0].version));
  expect(version).toContain('PostgreSQL');
});

test('the database survives a reload, because it lives in IndexedDB', async ({ page }) => {
  await bootLocal(page);

  await page.evaluate(() => backend.putRow('probe', { id: 'p1', note: 'written before the reload' }, 'active'));

  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 170_000 });

  const rows = await page.evaluate(() => backend.getTableData('probe', 'active').then((d) => d.rows));
  expect(rows).toHaveLength(1);
  expect(rows[0].note).toBe('written before the reload');
});

test('asks the browser not to evict the database, and records the answer', async ({ page }) => {
  // Best-effort storage is deleted by the browser at its own discretion -- under disk pressure
  // everywhere, and on WebKit after a stretch without visits. Correct for a cache; catastrophic for the
  // only copy of somebody's data, which is what this backend holds. So the boot asks for persistence.
  //
  // What is asserted is the ASKING and the recording, not a grant. Headless Chromium refuses: it decides
  // from engagement signals (installed, bookmarked, revisited) and a fresh automated profile has none.
  // That refusal is the normal case for a first-time visitor, which is exactly why Settings surfaces the
  // state instead of the app assuming it won.
  await page.addInitScript(() => {
    window.__persistAsked = 0;
    var sm = navigator.storage, real = sm.persist.bind(sm);
    sm.persist = function () { window.__persistAsked++; return real(); };
  });
  await bootLocal(page);
  await page.waitForFunction(() => window.appInstance && window.appInstance.localStore.persisted !== null,
    null, { timeout: 20_000 });

  expect(await page.evaluate(() => window.__persistAsked), 'boot never requested persistent storage').toBeGreaterThan(0);
  expect(await page.evaluate(() => typeof window.appInstance.localStore.persisted)).toBe('boolean');
  expect(await page.evaluate(() => window.appInstance.localStore.usage), 'no storage estimate').toBeGreaterThan(0);
});

test('tells the user, in Settings, that the browser may evict a best-effort database', async ({ page }) => {
  // The half that matters to a person: a refused request must be visible and actionable, not swallowed.
  await bootLocal(page);
  await page.waitForFunction(() => window.appInstance && window.appInstance.localStore.persisted === false,
    null, { timeout: 20_000 });

  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
  await expect(page.getByTestId('local-store-besteffort')).toBeVisible();
  await expect(page.getByTestId('local-store-persist')).toBeVisible();
  await expect(page.getByTestId('local-store')).toContainText('Using');
});

test('the production access policy is enforcing, against the identity in localStorage', async ({ page }) => {
  await bootLocal(page, 'owner@local');

  // The first visitor closes bootstrap by registering. After that the policies have a real registry to
  // judge against — the same sequence a Supabase deployment goes through on its first sign-in.
  await page.evaluate(() => backend_users.setUserRole('owner@local', 'admin', 'owner@local', 'all'));
  await page.evaluate(() => backend.putRow('probe', { id: 'secret', note: 'admin only' }, 'active'));

  // Come back as somebody else. Nothing verified the first identity and nothing verifies this one — but
  // the policies still answer as they would in production, which is what this mode is for.
  await bootLocalAs(page, 'stranger@local');
  const access = await page.evaluate(() => backend_users.getMyAccess());
  expect(access.registered).toBe(false);

  const rows = await page.evaluate(() => backend.getTableData('probe', 'active').then((d) => d.rows));
  expect(rows, 'RLS must filter the rows a non-member reads').toEqual([]);

  const wrote = await page.evaluate(() => backend.putRow('probe', { id: 'x', note: 'nope' }, 'active')
    .then(() => 'ok', (e) => e.message));
  expect(wrote).toMatch(/row-level security/);
});

// The service worker (sw.js) calls clients.claim(), so it takes over the page part-way through boot --
// and requests a service worker re-issues are NOT visible to page.route(). Blocking it here is what lets
// the vendored dist be hidden at all; it has nothing to do with the behaviour under test.
test.describe('CDN fallback', () => {
  test.use({ serviceWorkers: 'block' });

  test('falls back to the CDN when the vendored dist is missing', async ({ page }) => {
    // /vendor/pglite is GENERATED, not committed, so a fork that never ran ./update-vendor.sh serves a
    // 404 here. Before the fallback existed that was a dead backend and an error message. Aborting the
    // request is what a missing artifact looks like to import().
    //
    // This reaches the real jsdelivr, so it is skipped where the offline suites run; that the CDN still
    // serves these files is checked by `npm run test:cdn`, a network-only CI job.
    test.skip(!!process.env.OFFLINE, 'needs network');

    const cdnHits = [];
    await page.route((u) => u.pathname.startsWith('/vendor/pglite/'), (route) => route.abort());
    page.on('request', (r) => { if (r.url().includes('jsdelivr') && r.url().includes('pglite')) cdnHits.push(r.url()); });

    await bootLocal(page);

    expect(cdnHits.length, 'nothing came from the CDN -- did the fallback fire?').toBeGreaterThan(0);
    // Not merely "a request was made": the fallback has to produce a working database, which means the
    // module's OWN relative fetches for pglite.wasm / pglite.data resolved against the CDN too -- the
    // part that needs jsdelivr in connect-src, and the part a naive fallback gets wrong.
    const version = await page.evaluate(() => window._pgStorage._query('select version()').then((r) => r.rows[0].version));
    expect(version).toContain('PostgreSQL');
  });
});
