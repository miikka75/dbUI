// appearance.spec.js — Settings -> Appearance: one dialog per nav entry for how it is shown in menus (an
// icon, or an image on tiles and list rows) and what is behind its page (none, an icon drawn faint, an
// image). The overrides live in the synced folder config (appConfig.navAppearance / .backgrounds), apply
// through Nav.build, and nothing is written until Save. The background upload/fit/tombstone paths are
// covered in app.spec.js ("image/url column types"); this is what is new.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BROWSE = Object.assign({}, SCHEMA, { nav: { layout: 'browse', display: 'tiles', items: [
  { table: 'tasks', icon: 'mdi-check' },
  { table: 'notes', image: PNG },
  { group: 'Data', icon: 'mdi-database', items: [{ table: 'signups' }] },
] } });

async function boot(page, schema) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: schema || BROWSE } });
  await page.addInitScript(() => {
    localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
    localStorage.removeItem('app_nav_layout'); localStorage.removeItem('app_nav_display');
  });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading && !!appInstance.currentTable, null, { timeout: 8000 });
}
async function edit(page, id) {
  await page.evaluate(() => appInstance.selectTab('__settings'));
  const row = page.locator('[data-testid="appearance-row-' + id + '"]');
  if (!(await row.isVisible())) await page.locator('[data-testid="appearance-section-toggle"]').click();
  await row.click();
  await expect(page.locator('[data-testid="appearance-dialog"]')).toBeVisible();
}
const config = async (page) => (await (await page.request.post('/api/getFolderConfig', { data: {} })).json()) || {};
const save = (page) => page.locator('[data-testid="appearance-save"]').click();

test.describe('Settings -> Appearance', () => {
  test('lists every nav entry as a tree, groups included', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => appInstance.selectTab('__settings'));
    await page.locator('[data-testid="appearance-section-toggle"]').click();
    for (const id of ['tasks', 'notes', 'grp:Data', 'signups']) await expect(page.locator('[data-testid="appearance-row-' + id + '"]')).toBeVisible();
    await expect(page.locator('[data-testid="appearance-image-notes"]')).toBeVisible();   // the schema's image
  });

  test('a picked icon replaces the schema\'s everywhere; Cancel writes nothing', async ({ page }) => {
    await boot(page);
    await edit(page, 'tasks');
    await page.locator('[data-testid="menu-icon-search"] input').fill('star');
    await page.locator('[data-testid="menu-icon-mdi-star"]').click();
    await page.locator('[data-testid="appearance-cancel"]').click();
    expect((await config(page)).navAppearance).toBeUndefined();

    await edit(page, 'tasks');
    await page.locator('[data-testid="menu-icon-search"] input').fill('star');
    await page.locator('[data-testid="menu-icon-mdi-star"]').click();
    await save(page);
    await expect.poll(async () => ((await config(page)).navAppearance || {}).tasks).toEqual({ icon: 'mdi-star' });

    // Nav.build applied it: the tile on home and the breadcrumb's source both carry the new icon.
    await page.evaluate(() => appInstance.selectTab('__home'));
    await expect(page.locator('[data-testid="nav-level-item-tasks"] .mdi-star')).toBeVisible();
    await expect(page.locator('[data-testid="nav-level-item-tasks"] .mdi-check')).toHaveCount(0);
  });

  test('a menu image shows as a tile cover and a list thumbnail, and an upload is written only on Save', async ({ page }) => {
    await boot(page);
    // The schema's image, on a tile.
    await expect(page.locator('[data-testid="nav-tile-img-notes"]')).toBeVisible();

    await edit(page, 'tasks');
    await page.locator('[data-testid="appearance-menu-image"]').click();
    await page.locator('[data-testid="appearance-menu-file"]').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: Buffer.from(PNG.split(',')[1], 'base64') });
    await expect.poll(() => page.evaluate(() => !!appInstance.appearanceDraft.imageData)).toBe(true);
    const assets = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: '_assets', tab: 'active' } })).json()).rows || []).map((r) => r.id);
    expect(await assets()).not.toContain('tile_tasks');
    await save(page);
    await expect.poll(assets).toContain('tile_tasks');
    await expect.poll(async () => ((await config(page)).navAppearance || {}).tasks).toEqual({ image: 'asset:tile_tasks', focus: 'center' });

    await page.evaluate(() => appInstance.selectTab('__home'));
    await expect(page.locator('[data-testid="nav-tile-img-tasks"]')).toBeVisible();
    // List mode: the same image as the row's thumbnail.
    await page.evaluate(() => appInstance.setNavChoice('list'));
    await expect(page.locator('[data-testid="nav-level-item-tasks"] img.nav-row-img')).toBeVisible();
  });

  test('turning off a schema-declared image stores a tombstone; Schema default brings it back', async ({ page }) => {
    await boot(page);
    await edit(page, 'notes');
    await page.locator('[data-testid="appearance-menu-icon"]').click();
    await save(page);
    await expect.poll(async () => ((await config(page)).navAppearance || {}).notes).toEqual({ image: '' });
    await page.evaluate(() => appInstance.selectTab('__home'));
    await expect(page.locator('[data-testid="nav-tile-img-notes"]')).toHaveCount(0);

    await edit(page, 'notes');
    await page.locator('[data-testid="appearance-reset"]').click();
    await expect.poll(async () => ((await config(page)).navAppearance || {}).notes).toBeUndefined();
    await page.evaluate(() => appInstance.selectTab('__home'));
    await expect(page.locator('[data-testid="nav-tile-img-notes"]')).toBeVisible();
  });

  test('an icon background is drawn from the font, faint and in a corner, and follows the menu icon', async ({ page }) => {
    await boot(page);
    await edit(page, 'tasks');
    await page.locator('[data-testid="appearance-bg-icon"]').click();
    await save(page);
    await expect.poll(async () => ((await config(page)).backgrounds || {}).tasks)
      .toEqual({ image: 'icon:', fit: 'width', width: 25, position: 'bottom right', opacity: 0.08, fixed: false });

    await page.evaluate(() => appInstance.selectTab('tasks'));
    const styleOf = async () => (await page.locator('.v-main .v-card').first().getAttribute('style')) || '';
    await expect.poll(styleOf, { timeout: 8000 }).toContain('data:image/png;base64,');
    expect(await styleOf()).toContain('background-size: 25%');
    // Drawn, not blank: the canvas holds a glyph, so some pixels are opaque.
    const opaque = await page.evaluate(async () => {
      const src = appInstance.iconImage('mdi-check');
      const img = new Image(); await new Promise((r) => { img.onload = r; img.src = src; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    });
    expect(opaque).toBeGreaterThan(1000);
    // Bare `icon:` is the entry's own icon, so it follows a change of menu icon.
    const before = await page.evaluate(() => appInstance.backgroundSrc('tasks', 'icon:'));
    await page.evaluate(() => appInstance.iconImage('mdi-star'));
    await edit(page, 'tasks');
    await page.locator('[data-testid="menu-icon-search"] input').fill('star');
    await page.locator('[data-testid="menu-icon-mdi-star"]').click();
    await save(page);
    await expect.poll(() => page.evaluate(() => appInstance.backgroundSrc('tasks', 'icon:'))).not.toBe(before);
  });

  test('a group can have a background, painted behind its page', async ({ page }) => {
    await boot(page);
    await edit(page, 'grp:Data');
    await page.locator('[data-testid="appearance-bg-image"]').click();
    await page.locator('[data-testid="appearance-bg-url"] input').fill(PNG);
    await save(page);
    await expect.poll(async () => (((await config(page)).backgrounds || {})['grp:Data'] || {}).image).toBe(PNG);
    await page.evaluate(() => appInstance.selectTab('grp:Data'));
    await expect.poll(async () => (await page.locator('[data-testid="nav-level"]').getAttribute('style')) || '').toContain('background-image');
  });
});

test.describe('The Appearance dialog', () => {
  test('keeps one size whatever is chosen, and shows no icons until a search is typed', async ({ page }) => {
    await boot(page);
    await edit(page, 'tasks');
    const dialog = page.locator('[data-testid="appearance-dialog"]');
    const size = async () => { const b = await dialog.boundingBox(); return [Math.round(b.width), Math.round(b.height)]; };
    // Measured once the opening animation (a scale-in) has settled.
    await expect.poll(size).toEqual([620, 600]);
    const first = [620, 600];

    await expect(page.locator('[data-testid="menu-icon-current"] .mdi-check')).toBeVisible();   // the chosen icon, shown without a search
    await expect(page.locator('[data-testid^="menu-icon-mdi-"]')).toHaveCount(0);
    await page.locator('[data-testid="menu-icon-search"] input').fill('star');
    await expect(page.locator('[data-testid^="menu-icon-mdi-"]').first()).toBeVisible();
    await expect.poll(size).toEqual(first);

    await page.locator('[data-testid="appearance-bg-icon"]').click();
    await page.locator('[data-testid="appearance-bg-other"]').click();
    await expect.poll(size).toEqual(first);
    await page.locator('[data-testid="appearance-menu-image"]').click();
    await page.locator('[data-testid="appearance-bg-none"]').click();
    await expect.poll(size).toEqual(first);
  });

  test('search results are one row, and Menu and Background never move', async ({ page }) => {
    await boot(page);
    await edit(page, 'tasks');
    const top = async (id) => Math.round((await page.locator('[data-testid="' + id + '"]').boundingBox()).y);
    await expect.poll(() => top('appearance-bg-none')).toBeGreaterThan(0);
    await page.waitForTimeout(300);                                   // the opening animation
    const menuAt = await top('appearance-menu-icon'), bgAt = await top('appearance-bg-none');

    await page.locator('[data-testid="menu-icon-search"] input').fill('a');   // thousands of matches
    const results = page.locator('[data-testid="menu-icon-results"] button');
    await expect(results.first()).toBeVisible();
    const rows = await results.evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    expect(rows).toBe(1);
    expect(await top('appearance-bg-none')).toBe(bgAt);

    await page.locator('[data-testid="appearance-menu-image"]').click();
    expect(await top('appearance-bg-none')).toBe(bgAt);
    expect(await top('appearance-menu-icon')).toBe(menuAt);
  });
});

test.describe('Choosing Image with no picture yet', () => {
  test('keeps Save disabled and says what is missing, until a usable picture is set', async ({ page }) => {
    await boot(page);
    await edit(page, 'tasks');
    const saveBtn = page.locator('[data-testid="appearance-save"]');
    await expect(saveBtn).toBeEnabled();

    await page.locator('[data-testid="appearance-bg-image"]').click();
    await expect(saveBtn).toBeDisabled();
    await expect(page.locator('[data-testid="appearance-bg-need"]')).toBeVisible();

    await page.locator('[data-testid="appearance-bg-url"] input').fill('javascript:alert(1)');   // not an image address
    await expect(saveBtn).toBeDisabled();
    await page.locator('[data-testid="appearance-bg-url"] input').fill(PNG);
    await expect(saveBtn).toBeEnabled();
    await expect(page.locator('[data-testid="appearance-bg-need"]')).toHaveCount(0);

    // The same rule for the menu image, and a picked file satisfies it.
    await page.locator('[data-testid="appearance-menu-image"]').click();
    await expect(saveBtn).toBeDisabled();
    await expect(page.locator('[data-testid="appearance-menu-need"]')).toBeVisible();
    await page.locator('[data-testid="appearance-menu-file"]').setInputFiles({ name: 't.png', mimeType: 'image/png', buffer: Buffer.from(PNG.split(',')[1], 'base64') });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('[data-testid="appearance-dialog"]')).toHaveCount(0);
  });
});
