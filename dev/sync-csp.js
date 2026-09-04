// sync-csp.js — rewrite firebase.json's Content-Security-Policy-Report-Only header from /csp.js.
//
// The policy is WRITTEN once (csp.js) but DELIVERED twice: dev/server.js builds it at runtime for the
// E2E run, and Firebase Hosting sends a static copy out of firebase.json. test/csp.test.js fails when
// the two drift and tells you to regenerate — this is the tool it means. Run it after any edit to
// csp.js, and in particular after adding a self-hosted backend origin to CONNECT_HOSTS (SUPABASE.md).
//
//   npm run csp:sync
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Csp = require('../csp');

const ROOT = path.join(__dirname, '..');
const FIREBASE_JSON = path.join(ROOT, 'firebase.json');
const KEY = 'Content-Security-Policy-Report-Only';

const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const policy = Csp.buildPolicy({
  scriptHashes: Csp.inlineScriptHashes(idx, (s) => crypto.createHash('sha256').update(s).digest('base64')),
  reportUri: Csp.REPORT_URI
});

const raw = fs.readFileSync(FIREBASE_JSON, 'utf8');
const header = (JSON.parse(raw).hosting.headers || []).flatMap((h) => h.headers || []).find((h) => h.key === KEY);
if (!header) {
  console.error(`firebase.json carries no ${KEY} header — nothing to sync.`);
  process.exit(1);
}
if (header.value === policy) {
  console.log('firebase.json CSP is already up to date.');
  process.exit(0);
}

// Replace just the header VALUE, so the file keeps its formatting — a JSON.parse/stringify round-trip
// would reflow every unrelated line of firebase.json into one diff.
fs.writeFileSync(FIREBASE_JSON, raw.replace(JSON.stringify(header.value), JSON.stringify(policy)));
console.log('firebase.json CSP updated from csp.js.');
