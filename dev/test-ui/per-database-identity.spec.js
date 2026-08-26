// Per-database PWA identity: two databases on one deployment install as TWO apps.
//
// A web app IS its manifest `id` (its `start_url` in a browser too old for `id`). Both used to be the
// origin root for every database this deployment serves, so two databases installed as one app — it
// wore whichever icon was active at install time, and launching it opened whichever database
// localStorage happened to hold. The second half of the same problem: the config lived in ONE key per
// backend, so a browser profile could only hold one database at a time anyway.
//
// These assert the two halves against the real app: the manifest the browser would install, and the
// storage two databases share.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

// Read the manifest the app actually published. It is a blob URL built at runtime, so fetch it from
// inside the page rather than reasoning about what _updateManifest should have done.
async function liveManifest(page) {
  return page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return null;
    const r = await fetch(link.href);
    return r.json();
  });
}

async function bootLocal(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
}

test.describe('per-database PWA identity', () => {
  test('the manifest declares an id, and it names the database', async ({ page }) => {
    await bootLocal(page);
    const m = await liveManifest(page);
    expect(m, 'no runtime manifest was published').toBeTruthy();
    // `id` is what a modern browser compares. Without it the browser falls back to start_url — which
    // is why the key goes in both, and why asserting only one of them would miss half the fix.
    expect(m.id).toContain('db=local');
    expect(m.start_url).toBe(m.id);
  });

  test('scope stays the bare base, because the code really is shared', async ({ page }) => {
    // start_url must be inside scope or the manifest is invalid and the install silently degrades.
    await bootLocal(page);
    const m = await liveManifest(page);
    expect(m.scope.endsWith('?db=local')).toBe(false);
    expect(m.start_url.startsWith(m.scope)).toBe(true);
  });

  test('two databases produce two identities', async ({ page }) => {
    // The actual claim. Same origin, same code, same manifest link — different app.
    await bootLocal(page);
    const first = (await liveManifest(page)).id;

    // Adopt a second database (a Firebase project, which is what a shared link carries) and re-publish.
    const second = await page.evaluate(async () => {
      Databases.remember('firebase', { projectId: 'other-project', apiKey: 'k' });
      appInstance._updateManifest();
      const r = await fetch(document.querySelector('link[rel="manifest"]').href);
      return (await r.json()).id;
    });
    expect(second).not.toBe(first);
    expect(second).toContain('firebase%3Aother-project');
  });

  test('a profile holds both databases at once', async ({ page }) => {
    // The half that made the identity fix usable: connecting to a second database used to OVERWRITE
    // the first, so there was never anything to switch back to.
    await bootLocal(page);
    const held = await page.evaluate(() => {
      Databases.remember('firebase', { projectId: 'alpha', apiKey: 'k1' });
      Databases.remember('firebase', { projectId: 'beta', apiKey: 'k2' });
      return { keys: Databases.list().map((d) => d.key), active: Databases.activeKey() };
    });
    expect(held.keys).toContain('firebase:alpha');
    expect(held.keys).toContain('firebase:beta');
    expect(held.active).toBe('firebase:beta');
  });

  test('?db= selects the database before any backend loads', async ({ page }) => {
    // How an installed app says which one it is: the manifest start_url carries ?db=<key>, the browser
    // opens that URL, and index.html switches before it picks a backend file. Asserted by landing on
    // the URL and reading what boot settled on — not by calling setActive directly, which would test
    // the module rather than the wiring.
    await bootLocal(page);
    await page.evaluate(() => Databases.remember('firebase', { projectId: 'gamma', apiKey: 'k' }));
    // Back to a database that boots without a real Firebase SDK, then in through the installed-app URL.
    await page.goto('/?db=local');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('app_db'))).toBe('local');
    expect(await page.evaluate(() => localStorage.getItem('app_mode'))).toBe('local');
    // And the selector is stripped with the rest of the params, so a refresh does not re-apply it —
    // it does not need to, because the choice is persisted.
    expect(await page.evaluate(() => location.search)).toBe('');
  });

  test('a ?db= key this profile does not hold is ignored, not trusted', async ({ page }) => {
    // The parameter NAMES a database, it does not carry one. Acting on an unknown key would leave the
    // app pointing at nothing, so an unknown key must leave the current choice alone.
    await bootLocal(page);
    const before = await page.evaluate(() => localStorage.getItem('app_db'));
    await page.goto('/?db=firebase%3Asomebody-elses-project');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('app_db'))).toBe(before);
  });

  test('Settings lists every database this profile holds, and forgetting drops one', async ({ page }) => {
    // Storage nothing can list is storage nobody can reach: the per-database layout is only useful if
    // there is a way back to a database whose shared link you no longer have.
    await bootLocal(page);
    await page.evaluate(() => {
      Databases.remember('firebase', { projectId: 'alpha', apiKey: 'k1' });
      Databases.setActive('local');   // back to the one this fixture can actually boot
    });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();

    const rows = page.locator('[data-testid="database-list"] .v-list-item');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'alpha' })).toHaveCount(1);

    // Forgetting a NON-active database drops the stored config without reloading — the database itself
    // is untouched, and a shared link brings it back.
    await rows.filter({ hasText: 'alpha' }).locator('button', { hasText: 'settings.forget' }).click();
    expect(await page.evaluate(() => Databases.list().map((d) => d.key))).toEqual(['local']);
  });

  test('the list stays hidden while there is only one database', async ({ page }) => {
    // A picker with one entry is noise on the settings page of every ordinary user, who will only ever
    // have one.
    await bootLocal(page);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    await expect(page.locator('[data-testid="database-list"]')).toHaveCount(0);
  });

  test('an existing single-key install migrates without changing database', async ({ page }) => {
    // Everyone upgrading arrives with a `firebase_config` key and no `db.` records. Migration must
    // fold it in and leave them looking at the same database — not at the setup screen.
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.addInitScript(() => {
      localStorage.setItem('app_mode', 'firebase');
      localStorage.setItem('firebase_config', JSON.stringify({ projectId: 'legacy-app', apiKey: 'k' }));
    });
    await page.route(/gstatic\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto('/');
    await page.waitForFunction(() => localStorage.getItem('app_db') != null, null, { timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('app_db'))).toBe('firebase:legacy-app');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('db.firebase:legacy-app')).config.projectId)).toBe('legacy-app');
    // The legacy key is deliberately left in place: a downgrade, or a tab still running the old code,
    // would otherwise find nothing and show the setup screen for a database the user still has.
    expect(await page.evaluate(() => localStorage.getItem('firebase_config'))).not.toBeNull();
  });
});
