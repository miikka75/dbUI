// PROTOTYPE — does Chromium's PWA manifest install-icon downloader accept a CROSS-ORIGIN http(s) URL?
//
// Background: data: and blob: manifest icons both logged "Icon ... failed to load" because the
// install-icon fetch runs in the browser process and can't resolve renderer-minted URLs. A real
// network URL (the bundled ./icon-512.png) worked. Open question: does a real network URL on a
// DIFFERENT ORIGIN also work? If yes, a schema-defined absolute https URL can drive per-database
// install icons with no app server (Firebase = DB only).
//
// Method: stand up a 2nd static server on another port (different host:port = genuine cross-origin),
// serve the existing PNGs, swap the runtime manifest to point its icons at that cross-origin URL,
// then capture the console + Chromium's own manifest parser. No internet dependency, no TLS needed
// (both ends are localhost => "potentially trustworthy", so no mixed-content block).

const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEV_DIR = path.join(__dirname, '..');
const PNG192 = fs.readFileSync(path.join(DEV_DIR, 'icon-192.png'));
const PNG512 = fs.readFileSync(path.join(DEV_DIR, 'icon-512.png'));

let server, ORIGIN;
const hits = [];   // records every request the cross-origin server receives (proves the browser fetched it)

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (buf) => { res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(buf); };
    if (req.url.startsWith('/icon-192.png')) return send(PNG192);
    if (req.url.startsWith('/icon-512.png')) return send(PNG512);
    res.writeHead(404); res.end('nope');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));   // port 0 => OS-assigned free port
  const port = server.address().port;
  ORIGIN = `http://127.0.0.1:${port}`;   // page is http://localhost:3000 => different host AND port => cross-origin
});

test.afterAll(async () => { if (server) await new Promise(r => server.close(r)); });

test.describe('PWA schema-driven cross-origin icons', () => {
  test('schema.icons points favicon + apple-touch + manifest at a cross-origin host', async ({ page }) => {
    test.setTimeout(30000);

    const allConsole = [];
    page.on('console', m => allConsole.push(m.text()));
    page.on('pageerror', e => allConsole.push('pageerror: ' + String(e)));

    // Drive the REAL app with schema-driven cross-origin icon URLs (the feature). The app registers a
    // real service worker; Chromium auto-runs the installability pipeline (the only thing that actually
    // DOWNLOADS the manifest install icon — proven because this same harness logged "Icon ... failed to
    // load" for data:/blob:). schema.icons points favicon + apple-touch + manifest at the cross-origin
    // server so we exercise the real per-database path end to end.
    const S = {
      defaultLanguage: 'en',
      icons: {
        favicon: ORIGIN + '/icon-512.png',
        appleTouch: ORIGIN + '/icon-512.png',
        png512: ORIGIN + '/icon-512.png'
      },
      tables: { a: { columns: [{ name: 'x' }] } },
      views: [{ name: 'va', sources: ['a'], columns: ['x'] }],
      nav: { layout: 'drawer', items: [{ view: 'va' }] }
    };
    await page.request.post('/api/resetData');
    await page.request.post('/api/saveSchema', { data: { schema: S } });
    await page.request.post('/api/initSchema', { data: { schema: S.tables } });
    await page.addInitScript(() => {
      localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
    });
    await page.goto('/');
    await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 10000 });

    // Wait until the app's runtime manifest actually carries the cross-origin icons.
    await page.waitForFunction(async (origin) => {
      try {
        const link = document.querySelector('link[rel=manifest]');
        const m = JSON.parse(await (await fetch(link.href)).text());
        return (m.icons || []).length >= 1 && m.icons.every(i => i.src.startsWith(origin));
      } catch (e) { return false; }
    }, ORIGIN, { timeout: 8000 });

    // The schema-driven <link> icons reflect the cross-origin URLs too.
    const links = await page.evaluate(() => ({
      fav: document.querySelector('link[rel="icon"]').getAttribute('href'),
      apple: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href')
    }));
    expect(links.fav).toBe(ORIGIN + '/icon-512.png');
    expect(links.apple).toBe(ORIGIN + '/icon-512.png');

    hits.length = 0;   // count only the no-CORS image fetch below

    const client = await page.context().newCDPSession(page);

    // DECISIVE PROXY: the manifest install-icon downloader fetches icons as NO-CORS images. An <img>
    // load uses that exact fetch mode (unlike fetch(), which is CORS-governed and failed earlier).
    // If the browser loads + decodes the cross-origin PNG via <img>, the manifest downloader will too.
    const img = await page.evaluate((url) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = (e) => resolve({ ok: false, err: String(e && e.type || 'error') });
      im.src = url + '?img';   // cache-bust so it always hits the server
    }), `${ORIGIN}/icon-512.png`);

    // Chromium's own manifest parser: dump icons it resolved + any errors it reports.
    const appMan = await client.send('Page.getAppManifest');
    await page.waitForTimeout(300);

    const parsedIcons = (() => { try { return JSON.parse(appMan.data).icons; } catch (e) { return null; } })();
    const manErrors = appMan.errors || [];
    const iconConsoleErrors = allConsole.filter(t => /icon.*failed to load/i.test(t) || /square icon/i.test(t));

    console.log('--- X-ORIGIN ICON PROTOTYPE RESULT ---');
    console.log('cross-origin:', ORIGIN, '(page origin: http://localhost:3000)');
    console.log('manifest url:', appMan.url);
    console.log('parsed icons:', JSON.stringify(parsedIcons));
    console.log('manifest parser errors:', JSON.stringify(manErrors));
    console.log('cross-origin <img> no-CORS load:', JSON.stringify(img));
    console.log('cross-origin server hits:', JSON.stringify(hits));
    console.log('icon "failed to load" console errors:', JSON.stringify(iconConsoleErrors));
    console.log('NOTE: headless Chromium does not run the desktop install-icon download; verify the');
    console.log('      install affordance in real Chrome DevTools as the final confirmation.');
    console.log('--------------------------------------');

    // 1) App's runtime manifest carries both CROSS-ORIGIN icon entries, parsed cleanly by Chromium.
    expect(parsedIcons && parsedIcons.length).toBe(1);
    expect(parsedIcons.every(i => i.src.startsWith(ORIGIN))).toBe(true);
    // 2) No critical manifest parser errors.
    expect(manErrors.filter(e => e.critical)).toEqual([]);
    // 3) DECISIVE: the browser fetched the cross-origin PNG via the no-CORS image path and decoded it
    //    (512x512) — the same fetch mode the manifest install-icon downloader uses.
    expect(img.ok).toBe(true);
    expect(img.w).toBe(512);
    expect(hits.some(u => /icon-512\.png/.test(u))).toBe(true);
  });
});
