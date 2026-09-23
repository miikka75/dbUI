// csp-client.js — report CSP violations from the PAGE, because the policy cannot ask for them.
//
// WHY THIS EXISTS. `report-uri` is a header-only directive: a <meta> CSP ignores it, the same way it
// ignores frame-ancestors. The live site is served by GitHub Pages, which cannot send a header at any
// price, so the enforcing policy there has no way to request reports. `securitypolicyviolation`,
// however, fires in the page regardless of how the policy arrived — so the page reports for itself.
//
// The endpoint is baked into index.html as <meta name="csp-report-endpoint"> by `npm run csp:sync`,
// from Csp.REPORT_ENDPOINT. Empty (the default) means reporting is off and nothing is posted.
//
// WHAT CATCHES THE EARLY ONES. This file loads with the other modules, which is long after the first
// fetch in <head>. A small inline script at the top of index.html installs a listener before any of
// those fetches and pushes into `window.__cspViolationQueue`; `install` drains that queue and then
// takes over live. Without it every boot-time violation — the interesting ones, since a blocked script
// is what a bad policy actually does — would happen before any listener existed.
//
// TWO BLIND SPOTS, both stated because neither can be fixed from here.
//
// 1. A violation OF connect-src may not be reportable, because the report is itself a connection.
//    Those are the violations most visible in DevTools anyway, so it is the least costly gap.
//
// 2. CONTENT BLOCKERS BLOCK THIS. uBlock Origin and friends match URLs that look like telemetry --
//    and a path ending `/csp-report` looks exactly like telemetry -- so the POST fails with
//    net::ERR_BLOCKED_BY_CLIENT before it reaches the network. Observed in the browser this was
//    developed against. Renaming the endpoint would buy a round of cat-and-mouse and no principle,
//    so it is not attempted.
//
//    What it means for the data: the violation log is a SAMPLE, not a census, and it is biased --
//    it under-represents exactly the users most likely to run extensions that inject into pages
//    and trip a policy in the first place. A quiet log is evidence, never proof.
(function(root) {

  // One report is one distinct violation. A directive/URI pair is the same key the collectors use
  // server-side (`reportId`), so a page that de-duplicates by it cannot produce rows they would merge.
  function key(v) { return (v && v.directive) + ' ' + (v && v.blockedURI); }

  // The body every collector already understands: functions/index.js, the Supabase Edge Function and
  // dev/csp-report-collector.js all normalise `{"csp-report": {...}}` with these hyphenated field
  // names, so the three stay interchangeable and a deployment can move between them.
  function payload(v) {
    return { 'csp-report': {
      'effective-directive': (v && v.directive) || '?',
      'blocked-uri': (v && v.blockedURI) || '',
      'document-uri': (v && v.documentURI) || ''
    } };
  }

  // A bounded, de-duplicating sink. `offer` returns the payload it sent, or null when it declined —
  // which is what the tests assert, and what keeps the decision to send in one testable place.
  //
  // The cap is per page load and deliberately small. A violation inside a render loop repeats as fast
  // as the loop runs, and a page that answers that by posting a thousand times has turned a CSP
  // problem into an outage of its own collector. Ten distinct violations is far more than a healthy
  // page produces and far fewer than a broken one would.
  function reporter(post, opts) {
    opts = opts || {};
    var cap = opts.cap == null ? 10 : opts.cap;
    var seen = Object.create(null);   // null-prototype: a blocked URI is untrusted text
    var sent = 0;
    return {
      offer: function(v) {
        if (!v || sent >= cap) return null;
        var k = key(v);
        if (seen[k]) return null;
        seen[k] = 1;
        sent++;
        var body = payload(v);
        post(body);
        return body;
      },
      get sent() { return sent; }
    };
  }

  // Normalise a SecurityPolicyViolationEvent. `effectiveDirective` is the modern field and
  // `violatedDirective` the legacy one; browsers still differ, and a report that says '?' is worth
  // more than one that says undefined.
  function fromEvent(e) {
    return {
      directive: (e && (e.effectiveDirective || e.violatedDirective)) || '?',
      blockedURI: (e && e.blockedURI) || '',
      documentURI: (e && e.documentURI) || ''
    };
  }

  // Wire it up. `deps` exists so the whole thing is testable without a DOM.
  //   endpoint  absolute URL, or '' to do nothing at all
  //   deps.doc  document (listener + the queue drain)
  //   deps.post how to send; defaults to sendBeacon, falling back to fetch
  function install(endpoint, deps) {
    deps = deps || {};
    if (!endpoint) return null;            // not configured: reporting is off, silently and by design
    var doc = deps.doc || (typeof document !== 'undefined' ? document : null);
    var win = deps.win || root;
    if (!doc) return null;
    // `loc` is injectable so the tests can exercise both sides; in the browser it is window.location.
    var loc = deps.loc || (win && win.location);
    if (loc && isLoopback(loc)) return null;   // dev/E2E: never report into a shared collector

    var post = deps.post || function(body) {
      var json = JSON.stringify(body);
      try {
        // CONTENT-TYPE IS text/plain ON PURPOSE, and it is the difference between this working and
        // silently doing nothing.
        //
        // The collector is on another origin (the app is on its own domain, the function on
        // *.supabase.co), so this POST is cross-origin. Only three Content-Type values are
        // CORS-safelisted — text/plain, application/x-www-form-urlencoded, multipart/form-data — and
        // anything else makes the request "non-simple" and triggers a preflight OPTIONS. The Edge
        // Function answers OPTIONS with 405, so the preflight fails and the browser drops the report
        // before it is ever sent. Nothing appears in the console, nothing reaches the table, and the
        // page looks exactly like one with no violations to report.
        //
        // `application/csp-report` is what a BROWSER sends for a report-uri report, and those are
        // exempt from CORS precisely because the browser makes them itself. A page-initiated POST gets
        // no such exemption. The collector does not care either way: it reads the raw body and JSON
        // parses it, without looking at the type.
        //
        // The response stays opaque to us (no Access-Control-Allow-Origin), which costs nothing — the
        // request is still delivered and processed, and reporting is fire-and-forget in both branches.
        var TYPE = 'text/plain;charset=UTF-8';
        // sendBeacon survives the page going away, which a violation during unload otherwise would not.
        if (win.navigator && win.navigator.sendBeacon) {
          win.navigator.sendBeacon(endpoint, new Blob([json], { type: TYPE }));
          return;
        }
        win.fetch(endpoint, { method: 'POST', body: json, headers: { 'Content-Type': TYPE }, mode: 'no-cors', keepalive: true })
          .catch(function() {});          // a failed report must never surface to the user
      } catch (e) { /* reporting must not break the page it is reporting on */ }
    };

    // Guard whatever transport we ended up with, not just the default one. Reporting must never
    // become the user's problem: a collector that is down, blocked by the very policy being reported
    // on, or simply misconfigured is a thing the page carries on through.
    var safePost = function(body) { try { post(body); } catch (e) { /* never reaches the page */ } };
    var r = reporter(safePost, deps);
    // Drain whatever the inline listener caught before this file existed, then take over live.
    var queued = (win.__cspViolationQueue || []).slice();
    if (win.__cspViolationQueue) win.__cspViolationQueue.length = 0;
    queued.forEach(function(v) { r.offer(v); });
    doc.addEventListener('securitypolicyviolation', function(e) { r.offer(fromEvent(e)); });
    return r;
  }

  // The endpoint as index.html carries it. Read from the DOM rather than from csp.js, because csp.js
  // is a build-time module and is not deployed (firebase.json ignores it).
  function endpointFrom(doc) {
    var m = doc && doc.querySelector && doc.querySelector('meta[name="csp-report-endpoint"]');
    return (m && m.getAttribute('content')) || '';
  }

  // A page served from loopback is a DEVELOPMENT page, and its violations are not production
  // telemetry. Without this, every `npm start` and every E2E run posts into the deployment's shared
  // collector -- and the E2E suite deliberately provokes a violation to test this very module, so it
  // would have been the single loudest reporter the table ever saw. The counters are keyed by
  // directive + blocked URI, so that noise is indistinguishable from a real visitor's.
  //
  // Checked here rather than in the test harness, because it is a property of the deployment and not
  // of the tests: somebody running the app locally against a configured collector should not file
  // reports into it either.
  function isLoopback(loc) {
    var h = (loc && loc.hostname) || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === ''
      || /\.localhost$/.test(h);
  }

  var M = { reporter: reporter, payload: payload, fromEvent: fromEvent, install: install, endpointFrom: endpointFrom, isLoopback: isLoopback };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else {
    root.CspClient = M;
    // Self-install on load, rather than waiting for app-core to call it. Three reasons: this runs the
    // moment the module arrives, which is earlier than anything in the app; `init()` returns early per
    // backend mode, so there is no one place in it that runs for every deployment; and a boot that
    // fails before Vue mounts is exactly when a violation report is worth having.
    // Idempotent — a second load finds the flag and does nothing.
    if (!root.__cspReporter) root.__cspReporter = install(endpointFrom(root.document), {});
  }
})(typeof self !== 'undefined' ? self : this);
