// example-schemas.spec.js — boot the app against the schemas people actually write.
//
// Every other UI suite builds its own fixture, and fixtures are written by whoever is testing the
// feature — so they contain the shapes that feature needed and nothing else. The schemas in examples/
// are the opposite: real ones, with combinations nobody would think to construct on purpose.
//
// That difference is not theoretical. A view sharing its name with the table it sources made
// _viewTables return NOTHING, so the view loaded no tables and rendered empty. It survived six merges
// with the whole suite green, because no fixture had the collision and examples/bishopric-schema.json
// has it SEVEN times. It was found by booting that schema by hand.
//
// So this walks each example schema's entire navigation and asserts, for every view:
//   - it knows which tables it needs, and they are loaded;
//   - the page produces no console or page errors;
//   - the schema came forward to the current version on the way in.
//
// It deliberately does NOT assert row counts or rendered text: the point is to exercise unusual
// SHAPES, and pinning content here would make the suite fail whenever someone edits an example.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const EX_DIR = path.join(__dirname, '..', '..', 'examples');
const FILES = fs.existsSync(EX_DIR)
  ? fs.readdirSync(EX_DIR).filter((f) => f.endsWith('-schema.json')).sort()
  : [];

test('found example schemas to boot', () => {
  expect(FILES.length, 'no examples/*-schema.json — this suite would pass vacuously').toBeGreaterThan(0);
});

for (const file of FILES) {
  test.describe(file, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(EX_DIR, file), 'utf8'));
    const SCHEMA = raw.schema || raw;

    // What each view's `sources` say it reads, taken from the FILE. This is the independent truth the
    // walk below is checked against: asking _viewTables what a view needs and then confirming those
    // are loaded is circular -- when the derivation is broken it reports needing NOTHING, and "all of
    // nothing is loaded" passes. That is exactly how the first version of this suite went green with
    // the #116 fix removed.
    const DECLARED = {};
    (SCHEMA.views || []).forEach((v) => {
      if (v && v.name && Array.isArray(v.sources) && v.sources.length) {
        DECLARED[v.name] = v.sources.filter((t) => (SCHEMA.tables || {})[t]);
      }
    });

    let errs = [];
    test.beforeEach(({ page }) => {
      errs = [];
      page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon|Failed to load resource|\b404\b|net::ERR|ERR_/.test(m.text())) {
          errs.push('console: ' + m.text());
        }
      });
    });

    test('every navigable view loads the tables it needs', async ({ page }) => {
      test.setTimeout(120000);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.request.post('/api/resetData');
      await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
      if (raw.lists) await page.request.post('/api/saveLists', { data: { lists: raw.lists } });
      await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
      await page.goto('/');
      await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });

      // The migration chain ran on the way in — these are all pre-v3 schemas.
      const version = await page.evaluate(() => (appInstance.schemaData || {}).schemaVersion);
      expect(version, 'the schema did not come forward to the current version').toBe(
        await page.evaluate(() => window.Migrations.CURRENT_VERSION));

      const tabs = await page.evaluate(
        () => window.appInstance.sidebarTabs.filter((t) => !t.divider).map((t) => t.id));
      expect(tabs.length, 'no navigable views — the walk below would prove nothing').toBeGreaterThan(0);

      const short = [], undeclared = [], missedByDerivation = [];
      for (const id of tabs) {
        await page.evaluate((v) => window.appInstance.selectTab(v), id);
        // Wait for the view's own tables rather than a fixed delay: a view that never loads them is
        // exactly the failure being looked for, so let it time out and report instead of sleeping.
        await page.waitForFunction((v) => {
          const app = window.appInstance;
          return (app._viewTables(v) || []).every((t) => Array.isArray(app.dataCache[t]));
        }, id, { timeout: 8000 }).catch(() => {});
        const r = await page.evaluate((v) => {
          const app = window.appInstance;
          const needs = app._viewTables(v) || [];
          return { id: v, needs, missing: needs.filter((t) => !Array.isArray(app.dataCache[t])) };
        }, id);
        if (r.missing.length) short.push(r);

        // The independent check: whatever the derivation claims, a view that DECLARES sources must
        // have loaded them. This is what fails when _viewTables silently reports nothing.
        const declared = DECLARED[id] || [];
        if (declared.length) {
          const notLoaded = await page.evaluate(
            (d) => d.filter((t) => !Array.isArray(window.appInstance.dataCache[t])), declared);
          if (notLoaded.length) undeclared.push({ id, declared, notLoaded });
          const notDerived = await page.evaluate(
            (a) => a.d.filter((t) => !(window.appInstance._viewTables(a.v) || []).includes(t)),
            { v: id, d: declared });
          if (notDerived.length) missedByDerivation.push({ id, notDerived });
        }
      }
      expect(short, 'these views never loaded tables they say they need').toEqual([]);
      expect(undeclared, 'these views declare `sources` that were never loaded').toEqual([]);
      expect(missedByDerivation, '_viewTables does not report sources the schema declares').toEqual([]);
      expect(errs, 'console/page errors while walking the navigation').toEqual([]);
    });
  });
}
