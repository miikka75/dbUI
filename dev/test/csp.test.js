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
    assert.equal(hdr.value, builtPolicy({ reportUri: Csp.REPORT_URI }), 'regenerate firebase.json header from csp.js after editing either');
  });

  it('reporting: production header posts to the collector; the dev/CI enforcing policy does not', () => {
    assert.ok(builtPolicy({ reportUri: Csp.REPORT_URI }).endsWith('report-uri ' + Csp.REPORT_URI));
    assert.ok(!builtPolicy().includes('report-uri'), 'CI/E2E enforcement must never post reports to the real collector');
  });

  it('every inline <script> in index.html is hash-allowed (edits must re-sync firebase.json)', () => {
    const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const hashes = Csp.inlineScriptHashes(idx, sha256);
    assert.equal(hashes.length, 2, 'index.html has exactly the two known inline scripts (splash + boot)');
    for (const h of hashes) assert.ok(builtPolicy().includes(h), 'policy includes ' + h);
  });

  it('extra connect origins (a self-hosted backend) reach connect-src and no other directive', () => {
    const hosts = ['https://db.example.org', 'wss://db.example.org'];
    const p = builtPolicy({ connect: hosts });
    const connect = p.split(';').find(d => d.trim().startsWith('connect-src '));
    for (const h of hosts) {
      assert.ok(connect.includes(h), 'connect-src carries ' + h);
      assert.equal(p.split(h).length - 1, 1, h + ' appears in exactly one directive');
    }
  });

  it('the meta variant drops header-only directives', () => {
    const meta = builtPolicy({ meta: true });
    assert.ok(!meta.includes('frame-ancestors'), 'frame-ancestors is invalid in a <meta> delivery');
    assert.ok(builtPolicy().includes('frame-ancestors'), 'header variant keeps frame-ancestors');
  });
});

// --- The <meta> delivery: the only one GitHub Pages can use ---------------------------------------
//
// The app is deployed by deploy-pages.yml, which uploads the repo root to GitHub Pages on every push
// to main. Pages serves static files and cannot send a custom header, so neither of the other two
// deliveries reaches it: dev/server.js is not involved, and firebase.json's header is read by Firebase
// Hosting alone. Until this tag existed the deployed site ran with NO CSP in any mode while a
// Report-Only header sat in firebase.json looking like coverage.
describe('Content-Security-Policy — the index.html <meta> delivery', () => {
  const idx = () => fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const metaTag = () => idx().match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);

  it('index.html carries a CSP meta tag', () => {
    assert.ok(metaTag(), 'index.html has a <meta http-equiv="Content-Security-Policy"> — GitHub Pages ' +
      'has no other way to deliver one. Run `npm run csp:sync` in dev/.');
  });

  it('the meta tag matches the csp.js builder (no drift)', () => {
    assert.equal(metaTag()[1], builtPolicy({ meta: true }),
      'regenerate index.html from csp.js with `npm run csp:sync`');
  });

  // POSITION IS LOAD-BEARING. A CSP in a <meta> governs only what the parser fetches AFTER it reads
  // the tag, so anything above it is unprotected. index.html starts fetching in <head>: five preload
  // links, a manifest and two icons. A tag that drifted below them would still pass the drift test
  // above while silently exempting every one of those.
  it('sits before the first fetch-initiating element in the document', () => {
    const src = idx();
    const metaAt = src.indexOf('<meta http-equiv="Content-Security-Policy"');
    const firstFetch = Math.min(...['<link ', '<script'].map((t) => {
      const i = src.indexOf(t);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    }));
    assert.ok(firstFetch < Number.MAX_SAFE_INTEGER, 'index.html fetches something (preloads/scripts)');
    assert.ok(metaAt > 0 && metaAt < firstFetch,
      'the CSP meta must precede every <link>/<script>: a meta CSP does not apply to anything the ' +
      'parser already fetched above it');
  });

  // charset has to stay in the document's first bytes for encoding detection, so the meta CSP goes
  // directly after it. Pinned because "move the CSP to the top of head" is a plausible tidy-up.
  it('does not displace <meta charset>', () => {
    const src = idx();
    assert.ok(src.indexOf('<meta charset=') < src.indexOf('<meta http-equiv="Content-Security-Policy"'),
      'charset must remain first for encoding detection');
  });

  it('carries the same inline-script hashes as the header delivery', () => {
    const tag = metaTag()[1];
    for (const h of Csp.inlineScriptHashes(idx(), sha256)) {
      assert.ok(tag.includes(h), 'the meta policy hash-allows inline script ' + h);
    }
  });

  // An HTML attribute is delimited by the double quote the regex above relies on. Every source
  // expression CSP defines is single-quoted, so this holds — but a policy that grew one would be
  // truncated at the quote and ship as a shorter, weaker, still-valid-looking policy.
  it('contains no double quote, which would truncate the attribute', () => {
    assert.ok(!builtPolicy({ meta: true }).includes('"'));
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
