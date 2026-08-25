// CDN-fallback integrity check — runs in its OWN CI job (`cdn-fallback`), never in the offline suites.
//
// The app is self-hosted: index.html/style.html load Vue/Vuetify/MDI from the committed /vendor assets,
// so the functional UI + E2E suites need no network. The SRI-pinned CDN URLs in those files stay only as
// a runtime resilience fallback (used if /vendor is ever missing). This script is what guards that
// fallback so it can't silently rot: for every pinned URL it verifies the CDN still serves it (HTTP 200),
// and for the SRI-pinned scripts that the served bytes still hash to the pinned integrity — and, when the
// vendored copy is present, that the committed bytes are byte-identical to what the CDN serves and to the
// pin. A version bump that forgets to refresh the hash (or re-run update-vendor.sh) fails HERE, in a
// network-only job, instead of breaking a user whose /vendor fetch fell through to a stale-hashed CDN.
//
// Pure Node (global fetch + node:crypto) — no browser, no emulator. Exits non-zero on the first problem.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // repo root (dev/ -> ..)
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

// Map a CDN URL to the vendored file that mirrors it (so we can compare committed bytes), or null.
function vendorPathFor(url) {
  if (url.includes('/vue@') && url.endsWith('.js')) return join(ROOT, 'vendor', 'vue.js');
  if (url.includes('/vuetify@') && url.endsWith('.js')) return join(ROOT, 'vendor', 'vuetify.js');
  if (url.includes('/vuetify@') && url.endsWith('.css')) return join(ROOT, 'vendor', 'vuetify.css');
  if (url.includes('/@mdi/font@') && url.endsWith('.css')) return join(ROOT, 'vendor', 'mdi.css');
  return null;
}

const sri = buf => 'sha384-' + createHash('sha384').update(buf).digest('base64');

// SRI-pinned script fallbacks in index.html: loadScript('<https url>', '<sha384-...>').
const scripts = [...indexHtml.matchAll(/loadScript\('(https:\/\/[^']+)',\s*'(sha384-[^']+)'\)/g)]
  .map(m => ({ url: m[1], integrity: m[2] }));
// Un-pinned CSS fallbacks in index.html: loadStyle('/vendor/...', '<https jsdelivr url>')
// (jsdelivr only, no SRI — CSS @font-face rewrites the bytes, so a hash pin would be brittle).
const styles = [...indexHtml.matchAll(/loadStyle\('[^']+',\s*'(https:\/\/cdn\.jsdelivr\.net\/[^']+)'\)/g)]
  .map(m => ({ url: m[1] }));

if (!scripts.length) { console.error('✗ no SRI-pinned CDN scripts found in index.html — parser drift?'); process.exit(1); }

// Sanity: the URLs must reference the versions recorded in vendor/versions (catches a half-done bump).
const versions = Object.fromEntries(readFileSync(join(ROOT, 'vendor', 'versions'), 'utf8')
  .split('\n').filter(Boolean).map(l => l.split('=')));
const versionChecks = [
  ['vue@' + versions.VUE, 'VUE'], ['vuetify@' + versions.VUETIFY, 'VUETIFY'], ['@mdi/font@' + versions.MDI, 'MDI'],
];

let failed = 0;
const fail = msg => { console.error('✗ ' + msg); failed++; };
const okmsg = msg => console.log('✓ ' + msg);

async function fetchBuf(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

for (const [needle, key] of versionChecks) {
  const all = [...scripts, ...styles];
  if (all.some(s => s.url.includes(needle))) okmsg(`${key}=${versions[key]} referenced by a CDN URL`);
  else fail(`vendor/versions has ${key}=${versions[key]} but no CDN URL references ${needle} (bump drift?)`);
}

for (const { url, integrity } of scripts) {
  try {
    const buf = await fetchBuf(url);
    const got = sri(buf);
    if (got !== integrity) { fail(`SRI mismatch for ${url}\n    pinned: ${integrity}\n    actual: ${got}`); continue; }
    okmsg(`SRI ok: ${url}`);
    const vp = vendorPathFor(url);
    if (vp && existsSync(vp)) {
      const vsri = sri(readFileSync(vp));
      if (vsri !== integrity) fail(`committed ${vp.replace(ROOT + '/', '')} does not match the pin (re-run update-vendor.sh)`);
      else okmsg(`committed ${vp.replace(ROOT + '/', '')} matches the CDN + pin`);
    }
  } catch (e) { fail(`fetch failed for ${url}: ${e.message}`); }
}

// One vendored file is not a byte copy of the CDN's, by design: update-vendor.sh (and the CI hook)
// rewrite mdi.css's `../fonts/` to `./fonts/`, because we serve it flattened at /vendor/mdi.css where
// `../fonts/` would resolve to /fonts/ and 404 every glyph. Comparing raw bytes therefore reported a
// mismatch for a CORRECTLY vendored file and told you to re-run the script that had just produced it.
// It went unnoticed because CI has no vendor/ at all (it is generated, not committed), so the
// comparison was skipped there and only ever fired on a developer's populated tree. Apply the same
// rewrite before comparing.
const asVendored = (url, buf) => (url.includes('/@mdi/font@')
  ? Buffer.from(buf.toString('utf8').replace(/\.\.\/fonts\//g, './fonts/'))
  : buf);

for (const { url } of styles) {
  try {
    const buf = await fetchBuf(url);
    okmsg(`reachable: ${url}`);
    const vp = vendorPathFor(url);
    if (vp && existsSync(vp) && sri(readFileSync(vp)) !== sri(asVendored(url, buf))) {
      fail(`committed ${vp.replace(ROOT + '/', '')} differs from the CDN copy (re-run update-vendor.sh)`);
    }
  } catch (e) { fail(`fetch failed for ${url}: ${e.message}`); }
}

// The PGlite fallback, which lives in backend-local-pglite.js rather than index.html: it is a dynamic
// import() reached only when /vendor/pglite is missing, so nothing exercises it in the offline suites
// and rot here is invisible until the day it is needed. No SRI to verify -- the module fetches its own
// pglite.wasm / pglite.data relative to itself, so the bytes that matter never pass through a pin we
// control. What CAN be checked is that the URL still resolves and that its sibling binaries are there.
const pgSrc = readFileSync(join(ROOT, 'backend-local-pglite.js'), 'utf8');
const pgUrl = (/https:\/\/cdn\.jsdelivr\.net\/npm\/@electric-sql\/pglite@[0-9.]+\/dist\/index\.js/.exec(pgSrc) || [])[0];
if (!pgUrl) fail('backend-local-pglite.js has no PGlite CDN fallback URL — parser drift?');
else if (!pgUrl.includes('pglite@' + versions.PGLITE)) {
  fail(`PGlite fallback pins ${pgUrl} but vendor/versions says PGLITE=${versions.PGLITE}`);
} else {
  okmsg(`PGLITE=${versions.PGLITE} referenced by the fallback URL`);
  for (const u of [pgUrl, pgUrl.replace(/index\.js$/, 'pglite.wasm'), pgUrl.replace(/index\.js$/, 'pglite.data')]) {
    try { await fetchBuf(u); okmsg(`reachable: ${u}`); }
    catch (e) { fail(`fetch failed for ${u}: ${e.message}`); }
  }
}

if (failed) { console.error(`\n${failed} CDN-fallback check(s) failed.`); process.exit(1); }
console.log('\nAll CDN-fallback checks passed.');
