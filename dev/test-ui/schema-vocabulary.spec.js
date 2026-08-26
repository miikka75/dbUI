// The column vocabulary, as the APP sees it.
//
// `Columns.vocabularyErrors` is unit-tested as a pure function (dev/test/schema-vocabulary.test.js).
// What that cannot show is the half that made the check worth adding: the app loads a schema with a
// mistyped column and carries on as if nothing were wrong, because nothing IS wrong as far as any
// other layer can tell — the column renders, the rows save, and only the dropdown is missing.
//
// So this boots the real app on such a schema and asserts both halves at once: the table still works,
// and validateSchema names the mistake anyway.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

// One mistyped type and one mistyped property, on a table the app opens.
function schemaWithTypos() {
  const s = JSON.parse(JSON.stringify(SCHEMA));
  s.tables.notes.columns = s.tables.notes.columns.map((c) => {
    if (c.name === 'author') return Object.assign({}, c, { type: 'slect' });     // 'select'
    if (c.name === 'title') return Object.assign({}, c, { allowNews: true });    // 'allowNew'
    return c;
  });
  return s;
}

test('a mistyped column type and property are reported, though the app works either way', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: schemaWithTypos() } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tab.notes' }).first().click();
  await page.waitForSelector('button:has(.mdi-plus)', { timeout: 6000 });

  // The app is fine. That is the finding, not an aside: `columnType` falls back to 'text' and an
  // unread key is a no-op, so a broken schema is indistinguishable from a working one by looking.
  await page.locator('button:has(.mdi-plus)').click();
  await expect(page.locator('.v-table tbody tr')).toHaveCount(1);

  const errors = await page.evaluate(() => validateSchema());
  expect(errors.join('\n')).toContain('column "author" has unknown type "slect"');
  expect(errors.join('\n')).toContain('column "title" has unknown property "allowNews"');
});

test('the shipped fixture schema reports nothing', async ({ page }) => {
  // A check that fires on a valid schema is worse than no check: it teaches everyone to ignore the
  // banner. The unit suite asserts this over every schema in the repo; this asserts it through the
  // browser's own load path, migrations and implicit `id` column included.
  test.setTimeout(60000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  const errors = await page.evaluate(() => validateSchema());
  expect(errors.filter((e) => /unknown (type|property)/.test(e))).toEqual([]);
});
