// csp.test.js — Drift guards for the Content-Security-Policy (see /csp.js for the policy rationale).
// Two things can silently rot: (1) the STATIC copy of the policy in firebase.json's Report-Only
// header vs the builder the dev server enforces in E2E, and (2) the inline-script hashes vs the
// actual inline blocks in index.html (an edited inline script with a stale hash = broken boot in
// production but only after the header is enforcing). Both fail HERE instead.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Csp = require('../../csp');

const ROOT = path.join(__dirname, '..', '..');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64');

function builtPolicy(opts) {
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return Csp.buildPolicy(Object.assign({ scriptHashes: Csp.inlineScriptHashes(idx, sha256) }, opts));
}

describe('Content-Security-Policy', () => {
  it('firebase.json Report-Only header matches the csp.js builder (no drift)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const hdr = (cfg.hosting.headers || []).flatMap(h => h.headers || [])
      .find(h => h.key === 'Content-Security-Policy-Report-Only');
    assert.ok(hdr, 'firebase.json carries a Content-Security-Policy-Report-Only header');
    assert.equal(hdr.value, builtPolicy(), 'regenerate firebase.json header from csp.js after editing either');
  });

  it('every inline <script> in index.html is hash-allowed (edits must re-sync firebase.json)', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const hashes = Csp.inlineScriptHashes(idx, sha256);
    assert.equal(hashes.length, 2, 'index.html has exactly the two known inline scripts (splash + boot)');
    for (const h of hashes) assert.ok(builtPolicy().includes(h), 'policy includes ' + h);
  });

  it('the meta variant drops header-only directives', () => {
    const meta = builtPolicy({ meta: true });
    assert.ok(!meta.includes('frame-ancestors'), 'frame-ancestors is invalid in a <meta> delivery');
    assert.ok(builtPolicy().includes('frame-ancestors'), 'header variant keeps frame-ancestors');
  });

  it('policy shape: no unsafe-inline scripts; eval + Vuetify styles are the accepted exceptions', () => {
    const p = builtPolicy();
    const script = p.split(';').find(d => d.trim().startsWith('script-src '));
    assert.ok(!script.includes("'unsafe-inline'"), "script-src must never carry 'unsafe-inline'");
    assert.ok(script.includes("'unsafe-eval'"), 'Vue in-browser template compiler needs unsafe-eval');
    const style = p.split(';').find(d => d.trim().startsWith('style-src '));
    assert.ok(style.includes("'unsafe-inline'"), 'Vuetify runtime style injection needs unsafe-inline styles');
  });
});
