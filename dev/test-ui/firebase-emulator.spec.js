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
  // The recorder has to be PROVED present before its emptiness means anything. `|| []` made a page that
  // never ran seed()'s init script -- so never attached the securitypolicyviolation listener -- look
  // exactly like a page with no violations, and this gate exists because a CSP regression once blocked
  // boot outright. An empty array from a listener that was never attached is not evidence of anything.
  const installed = await page.evaluate(() => Array.isArray(window.__cspViolations));
  expect(installed, 'the CSP violation recorder was never installed on this page — seed() not called?').toBe(true);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
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
  await page.evaluate((schema) => backend.saveSchema(schema), SCHEMA);
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
  await page.evaluate((schema) => backend.saveSchema(schema), SCHEMA);
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
  await expect(viewer.locator('[data-testid="page-edit"]')).toHaveCount(0);
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
  await page.evaluate((schema) => backend.saveSchema(schema), SCHEMA);
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

test('user-linked lists: avatar projection over Firestore — admin sees all links, a non-admin only shared, never an email', async ({ page }) => {
  test.setTimeout(60000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');                      // bootstrap admin
  await page.waitForFunction(() => appInstance.isAdmin === true);
  await page.evaluate(() => backend_users.setUserRole('viewer@test.com', 'viewer', 'viewer@test.com', []));

  // Two people set up their own profiles: Ann shares (with a photo), Cara does not.
  await signIn(page, 'ann@test.com');
  await page.evaluate(() => backend_users.setMyProfile('Ann', true, 'PIC_ANN'));
  await signIn(page, 'cara@test.com');
  await page.evaluate(() => backend_users.setMyProfile('Cara', false, 'PIC_CARA'));

  // Admin links both list values to their accounts, then reads the projection.
  await signIn(page, 'admin@test.com');
  const adminProj = await page.evaluate(async () => {
    await backend.setListUser('people', 'Ann', 'ann@test.com');
    await backend.setListUser('people', 'Cara', 'cara@test.com');
    return backend.getListAvatars();
  });
  expect(adminProj).toEqual({ people: { Ann: 'PIC_ANN', Cara: 'PIC_CARA' } });   // admin sees both

  // The registered viewer gets a projection with only the SHARED link, and no email anywhere.
  await signIn(page, 'viewer@test.com');
  const viewerProj = await page.evaluate(() => backend.getListAvatars());
  expect(viewerProj).toEqual({ people: { Ann: 'PIC_ANN' } });                    // Cara (unshared) hidden
  expect(JSON.stringify(viewerProj)).not.toContain('@');                         // never an email
  await expectNoCspViolations(page);
});

test('live sync: a write in one client reaches another through onSnapshot, unscoped and scoped', async ({ page, browser }) => {
  // The only end-to-end proof that backend-firebase subscribeTable works against real Firestore rules.
  // Both halves matter: the granted case (one unconstrained listener) and the self-service case, where
  // rules are not filters so the listener has to carry the same owner/rosterPublic constraints
  // _scopedRead uses — an unconstrained listener there is denied outright and simply never fires.
  test.setTimeout(90000);
  const OWNER_SCHEMA = {
    defaultLanguage: 'en',
    tables: {
      notes: { columns: [{ name: 'title', type: 'text' }] },
      signups: { ownerWritable: ['status'], columns: [{ name: 'owner', type: 'owner' }, { name: 'status', type: 'text' }] }
    },
    views: [],
    nav: { items: [{ table: 'notes' }, { table: 'signups' }] }
  };

  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');
  await page.waitForFunction(() => appInstance.isAdmin === true);
  await page.evaluate((schema) => backend.saveSchema(schema), OWNER_SCHEMA);
  await page.reload();
  await signIn(page, 'admin@test.com');
  await page.click('text=tab.notes');
  await page.waitForFunction(() => !!appInstance.dataCache.notes);

  // A second, independent client on the same table.
  const ctxB = await browser.newContext();
  try {
    const pageB = await ctxB.newPage();
    await seed(pageB);
    await pageB.goto('/');
    await signIn(pageB, 'admin@test.com');
    // No click needed: the app auto-selects the first table on boot, which is what subscribes it.
    await pageB.waitForFunction(() => appInstance.currentTable === 'notes' && !!appInstance.dataCache.notes);
    await pageB.waitForFunction(() => !!(appInstance._liveSubs || {})['notes__active']);

    // Granted table: client A writes, client B's cache updates with no refetch of its own.
    await page.evaluate(() => backend.putRow('notes', { id: 'n1', title: 'FromA' }, 'active'));
    await expect.poll(async () => pageB.evaluate(
      () => ((appInstance.dataCache.notes || []).find(r => r.id === 'n1') || {}).title
    ), { timeout: 15000 }).toBe('FromA');

    // A partial write merges on the stored row and arrives as a merged row, not a patch.
    await page.evaluate(() => backend.putRow('notes', { id: 'n1', title: 'PatchedByA' }, 'active'));
    await expect.poll(async () => pageB.evaluate(
      () => ((appInstance.dataCache.notes || []).find(r => r.id === 'n1') || {}).title
    ), { timeout: 15000 }).toBe('PatchedByA');

    // The GRID, not just the cache. Every assertion above reads dataCache, which the reconciler mutates
    // in place -- so all of them pass even if the debounced rebuild never runs and the screen never
    // changes. currentData is derived, so it is the only thing that catches that. Asserted in the
    // POSITIVE direction first: checking only that a row disappears would pass on a client whose grid
    // never had it, which is exactly how the first version of this assertion went green under mutation.
    await expect.poll(async () => pageB.evaluate(
      () => ((appInstance.currentData || []).find(r => r.id === 'n1') || {}).title
    ), { timeout: 15000 }).toBe('PatchedByA');

    // ARCHIVING reaches the other client, and moves it between partitions there.
    //
    // This changed shape entirely and nothing was watching. Archiving used to be a delete from the
    // active collection plus a create in the archive one, so a subscriber saw a DELETE and the row
    // simply vanished. It is a `_status` stamp now, which arrives as an ordinary PUT to the collection
    // the subscriber is already watching -- so the row has to stay in the cache and change PARTITION,
    // which is a different thing for the reconciler to get right. A regression here would look like an
    // archived row lingering in someone else's active list until they reloaded.
    await page.evaluate(() => backend.putRow('notes', { id: 'n1', _status: 'archive' }, 'active'));
    await expect.poll(async () => pageB.evaluate(
      () => window.Rows.partitionRows(appInstance.dataCache, 'notes', 'active').some(r => r.id === 'n1')
    ), { timeout: 15000 }).toBe(false);
    expect(await pageB.evaluate(
      () => window.Rows.partitionRows(appInstance.dataCache, 'notes', 'archive').some(r => r.id === 'n1')
    ), 'the archived row left the active partition without arriving in the archive one').toBe(true);
    // The row is still THERE -- carrying its other fields -- rather than having been dropped.
    expect(await pageB.evaluate(
      () => ((appInstance.dataCache.notes || []).find(r => r.id === 'n1') || {}).title
    )).toBe('PatchedByA');
    // ...and having arrived in the grid, it leaves when archived.
    await expect.poll(async () => pageB.evaluate(
      () => (appInstance.currentData || []).some(r => r.id === 'n1')
    ), { timeout: 15000 }).toBe(false);

    // And restoring it comes back the same way.
    await page.evaluate(() => backend.putRow('notes', { id: 'n1', _status: 'active' }, 'active'));
    await expect.poll(async () => pageB.evaluate(
      () => window.Rows.partitionRows(appInstance.dataCache, 'notes', 'active').some(r => r.id === 'n1')
    ), { timeout: 15000 }).toBe(true);

    // A delete propagates too.
    await page.evaluate(() => backend.deleteRow('notes', 'n1', 'active'));
    await expect.poll(async () => pageB.evaluate(
      () => (appInstance.dataCache.notes || []).some(r => r.id === 'n1')
    ), { timeout: 15000 }).toBe(false);

    // Self-service half: a member with NO grant on `signups` subscribes through the two constrained
    // queries. Their own row must reach them live.
    await page.evaluate(() => backend_users.setUserRole('member@test.com', 'viewer', 'member@test.com', {}));
    const ctxC = await browser.newContext();
    try {
      const pageC = await ctxC.newPage();
      await seed(pageC);
      await pageC.goto('/');
      await signIn(pageC, 'member@test.com');
      await pageC.evaluate(() => appInstance._liveWatch(['signups'], 'active'));
      // The member writes their own owner-stamped row from a plain backend call; the listener they
      // opened on the same table has to deliver it back.
      await pageC.evaluate(() => {
        if (!appInstance.dataCache.signups) appInstance.dataCache.signups = [];
        return backend.putRow('signups', { id: 's1', owner: 'member@test.com', status: 'yes', rosterPublic: true }, 'active');
      });
      await expect.poll(async () => pageC.evaluate(
        () => ((appInstance.dataCache.signups || []).find(r => r.id === 's1') || {}).status
      ), { timeout: 15000 }).toBe('yes');
    } finally { await ctxC.close(); }

    await expectNoCspViolations(pageB);
  } finally { await ctxB.close(); }
  await expectNoCspViolations(page);
});

test('a viewed table is read ONCE: the listener first snapshot is the load, not a second fetch', async ({ page }) => {
  // Firestore bills a read per document in a listener's FIRST snapshot. The app fetched a table and
  // then subscribed to it, so every table a view opened was paid for twice, in full. The listener now
  // delivers that first snapshot as the load.
  //
  // Asserted by watching getTableData rather than by counting reads, which the client cannot see: if
  // the adapter is asked for the rows at all, the second read happened.
  test.setTimeout(60000);
  await seed(page);
  await page.goto('/');
  await signIn(page, 'admin@test.com');
  await page.waitForFunction(() => appInstance.isAdmin === true);
  await page.evaluate((schema) => backend.saveSchema(schema), SCHEMA);
  await page.evaluate(() => backend.putRow('notes', { id: 'n9', title: 'FromSnapshot' }, 'active'));
  await page.reload();
  await signIn(page, 'admin@test.com');

  // Record every table the adapter is asked to fetch, from before the view opens.
  await page.evaluate(() => {
    window.__fetched = [];
    const real = backend.getTableData.bind(backend);
    backend.getTableData = function (tableId, tab, opts) { window.__fetched.push(tableId); return real(tableId, tab, opts); };
  });

  await page.click('text=tab.notes');
  await expect.poll(async () => page.evaluate(
    () => ((appInstance.dataCache.notes || []).find(r => r.id === 'n9') || {}).title
  ), { timeout: 15000 }).toBe('FromSnapshot');

  // The rows arrived, and nobody fetched them.
  const fetched = await page.evaluate(() => window.__fetched);
  expect(fetched, 'notes was fetched as well as subscribed — the table was read twice').not.toContain('notes');
  expect(await page.evaluate(() => backend.subscribeLoads)).toBe(true);
});
