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

const storedTasks = async (page) => {
  const d = await (await page.request.post('/api/getTableData', { data: { tableId: 'tasks', tab: 'active' } })).json();
  return JSON.stringify(d.rows || []);
};
const storedLists = async (page) =>
  JSON.stringify(await (await page.request.post('/api/getLists', { data: {} })).json());

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

  test('renaming a list value and undoing puts the list AND every row it rewrote back', async ({ page }) => {
    // The failure this exists to catch is the half-undo: rows taken back to a value the list no longer
    // contains. One gesture writes four stores, only two of which are rows, and one press has to close
    // all of it — which is also the only place the async action is exercised for real, since the rename
    // fetches the archive partition before it can rewrite it.
    await appReady(page);
    // Seeded rather than typed, and NOT the `status` list: every value of that one is pinned by a view
    // filter, so the editor renders it locked and there is nothing there anyone may rename. `assigned_to`
    // is pinned by nothing, and backs a column in three tables.
    await page.request.post('/api/saveLists', {
      data: { lists: { status: ['open', 'in_progress'], assigned_to: ['Ann'] } } });
    await page.request.post('/api/putRow', {
      data: { tableId: 'tasks', data: { id: 'seed1', title: 'Roof', assigned_to: 'Ann' }, tab: 'active' } });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 20000 });
    await expect.poll(() => storedTasks(page)).toContain('Ann');

    await page.evaluate(() => window.appInstance.selectTab('__lookup'));
    const group = page.locator('.v-main .v-list-group').filter({ hasText: 'assigned_to' });
    await group.locator('.v-list-group__header').first().click();

    // Located by POSITION, not by its text: a locator is re-resolved on every use, so one filtered on
    // 'Ann' stops matching the moment the cell says 'Bea' — and the blur that commits the rename is the
    // use that comes after. 'Bea' rather than a longer form of 'Ann' for the mirror-image reason: if one
    // name were a substring of the other, every assertion below would pass while saying nothing.
    const value = group.locator('.editable-cell').first();
    await expect(value).toHaveText('Ann');
    await value.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Bea');
    await value.blur();

    // Both halves of the rename reached the server: the vocabulary and the row that stored it.
    await expect.poll(() => storedLists(page)).toContain('Bea');
    await expect.poll(() => storedTasks(page)).toContain('Bea');

    await undoBtn(page).click();
    await expect.poll(() => storedTasks(page)).toContain('Ann');
    await expect.poll(() => storedTasks(page)).not.toContain('Bea');
    await expect.poll(() => storedLists(page)).toContain('Ann');
    await expect.poll(() => storedLists(page)).not.toContain('Bea');
    // ONE entry. A second press left armed would mean the cascade was recorded as an entry of its own,
    // which is the state where the rows and the list disagree.
    await expect(undoBtn(page)).toBeDisabled();

    await redoBtn(page).click();
    await expect.poll(() => storedLists(page)).toContain('Bea');
    await expect.poll(() => storedTasks(page)).toContain('Bea');
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
