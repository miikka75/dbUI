// test-site.js — build the published folder (scripts/build-site.js) and boot it from a plain static
// server: the setup screen, then the in-browser Postgres. Fails on any same-origin request the site
// cannot answer, so the allowlist can never leave out a file the app loads. Needs vendor/ (CI's e2e job).
//   npm run test:site
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('@playwright/test');
const Site = require('../scripts/build-site');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dbui-site-'));
Site.build(ROOT, OUT, { minify: true });   // as the deploys build it
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.sql': 'text/plain', '.rules': 'text/plain' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(OUT, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

async function boot(browser, base, label, init, ready, timeout) {
  const page = await browser.newPage(), failures = [];
  page.on('response', (r) => { if (r.url().startsWith(base) && r.status() >= 400 && !r.url().includes('/api/')) failures.push(label + ': ' + r.status() + ' ' + r.url().slice(base.length)); });
  page.on('pageerror', (e) => failures.push(label + ': ' + String(e)));
  if (init) await page.addInitScript(init);
  await page.goto(base + '/');
  await page.waitForFunction(ready, null, { timeout }).catch(() => failures.push(label + ': never got ready'));
  await page.close();
  return failures;
}

server.listen(0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const failures = []
    .concat(await boot(browser, base, 'setup', null, () => window.appInstance && window.appInstance.showSetup === true, 15000))
    .concat(await boot(browser, base, 'pglite',
      () => { localStorage.setItem('app_mode', 'pglite'); localStorage.setItem('pglite_user', 'me@example.test'); },
      () => window.appInstance && !window.appInstance.loading && !!window.backend, 60000));
  await browser.close();
  server.close();
  fs.rmSync(OUT, { recursive: true, force: true });
  if (failures.length) { console.error('✗ the published site:\n  ' + failures.join('\n  ')); process.exit(1); }
  console.log('✓ the published site boots (setup screen, in-browser Postgres)');
});
