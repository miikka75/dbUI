// deploy-config.test.js — Drift guards between firebase.json and the Cloud Function source.
// The function's region is READ from firebase.json's /csp-report rewrite at deploy analysis
// (functions/index.js rewriteRegion()), so firebase.json is the single source of truth; the
// in-source fallback literal only exists for the packaged container where firebase.json isn't
// present (inert at runtime). Keep the fallback aligned anyway so nobody is misled by a stale value.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

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
  it('the GitHub Pages prune refuses the same bundles as the hosting ignore list', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');
    for (const p of ['drive-sync-export-*.json', '*-import.json', '*-export.json']) {
      assert.ok(wf.includes(p), `deploy-pages.yml does not prune ${p} — Pages would publish it`);
    }
  });
});
