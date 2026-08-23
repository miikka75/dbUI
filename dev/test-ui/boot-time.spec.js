// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

// Measures app boot time AND attributes it to each phase, so blank-screen time can be
// quantified rather than guessed. All numbers are ms-since-navigation (performance.now()).
//
// TARGET: defaults to the local dev server ('/'). Override to point at any deployment:
//   BOOT_URL='https://myapp.example.com/?mode=firebase&k=...&p=...' npx playwright test test-ui/boot-time.spec.js
//
// Two data sources, used together:
//  (a) window.__bootPhases / window.__bootMs  — only present if the target runs the
//      INSTRUMENTED build (loadAppStart, fragmentsFetched, fragmentsApplied, vueLibsLoaded,
//      sdkLoaded, vueMounted, dataReady). Absent on un-instrumented deployments.
//  (b) Native browser timing — ALWAYS available: Navigation Timing (responseEnd,
//      domContentLoaded, load) + Paint Timing (first-paint, first-contentful-paint = when
//      pixels first hit the screen = end of blank time). This is what lets us baseline an
//      un-instrumented / un-authenticated deployment.
//
// NOTE on Firebase targets: the data-ready phase (__bootMs) requires a signed-in Google
// session, which headless Playwright cannot perform. Against Firebase you therefore measure
// up to the login screen (script load + SDK load + auth check + FP/FCP) — the pre-data
// portion of blank time. For real signed-in numbers, read window.__bootPhases from your own
// authenticated browser console on the deployed (instrumented) site.
const TARGET = process.env.BOOT_URL || '/';

test('boot time + phase breakdown reported', async ({ page }) => {
  test.setTimeout(60000);
  // Local target: seed the isolated in-memory fixture DB + set local mode so the app boots with data
  // (mirrors ensureAppReady). External BOOT_URL targets a deployed site — never seed there.
  if (TARGET === '/') {
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
    await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  }
  await page.goto(TARGET, { waitUntil: 'load' });

  // Best-effort: give the instrumented build time to flip loading=false. If __bootMs never
  // appears (un-instrumented or auth-gated), fall back to native timings after a short wait.
  await page.waitForFunction(() => window.__bootMs != null, null, { timeout: 12000 })
    .catch(() => {});
  // Let any post-load paint settle (login screen render, etc.).
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const paints = {};
    performance.getEntriesByType('paint').forEach(function(e) { paints[e.name] = e.startTime; });
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      phases: window.__bootPhases || {},
      bootMs: (typeof window.__bootMs === 'number') ? window.__bootMs : null,
      firstPaint: paints['first-paint'] || null,
      firstContentfulPaint: paints['first-contentful-paint'] || null,
      responseEnd: nav.responseEnd || null,
      domContentLoaded: nav.domContentLoadedEventEnd || null,
      loadEvent: nav.loadEventEnd || null,
      instrumented: !!(window.__bootPhases && Object.keys(window.__bootPhases).length),
    };
  });

  const timeline = [
    ['navResponseEnd', data.responseEnd],
    ['loadAppStart', data.phases.loadAppStart],
    ['fragmentsFetched', data.phases.fragmentsFetched],
    ['fragmentsApplied', data.phases.fragmentsApplied],
    ['domContentLoaded', data.domContentLoaded],
    ['firstPaint', data.firstPaint],
    ['firstContentfulPaint', data.firstContentfulPaint],
    ['vueLibsLoaded', data.phases.vueLibsLoaded],
    ['sdkLoaded', data.phases.sdkLoaded],
    ['vueMounted', data.phases.vueMounted],
    ['loadEvent', data.loadEvent],
    ['dataReady (loading=false)', data.bootMs],
  ].filter(function(r) { return r[1] != null; })
   .sort(function(a, b) { return a[1] - b[1]; });

  console.log('--- BOOT PHASE BREAKDOWN (ms since navigation) ---');
  console.log('target=' + TARGET);
  console.log('instrumented=' + data.instrumented + (data.bootMs == null ? '  (no __bootMs — un-instrumented or auth-gated; native timings only)' : ''));
  let prev = 0;
  timeline.forEach(function(r) {
    const at = Math.round(r[1]);
    const delta = Math.round(r[1] - prev);
    console.log(r[0].padEnd(28) + ' @' + String(at).padStart(6) + ' ms  (+' + delta + ')');
    prev = r[1];
  });
  console.log('--------------------------------------------------');
  if (data.bootMs != null) console.log('boot_ms=' + Math.round(data.bootMs));
  if (data.firstContentfulPaint != null) console.log('fcp_ms=' + Math.round(data.firstContentfulPaint));
  if (data.firstPaint != null) console.log('fp_ms=' + Math.round(data.firstPaint));
  console.log('--------------------------------------------------');

  // Budget assertion only when the instrumented data-ready marker exists (local runs).
  // For un-instrumented/external targets the test is a reporter, not a guard.
  if (data.bootMs != null) {
    expect(data.bootMs).toBeLessThan(15000);
  } else {
    // At minimum the page should have painted something.
    expect(data.firstPaint != null || data.firstContentfulPaint != null).toBeTruthy();
  }
});
