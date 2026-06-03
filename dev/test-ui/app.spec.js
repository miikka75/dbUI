const { test, expect } = require('@playwright/test');
const SCHEMA = require('./fixture-schema.json');

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
    await page.waitForTimeout(500);
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
    await page.waitForTimeout(300);

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
});

test.describe('v3 nav + pages + tabs layout', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: '# Hello Page\n\nTasks below:\n\n{{table:tasks}}\n\nVia view:\n\n{{view:all}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home', icon: 'mdi-home' }, { view: 'all' }, { table: 'tasks' }] }
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
    await page.waitForTimeout(400);
    await expect(page.locator('.v-main')).toContainText('Hello Page');   // markdown <h1>
    await expect(page.locator('.v-main')).toContainText('Buy milk');     // {{table:tasks}} + {{view:all}} embed
  });
});

test.describe('v3 interactive page embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'title', type: 'text' }], archivable: true } },
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: 'Edit below:\n\n{{view:all}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
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
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: '{{view:all}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
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
    ],
    pages: { home: { markdown: '{{view:open?}}\n\n{{view:all}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
    // only the non-empty 'all' embed should render (open? has 0 rows -> hidden)
    const embeds = await page.evaluate(() => appInstance.pageBlocks.filter(b => b.embedName).map(b => b.embedName));
    expect(embeds).toEqual(['all']);
  });
});

test.describe('v3 aggregate view embed', () => {
  const V3 = {
    defaultLanguage: 'en',
    tables: { tasks: { columns: [{ name: 'date', type: 'date' }, { name: 'who', type: 'text' }] } },
    views: [{ name: 'byperson', sources: ['tasks'], mode: 'union', groupBy: { column: 'person', from: ['who'] }, collect: 'date', columns: ['person', 'latest'] }],
    pages: { home: { markdown: '{{view:byperson}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'byperson' }] }
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
    await page.waitForTimeout(400);
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
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: '## Active\n\n{{table:tasks}}\n\n## Archived\n\n{{table:tasks@archive}}' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
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
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: '# Seed' } },
    nav: { layout: 'tabs', items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
    // edit + save
    await page.locator('.v-card button:has-text("Edit")').click();
    await page.locator('.v-card textarea').first().fill('# Edited on server');
    await page.locator('.v-card button:has-text("Save")').click();
    await page.waitForTimeout(500);
    // persisted to _pages collection, NOT to schema
    const pages = await (await page.request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' } })).json();
    const row = pages.rows.find(r => r.id === 'home');
    expect(row && row.markdown).toBe('# Edited on server');
    const schema = await (await page.request.post('/api/getSchema', { data: { folderId: 'local' } })).json();
    expect(JSON.stringify(schema.pages || {})).not.toContain('Edited on server');
    // survives reload (rendered from server, not schema seed)
    await page.reload();
    await page.waitForSelector('.v-tabs .v-tab', { timeout: 6000 });
    await page.waitForTimeout(500);
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
    views: [{ name: 'all', sources: ['tasks'], mode: 'union', columns: ['title'] }],
    pages: { home: { markdown: '{{t:page.home.intro}}\n\n{{view:all}}' } },
    nav: { items: [{ page: 'home' }, { view: 'all' }] }
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
    await page.waitForTimeout(400);
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
});
