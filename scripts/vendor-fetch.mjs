#!/usr/bin/env node
// vendor-fetch.mjs — materialise vendor/ (the gitignored Vue/Vuetify/MDI/QR/PGlite dists) at the versions
// pinned in vendor/versions. This is the Firebase Hosting `predeploy` hook: `firebase deploy` uploads the
// working tree as it stands, and vendor/ is not in git, so without this a deploy after pulling a version
// bump would publish whatever an older ./update-vendor.sh run left behind.
//
// Node rather than bash because the hook runs on the deploying machine, which may be Windows (cmd.exe):
// Node is the one thing the Firebase CLI guarantees. Packages come from `npm pack`, so npm's registry,
// proxy and integrity checks apply, and the tarballs are unpacked here (no tar binary needed).
//
// Unlike ./update-vendor.sh it only WRITES vendor/, never a tracked file. It then checks that the SRI
// hashes the tracked files pin for the CDN fallbacks are the hashes of what it fetched, and fails the
// deploy when they are not: that means vendor/versions was changed without running ./update-vendor.sh.
//
// A no-op when vendor/.fetched already records the current vendor/versions (the dot file is outside the
// Hosting upload, like every dot file). Usage: node scripts/vendor-fetch.mjs [--force]
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const STAMP = path.join(VENDOR, '.fetched');

const versionsText = fs.readFileSync(path.join(VENDOR, 'versions'), 'utf8').replace(/\r\n/g, '\n').trim();
const V = Object.fromEntries(versionsText.split('\n').filter(Boolean).map((l) => l.split('=')));

// package -> [source path in the tarball (under package/), destination under vendor/]. Keep in step with
// update-vendor.sh, scripts/vendor-pglite.sh, deploy-pages.yml and the web SessionStart hook.
const PACKAGES = [
  { spec: `vue@${V.VUE}`, files: [['dist/vue.global.prod.js', 'vue.js']] },
  { spec: `vuetify@${V.VUETIFY}`, files: [['dist/vuetify.min.js', 'vuetify.js'], ['dist/vuetify.min.css', 'vuetify.css']] },
  { spec: `@mdi/font@${V.MDI}`, files: [['css/materialdesignicons.min.css', 'mdi.css'],
    ['fonts/materialdesignicons-webfont.woff2', 'fonts/materialdesignicons-webfont.woff2']] },
  { spec: `qrcode-generator@${V.QRCODE}`, files: [['qrcode.js', 'qrcode.js']] },
  // PGlite's ESM entry loads content-hashed chunks and three binaries relative to itself (see
  // scripts/vendor-pglite.sh), so the chunks are matched by pattern.
  { spec: `@electric-sql/pglite@${V.PGLITE}`, dir: 'pglite',
    files: [['dist/index.js', 'pglite/index.js'], [/^dist\/(chunk-[^/]+\.js)$/, 'pglite/$1'],
      ['dist/pglite.wasm', 'pglite/pglite.wasm'], ['dist/initdb.wasm', 'pglite/initdb.wasm'],
      ['dist/pglite.data', 'pglite/pglite.data']] },
];

// The CDN fallbacks' SRI pins, which must be the hashes of the files served from /vendor.
const SRI_PINS = [['vue.js', 'index.html'], ['vuetify.js', 'index.html'], ['qrcode.js', 'app-core.js']];

// Minimal tar reader: ustar entries, plus the pax ('x') and GNU ('L') long-name records npm can emit.
function untar(buf) {
  const out = new Map();
  let longName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8')); if (m) longName = m[1]; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    const prefix = str(345, 500);
    const name = longName || (prefix ? prefix + '/' + str(0, 100) : str(0, 100));
    longName = null;
    if (type === '0' || type === '\0') out.set(name.replace(/^[^/]+\//, ''), body);   // drop package/
  }
  return out;
}

const sha384 = (buf) => 'sha384-' + createHash('sha384').update(buf).digest('base64');

function checkSriPins() {
  const bad = SRI_PINS.filter(([file, pinnedIn]) =>
    !fs.readFileSync(path.join(ROOT, pinnedIn), 'utf8').includes(sha384(fs.readFileSync(path.join(VENDOR, file)))));
  if (bad.length) {
    throw new Error('the CDN fallback SRI hash for ' + bad.map(([f, p]) => `vendor/${f} (in ${p})`).join(', ') +
      ' does not match vendor/versions — run ./update-vendor.sh and commit the result before deploying');
  }
}

function main() {
  const force = process.argv.includes('--force');
  const present = PACKAGES.every((p) => p.files.every(([src, dest]) =>
    typeof src !== 'string' || fs.existsSync(path.join(VENDOR, dest))));
  if (!force && present && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8') === versionsText) {
    checkSriPins();
    console.log('vendor/ already matches vendor/versions.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-fetch-'));
  try {
    const specs = PACKAGES.map((p) => `"${p.spec}"`).join(' ');
    const packed = JSON.parse(execSync(`npm pack ${specs} --json --silent`, { cwd: tmp, encoding: 'utf8' }));
    fs.rmSync(STAMP, { force: true });
    PACKAGES.forEach((p, i) => {
      const entries = untar(gunzipSync(fs.readFileSync(path.join(tmp, packed[i].filename))));
      if (p.dir) fs.rmSync(path.join(VENDOR, p.dir), { recursive: true, force: true });   // drop old chunks
      for (const [src, dest] of p.files) {
        const hits = typeof src === 'string'
          ? (entries.has(src) ? [[src, dest]] : [])
          : [...entries.keys()].filter((k) => src.test(k)).map((k) => [k, k.replace(src, dest)]);
        if (!hits.length) throw new Error(`${p.spec} has no ${src} — its layout changed; update the copy lists`);
        for (const [from, to] of hits) {
          let data = entries.get(from);
          // The npm css sits in css/ and points at ../fonts/; flattened to vendor/mdi.css it needs ./fonts/.
          if (to === 'mdi.css') data = Buffer.from(data.toString('utf8').replaceAll('../fonts/', './fonts/'));
          fs.mkdirSync(path.dirname(path.join(VENDOR, to)), { recursive: true });
          fs.writeFileSync(path.join(VENDOR, to), data);
        }
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  checkSriPins();
  fs.writeFileSync(STAMP, versionsText);
  console.log(`✓ vendor/ — Vue ${V.VUE}, Vuetify ${V.VUETIFY}, MDI ${V.MDI}, qrcode-generator ${V.QRCODE}, PGlite ${V.PGLITE}`);
}

try {
  main();
} catch (e) {
  console.error('vendor-fetch: ' + e.message);
  process.exit(1);
}
