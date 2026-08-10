// csp.js — THE Content-Security-Policy for the app, built in one place.
// Consumed by: dev/server.js (sends it ENFORCING on HTML when CSP=1 — the whole Playwright suite
// runs that way, so CI proves the policy doesn't break the app), dev/test/csp.test.js (asserts the
// static copy in firebase.json's Report-Only header never drifts from this builder), and — after
// the production Report-Only soak — the enforcing header / meta tag.
//
// Decisions behind the shape (see CODE_REVIEW.md S6):
//   - Modes: FIREBASE ONLY (plus same-origin local dev/emulators). Sheets-OAuth / Drive-CRDT modes
//     would need accounts.google.com + www.googleapis.com additions — add them if those modes ship.
//   - Multi-database: users connect one URL to ANY Firebase project, so Google origins are
//     wildcarded (*.googleapis.com, *.firebaseapp.com) rather than pinned to one project.
//   - img-src allows any https + data: — image cells / schema.icons accept arbitrary URLs by design.
//   - 'unsafe-eval' is required by Vue's in-browser template compiler (no build step). Inline
//     SCRIPTS are NOT allowed: the two static inline blocks in index.html are hash-allowed, and the
//     loader uses real <script src> elements (the execScript refactor was the prerequisite).
//   - 'unsafe-inline' styles are required by Vuetify's runtime style injection.
//   - Loopback http/ws entries keep the dev server + Firebase emulator modes working; they are
//     unreachable third parties for production visitors.
//   - Supabase mode (index.html -> /backend-supabase.js) talks to a per-project *.supabase.co host,
//     wildcarded for the same reason the Google origins are: one URL connects the app to ANY project.
//     wss: covers realtime if it is ever switched on. The SDK itself loads from jsdelivr, already in
//     script-src. Without these the Supabase backend fails the moment the header stops being
//     Report-Only — silently, since a blocked fetch looks like an empty database.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);

  // sha256 hashes (CSP 'sha256-…' form) of every INLINE <script> in index.html. Any edit to those
  // blocks changes the hash — the csp test fails in CI instead of the app silently failing in prod.
  function inlineScriptHashes(indexHtmlSource, sha256) {
    var out = [], re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, m;
    while ((m = re.exec(indexHtmlSource))) out.push("'sha256-" + sha256(m[1]) + "'");
    return out;
  }

  // Where browsers POST violation reports. RELATIVE: on Firebase Hosting the /csp-report rewrite
  // (firebase.json) routes it to the cspReport Cloud Function (functions/index.js) — same-origin,
  // no separate collector host or certificate. A deployment on a plain static host instead points
  // this at an absolute URL running dev/csp-report-collector.js (self-hosted alternative).
  // Used by the production Report-Only header ONLY: the dev/CI enforcing policy deliberately omits
  // it so test runs never post reports at the real collector. report-uri is deprecated-but-universal;
  // report-to can be added later via a Reporting-Endpoints header if wanted.
  var REPORT_URI = '/csp-report';

  // opts.scriptHashes: array from inlineScriptHashes; opts.meta: true strips header-only directives
  // (frame-ancestors, report-uri) for a <meta http-equiv> delivery (e.g. GitHub Pages);
  // opts.reportUri: append a report-uri directive (pass REPORT_URI for the production header).
  function buildPolicy(opts) {
    opts = opts || {};
    var d = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' " + (opts.scriptHashes || []).join(' ')
        + " https://www.gstatic.com https://apis.google.com https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' data: https://cdn.jsdelivr.net",
      "img-src 'self' https: data: blob: http://127.0.0.1:* http://localhost:*",
      "connect-src 'self' blob: https://*.googleapis.com https://*.supabase.co wss://*.supabase.co http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",   // blob: -> fetch of the runtime (Blob-URL) manifest
      "frame-src https://*.firebaseapp.com https://accounts.google.com",
      "manifest-src 'self' blob:",   // the runtime PWA manifest is a Blob URL
      "worker-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'"
    ];
    if (!opts.meta) d.push("frame-ancestors 'self'");
    if (!opts.meta && opts.reportUri) d.push('report-uri ' + opts.reportUri);
    return d.join('; ');
  }

  var M = { buildPolicy: buildPolicy, inlineScriptHashes: inlineScriptHashes, REPORT_URI: REPORT_URI };
  if (isNode) module.exports = M;
  else root.Csp = M;
})(typeof globalThis !== 'undefined' ? globalThis : this);
