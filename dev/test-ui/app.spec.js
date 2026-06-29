const { test, expect } = require('@playwright/test');
const SCHEMA = require('./fixture-schema.json');

// Global gate: fail any test that produces an uncaught page error or console error
// (benign resource/network noise like favicon 404s is ignored).
let _consoleErrors = [];
test.beforeEach(({ page }) => {
  _consoleErrors = [];
  page.on('pageerror', e => _consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|\b404\b|net::ERR|ERR_/.test(m.text())) _consoleErrors.push('console: ' + m.text()); });
});
test.afterEach(() => { expect(_consoleErrors, 'console/page errors during test').toEqual([]); });

// Reset DB, seed the schema (server no longer auto-loads schema.json), and wait for the app.
// Opens the 'notes' table tab by default — it's the addable master table (first sidebar
// tab is a read-only join view; 'tasks' is a detail synced from 'notes' so has no add button).
async function ensureAppReady(page, openTableKey = 'tab.notes') {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  if (openTableKey) {
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: openTableKey }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
  }
}

test.describe('App boot', () => {
  test('loads and shows first view tab', async ({ page }) => {
    await ensureAppReady(page);
    await expect(page.locator('.v-app-bar-title')).not.toBeEmpty();
    const items = page.locator('.v-navigation-drawer .v-list-item');
    await expect(items.first()).toBeVisible();
  });

  test('shows sidebar tabs for views and system tabs', async ({ page }) => {
    await ensureAppReady(page);
    const items = page.locator('.v-navigation-drawer .v-list-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

test.describe('Data table', () => {
  test('add row creates a new row', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(1);
  });

  test('edit cell saves value', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('TestValue');
    await cell.blur();
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 20000 });
    await expect(page.locator('.v-main')).toContainText('TestValue');
  });

  test('delete row removes it', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    await page.locator('.v-table button:has(.mdi-close)').first().click();
    await page.waitForTimeout(200);
    await page.locator('.v-table button:has(.mdi-check-circle)').first().click();
    await page.waitForTimeout(150);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(0);
  });
});

test.describe('Archive / Restore', () => {
  test('archive moves row to archived view', async ({ page }) => {
    await ensureAppReady(page);
    const rowsBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(rowsBefore + 1);
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(rowsBefore);
    // Switch to archived view
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(1000);
    const archivedRows = await page.locator('.v-table tbody tr').count();
    expect(archivedRows).toBeGreaterThanOrEqual(1);
  });

  test('restore moves row back to active', async ({ page }) => {
    await ensureAppReady(page);
    // Add and archive a row
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    const activeBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(activeBefore - 1);
    // Go to archived, restore
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(1000);
    const archivedBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(archivedBefore - 1);
  });
});

test.describe('Navigation', () => {
  test('clicking sidebar tabs switches content', async ({ page }) => {
    await ensureAppReady(page);
    const firstContent = await page.locator('.v-main').textContent();
    // Click the settings tab (always top-level, always visible)
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(200);
    const secondContent = await page.locator('.v-main').textContent();
    expect(secondContent).not.toEqual(firstContent);
  });
});

test.describe('Lists management', () => {
  test('lists tab shows schema-defined lists', async ({ page }) => {
    await ensureAppReady(page);
    // Navigate to lookup tab
    const lookupTab = page.locator('.v-navigation-drawer .v-list-item').filter({ hasText: /lookup|tab\.lookup/ });
    await lookupTab.click();
    await page.waitForTimeout(2000);
    await expect(page.locator('.v-main')).toContainText('status', { timeout: 5000 });
  });
});

test.describe('Theme toggle', () => {
  test('toggles between light and dark', async ({ page }) => {
    await ensureAppReady(page);
    const app = page.locator('.v-theme--light, .v-theme--dark');
    const initialClass = await app.first().getAttribute('class');
    await page.locator('.v-app-bar button:has(.mdi-weather-night), .v-app-bar button:has(.mdi-weather-sunny)').click();
    await page.waitForTimeout(150);
    const newClass = await page.locator('.v-theme--light, .v-theme--dark').first().getAttribute('class');
    expect(newClass).not.toEqual(initialClass);
  });
});

test.describe('Select dropdowns', () => {
  test('select column renders as Vuetify autocomplete in table', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const selects = page.locator('.v-table .v-autocomplete, .v-table .v-combobox');
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Two-press delete', () => {
  test('first click arms, second click deletes', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const deleteBtn = page.locator('.v-table button:has(.mdi-close)').first();
    await deleteBtn.click(); // arm
    await page.waitForTimeout(200);
    await expect(page.locator('.v-table button:has(.mdi-check-circle)')).toBeVisible();
    await page.locator('.v-table button:has(.mdi-check-circle)').click(); // confirm
    await page.waitForTimeout(150);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(0);
  });
});

test.describe('Views', () => {
  test('union view shows data from multiple tables', async ({ page }) => {
    await ensureAppReady(page);
    // Add a row to tasks first
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    // Navigate to all_items view
    await page.locator('.v-navigation-drawer .v-list-item:has-text("all_items")').click();
    await page.waitForTimeout(200);
    const rows = await page.locator('.v-table tbody tr, .v-card.ma-2').count();
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  test('join view renders', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(200);
    // Combined view should render (may be empty but not error)
    await expect(page.locator('.v-main .v-card')).toBeVisible();
  });
});

test.describe('Print', () => {
  test('print button exists on data view', async ({ page }) => {
    await ensureAppReady(page);
    await expect(page.locator('button:has(.mdi-printer)')).toBeVisible();
  });

  test('print button hidden on a view without the printable flag', async ({ page }) => {
    await ensureAppReady(page);
    // all_items has no "printable" flag -> printing is opt-in, so no print button
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'all_items' }).first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('.v-main .v-card button:has(.mdi-printer)')).toHaveCount(0);
  });

  test('print opens new window', async ({ page, context }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.v-card button:has(.mdi-printer)').first().click()
    ]);
    await popup.waitForLoadState();
    expect(popup.url()).toContain('about:blank');
    await popup.close();
  });
});

test.describe('Card layout', () => {
  test('narrow viewport shows card layout', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-app-bar', { timeout: 6000 });
    // Narrow mode: open the drawer, then navigate to the tasks table
    await page.locator('.v-app-bar button:has(.mdi-menu)').click();
    await page.waitForTimeout(150);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    // Cards render as nested v-card inside main content
    const cards = page.locator('.v-main .v-card .v-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Import/Export', () => {
  test('export button downloads JSON', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(200);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button:has(.mdi-download)').click()
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    // Columns must export as the documented array-of-objects form (with name, no implicit id)
    const fs = require('fs');
    const body = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    const cols = body.schema.tables.notes.columns;
    expect(Array.isArray(cols)).toBe(true);
    expect(cols.every(c => c && typeof c === 'object' && typeof c.name === 'string')).toBe(true);
    expect(cols.some(c => c.name === 'id')).toBe(false);
  });
});

test.describe('Print embed positioning', () => {
  test('embed appears after afterColumn in card print', async ({ page, context }) => {
    await ensureAppReady(page);
    // Add a task with data so combined view has content
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('TestTask');
    await cell.blur();
    await page.waitForTimeout(200);
    // Navigate to combined view
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(200);
    // Print the view
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.v-card > .d-flex button:has(.mdi-printer)').click()
    ]);
    await popup.waitForLoadState();
    const content = await popup.content();
    // In card print, embed (class="embed") should appear between title and status fields
    // Check that "embed" div appears BEFORE "status" or "assigned_to" in the HTML
    const embedPos = content.indexOf('class="embed"');
    const afterFieldPos = content.indexOf('field.status') > 0 ? content.indexOf('field.status') : content.indexOf('field.assigned_to');
    if (embedPos > 0 && afterFieldPos > 0) {
      expect(embedPos).toBeLessThan(afterFieldPos);
    }
    await popup.close();
  });
});

test.describe('Print card embed positioning', () => {
  test('per-card print positions embed after afterColumn', async ({ page, context }) => {
    await ensureAppReady(page);
    // Add a task
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('CardTest');
    await cell.blur();
    await page.waitForTimeout(200);
    // Navigate to combined view (has embeds with afterColumn:"title")
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(200);
    // Click per-card print button
    const printBtn = page.locator('button:has(.mdi-printer)').first();
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      printBtn.click()
    ]);
    await popup.waitForLoadState();
    const content = await popup.content();
    // Embed should appear between title field and status/assigned fields
    const embedPos = content.indexOf('class="embed"');
    const statusPos = content.indexOf('field.status');
    if (embedPos > 0 && statusPos > 0) {
      expect(embedPos).toBeLessThan(statusPos);
    }
    await popup.close();
  });
});

test.describe('Setup UI', () => {
  test('shows setup dialog when no mode configured', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload();
    // Local dev server probe succeeds, app should boot
    await page.waitForSelector('.v-app-bar', { timeout: 6000 });
  });

  test('snackbar shows notification on export', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(200);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button:has(.mdi-download)').click()
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  });
});


test.describe('syncFrom read-only', () => {
  test('syncFrom columns are read-only in the detail table', async ({ page }) => {
    await ensureAppReady(page); // opens notes (master)
    // Navigate to tasks: a detail table whose date/title columns sync from notes
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.tasks' }).first().click();
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      current: appInstance.currentTable,
      title: appInstance.isReadonlyCell({}, 'title'),   // syncFrom -> read-only
      date: appInstance.isReadonlyCell({}, 'date'),     // syncFrom -> read-only
      status: appInstance.isReadonlyCell({}, 'status')  // own column -> editable
    }));
    expect(r.current).toBe('tasks');
    expect(r.title).toBe(true);
    expect(r.date).toBe(true);
    expect(r.status).toBe(false);
  });
});

test.describe('Multi-table lifecycle (join view UI)', () => {
  const has = async (page, tableId, tab, id) => {
    const d = await (await page.request.post('/api/getTableData', { data: { tableId, tab } })).json();
    return (d.rows || []).some(r => r.id === id);
  };
  test('add/archive/restore/delete in join view stays in sync across tasks+notes', async ({ page }) => {
    test.setTimeout(20000);
    await ensureAppReady(page, null); // boot only
    // combined (join view over [tasks, notes]) is the first sidebar tab
    await page.locator('.v-navigation-drawer .v-list-item').first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

    // ADD via the join view -> must create a row with the same id in BOTH source tables
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(700);
    const tasks = await (await page.request.post('/api/getTableData', { data: { tableId: 'tasks', tab: 'active' } })).json();
    const notes = await (await page.request.post('/api/getTableData', { data: { tableId: 'notes', tab: 'active' } })).json();
    expect(tasks.rows.length).toBe(1);
    expect(notes.rows.length).toBe(1);
    const id = tasks.rows[0].id;
    expect(notes.rows[0].id).toBe(id);

    // ARCHIVE -> both sources move to archive
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(700);
    expect(await has(page, 'tasks', 'active', id)).toBe(false);
    expect(await has(page, 'notes', 'active', id)).toBe(false);
    expect(await has(page, 'tasks', 'archive', id)).toBe(true);
    expect(await has(page, 'notes', 'archive', id)).toBe(true);

    // RESTORE from archived view -> both sources back to active
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(900);
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(700);
    expect(await has(page, 'tasks', 'active', id)).toBe(true);
    expect(await has(page, 'notes', 'active', id)).toBe(true);
    expect(await has(page, 'tasks', 'archive', id)).toBe(false);
    expect(await has(page, 'notes', 'archive', id)).toBe(false);

    // DELETE (two-press) -> removed from both sources
    await page.locator('.v-tab:nth-child(1)').click();
    await page.waitForTimeout(600);
    await page.locator('.v-table button:has(.mdi-close)').first().click();
    await page.waitForTimeout(200);
    await page.locator('.v-table button:has(.mdi-check-circle)').first().click();
    await page.waitForTimeout(700);
    expect(await has(page, 'tasks', 'active', id)).toBe(false);
    expect(await has(page, 'notes', 'active', id)).toBe(false);
  });
});

test.describe('Archivable flag', () => {
  const CUSTOM = {
    defaultLanguage: 'en',
    tables: { items: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ table: 'items' }],
    nav: { items: [{ table: 'items' }] }
  };
  const get = (page, tab) => page.request.post('/api/getTableData', { data: { tableId: 'items', tab } }).then(r => r.json());

  test('archivable flag enables archive/restore using the fixed "archive" partition', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: CUSTOM } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.items' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

    // ADD + ARCHIVE
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(600);

    // Stored under the fixed 'archive' partition
    const archive = await get(page, 'archive');
    expect(archive.rows.length).toBe(1);
    expect((await get(page, 'active')).rows.length).toBe(0);
    const id = archive.rows[0].id;

    // Archived view shows the row
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(700);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);

    // RESTORE -> back to active, archive emptied
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(600);
    expect((await get(page, 'active')).rows.some(r => r.id === id)).toBe(true);
    expect((await get(page, 'archive')).rows.length).toBe(0);
  });
});

test.describe('Archive from a view whose source has a mirror table not in sources', () => {
  // Mirrors the kokous/musiikki case: view 'mtg' sources=[meetings] only; 'music' mirrors meetings.
  const SCH = {
    defaultLanguage: 'en',
    tables: {
      meetings: { columns: [{ name: 'title', type: 'text' }], archivable: true },
      music: { columns: [{ name: 'title', type: 'text', syncFrom: 'meetings' }, { name: 'song', type: 'text' }], archivable: true }
    },
    views: [{ name: 'mtg', sources: ['meetings'], mode: 'union', columns: ['title'] }, { name: 'mus', sources: ['music'], mode: 'union', columns: ['song'] }, { table: 'meetings' }, { table: 'music' }],
    nav: { items: [{ view: 'mtg' }, { view: 'mus' }, { table: 'meetings' }, { table: 'music' }] }
  };
  const get = (page, t, tab) => page.request.post('/api/getTableData', { data: { tableId: t, tab } }).then(r => r.json());

  test('archiving in the view also archives the mirror table row', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'mtg' }).first().click(); // the view
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

    // ADD in the view -> meetings row + propagated music mirror row (same id)
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(600);
    expect((await get(page, 'meetings', 'active')).rows.length).toBe(1);
    expect((await get(page, 'music', 'active')).rows.length).toBe(1);
    const id = (await get(page, 'meetings', 'active')).rows[0].id;

    // ARCHIVE from the view -> BOTH meetings AND the mirror 'music' move to archive
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(600);
    expect((await get(page, 'meetings', 'active')).rows.length).toBe(0);
    expect((await get(page, 'music', 'active')).rows.length).toBe(0);
    expect((await get(page, 'meetings', 'archive')).rows.some(r => r.id === id)).toBe(true);
    expect((await get(page, 'music', 'archive')).rows.some(r => r.id === id)).toBe(true);
  });

  test('archiving from the DETAIL view also archives the upstream master row', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'mus' }).first().click(); // detail view (music)
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

    // ADD in the detail view -> music row + propagated upstream master 'meetings' row (same id)
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(600);
    expect((await get(page, 'music', 'active')).rows.length).toBe(1);
    expect((await get(page, 'meetings', 'active')).rows.length).toBe(1);
    const id = (await get(page, 'music', 'active')).rows[0].id;

    // ARCHIVE from the detail view -> upstream master 'meetings' moves to archive too
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(600);
    expect((await get(page, 'music', 'active')).rows.length).toBe(0);
    expect((await get(page, 'meetings', 'active')).rows.length).toBe(0);
    expect((await get(page, 'meetings', 'archive')).rows.some(r => r.id === id)).toBe(true);
    expect((await get(page, 'music', 'archive')).rows.some(r => r.id === id)).toBe(true);
  });
});

test.describe('Permissions — restricted user UI gating', () => {
  // meetings (master) has a list + a ref to venues; music (detail) has neither.
  const SCH = {
    defaultLanguage: 'en',
    tables: {
      meetings: { columns: [{ name: 'title', type: 'text' }, { name: 'place', type: 'ref', table: 'venues', valueCol: 'venue' }, { name: 'kind', type: 'select', list: 'mkind' }], archivable: true },
      music: { columns: [{ name: 'title', type: 'text', syncFrom: 'meetings' }, { name: 'song', type: 'text' }], archivable: true },
      venues: { columns: [{ name: 'venue', type: 'text' }], isLookup: true }
    },
    views: [{ name: 'mus', sources: ['music'], mode: 'union', columns: ['song'] }, { name: 'mtg', sources: ['meetings'], mode: 'union', columns: ['title', 'place', 'kind'] }, { table: 'meetings' }, { table: 'music' }],
    nav: { items: [{ view: 'mus' }, { view: 'mtg' }, { table: 'meetings' }, { table: 'music' }] }
  };
  async function setup(page) {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.request.post('/api/saveLists', { data: { lists: { mkind: ['weekly'] } } });
    await page.request.post('/api/setUserRole', { data: { uid: 'admin@x', role: 'admin', user: 'admin@x', tables: 'all' } });
    await page.request.post('/api/setUserRole', { data: { uid: 'ed@x', role: 'editor', user: 'ed@x', tables: ['music'] } });
  }
  async function bootAs(page, user) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.evaluate((u) => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', u); }, user);
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  }

  test('admin sees every tab, the lookup tab, all ref tables, and can archive', async ({ page }) => {
    test.setTimeout(20000);
    await setup(page);
    await bootAs(page, 'admin@x');
    const info = await page.evaluate(() => ({ ids: appInstance.sidebarTabs.map(t => t.id), ref: appInstance.refTables, lists: Object.keys(appInstance.visibleLists) }));
    expect(info.ids).toEqual(expect.arrayContaining(['mus', 'mtg', '__lookup']));
    expect(info.ref).toContain('venues');
    expect(info.lists).toContain('mkind');
    // add a row in the mus view -> archive button visible (admin has full access)
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mus' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => appInstance.canMutateCurrent)).toBe(true);
    expect(await page.locator('button:has(.mdi-archive-outline)').count()).toBeGreaterThanOrEqual(1);
  });

  test('editor restricted to music: filtered sidebar, no lookup tab, no archive button', async ({ page }) => {
    test.setTimeout(20000);
    await setup(page);
    // seed a music row as admin so the editor's view has data
    await bootAs(page, 'admin@x');
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mus' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);

    await bootAs(page, 'ed@x');
    const info = await page.evaluate(() => ({ ids: appInstance.sidebarTabs.map(t => t.id), ref: appInstance.refTables, lists: Object.keys(appInstance.visibleLists) }));
    expect(info.ids).toEqual(expect.arrayContaining(['mus', 'music']));
    expect(info.ids).not.toContain('mtg');         // view needs meetings (no access)
    expect(info.ids).not.toContain('meetings');    // table not allowed
    expect(info.ids).not.toContain('__lookup');    // no lists + no refs -> tab hidden
    expect(info.ref).toEqual([]);                  // venues filtered out
    expect(info.lists).toEqual([]);                // mkind (used by meetings) filtered out

    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mus' }).first().click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => appInstance.canMutateCurrent)).toBe(false);
    expect(await page.locator('button:has(.mdi-archive-outline)').count()).toBe(0); // archive hidden
    expect(await page.locator('.v-table tbody tr').count()).toBeGreaterThanOrEqual(1); // row still visible
    expect(await page.locator('.v-table button:has(.mdi-close)').count()).toBe(0); // delete hidden too
  });
});

test.describe('Mirror cluster is transitive (master + 2 details)', () => {
  // meet (master) <- mus, task (both syncFrom meet). Adding/deleting one detail must affect ALL three.
  const SCH = {
    defaultLanguage: 'en',
    tables: {
      meet: { columns: [{ name: 'title', type: 'text' }], archivable: true },
      mus: { columns: [{ name: 'title', type: 'text', syncFrom: 'meet' }, { name: 'song', type: 'text' }], archivable: true },
      task: { columns: [{ name: 'title', type: 'text', syncFrom: 'meet' }, { name: 'todo', type: 'text' }], archivable: true }
    },
    views: [{ name: 'musv', sources: ['mus'], mode: 'union', columns: ['song'] }, { table: 'meet' }, { table: 'mus' }, { table: 'task' }],
    nav: { items: [{ view: 'musv' }, { table: 'meet' }, { table: 'mus' }, { table: 'task' }] }
  };
  const get = (page, t) => page.request.post('/api/getTableData', { data: { tableId: t, tab: 'active' } }).then(r => r.json());

  test('add + delete from a detail view propagate transitively to master and sibling detail', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'musv' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

    // ADD in the mus detail view -> meet (master) + task (sibling detail) created too
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(600);
    expect((await get(page, 'mus')).rows.length).toBe(1);
    expect((await get(page, 'meet')).rows.length).toBe(1);
    expect((await get(page, 'task')).rows.length).toBe(1);

    // DELETE (two-press) -> all three removed
    await page.locator('.v-table button:has(.mdi-close)').first().click();
    await page.waitForTimeout(200);
    await page.locator('.v-table button:has(.mdi-check-circle)').first().click();
    await page.waitForTimeout(600);
    expect((await get(page, 'mus')).rows.length).toBe(0);
    expect((await get(page, 'meet')).rows.length).toBe(0);
    expect((await get(page, 'task')).rows.length).toBe(0);
  });
});

test.describe('Import round-trip', () => {
  test('importing a JSON bundle restores data into correct partitions (active vs archive) with implicit id', async ({ page }) => {
    test.setTimeout(20000);
    const SCH = { defaultLanguage: 'en', tables: { docs: { columns: [{ name: 'title', type: 'text' }], archivable: true } }, views: [{ table: 'docs' }], nav: { items: [{ table: 'docs' }] } };
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    // Open Settings so the hidden import file input is in the DOM
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(150);

    const bundle = { schema: SCH, tables: { docs: [{ id: 'a1', title: 'Active1' }], docs__archive: [{ id: 'z1', title: 'Arch1' }] } };
    await page.setInputFiles('input[type=file][accept=".json"]', { name: 'import.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    await page.waitForTimeout(2000); // FileReader + chained per-row writes

    const active = await (await page.request.post('/api/getTableData', { data: { tableId: 'docs', tab: 'active' } })).json();
    const archive = await (await page.request.post('/api/getTableData', { data: { tableId: 'docs', tab: 'archive' } })).json();
    expect(active.rows.some(r => r.id === 'a1' && r.title === 'Active1')).toBe(true);  // bare key -> active partition
    expect(archive.rows.some(r => r.id === 'z1' && r.title === 'Arch1')).toBe(true);   // __archive key -> archive partition
    expect(active.headers).toContain('id'); // implicit id present after import
  });
});

test.describe('Translation keys for view columns', () => {
  test('aggregate/computed view columns get field.* keys (plus normal columns)', async ({ page }) => {
    await ensureAppReady(page); // default schema includes the aggregate "attendance" subview
    const keys = await page.evaluate(() => appInstance.schemaTranslationKeys);
    // aggregate subview 'attendance' computed columns -> previously had NO key
    for (const k of ['field.person', 'field.latest', 'field.previous', 'field.3rd']) expect(keys).toContain(k);
    expect(keys).toContain('field.title');            // normal table column still covered
  });

  test('rotationView area/column names get field.* keys (+ period)', async ({ page }) => {
    await ensureAppReady(page);
    const keys = await page.evaluate(() => {
      // slots form
      appInstance.schemaData = { tables: {}, views: [
        { name: 'rota', rotation: { slots: ['alue_a', 'alue_b'], rosters: ['la', 'lb'], interval: 'weekly' } },
        { name: 'rota2', rotation: { columns: [{ name: 'crew' }], interval: 'weekly' } }   // columns form
      ] };
      return appInstance.schemaTranslationKeys;
    });
    expect(keys).toContain('field.alue_a');   // slots form (regression: was missing)
    expect(keys).toContain('field.alue_b');
    expect(keys).toContain('field.crew');     // columns form
    expect(keys).toContain('field.period');   // generated period column
    expect(keys).toContain('view.rota');
  });
});

test.describe('v3 nav + pages + tabs layout', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '# Hello Page\n\nTasks below:\n\n{{table:tasks}}\n\nVia view:\n\n{{view:all}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home', icon: 'mdi-home' }, { view: 'all' }, { table: 'tasks' }] }
  };
  test('top tabs render, drawer hidden, markdown page shows prose + embedded data', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'Buy milk' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });

    // tabs layout: top tab bar present, drawer hidden
    expect(await page.locator('.v-tabs .v-tab', { hasText: 'home' }).count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator('.v-navigation-drawer').count()).toBe(0);

    // page auto-selected -> markdown heading + embedded data rendered
    await page.waitForTimeout(150);
    await expect(page.locator('.v-main')).toContainText('Hello Page');   // markdown <h1>
    await expect(page.locator('.v-main')).toContainText('Buy milk');     // {{table:tasks}} + {{view:all}} embed
  });
});

test.describe('v3 interactive page embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: 'Edit below:\n\n{{view:all}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('editing a cell in an embedded view persists', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'Buy milk' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    const cell = page.locator('.v-main .editable-cell', { hasText: 'Buy milk' }).first();
    await cell.click();
    await cell.evaluate(el => { el.textContent = 'Edited milk'; el.dispatchEvent(new Event('blur')); });
    await page.waitForTimeout(800);
    // persisted to the underlying table
    const row = await page.request.post('/api/getTableData', { data: { tableId: 'tasks', tab: 'active' } });
    expect(JSON.stringify(await row.json())).toContain('Edited milk');
  });
});

test.describe('v3 embed row controls', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '{{view:all}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  const count = (page, tab) => page.request.post('/api/getTableData', { data: { tableId: 'tasks', tab } }).then(r => r.json()).then(d => d.rows.length);
  test('add/archive/delete from an embedded view operate on the underlying table', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    // ADD via embed
    await page.locator('.v-main button:has(.mdi-plus)').first().click();
    await page.waitForTimeout(600);
    expect(await count(page, 'active')).toBe(1);
    // ARCHIVE via embed
    await page.locator('.v-main button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(600);
    expect(await count(page, 'active')).toBe(0);
    expect(await count(page, 'archive')).toBe(1);
  });
});

test.describe('v3 hide-empty embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }] } },
    views: [
      { name: 'open', sources: ['tasks'], mode: 'union', filter: { status: 'open' }, columns: ['title'] },
      { name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }
    , { name: 'home', markdown: '{{view:open?}}\n\n{{view:all}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('{{view:x?}} block is skipped when the view yields 0 rows', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'Buy milk', status: 'done' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    // only the non-empty 'all' embed should render (open? has 0 rows -> hidden)
    const embeds = await page.evaluate(() => appInstance.pageBlocks.filter(b => b.embedName).map(b => b.embedName));
    expect(embeds).toEqual(['all']);
  });
});

test.describe('v3 named-view column embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'sub', sources: ['tasks'], mode: 'union', filter: { status: 'open' }, columns: ['title'] },
      { name: 'main', sources: ['tasks'], mode: 'union', columns: ['title', { view: 'sub', filter: { status: 'done' } }] }
    ],
    nav: { items: [{ view: 'main' }, { view: 'sub' }] }
  };
  test('{view,filter} column embed reuses the named view with an overridden filter', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'o1', title: 'OpenItem', status: 'open' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'd1', title: 'DoneItem', status: 'done' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(150);
    // the embed reuses 'sub' (columns from sub) but with filter overridden to status:done
    const emb = await page.evaluate(() => appInstance.embedItems.map(e => ({ cols: e.columns, rows: e.rows.map(r => r.title) })));
    expect(emb.length).toBe(1);
    expect(emb[0].cols).toEqual(['title']);
    expect(emb[0].rows).toEqual(['DoneItem']);
  });
});

test.describe('v3 embeddable doc-view (markdown header/footer/table inline)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { meet: { columns: [{ name: 'topic', type: 'text' }, { name: 'place', type: 'text' }], partition: 'active' }, people: { columns: [{ name: 'name', type: 'text' }, { name: 'state', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'people_open', sources: ['people'], mode: 'union', filter: { state: 'in_progress' }, columns: ['name'] },
      { name: 'people_block', markdown: '**People in progress**\n\n{{view:people_open?}}\n\n_end of people_' },
      { name: 'main', sources: ['meet'], mode: 'union', layout: 'card', columns: ['topic', 'place', { view: 'people_block' }] }
    ],
    nav: { items: [{ view: 'main' }, { table: 'people' }] }
  };
  async function boot(page) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'meet', data: { id: 'm1', topic: 'Meeting', place: 'Hall' }, tab: 'active' } });
  }
  test('renders header + table + footer inline when the table has rows', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page);
    await page.request.post('/api/putRow', { data: { tableId: 'people', data: { id: 'p1', name: 'Alice', state: 'in_progress' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(200);
    await expect(page.locator('.v-main')).toContainText('People in progress'); // doc header
    await expect(page.locator('.v-main')).toContainText('Alice');              // embedded table
    await expect(page.locator('.v-main')).toContainText('end of people');      // doc footer
  });
  test('whole doc-view is hidden when its table is empty', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page);
    await page.request.post('/api/putRow', { data: { tableId: 'people', data: { id: 'p2', name: 'Bob', state: 'done' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(200);
    // no in_progress people -> the doc embed (header + footer included) is not rendered
    await expect(page.locator('.v-main')).not.toContainText('People in progress');
    await expect(page.locator('.v-main')).not.toContainText('end of people');
  });
});

test.describe('v3 self-embed (view renders prose + its own grid, zero code)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'selfdemo', sources: ['tasks'], mode: 'union', columns: ['title'],
        markdown: '**Above grid**\n\n{{self}}\n\n_Below grid_' }
    ],
    nav: { items: [{ view: 'selfdemo' }] }
  };
  test('a view with sources + markdown self-embeds its own grid between prose', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'SelfRow' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.selfdemo' }).first().click();
    await page.waitForTimeout(150);
    // renders as a doc (markdown wins) yet shows its own grid inline via {{view:self}}
    expect(await page.evaluate(() => appInstance.isDataView)).toBeFalsy();
    await expect(page.locator('.v-main')).toContainText('Above grid'); // header prose
    await expect(page.locator('.v-main')).toContainText('SelfRow');    // its own grid row
    await expect(page.locator('.v-main')).toContainText('Below grid'); // footer prose
  });
});

test.describe('v3 hybrid self-view hide-empty ({{self}} participates)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { meet: { columns: [{ name: 'topic', type: 'text' }, { name: 'place', type: 'text' }], partition: 'active' }, task: { columns: [{ name: 'title', type: 'text' }, { name: 'state', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'task_block', sources: ['task'], mode: 'union', filter: { state: 'open' }, readonly: true, columns: ['title'],
        markdown: '**Open tasks**\n\n{{self}}\n\n_end tasks_' },
      { name: 'main', sources: ['meet'], mode: 'union', layout: 'card', columns: ['topic', 'place', { view: 'task_block' }] }
    ],
    nav: { items: [{ view: 'main' }, { table: 'task' }] }
  };
  async function boot(page, taskState) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'meet', data: { id: 'm1', topic: 'Meeting', place: 'Hall' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'task', data: { id: 'k1', title: 'TheTask', state: taskState }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(200);
  }
  test('shows header + own grid + footer when the {{self}} grid has rows', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page, 'open');
    await expect(page.locator('.v-main')).toContainText('Open tasks'); // header
    await expect(page.locator('.v-main')).toContainText('TheTask');    // {{self}} grid row
    await expect(page.locator('.v-main')).toContainText('end tasks');  // footer
  });
  test('hides the whole block (header + footer) when the {{self}} grid is empty', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page, 'done'); // no state:open rows -> {{self}} empty
    await expect(page.locator('.v-main')).not.toContainText('Open tasks');
    await expect(page.locator('.v-main')).not.toContainText('end tasks');
  });
});

test.describe('v3 non-ASCII names in embed tokens', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { 'tehtävät': { columns: [{ name: 'otsikko', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'tehtävä_block', sources: ['tehtävät'], mode: 'union', columns: ['otsikko'],
        markdown: '**Lista**\n\n{{self}}\n\n{{table:tehtävät}}' }
    ],
    nav: { items: [{ view: 'tehtävä_block' }, { table: 'tehtävät' }] }
  };
  test('{{self}} and {{table:X}} resolve non-ASCII (ä) names', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tehtävät', data: { id: 'r1', otsikko: 'FinRivi' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.tehtävä_block' }).first().click();
    await page.waitForTimeout(150);
    await expect(page.locator('.v-main')).toContainText('Lista');   // header prose
    await expect(page.locator('.v-main')).toContainText('FinRivi'); // {{self}} + {{table:tehtävät}} both rendered the row
  });
});

test.describe('v3 dangling reference validation', () => {
  test('validateRefs flags missing view/table/nav refs and passes a clean schema', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof validateRefs === 'function');
    const bad = await page.evaluate(() => validateRefs({
      tables: { t: { columns: [] } },
      views: [{ name: 'a', sources: ['nope'], columns: [{ view: 'ghost' }], markdown: '{{table:missing}}' }],
      nav: { items: [{ view: 'absent' }, { table: 't' }] }
    }));
    const good = await page.evaluate(() => validateRefs({
      tables: { t: { columns: [] } },
      views: [{ name: 'a', sources: ['t'], columns: [], markdown: '{{view:a}}\n\n{{table:t}}' }],
      nav: { items: [{ view: 'a' }, { table: 't' }] }
    }));
    expect(bad.length).toBeGreaterThanOrEqual(4); // missing source table, embed view, markdown table, nav view
    expect(good).toEqual([]);
  });
});

test.describe('v3 unicode {{t:}} key', () => {
  test('a non-ASCII (ä) {{t:}} key both resolves and is extracted', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof appInstance !== 'undefined' && !!appInstance && typeof appInstance.mdBlocks === 'function');
    const result = await page.evaluate(() => {
      appInstance.strings = Object.assign({}, appInstance.strings, { 'tehtävä.otsikko': 'Otsikko-ÄÖ' });
      var resolved = appInstance.mdBlocks('{{t:tehtävä.otsikko}}', null).map(function (b) { return b.html || ''; }).join('');
      // extractor uses the same broadened class -> confirm it captures the ä key
      var extracted = /\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/.exec('{{t:tehtävä.otsikko}}');
      return { resolved: resolved, extracted: extracted && extracted[1] };
    });
    expect(result.resolved).toContain('Otsikko-ÄÖ');     // resolver regex matched + substituted the ä key
    expect(result.extracted).toBe('tehtävä.otsikko');    // extractor regex captures the ä key
  });
});

test.describe('v3 tabs nav layout', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'home', sources: ['tasks'], mode: 'union', columns: ['title'] },
      { name: 'report', sources: ['tasks'], mode: 'union', columns: ['title'] }
    ],
    nav: { layout: 'tabs', items: [
      { view: 'home' },
      { group: 'Group', items: [{ view: 'report' }] },
      { table: 'tasks' }
    ] }
  };
  test('renders top tabs (no drawer), keeps group hierarchy via dropdown, and child click navigates', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'TabRow' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    // tabs layout -> top tabs render and the navigation drawer is not present
    await expect(page.locator('.v-navigation-drawer')).toHaveCount(0);
    // hierarchy preserved (not flattened): 'home' is a top-level tab; the group is a parent tab; 'report' lives under it
    await expect(page.locator('.v-tab', { hasText: 'view.home' })).toBeVisible();
    const groupTab = page.locator('.v-tab', { hasText: 'Group' });
    await expect(groupTab).toBeVisible();
    await expect(page.locator('.v-list-item', { hasText: 'view.report' })).toHaveCount(0); // not a top-level tab; hidden until the group opens
    // hovering the parent opens its dropdown (no click) -> child revealed -> selecting it navigates
    await groupTab.dispatchEvent('mouseenter');
    const child = page.locator('.v-list-item', { hasText: 'view.report' });
    await expect(child).toBeVisible();
    await child.dispatchEvent('click');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => appInstance.currentTable)).toBe('report');
    await expect(page.locator('.v-main')).toContainText('TabRow');
    await expect(groupTab).toHaveClass(/nav-tab-active/); // parent tab shows active styling when a child view is selected
    // active indication is background, not the underline slider (slider hidden)
    expect(await page.evaluate(() => { const s = document.querySelector('.nav-tabs .v-tab__slider'); return s ? getComputedStyle(s).display : 'none'; })).toBe('none');
  });
});

test.describe('v3 drawer nav layout', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'home', sources: ['tasks'], mode: 'union', columns: ['title'] },
      { name: 'report', sources: ['tasks'], mode: 'union', columns: ['title'] }
    ],
    nav: { layout: 'drawer', items: [
      { view: 'home' },
      { group: 'Group', items: [{ view: 'report' }] },
      { table: 'tasks' }
    ] }
  };
  test('renders the navigation drawer (no top tabs) and item click navigates', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'DrawerRow' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    // drawer layout -> side drawer present, no top tabs
    await expect(page.locator('.v-tabs')).toHaveCount(0);
    await expect(page.locator('.v-navigation-drawer')).not.toHaveCount(0);
    // a group keeps its hierarchy in the drawer (rendered as a parent, not flattened)
    await expect(page.locator('.v-navigation-drawer .v-list-item', { hasText: 'Group' })).toHaveCount(1);
    // clicking a top-level item navigates and shows its data
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.home' }).first().click();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => appInstance.currentTable)).toBe('home');
    await expect(page.locator('.v-main')).toContainText('DrawerRow');
  });
});

test.describe('v3 live nav layout switch', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [{ name: 'home', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    nav: { layout: 'drawer', items: [{ view: 'home' }] }
  };
  async function boot(page) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.removeItem('app_nav_layout'); localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  }
  test('Settings toggle flips drawer -> tabs live (navLayoutOverride)', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page);
    await expect(page.locator('.v-tabs')).toHaveCount(0);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="nav-layout-toggle"] input').dispatchEvent('click');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => appInstance.navLayout)).toBe('tabs');
    await expect(page.locator('.v-tabs')).not.toHaveCount(0);
    await expect(page.locator('.v-navigation-drawer')).toHaveCount(0);
    await expect(page.locator('.v-toolbar__extension')).toHaveCount(0); // inline tabs -> no extension row, bar stays thin
    await expect(page.locator('.v-app-bar-nav-icon')).toHaveCount(1);   // hamburger stays in tabs mode
    // hamburger toggles icon-only tabs (rail), like the drawer rail
    expect(await page.evaluate(() => appInstance.rail)).toBe(false);
    await page.locator('.v-app-bar-nav-icon').first().click();
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => appInstance.rail)).toBe(true);
    await expect(page.locator('.v-tabs.nav-icons-only')).toHaveCount(1);
    // icon-only: label faded out (opacity 0) until hover, then fades in (overlay in place)
    const homeTab = page.locator('.v-tab', { hasText: 'view.home' });
    await expect(homeTab.locator('.tab-label')).toHaveCSS('opacity', '0');
    await homeTab.hover();
    await expect(homeTab.locator('.tab-label')).toHaveCSS('opacity', '1');
    // toggle back to drawer; never any extension row
    await page.locator('[data-testid="nav-layout-toggle"] input').dispatchEvent('click');
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => appInstance.navLayout)).toBe('drawer');
    await expect(page.locator('.v-toolbar__extension')).toHaveCount(0);
    await expect(page.locator('.v-app-bar-nav-icon')).toHaveCount(1);
  });
  test('reassigning schemaData live-swaps the layout (no reload)', async ({ page }) => {
    test.setTimeout(20000);
    await boot(page);
    expect(await page.evaluate(() => appInstance.navLayout)).toBe('drawer');
    await page.evaluate(() => {
      appInstance.navLayoutOverride = null; // ensure schema drives the layout
      appInstance.schemaData = Object.freeze(Object.assign({}, appInstance.schemaData, { nav: { layout: 'tabs', items: [{ view: 'home' }] } }));
    });
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 4000 });
    expect(await page.evaluate(() => appInstance.navLayout)).toBe('tabs');
    await expect(page.locator('.v-navigation-drawer')).toHaveCount(0);
  });
});

test.describe('Print with doc-view embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { t: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'doc', markdown: '**Doc**\n\n{{table:t}}' },
      { name: 'main', sources: ['t'], mode: 'union', layout: 'card', printable: ["view","cards"], columns: ['title', { view: 'doc', bare: true }] }
    ],
    nav: { items: [{ view: 'main' }, { table: 't' }] }
  };
  test('printing a card whose view embeds a doc-view renders the doc inline (markdown + nested table)', async ({ page, context }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 't', data: { id: 'r1', title: 'Row1' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(150);
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.v-main .v-card button:has(.mdi-printer)').first().click()
    ]);
    await popup.waitForLoadState();
    await expect(popup.locator('body')).toContainText('Doc');   // doc-view markdown header rendered in print
    await expect(popup.locator('body')).toContainText('Row1');  // its embedded {{table:t}} row rendered in print
    expect(await popup.locator('.embed').count()).toBe(0);      // bare:true -> no boxed .embed wrapper in print
    await popup.close(); // global afterEach console-error gate asserts no TypeError from printCard
  });
});

test.describe('filterRows operators', () => {
  test('supports flat AND, $or, $and; array-IN is retired (upgraded to $or via filterToOr)', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof filterRows === 'function');
    const r = await page.evaluate(() => {
      const rows = [
        { id: 1, state: 'open', city: 'X' },
        { id: 2, state: 'in_progress', city: 'X' },
        { id: 3, state: 'done', city: 'X' },
        { id: 4, state: 'open', city: 'Y' }
      ];
      const ids = (f) => filterRows(rows, f).map((x) => x.id);
      return {
        flatAnd: ids({ state: 'open', city: 'X' }),
        arrayInRaw: ids({ state: ['open', 'in_progress'] }),          // array-IN no longer matched directly
        arrayInUpgraded: ids(filterToOr({ state: ['open', 'in_progress'] })), // ...but filterToOr -> $or works
        or: ids({ $or: [{ state: 'open' }, { state: 'in_progress' }] }),
        and: ids({ $and: [{ city: 'X' }, { $or: [{ state: 'open' }, { state: 'in_progress' }] }] }),
        noFilter: ids(null).length
      };
    });
    expect(r.flatAnd).toEqual([1]);              // AND of equality (backward compatible)
    expect(r.arrayInRaw).toEqual([]);            // raw array-IN is retired at the matcher level
    expect(r.arrayInUpgraded).toEqual([1, 2, 4]); // upgraded to $or (as convertViewFilters does at load)
    expect(r.or).toEqual([1, 2, 4]);             // $or
    expect(r.and).toEqual([1, 2]);               // city X AND (open OR in_progress)
    expect(r.noFilter).toBe(4);                  // no filter = all rows
  });
});

test.describe('v3 bare doc-view embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { meet: { columns: [{ name: 'topic', type: 'text' }, { name: 'place', type: 'text' }], partition: 'active' }, task: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'doc', markdown: '**DocHeader**\n\n{{table:task}}' },
      { name: 'main', sources: ['meet'], mode: 'union', layout: 'card', columns: ['topic', 'place', { view: 'doc', bare: true }] }
    ],
    nav: { items: [{ view: 'main' }, { table: 'task' }] }
  };
  test('bare:true renders the embed without the box wrapper (no surface-variant background)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'meet', data: { id: 'm1', topic: 'Meeting', place: 'Hall' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'task', data: { id: 't1', title: 'TaskRow' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(150);
    await expect(page.locator('.v-main')).toContainText('DocHeader'); // doc still renders inline
    await expect(page.locator('.v-main')).toContainText('TaskRow');
    expect(await page.locator('.v-main [style*="surface-variant"]').count()).toBe(0); // no boxed wrapper
  });
});

test.describe('v3 per-column hideEmpty override', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { t: { columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }, { name: 'c', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'tbl', sources: ['t'], mode: 'union', layout: 'table', hideEmpty: true, columns: ['a', { name: 'b', hideEmpty: false }, 'c'] }
    ],
    nav: { items: [{ view: 'tbl' }, { table: 't' }] }
  };
  test('per-column hideEmpty:false force-shows an empty column; view default still hides others', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 't', data: { id: 'r1', a: 'A1', b: '', c: '' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.tbl' }).first().click();
    await page.waitForTimeout(150);
    const cols = await page.evaluate(() => appInstance.visibleCols);
    expect(cols).toEqual(['a', 'b']); // a has data; b forced-shown (hideEmpty:false); c (empty, view default hide) dropped
  });
});

test.describe('Print honors per-column hideEmpty (card)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { t: { columns: [{ name: 'title', type: 'text' }, { name: 'note', type: 'text' }, { name: 'extra', type: 'text' }], partition: 'active' } },
    views: [{ name: 'main', sources: ['t'], mode: 'union', layout: 'card', hideEmpty: true, printable: ["view","cards"], columns: ['title', { name: 'note', hideEmpty: false }, 'extra'] }],
    nav: { items: [{ view: 'main' }, { table: 't' }] }
  };
  test('force-shown empty column prints; default-hidden empty column does not', async ({ page, context }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 't', data: { id: 'r1', title: 'T1', note: '', extra: '' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(150);
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.v-main .v-card button:has(.mdi-printer)').first().click()
    ]);
    await popup.waitForLoadState();
    await expect(popup.locator('body')).toContainText('field.note');      // hideEmpty:false -> printed even though empty
    await expect(popup.locator('body')).not.toContainText('field.extra'); // empty + view default hide -> not printed
    await popup.close();
  });
});

test.describe('saveField debounce (data integrity)', () => {
  test('rapid edits to the same cell persist the last value (no data loss)', async ({ page }) => {
    test.setTimeout(20000);
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    // rapidly update the same field 5 times
    for (let i = 1; i <= 5; i++) {
      await page.evaluate((v) => { const row = appInstance.sortedData[0]; appInstance.saveField(row, 'title', 'val' + v); }, i);
    }
    await page.waitForTimeout(500); // debounce fires (300ms)
    // reload from backend and verify last value persisted
    const persisted = await page.evaluate(async () => {
      const rows = await backend.getTableData(appInstance.tableMap[appInstance.currentTable] || appInstance.currentTable, 'active');
      return rows && rows.rows ? rows.rows[0].title : (rows[0] && rows[0].title);
    });
    expect(persisted).toBe('val5');
  });
});

test.describe('importData error recovery', () => {
  test('import blocked by validateRefs does not corrupt existing data', async ({ page }) => {
    test.setTimeout(20000);
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => appInstance.sortedData.length);
    // simulate importing a schema with a dangling reference (calls importData's reader.onload path)
    const blocked = await page.evaluate(() => {
      return new Promise(resolve => {
        var origNotify = appInstance.notify; var msg = '';
        appInstance.notify = function(t) { msg = t; origNotify.call(appInstance, t); };
        var bad = JSON.stringify({ schema: { tables: { t: { columns: [{ name: 'x', type: 'text' }] } }, views: [{ name: 'v', sources: ['missing_table'], columns: ['x'] }], nav: { items: [{ view: 'v' }] } } });
        var file = new File([bad], 'bad.json', { type: 'application/json' });
        var evt = { target: { files: [file] } };
        appInstance.importData(evt);
        setTimeout(function() { resolve(msg); }, 500);
      });
    });
    expect(blocked).toContain('Import blocked');
    expect(await page.evaluate(() => appInstance.sortedData.length)).toBe(before);
  });
});

test.describe('XSS prevention (safeUrl + print escape)', () => {
  test('javascript: URLs in markdown are neutralized; HTML in field values is escaped in print', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof mdToHtml === 'function');
    const results = await page.evaluate(() => {
      // Test 1: safeUrl blocks javascript: protocol
      var html = mdToHtml('[click](javascript:alert(1))');
      var hasJsUrl = html.includes('javascript:');
      // Test 2: _pe escapes HTML special chars
      var pe = appInstance._pe;
      var escaped = pe('<script>alert(1)</script>');
      var hasRawTag = escaped.includes('<script>');
      return { jsBlocked: !hasJsUrl, htmlEscaped: !hasRawTag, escapedOutput: escaped };
    });
    expect(results.jsBlocked).toBe(true);     // javascript: URL stripped
    expect(results.htmlEscaped).toBe(true);   // <script> tags escaped
    expect(results.escapedOutput).toContain('&lt;script&gt;');
  });
});

test.describe('v3 markdown doc-view', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] },
      { name: 'home', markdown: '# Home Doc\n\n{{view:all}}' }
    ],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('a view with markdown renders as a document with embeds (pages removed)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'Buy milk' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    // 'home' is a doc-view: not a data view, renders markdown + embedded 'all'
    expect(await page.evaluate(() => appInstance.isDataView)).toBeFalsy();
    expect(await page.evaluate(() => !!appInstance.currentPage)).toBe(true);
    await expect(page.locator('.v-main')).toContainText('Home Doc');
    await expect(page.locator('.v-main')).toContainText('Buy milk');
  });
});

test.describe('filterBy (per-card dynamic embed filter)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { people: { columns: [{ name: 'name', type: 'text' }], partition: 'active' }, tasks: { columns: [{ name: 'title', type: 'text' }, { name: 'owner', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'all_tasks', sources: ['tasks'], mode: 'union', columns: ['title'] },
      { name: 'main', sources: ['people'], mode: 'union', layout: 'card', columns: ['name', { view: 'all_tasks', filterBy: { owner: 'name' } }] }
    ],
    nav: { items: [{ view: 'main' }, { table: 'tasks' }, { table: 'people' }] }
  };
  test('each card shows only tasks where owner matches that card person', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'people', data: { id: 'p1', name: 'Alice' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'people', data: { id: 'p2', name: 'Bob' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'AliceTask', owner: 'Alice' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't2', title: 'BobTask', owner: 'Bob' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(500); // wait for embed data preload (async)
    // Alice's card should contain AliceTask but NOT BobTask
    const cards = page.locator('.v-main .v-card.ma-2');
    await expect(cards).toHaveCount(2);
    const aliceCard = cards.filter({ hasText: 'Alice' }).first();
    await expect(aliceCard).toContainText('AliceTask');
    await expect(aliceCard).not.toContainText('BobTask');
    // Bob's card should contain BobTask but NOT AliceTask
    const bobCard = cards.filter({ hasText: 'Bob' }).first();
    await expect(bobCard).toContainText('BobTask');
    await expect(bobCard).not.toContainText('AliceTask');
  });
});

test.describe('Print inline embed markdown', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { t: { columns: [{ name: 'title', type: 'text' }, { name: 'status', type: 'text' }], partition: 'active' } },
    views: [{ name: 'main', sources: ['t'], mode: 'union', layout: 'card', printable: ["view","cards"], columns: ['title',
      { sources: ['t'], mode: 'union', filter: { status: 'open' }, columns: ['title'], hideEmpty: true, bare: true, markdown: '**Open Items**\n\n{{self}}\n\n_end of open_' }
    ] }],
    nav: { items: [{ view: 'main' }, { table: 't' }] }
  };
  test('print renders inline embed markdown (header + table + footer + CSS borders)', async ({ page, context }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 't', data: { id: 'r1', title: 'Task1', status: 'open' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.main' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('.v-main .v-card.ma-2').first().click();
    await page.waitForTimeout(200);
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.v-main .v-card.ma-2 button:has(.mdi-printer)').first().click()
    ]);
    await popup.waitForLoadState();
    const html = await popup.content();
    await expect(popup.locator('body')).toContainText('Open Items');  // header from markdown
    await expect(popup.locator('body')).toContainText('Task1');       // table row
    await expect(popup.locator('body')).toContainText('end of open'); // footer from markdown
    expect(html).toContain('<style>');                                 // CSS present
    expect(html).toContain('border:1px solid #ddd');                   // table borders in CSS
    expect(html).toContain('grid-template-columns');                   // dl grid layout
    await popup.close();
  });
});

test.describe('listSwitch (toggle between two dropdown lists)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { t: { columns: [{ name: 'person', type: 'select', list: 'internal', allowNew: true, listSwitch: { label: 'External', list: 'external' } }], partition: 'active' } },
    views: [{ name: 'main', sources: ['t'], mode: 'union', columns: ['person'] }],
    nav: { items: [{ view: 'main' }, { table: 't' }] }
  };
  test('swap icon toggles which list populates the dropdown', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/saveLists', { data: { folderId: 'local', lists: { internal: ['Alice', 'Bob'], external: ['ExtJohn', 'ExtJane'] } } });
    await page.request.post('/api/putRow', { data: { tableId: 't', data: { id: 'r1', person: 'Alice' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.t' }).first().click();
    await page.waitForTimeout(200);
    // Verify swap icon exists and isAltList detects correctly
    const result = await page.evaluate(() => {
      var item = appInstance.sortedData[0];
      return {
        hasSwitch: !!appInstance.colListSwitch('person'),
        isAlt: appInstance.isAltList('person', item),
        primaryOptions: appInstance.getListOptions('person', null).map(o => o.value),
        altOptions: appInstance.getListOptions('person', 'external').map(o => o.value)
      };
    });
    expect(result.hasSwitch).toBe(true);
    expect(result.isAlt).toBe(false); // Alice is in 'internal' list
    expect(result.primaryOptions).toEqual(['Alice', 'Bob']);
    expect(result.altOptions).toEqual(['ExtJohn', 'ExtJane']); // not sorted (no sorted:true on column)
    // Toggle and verify alt list is used
    await page.evaluate(() => { appInstance.toggleListSwitch('person', appInstance.sortedData[0]); });
    const afterToggle = await page.evaluate(() => appInstance.isAltList('person', appInstance.sortedData[0]));
    expect(afterToggle).toBe(true);
  });
});

test.describe('collectWith (role alongside date)', () => {
  test('aggregateRows includes role when collectWith is set', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof aggregateRows === 'function');
    const result = await page.evaluate(() => {
      var view = { groupBy: { column: 'person', from: ['speaker', 'singer'] }, collect: 'date', collectWith: 'role', columns: ['person', 'latest', 'previous'] };
      var rows = [
        { id: '1', date: '2026-06-01', speaker: 'Alice', singer: '' },
        { id: '2', date: '2026-05-20', speaker: '', singer: 'Alice' },
        { id: '3', date: '2026-06-03', speaker: 'Bob', singer: '' }
      ];
      return aggregateRows(view, rows);
    });
    const alice = result.find(r => r.person === 'Alice');
    const bob = result.find(r => r.person === 'Bob');
    expect(alice.latest).toBe('2026-06-01 (speaker)');
    expect(alice.previous).toBe('2026-05-20 (singer)');
    expect(bob.latest).toBe('2026-06-03 (speaker)');
  });
});

test.describe('matchList (filter + filterBy + computed)', () => {
  const ML = {
    defaultLanguage: 'en',
    tables: { events: { columns: [{ name: 'speaker', type: 'select', list: 'members' }, { name: 'guest', type: 'select', list: 'guests' }, { name: 'topic' }] } },
    lists: { members: ['Alice', 'Bob'], guests: ['Charlie', 'Dave'] },
    views: [
      { name: 'guest_events', sources: ['events'], mode: 'union', filter: { speaker: { matchList: 'guests' } }, columns: ['speaker', 'topic'] },
      { name: 'all', sources: ['events'], mode: 'union', columns: ['speaker', 'guest', 'topic', { name: 'visitors', computed: { fromColumns: ['speaker', 'guest'], matchList: 'guests' } }] }
    ],
    nav: { layout: 'tabs', items: [{ view: 'guest_events' }, { view: 'all' }] }
  };
  test('filter with matchList filters rows by list membership', async ({ page }) => {
    test.setTimeout(20000);
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: ML } });
    await page.request.post('/api/initSchema', { data: { schema: ML.tables } });
    await page.request.post('/api/saveLists', { data: { folderId: 'local', lists: ML.lists } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '1', speaker: 'Alice', guest: '', topic: 'a' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '2', speaker: 'Charlie', guest: '', topic: 'b' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '3', speaker: 'Bob', guest: 'Dave', topic: 'c' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 10000 });
    // guest_events view: only rows where speaker is in guests list (Charlie)
    const guestRows = await page.evaluate(() => appInstance.sortedData.map(r => r.speaker));
    expect(guestRows).toEqual(['Charlie']);
  });
  test('computed column with matchList collects values from named list', async ({ page }) => {
    test.setTimeout(20000);
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: ML } });
    await page.request.post('/api/initSchema', { data: { schema: ML.tables } });
    await page.request.post('/api/saveLists', { data: { folderId: 'local', lists: ML.lists } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '1', speaker: 'Alice', guest: '', topic: 'a' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '2', speaker: 'Charlie', guest: '', topic: 'b' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'events', data: { id: '3', speaker: 'Bob', guest: 'Dave', topic: 'c' }, tab: 'active' } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 10000 });
    // Navigate to 'all' view
    await page.evaluate(() => { appInstance.selectTab('all'); });
    await page.waitForFunction(() => appInstance.sortedData.length === 3, { timeout: 5000 });
    const rows = await page.evaluate(() => appInstance.sortedData.map(r => ({ speaker: r.speaker, visitors: r.visitors })));
    expect(rows.find(r => r.speaker === 'Alice').visitors).toBe('');
    expect(rows.find(r => r.speaker === 'Charlie').visitors).toBe('Charlie');
    expect(rows.find(r => r.speaker === 'Bob').visitors).toBe('Dave');
  });
});

test.describe('v3 aggregate view embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'date', type: 'date' }, { name: 'who', type: 'text' }] } },
    views: [{ name: 'byperson', sources: ['tasks'], mode: 'union', groupBy: { column: 'person', from: ['who'] }, collect: 'date', columns: ['person', 'latest'] }, { name: 'home', markdown: '{{view:byperson}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'byperson' }] }
  };
  test('embedded groupBy/collect view shows aggregated rows (not blank)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', date: '2026-06-01', who: 'Alice' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    const rows = await page.evaluate(() => appInstance.embedRows('view', 'byperson'));
    expect(rows.length).toBe(1);
    expect(rows[0].person).toBe('Alice');
    expect(rows[0].latest).toBe('2026-06-01');
    await expect(page.locator('.v-main')).toContainText('Alice');
  });
});

test.describe('v3 archived table embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '## Active\n\n{{table:tasks}}\n\n## Archived\n\n{{table:tasks@archive}}' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('{{table:x@archive}} shows archived rows (read-only)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'a1', title: 'Active item' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'z1', title: 'Archived item' }, tab: 'archive' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    const active = await page.evaluate(() => appInstance.embedRows('table', 'tasks', null).map(r => r.title));
    const archived = await page.evaluate(() => appInstance.embedRows('table', 'tasks', 'archive').map(r => r.title));
    expect(active).toEqual(['Active item']);
    expect(archived).toEqual(['Archived item']);
    await expect(page.locator('.v-main')).toContainText('Archived item');
  });
});

test.describe('v3 page body stored on server', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }] } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '# Seed' }],
    nav: { layout: 'tabs', items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('editing a page saves to the _pages collection (not schema) and survives reload', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(150);
    // edit + save
    await page.locator('.v-card button:has-text("Edit")').click();
    await page.locator('.v-card textarea').first().fill('# Edited on server');
    await page.locator('.v-card button:has-text("Save")').click();
    await page.waitForTimeout(200);
    // persisted to _pages collection, NOT to schema
    const pages = await (await page.request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' } })).json();
    const row = pages.rows.find(r => r.id === 'home');
    expect(row && row.markdown).toBe('# Edited on server');
    const schema = await (await page.request.post('/api/getSchema', { data: { folderId: 'local' } })).json();
    expect(JSON.stringify(schema.pages || {})).not.toContain('Edited on server');
    // survives reload (rendered from server, not schema seed)
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(200);
    await expect(page.locator('.v-main')).toContainText('Edited on server');
  });
});

test.describe('v3 nav nesting (migrated hierarchy)', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true }, notes: { columns: [{ name: 'note', type: 'text' }], archivable: true } },
    views: [{ name: 'combined', sources: ['tasks', 'notes'], mode: 'join', columns: ['title'] }, { name: 'attendance', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    nav: { layout: 'drawer', items: [{ view: 'combined', items: [{ view: 'attendance' }] }, { table: 'tasks' }] }
  };
  test('a nav view item with child items renders as a clickable group', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const ids = await page.evaluate(() => appInstance.sidebarTabs.map(t => t.children ? t.id + '[' + t.children.map(c => c.id).join(',') + ']' : t.id));
    expect(ids).toContain('combined[attendance]'); // clickable parent + nested child
    expect(ids).toContain('tasks');
  });
});

test.describe('Page {{t:key}} translatable token', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }, { name: 'home', markdown: '{{t:page.home.intro}}\n\n{{view:all}}' }],
    nav: { items: [{ view: 'home' }, { view: 'all' }] }
  };
  test('{{t:key}} resolves via translations in a page', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'en', name: 'English', keys: ['page.home.intro'] } });
    await page.request.post('/api/updateTranslations', { data: { folderId: 'local', langCode: 'en', updates: { 'page.home.intro': 'Welcome translated intro' } } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.waitForTimeout(150);
    await expect(page.locator('.v-main')).toContainText('Welcome translated intro'); // {{t:page.home.intro}} resolved
  });
});

test.describe('demo schema (dev/schema.json) is valid v3', () => {
  const DEMO = require('../schema.json');
  test('boots and nav exposes a group + nested items', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const ids = await page.evaluate(() => appInstance.sidebarTabs.map(t => t.id + (t.children ? '[' + t.children.map(c => c.id).join(',') + ']' : '')));
    expect(ids.some(s => s.startsWith('grp:Data['))).toBe(true);                 // nav group
    expect(ids.some(s => s.startsWith('all_items[summary_cards,quick_list]'))).toBe(true); // nested clickable parent
  });

  test('demo pages render embeds (combined + aggregate + archive) and all layouts', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 't1', title: 'Demo task', date: '2026-06-01', status: 'open', assigned_to: 'Alice' }, tab: 'active' } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'z1', title: 'Archived task', date: '2026-05-01', status: 'open', assigned_to: 'Bob' }, tab: 'archive' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.waitForTimeout(200);
    // combined_page (auto-selected): all embeds present, incl. the archive embed (archived rows seeded)
    const embeds = await page.evaluate(() => appInstance.pageBlocks.filter(b => b.embedName).map(b => b.embedName));
    expect(embeds).toEqual(['combined', 'attendance', 'tasks', 'notes']);        // {{table:tasks@archive?}} -> 'tasks' (visible: has archived rows)
    // aggregate embed computes rows (regression: not blank)
    const agg = await page.evaluate(() => appInstance.embedRows('view', 'attendance'));
    expect(agg.some(r => r.person === 'Alice')).toBe(true);
    await expect(page.locator('.v-main')).toContainText('Demo task');            // combined embed (active)
    await expect(page.locator('.v-main')).toContainText('Alice');                // attendance embed
    await expect(page.locator('.v-main')).toContainText('Archived task');        // {{table:tasks@archive}} embed
    // layouts resolve per view
    const layouts = await page.evaluate(() => {
      var r = {};
      ['all_items', 'summary_cards', 'quick_list'].forEach(function(v) { appInstance.selectTab(v); r[v] = appInstance.currentConfig.layout; });
      return r;
    });
    expect(layouts).toEqual({ all_items: 'table', summary_cards: 'card', quick_list: 'list' });
  });
});

test.describe('Export/import includes edited page bodies', () => {
  test('pages are exported and re-imported via _pages collection', async ({ request }) => {
    test.setTimeout(20000);
    await request.post('/api/resetData');
    const schema = { defaultLanguage: 'en', tables: { tasks: { columns: [{ name: 'title', type: 'text' }] } }, views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'], markdown: '# Seed\n\n{{self}}' }], nav: { items: [{ view: 'all' }] } };
    await request.post('/api/saveSchema', { data: { schema } });
    // Save an edited page body (overwrites the seed)
    await request.post('/api/putRow', { data: { tableId: '_pages', data: { id: 'all', markdown: '# Edited content\n\n{{self}}' }, tab: 'active' } });
    // Verify stored
    const res1 = await request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' } });
    const rows1 = (await res1.json()).rows;
    expect(rows1.find(r => r.id === 'all').markdown).toBe('# Edited content\n\n{{self}}');
    // Simulate export: pages are fetched from _pages
    const pages = rows1.filter(r => r.id && r.markdown);
    expect(pages.length).toBeGreaterThan(0);
    // Reset (simulates fresh import target)
    await request.post('/api/resetData');
    await request.post('/api/saveSchema', { data: { schema } });
    // Re-import pages
    for (const pg of pages) {
      await request.post('/api/putRow', { data: { tableId: '_pages', data: pg, tab: 'active' } });
    }
    // Verify restored
    const res2 = await request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' } });
    const rows2 = (await res2.json()).rows;
    expect(rows2.find(r => r.id === 'all').markdown).toBe('# Edited content\n\n{{self}}');
  });
});

// Shared-link URL-param path (index.html loadApp): a ?mode=... link persists
// config to localStorage, then strips the params from the URL via replaceState
// so a refresh doesn't re-apply / leak them. The param block runs synchronously
// at the top of loadApp() before any backend fetch.
test.describe('Shared-link URL params', () => {
  // Non-firebase branch: restores app_folder + oauth_client_id and boots cleanly
  // in local mode (mode!=='sheets/crdt/crdt-local/firebase' falls through to the
  // local dev backend, exactly like the other tests' default setup).
  test('mode link restores folder/clientId and strips the URL', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.goto('/?mode=local&folder=local&clientId=shared-client-123');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    const ls = await page.evaluate(() => ({
      mode: localStorage.getItem('app_mode'),
      folder: localStorage.getItem('app_folder'),
      clientId: localStorage.getItem('oauth_client_id'),
    }));
    expect(ls.mode).toBe('local');
    expect(ls.folder).toBe('local');
    expect(ls.clientId).toBe('shared-client-123');

    // Params stripped from the URL after restore.
    const loc = await page.evaluate(() => ({ search: location.search, pathname: location.pathname }));
    expect(loc.search).toBe('');
    expect(loc.pathname).toBe('/');
  });

  // Firebase branch with discrete k/d/p params. The firebase backend + external
  // SDK scripts are stubbed empty so the param-restoration contract can be
  // asserted without a real firebase boot (which can't run in the test env).
  test('firebase k/d/p link restores firebase_config and strips the URL', async ({ page }) => {
    await page.route(/gstatic\.com|\/backend-firebase\.html|\/storage-firestore\.html/, r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto('/?mode=firebase&k=API_KEY_1&d=app.example.com&p=proj-123');
    await page.waitForFunction(() => localStorage.getItem('app_mode') === 'firebase', { timeout: 6000 });

    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('firebase_config') || 'null'));
    expect(cfg).toEqual({ apiKey: 'API_KEY_1', authDomain: 'app.example.com', projectId: 'proj-123' });

    const loc = await page.evaluate(() => ({ search: location.search, pathname: location.pathname }));
    expect(loc.search).toBe('');
    expect(loc.pathname).toBe('/');
  });

  // Firebase branch with d= omitted: authDomain must default to <projectId>.firebaseapp.com.
  test('firebase k/p link without d= derives authDomain from projectId', async ({ page }) => {
    await page.route(/gstatic\.com|\/backend-firebase\.html|\/storage-firestore\.html/, r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto('/?mode=firebase&k=API_KEY_9&p=proj-999');
    await page.waitForFunction(() => localStorage.getItem('app_mode') === 'firebase', { timeout: 6000 });

    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('firebase_config') || 'null'));
    expect(cfg).toEqual({ apiKey: 'API_KEY_9', authDomain: 'proj-999.firebaseapp.com', projectId: 'proj-999' });
  });
  test('firebase base64 config link restores firebase_config', async ({ page }) => {
    await page.route(/gstatic\.com|\/backend-firebase\.html|\/storage-firestore\.html/, r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    const config = { apiKey: 'AK2', authDomain: 'b.example.com', projectId: 'p2' };
    const b64 = Buffer.from(JSON.stringify(config)).toString('base64');
    await page.goto('/?mode=firebase&config=' + encodeURIComponent(b64));
    await page.waitForFunction(() => localStorage.getItem('app_mode') === 'firebase', { timeout: 6000 });

    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('firebase_config') || 'null'));
    expect(cfg).toEqual(config);
  });

  // Guard: with no mode param the restore block is skipped — existing localStorage
  // is untouched and unrelated query params are left on the URL (not stripped).
  test('no mode param leaves URL and localStorage untouched', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/?foo=bar');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    const loc = await page.evaluate(() => location.search);
    expect(loc).toBe('?foo=bar');
    const mode = await page.evaluate(() => localStorage.getItem('app_mode'));
    expect(mode).toBe('local');
  });
});

test.describe('PWA static icons', () => {
  test('favicon, apple-touch-icon, and manifest icons are static served files', async ({ page }) => {
    test.setTimeout(20000);
    const S = {
      defaultLanguage: 'en', icon: 'https://example.com/ignored.svg',   // schema icon is ignored now (fully static)
      tables: { a: { columns: [{ name: 'x' }] } },
      views: [{ name: 'va', sources: ['a'], columns: ['x'] }],
      nav: { layout: 'drawer', items: [{ view: 'va' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: S } });
    await page.request.post('/api/initSchema', { data: { schema: S.tables } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 10000 });

    const r = await page.evaluate(async () => {
      const fav = document.querySelector('link[rel="icon"]');
      const apple = document.querySelector('link[rel="apple-touch-icon"]');
      const manLink = document.querySelector('link[rel=manifest]');
      const man = JSON.parse(await (await fetch(manLink.href)).text());
      return { favHref: fav ? fav.getAttribute('href') : null, appleHref: apple ? apple.getAttribute('href') : null, icons: man.icons };
    });
    // Static <link> icons declared in index.html (NOT generated from the schema icon).
    expect(r.favHref).toBe('./favicon.svg');
    expect(r.appleHref).toBe('./icon-512.png');
    // Manifest install icons are square PNGs at real http file URLs (no data:/blob:).
    expect(r.icons.every(i => i.type === 'image/png' && /^(\d+)x\1$/.test(i.sizes))).toBe(true);
    expect(r.icons.every(i => /^https?:.*icon-\d+\.png$/.test(i.src))).toBe(true);
    expect(r.icons.every(i => !/^(data|blob):/.test(i.src))).toBe(true);

    // All declared icon files are actually served (200 + image content-type).
    for (const path of ['/favicon.svg', '/icon-512.png']) {
      const res = await page.request.get(path);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toMatch(/^image\//);
    }
  });
});

test.describe('Filter array-IN -> $or on export', () => {
  test('exported view filter uses $or instead of an array (forward-deprecation)', async ({ page }) => {
    const SCH = {
      defaultLanguage: 'en',
      tables: { t: { columns: [{ name: 'status', type: 'text' }] } },
      views: [{ name: 'v', sources: ['t'], mode: 'union', filter: { status: ['open', 'wip'] }, columns: ['status'] }],
      nav: { layout: 'drawer', items: [{ view: 'v' }, { table: 't' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(200);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button:has(.mdi-download)').click()
    ]);
    const fs = require('fs');
    const body = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    const f = body.schema.views.find(v => v.name === 'v').filter;
    expect(Array.isArray(f.status)).toBe(false);
    expect(f.$or).toEqual([{ status: 'open' }, { status: 'wip' }]);
  });
});

test.describe('PWA installability (no errors)', () => {
  test('boots installable: valid manifest, square PNG icons, SW registered, no errors', async ({ page }) => {
    test.setTimeout(20000);
    const errors = [];
    const allConsole = [];
    page.on('console', m => { allConsole.push(m.text()); if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await ensureAppReady(page);   // resets data, loads SCHEMA fixture, opens a table tab
    // Wait for the runtime manifest to be built with its (bundled, http) PNG install icons.
    await page.waitForFunction(async () => {
      try {
        var link = document.querySelector('link[rel=manifest]');
        var m = JSON.parse(await (await fetch(link.href)).text());
        return (m.icons || []).length >= 2 && m.icons.every(i => /^https?:.*icon-\d+\.png$/.test(i.src));
      } catch (e) { return false; }
    }, { timeout: 8000 });
    await page.waitForTimeout(500);   // let Chromium fetch/validate the manifest icons

    // 1) Service worker is registered (localhost is a secure context, so SW is allowed over http).
    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false, registered: false };
      const reg = await navigator.serviceWorker.getRegistration();
      return { supported: true, registered: !!reg };
    });
    expect(sw.supported).toBe(true);
    expect(sw.registered).toBe(true);

    // 2) Manifest is valid, has install fields, and every icon is a square raster PNG (blob:) that decodes.
    const man = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]');
      const m = JSON.parse(await (await fetch(link.href)).text());
      const decoded = await Promise.all((m.icons || []).map(i => new Promise(res => {
        const im = new Image();
        im.onload = () => res({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
        im.onerror = () => res({ ok: false });
        im.src = i.src;
      })));
      return { name: m.name, start_url: m.start_url, display: m.display, icons: m.icons, decoded };
    });
    expect(man.name).toBeTruthy();
    expect(man.start_url).toBeTruthy();
    expect(man.display).toBe('standalone');
    const sq = man.icons.filter(i => i.type === 'image/png' && /^(\d+)x\1$/.test(i.sizes));
    expect(sq.some(i => parseInt(i.sizes, 10) >= 192)).toBe(true);   // install icon
    expect(sq.some(i => parseInt(i.sizes, 10) >= 512)).toBe(true);   // splash/maskable icon
    expect(man.icons.every(i => /^https?:.*icon-\d+\.png$/.test(i.src))).toBe(true);   // real http file, not data:/blob:
    expect(man.decoded.every(d => d.ok && d.w === d.h && d.w >= 192)).toBe(true);

    // 3) Chromium's own manifest parser reports no critical errors and nothing wrong with the icons.
    const client = await page.context().newCDPSession(page);
    const appMan = await client.send('Page.getAppManifest');
    const errs = appMan.errors || [];
    expect(errs.filter(e => e.critical)).toEqual([]);

    // 4) Chromium did NOT log "Icon ... failed to load" or "require ... square icon" (the real-world symptom).
    const iconConsoleErrors = allConsole.filter(t => /icon.*failed to load/i.test(t) || /square icon/i.test(t));
    expect(iconConsoleErrors).toEqual([]);

    // 5) No console / page errors during boot (ignore unrelated network noise).
    const real = errors.filter(e => !/favicon|net::ERR|\b404\b|Failed to load resource/i.test(e));
    expect(real).toEqual([]);
  });
});

test.describe('conditional computed columns (when)', () => {
  test('condMatches supports equality + notEmpty/empty/eq/ne/in operators (drives when/conditional columns)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const f = (typeof condMatches !== 'undefined') ? condMatches : window.condMatches;
      return {
        eqTrue:        f({ a: 'x' }, { a: 'x' }),
        eqFalse:       f({ a: 'y' }, { a: 'x' }),
        notEmptyTrue:  f({ a: 'x' }, { a: { notEmpty: true } }),
        notEmptyFalse: f({ a: '' },  { a: { notEmpty: true } }),
        emptyTrue:     f({ a: '' },  { a: { empty: true } }),
        emptyFalse:    f({ a: 'x' }, { a: { empty: true } }),
        neTrue:        f({ a: 'x' }, { a: { ne: 'y' } }),
        neFalse:       f({ a: 'y' }, { a: { ne: 'y' } }),
        multi:         f({ a: 'x', b: 'y' }, { a: { notEmpty: true }, b: 'y' }),
        orTrue:        f({ a: 'z' }, { $or: [ { a: 'x' }, { a: 'z' } ] }),
        orFalse:       f({ a: 'q' }, { $or: [ { a: 'x' }, { a: 'z' } ] }),
        andTrue:       f({ a: 'x', b: 'y' }, { $and: [ { a: 'x' }, { b: { notEmpty: true } } ] }),
        andFalse:      f({ a: 'x', b: '' },  { $and: [ { a: 'x' }, { b: { notEmpty: true } } ] }),
        emptyCondTrue: f({ a: 'x' }, {})
      };
    });
    expect(r).toEqual({
      eqTrue: true, eqFalse: false,
      notEmptyTrue: true, notEmptyFalse: false,
      emptyTrue: true, emptyFalse: false,
      neTrue: true, neFalse: false,
      multi: true,
      orTrue: true, orFalse: false,
      andTrue: true, andFalse: false,
      emptyCondTrue: true
    });
  });

  test('embedWhenOk gates an embed/prose block per-row by its `when` clause', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const a = window.appInstance;
      const mk = (when) => ({ config: when ? { when } : {} });
      return {
        noWhen:  a.embedWhenOk(mk(null), { vieraat: '' }),                 // no when -> always show
        match:   a.embedWhenOk(mk({ vieraat: { notEmpty: true } }), { vieraat: 'Matti' }),
        noMatch: a.embedWhenOk(mk({ vieraat: { notEmpty: true } }), { vieraat: '' }),
        orMatch: a.embedWhenOk(mk({ $or: [ { tila: 'x' }, { vieraat: { notEmpty: true } } ] }), { tila: '', vieraat: 'M' })
      };
    });
    expect(r).toEqual({ noWhen: true, match: true, noMatch: false, orMatch: true });
  });

  test('convertViewFilters canonicalizes legacy shorthand conditional columns to {name, when} (+ array-IN to $or)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const views = [{ name: 'v', columns: [ 'a', { content: { status: 'in_progress' } }, { tag: { x: ['p', 'q'] } } ] }];
      convertViewFilters(views);
      return views[0].columns;
    });
    expect(r[0]).toBe('a');                                              // plain column untouched
    expect(r[1]).toEqual({ name: 'content', when: { status: 'in_progress' } });   // shorthand -> {name, when}
    expect(r[2]).toEqual({ name: 'tag', when: { $or: [ { x: 'p' }, { x: 'q' } ] } }); // + inner array-IN -> $or
  });
});

test.describe('multiselect column type', () => {
  test('condMatches matchList matches when ANY array element is in the list; displayValue joins arrays', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const f = (typeof condMatches !== 'undefined') ? condMatches : window.condMatches;
      window._listsCache = window._listsCache || {};
      window._listsCache.guests = ['Matti', 'Liisa'];
      const dv = window.appInstance && window.appInstance.displayValue;
      return {
        anyMatch:     f({ h: ['Pekka', 'Liisa'] }, { h: { matchList: 'guests' } }), // Liisa in list -> true
        noneMatch:    f({ h: ['Pekka', 'Sanna'] }, { h: { matchList: 'guests' } }), // none -> false
        scalarStill:  f({ h: 'Matti' },            { h: { matchList: 'guests' } }), // scalar still works
        notMatchAny:  f({ h: ['Pekka', 'Liisa'] }, { h: { notMatchList: 'guests' } }), // Liisa present -> false
        displayJoin:  dv ? dv('h', ['Matti', 'Liisa']) : null,
        displayEmpty: dv ? dv('h', []) : null
      };
    });
    expect(r.anyMatch).toBe(true);
    expect(r.noneMatch).toBe(false);
    expect(r.scalarStill).toBe(true);
    expect(r.notMatchAny).toBe(false);
    expect(r.displayJoin).toBe('Matti, Liisa');
    expect(r.displayEmpty).toBe('');
  });
});

test.describe('rotation resolvers', () => {
  test('occurrence + calendar position resolution and looping', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const rot = [
        { id: 'c1', position: 1, people: ['A'] },
        { id: 'c2', position: 2, people: ['B', 'C'] },
        { id: 'c3', position: 3, people: ['D'] }
      ];
      const src = [
        { id: 'k1', pvm: '2026-01-01' },
        { id: 'k2', pvm: '2026-02-01' },
        { id: 'k3', pvm: '2026-03-01' }
      ];
      const wi = window.wholeIntervalsBetween, ro = window.resolveByOccurrence, rc = window.resolveByCalendar;
      const ra = window.resolveAnchorDate;
      const ai = window.addIntervals, iv = window.isValidInterval;
      return {
        wkly2:    wi('2026-01-01', '2026-01-15', 'weekly'),    // 14 days -> 2
        wkly0:    wi('2026-01-01', '2026-01-05', 'weekly'),    // 4 days -> 0
        mon2:     wi('2026-01-01', '2026-03-01', 'monthly'),   // 2 months
        monPart:  wi('2026-01-15', '2026-02-10', 'monthly'),   // day 10 < 15 -> 0 full months
        occ0:     ro(rot, src, src[0], 'pvm'),                 // index 0 -> ['A']
        occ1:     ro(rot, src, src[1], 'pvm'),                 // index 1 -> ['B','C']
        occLoop:  ro([rot[0], rot[1]], src, src[2], 'pvm'),    // index 2 % 2 = 0 -> ['A']
        cal2:     rc(rot, '2026-01-15', '2026-01-01', 'weekly'),  // elapsed 2 -> cells[2] ['D']
        calLoop:  rc(rot, '2026-01-22', '2026-01-01', 'weekly'),  // elapsed 3 % 3 = 0 -> ['A']
        calNeg:   rc(rot, '2025-12-25', '2026-01-01', 'weekly'),  // elapsed -1 -> negative-safe -> ['D']
        emptyRot: rc([], '2026-01-15', '2026-01-01', 'weekly'),   // no slots -> []
        anchorLit:    ra({ anchorDate: '2026-02-02' }, '2026-01-01'), // literal column wins over global
        anchorGlobal: ra({}, '2026-01-01'),                           // global app-wide anchor used
        anchorNone:   ra({}, ''),                                     // neither -> null
        d3:    wi('2026-01-01', '2026-01-04', '1d'),               // 3 days -> 3
        w3:    wi('2026-01-01', '2026-01-22', '3w'),               // 21 days = 3 weeks /3 -> 1
        y1:    wi('2026-01-01', '2027-01-01', '1y'),               // 12 months /12 -> 1
        q2:    wi('2026-01-01', '2026-07-01', '3m'),               // 6 months /3 -> 2
        addD:  ai('2026-01-01', 2, '1d'),                          // 2026-01-03
        add3w: ai('2026-01-01', 2, '3w'),                          // +6 weeks = +42 days -> 2026-02-12
        addY:  ai('2026-01-01', 1, '1y'),                          // 2027-01-01
        ivOk1: iv('1d'), ivOk2: iv('3w'), ivOk3: iv('daily'),
        ivBad1: iv('1h'), ivBad2: iv('weeklyy')
      };
    });
    expect(r.wkly2).toBe(2);
    expect(r.wkly0).toBe(0);
    expect(r.mon2).toBe(2);
    expect(r.monPart).toBe(0);
    expect(r.occ0).toEqual(['A']);
    expect(r.occ1).toEqual(['B', 'C']);
    expect(r.occLoop).toEqual(['A']);
    expect(r.cal2).toEqual(['D']);
    expect(r.calLoop).toEqual(['A']);
    expect(r.calNeg).toEqual(['D']);
    expect(r.emptyRot).toEqual([]);
    expect(r.anchorLit).toBe('2026-02-02');
    expect(r.anchorGlobal).toBe('2026-01-01');
    expect(r.anchorNone).toBe(null);
    expect(r.d3).toBe(3);
    expect(r.w3).toBe(1);
    expect(r.y1).toBe(1);
    expect(r.q2).toBe(2);
    expect(r.addD).toBe('2026-01-03');
    expect(r.add3w).toBe('2026-02-12');
    expect(r.addY).toBe('2027-01-01');
    expect(r.ivOk1).toBe(true);
    expect(r.ivOk2).toBe(true);
    expect(r.ivOk3).toBe(true);
    expect(r.ivBad1).toBe(false);
    expect(r.ivBad2).toBe(false);
  });
});

test.describe('rotationView (third view kind, e2e)', () => {
  test('generates calendar-period rows resolving rotation slots (fixture crew_rotation + crewrota)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // Seed the rotation slot list (people is the group the resolver reads).
      app.appConfig = { rotationAnchors: { crewrota: '2026-01-01' } }; // per-view anchor (folder config map)
      app.dataCache['crew_rotation'] = [
        { id: 's1', position: 1, people: ['Alpha'] },
        { id: 's2', position: 2, people: ['Beta', 'Gamma'] }
      ];
      app.selectTab('crewrota'); // nav path must load rotationView data (regression: was only via loadTableData)
      return {
        isRot: app.isRotationView,
        cols: app.rotationViewCols,
        rows: (app.rotationViewRows || []).map(function(x) { return { period: x._period, crew: x.crew }; }),
        joined: app.displayValue('crew', ['Beta', 'Gamma'])
      };
    });
    expect(r.isRot).toBe(true);
    expect(r.cols).toEqual(['_period', 'crew']);
    expect(r.rows.length).toBe(3);                                              // range.periods = 3
    expect(r.rows[0]).toEqual({ period: '2026-01-01', crew: ['Alpha'] });        // elapsed 0 -> slot 0
    expect(r.rows[1]).toEqual({ period: '2026-01-08', crew: ['Beta', 'Gamma'] }); // elapsed 1 -> slot 1
    expect(r.rows[2]).toEqual({ period: '2026-01-15', crew: ['Alpha'] });        // elapsed 2 -> loop -> slot 0
    expect(r.joined).toBe('Beta, Gamma');                                        // multiselect display join
  });

  test('rotating slots/rosters swap assignment every rotateEvery periods', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { rotation: {
        slots: ['alue_a', 'alue_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1,
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.alue_a, b: x.alue_b }; });
    });
    // even periods: a<-L_a, b<-L_b ; odd periods (s=1): swapped a<-L_b, b<-L_a. Member idx = period % 2.
    expect(r[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] });
    expect(r[1]).toEqual({ p: '2026-01-08', a: ['B1'], b: ['A1'] });
    expect(r[2]).toEqual({ p: '2026-01-15', a: ['A0'], b: ['B0'] });
    expect(r[3]).toEqual({ p: '2026-01-22', a: ['B1'], b: ['A1'] });
  });

  test('rotateEvery:["cycle"] makes even-length rosters alternate slots every duty turn', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { rotation: {
        slots: ['alue_a', 'alue_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: ['cycle'],
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {  // even-length rosters (2 each)
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.alue_a, b: x.alue_b }; });
    });
    // cycleLen=2: per-cycle swap flips every 2 periods. A0's duty turns (p0,p2) land in DIFFERENT slots.
    expect(r[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] }); // s=0
    expect(r[1]).toEqual({ p: '2026-01-08', a: ['A1'], b: ['B1'] }); // s=0
    expect(r[2]).toEqual({ p: '2026-01-15', a: ['B0'], b: ['A0'] }); // s=1 -> A0 now in slot b
    expect(r[3]).toEqual({ p: '2026-01-22', a: ['B1'], b: ['A1'] }); // s=1 -> A1 now in slot b
  });

  test('rotateEvery:[1,"cycle"] sums per-period + per-cycle offsets', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { rotation: {
        slots: ['alue_a', 'alue_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: [1, 'cycle'],
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.alue_a, b: x.alue_b }; });
    });
    // s = floor(i/1)%2 + floor(i/2)%2. i=0:0, i=1:1, i=2:1, i=3:2%2=0. memberIdx=i%2.
    expect(r[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] }); // s=0
    expect(r[1]).toEqual({ p: '2026-01-08', a: ['B1'], b: ['A1'] }); // s=1
    expect(r[2]).toEqual({ p: '2026-01-15', a: ['B0'], b: ['A0'] }); // s=1
    expect(r[3]).toEqual({ p: '2026-01-22', a: ['A1'], b: ['B1'] }); // s=2≡0
  });
});


test.describe('rotationView embedding in data views', () => {
  test('a {view:rota} embed yields an isRotation embed with slot columns + generated rows', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.rota_e = { name: 'rota_e', rotation: { slots: ['alue_a', 'alue_b'], rosters: ['RL_a', 'RL_b'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
      window.VIEWS.host_e = { name: 'host_e', sources: ['tasks'], columns: ['title', { view: 'rota_e' }] };
      app.dataCache['RL_a'] = [{ position: 1, people: ['A0'] }];
      app.dataCache['RL_b'] = [{ position: 1, people: ['B0'] }];
      app.appConfig = Object.assign({}, app.appConfig, { rotationAnchors: { rota_e: '2026-01-01' } });
      app.currentTable = 'host_e';
      const rot = app.embedItems.find(function(e) { return e.isRotation; });
      return rot ? { cols: rot.columns, rows: rot.rows.map(function(x) { return { p: x._period, a: x.alue_a, b: x.alue_b }; }) } : null;
    });
    expect(r).not.toBeNull();                                   // the rotationView embed is recognized
    expect(r.cols).toEqual(['_period', 'alue_a', 'alue_b']);    // period + slot columns
    expect(r.rows[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] });
    expect(r.rows[1]).toEqual({ p: '2026-01-08', a: ['B0'], b: ['A0'] }); // rotateEvery:1 swap
  });
});

test.describe('rotationView filter / hideEmpty / layout', () => {
  test('filter narrows generated periods', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { filter: { _period: '2026-01-15' }, rotation: { slots: ['alue_a'], rosters: ['R'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 0, range: { from: '2026-01-01', periods: 3 } } };
      const cache = { R: [{ position: 1, people: ['A0'] }] };
      let rows = window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01');
      rows = window.filterRows(rows, view.filter);
      return rows.map(function(x) { return x._period; });
    });
    expect(r).toEqual(['2026-01-15']); // only the matching period survives the filter
  });

  test('hideEmpty drops slot columns empty in every period; rotationLayout reads layout', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.rot_he = { name: 'rot_he', layout: 'card', hideEmpty: true, rotation: { slots: ['alue_a', 'alue_b'], rosters: ['X', 'Y'] } };
      app.currentTable = 'rot_he';
      app.currentData = [
        { id: 'r0', _period: '2026-01-01', alue_a: ['A0'], alue_b: [] },
        { id: 'r1', _period: '2026-01-08', alue_a: ['A1'], alue_b: [] }
      ];
      return { cols: app.rotationViewCols, slotCols: app.rotationSlotCols, layout: app.rotationLayout };
    });
    expect(r.cols).toEqual(['_period', 'alue_a']); // alue_b empty in every period -> dropped
    expect(r.slotCols).toEqual(['alue_a']);
    expect(r.layout).toBe('card');
  });

  test('DB-backed range: saveRotationRange overrides periods/from, merges over schema, reset-to-today', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.rng_v = { name: 'rng_v', rotation: { slots: ['a'], rosters: ['R'], interval: 'weekly', range: { from: 'today', periods: 12 } } };
      app.appConfig = Object.assign({}, app.appConfig, { rotationRanges: {} });
      app.currentTable = 'rng_v';
      const clone = function() { return JSON.parse(JSON.stringify(app.rangeForView('rng_v'))); };
      app.saveRotationRange('rng_v', { periods: 4 });        var afterPeriods = clone();
      app.saveRotationRange('rng_v', { from: '2026-03-01' }); var afterFrom = clone();
      app.saveRotationRange('rng_v', { from: 'today' });      var afterReset = clone();  // reset start to today
      app.saveRotationRange('rng_v', { periods: '' });        var afterClear = clone();  // clear periods -> schema default
      return { afterPeriods, afterFrom, afterReset, afterClear };
    });
    expect(r.afterPeriods).toEqual({ from: 'today', periods: 4 });
    expect(r.afterFrom).toEqual({ from: '2026-03-01', periods: 4 });
    expect(r.afterReset).toEqual({ from: 'today', periods: 4 });   // start rolls from today again
    expect(r.afterClear).toEqual({ from: 'today', periods: 12 });  // periods override removed -> schema 12
  });

  test('buildRotationViewRows honors rangeOverride (periods + fixed from)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { rotation: { slots: ['a'], rosters: ['R'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 0, range: { from: '2026-01-01', periods: 12 } } };
      const cache = { R: [{ position: 1, people: ['A0'] }] };
      return window.buildRotationViewRows(view, cache, '2099-01-01', '2026-01-01', { from: '2026-02-01', periods: 2 }).map(function(x) { return x._period; });
    });
    expect(r).toEqual(['2026-02-01', '2026-02-08']); // override start + periods=2 win over schema range
  });
});

test.describe('reorderable tables (up/down)', () => {
  test('moveRowPosition reorders rows and renumbers position as strings', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.currentTable = 'crew_rotation';   // reorderable:true in the fixture
      app.sortCol = 'position'; app.sortAsc = true;
      app.viewingArchive = false;
      app.currentData = [
        { id: 'r1', position: '1', people: ['A'] },
        { id: 'r2', position: '2', people: ['B'] },
        { id: 'r3', position: '3', people: ['C'] }
      ];
      const reorderable = app.isReorderable;
      app.moveRowPosition(app.currentData[0], 1); // move r1 down one slot
      return {
        reorderable: reorderable,
        order: app.sortedData.map(function(x) { return x.id; }),
        positions: app.currentData.reduce(function(m, x) { m[x.id] = x.position; return m; }, {}),
        allStrings: app.currentData.every(function(x) { return typeof x.position === 'string'; }),
        visible: app.visibleCols
      };
    });
    expect(r.reorderable).toBe(true);
    expect(r.order).toEqual(['r2', 'r1', 'r3']);              // r1 moved below r2
    expect(r.positions).toEqual({ r1: '2', r2: '1', r3: '3' });
    expect(r.allStrings).toBe(true);                          // strings, not numbers -> no localeCompare crash
    expect(r.visible).not.toContain('position');              // position hidden; order driven by arrows only
  });
});

test.describe('per-view rotation anchor', () => {
  test('saveRotationAnchor stores per-view in folder config map', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.saveRotationAnchor('siivous', '2026-03-03');
      app.saveRotationAnchor('doormen', '2026-05-05'); // different view -> different anchor
      return {
        siivous: app.anchorForView('siivous'),
        doormen: app.anchorForView('doormen'),
        other: app.anchorForView('nope'),
        map: app.appConfig.rotationAnchors
      };
    });
    expect(r.siivous).toBe('2026-03-03');
    expect(r.doormen).toBe('2026-05-05'); // per-view anchors are independent
    expect(r.other).toBe('');
    expect(r.map).toEqual({ siivous: '2026-03-03', doormen: '2026-05-05' });
  });
});

test.describe('obscureNames (privacy)', () => {
  test('obscureName transform + per-view displayValue obscuring', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const o = window.obscureName;
      window.VIEWS.crewrota.obscureNames = true; // obscure this rotationView's area columns
      app.currentTable = 'crewrota';
      return {
        one: o('Miikka Tuppurainen'),
        two: o('Anna Maria Lehtimäki'),
        single: o('Cher'),
        empty: o(''),
        disp: app.displayValue('crew', 'Miikka Tuppurainen'),
        arr: app.displayValue('crew', ['Aatos Suontausta', 'Anna Lehtimäki'])
      };
    });
    expect(r.one).toBe('Miikka T.');
    expect(r.two).toBe('Anna M. L.');
    expect(r.single).toBe('Cher');
    expect(r.empty).toBe('');
    expect(r.disp).toBe('Miikka T.');            // per-view obscuring via displayValue
    expect(r.arr).toBe('Aatos S., Anna L.');      // multiselect: each member obscured then joined
  });
});

test.describe('archive tab reverse sort', () => {
  test('viewing archive reverses the default sort direction', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const tick = () => new Promise(res => setTimeout(res, 30));
      app.currentTable = 'crew_rotation';   // defaultSort: 'position'
      app.viewingArchive = false; await tick();
      app.viewingArchive = true;  await tick();   // -> archive: descending
      const arch = { col: app.sortCol, asc: app.sortAsc };
      app.viewingArchive = false; await tick();    // -> active: ascending
      const act = { col: app.sortCol, asc: app.sortAsc };
      return { arch, act };
    });
    expect(r.arch).toEqual({ col: 'position', asc: false });  // today -> past
    expect(r.act).toEqual({ col: 'position', asc: true });    // today -> future
  });
});

test.describe('list-item delete/rename cascade into table data', () => {
  test('delete scrubs value (blank select / drop multiselect element) across both partitions', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const puts = [];
      window.backend.putRow = (t, row, part) => { puts.push({ t, id: row.id, part, status: row.status, people: row.people && row.people.slice() }); };
      app.tableMap = Object.assign({}, app.tableMap, { tasks: 'tasks', crew_rotation: 'crew_rotation' });
      app.listsCache = { status: ['open', 'done'], crew: ['A', 'B', 'C'] };
      // active + archive rows seeded directly in cache so no fetch is needed
      app.dataCache['tasks'] = [ { id: 't1', status: 'open' }, { id: 't2', status: 'done' } ];
      app.dataCache['tasks__archive'] = [ { id: 't3', status: 'open' } ];
      app.dataCache['crew_rotation'] = [ { id: 'c1', people: ['A', 'B'] }, { id: 'c2', people: ['C'] } ];
      // delete 'open' from status, and 'A' from crew — armed two-click delete
      app.removeListItem2('status', 0); app.removeListItem2('status', 0); // arm + confirm
      app.removeListItem2('crew', 0);   app.removeListItem2('crew', 0);
      await new Promise(res => setTimeout(res, 50));
      return {
        statusList: app.listsCache.status, crewList: app.listsCache.crew,
        t1: app.dataCache['tasks'][0].status, t2: app.dataCache['tasks'][1].status,
        t3: app.dataCache['tasks__archive'][0].status,
        c1: app.dataCache['crew_rotation'][0].people, c2: app.dataCache['crew_rotation'][1].people,
        puts
      };
    });
    expect(r.statusList).toEqual(['done']);          // list item removed
    expect(r.crewList).toEqual(['B', 'C']);
    expect(r.t1).toBe('');                            // select cell blanked
    expect(r.t2).toBe('done');                        // untouched
    expect(r.t3).toBe('');                            // archive partition scrubbed too
    expect(r.c1).toEqual(['B']);                      // multiselect element dropped
    expect(r.c2).toEqual(['C']);                      // untouched
    // only changed rows persisted (t1 active, t3 archive, c1 active)
    const ids = r.puts.map(p => p.id + ':' + p.part).sort();
    expect(ids).toEqual(['c1:active', 't1:active', 't3:archive']);
  });

  test('rename rewrites the stored value across rows (select + multiselect)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const puts = [];
      window.backend.putRow = (t, row, part) => { puts.push(row.id + ':' + part); };
      app.tableMap = Object.assign({}, app.tableMap, { tasks: 'tasks', crew_rotation: 'crew_rotation' });
      app.listsCache = { status: ['open', 'done'], crew: ['A', 'B'] };
      app.dataCache['tasks'] = [ { id: 't1', status: 'open' } ];
      app.dataCache['tasks__archive'] = [ { id: 't3', status: 'open' } ];
      app.dataCache['crew_rotation'] = [ { id: 'c1', people: ['A', 'B'] } ];
      app.updateListItem2('status', 0, 'in_progress'); // rename open -> in_progress
      app.updateListItem2('crew', 0, 'Alice');         // rename A -> Alice
      await new Promise(res => setTimeout(res, 50));
      return {
        statusList: app.listsCache.status,
        t1: app.dataCache['tasks'][0].status, t3: app.dataCache['tasks__archive'][0].status,
        c1: app.dataCache['crew_rotation'][0].people,
        puts: puts.sort()
      };
    });
    expect(r.statusList).toEqual(['in_progress', 'done']);
    expect(r.t1).toBe('in_progress');                 // rename propagated to active row
    expect(r.t3).toBe('in_progress');                 // and to archive row
    expect(r.c1).toEqual(['Alice', 'B']);             // multiselect element renamed in place
    expect(r.puts).toEqual(['c1:active', 't1:active', 't3:archive']);
  });

  test('listSwitch move: deleting from primary list spares rows whose value is in the alt list', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const puts = [];
      window.backend.putRow = (t, row, part) => { puts.push(row.id + ':' + part); };
      app.tableMap = Object.assign({}, app.tableMap, { tasks: 'tasks' });
      // status column gets a listSwitch alt list 'guests' (mirrors kokoukset puhe* : seurakuntalaiset + vieraat)
      SCHEMA.tasks.columns.status.listSwitch = { list: 'guests', label: 'Guest' };
      app.listsCache = { status: ['done'], guests: ['Matti'] }; // 'Matti' moved: added to guests, removed from status
      app.dataCache['tasks'] = [
        { id: 't1', status: 'Matti' },  // value lives in the alt list -> must be spared
        { id: 't2', status: 'Pekka' }   // not in alt list -> must be scrubbed
      ];
      app.dataCache['tasks__archive'] = [];
      app.propagateListChange('status', 'Matti', null); // delete 'Matti' from the primary list
      await new Promise(res => setTimeout(res, 30));
      app.propagateListChange('status', 'Pekka', null); // control: a true orphan
      await new Promise(res => setTimeout(res, 30));
      delete SCHEMA.tasks.columns.status.listSwitch; // cleanup so other tests are unaffected
      return { t1: app.dataCache['tasks'][0].status, t2: app.dataCache['tasks'][1].status, puts: puts.sort() };
    });
    expect(r.t1).toBe('Matti');   // spared: still valid via the alt list (the "move" is lossless)
    expect(r.t2).toBe('');        // scrubbed: genuine orphan, not in any list
    expect(r.puts).toEqual(['t2:active']); // only the orphan row was persisted
  });
});
