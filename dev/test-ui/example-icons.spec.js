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
// The installed app's identity: the apple-touch <link> and the icon the runtime manifest declares.
const installIcons = (page) => page.evaluate(async () => {
  const apple = document.querySelector('link[rel="apple-touch-icon"]');
  const manLink = document.querySelector('link[rel=manifest]');
  const man = JSON.parse(await (await fetch(manLink.href)).text());
  return { apple: apple ? apple.getAttribute('href') : null, icons: man.icons };
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

test('the chores schema brands the INSTALLED app too, not just the tab', async ({ page }) => {
  // The bundled ./icon-512.png is the generic dbUI mark. A
  // schema that brands only its favicon still installs to the home screen under somebody else's mark,
  // which is the half of "per-database icons" that is invisible until someone installs it.
  test.setTimeout(90000);
  await bootWith(page, CHORES);
  const r = await installIcons(page);
  expect(r.apple).toBe('./examples/chores-icon-512.png');
  expect(r.icons.length).toBe(1);
  expect(r.icons[0].src, 'the manifest still installs the default icon').toMatch(/examples\/chores-icon-512\.png$/);

  // The manifest declares PNG, and a launcher that is handed an SVG here simply shows nothing.
  expect(r.icons[0].type).toBe('image/png');
  expect(r.icons[0].sizes).toBe('512x512');
  const res = await page.request.get('/examples/chores-icon-512.png');
  expect(res.status(), 'the manifest points at an install icon that is not served').toBe(200);
  expect(res.headers()['content-type']).toMatch(/image\/png/);

  // ...and it really is a 512x512 PNG, not an SVG or a smaller image with a confident `sizes`.
  // Chromium refuses to offer installation for a mismatched or non-square icon.
  const buf = await res.body();
  expect(buf.slice(1, 4).toString()).toBe('PNG');
  expect(buf.readUInt32BE(16)).toBe(512);
  expect(buf.readUInt32BE(20)).toBe(512);
});

test('the bishopric schema carries its own beehive, not the app default', async ({ page }) => {
  // The beehive used to BE the app default, so every other database installed itself under this
  // deployment's mark. It now travels with the schema it belongs to.
  test.setTimeout(90000);
  await bootWith(page, BISHOPRIC);
  expect(await iconHref(page)).toBe('./examples/bishopric-favicon.svg');
  const fav = await page.request.get('/examples/bishopric-favicon.svg');
  expect(fav.status(), 'bishopric points at a favicon that is not served').toBe(200);

  const r = await installIcons(page);
  expect(r.apple).toBe('./examples/bishopric-icon-512.png');
  expect(r.icons[0].src).toMatch(/examples\/bishopric-icon-512\.png$/);
  const png = await page.request.get('/examples/bishopric-icon-512.png');
  expect(png.status()).toBe(200);
  const buf = await png.body();
  expect(buf.slice(1, 4).toString()).toBe('PNG');
  expect(buf.readUInt32BE(16)).toBe(512);
});

test('a schema with NO icons gets the generic app default', async ({ page }) => {
  // The property that makes per-schema branding safe to add: a schema that says nothing must land on
  // the shipped icon rather than on nothing -- and that icon must now be GENERIC, since it is what
  // every unbranded database wears.
  test.setTimeout(90000);
  const PLAIN = {
    defaultLanguage: 'en',
    tables: { notes: { columns: [{ name: 'title', type: 'text' }] } },
    views: [{ table: 'notes' }],
    nav: { items: [{ table: 'notes' }] }
  };
  await bootWith(page, PLAIN);
  expect(await iconHref(page)).toBe('./favicon.svg');
  const r = await installIcons(page);
  expect(r.apple).toBe('./icon-512.png');
  expect(r.icons[0].src).toMatch(/\/icon-512\.png$/);
  expect(r.icons[0].src, 'the default now points into an example').not.toMatch(/examples\//);

  for (const p of ['/favicon.svg', '/icon-512.png']) {
    const res = await page.request.get(p);
    expect(res.status(), p + ' is the default and must be served').toBe(200);
  }
  // The default must not be one deployment's emblem. Checked by CONTENT, because the filenames never
  // changed -- the beehive WAS ./favicon.svg, so a path assertion could never have caught it.
  const dflt = await (await page.request.get('/favicon.svg')).text();
  const bishop = await (await page.request.get('/examples/bishopric-favicon.svg')).text();
  expect(dflt, 'the app default is byte-identical to a schema-specific icon').not.toBe(bishop);
});

test('switching databases re-points the icon rather than keeping the last one', async ({ page }) => {
  // The failure this guards is a branded tab surviving into a database that never asked for it: the
  // href is set on a <link> that persists across schema loads, so a missing field must RESET it.
  // Both directions, because branded->branded and branded->plain fail differently.
  test.setTimeout(150000);
  const PLAIN = {
    defaultLanguage: 'en',
    tables: { notes: { columns: [{ name: 'title', type: 'text' }] } },
    views: [{ table: 'notes' }],
    nav: { items: [{ table: 'notes' }] }
  };
  await bootWith(page, CHORES);
  expect(await iconHref(page)).toBe('./examples/chores-favicon.svg');

  await bootWith(page, BISHOPRIC);
  expect(await iconHref(page), 'one branded schema kept branding the next').toBe('./examples/bishopric-favicon.svg');

  await bootWith(page, PLAIN);
  expect(await iconHref(page), 'a branded schema kept branding a database that set no icons').toBe('./favicon.svg');
});
