// examples-manifest.test.js — examples/index.json is GENERATED, and the app trusts it.
//
// It is the only thing the running app reads to know what the deployment ships, and its per-file
// hashes are what an installed database compares itself against to notice an update. A stale manifest
// therefore fails silently in the worst possible direction: the app keeps reporting "up to date"
// about files that have changed underneath it.
//
// So: regenerate it here and require the committed copy to match byte for byte. The generator is
// idempotent by construction (a bundle's revision only moves when one of its file hashes moves), so
// this passes exactly when someone remembered to run it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'examples');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
const Examples = require('../../examples');

describe('examples/index.json', () => {
  it('is what scripts/examples-manifest.js produces right now', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'examples-manifest.js'), '--check'],
      { cwd: ROOT, encoding: 'utf8' });
    assert.match(out, /is current/);
  });

  it('accounts for every JSON file in examples/ — a new example cannot go unlisted', () => {
    const listed = new Set();
    for (const l of MANIFEST.appLanguages) listed.add(l.file);
    for (const b of MANIFEST.bundles) {
      listed.add(b.schema.file);
      for (const l of b.languages) listed.add(l.file);
      if (b.data) listed.add(b.data.file);
    }
    const onDisk = fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && n !== 'index.json');
    assert.deepEqual(onDisk.filter((n) => !listed.has(n)).sort(), [], 'unlisted files in examples/');
    assert.deepEqual([...listed].filter((n) => !onDisk.includes(n)).sort(), [], 'manifest names files that do not exist');
  });

  it('every recorded hash matches the file it names', () => {
    const all = [].concat(MANIFEST.appLanguages);
    for (const b of MANIFEST.bundles) all.push(b.schema, ...b.languages, ...(b.data ? [b.data] : []));
    for (const f of all) {
      assert.equal(f.hash, Examples.hashText(fs.readFileSync(path.join(DIR, f.file), 'utf8')),
        f.file + ': recorded hash is stale');
    }
  });

  it('every bundle offers a schema, at least one language, and English among them', () => {
    assert.ok(MANIFEST.bundles.length >= 3, 'sanity: the repo ships three bundles');
    for (const b of MANIFEST.bundles) {
      assert.ok(b.schema && b.schema.file, b.id + ': no schema');
      assert.ok(b.languages.length, b.id + ': no language pack');
      assert.ok(b.languages.some((l) => l.code === 'en'), b.id + ': no English pack, so the picker has no title to show');
      assert.ok(b.title && b.title !== b.id, b.id + ": no app.title in its language pack, so the picker would show the raw id");
      assert.ok(b.description, b.id + ': no description — add one to DESCRIPTIONS in the generator');
      assert.ok(b.tables > 0 && b.views > 0, b.id + ': empty schema?');
    }
  });

  it('an icon, where declared, points at a file that ships', () => {
    for (const b of MANIFEST.bundles) {
      if (!b.icon) continue;
      // Schema icons are written relative to the deployment root ("./examples/x.svg"), because that is
      // what the browser resolves them against.
      assert.match(b.icon, /^\.\/examples\//, b.id + ': icon should be root-relative');
      assert.ok(fs.existsSync(path.join(ROOT, b.icon.replace(/^\.\//, ''))), b.id + ': icon file is missing');
    }
  });
});
