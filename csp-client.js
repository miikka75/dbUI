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
// THE BLIND SPOT, stated because it cannot be fixed from here: a violation OF connect-src may not be
// reportable, because the report is itself a connection. Those are the violations most visible in
// DevTools anyway, so the gap is the least costly one available.
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

    var post = deps.post || function(body) {
      var json = JSON.stringify(body);
      try {
        // sendBeacon survives the page going away, which a violation during unload otherwise would not.
        // It is fire-and-forget by design: the browser ignores the response, and so must we.
        if (win.navigator && win.navigator.sendBeacon) {
          win.navigator.sendBeacon(endpoint, new Blob([json], { type: 'application/csp-report' }));
          return;
        }
        win.fetch(endpoint, { method: 'POST', body: json, headers: { 'Content-Type': 'application/csp-report' }, keepalive: true })
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

  var M = { reporter: reporter, payload: payload, fromEvent: fromEvent, install: install, endpointFrom: endpointFrom };
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
