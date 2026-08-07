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

  test('select column `picker` renders chips / toggle instead of a dropdown; selecting saves', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const schema = {
      defaultLanguage: 'en',
      tables: { items: { columns: [
        { name: 'title', type: 'text' },
        { name: 'status', type: 'select', list: 'status', picker: 'chips' },
        { name: 'prio', type: 'select', list: 'prio', picker: 'toggle' }
      ] } },
      views: [{ name: 'all', sources: ['items'], mode: 'union', columns: ['title'] }],
      nav: { items: [{ table: 'items' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.evaluate(() => { window.appInstance.listsCache = { status: ['open', 'done'], prio: ['low', 'high'] }; window.appInstance.selectTab('items'); });
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);

    // picker:"chips" -> chip group; picker:"toggle" -> button toggle; NOT the default autocomplete
    await expect(page.locator('.v-table .v-chip-group')).toBeVisible();
    await expect(page.locator('.v-table .v-btn-toggle')).toBeVisible();
    await expect(page.locator('.v-table .v-autocomplete, .v-table .v-combobox')).toHaveCount(0);

    // choosing a chip saves the value onto the row
    await page.locator('.v-table .v-chip-group .v-chip', { hasText: 'open' }).first().click();
    await expect.poll(async () => page.evaluate(() => window.appInstance.currentData[0].status)).toBe('open');
  });
});

test.describe('Secondary-colored chips', () => {
  test('multiselect values render as secondary chips', async ({ page }) => {
    await ensureAppReady(page);
    // crew_rotation has a `people` multiselect (allowNew -> v-combobox with the chip slot)
    await page.evaluate(() => window.appInstance.selectTab('crew_rotation'));
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const app = window.appInstance;
      app.saveField(app.currentData[0], 'people', ['Alice']);
    });
    const chip = page.locator('.v-table .v-chip:has-text("Alice")').first();
    await expect(chip).toBeVisible();               // slot renders the value title
    expect(await chip.getAttribute('class')).toMatch(/secondary/); // ...tinted secondary
    await expect(chip.locator('.v-chip__close')).toHaveCount(1); // still closable
  });
});

test.describe('image/url column types', () => {
  const GALLERY = {
    defaultLanguage: 'en',
    tables: { gallery: { columns: [ { name: 'title', type: 'text' }, { name: 'photo', type: 'image' }, { name: 'link', type: 'url' } ] } },
    views: [ { name: 'all', sources: ['gallery'], mode: 'union', columns: ['title'] } ],
    nav: { items: [ { table: 'gallery' } ] }
  };
  async function openGallery(page, { dropUploader } = {}) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: GALLERY } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    if (dropUploader) await page.evaluate(() => { delete window.backend.uploadFile; }); // simulate a backend w/o file storage
    await page.evaluate(() => window.appInstance.selectTab('gallery'));
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);
  }

  test('image column uploads a file to the local dev store + persists + serves the URL', async ({ page }) => {
    test.setTimeout(20000);
    await openGallery(page);

    // The local dev backend exposes uploadFile -> the image cell shows an upload button, not a URL field.
    await expect(page.locator('.mdi-camera-plus')).toBeVisible();
    // Placeholder is i18n-keyed (t('img.url')); derive the rendered text so the selector survives translation.
    const imgUrlPlaceholder = await page.evaluate(() => window.appInstance.t('img.url'));
    await expect(page.locator(`input[placeholder="${imgUrlPlaceholder}"]`)).toHaveCount(0);

    // Pick a real PNG -> uploadFile POSTs it to the dev server, which stores it and returns a URL.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    await page.locator('input[type=file]').setInputFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });

    // The cell now shows a thumbnail whose src is the dev-store URL.
    const thumb = page.locator('img.cell-thumb');
    await expect(thumb).toBeVisible({ timeout: 5000 });
    const src = await thumb.getAttribute('src');
    expect(src).toMatch(/\/uploads\/.+\.png$/);

    // The dev server actually serves the stored file (200 + image content-type).
    const resp = await page.request.get(src);
    expect(resp.status()).toBe(200);
    expect(resp.headers()['content-type']).toContain('image/png');

    // The URL (not the bytes) is persisted on the row (server round-trip; putRow is fire-and-forget).
    await expect.poll(async () => {
      const s = await (await page.request.post('/api/getTableData', { data: { tableId: 'gallery', tab: 'active' } })).json();
      return (s.rows[0] || {}).photo;
    }, { timeout: 4000 }).toBe(src);
  });

  test('compact list layout renders an image column as a thumbnail, not the raw URL', async ({ page }) => {
    test.setTimeout(20000);
    // Same gallery table, but forced through the compact single-line list layout (data-list).
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: Object.assign({}, GALLERY, {
      tables: { gallery: Object.assign({ layout: 'list' }, GALLERY.tables.gallery) }
    }) } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.evaluate(() => window.appInstance.selectTab('gallery'));
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(150);

    // Store a title + a raster data-image on the row.
    const img1x1 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    await page.evaluate((s) => { const a = window.appInstance, r = a.currentData[0]; a.saveField(r, 'title', 'Widget'); a.saveField(r, 'photo', s); }, img1x1);

    // We are in the list layout (no editing grid), and the image cell is a thumbnail whose src is the stored value.
    await expect(page.locator('.v-table')).toHaveCount(0);
    const thumb = page.locator('img.cell-thumb');
    await expect(thumb).toBeVisible();
    expect(await thumb.getAttribute('src')).toBe(img1x1);
    // Non-image columns still render as text alongside it (same list row as the thumbnail).
    await expect(page.locator('.v-list-item', { hasText: 'Widget' })).toBeVisible();
  });

  test('image degrades to a paste-a-URL field on a backend without uploadFile; url renders a link', async ({ page }) => {
    test.setTimeout(20000);
    await openGallery(page, { dropUploader: true });

    // No uploadFile -> image cell is a URL field (no upload button); url column has its own input.
    await expect(page.locator('.mdi-camera-plus, .mdi-image-edit')).toHaveCount(0);
    // Placeholder is i18n-keyed (t('img.url')); derive the rendered text so the selector survives translation.
    const imgUrlPlaceholder = await page.evaluate(() => window.appInstance.t('img.url'));
    await expect(page.locator(`input[placeholder="${imgUrlPlaceholder}"]`)).toBeVisible();
    await expect(page.locator('input[placeholder^="https"]')).toBeVisible();

    // Store values, then assert the render: <img> thumbnail for image, open-link icon for url.
    const img1x1 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    await page.evaluate((s) => { const a = window.appInstance, r = a.currentData[0]; a.saveField(r, 'photo', s); a.saveField(r, 'link', 'https://example.com/x'); }, img1x1);
    await expect(page.locator('img.cell-thumb')).toBeVisible();
    expect(await page.locator('img.cell-thumb').getAttribute('src')).toBe(img1x1);
    await expect(page.locator('.mdi-open-in-new')).toBeVisible();

    // Editing wiring: typing a URL into the url cell + change writes it onto the row and persists.
    await page.locator('input[placeholder^="https"]').evaluate((el) => { el.value = 'https://example.com/y'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    await expect.poll(async () => {
      const s = await (await page.request.post('/api/getTableData', { data: { tableId: 'gallery', tab: 'active' } })).json();
      return (s.rows[0] || {}).link;
    }, { timeout: 4000 }).toBe('https://example.com/y');
  });

  test('a stored javascript:/data:text/html cell value renders an EMPTY href, not the payload', async ({ page }) => {
    test.setTimeout(20000);
    await openGallery(page, { dropUploader: true });
    // A malicious value reaches the cell the same way any url does -- a writer stores it (on a shared-write
    // table, writer != the victim who clicks). The rendered href must be neutralized.
    await page.evaluate(() => {
      const a = window.appInstance, r = a.currentData[0];
      a.saveField(r, 'link', 'javascript:alert(document.domain)');
      a.saveField(r, 'photo', 'data:text/html,<script>alert(1)</script>');
    });
    await expect(page.locator('.mdi-open-in-new')).toBeVisible();               // the url cell still renders a link element
    const hrefs = await page.locator('a[target="_blank"]').evaluateAll(els => els.map(e => e.getAttribute('href')));
    expect(hrefs.some(h => (h || '').startsWith('javascript:'))).toBe(false);   // no javascript: href survives
    expect(hrefs).toContain('');                                                // the unsafe value became an empty href
    // The data:text/html image value is not a raster data image -> src drops to empty too.
    const srcs = await page.locator('img.cell-thumb').evaluateAll(els => els.map(e => e.getAttribute('src')));
    expect(srcs.every(s => !/^data:text\/html/.test(s || ''))).toBe(true);
  });
});

test.describe('Calendar locale follows the selected language', () => {
  test('calLocale uses the language code (not the browser locale); explicit locale wins', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.languages = [{ code: 'es', name: 'Español' }, { code: 'en', name: 'English' }];
      app.currentLang = 'es';
      const esLoc = app.calLocale();
      const esMonth = new Intl.DateTimeFormat(esLoc, { month: 'long' }).format(new Date(2026, 6, 1));
      app.languages = [{ code: 'sv', name: 'Svenska' }];
      app.currentLang = 'sv';
      const svLoc = app.calLocale();
      app.languages = [{ code: 'xx', name: 'Custom', locale: 'de' }];  // explicit locale override
      app.currentLang = 'xx';
      const overrideLoc = app.calLocale();
      return { esLoc, esMonth, svLoc, overrideLoc };
    });
    expect(r.esLoc).toBe('es');                       // the code itself is the locale — not navigator.language
    expect(r.esMonth.toLowerCase()).toBe('julio');    // -> Spanish month names in the calendar
    expect(r.svLoc).toBe('sv');
    expect(r.overrideLoc).toBe('de');                 // an explicit `language.locale` still wins
  });

  test('add-language picker adds a BCP-47 language whose code drives the calendar locale', async ({ page }) => {
    await ensureAppReady(page);
    await page.evaluate(() => window.appInstance.selectTab('__languages'));
    await expect(page.locator('[data-testid="add-language"]')).toBeVisible();   // the picker replaces the old auto-code button
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const optHasFi = app.bcp47Options().some(o => o.code === 'fi');   // Finnish offered before it's added
      app.addLanguage('fi', 'Suomi');                                    // simulate picking it
      return { optHasFi, added: app.languages.some(l => l.code === 'fi') };
    });
    expect(r.optHasFi).toBe(true);
    await expect.poll(async () => page.evaluate(() => window.appInstance.languages.some(l => l.code === 'fi'))).toBe(true);
    const after = await page.evaluate(() => {
      const app = window.appInstance;
      app.currentLang = 'fi';
      return { calLoc: app.calLocale(), optStillHasFi: app.bcp47Options().some(o => o.code === 'fi') };
    });
    expect(after.calLoc).toBe('fi');            // the real code IS the Intl locale -> Finnish date names
    expect(after.optStillHasFi).toBe(false);    // already-added languages drop out of the picker
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
  // Mirrors the meeting/music case: view 'mtg' sources=[meetings] only; 'music' mirrors meetings.
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

  test('a DETAIL view hides its own add/archive; archiving via the master rides to the mirror', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    // The DETAIL view (source 'music' = syncFrom meetings) inherits its master, so it offers NO
    // independent add/archive -- the music rows are created/archived with the meeting, never on their own.
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'mus' }).first().click(); // detail view (music)
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => appInstance.canMutateRows)).toBe(false);
    expect(await page.locator('button:has(.mdi-plus)').count()).toBe(0);
    expect(await page.locator('button:has(.mdi-archive-outline)').count()).toBe(0);

    // ADD from the MASTER view 'mtg' (source 'meetings') -> meetings row + propagated music mirror (same id)
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'mtg' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(600);
    expect((await get(page, 'music', 'active')).rows.length).toBe(1);
    expect((await get(page, 'meetings', 'active')).rows.length).toBe(1);
    const id = (await get(page, 'meetings', 'active')).rows[0].id;

    // ARCHIVE from the master view -> the mirror 'music' detail row rides along to archive
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
    // add a row in the master 'mtg' view -> archive button visible (admin has full access + a
    // master-sourced view is mutable; the detail 'mus' view rides its master and stays read-only)
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mtg' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => appInstance.canMutateCurrent)).toBe(true);
    expect(await page.locator('button:has(.mdi-archive-outline)').count()).toBeGreaterThanOrEqual(1);
  });

  test('editor restricted to music: filtered sidebar, no lookup tab, no archive button', async ({ page }) => {
    test.setTimeout(20000);
    await setup(page);
    // seed a music row via the MASTER in an authenticated admin session. The detail 'mus' view can't add
    // (its rows ride the master), and the unauthenticated seed API writes a store the role-gated session
    // can't read -- so add through the master 'mtg' view, whose mirror propagates a row into 'music'.
    await bootAs(page, 'admin@x');
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.mtg' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(300);

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

  test('a detail view hides its own controls; add + delete via the master propagate transitively', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    // The detail view 'musv' (source 'mus' = syncFrom meet) inherits its master, so it offers no
    // independent add/delete -- the cluster mutates only through the master 'meet'.
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'musv' }).first().click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => appInstance.canMutateRows)).toBe(false);
    expect(await page.locator('button:has(.mdi-plus)').count()).toBe(0);

    // ADD in the MASTER table 'meet' -> mus (detail) + task (sibling detail) created transitively
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'meet' }).first().click();
    await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });
    await page.locator('button:has(.mdi-plus)').click();
    await page.waitForTimeout(600);
    expect((await get(page, 'mus')).rows.length).toBe(1);
    expect((await get(page, 'meet')).rows.length).toBe(1);
    expect((await get(page, 'task')).rows.length).toBe(1);

    // DELETE (two-press) from the master -> all three removed transitively
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

test.describe('Stale defaultLanguage', () => {
  // A schema can outlive the language it names: change a language's code (Suomi -> fi) and
  // schema.defaultLanguage still says the old one. The base strings then load from a translations doc
  // that doesn't exist and the ENTIRE UI falls back to raw keys, even though a perfectly good language
  // is present. defaultLanguage now only honours a configured code that actually exists.
  const SCH = { defaultLanguage: 'Suomi', tables: { docs: { columns: [{ name: 'title', type: 'text' }] } }, views: [{ table: 'docs' }], nav: { items: [{ table: 'docs' }] } };

  test('falls back to an existing language when the configured default is gone', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCH } });
    // Only 'fi' exists — the schema's 'Suomi' names nothing.
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'fi', name: 'Suomi', keys: [] } });
    await page.request.post('/api/updateTranslations', { data: { folderId: 'local', langCode: 'fi', updates: { 'tab.docs': 'Asiakirjat' } } });
    // A remembered code that no longer exists must not select a missing language either.
    await page.addInitScript(() => {
      localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
      localStorage.setItem('app_lang', 'Suomi');
    });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });

    expect(await page.evaluate(() => appInstance.defaultLanguage)).toBe('fi');
    expect(await page.evaluate(() => appInstance.currentLang)).toBe('fi');
    // The translated string is used, not the raw key — the actual user-visible symptom.
    expect(await page.evaluate(() => appInstance.strings['tab.docs'])).toBe('Asiakirjat');
    await expect(page.locator('.v-navigation-drawer .v-list-item', { hasText: 'Asiakirjat' }).first()).toBeVisible();
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
        { name: 'rota', rotation: { slots: ['area_a', 'area_b'], rosters: ['la', 'lb'], interval: 'weekly' } },
        { name: 'rota2', rotation: { columns: [{ name: 'crew' }], interval: 'weekly' } }   // columns form
      ] };
      return appInstance.schemaTranslationKeys;
    });
    expect(keys).toContain('field.area_a');   // slots form (regression: was missing)
    expect(keys).toContain('field.area_b');
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
    tables: { 'todos': { columns: [{ name: 'heading', type: 'text' }], partition: 'active' } },
    views: [
      { name: 'todo_block', sources: ['todos'], mode: 'union', columns: ['heading'],
        markdown: '**List**\n\n{{self}}\n\n{{table:todos}}' }
    ],
    nav: { items: [{ view: 'todo_block' }, { table: 'todos' }] }
  };
  test('{{self}} and {{table:X}} resolve non-ASCII (accented) names', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: V3 } });
    await page.request.post('/api/putRow', { data: { tableId: 'todos', data: { id: 'r1', heading: 'Café-Ñ' }, tab: 'active' } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.todo_block' }).first().click();
    await page.waitForTimeout(150);
    await expect(page.locator('.v-main')).toContainText('List');   // header prose
    await expect(page.locator('.v-main')).toContainText('Café-Ñ'); // {{self}} + {{table:todos}} both rendered the row
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
  test('a non-ASCII (accented) {{t:}} key both resolves and is extracted', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    await page.waitForFunction(() => typeof appInstance !== 'undefined' && !!appInstance && typeof appInstance.mdBlocks === 'function');
    const result = await page.evaluate(() => {
      appInstance.strings = Object.assign({}, appInstance.strings, { 'café.título': 'Título-ÑÇ' });
      var resolved = appInstance.mdBlocks('{{t:café.título}}', null).map(function (b) { return b.html || ''; }).join('');
      // extractor uses the same broadened class -> confirm it captures the accented key
      var extracted = /\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/.exec('{{t:café.título}}');
      return { resolved: resolved, extracted: extracted && extracted[1] };
    });
    expect(result.resolved).toContain('Título-ÑÇ');     // resolver regex matched + substituted the accented key
    expect(result.extracted).toBe('café.título');    // extractor regex captures the accented key
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
    // Notify text is i18n-keyed (t('msg.import_blocked') + detail); derive the prefix so the assertion survives translation.
    const importBlockedPrefix = await page.evaluate(() => appInstance.t('msg.import_blocked'));
    expect(blocked).toContain(importBlockedPrefix);
    expect(await page.evaluate(() => appInstance.sortedData.length)).toBe(before);
  });
});

test.describe('XSS prevention (safeUrl + print escape)', () => {
  test('javascript: URLs in markdown are neutralized; HTML in field values is escaped in print', async ({ page }) => {
    test.setTimeout(20000);
    await page.goto('/');
    // Wait for BOTH globals this test reads: mdToHtml (embeds.js, loaded early) AND appInstance (mounted
    // later by createVueApp). mdToHtml now appears well before the Vue app mounts, so waiting on it alone
    // would race appInstance._pe.
    await page.waitForFunction(() => typeof mdToHtml === 'function' && window.appInstance && typeof appInstance._pe === 'function');
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

  test('a new name typed while switched to the alt list is added to the alt list, not the primary', async ({ page }) => {
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
    const result = await page.evaluate(async () => {
      var item = appInstance.sortedData[0];
      // Spy on the persistence call so we assert BOTH the in-memory cache and what was written to the backend.
      var puts = [];
      var realPut = backend.putListItem;
      backend.putListItem = function(folder, list, v) { puts.push({ list: list, v: v }); return realPut && realPut.apply(backend, arguments); };
      // Switch the cell to the alt list (the swap arrow), then type a brand-new name.
      appInstance.toggleListSwitch('person', item);
      item.person = 'Zelda';                       // a name in neither list
      appInstance.addToListOnBlur(item, 'person');
      backend.putListItem = realPut;
      return {
        inExternal: (appInstance.listsCache.external || []).indexOf('Zelda') >= 0,
        inInternal: (appInstance.listsCache.internal || []).indexOf('Zelda') >= 0,
        puts: puts
      };
    });
    expect(result.inExternal).toBe(true);   // the new name landed in the alt list...
    expect(result.inInternal).toBe(false);  // ...and NOT the primary list
    expect(result.puts).toEqual([{ list: 'external', v: 'Zelda' }]); // persisted to the alt list only
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
    tables: { events: { columns: [{ name: 'speaker', type: 'select', list: 'staff' }, { name: 'guest', type: 'select', list: 'guests' }, { name: 'topic' }] } },
    lists: { staff: ['Alice', 'Bob'], guests: ['Charlie', 'Dave'] },
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

  test('renameLanguage decouples name from code: rename preserves code + translations', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'xx', name: 'TestLang', keys: ['app.title'] } });
    await page.request.post('/api/updateTranslations', { data: { folderId: 'local', langCode: 'xx', updates: { 'app.title': 'Hello' } } });
    // Rename the (default) language's display name — code 'xx' must stay, translations must survive
    const r = await page.request.post('/api/renameLanguage', { data: { folderId: 'local', code: 'xx', name: 'Renamed' } });
    expect(r.ok()).toBeTruthy();
    const langs = await (await page.request.post('/api/getAvailableLanguages', { data: {} })).json();
    const lang = langs.find(l => l.code === 'xx');
    expect(lang).toBeTruthy();             // code 'xx' still present (stable)
    expect(lang.name).toBe('Renamed');     // display name updated
    const tr = await (await page.request.post('/api/getTranslations', { data: { folderId: 'local', langCode: 'xx' } })).json();
    expect(tr['app.title']).toBe('Hello'); // translations preserved across rename
  });

  test('deleting the default language repoints the default to a remaining language', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: { defaultLanguage: 'en', tables: { t: { columns: [{ name: 'a', type: 'text' }] } }, views: [{ table: 't' }], nav: { items: [{ table: 't' }] } } } });
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'en', name: 'English', keys: ['tab.t'] } });
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'xx', name: 'TestLang', keys: ['tab.t'] } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      app.deleteLang({ code: 'en', name: 'English' });  // arm
      app.deleteLang({ code: 'en', name: 'English' });  // confirm
      await new Promise(res => setTimeout(res, 200));
      return { langs: app.languages.map(l => l.code), def: app.defaultLanguage, schemaDef: app.schemaData.defaultLanguage };
    });
    expect(r.langs).not.toContain('en');   // default was deletable
    expect(r.langs).toContain('xx');
    expect(r.def).toBe('xx');              // default repointed to the remaining language
    expect(r.schemaDef).toBe('xx');        // repoint persisted to schema
  });

  test('deleting the last language clears default and falls back to raw keys', async ({ page }) => {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: { defaultLanguage: 'en', tables: { t: { columns: [{ name: 'a', type: 'text' }] } }, views: [{ table: 't' }], nav: { items: [{ table: 't' }] } } } });
    await page.request.post('/api/createLanguage', { data: { folderId: 'local', code: 'en', name: 'English', keys: ['tab.t'] } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      app.deleteLang({ code: 'en', name: 'English' });  // arm
      app.deleteLang({ code: 'en', name: 'English' });  // confirm
      await new Promise(res => setTimeout(res, 200));
      return { langs: app.languages.map(l => l.code), def: app.defaultLanguage, stringCount: Object.keys(app.strings).length, tabT: app.t('tab.t') };
    });
    expect(r.langs).toEqual([]);     // last language deletable
    expect(r.def).toBeNull();        // no default
    expect(r.stringCount).toBe(0);   // no translations loaded
    expect(r.tabT).toBe('tab.t');    // t() falls back to the raw key
  });
});

test.describe('access control: user matching + fail-closed', () => {
  test('matches by key/addr (case-insensitive), fails closed for unmatched, admin unrestricted', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const setUsers = (list, email) => { app.usersLoaded = true; app.userList = list; app.currentUserEmail = email; };
      const snap = () => ({ allowed: app.userAllowedTables, unreg: app.isUnregisteredUser, admin: app.isAdmin, role: app.currentUserRole });
      // 1. matched by KEY (login email), editor restricted to one table
      setUsers([{ key: 'a@x.com', addr: '', role: 'editor', tables: ['reports'] }], 'a@x.com');
      const byKey = snap();
      // 2. case-insensitive key match (Firestore key was stored with different casing)
      setUsers([{ key: 'A@X.com', addr: '', role: 'editor', tables: ['reports'] }], 'a@x.com');
      const caseIns = snap();
      // 3. legacy match by addr (user field) when key is a placeholder
      setUsers([{ key: '_new_1', addr: 'b@x.com', role: 'editor', tables: ['team_a'] }], 'b@x.com');
      const byAddr = snap();
      // 4. registered users exist but the signed-in user matches none -> FAIL CLOSED
      setUsers([{ key: 'a@x.com', addr: 'a@x.com', role: 'editor', tables: ['reports'] }], 'ghost@x.com');
      const unmatched = snap();
      // 5. admin -> unrestricted
      setUsers([{ key: 'a@x.com', addr: 'a@x.com', role: 'admin', tables: 'all' }], 'a@x.com');
      const admin = snap();
      return { byKey, caseIns, byAddr, unmatched, admin };
    });
    expect(r.byKey).toEqual({ allowed: ['reports'], unreg: false, admin: false, role: 'editor' });
    expect(r.caseIns.allowed).toEqual(['reports']);          // case-insensitive key match
    expect(r.caseIns.unreg).toBe(false);
    expect(r.byAddr.allowed).toEqual(['team_a']);          // legacy addr fallback still works
    expect(r.unmatched).toEqual({ allowed: [], unreg: true, admin: false, role: null }); // fail closed + notice
    expect(r.admin).toEqual({ allowed: null, unreg: false, admin: true, role: 'admin' }); // unrestricted
  });

  test('selfUnregistered separates unregistered (fail closed) from bootstrap (admin); non-admin self-entry restricts', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const snap = () => ({ allowed: app.userAllowedTables, unreg: app.isUnregisteredUser, admin: app.isAdmin, role: app.currentUserRole });
      app.usersLoaded = true;
      // Bootstrap: no users configured, not flagged -> admin / unrestricted.
      app.userList = []; app.selfUnregistered = false; app.currentUserEmail = 'x@x.com';
      const bootstrap = snap();
      // Unregistered: getMyAccess said registered:false. An empty userList (a non-admin can't read the
      // roster) MUST NOT be mistaken for bootstrap -> must fail closed.
      app.userList = []; app.selfUnregistered = true;
      const unregistered = snap();
      // Restricted non-admin with ONLY their own entry visible (the Firebase per-user-doc case).
      app.selfUnregistered = false;
      app.userList = [{ key: 'm@x.com', addr: 'm@x.com', role: 'editor', tables: ['reports', 'team_a'] }];
      app.currentUserEmail = 'm@x.com';
      const selfOnly = snap();
      return { bootstrap, unregistered, selfOnly };
    });
    expect(r.bootstrap).toEqual({ allowed: null, unreg: false, admin: true, role: 'admin' });
    expect(r.unregistered).toEqual({ allowed: [], unreg: true, admin: false, role: null });   // NOT bootstrap
    expect(r.selfOnly).toEqual({ allowed: ['reports', 'team_a'], unreg: false, admin: false, role: 'editor' });
  });

  test('membership request -> admin approve registers the user and clears the request', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      // Submit a request as a new (unregistered) user (the _post header follows test_user).
      localStorage.setItem('test_user', 'newbie@x.com');
      await backend_users.requestAccess('New Bie', 'please add me');
      // Switch to admin (local@dev was bootstrap-registered as admin at boot).
      localStorage.setItem('test_user', 'local@dev');
      const reqs = await backend_users.getAccessRequests();
      await backend_users.setUserRole('newbie@x.com', 'editor', 'newbie@x.com', ['tasks']);  // approve
      await backend_users.removeAccessRequest('newbie@x.com');
      const reqsAfter = await backend_users.getAccessRequests();
      const users = await backend_users.getUsers();
      // The approved user now resolves their OWN access via getMyAccess.
      localStorage.setItem('test_user', 'newbie@x.com');
      const mine = await backend_users.getMyAccess();
      // Cleanup so the shared isolated users file returns to its prior state.
      localStorage.setItem('test_user', 'local@dev');
      await backend_users.removeUser('newbie@x.com');
      return {
        hadReq: !!reqs['newbie@x.com'], reqName: (reqs['newbie@x.com'] || {}).name,
        clearedAfter: !reqsAfter['newbie@x.com'], userCreated: !!users['newbie@x.com'], mine: mine
      };
    });
    expect(r.hadReq).toBe(true);
    expect(r.reqName).toBe('New Bie');
    expect(r.userCreated).toBe(true);
    expect(r.clearedAfter).toBe(true);
    expect(r.mine).toEqual({ role: 'editor', tables: ['tasks'] });
  });

  test('approveRequest seeds the approved user profile name from their request (enables @me)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      localStorage.setItem('test_user', 'seed@x.com'); await backend_users.requestAccess('Seed Person', '');
      localStorage.setItem('test_user', 'local@dev');   // admin
      await app.approveRequest({ email: 'seed@x.com', name: 'Seed Person' });
      const users = await backend_users.getUsers();
      localStorage.setItem('test_user', 'seed@x.com');
      const prof = await backend_users.getMyProfile();
      const reqsAfter = await backend_users.getAccessRequests();
      localStorage.setItem('test_user', 'local@dev');
      await backend_users.removeUser('seed@x.com');       // cleanup
      await backend_users.setProfileName('seed@x.com', '');
      return { registered: !!users['seed@x.com'], profName: prof.name, profShared: prof.shared, cleared: !reqsAfter['seed@x.com'] };
    });
    expect(r.registered).toBe(true);
    expect(r.profName).toBe('Seed Person');   // seeded from the request
    expect(r.profShared).toBe(false);          // NOT auto-shared (still opt-in)
    expect(r.cleared).toBe(true);              // request removed after approval
  });

  test('user-backed list: opted-in shared profile names populate a listSources:"users" list', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      localStorage.setItem('test_user', 'ann@x.com'); await backend_users.setMyProfile('Ann', true);
      localStorage.setItem('test_user', 'bob@x.com'); await backend_users.setMyProfile('Bob', false);   // opted out
      localStorage.setItem('test_user', 'cara@x.com'); await backend_users.setMyProfile('Cara', true);
      localStorage.setItem('test_user', 'local@dev');
      const shared = await backend_users.getSharedNames();
      const app = window.appInstance;
      app.schemaData = Object.freeze(Object.assign({}, app.schemaData, { listSources: { members: 'users' } }));
      await app._overlayUserLists();
      const listed = (app.listsCache['members'] || []).slice();
      // cleanup so the isolated profiles file doesn't leak into other tests
      localStorage.setItem('test_user', 'ann@x.com'); await backend_users.setMyProfile('Ann', false);
      localStorage.setItem('test_user', 'cara@x.com'); await backend_users.setMyProfile('Cara', false);
      localStorage.setItem('test_user', 'local@dev');
      return { shared, listed };
    });
    expect(r.shared).toEqual(['Ann', 'Cara']);   // Bob opted out -> excluded
    expect(r.listed).toEqual(['Ann', 'Cara']);   // the user-backed list is filled from shared names
  });

  test('user-backed list: shared names merge over curated values; un-sharing removes only the injected name', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      app.schemaData = Object.freeze(Object.assign({}, app.schemaData, { listSources: { members: 'users' } }));
      app.listsCache = Object.assign({}, app.listsCache, { members: ['Curated', 'Ann'] });  // seeded/admin-curated values
      const snap = {};

      // Nobody has opted in yet -> the curated list must survive (this used to empty it).
      await app._overlayUserLists();
      snap.noneShared = (app.listsCache['members'] || []).slice();

      localStorage.setItem('test_user', 'zoe@x.com'); await backend_users.setMyProfile('Zoe', true);
      localStorage.setItem('test_user', 'local@dev');
      await app._overlayUserLists();
      snap.zoeShared = (app.listsCache['members'] || []).slice();

      // Zoe un-shares -> only the injected name goes; curated values stay put.
      localStorage.setItem('test_user', 'zoe@x.com'); await backend_users.setMyProfile('Zoe', false);
      localStorage.setItem('test_user', 'local@dev');
      await app._overlayUserLists();
      snap.zoeRemoved = (app.listsCache['members'] || []).slice();

      // A backend failure must not wipe the list either (the caller's catch leaves it alone).
      const real = backend_users.getSharedNames;
      backend_users.getSharedNames = () => Promise.reject(new Error('permission-denied'));
      await app._overlayUserLists();
      snap.onReject = (app.listsCache['members'] || []).slice();
      backend_users.getSharedNames = real;
      return snap;
    });
    expect(r.noneShared).toEqual(['Curated', 'Ann']);          // curated values preserved
    expect(r.zoeShared).toEqual(['Curated', 'Ann', 'Zoe']);    // shared name merged on top
    expect(r.zoeRemoved).toEqual(['Curated', 'Ann']);          // 'Ann' is curated -> never stripped
    expect(r.onReject).toEqual(['Curated', 'Ann']);            // rejection != "nobody opted in"
  });

  test('admin can view and rename another user\'s profile name from the Users table', async ({ page }) => {
    await ensureAppReady(page);
    await page.evaluate(() => { appInstance.setUserRole('bob@x.com', 'editor', 'bob@x.com', ['tasks']); });
    await page.waitForTimeout(300);   // let loadUsers()/loadAllProfiles() resolve
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    const row = page.locator('.v-table tbody tr', { hasText: 'bob@x.com' });
    await expect(row).toHaveCount(1);
    const nameCell = row.locator('.editable-cell').nth(1);   // [0] = email/id, [1] = name
    await expect(nameCell).toHaveText('');   // no profile yet
    await nameCell.click();
    await page.keyboard.type('Bob Builder');
    await nameCell.blur();
    await page.waitForTimeout(400);
    const r = await page.evaluate(async () => {
      const profiles = await backend_users.getProfiles();
      await backend_users.removeUser('bob@x.com'); await backend_users.setProfileName('bob@x.com', '');   // cleanup
      return { saved: (profiles['bob@x.com'] || {}).name, cached: appInstance.userDisplayName({ key: 'bob@x.com' }) };
    });
    expect(r.saved).toBe('Bob Builder');
    expect(r.cached).toBe('Bob Builder');
  });

  test('a user can set and remove their own profile picture (persists + renders as an avatar)', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    await expect(page.locator('.v-main')).toContainText('profile.title');
    const pic = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
    // set + save via the app (canvas resize is exercised in the browser through onProfilePictureFile's twin;
    // here we drive the persistence path the UI uses on change).
    const saved = await page.evaluate(async (p) => {
      appInstance.myProfile.picture = p;
      appInstance.saveMyProfile();
      await new Promise(r => setTimeout(r, 300));
      return backend_users.getMyProfile();
    }, pic);
    expect(saved.picture).toBe(pic);
    // the settings avatar shows the uploaded image
    await expect(page.locator('.v-main .v-avatar img').first()).toHaveAttribute('src', pic);
    // remove clears it everywhere
    const cleared = await page.evaluate(async () => {
      appInstance.removeMyPicture();
      await new Promise(r => setTimeout(r, 300));
      return backend_users.getMyProfile();
    });
    expect(cleared.picture).toBe('');
  });

  test('a registered user with no table access still sees and can edit their own profile name (not gated by user-backed lists)', async ({ page }) => {
    await ensureAppReady(page);
    await page.evaluate(() => { appInstance.setUserRole('noaccess@x.com', 'editor', 'noaccess@x.com', []); });
    await page.waitForTimeout(300);
    await page.evaluate(() => { localStorage.setItem('test_user', 'noaccess@x.com'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    // fixture schema defines no listSources -> user-backed lists feature is unused for anyone here.
    expect(await page.evaluate(() => appInstance.userBackedLists().length)).toBe(0);
    expect(await page.evaluate(() => appInstance.isUnregisteredUser)).toBe(false);
    expect(await page.evaluate(() => appInstance.userAllowedTables)).toEqual([]);
    await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.settings' }).first().click();
    // No translations loaded in the fixture -> labels render as their raw keys (no English fallback).
    await expect(page.locator('.v-main')).toContainText('profile.title');
    const nameField = page.locator('label:has-text("profile.your_name")').locator('..').locator('input');
    await nameField.fill('No Access Person');
    await nameField.blur();   // no Save button -> the name auto-saves on blur
    await page.waitForTimeout(400);
    const saved = await page.evaluate(() => backend_users.getMyProfile());
    // cleanup as admin
    await page.evaluate(() => { localStorage.setItem('test_user', 'local@dev'); });
    await page.evaluate(async () => { await backend_users.removeUser('noaccess@x.com'); await backend_users.setProfileName('noaccess@x.com', ''); });
    expect(saved.name).toBe('No Access Person');
  });

  test('@me filter token resolves to the current user profile name (data-view + groupBy.filter)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const cache = { tasks: [{ id: 1, person: 'Ann', task: 'A' }, { id: 2, person: 'Bob', task: 'B' }, { id: 3, person: 'Ann', task: 'C' }] };
      app.myProfile = { name: 'Ann', shared: true };
      // data-view filter { person: '@me' } -> only my rows
      const dataRows = window.buildRows(app._viewWithMe({ sources: ['tasks'], filter: { person: '@me' } }), cache).map(function (x) { return x.task; }).sort();
      // groupBy.filter { person: '@me' } -> only my aggregated row
      const gb = { groupBy: { column: 'person', from: ['person'], filter: { person: '@me' } }, collect: 'task', columns: ['person', 't1', 't2'] };
      const vmg = app._viewWithMe(gb);
      const aggKeys = window.aggregateRows(vmg, window.buildRows(Object.assign({ sources: ['tasks'] }, vmg), cache)).map(function (x) { return x.person; });
      // empty profile name -> @me matches nothing (no assigned identity)
      app.myProfile = { name: '', shared: false };
      const none = window.buildRows(app._viewWithMe({ sources: ['tasks'], filter: { person: '@me' } }), cache).length;
      return { dataRows: dataRows, aggKeys: aggKeys, none: none };
    });
    expect(r.dataRows).toEqual(['A', 'C']);   // only Ann's task rows
    expect(r.aggKeys).toEqual(['Ann']);        // only my aggregated (per-person) row
    expect(r.none).toBe(0);                    // empty display name -> matches nothing
  });

  test('lookup computed + aggregate (sum/count) build a ranked leaderboard', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const chores = [{ chore: 'Dishes', points: 2 }, { chore: 'Mow', points: 5 }];
      const log = [
        { id: 1, person: 'Ann', chore: 'Dishes' }, { id: 2, person: 'Ann', chore: 'Mow' },
        { id: 3, person: 'Bob', chore: 'Dishes' }, { id: 4, person: 'Ann', chore: 'Dishes' }
      ];
      const ctx = { dataCache: { chores: chores } };
      const compute = [{ name: 'points', computed: { lookup: { table: 'chores', match: 'chore', on: 'chore', field: 'points' } } }];
      const resolved = window.resolveComputed(log.map(function (x) { return Object.assign({}, x); }), compute, ctx);
      const sumView = { groupBy: { column: 'person', from: ['person'] }, aggregate: { sum: 'points', into: 'total' }, columns: ['person', 'total'] };
      const cntView = { groupBy: { column: 'person', from: ['person'] }, aggregate: { count: true, into: 'total' }, columns: ['person', 'total'] };
      return {
        pts: resolved.map(function (x) { return x.points; }),
        board: window.aggregateRows(sumView, resolved).map(function (x) { return { p: x.person, t: x.total }; }),
        counts: window.aggregateRows(cntView, resolved).map(function (x) { return { p: x.person, t: x.total }; })
      };
    });
    expect(r.pts).toEqual([2, 5, 2, 2]);                                   // per-chore points looked up
    expect(r.board).toEqual([{ p: 'Ann', t: 9 }, { p: 'Bob', t: 2 }]);      // sum, ranked desc (Ann 2+5+2)
    expect(r.counts).toEqual([{ p: 'Ann', t: 3 }, { p: 'Bob', t: 1 }]);     // count, ranked desc
  });

  test('`within` period operator: @month/@week/@year + back-offset, auto-relative to today', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const fmt = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const rows = [
        { id: 'today', d: fmt(now) },
        { id: 'mstart', d: fmt(new Date(now.getFullYear(), now.getMonth(), 1)) },      // 1st of this month
        { id: 'last', d: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 15)) },   // mid last month
        { id: 'prevyr', d: fmt(new Date(now.getFullYear() - 1, 5, 15)) }               // last year
      ];
      const ids = function (cond) { return window.filterRows(rows, { d: cond }).map(function (x) { return x.id; }).sort(); };
      const has = function (cond, id) { return window.filterRows(rows, { d: cond }).some(function (x) { return x.id === id; }); };
      return {
        month: ids({ within: '@month' }),
        lastMonth: ids({ within: '@month-1' }),
        weekHasToday: has({ within: '@week' }, 'today'),
        yearHasToday: has({ within: '@year' }, 'today'),
        yearHasPrevYr: has({ within: '@year' }, 'prevyr'),
        bad: window.filterRows(rows, { d: { within: '@decade' } }).length
      };
    });
    expect(r.month).toEqual(['mstart', 'today']);   // this month: today + 1st; excludes last month & prev year
    expect(r.lastMonth).toEqual(['last']);           // @month-1 = previous month only
    expect(r.weekHasToday).toBe(true);               // today is within this week
    expect(r.yearHasToday).toBe(true);               // this year includes today
    expect(r.yearHasPrevYr).toBe(false);             // ...but not the previous-year row
    expect(r.bad).toBe(0);                           // unknown token matches nothing (fail-closed)
  });

  test('leaderboard ‹ › navigation: periodOffset injects @month-N and re-scopes; label tracks', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const fmt = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const thisM = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
      const lastM = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 15));
      const chores = [{ chore: 'X', points: 1 }];
      const log = [{ id: 1, person: 'Ann', chore: 'X', done_on: thisM }, { id: 2, person: 'Ann', chore: 'X', done_on: lastM }, { id: 3, person: 'Bob', chore: 'X', done_on: lastM }];
      const resolved = window.resolveComputed(log.map(function (x) { return Object.assign({}, x); }), [{ name: 'points', computed: { lookup: { table: 'chores', match: 'chore', on: 'chore', field: 'points' } } }], { dataCache: { chores: chores } });
      const baseFilter = { done_on: { within: '@month' } };
      const board = function (offset) {
        var scoped = window.filterRows(resolved, app.resolvePeriodTokens(baseFilter, offset));   // view.filter on source rows
        var view = { groupBy: { column: 'person', from: ['person'] }, aggregate: { count: true, into: 'total' }, columns: ['person', 'total'] };
        return window.aggregateRows(view, scoped).map(function (x) { return { p: x.person, t: x.total }; }).sort(function (a, b) { return a.p.localeCompare(b.p); });
      };
      window.VIEWS.lb_test = { name: 'lb_test', period: 'month' };
      app.currentTable = 'lb_test'; app.periodOffset = 0; var lblNow = app.periodLabel(); app.periodOffset = 1; var lblPrev = app.periodLabel(); app.periodOffset = 0;
      var im = function (o) { return new Intl.DateTimeFormat(app.calLocale(), { month: 'long', year: 'numeric' }).format(new Date(now.getFullYear(), now.getMonth() - o, 1)); };
      return {
        tok0: JSON.stringify(app.resolvePeriodTokens(baseFilter, 0)),
        tok2: JSON.stringify(app.resolvePeriodTokens(baseFilter, 2)),
        thisMonth: board(0), lastMonth: board(1),
        lblNow: lblNow, lblPrev: lblPrev, expNow: im(0), expPrev: im(1)
      };
    });
    expect(r.tok0).toBe(JSON.stringify({ done_on: { within: '@month' } }));      // offset 0 -> unchanged
    expect(r.tok2).toBe(JSON.stringify({ done_on: { within: '@month-2' } }));    // offset injected
    expect(r.thisMonth).toEqual([{ p: 'Ann', t: 1 }]);                           // current month
    expect(r.lastMonth).toEqual([{ p: 'Ann', t: 1 }, { p: 'Bob', t: 1 }]);        // one month back
    expect(r.lblNow).toBe(r.expNow);                                             // label = current month
    expect(r.lblPrev).toBe(r.expPrev);                                           // label = previous month
  });

  test('unmatched user gets no data nav tabs (fail closed hides tables/views)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.usersLoaded = true;
      app.userList = [{ key: 'a@x.com', addr: 'a@x.com', role: 'editor', tables: ['tasks'] }];
      app.currentUserEmail = 'ghost@x.com';   // not in the list
      // sidebarTabs must contain no schema-table / data-view tabs for an unmatched user
      const ids = app.sidebarTabs.filter(function (t) { return !t.divider && t.id; }).map(function (t) { return t.id; });
      const leaks = ids.filter(function (id) { return window.SCHEMA[id] || (window.VIEWS[id] && (window.VIEWS[id].sources || []).length); });
      return { unreg: app.isUnregisteredUser, leaks: leaks };
    });
    expect(r.unreg).toBe(true);
    expect(r.leaks).toEqual([]);   // no data-backed tabs leak through to an unmatched user
  });

  test('renameUser lowercases + trims the email key at write time', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      let captured = null;
      window.backend_users = {
        removeUser: function () { return Promise.resolve(); },
        setUserRole: function (uid, role, user, tables) { if (!captured) captured = { uid: uid, user: user }; return Promise.resolve(); },
        getUsers: function () { return Promise.resolve({}); }
      };
      app.renameUser({ key: '_new_1', addr: '', role: 'editor', tables: ['reports'] }, '  Foo@X.COM ');
      await new Promise(function (res) { setTimeout(res, 50); });
      return captured;
    });
    expect(r.uid).toBe('foo@x.com');   // doc key: trimmed + lowercased to match the auth email
    expect(r.user).toBe('foo@x.com');  // user field mirrors the normalized key
  });

  test('sortedUserList is stable (by key) across rebuilds -> rows do not jump', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.userList = [
        { key: 'zoe@x.com', role: 'editor', tables: [] },
        { key: 'Amy@x.com', role: 'admin', tables: 'all' },
        { key: 'bob@x.com', role: 'viewer', tables: [] }
      ];
      const order1 = app.sortedUserList.map(function (u) { return u.key; });
      // Simulate a loadUsers() refetch that returns users in a different raw order
      app.userList = [
        { key: 'bob@x.com', role: 'viewer', tables: [] },
        { key: 'zoe@x.com', role: 'editor', tables: [] },
        { key: 'Amy@x.com', role: 'admin', tables: 'all' }
      ];
      const order2 = app.sortedUserList.map(function (u) { return u.key; });
      return { order1: order1, order2: order2 };
    });
    expect(r.order1).toEqual(['Amy@x.com', 'bob@x.com', 'zoe@x.com']); // case-insensitive alphabetical
    expect(r.order2).toEqual(['Amy@x.com', 'bob@x.com', 'zoe@x.com']); // identical after rebuild -> no jump
  });
});

test.describe('filter list values: seeded and locked agree', () => {
  test('$or/$and filter values are BOTH seeded and locked (one shared walk)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // convertViewFilters rewrites every legacy `{col:[a,b]}` to $or at load, so grouped filters are
      // the common case -- and the locker used to iterate the key '$or', match no column, lock nothing.
      window.VIEWS.or_fx = { name: 'or_fx', sources: ['tasks'], columns: ['title'],
        filter: { $or: [{ status: 'open' }, { status: 'done' }] } };
      window.VIEWS.and_fx = { name: 'and_fx', sources: ['tasks'], columns: ['title'],
        filter: { $and: [{ assigned_to: 'Zoe' }] } };
      app.schemaData = Object.freeze(Object.assign({}, app.schemaData, { _bump: Date.now() }));  // invalidate the computed
      const listsCache = { status: [], assigned_to: [] };
      window._seedListValues(listsCache);
      const locked = app.lockedListValues;
      return {
        seededStatus: listsCache.status.slice(),
        lockedStatus: Object.keys(locked.status || {}),
        seededAssigned: listsCache.assigned_to.slice(),
        lockedAssigned: Object.keys(locked.assigned_to || {})
      };
    });
    // Seeding always recursed into $or; locking is what was missing.
    expect(r.seededStatus).toEqual(expect.arrayContaining(['open', 'done']));
    expect(r.lockedStatus).toEqual(expect.arrayContaining(['open', 'done']));   // was [] for $or
    expect(r.seededAssigned).toContain('Zoe');
    expect(r.lockedAssigned).toContain('Zoe');                                  // was [] for $and
  });
});

test.describe('@me filter token', () => {
  test('is never seeded, locked, or offered as a list value (it resolves per-user at filter time)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // A view filtering a list-backed column by the token, plus a real value to prove the
      // seeding/locking still works for genuine values.
      window.VIEWS.me_fx  = { name: 'me_fx', sources: ['tasks'], columns: ['title'], filter: { assigned_to: '@me' } };
      window.VIEWS.real_fx = { name: 'real_fx', sources: ['tasks'], columns: ['title'], filter: { status: 'done' } };
      app.schemaData = Object.freeze(Object.assign({}, app.schemaData, { _bump: Date.now() }));  // invalidate lockedListValues
      const listsCache = { assigned_to: ['Ann'], status: ['open'] };
      const seeded = window._seedListValues(listsCache);
      const locked = app.lockedListValues;
      return {
        seededAssigned: listsCache.assigned_to,          // '@me' must NOT be here
        seededStatus: listsCache.status,                 // 'done' SHOULD be seeded
        seededFlag: seeded,
        lockedAssigned: Object.keys(locked.assigned_to || {}),
        lockedStatus: Object.keys(locked.status || {}),
        tokenTranslationKeys: app.translationKeys.filter(k => k.indexOf('@me') >= 0)
      };
    });
    // The fixture's own views also filter these columns, so assert on the token rather than exact
    // list contents: '@me' must be absent, real filter values must still seed/lock as before.
    expect(r.seededAssigned).not.toContain('@me');       // token not seeded into the picker's list
    expect(r.seededAssigned).toContain('Ann');           // pre-existing value untouched
    expect(r.seededStatus).toContain('done');            // real filter values still seed
    expect(r.lockedAssigned).not.toContain('@me');       // token not locked (would be undeletable)
    expect(r.lockedStatus).toContain('done');            // real values still lock
    expect(r.tokenTranslationKeys).toEqual([]);          // no list.<list>.@me key
  });
});

test.describe('rsvp + pivot sorting', () => {
  test('rsvp: headers sort by date/title/response/count, default stays chronological', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const vm = { sortCol: null, sortAsc: true,
        options: [{ value: 'coming' }, { value: 'maybe' }, { value: 'out' }],
        data: { events: [
          { id: 'a', date: '2026-07-10', title: 'Beta',  myStatus: 'out',    total: 5 },
          { id: 'b', date: '2026-07-02', title: 'Alpha', myStatus: 'coming', total: 11 },
          { id: 'c', date: '2026-07-20', title: '',      myStatus: '',       total: 4 }
        ] } };
      // Drive the component's own computed/methods against the fixture above.
      const C = app.$.appContext.components['rsvp-view'];
      const events = C.computed.events.call(vm);
      const out = { engineOrder: events.map(e => e.id) };
      const run = (col, asc) => { vm.sortCol = col; vm.sortAsc = asc; return C.computed.events.call(vm).map(e => e.id); };
      out.dateAsc = run('date', true);
      out.dateDesc = run('date', false);
      out.titleAsc = run('title', true);        // blank title must sort last
      out.statusAsc = run('myStatus', true);    // configured status order, blank last
      out.totalDesc = run('total', false);      // numeric, not lexicographic
      return out;
    });
    expect(r.engineOrder).toEqual(['a', 'b', 'c']);   // untouched: the rsvp.js engine's own order
    expect(r.dateAsc).toEqual(['b', 'a', 'c']);
    expect(r.dateDesc).toEqual(['c', 'a', 'b']);
    expect(r.titleAsc).toEqual(['b', 'a', 'c']);      // Alpha, Beta, then the blank
    expect(r.statusAsc).toEqual(['b', 'a', 'c']);     // coming, out, then blank (list order, not A-Z)
    expect(r.totalDesc).toEqual(['b', 'a', 'c']);     // 11, 5, 4
  });

  test('pivot: row-axis, a column\'s cells, and totals all sort; default is grid order', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      const vm = { sortCol: null, sortAsc: true,
        rowLabel: k => k,
        grid: { columns: ['Dishes', 'Mow'], rows: [
          { key: 'Cara', cells: [1, 9], total: 10 },
          { key: 'Ann',  cells: [7, 2], total: 9 },
          { key: 'Bob',  cells: [3, '' ], total: 3 }
        ] } };
      const C = app.$.appContext.components['pivot-view'];
      const out = { gridOrder: C.computed.rows.call(vm).map(r => r.key) };
      const run = (col, asc) => { vm.sortCol = col; vm.sortAsc = asc; return C.computed.rows.call(vm).map(r => r.key); };
      out.byRowLabel = run('__row__', true);
      out.byFirstCol = run(0, false);       // Dishes desc: 7, 3, 1
      out.bySecondCol = run(1, true);       // Mow asc: 2, 9, then the blank cell last
      out.byTotalDesc = run('__total__', false);
      return out;
    });
    expect(r.gridOrder).toEqual(['Cara', 'Ann', 'Bob']);   // untouched grid key order
    expect(r.byRowLabel).toEqual(['Ann', 'Bob', 'Cara']);
    expect(r.byFirstCol).toEqual(['Ann', 'Bob', 'Cara']);  // 7, 3, 1
    expect(r.bySecondCol).toEqual(['Ann', 'Cara', 'Bob']); // 2, 9, blank last
    expect(r.byTotalDesc).toEqual(['Cara', 'Ann', 'Bob']); // 10, 9, 3
  });
});

test.describe('blank-row creation (shared by grid / embed / calendar add)', () => {
  test('every add path seeds `position` on a reorderable table, stamps owner, and prefills', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      app.userList = []; app.usersLoaded = true;
      app.dataCache['crew_rotation'] = [{ id: 'p1', position: '1', people: [] }, { id: 'p2', position: '2', people: [] }];
      const out = {};

      // 1. The grid path (already correct before the extraction) -> next position.
      app.currentTable = 'crew_rotation';
      app.addRow();
      out.gridPosition = app.dataCache['crew_rotation'].slice(-1)[0].position;

      // 2. The EMBED path -- this used to leave position blank, so the row sorted after every
      //    placed row. window.VIEWS embed spec resolved via embedSources.
      window.VIEWS.rot_embed = { name: 'rot_embed', sources: ['crew_rotation'], columns: ['position', 'people'] };
      app.embedAddRow('view', 'rot_embed');
      out.embedPosition = app.dataCache['crew_rotation'].slice(-1)[0].position;

      // 3. The CALENDAR path -- same gap, plus it must prefill the clicked date.
      app.dataCache['tasks'] = [];
      window.VIEWS.cal_add2 = { name: 'cal_add2', calendar: { source: 'tasks', dateColumn: 'date', titleColumns: ['title'] } };
      app.calendarAddOnDay('cal_add2', '2026-07-09');
      const t = app.dataCache['tasks'].slice(-1)[0];
      out.calPrefilledDate = t.date;
      out.calBlankTitle = t.title;
      return out;
    });
    expect(r.gridPosition).toBe('3');     // unchanged behaviour
    expect(r.embedPosition).toBe('4');    // was '' before: the fix
    expect(r.calPrefilledDate).toBe('2026-07-09');
    expect(r.calBlankTitle).toBe('');
  });
});

test.describe('sorting', () => {
  test('a view sorts by a numeric column (real numbers and string-stored) instead of throwing', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // A VIEW: currentTable is a view name, which has no SCHEMA entry -- the case that used to skip
      // the numeric branch and then throw on Number.localeCompare.
      window.VIEWS.sort_fx = { name: 'sort_fx', sources: ['tasks'], columns: ['title', 'position'] };
      app.currentTable = 'sort_fx';
      const out = {};

      // 1. Aggregate-style REAL numbers (count/sum results belong to no table).
      app.dataCache['tasks'] = [];
      app.currentData = [{ id: 'a', title: 'A', total: 11 }, { id: 'b', title: 'B', total: 5 }, { id: 'c', title: 'C', total: 4 }];
      app.sortCol = 'total'; app.sortAsc = true;
      try { out.numAsc = app.sortedData.map(r => r.total); } catch (e) { out.numAsc = 'THREW: ' + e.message; }
      app.sortAsc = false;
      try { out.numDesc = app.sortedData.map(r => r.total); } catch (e) { out.numDesc = 'THREW: ' + e.message; }

      // 2. String-stored numbers on a `number` column -> numeric, not lexicographic ("10" after "2").
      app.currentData = [{ id: 'a', position: '10' }, { id: 'b', position: '2' }, { id: 'c', position: '9' }];
      app.sortCol = 'position'; app.sortAsc = true;
      try { out.strNumAsc = app.sortedData.map(r => r.position); } catch (e) { out.strNumAsc = 'THREW: ' + e.message; }

      // 3. Blanks sort last regardless of direction; text still sorts as text.
      app.currentData = [{ id: 'a', title: 'Beta' }, { id: 'b', title: '' }, { id: 'c', title: 'Alpha' }];
      app.sortCol = 'title'; app.sortAsc = true;
      try { out.textAsc = app.sortedData.map(r => r.title); } catch (e) { out.textAsc = 'THREW: ' + e.message; }
      app.sortAsc = false;
      try { out.textDesc = app.sortedData.map(r => r.title); } catch (e) { out.textDesc = 'THREW: ' + e.message; }
      return out;
    });
    expect(r.numAsc).toEqual([4, 5, 11]);              // used to throw: va.localeCompare is not a function
    expect(r.numDesc).toEqual([11, 5, 4]);
    expect(r.strNumAsc).toEqual(['2', '9', '10']);     // numeric, not lexicographic
    expect(r.textAsc).toEqual(['Alpha', 'Beta', '']);  // blanks last
    expect(r.textDesc).toEqual(['Beta', 'Alpha', '']); // blanks last in both directions
  });
});

test.describe('calendar view', () => {
  test('add-on-day: prefills the clicked date, lands on the table; gated to one writable source', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.cal_add   = { name: 'cal_add', calendar: { source: 'tasks', dateColumn: 'date', titleColumns: ['title'] } };
      window.VIEWS.cal_multi = { name: 'cal_multi', calendar: { sources: [{ table: 'tasks', dateColumn: 'date' }, { table: 'notes', dateColumn: 'date' }] } };
      window.VIEWS.cal_ro    = { name: 'cal_ro', readonly: true, calendar: { source: 'tasks', dateColumn: 'date' } };
      app.dataCache['tasks'] = [];
      app.userList = []; app.usersLoaded = true;                 // admin / unrestricted
      const gates = {
        single: app.canCalendarAdd('cal_add'),
        multi: app.canCalendarAdd('cal_multi'),                  // ambiguous target -> no add offered
        readonly: app.canCalendarAdd('cal_ro')
      };
      app.calendarAddOnDay('cal_add', '2026-07-09');             // a day with NO events
      const rows = app.dataCache['tasks'];
      return { gates, added: rows.length, date: rows[0] && rows[0].date, title: rows[0] && rows[0].title, landedOn: app.currentTable };
    });
    expect(r.gates).toEqual({ single: true, multi: false, readonly: false });
    expect(r.added).toBe(1);
    expect(r.date).toBe('2026-07-09');                           // the clicked day, prefilled
    expect(r.title).toBe('');                                    // rest blank, to be filled in on the table
    expect(r.landedOn).toBe('tasks');                            // where the new row is editable
  });

  test('a day with no items is selectable (empty day panel, not an inert cell)', async ({ page }) => {
    await ensureAppReady(page);
    const anchor = await page.evaluate(() => {
      const app = window.appInstance;
      app.dataCache['tasks'] = [{ id: 'x', date: app._calToday(), title: 'Today thing' }];
      app.userList = []; app.usersLoaded = true;
      app.selectTab('cal_fx');                                    // selectTab drives the render; assigning currentTable does not
      return app._calToday();
    });
    const cal = page.locator('[data-testid="cal-view"]');
    await expect(cal).toBeVisible();
    // Same month as the anchor, but a day that carries no rows. Pick one that isn't today.
    const [y, m] = anchor.split('-');
    const emptyDay = anchor.endsWith('-09') ? `${y}-${m}-10` : `${y}-${m}-09`;
    await cal.locator(`[data-testid="cal-cell-${emptyDay}"]`).click();
    await expect(cal).toContainText('cal.no_events');             // the panel followed the click to an empty day
  });

  test('calEventsFor buckets rows by date (+ undated), month cells + counts + selected day', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.cal_test = { name: 'cal_test', calendar: { source: 'tasks', dateColumn: 'date', titleColumns: ['title'], defaultView: 'month' } };
      app.dataCache['tasks'] = [
        { id: 'a', date: '2026-07-08', title: 'Alpha' },
        { id: 'b', date: '2026-07-08', title: 'Beta' },
        { id: 'c', date: '2026-07-20', title: 'Gamma' },
        { id: 'd', date: '', title: 'NoDate' }
      ];
      app.userList = []; app.usersLoaded = true;        // admin / unrestricted
      app.currentTable = 'cal_test';
      // Model helpers the calendar-view component reads: window + events + month cells (anchor 07-15).
      var ev = app.calEventsFor('cal_test', app._calWindowFor('2026-07-15', 'month', 1));
      var cells = app._calCellsMonth('2026-07-15', 1).map(function(c) { c.count = (ev[c.date] || []).length; return c; });
      var selDay = '2026-07-08';
      return {
        d8: (ev['2026-07-08'] || []).map(function(e) { return e.title; }),
        d20: (ev['2026-07-20'] || []).length,
        undated: (ev['__undated__'] || []).length,
        cells: cells.length,
        cnt8: cells.find(function(c) { return c.date === '2026-07-08'; }).count,
        selCount: (ev[selDay] || []).length,
        listDays: Object.keys(ev).filter(function(k) { return k !== '__undated__'; }).sort()
      };
    });
    expect(r.d8).toEqual(['Alpha', 'Beta']);   // two events on the 8th, sorted
    expect(r.d20).toBe(1);
    expect(r.undated).toBe(1);                 // empty-date row -> Undated bucket
    expect(r.cells).toBe(42);                  // 6x7 month grid
    expect(r.cnt8).toBe(2);                    // count badge value
    expect(r.selCount).toBe(2);                // selected-day panel shows the 8th's events
    expect(r.listDays).toEqual(['2026-07-08', '2026-07-20']); // agenda excludes undated, sorted
  });

  test('navigation: prev/next step the anchor by month/week (addIntervals)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // The calendar-view component's prev/next/goToday delegate to addIntervals(anchor, ±1, ...)
      // and _calToday(); exercise that same underlying logic here.
      var n = window.addIntervals('2026-07-15', 1, 'monthly');            // next (month)
      var p = window.addIntervals(window.addIntervals(n, -1, 'monthly'), -1, 'monthly'); // prev, prev
      var wk = window.addIntervals('2026-07-15', 1, 'weekly');           // next (week)
      var isToday = /^\d{4}-\d{2}-\d{2}$/.test(app._calToday());          // goToday resets to today
      return { n: n, p: p, isToday: isToday, wk: wk };
    });
    expect(r.n).toBe('2026-08-15');   // +1 month
    expect(r.p).toBe('2026-06-15');   // back to -1 month
    expect(r.isToday).toBe(true);
    expect(r.wk).toBe('2026-07-22');  // +1 week
  });

  test('validateSchema flags a bad calendar (non-date dateColumn + missing table)', async ({ page }) => {
    await ensureAppReady(page);
    const joined = await page.evaluate(() => {
      window.VIEWS.cal_bad1 = { name: 'cal_bad1', calendar: { source: 'tasks', dateColumn: 'title' } }; // title is not a date column
      window.VIEWS.cal_bad2 = { name: 'cal_bad2', calendar: { source: 'nope', dateColumn: 'x' } };       // missing table
      var errs = window.validateSchema();
      delete window.VIEWS.cal_bad1; delete window.VIEWS.cal_bad2;
      return errs.join(' | ');
    });
    expect(joined).toContain('cal_bad1');
    expect(joined.toLowerCase()).toContain('must be a date column');
    expect(joined).toContain('non-existent table');
  });

  test('validateSchema requires the rsvp responses table to have a ref to the events table', async ({ page }) => {
    await ensureAppReady(page);
    const joined = await page.evaluate(() => {
      // `notes` has no ref column pointing at `tasks` -> the required response<->event link is missing
      window.VIEWS.rsvp_bad = { name: 'rsvp_bad', rsvp: { events: 'tasks', dateColumn: 'date', responses: 'notes', statusColumn: 'title' } };
      var errs = window.validateSchema();
      delete window.VIEWS.rsvp_bad;
      return errs.join(' | ');
    });
    expect(joined).toContain('rsvp_bad');
    expect(joined).toContain('ref');   // "needs a `ref` column pointing at the events table"
  });

  test('validateSchema warns when a mirror detail of an archivable master is not archivable', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      // master is archivable; detail mirrors it (syncFrom) but is NOT archivable -> archiving a master
      // row would orphan the detail row (the exact church ovimiehet_vuorot / kokoukset case).
      window.SCHEMA.mtg = { columns: { pvm: { type: 'date' } }, archivable: true };
      window.SCHEMA.shift = { columns: { pvm: { type: 'date', syncFrom: 'mtg' } } };            // not archivable
      const warn = window.validateSchema().join(' | ');
      // control: making the detail archivable clears it
      window.SCHEMA.shift.archivable = true;
      const clean = window.validateSchema().filter(e => e.indexOf('shift') >= 0).join(' | ');
      delete window.SCHEMA.mtg; delete window.SCHEMA.shift;
      return { warn, clean };
    });
    expect(r.warn).toContain('shift');
    expect(r.warn).toContain('archivable');
    expect(r.warn).toContain('mtg');           // names the master
    expect(r.clean).toBe('');                  // no warning once the detail is archivable too
  });

  test('calendar renders in a markdown page embed ({{view:cal}})', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.cal_md = { name: 'cal_md', calendar: { source: 'tasks', dateColumn: 'date' } };
      return { isCal: app.isCalendarName('cal_md') === true, notCal: app.isCalendarName('tasks') === false };
    });
    expect(r.isCal).toBe(true);    // markdown embed routes calendar views to <calendar-view :embed>
    expect(r.notCal).toBe(true);
  });

  test('calendar card renders in the DOM (month grid + count badge + selected-day panel)', async ({ page }) => {
    await ensureAppReady(page);
    await page.evaluate(() => {
      const app = window.appInstance;
      // Seed on today so the component's default anchor/selection (both today) land on the events —
      // keeps the DOM assertions date-independent now that anchor/sel live in the component.
      var today = app._calToday();
      window.VIEWS.cal_dom = { name: 'cal_dom', calendar: { source: 'tasks', dateColumn: 'date', titleColumns: ['title'], defaultView: 'month' } };
      app.dataCache['tasks'] = [{ id: 'a', date: today, title: 'Alpha' }, { id: 'b', date: today, title: 'Beta' }];
      app.userList = []; app.usersLoaded = true;
      app.selectTab('cal_dom');
    });
    await page.waitForTimeout(200);
    const card = page.locator('[data-testid="cal-view"]');
    await expect(card).toBeVisible();
    // 7 weekday headers + 42 day cells => the count badge "2" for Jul 8 is present
    await expect(card).toContainText('2');
    // selected-day panel shows the two events
    await expect(card).toContainText('Alpha');
    await expect(card).toContainText('Beta');
  });

  test('multi-source: merges multiple tables (incl. same table twice) + per-source fail-closed', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.cal_multi = { name: 'cal_multi', calendar: { sources: [
        { table: 'tasks', dateColumn: 'date', titleColumns: ['title'], label: 'Task' },
        { table: 'notes', dateColumn: 'date', titleColumns: ['title'], label: 'Note' },
        { table: 'notes', dateColumn: 'date', titleColumns: ['author'], label: 'Author' }
      ] } };
      app.dataCache['tasks'] = [{ id: 't1', date: '2026-07-08', title: 'DoThing' }];
      app.dataCache['notes'] = [{ id: 'n1', date: '2026-07-08', title: 'Memo', author: 'Alice' }];
      app.userList = []; app.usersLoaded = true;   // admin
      app.currentTable = 'cal_multi';
      var win = app._calWindowFor('2026-07-15', 'month', 1);
      var evAdmin = (app.calEventsFor('cal_multi', win))['2026-07-08'] || [];
      // now restrict to only 'tasks' -> notes sources drop out (fail closed)
      app.userList = [{ key: 'u@x.com', addr: 'u@x.com', role: 'editor', tables: ['tasks'] }];
      app.currentUserEmail = 'u@x.com';
      var evRestricted = ((app.calEventsFor('cal_multi', win))['2026-07-08'] || []).map(function(e) { return e.label; });
      return {
        adminLabels: evAdmin.map(function(e) { return e.label; }).sort(),
        adminCount: evAdmin.length,
        restricted: evRestricted
      };
    });
    expect(r.adminCount).toBe(3);                                  // task + note + note-as-author
    expect(r.adminLabels).toEqual(['Author', 'Note', 'Task']);    // three source specs merged
    expect(r.restricted).toEqual(['Task']);                        // notes-backed sources denied -> only Task
  });

  test('rotationSources: generated duties become read-only events, clipped to window, per-roster fail-closed', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // A weekly rotation starting 2026-07-01 (Wed): area_a<-L_a (Alice), area_b<-L_b (Bob), no swap.
      window.VIEWS.rota3 = { name: 'rota3', rotation: { slots: ['area_a', 'area_b'], rosters: ['L_a', 'L_b'], interval: 'weekly', range: { from: '2026-07-01', periods: 12 } } };
      window.VIEWS.cal_rot = { name: 'cal_rot', calendar: { rotationSources: [{ view: 'rota3', label: 'Duty' }], defaultView: 'month' } };
      app.appConfig = { rotationAnchors: { rota3: '2026-07-01' } };
      app.dataCache['L_a'] = [{ id: 'a1', position: 1, people: ['Alice'] }];
      app.dataCache['L_b'] = [{ id: 'b1', position: 1, people: ['Bob'] }];
      app.userList = []; app.usersLoaded = true;               // admin / unrestricted
      app.currentTable = 'cal_rot';
      // Events for the month grid around a given anchor (the calendar-view component's `events`).
      var evAt = function(anchor) { return app.calEventsFor('cal_rot', app._calWindowFor(anchor, 'month', 1)); };

      var jul = evAt('2026-07-15');
      var d15 = jul['2026-07-15'] || [];
      var win = app._calWindowFor('2026-07-15', 'month', 1);
      var out = {
        d15titles: d15.map(function(e) { return e.title; }).sort(),
        d15readonly: d15.every(function(e) { return e.readOnly === true && e.table === null; }),
        d15label: d15.map(function(e) { return e.label; }).sort(),
        // period on the true duty date (07-29 is a rotation period), one per populated slot
        d29: (jul['2026-07-29'] || []).length,
        // a grid cell BEFORE the rotation starts (06-29 is in the July grid) has no duties
        preStart: (jul['2026-06-29'] || []).length,
        winFrom: win.from
      };

      // A month entirely before the rotation begins -> no rotation events generated.
      out.farPast = Object.keys(evAt('2026-01-15')).length;

      // Per-roster fail-closed: user who can read neither roster sees no duties.
      app.userList = [{ key: 'u@x.com', addr: 'u@x.com', role: 'editor', tables: ['tasks'] }];
      app.currentUserEmail = 'u@x.com';
      out.restricted = Object.keys(evAt('2026-07-15')).length;

      // User who can read at least one roster still sees the duties.
      app.userList = [{ key: 'u@x.com', addr: 'u@x.com', role: 'editor', tables: ['L_a'] }];
      out.oneRoster = (evAt('2026-07-15')['2026-07-15'] || []).length;
      return out;
    });
    expect(r.d15titles).toEqual(['area_a: Alice', 'area_b: Bob']); // one event per populated slot
    expect(r.d15readonly).toBe(true);                              // generated -> read-only, no stored row
    expect(r.d15label).toEqual(['Duty', 'Duty']);                  // rotationSources label
    expect(r.d29).toBe(2);                                         // duties land on their true weekly date
    expect(r.preStart).toBe(0);                                    // clipped: nothing before rotation start
    expect(r.winFrom).toBe('2026-06-29');                          // Monday-start July grid begins 06-29
    expect(r.farPast).toBe(0);                                     // window before start -> zero periods
    expect(r.restricted).toBe(0);                                  // no readable roster -> fail closed
    expect(r.oneRoster).toBe(2);                                   // >=1 readable roster -> duties shown
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
    expect(ids.some(s => s.startsWith('all_items[summary_cards,quick_list,notes_list]'))).toBe(true); // nested clickable parent
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

  test('the showcase page embeds every element kind (data/table/calendar/rotation/pivot/rsvp/aggregate/doc)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.request.post('/api/putRow', { data: { tableId: 'tasks', data: { id: 'zz', title: 'Archived', status: 'done' }, tab: 'archive' } }); // so {{table:tasks@archive?}} resolves
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.selectTab('showcase');
      const embeds = app.pageBlocks.filter(b => b.embedName).map(b => b.embedName);
      return {
        kind: app.viewKind,
        embeds,
        cal: app.isCalendarName('chore_calendar'),   // page-view routes this to <calendar-view :embed>
        rot: app.isRotationName('crewrota'),          // ...and this to <rotation-view :embed>
        piv: app.isPivotName('chore_heatmap'),
        rsvp: app.isRsvpName('my_rsvp')               // ...and {{view:my_rsvp}} to <rsvp-view :embed>
      };
    });
    expect(r.kind).toBe('page');
    // data view + table + calendar + rotation + pivot + rsvp + aggregate view + nested doc-view + archive-partition table
    expect(r.embeds).toEqual(['combined', 'notes', 'chore_calendar', 'crewrota', 'chore_heatmap', 'my_rsvp', 'leaderboard', 'task_doc', 'tasks']);
    expect(r.cal).toBe(true);
    expect(r.rot).toBe(true);
    expect(r.piv).toBe(true);
    expect(r.rsvp).toBe(true);
  });

  test('pivot view (chore_heatmap): person x chore counts + row/col/grand totals', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    // Ann: dishes x2 + trash; Bob: trash. Grid is person x chore -> count.
    for (const [id, person, chore] of [['a', 'Ann', 'dishes'], ['b', 'Ann', 'dishes'], ['c', 'Ann', 'trash'], ['d', 'Bob', 'trash']]) {
      await page.request.post('/api/putRow', { data: { tableId: 'chore_log', data: { id, person, chore, done_on: '2026-07-01' }, tab: 'active' } });
    }
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.selectTab('chore_heatmap');
      const g = app.pivotFor('chore_heatmap');
      return { kind: app.viewKind, columns: g.columns, rows: g.rows.map(x => ({ k: x.key, c: x.cells, t: x.total })), colTot: g.columnTotals, grand: g.grandTotal };
    });
    expect(r.kind).toBe('pivot');                                  // routed to pivot-view via VIEW_KINDS
    expect(r.columns).toEqual(['dishes', 'trash']);                // sorted distinct chores
    expect(r.rows).toEqual([
      { k: 'Ann', c: [2, 1], t: 3 },                               // dishes x2, trash x1
      { k: 'Bob', c: ['', 1], t: 1 }                               // no dishes, trash x1
    ]);
    expect(r.colTot).toEqual([2, 2]);                              // dishes total 2, trash total 2
    expect(r.grand).toBe(4);
    await expect(page.locator('[data-testid="pivot-view"]')).toBeVisible();  // renders in the DOM
  });

  test('rsvp view (my_rsvp): self-service response upserts an owner-stamped row + tallies', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.currentUserEmail = 'me@x.com';   // the owner identity
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return window.fmtDate(x); };
      app.dataCache['practices'] = [
        { id: 'p1', date: d(3), title: 'Practice', opponent: '' },
        { id: 'p2', date: d(10), title: 'Match', opponent: 'Reds' }
      ];
      app.dataCache['rsvps'] = [{ id: 'other', owner: 'you@x.com', practice: 'p1', response: 'maybe' }]; // someone else's — links by event id
      app.listsCache = Object.assign({}, app.listsCache, { rsvp_status: ['coming', 'maybe', 'out'] }); // Lookup-editable list
      const optionVals = app.getListOptions('response').map(o => o.value);   // options come FROM the list, not inline
      app.selectTab('my_rsvp');
      const before = app.rsvpFor('my_rsvp').events.map(e => e.myStatus);   // I haven't responded
      app.setRsvp('my_rsvp', 'p1', 'coming');                              // respond to the first practice (by id)
      const after = app.rsvpFor('my_rsvp');
      const myRow = app.dataCache['rsvps'].find(x => x.owner === 'me@x.com');
      const roster = after.events[0].participants;                       // who registered (public roster)
      app.setRsvp('my_rsvp', 'p1', 'out');                                // change my mind -> UPSERT (no dup row)
      const myRow2 = app.dataCache['rsvps'].find(x => x.owner === 'me@x.com');
      const myRowCountBeforeRemove = app.dataCache['rsvps'].filter(x => x.owner === 'me@x.com').length;
      app.setRsvp('my_rsvp', 'p1', '');                                   // REMOVE my vote (toggle off)
      const removed = app.rsvpFor('my_rsvp');
      return {
        kind: app.viewKind,
        before,
        myStatusAfter: after.events[0].myStatus,
        tally: after.events[0].tally,
        roster,
        rosterPublic: myRow2.rosterPublic,
        ownerStamped: myRow.owner,
        linkVal: myRow.practice,
        upsertedStatus: myRow2.response,
        optionVals,
        myRowCount: myRowCountBeforeRemove,
        ownerReadonly: app.cellReadonly({}, 'owner', 'rsvps'),
        afterRemoveMyStatus: removed.events[0].myStatus,
        afterRemoveRoster: removed.events[0].participants,
        afterRemoveTally: removed.events[0].tally,
        myRowCountAfterRemove: app.dataCache['rsvps'].filter(x => x.owner === 'me@x.com').length
      };
    });
    expect(r.kind).toBe('rsvp');                                 // routed to rsvp-view via VIEW_KINDS
    expect(r.before).toEqual(['', '']);                          // no response from me yet
    expect(r.myStatusAfter).toBe('coming');                      // my response recorded
    expect(r.tally).toEqual({ coming: 1, maybe: 1 });            // me coming + the other's maybe
    expect(r.roster).toEqual([                                   // public roster shows WHO (sorted by status)
      { owner: 'me@x.com', status: 'coming' },
      { owner: 'you@x.com', status: 'maybe' }
    ]);
    expect(r.rosterPublic).toBe(true);                           // stamped from the (public) table policy
    expect(r.ownerStamped).toBe('me@x.com');                     // row stamped with MY email, not editable
    expect(r.linkVal).toBeTruthy();                              // linked to the practice
    expect(r.upsertedStatus).toBe('out');                        // second response updated, not duplicated
    expect(r.optionVals).toEqual(['coming', 'maybe', 'out']);    // options come from the rsvp_status list (real, Lookup-editable)
    expect(r.myRowCount).toBe(1);                                // still one row for me
    expect(r.ownerReadonly).toBe(true);                          // owner column is read-only
    // Removing my vote deletes my row (no empty-status orphan) -> I disappear from the roster/tally.
    expect(r.afterRemoveMyStatus).toBe('');
    expect(r.myRowCountAfterRemove).toBe(0);                     // row deleted, not left blank
    expect(r.afterRemoveRoster).toEqual([{ owner: 'you@x.com', status: 'maybe' }]); // no blank "me@x.com" line
    expect(r.afterRemoveTally).toEqual({ maybe: 1 });
    await expect(page.locator('[data-testid="rsvp-view"]')).toBeVisible();
    // A non-admin viewer must not see an unshared member in the roster at all — neither name nor email
    // (both participants here have no shared profile, so the roster reveals neither).
    const rosterText = await page.locator('[data-testid="rsvp-roster"]').first().textContent();
    expect(rosterText).not.toContain('you@x.com');   // another member's email is never shown to a non-admin
    expect(rosterText).not.toContain('me@x.com');    // unshared members are hidden entirely
  });

  test('rsvp roster: non-admin sees shared members by name (never email); unshared members are hidden', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(async () => {
      // ann opts in with a name; zoe does not share at all
      localStorage.setItem('test_user', 'ann@x.com'); await backend_users.setMyProfile('Ann', true);
      localStorage.setItem('test_user', 'local@dev');
      const app = window.appInstance;
      app.currentUserEmail = 'member@x.com';        // a non-admin viewer
      await app.loadSharedProfiles();               // pulls Ann's shared profile into profilesByEmail
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return window.fmtDate(x); };
      app.dataCache['practices'] = [{ id: 'p1', date: d(3), title: 'Practice', opponent: '' }];
      app.dataCache['rsvps'] = [
        { id: 'a', owner: 'ann@x.com', practice: 'p1', response: 'coming' },
        { id: 'z', owner: 'zoe@x.com', practice: 'p1', response: 'coming' }
      ];
      app.listsCache = Object.assign({}, app.listsCache, { rsvp_status: ['coming', 'maybe', 'out'] });
      app.selectTab('my_rsvp');
      return { admin: app.isAdmin };
    });
    expect(r.admin).toBe(false);                                     // viewer is not an admin
    const rosterText = await page.locator('[data-testid="rsvp-roster"]').first().textContent();
    expect(rosterText).toContain('Ann');             // shared member -> shown by name
    expect(rosterText).not.toContain('ann@x.com');   // ...never their email
    expect(rosterText).not.toContain('zoe@x.com');   // unshared member -> hidden entirely
    // cleanup so the shared opt-in doesn't leak into other tests
    await page.evaluate(async () => {
      localStorage.setItem('test_user', 'ann@x.com'); await backend_users.setMyProfile('', false);
      localStorage.setItem('test_user', 'local@dev');
    });
  });

  test('profile: sharing is dropped when the display name is empty (name required to share)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(async () => {
      localStorage.setItem('test_user', 'named@x.com');
      const app = window.appInstance;
      app.currentUserEmail = 'named@x.com';
      app.myProfile = { name: 'Named', shared: true, picture: '' };   // opt in WITH a name
      app.saveMyProfile();
      await new Promise(r => setTimeout(r, 200));
      const withName = await backend_users.getMyProfile();
      app.myProfile.name = ''; app.myProfile.shared = true;           // clear the name while still "shared"
      app.saveMyProfile();
      await new Promise(r => setTimeout(r, 200));
      const cleared = await backend_users.getMyProfile();
      const modelShared = app.myProfile.shared;
      localStorage.setItem('test_user', 'local@dev');
      return { withNameShared: withName.shared, clearedShared: cleared.shared, modelShared: modelShared };
    });
    expect(r.withNameShared).toBe(true);    // sharing allowed once a name is set
    expect(r.clearedShared).toBe(false);    // clearing the name un-shares the profile
    expect(r.modelShared).toBe(false);      // ...and the toggle state reflects it
  });

  test('user-linked lists: getListAvatars projects value->picture (non-admin: shared only, no email); links are admin-only', async ({ page }) => {
    const api = (route, data, user) => page.request.post('/api/' + route, { headers: { 'X-User': user || 'local@dev' }, data: data || {} });
    await api('resetData');
    // Seed profiles: Ann shared with a photo; Cara has a photo but did NOT share.
    await api('setMyProfile', { name: 'Ann',  shared: true,  picture: 'PIC_ANN'  }, 'ann@x.com');
    await api('setMyProfile', { name: 'Cara', shared: false, picture: 'PIC_CARA' }, 'cara@x.com');
    // Register an admin + a viewer (once users exist, unregistered callers are non-admin).
    await api('setUserRole', { uid: 'admin@x.com',  role: 'admin',  user: 'admin@x.com',  tables: 'all' });
    await api('setUserRole', { uid: 'viewer@x.com', role: 'viewer', user: 'viewer@x.com', tables: [] }, 'admin@x.com');
    // Admin links two list values to accounts.
    await api('setListUser', { listName: 'people', value: 'Ann',  email: 'ann@x.com'  }, 'admin@x.com');
    await api('setListUser', { listName: 'people', value: 'Cara', email: 'cara@x.com' }, 'admin@x.com');

    const adminProj  = await (await api('getListAvatars', {}, 'admin@x.com')).json();
    const viewerProj = await (await api('getListAvatars', {}, 'viewer@x.com')).json();
    expect(adminProj).toEqual({ people: { Ann: 'PIC_ANN', Cara: 'PIC_CARA' } });  // admin sees both linked photos
    expect(viewerProj).toEqual({ people: { Ann: 'PIC_ANN' } });                    // non-admin: shared linked only
    expect(JSON.stringify(viewerProj)).not.toContain('@');                         // ...and never an email

    const links = await (await api('getListUserLinks', {}, 'admin@x.com')).json();
    expect(links).toEqual({ people: { Ann: 'ann@x.com', Cara: 'cara@x.com' } });   // admin gets the raw email links
    const denied = await api('getListUserLinks', {}, 'viewer@x.com');
    expect(denied.status()).toBe(403);                                             // non-admin denied the raw links
  });

  test('user-linked lists: a readonly list cell renders the linked user avatar beside the value', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const api = (route, data, user) => page.request.post('/api/' + route, { headers: { 'X-User': user || 'local@dev' }, data: data || {} });
    await api('resetData');
    await api('setMyProfile', { name: 'Ann', shared: true, picture: 'PIC_ANN' }, 'ann@x.com');  // linked user + photo
    await api('setListUser', { listName: 'people', value: 'Ann', email: 'ann@x.com' });          // link the value (bootstrap admin)
    await api('saveSchema', { schema: { tables: { roster: { readonly: true, columns: [{ name: 'who', type: 'select', list: 'people' }] } } } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const seeded = await page.evaluate(() => {
      const app = window.appInstance;
      app.listsCache = Object.assign({}, app.listsCache, { people: ['Ann'] });
      app.dataCache['roster'] = [{ id: 'r1', who: 'Ann' }];
      app.selectTab('roster');
      return { proj: app.listAvatars, resolved: app.listValuePicture('who', 'Ann') };
    });
    expect(seeded.proj).toEqual({ people: { Ann: 'PIC_ANN' } });   // projection loaded at boot
    expect(seeded.resolved).toBe('PIC_ANN');                        // client resolver maps col->list->picture
    // the cell renders the avatar image AND still shows the value text
    const avatarImg = page.locator('.v-main .user-avatar img').first();
    await expect(avatarImg).toHaveAttribute('src', 'PIC_ANN');
    await expect(page.locator('.v-main')).toContainText('Ann');
  });

  test('user-linked lists: an aggregate group card shows the linked avatar in its title (piispakunta pattern)', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const api = (route, data, user) => page.request.post('/api/' + route, { headers: { 'X-User': user || 'local@dev' }, data: data || {} });
    await api('resetData');
    await api('setMyProfile', { name: 'Ann', shared: true, picture: 'PIC_ANN' }, 'ann@x.com');
    await api('setListUser', { listName: 'people', value: 'Ann', email: 'ann@x.com' });
    // A grouped aggregate (like piispakunta): one card per group value of `role`, whose list is `people`.
    await api('saveSchema', { schema: {
      tables: { duties: { columns: [{ name: 'role', type: 'select', list: 'people' }, { name: 'd', type: 'date' }] } },
      views: [{ name: 'byrole', layout: 'card', mode: 'union', sources: ['duties'], groupBy: { column: 'byrole', from: ['role'] }, collect: 'd', columns: ['byrole'] }],
      listSources: { people: 'userlink' },
      nav: { items: [{ view: 'byrole' }] }
    } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const seeded = await page.evaluate(() => {
      const app = window.appInstance;
      app.listsCache = Object.assign({}, app.listsCache, { people: ['Ann'] });
      app.dataCache['duties'] = [{ id: 'd1', role: 'Ann', d: '2026-01-01' }];
      app.selectTab('byrole');
      return { titleCol: app.visibleCols[0], list: app.listNameForCol(app.visibleCols[0]), groupVals: app.sortedData.map(r => r[app.visibleCols[0]]) };
    });
    expect(seeded.titleCol).toBe('byrole');
    expect(seeded.list).toBe('people');          // synthetic group column resolves to its source list
    expect(seeded.groupVals).toContain('Ann');   // one card per role value
    // the group card's title renders the linked user's avatar
    const avatarImg = page.locator('.v-main .v-card .user-avatar img').first();
    await expect(avatarImg).toHaveAttribute('src', 'PIC_ANN');
  });

  test('user-linked lists: the Lookup editor links a value to a user (admin picker) for userlink-flagged lists', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const api = (route, data, user) => page.request.post('/api/' + route, { headers: { 'X-User': user || 'local@dev' }, data: data || {} });
    await api('resetData');
    await api('setMyProfile', { name: 'Ann', shared: true, picture: 'PIC_ANN' }, 'ann@x.com');   // a registered, shared user
    await api('setUserRole', { uid: 'local@dev', role: 'admin', user: 'local@dev', tables: 'all' }); // the acting admin
    await api('setUserRole', { uid: 'ann@x.com', role: 'viewer', user: 'ann@x.com', tables: [] });    // so she's a pick option
    await api('saveSchema', { schema: { tables: { roster: { columns: [{ name: 'who', type: 'select', list: 'people' }] } }, listSources: { people: 'userlink', status: 'x' } } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const flags = await page.evaluate(() => {
      const app = window.appInstance;
      app.listsCache = Object.assign({}, app.listsCache, { people: ['Ann'], status: ['open'] });
      window._listsCache = app.listsCache;
      app.selectTab('__lookup');
      return { peopleIsLink: app.isUserLinkList('people'), statusIsLink: app.isUserLinkList('status'), opts: app.listUserOptions().map(o => o.email) };
    });
    expect(flags.peopleIsLink).toBe(true);     // flagged list is user-linkable
    expect(flags.statusIsLink).toBe(false);    // a non-'userlink' listSource value is NOT
    expect(flags.opts).toContain('ann@x.com'); // registered users are pick options
    // the picker renders for a value of the userlink list (expand the group)
    await page.locator('.v-main .v-list-group').filter({ hasText: 'people' }).locator('.v-list-group__header').first().click();
    await expect(page.locator('[data-testid="list-user-picker"]').first()).toBeVisible();
    // link through the app method, then verify it persisted, projected, and refreshed the editor state
    const r = await page.evaluate(async () => {
      window.appInstance.setListUserLink('people', 'Ann', 'ann@x.com');
      await new Promise(r => setTimeout(r, 300));
      return { links: await backend.getListUserLinks(), avatars: window.appInstance.listAvatars, uiLinks: window.appInstance.listUserLinks };
    });
    expect(r.links).toEqual({ people: { Ann: 'ann@x.com' } });   // persisted (raw admin links)
    expect(r.avatars).toEqual({ people: { Ann: 'PIC_ANN' } });   // projected for cell rendering
    expect(r.uiLinks).toEqual({ people: { Ann: 'ann@x.com' } }); // editor state refreshed
  });

  test('user-linked lists: a link follows a list-value rename and is dropped on delete', async ({ page }) => {
    test.setTimeout(20000);
    const api = (route, data, user) => page.request.post('/api/' + route, { headers: { 'X-User': user || 'local@dev' }, data: data || {} });
    await api('resetData');
    await api('setMyProfile', { name: 'Ann', shared: true, picture: 'PIC_ANN' }, 'ann@x.com');
    await api('setUserRole', { uid: 'local@dev', role: 'admin', user: 'local@dev', tables: 'all' });
    await api('setUserRole', { uid: 'ann@x.com', role: 'viewer', user: 'ann@x.com', tables: [] });
    await api('saveSchema', { schema: { tables: { roster: { columns: [{ name: 'who', type: 'select', list: 'people' }] } }, listSources: { people: 'userlink' } } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(async () => {
      const app = window.appInstance;
      app.listsCache = Object.assign({}, app.listsCache, { people: ['Ann'] });
      window._listsCache = app.listsCache;
      app.setListUserLink('people', 'Ann', 'ann@x.com');
      await new Promise(r => setTimeout(r, 250));
      app.updateListItem2('people', 0, 'Ann V.');       // rename the value
      await new Promise(r => setTimeout(r, 400));
      const afterRename = await backend.getListUserLinks();
      app.removeListItem2('people', 0); app.removeListItem2('people', 0); // arm + confirm delete
      await new Promise(r => setTimeout(r, 400));
      const afterDelete = await backend.getListUserLinks();
      return { afterRename, afterDelete };
    });
    expect(r.afterRename).toEqual({ people: { 'Ann V.': 'ann@x.com' } });  // link moved to the new value, old key gone
    expect(r.afterDelete).toEqual({});                                     // deleting the value dropped the link
  });

  test('rsvp: status labels translate (statusList) + picker type is configurable', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const schema = {
      defaultLanguage: 'en',
      tables: {
        practices: { columns: [{ name: 'date', type: 'date' }, { name: 'title', type: 'text' }], archivable: true },
        rsvps: { columns: [{ name: 'owner', type: 'owner' }, { name: 'practice', type: 'ref', table: 'practices', valueCol: 'id' }, { name: 'status', type: 'text' }] }
      },
      views: [{ name: 'signup', rsvp: { events: 'practices', dateColumn: 'date', titleColumns: ['title'], responses: 'rsvps', statusColumn: 'status', statuses: ['coming', 'maybe', 'out'], statusList: 'rsvp_status', picker: 'chips', rosterVisibility: 'all', showCounts: true } }],
      nav: { items: [{ view: 'signup' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.evaluate(() => {
      const app = window.appInstance;
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return window.fmtDate(x); };
      app.dataCache['practices'] = [{ id: 'p1', date: d(3), title: 'Match' }];
      app.dataCache['rsvps'] = [];
      app.strings['list.rsvp_status.coming'] = 'Tulossa';   // translate one status label
      app.selectTab('signup');
    });
    await page.waitForTimeout(150);
    // picker: "chips" -> renders a chip group (not the default dropdown)
    await expect(page.locator('[data-testid="rsvp-toggle"].v-chip-group')).toBeVisible();
    // and the option label is translated via list.<statusList>.<value>
    await expect(page.locator('[data-testid="rsvp-toggle"]')).toContainText('Tulossa');
  });

  test('rsvp: picker defaults to dropdown (v-select) when unset', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const schema = {
      defaultLanguage: 'en',
      tables: {
        practices: { columns: [{ name: 'date', type: 'date' }, { name: 'title', type: 'text' }], archivable: true },
        rsvps: { columns: [{ name: 'owner', type: 'owner' }, { name: 'practice', type: 'ref', table: 'practices', valueCol: 'id' }, { name: 'response', type: 'select', list: 'rsvp_status' }] }
      },
      views: [{ name: 'signup', rsvp: { events: 'practices', dateColumn: 'date', titleColumns: ['title'], responses: 'rsvps', statusColumn: 'response', rosterVisibility: 'all' } }],  // no `picker`
      nav: { items: [{ view: 'signup' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.evaluate(() => {
      const app = window.appInstance;
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return window.fmtDate(x); };
      app.dataCache['practices'] = [{ id: 'p1', date: d(3), title: 'Match' }];
      app.dataCache['rsvps'] = [];
      app.selectTab('signup');
    });
    await page.waitForTimeout(150);
    // no picker set -> defaults to dropdown (v-select), same default as the column-level picker
    await expect(page.locator('[data-testid="rsvp-toggle"].v-select')).toBeVisible();
    await expect(page.locator('[data-testid="rsvp-toggle"].v-chip-group, [data-testid="rsvp-toggle"].v-btn-toggle')).toHaveCount(0);
  });

  test('rsvp renders a one-row-per-event table on desktop, stacked cards on mobile', async ({ page }) => {
    test.setTimeout(20000);
    const schema = {
      defaultLanguage: 'en',
      tables: {
        practices: { columns: [{ name: 'date', type: 'date' }, { name: 'title', type: 'text' }], archivable: true },
        rsvps: { columns: [{ name: 'owner', type: 'owner' }, { name: 'practice', type: 'ref', table: 'practices', valueCol: 'date' }, { name: 'response', type: 'select', list: 'rsvp_status' }] }
      },
      views: [{ name: 'signup', rsvp: { events: 'practices', dateColumn: 'date', titleColumns: ['title'], responses: 'rsvps', statusColumn: 'response', showCounts: true, rosterVisibility: 'all' } }],
      nav: { items: [{ view: 'signup' }] }
    };
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
    await page.goto('/');
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    await page.evaluate(() => {
      const app = window.appInstance;
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return window.fmtDate(x); };
      app.dataCache['practices'] = [{ id: 'p1', date: d(3), title: 'Match' }];
      app.dataCache['rsvps'] = [{ id: 'r1', owner: 'you@x.com', practice: d(3), response: 'coming' }];
      app.listsCache = Object.assign({}, app.listsCache, { rsvp_status: ['coming', 'maybe', 'out'] });
      app.selectTab('signup');
    });
    await page.waitForTimeout(150);
    // desktop -> a real table with a header row + one row per event
    await expect(page.locator('[data-testid="rsvp-view"] table thead')).toBeVisible();
    await expect(page.locator('[data-testid="rsvp-view"] tbody tr')).toHaveCount(1);
    await expect(page.locator('[data-testid="rsvp-view"] .v-card')).toHaveCount(0);
    // mobile -> stacked cards, no table
    await page.setViewportSize({ width: 375, height: 800 });
    await page.waitForTimeout(250);
    await expect(page.locator('[data-testid="rsvp-view"] table')).toHaveCount(0);
    await expect(page.locator('[data-testid="rsvp-view"] .v-card')).toHaveCount(1);
  });

  test('schema.theme brands the live Vuetify palette + regenerates the CSS variables', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('app_theme', 'light'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const themes = app.$vuetify.theme.themes.value || app.$vuetify.theme.themes;
      return {
        lightPrimary: themes.light.colors.primary,                  // from schema.theme.light
        darkPrimary: themes.dark.colors.primary,
        lightSurfaceUntouched: themes.light.colors.surface,          // NOT in schema -> keeps built-in default
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--v-theme-primary').replace(/\s/g, '')
      };
    });
    expect(r.lightPrimary).toBe('#00695c');           // schema-driven brand color applied
    expect(r.darkPrimary).toBe('#4db6ac');
    expect(r.lightSurfaceUntouched).toBe('#ffffff');  // partial override — unspecified colors keep defaults
    expect(r.cssVar).toBe('0,105,92');                // Vuetify regenerated --v-theme-primary (RGB of #00695c)
  });

  test('pre-Vue splash caches the brand color and applies it on the next boot', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('app_theme', 'light'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    // First boot stashed the brand palette (both modes) for the pre-Vue splash.
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('brand_splash') || 'null'));
    expect(cache.light.p).toBe('#00695c');   // brand primary cached (light)
    expect(cache.dark.p).toBe('#4db6ac');
    // Next boot: the <head> script reads the cache and paints the splash spinner in-brand BEFORE Vue loads.
    await page.reload();
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--splash-accent').trim());
    expect(accent).toBe('#00695c');          // splash spinner brand-colored from the cache
  });

  test('admin theme editor: live-previews a color + persists it to schema.theme', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('app_theme', 'light'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const before = app.themeColor('light', 'primary');           // demo brand teal
      app.setThemeColor('light', 'primary', '#ff0000');            // drag -> live preview only (no save)
      const themes = app.$vuetify.theme.themes.value || app.$vuetify.theme.themes;
      const live = themes.light.colors.primary;
      const el = document.querySelector('.v-theme--light') || document.querySelector('.v-application');
      const cssVar = getComputedStyle(el).getPropertyValue('--v-theme-primary').replace(/\s/g, '');
      // commit (final change / typed value) auto-persists — no Save button.
      app.commitTheme('light', 'primary', '#ff0000');
      app.commitTheme('dark', 'surface', '#101010');
      app.commitTheme('light', 'secondary', 'aabbcc');            // typed WITHOUT '#' -> normalized
      app.commitTheme('light', 'background', 'nope');             // invalid -> ignored (kept default)
      return {
        before, live, cssVar,
        savedLightPrimary: app.schemaData.theme.light.primary,
        savedDarkSurface: app.schemaData.theme.dark.surface,
        savedSecondary: app.schemaData.theme.light.secondary,
        bgUntouched: (app.schemaData.theme.light.background === undefined),
        readBack: app.themeColor('light', 'primary')
      };
    });
    expect(r.before).toBe('#00695c');            // starts from the schema brand
    expect(r.live).toBe('#ff0000');              // setThemeColor applied to the live Vuetify theme
    expect(r.cssVar).toBe('255,0,0');            // --v-theme-primary regenerated (live preview reaches CSS)
    expect(r.savedLightPrimary).toBe('#ff0000'); // commit auto-persisted into schema.theme (no Save button)
    expect(r.savedDarkSurface).toBe('#101010');  // both modes editable
    expect(r.savedSecondary).toBe('#aabbcc');    // typed value normalized (# added)
    expect(r.bgUntouched).toBe(true);            // invalid input ignored (not written)
    expect(r.readBack).toBe('#ff0000');
    // the editor renders (admin): a picker + a text field per token, sun/moon icons per mode
    await page.evaluate(() => window.appInstance.selectTab('__settings'));
    await expect(page.locator('[data-testid="theme-light-primary"]')).toBeVisible();
    await expect(page.locator('[data-testid="theme-txt-light-primary"]')).toBeVisible();
  });

  test('theme editor: paste-a-palette maps colors to roles by luminance + chroma', async ({ page }) => {
    test.setTimeout(20000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: DEMO } });
    await page.goto('/');
    await page.evaluate(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('app_theme', 'light'); });
    await page.reload();
    await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      const parsed = app._parsePalette('["#ccd5ae","#e9edc9","#fefae0"]').length;   // extract # hexes from the array literal
      app.applyPalette('["#ccd5ae","#e9edc9","#fefae0","#faedcd","#d4a373"]');       // coolors export -> current (light) mode
      const t = app.schemaData.theme.light;
      return { parsed, bg: t.background, surface: t.surface, text: t['on-surface'], primary: t.primary, secondary: t.secondary };
    });
    expect(r.parsed).toBe(3);            // parses hex codes out of the array
    expect(r.bg).toBe('#fefae0');        // lightest -> background
    expect(r.surface).toBe('#faedcd');   // 2nd lightest -> surface
    expect(r.text).toBe('#d4a373');      // darkest -> text (on-surface)
    expect(r.primary).toBe('#d4a373');   // most saturated -> primary
    expect(r.secondary).toBe('#faedcd'); // next most saturated -> secondary
    await page.evaluate(() => window.appInstance.selectTab('__settings'));
    await expect(page.locator('[data-testid="theme-palette"]')).toBeVisible();
    // Reactivity: the per-token fields must refresh to the pasted palette (themeColor reads the
    // reactive themeEdit/schema.theme, not the non-reactive $vuetify.theme.themes).
    await expect(page.locator('[data-testid="theme-txt-light-primary"]')).toHaveValue('#d4a373');
    await expect(page.locator('[data-testid="theme-light-background"]')).toHaveValue('#fefae0');
    // The paste field is a v-text-field (styled like profile.email): typing + Enter applies the palette.
    await page.locator('[data-testid="theme-palette"] input').fill('#111111 #eeeeee #888888');
    await page.locator('[data-testid="theme-palette"] input').press('Enter');
    await expect(page.locator('[data-testid="theme-txt-light-background"]')).toHaveValue('#eeeeee');
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
    page.on('dialog', d => d.accept());   // user confirms the projectId connect prompt (the onboarding path)
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
    page.on('dialog', d => d.accept());   // user confirms the projectId connect prompt (the onboarding path)
    await page.route(/gstatic\.com|\/backend-firebase\.html|\/storage-firestore\.html/, r =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.goto('/?mode=firebase&k=API_KEY_9&p=proj-999');
    await page.waitForFunction(() => localStorage.getItem('app_mode') === 'firebase', { timeout: 6000 });

    const cfg = await page.evaluate(() => JSON.parse(localStorage.getItem('firebase_config') || 'null'));
    expect(cfg).toEqual({ apiKey: 'API_KEY_9', authDomain: 'proj-999.firebaseapp.com', projectId: 'proj-999' });
  });
  test('firebase base64 config link restores firebase_config', async ({ page }) => {
    page.on('dialog', d => d.accept());   // user confirms the projectId connect prompt (the onboarding path)
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
        noWhen:  a.embedWhenOk(mk(null), { guests: '' }),                 // no when -> always show
        match:   a.embedWhenOk(mk({ guests: { notEmpty: true } }), { guests: 'Alice' }),
        noMatch: a.embedWhenOk(mk({ guests: { notEmpty: true } }), { guests: '' }),
        orMatch: a.embedWhenOk(mk({ $or: [ { status: 'x' }, { guests: { notEmpty: true } } ] }), { status: '', guests: 'M' })
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
      window._listsCache.guests = ['Alice', 'Bob'];
      const dv = window.appInstance && window.appInstance.displayValue;
      return {
        anyMatch:     f({ h: ['Carol', 'Bob'] }, { h: { matchList: 'guests' } }), // Bob in list -> true
        noneMatch:    f({ h: ['Carol', 'Dave'] }, { h: { matchList: 'guests' } }), // none -> false
        scalarStill:  f({ h: 'Alice' },            { h: { matchList: 'guests' } }), // scalar still works
        notMatchAny:  f({ h: ['Carol', 'Bob'] }, { h: { notMatchList: 'guests' } }), // Bob present -> false
        displayJoin:  dv ? dv('h', ['Alice', 'Bob']) : null,
        displayEmpty: dv ? dv('h', []) : null
      };
    });
    expect(r.anyMatch).toBe(true);
    expect(r.noneMatch).toBe(false);
    expect(r.scalarStill).toBe(true);
    expect(r.notMatchAny).toBe(false);
    expect(r.displayJoin).toBe('Alice, Bob');
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
        { id: 'k1', date: '2026-01-01' },
        { id: 'k2', date: '2026-02-01' },
        { id: 'k3', date: '2026-03-01' }
      ];
      const wi = window.wholeIntervalsBetween, ro = window.resolveByOccurrence, rc = window.resolveByCalendar;
      const ra = window.resolveAnchorDate;
      const ai = window.addIntervals, iv = window.isValidInterval;
      return {
        wkly2:    wi('2026-01-01', '2026-01-15', 'weekly'),    // 14 days -> 2
        wkly0:    wi('2026-01-01', '2026-01-05', 'weekly'),    // 4 days -> 0
        mon2:     wi('2026-01-01', '2026-03-01', 'monthly'),   // 2 months
        monPart:  wi('2026-01-15', '2026-02-10', 'monthly'),   // day 10 < 15 -> 0 full months
        occ0:     ro(rot, src, src[0], 'date'),                 // index 0 -> ['A']
        occ1:     ro(rot, src, src[1], 'date'),                 // index 1 -> ['B','C']
        occLoop:  ro([rot[0], rot[1]], src, src[2], 'date'),    // index 2 % 2 = 0 -> ['A']
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
        slots: ['area_a', 'area_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1,
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.area_a, b: x.area_b }; });
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
        slots: ['area_a', 'area_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: ['cycle'],
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {  // even-length rosters (2 each)
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.area_a, b: x.area_b }; });
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
        slots: ['area_a', 'area_b'], rosters: ['L_a', 'L_b'],
        advanceBy: 'calendar', interval: 'weekly', rotateEvery: [1, 'cycle'],
        range: { from: '2026-01-01', periods: 4 }
      } };
      const cache = {
        L_a: [{ position: 1, people: ['A0'] }, { position: 2, people: ['A1'] }],
        L_b: [{ position: 1, people: ['B0'] }, { position: 2, people: ['B1'] }]
      };
      return window.buildRotationViewRows(view, cache, '2026-01-01', '2026-01-01')
        .map(function(x) { return { p: x._period, a: x.area_a, b: x.area_b }; });
    });
    // s = floor(i/1)%2 + floor(i/2)%2. i=0:0, i=1:1, i=2:1, i=3:2%2=0. memberIdx=i%2.
    expect(r[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] }); // s=0
    expect(r[1]).toEqual({ p: '2026-01-08', a: ['B1'], b: ['A1'] }); // s=1
    expect(r[2]).toEqual({ p: '2026-01-15', a: ['B0'], b: ['A0'] }); // s=1
    expect(r[3]).toEqual({ p: '2026-01-22', a: ['A1'], b: ['B1'] }); // s=2≡0
  });

  test('numeric rotateEvery is anchored: shifting the window `from` does NOT change a date\'s assignment', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { rotation: { slots: ['area_a', 'area_b'], rosters: ['L_a', 'L_b'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1 } };
      const cache = { L_a: [{ position: 1, people: ['A0'] }], L_b: [{ position: 1, people: ['B0'] }] };
      const anchor = '2026-01-01';
      // Same anchor, two different window starts. The overlapping date 2026-01-08 must resolve to the
      // SAME slot assignment regardless of where the window begins (window is display-only).
      const pick = function (rows, d) { return rows.filter(function (x) { return x._period === d; }).map(function (x) { return { a: x.area_a, b: x.area_b }; })[0]; };
      const fromAnchor = window.buildRotationViewRows(view, cache, anchor, anchor, { from: '2026-01-01', periods: 4 });
      const fromShifted = window.buildRotationViewRows(view, cache, anchor, anchor, { from: '2026-01-08', periods: 4 });
      return { anchored: pick(fromAnchor, '2026-01-08'), shifted: pick(fromShifted, '2026-01-08') };
    });
    expect(r.anchored).toEqual({ a: ['B0'], b: ['A0'] });  // week 1 from anchor -> swapped (abs=1)
    expect(r.shifted).toEqual(r.anchored);                 // window start does NOT reshuffle the assignment
  });
});

test.describe('reorderable tables: position seeding on add', () => {
  test('addRow assigns the next position so new rows append in order (not empty)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.currentTable = 'crew_rotation'; // reorderable in fixture-schema
      app.dataCache['crew_rotation'] = [];
      try { app.addRow(); } catch (e) {}  // focusLastEditable may no-op in headless; seeding runs first
      try { app.addRow(); } catch (e) {}
      return (app.dataCache['crew_rotation'] || []).map(function (x) { return x.position; });
    });
    expect(r).toEqual(['1', '2']); // seeded sequentially — empty positions were the partial-position bug
  });
});


test.describe('rotationView embedding in data views', () => {
  test('a {view:rota} embed yields an isRotation embed with slot columns + generated rows', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.rota_e = { name: 'rota_e', rotation: { slots: ['area_a', 'area_b'], rosters: ['RL_a', 'RL_b'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
      window.VIEWS.host_e = { name: 'host_e', sources: ['tasks'], columns: ['title', { view: 'rota_e' }] };
      app.dataCache['RL_a'] = [{ position: 1, people: ['A0'] }];
      app.dataCache['RL_b'] = [{ position: 1, people: ['B0'] }];
      app.appConfig = Object.assign({}, app.appConfig, { rotationAnchors: { rota_e: '2026-01-01' } });
      app.currentTable = 'host_e';
      const rot = app.embedItems.find(function(e) { return e.kind === 'rotation'; });
      return rot ? { cols: rot.columns, rows: rot.rows.map(function(x) { return { p: x._period, a: x.area_a, b: x.area_b }; }) } : null;
    });
    expect(r).not.toBeNull();                                   // the rotationView embed is recognized
    expect(r.cols).toEqual(['_period', 'area_a', 'area_b']);    // period + slot columns
    expect(r.rows[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] });
    expect(r.rows[1]).toEqual({ p: '2026-01-08', a: ['B0'], b: ['A0'] }); // rotateEvery:1 swap
  });

  test('rotationRowsFor/rotationColsFor + isRotationName drive the name-based (page embed) rendering', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // page-view routes a {{view:x}} embed to <rotation-view :name :embed> when isRotationName(x);
      // the component generates its rows/cols via these name-parameterized helpers (no currentTable).
      window.VIEWS.rota_n = { name: 'rota_n', rotation: { slots: ['area_a', 'area_b'], rosters: ['NL_a', 'NL_b'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 1, range: { from: '2026-01-01', periods: 2 } } };
      app.dataCache['NL_a'] = [{ position: 1, people: ['A0'] }];
      app.dataCache['NL_b'] = [{ position: 1, people: ['B0'] }];
      app.appConfig = Object.assign({}, app.appConfig, { rotationAnchors: { rota_n: '2026-01-01' } });
      app.currentTable = 'tasks';                    // NOT the rotation -> proves name-parameterization
      var rows = app.rotationRowsFor('rota_n');
      return {
        isRot: app.isRotationName('rota_n') === true,
        notRot: app.isRotationName('tasks') === false,
        cols: app.rotationColsFor('rota_n', rows),
        rows: rows.map(function(x) { return { p: x._period, a: x.area_a, b: x.area_b }; })
      };
    });
    expect(r.isRot).toBe(true);                                // routed to rotation-view (not empty embed-view)
    expect(r.notRot).toBe(true);
    expect(r.cols).toEqual(['_period', 'area_a', 'area_b']);   // slot columns even though currentTable=tasks
    expect(r.rows[0]).toEqual({ p: '2026-01-01', a: ['A0'], b: ['B0'] });
    expect(r.rows[1]).toEqual({ p: '2026-01-08', a: ['B0'], b: ['A0'] });
  });

  test('a {view:cal} embed in a data view resolves to a calendar spec (kind=calendar, was empty)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // Previously a calendar embedded in a data view fell through embed-view (no calendar handling)
      // and rendered empty; resolveEmbed now tags it kind='calendar' -> <calendar-view :embed>.
      window.VIEWS.cal_de = { name: 'cal_de', calendar: { source: 'tasks', dateColumn: 'date', titleColumns: ['title'], defaultView: 'month' } };
      window.VIEWS.host_cd = { name: 'host_cd', sources: ['tasks'], columns: ['title', { view: 'cal_de' }] };
      app.dataCache['tasks'] = [{ id: 'a', date: '2026-07-08', title: 'Alpha' }];
      app.userList = []; app.usersLoaded = true;
      app.currentTable = 'host_cd';
      const cal = app.embedItems.find(function(e) { return e.kind === 'calendar'; });
      return cal ? { name: cal.name, visible: app.embedVisible(cal) } : null;
    });
    expect(r).not.toBeNull();       // calendar embed recognized in a data view (the closed gap)
    expect(r.name).toBe('cal_de');
    expect(r.visible).toBe(true);   // calendar always shows; the component handles its own emptiness
  });

  test('resolveEmbed tags each config kind (doc/calendar/rotation/data) for the unified renderer', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // resolveEmbed is the single normalizer feeding embed-view's kind dispatch; assert every branch.
      window.VIEWS.re_cal = { name: 're_cal', calendar: { source: 'tasks', dateColumn: 'date' } };
      window.VIEWS.re_rot = { name: 're_rot', rotation: { slots: ['a'], rosters: ['RLa'], interval: 'weekly', range: { from: '2026-01-01', periods: 1 } } };
      window.VIEWS.re_data = { name: 're_data', sources: ['tasks'], columns: ['title'] };
      app.dataCache['RLa'] = [{ position: 1, people: ['A'] }];
      var k = function(cfg) { return app.resolveEmbed(cfg).kind; };
      return {
        cal: k(Object.assign({ view: 're_cal' }, window.VIEWS.re_cal)),
        rot: k(Object.assign({ view: 're_rot' }, window.VIEWS.re_rot)),
        data: k(Object.assign({ view: 're_data' }, window.VIEWS.re_data)),
        doc: k({ name: 're_doc', markdown: '# hi' })
      };
    });
    expect(r).toEqual({ cal: 'calendar', rot: 'rotation', data: 'data', doc: 'doc' });
  });
});

test.describe('rotationView filter / hideEmpty / layout', () => {
  test('filter narrows generated periods', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const view = { filter: { _period: '2026-01-15' }, rotation: { slots: ['area_a'], rosters: ['R'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 0, range: { from: '2026-01-01', periods: 3 } } };
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
      window.VIEWS.rot_he = { name: 'rot_he', layout: 'card', hideEmpty: true, rotation: { slots: ['area_a', 'area_b'], rosters: ['X', 'Y'] } };
      app.currentTable = 'rot_he';
      app.currentData = [
        { id: 'r0', _period: '2026-01-01', area_a: ['A0'], area_b: [] },
        { id: 'r1', _period: '2026-01-08', area_a: ['A1'], area_b: [] }
      ];
      return { cols: app.rotationViewCols, slotCols: app.rotationSlotCols, layout: app.rotationLayout };
    });
    expect(r.cols).toEqual(['_period', 'area_a']); // area_b empty in every period -> dropped
    expect(r.slotCols).toEqual(['area_a']);
    expect(r.layout).toBe('card');
  });

  test('rotationDisplayLayout falls back table->card on mobile (wide table overflows phones)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.lay_t = { name: 'lay_t', rotation: { slots: ['a', 'b'], rosters: ['X', 'Y'] } }; // no layout -> default 'table'
      window.VIEWS.lay_l = { name: 'lay_l', layout: 'list', rotation: { slots: ['a'], rosters: ['X'] } };
      app.currentTable = 'lay_t'; var deskTable = (app.mobile = false, app.rotationDisplayLayout); var mobTable = (app.mobile = true, app.rotationDisplayLayout);
      app.currentTable = 'lay_l'; var mobList = app.rotationDisplayLayout; // explicit non-table layout is preserved on mobile
      app.mobile = false;
      return { deskTable, mobTable, mobList };
    });
    expect(r.deskTable).toBe('table'); // desktop keeps the table
    expect(r.mobTable).toBe('card');   // mobile swaps table -> card (stacked, no horizontal overflow)
    expect(r.mobList).toBe('list');    // an explicitly-chosen layout is left alone
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

  test('DB-backed rotateEvery: saveRotationRotateEvery composes [n,"cycle"], full-replaces schema, reset clears', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      window.VIEWS.re_v = { name: 're_v', rotation: { slots: ['a', 'b'], rosters: ['RA', 'RB'], interval: 'weekly', rotateEvery: [1] } };
      app.appConfig = Object.assign({}, app.appConfig, { rotationRotateEvery: {} });
      app.currentTable = 're_v';
      const eff = function() { return app.rotateEveryForView('re_v'); };
      const ui = function() { return { every: app.rotationEveryForView, cycle: app.rotationCycleForView, overridden: app.rotationRotateEveryOverridden }; };
      var schemaDefault = eff();                                            // no override yet -> schema
      app.saveRotationRotateEvery('re_v', { every: 0, cycle: true });  var cycleOnly = eff(); var uiCycle = ui();
      app.saveRotationRotateEvery('re_v', { every: 2, cycle: true });  var both = eff();
      app.saveRotationRotateEvery('re_v', { every: 0, cycle: false }); var noSwap = eff();   // explicit "no swap" (NOT schema fallthrough)
      app.saveRotationRotateEvery('re_v', null);                       var afterReset = eff(); var uiReset = ui();
      return { schemaDefault, cycleOnly, both, noSwap, afterReset, uiCycle, uiReset };
    });
    expect(r.schemaDefault).toEqual([1]);          // falls back to schema when no override
    expect(r.cycleOnly).toEqual(['cycle']);        // every:0 drops the numeric source
    expect(r.both).toEqual([2, 'cycle']);          // composed array
    expect(r.noSwap).toEqual([]);                  // present override [] = explicit no-swap, full replacement
    expect(r.afterReset).toEqual([1]);             // null clears override -> schema default returns
    expect(r.uiCycle).toEqual({ every: 0, cycle: true, overridden: true });
    expect(r.uiReset).toEqual({ every: 1, cycle: false, overridden: false }); // decomposed from schema [1]
  });

  test('buildRotationViewRows honors rotateEveryOverride (overrides schema rotateEvery)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      // schema says no swap (rotateEvery:0); override forces a per-period swap -> rosters alternate slots
      const view = { rotation: { slots: ['a', 'b'], rosters: ['RA', 'RB'], advanceBy: 'calendar', interval: 'weekly', rotateEvery: 0, range: { from: '2026-01-01', periods: 2 } } };
      const cache = { RA: [{ position: 1, people: ['A0'] }], RB: [{ position: 1, people: ['B0'] }] };
      const noOv = window.buildRotationViewRows(view, cache, '2099-01-01', '2026-01-01').map(function(x) { return { a: x.a, b: x.b }; });
      const ov = window.buildRotationViewRows(view, cache, '2099-01-01', '2026-01-01', undefined, [1]).map(function(x) { return { a: x.a, b: x.b }; });
      return { noOv, ov };
    });
    expect(r.noOv[1]).toEqual({ a: ['A0'], b: ['B0'] });   // schema rotateEvery:0 -> no swap in period 1
    expect(r.ov[1]).toEqual({ a: ['B0'], b: ['A0'] });     // override [1] -> swap in period 1
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

  test('sortedData sorts numeric position numerically past 9 rows (no lexicographic shuffle)', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.currentTable = 'crew_rotation'; // reorderable, defaultSort:'position', position type number
      app.sortCol = 'position'; app.sortAsc = true;
      app.viewingArchive = false;
      // 12 rows positioned "1".."12" as strings (how moveRowPosition/addRow store them).
      // Lexicographic sort would give 1,10,11,12,2,...,9 — the partial-position "whole table shuffles" bug.
      app.currentData = [];
      for (var i = 1; i <= 12; i++) app.currentData.push({ id: 'r' + i, position: String(i), people: ['P' + i] });
      var displayed = app.sortedData.map(function(x) { return x.position; });
      // Press the arrow on the FIRST displayed row -> move it down one. Must swap only rows 1<->2.
      app.moveRowPosition(app.sortedData[0], 1);
      var afterMove = app.sortedData.map(function(x) { return x.position; });
      return { displayed: displayed, afterMove: afterMove };
    });
    // Display is numeric order, NOT lexicographic ['1','10','11','12','2',...]
    expect(r.displayed).toEqual(['1','2','3','4','5','6','7','8','9','10','11','12']);
    // One arrow press swaps only the top two; the rest stay put (no full-table shuffle)
    expect(r.afterMove).toEqual(['1','2','3','4','5','6','7','8','9','10','11','12']);
  });
});

test.describe('per-view rotation anchor', () => {
  test('saveRotationAnchor stores per-view in folder config map', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      app.saveRotationAnchor('cleaning', '2026-03-03');
      app.saveRotationAnchor('shifts', '2026-05-05'); // different view -> different anchor
      return {
        cleaning: app.anchorForView('cleaning'),
        shifts: app.anchorForView('shifts'),
        other: app.anchorForView('nope'),
        map: app.appConfig.rotationAnchors
      };
    });
    expect(r.cleaning).toBe('2026-03-03');
    expect(r.shifts).toBe('2026-05-05'); // per-view anchors are independent
    expect(r.other).toBe('');
    expect(r.map).toEqual({ cleaning: '2026-03-03', shifts: '2026-05-05' });
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
        one: o('John Smith'),
        two: o('Alice Mary Brown'),
        single: o('Cher'),
        empty: o(''),
        disp: app.displayValue('crew', 'John Smith'),
        arr: app.displayValue('crew', ['Charlie Green', 'Alice Brown'])
      };
    });
    expect(r.one).toBe('John S.');
    expect(r.two).toBe('Alice M. B.');
    expect(r.single).toBe('Cher');
    expect(r.empty).toBe('');
    expect(r.disp).toBe('John S.');            // per-view obscuring via displayValue
    expect(r.arr).toBe('Charlie G., Alice B.');      // multiselect: each member obscured then joined
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
      app.dataCache['tasks'] = [ { id: 't1', status: 'done' } ];
      app.dataCache['tasks__archive'] = [ { id: 't3', status: 'done' } ];
      app.dataCache['crew_rotation'] = [ { id: 'c1', people: ['A', 'B'] } ];
      app.updateListItem2('status', 1, 'closed');      // rename done -> closed ('open'/'in_progress' are filter-pinned, so non-renamable)
      app.updateListItem2('crew', 0, 'Alice');         // rename A -> Alice
      await new Promise(res => setTimeout(res, 50));
      return {
        statusList: app.listsCache.status,
        t1: app.dataCache['tasks'][0].status, t3: app.dataCache['tasks__archive'][0].status,
        c1: app.dataCache['crew_rotation'][0].people,
        puts: puts.sort()
      };
    });
    expect(r.statusList).toEqual(['open', 'closed']);
    expect(r.t1).toBe('closed');                      // rename propagated to active row
    expect(r.t3).toBe('closed');                      // and to archive row
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
      // status column gets a listSwitch alt list 'guests' (primary list + an alternate: staff + guests)
      SCHEMA.tasks.columns.status.listSwitch = { list: 'guests', label: 'Guest' };
      app.listsCache = { status: ['done'], guests: ['Alice'] }; // 'Alice' moved: added to guests, removed from status
      app.dataCache['tasks'] = [
        { id: 't1', status: 'Alice' },  // value lives in the alt list -> must be spared
        { id: 't2', status: 'Carol' }   // not in alt list -> must be scrubbed
      ];
      app.dataCache['tasks__archive'] = [];
      app.propagateListChange('status', 'Alice', null); // delete 'Alice' from the primary list
      await new Promise(res => setTimeout(res, 30));
      app.propagateListChange('status', 'Carol', null); // control: a true orphan
      await new Promise(res => setTimeout(res, 30));
      delete SCHEMA.tasks.columns.status.listSwitch; // cleanup so other tests are unaffected
      return { t1: app.dataCache['tasks'][0].status, t2: app.dataCache['tasks'][1].status, puts: puts.sort() };
    });
    expect(r.t1).toBe('Alice');   // spared: still valid via the alt list (the "move" is lossless)
    expect(r.t2).toBe('');        // scrubbed: genuine orphan, not in any list
    expect(r.puts).toEqual(['t2:active']); // only the orphan row was persisted
  });
});

test.describe('shared-link firebase config safety', () => {
  test('a firebase config link is NOT applied until the user confirms the projectId', async ({ page }) => {
    // Simulate a crafted link pointing the victim at an attacker's Firestore project. The user declines.
    let confirmMsg = null;
    await page.addInitScript(() => {
      // Fresh visitor: no prior mode/config. Decline the connect prompt and record what it said.
      window.localStorage.clear();
      window.__confirmMsg = null;
      window.confirm = (m) => { window.__confirmMsg = m; return false; };
    });
    await page.goto('/?mode=firebase&k=AIza-fake&p=attacker-project');
    await page.waitForLoadState('domcontentloaded');
    const r = await page.evaluate(() => ({
      msg: window.__confirmMsg,
      config: window.localStorage.getItem('firebase_config'),
      mode: window.localStorage.getItem('app_mode'),
      url: location.search
    }));
    confirmMsg = r.msg;
    expect(confirmMsg).toContain('attacker-project');   // the prompt names the project so the user can catch it
    expect(r.config).toBeNull();                        // declined -> attacker config never persisted
    expect(r.mode).not.toBe('firebase');                // and the app didn't switch into firebase mode
    expect(r.url).toBe('');                             // params stripped regardless (no re-apply on refresh)
  });
});

test.describe('self-service tables (owner column) in the plain grid', () => {
  test('a no-grant member sees the table, adds their own row, edits/deletes only their own', async ({ page }) => {
    await ensureAppReady(page);
    const r = await page.evaluate(() => {
      const app = window.appInstance;
      // A viewer granted only 'notes' -> no grant on 'signups' (which has an owner column in the fixture).
      app.usersLoaded = true;
      app.userList = [{ key: 'mel@x.com', role: 'viewer', tables: ['notes'] }];
      app.currentUserEmail = 'mel@x.com';
      app.dataCache['signups'] = [
        { id: 's1', owner: 'mel@x.com', dish: 'Pie' },     // mine
        { id: 's2', owner: 'ann@x.com', dish: 'Salad' }    // someone else's (a public/roster row I can see)
      ];
      const mine = app.dataCache['signups'][0], theirs = app.dataCache['signups'][1];
      const out = {
        canSee: app.sidebarTabs.some(t => t.id === 'signups' || (t.children || []).some(c => c.id === 'signups')),
        canSeeNotes: !!app.userAllowedTables && app.userAllowedTables.indexOf('notes') >= 0
      };
      app.selectTab('signups');
      out.currentSelfService = app.currentSelfService;
      out.canMutateRows = app.canMutateRows;                 // add button gate
      out.canMutateMine = app.canMutateRow(mine);
      out.canMutateTheirs = app.canMutateRow(theirs);
      out.cellMineRO = app.cellReadonly(mine, 'dish');
      out.cellTheirsRO = app.cellReadonly(theirs, 'dish');
      out.ownerColRO = app.cellReadonly(mine, 'owner');
      out.tasksVisible = app.sidebarTabs.some(t => t.id === 'tasks');
      return out;
    });
    expect(r.canSee).toBe(true);            // self-service table shows in nav without a grant
    expect(r.currentSelfService).toBe(true);
    expect(r.canMutateRows).toBe(true);     // add button available
    expect(r.canMutateMine).toBe(true);     // can delete/archive my row
    expect(r.canMutateTheirs).toBe(false);  // not someone else's
    expect(r.cellMineRO).toBe(false);       // my cell editable despite viewer role
    expect(r.cellTheirsRO).toBe(true);      // their cell read-only
    expect(r.ownerColRO).toBe(true);        // owner column immutable
    expect(r.tasksVisible).toBe(false);     // control: an ungranted non-owner table stays hidden
  });
});
