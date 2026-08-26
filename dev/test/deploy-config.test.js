// deploy-config.test.js — Drift guards between firebase.json and the Cloud Function source.
// The function's region is READ from firebase.json's /csp-report rewrite at deploy analysis
// (functions/index.js rewriteRegion()), so firebase.json is the single source of truth; the
// in-source fallback literal only exists for the packaged container where firebase.json isn't
// present (inert at runtime). Keep the fallback aligned anyway so nobody is misled by a stale value.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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
describe('deploy config — hosting ignore list', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const ignore = cfg.hosting.ignore || [];

  // Minimal gitignore-flavoured glob: `**` spans separators, `*` doesn't, and a pattern with no `/`
  // matches the basename at any depth. Enough to answer "would firebase deploy skip this path".
  const matches = (pattern, filePath) => {
    const rx = pattern.split('**').map((seg) =>
      seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
    ).join('.*');
    const re = new RegExp('^' + rx + '$');
    return re.test(filePath) || (!pattern.includes('/') && re.test(path.basename(filePath)));
  };
  const isIgnored = (filePath) => ignore.some((p) => matches(p, filePath));

  it('hosting serves the repo root, which is what makes the ignore list load-bearing', () => {
    assert.equal(cfg.hosting.public, '.');
  });

  for (const f of [
    'drive-sync-export-2026-07-31.json',
    'drive-sync-export-2026-07-31 (1).json',
    'english-schema-import.json',
    'english-translations-import.json',
    'firebase-tehtavat-board-import.json',
    'some-backup-export.json'
  ]) {
    it(`excludes the data bundle ${f}`, () => {
      assert.ok(isIgnored(f), `${f} would be DEPLOYED PUBLICLY — add a pattern to firebase.json hosting.ignore`);
    });
  }

  // Executables are not merely unwanted here, they are REFUSED: Firebase Hosting rejects the whole
  // deploy on the Spark plan rather than skipping the file --
  //   "Executable files are forbidden on the Spark billing plan"
  // -- so a .bat left in the working tree fails the deploy of everything else with it. The list named
  // `update-vendor.sh` specifically, which covered the one that existed and nothing a contributor
  // might add next.
  for (const f of [
    'update-vendor.sh',
    'make-supabase-pr.bat',
    'split-supabase-commits.bat',
    'deploy.cmd',
    'Setup.exe',
    'tools/build.ps1',
    'scripts/migrate-schema-db.js'
  ]) {
    it(`excludes the executable/tooling file ${f}`, () => {
      assert.ok(isIgnored(f), `${f} would be sent to Hosting — on Spark that FAILS THE WHOLE DEPLOY`);
    });
  }

  // Dot-DIRECTORIES, which `**/.*` does not reach: it matches a path whose last segment starts with a
  // dot, and `.claude/settings.local.json` does not. Editor and tooling directories sitting in the repo
  // root were therefore being served -- local settings, caches, whatever a contributor's tooling keeps.
  for (const f of [
    '.claude/settings.local.json',
    '.claude/launch.json',
    '.firebase/hosting..cache',
    '.vscode/settings.json',
    'sub/.idea/workspace.xml'
  ]) {
    it(`excludes ${f} (inside a dot-directory)`, () => {
      assert.ok(isIgnored(f), `${f} would be served publicly — a dot-directory is not covered by "**/.*"`);
    });
  }

  // The mirror image: an over-broad "*.json" would silently break boot, since these are fetched at
  // runtime (index.html appUrl + initFirebase/initSupabase) rather than bundled.
  for (const f of ['manifest.json', 'firebase-config.json', 'supabase-config.json',
                   'app-core.js', 'sw.js', 'index.html', 'vendor/vue.js', 'icon-512.png']) {
    it(`still serves ${f} (the app fetches it at runtime)`, () => {
      assert.ok(!isIgnored(f), `${f} is fetched at boot and must stay deployable`);
    });
  }

  it('.gitignore refuses the same bundles, so they never reach history either', () => {
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const p of ['drive-sync-export-*.json', '*-import.json', '*-export.json']) {
      assert.ok(gi.includes(p), `.gitignore is missing ${p} (keep it in step with firebase.json)`);
    }
  });

  // There are TWO publish paths for the repo root — Firebase Hosting (firebase.json `ignore`) and
  // GitHub Pages (deploy-pages.yml's `rm -f` prune) — each with its own hand-maintained denylist and
  // no reference to the other. Excluding a file from one only moves the leak to the other.
  //
  // This checked three glob STRINGS and called it parity, which is how the two lists drifted: the
  // hosting side was hardened against executables and dot-directories while Pages -- which deploys on
  // every push to main -- kept publishing them. So both are now asked about the same FILES, and the
  // Pages side is answered by running its own prune over a copy of the repo rather than by reading it.
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');

  it('the GitHub Pages prune refuses the same bundles as the hosting ignore list', () => {
    for (const p of ['drive-sync-export-*.json', '*-import.json', '*-export.json']) {
      assert.ok(wf.includes(p), `deploy-pages.yml does not prune ${p} — Pages would publish it`);
    }
  });

  // The files both paths must refuse. Named once, asked of both, so hardening one cannot silently
  // leave the other open -- which is exactly what happened.
  const MUST_NOT_PUBLISH = [
    'make-supabase-pr.bat',
    'split-supabase-commits.bat',
    'update-vendor.sh',
    'deploy.cmd',
    'Setup.exe',
    'scripts/migrate-schema-db.js',
    '.claude/settings.local.json',
    '.vscode/settings.json',
    'drive-sync-export-2026-07-31.json',
    'some-backup-export.json'
  ];
  // What the site needs. An exclusion list that breaks boot is the other way to get this wrong.
  // supabase-schema.sql is here because the browser-local Postgres backend FETCHES it at boot and
  // applies it (storage-pglite.js). It used to be pruned by the Pages workflow as a "server-side" file,
  // which published an app whose "In this browser" mode 404s on its own access policy — a denylist
  // maintained by hand will eventually delete something the app needs, and this list is the other half.
  const MUST_PUBLISH = ['index.html', 'app-core.js', 'databases.js', 'sw.js', 'manifest.json', 'favicon.svg',
                        'icon-512.png', 'vendor/vue.js', 'examples/chores-schema.json',
                        'supabase-schema.sql', 'backend-kv.js', 'storage-pglite.js'];

  for (const f of MUST_NOT_PUBLISH) {
    it(`hosting ignores ${f}`, () => {
      assert.ok(isIgnored(f), `${f} would be served by Firebase Hosting`);
    });
  }
  for (const f of MUST_PUBLISH) {
    it(`hosting still serves ${f}`, () => {
      assert.ok(!isIgnored(f), `${f} is needed at runtime and must stay deployable`);
    });
  }

  it('the Pages prune removes every file the hosting ignore list refuses', () => {
    // Run the workflow's OWN prune commands against a throwaway tree containing each file. Reading the
    // YAML for substrings is what let `split-supabase-commits.bat` look like coverage while
    // `make-supabase-pr.bat`, added later and right next to it, shipped.
    const prune = (wf.match(/- name: Prune non-public files\r?\n\s+run: \|\r?\n([\s\S]*?)\r?\n\s+- name:/) || [])[1];
    assert.ok(prune && prune.includes('rm '), 'could not find the prune step — this test would pass vacuously');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbui-pages-'));
    for (const f of MUST_NOT_PUBLISH.concat(MUST_PUBLISH)) {
      const full = path.join(dir, f);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x');
    }
    const script = prune.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      .filter((l) => !l.startsWith('#')).join('\n');
    execFileSync('bash', ['-c', script], { cwd: dir, stdio: 'ignore' });

    const left = (f) => fs.existsSync(path.join(dir, f));
    const leaked = MUST_NOT_PUBLISH.filter(left);
    const missing = MUST_PUBLISH.filter((f) => !left(f));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(leaked, [], 'GitHub Pages would publish these');
    assert.deepEqual(missing, [], 'the Pages prune deleted files the site needs');
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
