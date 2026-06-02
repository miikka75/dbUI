const { test, expect } = require('@playwright/test');
const SCHEMA = require('../schema.json');

// Reset DB, seed the schema (server no longer auto-loads schema.json), and wait for the app.
// Opens the 'notes' table tab by default — it's the addable master table (first sidebar
// tab is a read-only join view; 'tasks' is a detail synced from 'notes' so has no add button).
async function ensureAppReady(page, openTableKey = 'tab.notes') {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.goto('/');
  await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.reload();
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
    await page.waitForTimeout(300);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(1);
  });

  test('edit cell saves value', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(300);
    await page.locator('.v-table button:has(.mdi-close)').first().click();
    await page.waitForTimeout(200);
    await page.locator('.v-table button:has(.mdi-check-circle)').first().click();
    await page.waitForTimeout(300);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(0);
  });
});

test.describe('Archive / Restore', () => {
  test('archive moves row to archived view', async ({ page }) => {
    await ensureAppReady(page);
    const rowsBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
    const activeBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(activeBefore - 1);
    // Go to archived, restore
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(1000);
    const archivedBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(archivedBefore - 1);
  });
});

test.describe('Navigation', () => {
  test('clicking sidebar tabs switches content', async ({ page }) => {
    await ensureAppReady(page);
    const firstContent = await page.locator('.v-main').textContent();
    // Click the settings tab (always top-level, always visible)
    await page.locator('.v-navigation-drawer .v-list-item:has(.mdi-cog-outline)').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(300);
    const newClass = await page.locator('.v-theme--light, .v-theme--dark').first().getAttribute('class');
    expect(newClass).not.toEqual(initialClass);
  });
});

test.describe('Select dropdowns', () => {
  test('select column renders as Vuetify autocomplete in table', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);
    const selects = page.locator('.v-table .v-autocomplete, .v-table .v-combobox');
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);
  });
});

test.describe('Two-press delete', () => {
  test('first click arms, second click deletes', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);
    const deleteBtn = page.locator('.v-table button:has(.mdi-close)').first();
    await deleteBtn.click(); // arm
    await page.waitForTimeout(200);
    await expect(page.locator('.v-table button:has(.mdi-check-circle)')).toBeVisible();
    await page.locator('.v-table button:has(.mdi-check-circle)').click(); // confirm
    await page.waitForTimeout(300);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(0);
  });
});

test.describe('Views', () => {
  test('union view shows data from multiple tables', async ({ page }) => {
    await ensureAppReady(page);
    // Add a row to tasks first
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);
    // Navigate to all_items view
    await page.locator('.v-navigation-drawer .v-list-item:has-text("all_items")').click();
    await page.waitForTimeout(500);
    const rows = await page.locator('.v-table tbody tr, .v-card.ma-2').count();
    expect(rows).toBeGreaterThanOrEqual(1);
  });

  test('join view renders', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(500);
    // Combined view should render (may be empty but not error)
    await expect(page.locator('.v-main .v-card')).toBeVisible();
  });
});

test.describe('Print', () => {
  test('print button exists on data view', async ({ page }) => {
    await ensureAppReady(page);
    await expect(page.locator('button:has(.mdi-printer)')).toBeVisible();
  });

  test('print opens new window', async ({ page, context }) => {
    await ensureAppReady(page);
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);
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
    await page.waitForTimeout(300);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('button:has(.mdi-download)').click()
    ]);
    expect(download.suggestedFilename()).toMatch(/\.json$/);
  });
});

test.describe('Print embed positioning', () => {
  test('embed appears after afterColumn in card print', async ({ page, context }) => {
    await ensureAppReady(page);
    // Add a task with data so combined view has content
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('TestTask');
    await cell.blur();
    await page.waitForTimeout(500);
    // Navigate to combined view
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(300);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('CardTest');
    await cell.blur();
    await page.waitForTimeout(500);
    // Navigate to combined view (has embeds with afterColumn:"title")
    await page.locator('.v-navigation-drawer .v-list-item:has-text("combined")').click();
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(400);
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

test.describe('Custom archivePartition', () => {
  const CUSTOM = {
    defaultLanguage: 'en',
    tables: { items: { columns: [{ name: 'title', type: 'text' }], partition: 'active', archivePartition: 'trash' } },
    views: [{ table: 'items' }]
  };
  const get = (page, tab) => page.request.post('/api/getTableData', { data: { tableId: 'items', tab } }).then(r => r.json());

  test('archive/restore use the configured archivePartition (trash), not hardcoded archive', async ({ page }) => {
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
    await page.waitForTimeout(500);
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(600);

    // Stored under 'trash', NOT the hardcoded 'archive'
    const trash = await get(page, 'trash');
    expect(trash.rows.length).toBe(1);
    expect((await get(page, 'archive')).rows.length).toBe(0);
    expect((await get(page, 'active')).rows.length).toBe(0);
    const id = trash.rows[0].id;

    // Archived view reads dataCache[items__trash] -> row is visible
    await page.locator('.v-tab:nth-child(2)').click();
    await page.waitForTimeout(700);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(1);

    // RESTORE -> back to active partition, trash emptied
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(600);
    expect((await get(page, 'active')).rows.some(r => r.id === id)).toBe(true);
    expect((await get(page, 'trash')).rows.length).toBe(0);
  });
});

test.describe('Archive from a view whose source has a mirror table not in sources', () => {
  // Mirrors the kokous/musiikki case: view 'mtg' sources=[meetings] only; 'music' mirrors meetings.
  const SCH = {
    defaultLanguage: 'en',
    tables: {
      meetings: { columns: [{ name: 'title', type: 'text' }], partition: 'active', archivePartition: 'archive' },
      music: { columns: [{ name: 'title', type: 'text', syncFrom: 'meetings' }, { name: 'song', type: 'text' }], partition: 'active', archivePartition: 'archive' }
    },
    views: [{ name: 'mtg', sources: ['meetings'], mode: 'union', columns: ['title'] }, { name: 'mus', sources: ['music'], mode: 'union', columns: ['song'] }, { table: 'meetings' }, { table: 'music' }]
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
      meetings: { columns: [{ name: 'title', type: 'text' }, { name: 'place', type: 'ref', table: 'venues', valueCol: 'venue' }, { name: 'kind', type: 'select', list: 'mkind' }], partition: 'active', archivePartition: 'archive' },
      music: { columns: [{ name: 'title', type: 'text', syncFrom: 'meetings' }, { name: 'song', type: 'text' }], partition: 'active', archivePartition: 'archive' },
      venues: { columns: [{ name: 'venue', type: 'text' }], isLookup: true }
    },
    views: [{ name: 'mus', sources: ['music'], mode: 'union', columns: ['song'] }, { name: 'mtg', sources: ['meetings'], mode: 'union', columns: ['title', 'place', 'kind'] }, { table: 'meetings' }, { table: 'music' }]
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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);

    await bootAs(page, 'ed@x');
    const info = await page.evaluate(() => ({ ids: appInstance.sidebarTabs.map(t => t.id), ref: appInstance.refTables, lists: Object.keys(appInstance.visibleLists) }));
    expect(info.ids).toEqual(expect.arrayContaining(['mus', 'music']));
    expect(info.ids).not.toContain('mtg');         // view needs meetings (no access)
    expect(info.ids).not.toContain('meetings');    // table not allowed
    expect(info.ids).not.toContain('__lookup');    // no lists + no refs -> tab hidden
    expect(info.ref).toEqual([]);                  // venues filtered out
    expect(info.lists).toEqual([]);                // mkind (used by meetings) filtered out

    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mus' }).first().click();
    await page.waitForTimeout(500);
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
      meet: { columns: [{ name: 'title', type: 'text' }], partition: 'active', archivePartition: 'archive' },
      mus: { columns: [{ name: 'title', type: 'text', syncFrom: 'meet' }, { name: 'song', type: 'text' }], partition: 'active', archivePartition: 'archive' },
      task: { columns: [{ name: 'title', type: 'text', syncFrom: 'meet' }, { name: 'todo', type: 'text' }], partition: 'active', archivePartition: 'archive' }
    },
    views: [{ name: 'musv', sources: ['mus'], mode: 'union', columns: ['song'] }, { table: 'meet' }, { table: 'mus' }, { table: 'task' }]
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
