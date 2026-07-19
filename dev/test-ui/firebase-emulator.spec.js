// firebase-emulator.spec.js — Boots the REAL app in Firebase mode against the emulator suite
// (auth + firestore + storage) via the app's own opt-in emulator wiring
// (localStorage.firebase_emulators='1' + loopback host, see backend-firebase.js _useEmulators).
//
// Run via: npm run test:e2e-firebase   (firebase emulators:exec wraps this spec)
// A plain `npx playwright test` AUTO-SKIPS these tests when the emulators aren't running, so the
// default suite stays green without them.
//
// This is the only end-to-end coverage of the Firebase adapter + security rules + loader working
// together: bootstrap-admin registration, schema/data round-trips through Firestore, the Storage
// upload path through the cross-service registration gate, and the restricted-viewer _pages fix.
const { test, expect } = require('@playwright/test');

const PROJECT = 'demo-app';
const FS = 'http://127.0.0.1:8080';
const AUTH = 'http://127.0.0.1:9099';
const OWNER = { Authorization: 'Bearer owner' }; // emulator admin bypass for REST verification

// Minimal self-contained schema: one plain table (with an image column for the Storage test), an
// untagged doc-view (readable by all — the _pages restricted-read test), and a doc-view gated on the
// `notes` grant via `access` (the per-page access test). `nav` is required.
const SCHEMA = {
  defaultLanguage: 'en',
  tables: { notes: { columns: [{ name: 'title', type: 'text' }, { name: 'photo', type: 'image' }] } },
  views: [
    { name: 'handbook', markdown: 'SEED-BODY' },
    { name: 'secret_page', markdown: 'SEED-SECRET', access: ['notes'] }
  ],
  nav: { items: [{ table: 'notes' }, { view: 'handbook' }, { view: 'secret_page' }] }
};

let emulatorsUp = false;
test.beforeAll(async () => {
  try { emulatorsUp = (await fetch(AUTH + '/')).ok; } catch (e) { emulatorsUp = false; }
});

test.beforeEach(async () => {
  test.skip(!emulatorsUp, 'firebase emulators not running — use `npm run test:e2e-firebase`');
  // Fresh emulator state per test (storage objects keep unique ts-prefixed names; no wipe needed).
  await fetch(FS + `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  await fetch(AUTH + `/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
});

// Seed the pre-boot localStorage that puts the app in Firebase-emulator mode, and record any
// Content-Security-Policy violations (the dev server ENFORCES the policy under CSP=1 — a violated
// directive that doesn't happen to break a flow would otherwise pass unnoticed).
function seed(page) {
  return page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(e.violatedDirective + ' <- ' + e.blockedURI);
    });
    localStorage.setItem('app_mode', 'firebase');
    localStorage.setItem('firebase_config', JSON.stringify({
      apiKey: 'demo-key', projectId: 'demo-app',
      authDomain: 'demo-app.firebaseapp.com', storageBucket: 'demo-app.appspot.com'
    }));
    localStorage.setItem('firebase_emulators', '1');
  });
}

async function expectNoCspViolations(page) {
  expect(await page.evaluate(() => window.__cspViolations || [])).toEqual([]);
}

// Sign in against the AUTH EMULATOR with a mock Google credential (the emulator accepts an unsigned
// JSON claims blob as the idToken — no popup UI to automate). onAuthStateChanged then runs the
// app's real init() -> startApp() path.
async function signIn(page, email) {
  // Wait for initializeApp (backend-firebase.js runs AFTER app-core/appInstance): firebase.auth
  // existing only means the SDK loaded — calling firebase.auth() before the app exists throws.
  await page.waitForFunction(() => typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0 && !!window.appInstance, null, { timeout: 20000 });
  await page.evaluate((email) => {
    var cred = firebase.auth.GoogleAuthProvider.credential(JSON.stringify({ sub: email.replace(/\W/g, ''), email: email, email_verified: true }));
    return firebase.auth().signInWithCredential(cred);
  }, email);
  await page.waitForFunction(() => window.appInstance && appInstance.usersLoaded && !appInstance.loading, null, { timeout: 20000 });
}

async function fsDoc(path) {
  const r = await fetch(FS + `/v1/projects/${PROJECT}/databases/(default)/documents/` + path, { headers: OWNER });
  return r.ok ? r.json() : null;
}

test('bootstrap: first sign-in registers admin and saves the default schema', async ({ page }) => {
  test.setTimeout(45000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');

  // Bootstrap made us admin (client state) and persisted the registration (server state).
  await page.waitForFunction(() => appInstance.isAdmin === true);
  const userDoc = await fsDoc('_users/admin@test.com');
  expect(userDoc && userDoc.fields.role.stringValue).toBe('admin');
  const legacyMap = await fsDoc('_meta/users');   // mirrored for the rules' legacy fallback
  expect(legacyMap).toBeTruthy();
  const schemaDoc = await fsDoc('_meta/schema');  // first boot saves the bundled default schema
  expect(schemaDoc).toBeTruthy();
  await expectNoCspViolations(page);
});

test('admin: schema seed, grid add-row round-trip, image upload through Storage', async ({ page }) => {
  test.setTimeout(60000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');
  await page.waitForFunction(() => appInstance.isAdmin === true);

  // Seed the fixture schema through the real adapter (also writes _meta/ownerTables), then reboot.
  await page.evaluate((schema) => backend.saveSchema('', schema), SCHEMA);
  await page.reload();
  await signIn(page, 'admin@test.com'); // session persists, but wait for the re-boot to settle

  // The notes table renders from Firestore; add a row through the grid.
  await page.click('text=tab.notes');
  await page.click('button:has(.mdi-plus)');
  const cell = page.locator('.v-table tbody tr:last-child .editable-cell').first();
  await cell.click();
  await cell.fill('hello firestore');
  await cell.blur();
  // The row lands in notes__active (saveField debounce is 300ms).
  await expect.poll(async () => {
    const r = await fetch(FS + `/v1/projects/${PROJECT}/databases/(default)/documents/notes__active`, { headers: OWNER });
    const d = await r.json();
    return JSON.stringify(d.documents || []);
  }, { timeout: 10000 }).toContain('hello firestore');

  // Image upload: through Firebase Storage, past the cross-service REGISTRATION gate (storage.rules
  // firestore.exists lookup), resolving to an emulator download URL stored on the row.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: png });
  const thumb = page.locator('img.cell-thumb').first();
  await expect(thumb).toBeVisible({ timeout: 15000 });
  const src = await thumb.getAttribute('src');
  expect(src).toContain('127.0.0.1:9199'); // served by the storage emulator
  await expectNoCspViolations(page);
});

test('zero-grant viewer: sees the EDITED page body (not the schema seed), no edit controls, no tables', async ({ page, browser }) => {
  test.setTimeout(60000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');
  await page.waitForFunction(() => appInstance.isAdmin === true);
  await page.evaluate((schema) => backend.saveSchema('', schema), SCHEMA);
  // Admin edits the doc body (server-side _pages store) and registers a viewer with NO grants.
  await page.evaluate(() => backend.putRow('_pages', { id: 'handbook', markdown: 'EDITED-BODY' }, 'active'));
  await page.evaluate(() => backend_users.setUserRole('viewer@test.com', 'viewer', 'viewer@test.com', []));

  // A raw newContext does not inherit the config baseURL — derive the origin from the admin page.
  const ctx = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const viewer = await ctx.newPage();
  await seed(viewer);
  await viewer.goto('/');
  await signIn(viewer, 'viewer@test.com');

  // Nav model: the doc view is reachable without table grants; the ungranted table is not.
  await viewer.waitForFunction(() => window.appInstance && appInstance.sidebarTabs.some(t => t.id === 'handbook'), null, { timeout: 15000 });
  const tabs = await viewer.evaluate(() => appInstance.sidebarTabs.filter(t => !t.divider).map(t => t.id));
  expect(tabs).toContain('handbook');
  expect(tabs).not.toContain('notes');

  // The EDITED body must render (the _pages rules fix — previously the Firestore read was denied and
  // the stale schema seed silently showed instead). selectTab avoids drawer-overlay click flake.
  await viewer.evaluate(() => appInstance.selectTab('handbook'));
  await expect(viewer.locator('text=EDITED-BODY')).toBeVisible({ timeout: 15000 });
  await expect(viewer.locator('text=SEED-BODY')).toHaveCount(0);
  // No edit controls for a viewer (canEditPages gate).
  await expect(viewer.locator('button:has-text("Edit")')).toHaveCount(0);
  // Per-page access: secret_page is gated on the `notes` grant, which this viewer lacks -> not in nav.
  expect(tabs).not.toContain('secret_page');
  await expectNoCspViolations(viewer);
  await ctx.close();
});

test('per-page access: gated doc-view is hidden + read-denied without the grant, visible with it', async ({ page, browser }) => {
  test.setTimeout(60000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');
  await page.waitForFunction(() => appInstance.isAdmin === true);
  await page.evaluate((schema) => backend.saveSchema('', schema), SCHEMA);
  // Admin edits the gated page's body and registers two users: one granted `notes`, one with nothing.
  await page.evaluate(() => backend.putRow('_pages', { id: 'secret_page', markdown: 'EDITED-SECRET' }, 'active'));
  await page.evaluate(() => backend_users.setUserRole('member@test.com', 'editor', 'member@test.com', ['notes']));
  await page.evaluate(() => backend_users.setUserRole('nobody@test.com', 'viewer', 'nobody@test.com', []));
  const origin = new URL(page.url()).origin;

  // Granted member: page IS in nav and the EDITED body renders (single-doc read authorized by the rule).
  const ctxM = await browser.newContext({ baseURL: origin });
  const member = await ctxM.newPage();
  await seed(member);
  await member.goto('/');
  await signIn(member, 'member@test.com');
  await member.waitForFunction(() => window.appInstance && appInstance.usersLoaded && !appInstance.loading, null, { timeout: 15000 });
  let mtabs = await member.evaluate(() => appInstance.sidebarTabs.filter(t => !t.divider).map(t => t.id));
  expect(mtabs).toContain('secret_page');
  await member.evaluate(() => appInstance.selectTab('secret_page'));
  await expect(member.locator('text=EDITED-SECRET')).toBeVisible({ timeout: 15000 });
  await ctxM.close();

  // No-grant user: page is NOT in nav, and a direct single-doc read is denied by the rule (so even a
  // forced navigation can't reveal the edited body — it falls back to the non-secret schema seed).
  const ctxN = await browser.newContext({ baseURL: origin });
  const nobody = await ctxN.newPage();
  await seed(nobody);
  await nobody.goto('/');
  await signIn(nobody, 'nobody@test.com');
  await nobody.waitForFunction(() => window.appInstance && appInstance.usersLoaded && !appInstance.loading, null, { timeout: 15000 });
  const ntabs = await nobody.evaluate(() => appInstance.sidebarTabs.filter(t => !t.divider).map(t => t.id));
  expect(ntabs).not.toContain('secret_page');
  const denied = await nobody.evaluate(() => backend.getPage('secret_page').then(p => (p && p.markdown) || null));
  expect(denied).toBeNull();   // rule denied the read -> getPage resolves null, never the edited body
  await ctxN.close();
});
