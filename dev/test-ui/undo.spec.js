// undo.spec.js — undo/redo against the real app and a real server.
//
// The Node suite pins the stack and the before-image; neither can see the two things that only exist
// here: that the button is wired to a reactive depth, and that an undo is a WRITE — it has to reach the
// server, not just repaint the cell. A test that only checked the screen would pass on a version that
// patched dataCache and told nobody.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

async function appReady(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
  await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
}

const storedNotes = async (page) => {
  const d = await (await page.request.post('/api/getTableData', { data: { tableId: 'notes', tab: 'active' } })).json();
  return JSON.stringify(d.rows || []);
};

// Type into the first editable cell and let saveField's 300ms debounce fire.
async function typeInFirstCell(page, text) {
  const cell = page.locator('.v-table .editable-cell').first();
  await cell.click();
  await page.keyboard.type(text);
  await cell.blur();
  await expect.poll(() => storedNotes(page)).toContain(text);
}

const undoBtn = (page) => page.locator('[data-testid="undo"]');
const redoBtn = (page) => page.locator('[data-testid="redo"]');

test.describe('Undo / redo', () => {
  test('both buttons start disabled and undo arms after an edit', async ({ page }) => {
    await appReady(page);
    await expect(undoBtn(page)).toBeDisabled();
    await expect(redoBtn(page)).toBeDisabled();

    await page.locator('button:has(.mdi-plus)').click();
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);
    await typeInFirstCell(page, 'Original');

    await expect(undoBtn(page)).toBeEnabled();
    await expect(redoBtn(page)).toBeDisabled();
  });

  test('undo puts the old value back on screen AND on the server, and redo returns it', async ({ page }) => {
    await appReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);
    await typeInFirstCell(page, 'First');

    // A second edit of the same cell, so the undo has a value to go back TO rather than to empty.
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Second');
    await cell.blur();
    await expect.poll(() => storedNotes(page)).toContain('Second');

    await undoBtn(page).click();
    await expect(page.locator('.v-main')).toContainText('First');
    // The half a screen-only implementation would fail: the server has to agree.
    await expect.poll(() => storedNotes(page)).toContain('First');
    await expect.poll(() => storedNotes(page)).not.toContain('Second');

    await expect(redoBtn(page)).toBeEnabled();
    await redoBtn(page).click();
    await expect(page.locator('.v-main')).toContainText('Second');
    await expect.poll(() => storedNotes(page)).toContain('Second');
  });

  test('the undone value survives a reload', async ({ page }) => {
    // The stack is in memory and goes with the session; what it wrote must not.
    await appReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);
    await typeInFirstCell(page, 'Keep');

    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Replaced');
    await cell.blur();
    await expect.poll(() => storedNotes(page)).toContain('Replaced');

    await undoBtn(page).click();
    await expect.poll(() => storedNotes(page)).toContain('Keep');

    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 20000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
    await expect(page.locator('.v-main')).toContainText('Keep');
    // A reload is a fresh session, so there is nothing left to take back.
    await expect(undoBtn(page)).toBeDisabled();
  });

  test('Ctrl+Z works outside a cell and is left to the browser inside one', async ({ page }) => {
    await appReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);
    await typeInFirstCell(page, 'Typed');

    // Inside a cell, Ctrl+Z belongs to the browser — it takes back a character, which is what someone
    // mid-edit means by undo. Taking the whole edit back there would be a surprise.
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.press('Control+z');
    await expect(undoBtn(page)).toBeEnabled();   // the app's stack is untouched
    await cell.blur();

    await page.locator('.v-app-bar-title').click();   // focus somewhere that is not a field
    await page.keyboard.press('Control+z');
    await expect.poll(() => storedNotes(page)).not.toContain('Typed');
    await expect(redoBtn(page)).toBeEnabled();
  });

  test('refresh moved to Settings and clears the stack', async ({ page }) => {
    await appReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);
    await typeInFirstCell(page, 'Before refresh');
    await expect(undoBtn(page)).toBeEnabled();

    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    const refresh = page.locator('[data-testid="settings-refresh"]');
    await expect(refresh).toBeVisible();
    await refresh.click();

    // refreshData replaces the cache wholesale, so the inverses no longer invert anything.
    await expect(undoBtn(page)).toBeDisabled();
  });

  test('adding a row and undoing removes it, from the table and the server', async ({ page }) => {
    await appReady(page);
    const rows = page.locator('.v-table tbody tr');
    const before = await rows.count();
    await page.locator('button:has(.mdi-plus)').click();
    await expect(rows).toHaveCount(before + 1);
    // The add writes immediately, so there is something to poll for before undoing.
    await expect.poll(async () => JSON.parse(await storedNotes(page)).length).toBe(before + 1);

    await undoBtn(page).click();
    await expect(rows).toHaveCount(before);
    await expect.poll(async () => JSON.parse(await storedNotes(page)).length).toBe(before);

    await redoBtn(page).click();
    await expect(rows).toHaveCount(before + 1);
  });

  test('deleting a row and undoing brings it back with its columns intact', async ({ page }) => {
    await appReady(page);
    const rows = page.locator('.v-table tbody tr');
    await page.locator('button:has(.mdi-plus)').click();
    await expect(rows).toHaveCount(1);
    await typeInFirstCell(page, 'Precious');

    // Two-press delete: the first click arms, the second confirms.
    await page.locator('.v-table button:has(.mdi-close)').first().click();
    const confirm = page.locator('.v-table button:has(.mdi-check-circle)').first();
    await expect(confirm).toBeVisible();
    await confirm.click();
    await expect(rows).toHaveCount(0);

    await undoBtn(page).click();
    await expect(rows).toHaveCount(1);
    // The whole row, not an empty shell: a delete has no partial to merge onto.
    await expect(page.locator('.v-main')).toContainText('Precious');
    await expect.poll(() => storedNotes(page)).toContain('Precious');
  });

  test('archiving and undoing puts the row back in the active tab', async ({ page }) => {
    await appReady(page);
    const rows = page.locator('.v-table tbody tr');
    await page.locator('button:has(.mdi-plus)').click();
    await expect(rows).toHaveCount(1);
    await typeInFirstCell(page, 'Filed');

    // Archive arms first (same confirm as delete): click the icon, then the tick it turns into.
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.locator('button:has(.mdi-check-circle)').first().click();
    await expect(rows).toHaveCount(0);

    await undoBtn(page).click();
    await expect(rows).toHaveCount(1);
    await expect(page.locator('.v-main')).toContainText('Filed');
  });
});
