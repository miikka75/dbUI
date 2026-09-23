// sync-csp.js — regenerate every STATIC copy of the Content-Security-Policy from /csp.js.
//
// The policy is WRITTEN once (csp.js) and DELIVERED three ways, because the app is deployed three ways:
//
//   1. dev/server.js            — builds it at runtime and ENFORCES it when CSP=1 (the Playwright run).
//   2. firebase.json            — a static Report-Only header, for a Firebase Hosting deploy.
//   3. index.html <meta>        — for GITHUB PAGES, which serves static files and cannot send a custom
//                                 header at all. Without this the deployed site has no CSP in any mode,
//                                 which is exactly the state the 2026-09-22 review found it in.
//
// test/csp.test.js fails when any static copy drifts from the builder and tells you to regenerate —
// this is the tool it means. Run it after any edit to csp.js, and in particular after adding a
// self-hosted backend origin to CONNECT_HOSTS (SUPABASE.md).
//
//   npm run csp:sync
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Csp = require('../csp');

const ROOT = path.join(__dirname, '..');
const FIREBASE_JSON = path.join(ROOT, 'firebase.json');
const INDEX_HTML = path.join(ROOT, 'index.html');
const KEY = 'Content-Security-Policy-Report-Only';

// The <meta> is inserted immediately after <meta charset>, and that position is load-bearing twice
// over: a CSP in a <meta> governs only what is fetched AFTER the parser reaches it (the preload links
// a few lines below are fetches), and charset must stay in the document's first bytes for encoding
// detection. Between those two constraints there is exactly one correct spot.
const CHARSET = '<meta charset="UTF-8">';
const META_RE = /^[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/m;
// The collector URL the PAGE posts to (csp-client.js). Separate from the policy because a <meta>
// CSP cannot carry report-uri at all - see Csp.REPORT_ENDPOINT for why the page reports for itself.
const ENDPOINT_RE = /(<meta name="csp-report-endpoint" content=")([^"]*)(">)/;

const idx = fs.readFileSync(INDEX_HTML, 'utf8');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('base64');

// Hashes come from the inline <script> blocks, which inserting a <meta> does not touch — so there is
// no chicken-and-egg between the tag and the policy inside it.
const hashes = Csp.inlineScriptHashes(idx, sha256);
const headerPolicy = Csp.buildPolicy({ scriptHashes: hashes, reportUri: Csp.REPORT_URI });
const metaPolicy = Csp.buildPolicy({ scriptHashes: hashes, meta: true });

let changed = 0;

// --- 1. firebase.json's Report-Only header --------------------------------------------------------
{
  const raw = fs.readFileSync(FIREBASE_JSON, 'utf8');
  const header = (JSON.parse(raw).hosting.headers || []).flatMap((h) => h.headers || []).find((h) => h.key === KEY);
  if (!header) {
    console.error(`firebase.json carries no ${KEY} header — nothing to sync.`);
    process.exit(1);
  }
  if (header.value === headerPolicy) {
    console.log('firebase.json CSP is already up to date.');
  } else {
    // Replace just the header VALUE, so the file keeps its formatting — a JSON.parse/stringify
    // round-trip would reflow every unrelated line of firebase.json into one diff.
    fs.writeFileSync(FIREBASE_JSON, raw.replace(JSON.stringify(header.value), JSON.stringify(headerPolicy)));
    console.log('firebase.json CSP updated from csp.js.');
    changed++;
  }
}

// --- 2. index.html's <meta> delivery --------------------------------------------------------------
{
  // A double quote in the policy would break the attribute. Nothing buildPolicy emits contains one
  // (every source expression is single-quoted), but assert it rather than trust it: the failure mode
  // is a silently truncated policy, which looks like a working app with most of its rules missing.
  if (metaPolicy.includes('"')) {
    console.error('policy contains a double quote and cannot be written into an HTML attribute.');
    process.exit(1);
  }
  const tag = `  <meta http-equiv="Content-Security-Policy" content="${metaPolicy}">\n`;
  let out;
  if (META_RE.test(idx)) {
    out = idx.replace(META_RE, tag);
  } else {
    if (!idx.includes(CHARSET)) {
      console.error(`index.html has no ${CHARSET} to anchor the CSP meta tag to.`);
      process.exit(1);
    }
    out = idx.replace(CHARSET, CHARSET + '\n' + tag.replace(/\n$/, ''));
  }
  // --- 3. the report endpoint csp-client.js posts to ---------------------------------------------
  if (!ENDPOINT_RE.test(out)) {
    console.error('index.html has no <meta name="csp-report-endpoint"> to write the collector URL into.');
    process.exit(1);
  }
  if (Csp.REPORT_ENDPOINT.includes('"')) {
    console.error('REPORT_ENDPOINT contains a double quote and cannot be written into an HTML attribute.');
    process.exit(1);
  }
  out = out.replace(ENDPOINT_RE, (_m, a, _cur, c) => a + Csp.REPORT_ENDPOINT + c);

  if (out === idx) {
    console.log('index.html CSP meta + report endpoint are already up to date.');
  } else {
    fs.writeFileSync(INDEX_HTML, out);
    console.log('index.html CSP meta + report endpoint updated from csp.js'
      + (Csp.REPORT_ENDPOINT ? '.' : ' (reporting is OFF: Csp.REPORT_ENDPOINT is empty).'));
    changed++;
  }
}

process.exit(0);
