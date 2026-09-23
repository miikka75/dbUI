// csp-client.test.js — reporting CSP violations from the page, because the policy cannot ask.
//
// `report-uri` is header-only; a <meta> CSP ignores it. The live site is on GitHub Pages, which cannot
// send a header at all, so the enforcing policy there has no way to request reports. csp-client.js
// listens for `securitypolicyviolation` — which fires however the policy arrived — and posts.
//
// The two things that must not go wrong are both about restraint: a page that reports a looping
// violation a thousand times has turned a CSP problem into an outage of its own collector, and a
// report that fails must never reach the user. Both are pinned here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CspClient = require('../../csp-client');
const Csp = require('../../csp');

const v = (directive, blockedURI, documentURI) => ({ directive, blockedURI, documentURI: documentURI || 'https://app/' });

// A document stand-in: enough for install() to add a listener and read the endpoint meta.
function fakeDoc(endpoint) {
  const handlers = [];
  return {
    handlers,
    addEventListener: (name, fn) => { if (name === 'securitypolicyviolation') handlers.push(fn); },
    querySelector: (sel) => (sel === 'meta[name="csp-report-endpoint"]' && endpoint !== undefined
      ? { getAttribute: () => endpoint } : null),
    fire: (e) => handlers.forEach((h) => h(e)),
  };
}

describe('payload — the body every collector already understands', () => {
  it('uses the hyphenated field names the three collectors normalise', () => {
    assert.deepEqual(CspClient.payload(v('script-src', 'https://evil/x.js')), {
      'csp-report': {
        'effective-directive': 'script-src',
        'blocked-uri': 'https://evil/x.js',
        'document-uri': 'https://app/',
      },
    });
  });

  // The Supabase Edge Function, functions/index.js and dev/csp-report-collector.js all read
  // `violated-directive ?? effective-directive`, `blocked-uri` and `document-uri` off a `csp-report`
  // envelope. If this shape drifts, reports arrive and normalise to '?' — collected and useless.
  it('survives the collector normaliser with its fields intact', () => {
    // The REAL collector, so this is interoperability rather than a restatement of the shape.
    const { normalize } = require('../csp-report-collector');
    const [row] = normalize(JSON.stringify(CspClient.payload(v('img-src', 'data:'))));
    // The collector stamps its own `ts`; what matters is that none of the three fields it reads came
    // back as the '?' it substitutes when it cannot find one.
    assert.equal(row.directive, 'img-src');
    assert.equal(row.blockedURI, 'data:');
    assert.equal(row.document, 'https://app/');
  });

  it('never emits undefined for a field, however empty the event was', () => {
    const p = CspClient.payload({})['csp-report'];
    assert.equal(p['effective-directive'], '?');
    assert.equal(p['blocked-uri'], '');
    assert.equal(p['document-uri'], '');
  });
});

describe('fromEvent — both spellings browsers use', () => {
  it('prefers effectiveDirective and falls back to the legacy violatedDirective', () => {
    assert.equal(CspClient.fromEvent({ effectiveDirective: 'a', violatedDirective: 'b' }).directive, 'a');
    assert.equal(CspClient.fromEvent({ violatedDirective: 'b' }).directive, 'b');
    assert.equal(CspClient.fromEvent({}).directive, '?', 'a report saying ? beats one saying undefined');
  });
});

describe('reporter — de-duplicated and capped, per page load', () => {
  const sink = () => { const sent = []; return { sent, post: (b) => sent.push(b) }; };

  it('sends the first of a kind and declines every repeat', () => {
    const s = sink();
    const r = CspClient.reporter(s.post);
    assert.ok(r.offer(v('script-src', 'https://evil/x.js')));
    assert.equal(r.offer(v('script-src', 'https://evil/x.js')), null, 'the same violation again');
    assert.equal(s.sent.length, 1);
  });

  it('treats a different directive or a different URI as a different violation', () => {
    const s = sink();
    const r = CspClient.reporter(s.post);
    r.offer(v('script-src', 'https://evil/x.js'));
    r.offer(v('img-src', 'https://evil/x.js'));
    r.offer(v('script-src', 'https://evil/y.js'));
    assert.equal(s.sent.length, 3);
  });

  // THE POINT OF THE CAP. A violation inside a render loop repeats as fast as the loop runs. Without
  // this, the page answers a CSP problem by flooding its own collector.
  it('stops at the cap even when every violation is distinct', () => {
    const s = sink();
    const r = CspClient.reporter(s.post, { cap: 3 });
    for (let i = 0; i < 50; i++) r.offer(v('script-src', 'https://evil/' + i + '.js'));
    assert.equal(s.sent.length, 3);
    assert.equal(r.sent, 3);
  });

  it('defaults to a small cap rather than none', () => {
    const s = sink();
    const r = CspClient.reporter(s.post);
    for (let i = 0; i < 100; i++) r.offer(v('script-src', 'https://evil/' + i + '.js'));
    assert.ok(s.sent.length > 0 && s.sent.length <= 20, 'a default cap exists and is small, got ' + s.sent.length);
  });

  it('ignores a null offer instead of throwing', () => {
    const s = sink();
    const r = CspClient.reporter(s.post);
    assert.equal(r.offer(null), null);
    assert.equal(s.sent.length, 0);
  });

  // A blocked URI is untrusted text that reaches an object key. '__proto__' on a plain object answers
  // `seen[k]` truthily for a key nobody stored, which would silently drop the first real report of it.
  it('is not fooled by a blocked URI called __proto__', () => {
    const s = sink();
    const r = CspClient.reporter(s.post);
    assert.ok(r.offer(v('script-src', '__proto__')), 'the first __proto__ violation is reported');
    assert.equal(r.offer(v('script-src', '__proto__')), null, 'and the second is still de-duplicated');
  });
});

describe('install — wiring, and the queue that catches the early ones', () => {
  it('does nothing at all when no endpoint is configured', () => {
    const doc = fakeDoc('');
    assert.equal(CspClient.install('', { doc, win: {} }), null);
    assert.equal(doc.handlers.length, 0, 'no listener, so no cost on a deployment that has not set one');
  });

  // The inline script in index.html installs a listener before the first fetch in <head>; this module
  // loads with the others, long after. Without the drain, every boot-time violation -- the interesting
  // ones, since a blocked script is what a bad policy actually does -- would be lost.
  it('drains what the inline listener caught before this module existed', () => {
    const sent = [];
    const win = { __cspViolationQueue: [v('script-src', 'https://cdn/early.js')] };
    CspClient.install('https://collector/', { doc: fakeDoc(), win, post: (b) => sent.push(b) });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]['csp-report']['blocked-uri'], 'https://cdn/early.js');
    assert.equal(win.__cspViolationQueue.length, 0, 'the queue is emptied, so a second install cannot re-send it');
  });

  it('then takes over live events', () => {
    const sent = [];
    const doc = fakeDoc();
    CspClient.install('https://collector/', { doc, win: {}, post: (b) => sent.push(b) });
    doc.fire({ effectiveDirective: 'connect-src', blockedURI: 'https://evil/', documentURI: 'https://app/' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]['csp-report']['effective-directive'], 'connect-src');
  });

  it('de-duplicates across the queue and the live events together', () => {
    const sent = [];
    const doc = fakeDoc();
    const win = { __cspViolationQueue: [v('script-src', 'https://evil/x.js')] };
    CspClient.install('https://collector/', { doc, win, post: (b) => sent.push(b) });
    doc.fire({ effectiveDirective: 'script-src', blockedURI: 'https://evil/x.js', documentURI: 'https://app/' });
    assert.equal(sent.length, 1, 'the live repeat of a queued violation is not a second report');
  });

  it('reads the endpoint off the meta tag index.html carries', () => {
    assert.equal(CspClient.endpointFrom(fakeDoc('https://x.supabase.co/functions/v1/csp-report')),
      'https://x.supabase.co/functions/v1/csp-report');
    assert.equal(CspClient.endpointFrom(fakeDoc('')), '', 'empty means reporting is off');
    assert.equal(CspClient.endpointFrom({}), '', 'and so does no tag at all');
  });

  // Reporting must never become the user's problem. A collector that is down, blocked or misconfigured
  // is a thing the page carries on through.
  it('swallows a failing transport rather than letting it reach the page', () => {
    const doc = fakeDoc();
    const boom = () => { throw new Error('network down'); };
    CspClient.install('https://collector/', { doc, win: {}, post: boom });
    assert.doesNotThrow(() => doc.fire({ effectiveDirective: 'script-src', blockedURI: 'x' }));
  });
});

describe('loopback never reports — dev and CI are not production telemetry', () => {
  // WRITTEN AFTER GETTING IT WRONG. With an endpoint configured, `npm start` and every E2E run began
  // posting into the deployment's shared collector -- and the E2E suite deliberately provokes a
  // violation to test this very module, so it was about to become the loudest reporter the table had.
  // The counters are keyed by directive + blocked URI, so that noise is indistinguishable from a real
  // visitor's, which is what makes it worth preventing rather than filtering later.
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]', 'app.localhost'];
  const real = ['miikka75.github.io', 'example.org', 'csbyjsibxjszduxqetbf.supabase.co'];

  it('recognises every shape a local host takes', () => {
    for (const h of loopback) assert.equal(CspClient.isLoopback({ hostname: h }), true, h);
    for (const h of real) assert.equal(CspClient.isLoopback({ hostname: h }), false, h);
  });

  it('install() declines on loopback even with an endpoint configured', () => {
    const doc = fakeDoc();
    const r = CspClient.install('https://collector.example/report', {
      doc, win: {}, loc: { hostname: '127.0.0.1' }, post: () => { throw new Error('must not post'); },
    });
    assert.equal(r, null, 'no reporter');
    assert.equal(doc.handlers.length, 0, 'and no listener, so a violation costs nothing at all');
  });

  it('but installs normally on a real host', () => {
    const doc = fakeDoc();
    const sent = [];
    const r = CspClient.install('https://collector.example/report', {
      doc, win: {}, loc: { hostname: 'miikka75.github.io' }, post: (b) => sent.push(b),
    });
    assert.ok(r);
    doc.fire({ effectiveDirective: 'script-src', blockedURI: 'https://evil/' });
    assert.equal(sent.length, 1);
  });

  it('a queued violation from a loopback page is dropped, not deferred', () => {
    // The inline listener queues regardless of host -- it is four lines and knows nothing. The
    // decision belongs here, and it must DISCARD rather than hold: a queue that survives would post
    // on the next navigation to a real host.
    const win = { __cspViolationQueue: [v('script-src', 'https://blocked.example/evil.js')] };
    const r = CspClient.install('https://collector.example/report', {
      doc: fakeDoc(), win, loc: { hostname: 'localhost' }, post: () => { throw new Error('must not post'); },
    });
    assert.equal(r, null);
  });
});

describe('the endpoint is configuration, not a default', () => {
  // This used to assert the endpoint was EMPTY, which stopped being the interesting property the
  // moment this deployment configured one. What must stay true is weaker and more useful: the value
  // is either unset, or a real absolute URL that this repo's owner chose. What it must never be is a
  // plausible-looking default nobody picked -- that is how a fork ends up posting its violations into
  // somebody else's table without anyone noticing.
  it('is either unset or an absolute https URL', () => {
    if (!Csp.REPORT_ENDPOINT) return;                 // unset is a valid, and the default, state
    const u = new URL(Csp.REPORT_ENDPOINT);           // throws if it is not a URL at all
    assert.equal(u.protocol, 'https:', 'a report posted over http: is readable by anyone on the path');
    assert.ok(u.pathname.length > 1, 'an endpoint needs a path, not just an origin');
  });

  // A fork that changes nothing else inherits this URL, and its violations would land in the original
  // deployment's table. Nothing can stop that automatically -- but the constant is commented as
  // per-deployment, and this test names the consequence so the next person to read it knows.
  it('is a per-deployment value, which a fork must change', () => {
    assert.match(
      require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'csp.js'), 'utf8'),
      /REPORT_ENDPOINT[\s\S]{0,80}?=/,
      'REPORT_ENDPOINT is still a single named constant, so a fork has one line to change');
  });
});
