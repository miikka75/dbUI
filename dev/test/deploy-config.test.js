// deploy-config.test.js — Drift guards between firebase.json and the Cloud Function source.
// The function's region is READ from firebase.json's /csp-report rewrite at deploy analysis
// (functions/index.js rewriteRegion()), so firebase.json is the single source of truth; the
// in-source fallback literal only exists for the packaged container where firebase.json isn't
// present (inert at runtime). Keep the fallback aligned anyway so nobody is misled by a stale value.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const crypto = require('node:crypto');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

describe('deploy config — function region', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const rewrite = (cfg.hosting.rewrites || []).find((x) => x.function && x.function.functionId === 'cspReport');

  it('the /csp-report rewrite names an explicit region (rewrites default to us-central1 otherwise)', () => {
    assert.ok(rewrite, 'firebase.json has the /csp-report rewrite');
    assert.ok(rewrite.function.region, 'rewrite declares a region');
  });

  it("functions/index.js fallback literal matches firebase.json's rewrite region", () => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    const m = /return '([a-z0-9-]+)';\s*\n\}/.exec(src.slice(src.indexOf('function rewriteRegion')));
    assert.ok(m, 'rewriteRegion() has a fallback literal');
    assert.equal(m[1], rewrite.function.region, 'update the fallback when the rewrite region changes');
  });
});

// Hosting serves the REPO ROOT ("public": "."), so the `ignore` list is the only thing standing
// between a file dropped in the working tree and a world-readable URL. A data export bundle carries
// the `tables` key -- actual rows -- so publishing one bypasses every rule in firestore.rules at once.
// Guard both that the exclusions are there and that they don't over-reach onto the JSON the app must
// actually be able to fetch at runtime.
describe('deploy config — what is published', () => {
  // Both publish paths upload _site/, which scripts/build-site.js fills from an allowlist. The old way was
  // two hand-kept denylists over the repo root, and whatever neither named shipped (ROADMAP.md,
  // functions/, the Edge Function source were all live).
  const Site = require(path.join(ROOT, 'scripts', 'build-site.js'));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');

  it('Firebase Hosting serves _site, built after vendor/ is fetched', () => {
    assert.equal(cfg.hosting.public, '_site');
    const hooks = [].concat(cfg.hosting.predeploy || []);
    assert.ok(hooks.indexOf('node scripts/build-site.js --with-config --compile --minify') > hooks.indexOf('node scripts/vendor-fetch.mjs'),
      'predeploy must fetch vendor/ and then build _site');
  });

  it('GitHub Pages uploads _site, built from the same list', () => {
    assert.match(wf, /run: node scripts\/build-site\.js --compile --minify/);
    assert.match(wf, /upload-pages-artifact@\S+\s+with:\s+path: _site/);
  });

  // A minifier or template-compile bug would ship unseen if CI tested the source; it tests what ships.
  it('CI runs the UI suites against the published build', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'node.js.yml'), 'utf8');
    assert.match(ci, /build-site\.js --compile --minify/);
    assert.match(ci, /run: npx playwright test\s+env:\s+STATIC_DIR: \.\.\/_site/);
  });

  // The published page has no in-browser compiler to fall back on: a template the build missed would be
  // compiled at runtime, which its policy refuses.
  it('the template build finds every registered component template, and every #id it names', () => {
    const { componentTemplates } = require(path.join(ROOT, 'scripts', 'compile-templates.js'));
    const found = componentTemplates(ROOT);
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    assert.equal(Object.keys(found).length, (src.match(/\n {2}app\.component\('[\w-]+', \{/g) || []).length, 'a registered component was not harvested');
    const ui = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
    for (const t of Object.values(found).filter((x) => x.charAt(0) === '#')) assert.ok(ui.includes('<template id="' + t.slice(1) + '"'), t + ' is not in ui.html');
  });

  const MUST_NOT_PUBLISH = [
    'ROADMAP.md', 'CLAUDE.md', 'README.md', 'examples/README.md', 'tsconfig.json', 'package.json', 'package-lock.json',
    'functions/index.js', 'supabase/functions/csp-report/index.ts', 'csp.js', 'storage.rules', 'firebase.json',
    '0001-some-fix.patch', 'update-vendor.sh', 'make-supabase-pr.bat', 'deploy.cmd', 'Setup.exe', 'tools/build.ps1',
    'scripts/migrate-schema-db.js', '.claude/settings.local.json', '.vscode/settings.json', '.env',
    'drive-sync-export-2026-07-31.json', 'english-schema-import.json', 'some-backup-export.json',
    'docs/features/rsvp.md', 'docs/screenshots/rsvp.png', 'dev/server.js', 'dev/local.db', 'firebase-debug.log',
    'firebase-config.json', 'supabase-config.json', 'stray.js'
  ];
  const MUST_PUBLISH = ['index.html', 'ui.html', 'style.html', 'app-core.js', 'databases.js', 'sw.js', 'manifest.json',
    'favicon.svg', 'icon-512.png', 'vendor/vue.js', 'vendor/pglite/pglite.wasm', 'examples/chores-schema.json',
    'examples/chores-favicon.svg', 'supabase-schema.sql', 'firestore.rules', 'schema.schema.json'];
  const INDEX = "<script>loadScript('/databases.js'); loadScriptsOrdered(['/app-core.js']); register('./sw.js');</script>";

  function buildFixture(opts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dbui-site-'));
    for (const f of MUST_NOT_PUBLISH.concat(MUST_PUBLISH)) {
      const full = path.join(root, ...f.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f === 'index.html' ? INDEX : f === 'sw.js' ? fs.readFileSync(path.join(ROOT, 'sw.js')) : 'x');
    }
    const out = path.join(root, '_site');
    const files = Site.build(root, out, opts);
    files.sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    fs.rmSync(root, { recursive: true, force: true });
    return files;
  }

  it('publishes the app and nothing else', () => {
    const files = buildFixture();
    assert.deepEqual(MUST_NOT_PUBLISH.filter((f) => files.includes(f)), [], 'these would be public');
    assert.deepEqual(MUST_PUBLISH.filter((f) => !files.includes(f)), [], 'the site needs these');
  });

  // The source sw.js does nothing (development); the published one caches under the build's revisions.
  it('the published service worker carries its revisions and a shell of published files', () => {
    const files = buildFixture();
    assert.doesNotMatch(files.sw, /'__(APP_REV|VENDOR_REV|SHELL)__'/);
    const shell = JSON.parse(/SHELL = (\[[^\]]*\])/.exec(files.sw)[1]);
    assert.ok(shell.includes('index.html') && shell.includes('app-core.js') && shell.includes('vendor/vue.js'), shell.join(', '));
    assert.deepEqual(shell.filter((f) => !files.includes(f)), [], 'the shell names files the site does not publish');
    assert.match(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), /var APP_REV = '__APP_REV__'/, 'the source sw.js must keep its placeholders');
  });

  it('a Firebase-hosted copy also ships its config files, so visitors connect without setup', () => {
    const files = buildFixture({ withConfig: true });
    assert.ok(files.includes('firebase-config.json') && files.includes('supabase-config.json'));
    assert.ok(!files.includes('ROADMAP.md'));
  });

  it('every script index.html loads is published, and exists', () => {
    const scripts = Site.scriptsOf(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
    const devOnly = ['dev-client.js', 'backend-local-client.js'];   // served by the dev server from dev/
    for (const s of scripts) {
      if (devOnly.includes(s)) continue;
      assert.ok(fs.existsSync(path.join(ROOT, s)), 'index.html loads /' + s + ', which does not exist');
      assert.ok(Site.isPublished(s, { scripts }), s + ' is loaded but not published');
    }
  });

  it('.gitignore refuses the data bundles too, so they never reach history', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const p of ['drive-sync-export-*.json', '*-import.json', '*-export.json', '/_site/']) {
      assert.ok(gi.includes(p), `.gitignore is missing ${p}`);
    }
  });
});

describe('deploy config — the browser-local Postgres backend', () => {
  const versions = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'vendor', 'versions'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => l.split('=')));

  // vendor/ is generated rather than committed, so a deploy has to MAKE the assets it serves. Missing
  // this step is not fatal -- the backend falls back to jsdelivr -- but it hands every visitor's boot to
  // a third party, which is the one thing this mode exists to avoid, and it does so silently.
  it('the Pages deploy materialises the vendored dists it does not commit', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
    assert.match(wf, /npm pack .*vue@/, 'deploy-pages.yml no longer materialises vendor/vue.js');
    assert.match(wf, /scripts\/vendor-pglite\.sh/, 'deploy-pages.yml no longer materialises vendor/pglite');
    assert.match(wf, /qrcode-generator@/, 'deploy-pages.yml no longer materialises vendor/qrcode.js');
  });

  // Firebase Hosting uploads the working tree, where vendor/ is whatever the last local run left, so the
  // predeploy hook is what brings it to vendor/versions. It runs on the deploying machine (Windows
  // included), hence a Node script rather than update-vendor.sh.
  it('the Firebase Hosting deploy materialises vendor/ first, with a script that runs on Windows', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const hooks = [].concat(cfg.hosting.predeploy || []);
    assert.ok(hooks.includes('node scripts/vendor-fetch.mjs'), 'firebase.json hosting.predeploy no longer runs vendor-fetch.mjs');
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'vendor-fetch.mjs')));
  });

  // Four places materialise vendor/ and they must agree, or the QR encoder is present in one
  // environment and absent in another -- where the label sheet silently prints Code 39 instead, which
  // looks like a design choice rather than a missing file.
  it('every path that materialises vendor/ knows about the QR encoder', () => {
    for (const f of [['update-vendor.sh'], ['.claude', 'hooks', 'session-start.sh'],
                     ['.github', 'workflows', 'deploy-pages.yml'], ['scripts', 'vendor-fetch.mjs']]) {
      const src = fs.readFileSync(path.join(ROOT, ...f), 'utf8');
      assert.match(src, /qrcode/, f.join('/') + ' does not materialise vendor/qrcode.js');
    }
  });

  // Same trap the PGlite pin has: bump vendor/versions by hand and the CDN fallback keeps naming the
  // old version, which is invisible until the day /vendor is missing -- and then the fallback serves a
  // DIFFERENT encoder than the SRI hash beside it was taken from, so it is blocked and no QR appears.
  it('the QR CDN fallback pins the version in vendor/versions', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const m = /cdn\.jsdelivr\.net\/npm\/qrcode-generator@([0-9.]+)\//.exec(src);
    assert.ok(m, 'app-core.js has no jsdelivr fallback URL for the QR encoder');
    assert.equal(m[1], versions.QRCODE, 'the CDN fallback and vendor/versions name different qrcode-generator versions');
  });

  // The fallback is only as good as its hash: an unpinned CDN script is a third party that can change
  // what it serves, which is the one thing loading from /vendor first exists to avoid.
  it('the QR CDN fallback is pinned by SRI, and the hash is the vendored file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const m = /qrcode-generator@[0-9.]+\/qrcode\.js', '(sha384-[A-Za-z0-9+/=]+)'/.exec(src);
    assert.ok(m, 'the QR CDN fallback carries no SRI hash');
    const file = path.join(ROOT, 'vendor', 'qrcode.js');
    if (!fs.existsSync(file)) return;      // vendor/ is generated; nothing to compare against here
    const want = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64');
    assert.equal(m[1], want, 'the SRI hash does not match vendor/qrcode.js — run ./update-vendor.sh');
  });

  // The fallback pins a version in backend-local-pglite.js, and a half-done bump (vendor/versions moved,
  // the URL not) is invisible until the day /vendor is missing -- at which point the fallback quietly
  // serves a DIFFERENT Postgres build than the one everything was tested against. update-vendor.sh
  // rewrites it; this is what notices when vendor/versions is edited by hand.
  it('the PGlite CDN fallback pins the version in vendor/versions', () => {
    const src = fs.readFileSync(path.join(ROOT, 'backend-local-pglite.js'), 'utf8');
    const m = /cdn\.jsdelivr\.net\/npm\/@electric-sql\/pglite@([0-9.]+)\//.exec(src);
    assert.ok(m, 'backend-local-pglite.js has no jsdelivr fallback URL to check');
    assert.equal(m[1], versions.PGLITE, 'the CDN fallback and vendor/versions name different PGlite versions');
  });

  // ...and the fallback only works if the policy lets that module fetch its OWN binaries. It pulls
  // pglite.wasm / pglite.data by URL relative to itself, which is connect-src, not script-src -- so
  // without this it loads and then dies fetching its engine.
  it('the CSP lets the PGlite CDN fallback fetch its wasm, not just execute its script', () => {
    const connect = /connect-src ([^;]+)/.exec(require('../../csp').buildPolicy({}));
    assert.ok(connect, 'no connect-src in the policy');
    assert.match(connect[1], /https:\/\/cdn\.jsdelivr\.net/,
      'jsdelivr is missing from connect-src — the fallback would load and then die fetching pglite.wasm');
  });
});

// --- Cache policy -------------------------------------------------------------------------------
// The app is a set of separately cached files that MUST come from the same deploy: index.html names
// the module list, ui.html holds the templates, and app-core.js holds the state those templates bind
// to. On Firebase's default `max-age=3600` each expires on its own clock, so for an hour after every
// deploy a returning visitor can hold a NEW template bound to an OLD instance -- which is not a
// subtle failure, it is `Cannot read properties of undefined` on the first render, and no amount of
// reloading fixes it because each file is individually still "fresh".
//
// `no-cache` does not mean "do not cache": it means revalidate, so the browser keeps the bytes and
// Hosting answers 304 when nothing changed. The cost is one conditional request per file per load;
// the thing it buys is that a mixed set cannot happen.
//
// vendor/** is deliberately NOT here. Those change only on a deliberate dependency bump, they are the
// large files, and they are consistent with each other by construction. If they ever do need this,
// the better fix is versioned paths, not revalidation of a megabyte.
describe('deploy config — cache policy', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));

  // Enough glob to read the patterns this config actually uses: a leading `**/`, `*` that does not
  // cross a slash, a trailing `**`, and `@(a|b)` alternation. Deliberately not a general matcher --
  // if someone writes a pattern this cannot read, the assertion below fails and says so.
  function matches(pattern, filePath) {
    let re = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '*' && pattern[i + 1] === '*') { re += (pattern[i + 2] === '/' ? '(?:.*/)?' : '.*'); i += (pattern[i + 2] === '/' ? 2 : 1); }
      else if (c === '*') re += '[^/]*';
      else if (c === '@' && pattern[i + 1] === '(') {
        const close = pattern.indexOf(')', i);
        re += '(?:' + pattern.slice(i + 2, close).split('|').map((x) => x.replace(/[.]/g, '[.]')).join('|') + ')';
        i = close;
      } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$').test(filePath);
  }

  const headerFor = (filePath, key) => (cfg.hosting.headers || [])
    .filter((h) => matches(h.source, filePath))
    .flatMap((h) => h.headers || [])
    .filter((h) => h.key === key)
    .map((h) => h.value)
    .pop();

  it('the matcher understands every pattern the config uses', () => {
    for (const h of cfg.hosting.headers || []) {
      assert.doesNotThrow(() => matches(h.source, 'probe'), 'unreadable pattern: ' + h.source);
    }
    // Sanity that it is not vacuously true.
    assert.ok(matches('**/*.html', 'index.html'));
    assert.ok(!matches('*.@(js|json)', 'vendor/vue.js'), 'a single * must not cross a slash');
  });

  // Every file whose CONTENT the running app depends on being the same generation as the others.
  const MUST_REVALIDATE = [
    'index.html',        // names the module list and carries the inline boot script
    'ui.html',           // the templates
    'style.html',
    'app-core.js',       // the state those templates bind to
    'columns.js', 'schema-normalize.js', 'examples.js', 'backend-firebase.js',
    'manifest.json',     // PWA identity, rewritten per database
    'sw.js',
    'firestore.rules',        // fetched and DISPLAYED by the setup dialog
    'supabase-schema.sql',    // fetched and APPLIED by the browser-local backend at boot
    'examples/index.json',    // what the picker reads, and what the update check compares against
    'examples/bishopric-schema.json'
  ];

  for (const file of MUST_REVALIDATE) {
    it(file + ' revalidates rather than sitting in a cache for an hour', () => {
      assert.equal(headerFor(file, 'Cache-Control'), 'no-cache',
        file + ' can go stale independently of the files it has to agree with');
    });
  }

  it('the HTML entry keeps its CSP — the cache header is added to it, not instead of it', () => {
    assert.ok(headerFor('index.html', 'Content-Security-Policy-Report-Only'));
  });

  it('leaves vendor/** alone, so a dependency bump is the only thing that pays for it', () => {
    assert.equal(headerFor('vendor/vue.js', 'Cache-Control'), undefined);
  });
});
