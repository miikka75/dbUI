const { test, expect } = require('@playwright/test');
const SCHEMA = require('./fixture-schema.json');

// The end-to-end claim of live sync, tested the only way it can honestly be tested: TWO clients.
// One edits, the other must show it without touching anything — and, just as importantly, must NOT be
// disturbed mid-edit by a change arriving from elsewhere.
//
// Every test boots the app TWICE and then waits on a propagation, so the suite-wide 8s budget doesn't
// fit. Raised only for this file.
test.describe.configure({ timeout: 40000 });

let _consoleErrors = [];
test.beforeEach(({ page }) => {
  _consoleErrors = [];
  page.on('pageerror', e => _consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|\b404\b|net::ERR|ERR_/.test(m.text())) _consoleErrors.push('console: ' + m.text()); });
});
test.afterEach(() => { expect(_consoleErrors, 'console/page errors during test').toEqual([]); });

// `notes` is the addable master table the rest of the E2E suite uses. Its `title` and `content` are
// plain text columns, so both render as contenteditable cells — two independent columns on one row is
// exactly what the clobber test needs.
const TITLE = 0, CONTENT = 1;
const cell = (page, i) => page.locator('.v-table tbody tr').first().locator('.editable-cell').nth(i);

async function openNotes(page, seed) {
  await page.setViewportSize({ width: 1280, height: 800 });
  if (seed) {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.request.post('/api/putRow', { data: { tableId: 'notes', tab: 'active', data: { id: 'lv1', title: 'Original', content: 'Body' } } });
  }
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
  await page.waitForSelector('.v-table tbody tr', { timeout: 6000 });
}

// Type a value into a contenteditable cell and commit it (blur fires the 300ms debounced write).
async function typeInto(page, index, text) {
  const c = cell(page, index);
  await c.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type(text);
  await c.blur();
}

test.describe('Live sync between two clients', () => {
  test('an edit in one client appears in the other with no reload and no refresh click', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await openNotes(pageA, true);
      await openNotes(pageB, false);
      await expect(pageB.locator('.v-table')).toContainText('Original');

      await typeInto(pageA, TITLE, 'EditedByA');

      // B updates on its own. No reload, no refresh button — that is the whole point.
      await expect(pageB.locator('.v-table')).toContainText('EditedByA', { timeout: 10000 });
      await expect(pageB.locator('.v-table')).not.toContainText('Original');
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });

  test('a row added in one client appears in the other', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await openNotes(pageA, true);
      await openNotes(pageB, false);
      await expect(pageB.locator('.v-table tbody tr')).toHaveCount(1);

      await pageA.request.post('/api/putRow', { data: { tableId: 'notes', tab: 'active', data: { id: 'lv2', title: 'AddedRemotely' } } });
      await expect(pageB.locator('.v-table')).toContainText('AddedRemotely', { timeout: 10000 });
      await expect(pageB.locator('.v-table tbody tr')).toHaveCount(2);
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });

  test('a row deleted in one client disappears from the other', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await openNotes(pageA, true);
      await openNotes(pageB, false);
      await expect(pageB.locator('.v-table')).toContainText('Original');

      await pageA.request.post('/api/deleteRow', { data: { tableId: 'notes', tab: 'active', id: 'lv1' } });
      await expect(pageB.locator('.v-table tbody tr')).toHaveCount(0, { timeout: 10000 });
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });

  test('a remote change does NOT overwrite the cell the user is typing in — it lands on blur', async ({ browser }) => {
    // The reason live sync needed a hold gate at all. The inline cell has no draft buffer: it renders
    // {{ item[col] }} straight off the cached row object, so an unguarded remote write would repaint
    // the text under the caret mid-word.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await openNotes(pageA, true);
      await openNotes(pageB, false);

      // B starts editing `content` and leaves the caret in it — deliberately NOT blurring.
      const bCell = cell(pageB, CONTENT);
      await bCell.click();
      await pageB.keyboard.press('Control+a');
      await pageB.keyboard.type('TypingInB');

      // Meanwhile A changes the same row's `title` from outside.
      await pageA.request.post('/api/putRow', { data: { tableId: 'notes', tab: 'active', data: { id: 'lv1', title: 'ChangedByA' } } });
      await pageB.waitForTimeout(2000);   // far past the 150ms rebuild debounce

      // The half-typed text is intact and still focused; the remote change is being held, not applied.
      await expect(bCell).toHaveText('TypingInB');
      await expect(pageB.locator('.v-table')).not.toContainText('ChangedByA');

      // Blur releases the hold: B's own edit is written and A's change lands.
      await bCell.blur();
      await expect(pageB.locator('.v-table')).toContainText('ChangedByA', { timeout: 10000 });
      await expect(pageB.locator('.v-table')).toContainText('TypingInB');
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });

  test('two clients editing DIFFERENT columns of one row no longer clobber each other', async ({ browser }) => {
    // Partial writes: each client sends only the column it touched, so both survive. Before this, every
    // write carried its author's stale copy of every other column and the later write won everything.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await openNotes(pageA, true);
      await openNotes(pageB, false);

      await typeInto(pageA, TITLE, 'TitleFromA');
      await typeInto(pageB, CONTENT, 'ContentFromB');
      await pageB.waitForTimeout(2000);

      const data = await pageB.request.post('/api/getTableData', { data: { tableId: 'notes', tab: 'active' } }).then(r => r.json());
      const stored = (data.rows || []).find(r => r.id === 'lv1');
      expect(stored.title).toBe('TitleFromA');
      expect(stored.content).toBe('ContentFromB');
    } finally {
      await ctxA.close(); await ctxB.close();
    }
  });
});
