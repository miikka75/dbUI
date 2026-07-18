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
