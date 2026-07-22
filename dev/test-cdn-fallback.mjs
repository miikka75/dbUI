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
const styleHtml = readFileSync(join(ROOT, 'style.html'), 'utf8');

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
// Un-pinned CSS fallbacks in style.html: <link href="<https url>" ...> (jsdelivr only — Google SDKs rotate).
const styles = [...styleHtml.matchAll(/href="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"/g)].map(m => ({ url: m[1] }));

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

for (const { url } of styles) {
  try {
    const buf = await fetchBuf(url);
    okmsg(`reachable: ${url}`);
    const vp = vendorPathFor(url);
    if (vp && existsSync(vp) && sri(readFileSync(vp)) !== sri(buf)) {
      fail(`committed ${vp.replace(ROOT + '/', '')} differs from the CDN copy (re-run update-vendor.sh)`);
    }
  } catch (e) { fail(`fetch failed for ${url}: ${e.message}`); }
}

if (failed) { console.error(`\n${failed} CDN-fallback check(s) failed.`); process.exit(1); }
console.log('\nAll CDN-fallback checks passed.');
