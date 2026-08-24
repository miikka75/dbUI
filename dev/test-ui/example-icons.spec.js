// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');
const fs = require('node:fs');
const path = require('node:path');

// Per-database favicons, exercised against the REAL example schemas.
//
// Two things make this worth an end-to-end test rather than trusting the href:
//
//   1. `schema.icon` (singular) is VESTIGIAL -- app-core reads `schemaData.icons`, and app.spec.js
//      pins that a singular `icon` is ignored. A schema setting the wrong key silently gets the
//      default, which looks like "the feature does not work".
//   2. The suite's global console gate deliberately ignores favicon 404s, so a broken path is exactly
//      the kind of mistake the rest of the suite is blind to. Hence fetching the URL.
const EX = path.resolve(__dirname, '..', '..', 'examples');
const readSchema = (f) => {
  const doc = JSON.parse(fs.readFileSync(path.join(EX, f), 'utf8'));
  return doc.schema || doc;
};
const CHORES = readSchema('chores-schema.json');
const BISHOPRIC = readSchema('bishopric-schema.json');

async function bootWith(page, schema) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
const iconHref = (page) => page.evaluate(() => {
  const fav = document.querySelector('link[rel="icon"]');
  return fav ? fav.getAttribute('href') : null;
});

test('the chores schema brands its own tab, from a file in examples/', async ({ page }) => {
  test.setTimeout(90000);
  await bootWith(page, CHORES);
  expect(await iconHref(page)).toBe('./examples/chores-favicon.svg');

  // The href being right is not the same as the file being there, and a favicon 404 is silent both in
  // the browser chrome and in this suite's console gate.
  const res = await page.request.get('/examples/chores-favicon.svg');
  expect(res.status(), 'the schema points at a favicon that is not served').toBe(200);
  expect(res.headers()['content-type']).toMatch(/image\/svg/);

  const body = await res.text();
  expect(body).toMatch(/<svg[\s\S]*<\/svg>/);
  // Self-contained: a favicon that pulls in another origin would be blocked by the CSP and would also
  // make the tab icon depend on somebody else's uptime. `xmlns` is a namespace, not a fetch.
  expect(body.replace(/xmlns(:\w+)?="[^"]*"/g, '')).not.toMatch(/https?:\/\/|url\(|<image|<use\s/);
});

test('the bishopric schema keeps the bundled default', async ({ page }) => {
  // It declares no icons, and that has to resolve to the shipped favicon rather than to nothing --
  // which is what makes "one schema brands itself" safe to add without touching the other.
  test.setTimeout(90000);
  expect(BISHOPRIC.icons, 'this test is about a schema with NO icons').toBe(undefined);
  await bootWith(page, BISHOPRIC);
  expect(await iconHref(page)).toBe('./favicon.svg');
  const res = await page.request.get('/favicon.svg');
  expect(res.status()).toBe(200);
});

test('switching databases re-points the icon rather than keeping the last one', async ({ page }) => {
  // The failure this guards is a branded tab surviving into a database that never asked for it: the
  // href is set on a <link> that persists across schema loads, so a missing field must RESET it.
  test.setTimeout(120000);
  await bootWith(page, CHORES);
  expect(await iconHref(page)).toBe('./examples/chores-favicon.svg');
  await bootWith(page, BISHOPRIC);
  expect(await iconHref(page), 'the previous schema kept branding the tab').toBe('./favicon.svg');
});
