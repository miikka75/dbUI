// csp-meta.spec.js — boot the app with index.html's <meta> CSP as the ONLY policy in force.
//
// This is the GITHUB PAGES configuration, and it is the one this app actually deploys to
// (deploy-pages.yml uploads the repo root on every push to main). A static host cannot send a custom
// header, so the meta tag is the whole of the policy there.
//
// Every other E2E spec runs with CSP=1, which makes dev/server.js send the policy as an enforcing
// HEADER. Those runs do exercise the meta tag — it is in index.html now — but only alongside a header
// that would mask a malformed or over-strict meta: two policies intersect, and if the header were
// doing the permitting, a broken meta would look fine. So this spec removes the header and leaves the
// tag to stand on its own.
//
// What it is really guarding: before the tag existed, the deployed site ran with NO CSP in any mode
// while firebase.json's Report-Only header sat there looking like coverage. A regression that dropped
// or mangled the tag would return it to exactly that state, silently, because a page with no CSP looks
// identical to a page whose CSP permits everything.
const base = require('@playwright/test');
const { startServer, READY_TIMEOUT_MS } = require('./server-fixture');

const test = base.test.extend({
  // CSP: '' -> server.js's `process.env.CSP === '1'` is false, so it sends no CSP header at all.
  metaOnlyURL: [async ({}, use) => {
    const { child, url } = startServer({ CSP: '' });
    const origin = await url;
    child.stdout.resume();
    await use(origin);
    child.kill();
  }, { scope: 'worker', timeout: READY_TIMEOUT_MS + 5_000 }],
});
const { expect } = base;

test('the app boots under the <meta> CSP alone, with no violations', async ({ page, metaOnlyURL }) => {
  // A CSP violation surfaces as a console error and as a securitypolicyviolation event. Collect both:
  // the event is the precise signal, the console text is what makes a failure readable.
  const violations = [];
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(e.violatedDirective + ' blocked ' + (e.blockedURI || '(inline)'));
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });

  const res = await page.goto(metaOnlyURL + '/');
  expect(res.status()).toBe(200);

  // The server must NOT be sending a policy — otherwise this spec silently retests the header path.
  const headers = res.headers();
  expect(headers['content-security-policy'], 'this spec requires a header-free server').toBeUndefined();
  expect(headers['content-security-policy-report-only']).toBeUndefined();

  // The tag is present and is the policy actually in force.
  const metaContent = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  expect(metaContent, 'index.html carries the CSP meta tag').toBeTruthy();
  expect(metaContent).toContain("default-src 'self'");
  expect(metaContent).not.toContain('frame-ancestors');   // header-only; invalid in meta

  // Boot far enough to have run the inline splash script, loaded Vue + Vuetify + app-core over the
  // policy, and rendered. The setup screen is the first thing a fresh database shows, so its presence
  // means the whole script chain executed under the meta policy rather than being refused by it.
  await page.waitForSelector('[data-testid="setup-mode-local"], [data-testid="nav-drawer"], .v-application', { timeout: 30_000 });

  const fromPage = await page.evaluate(() => window.__cspViolations || []);
  expect(fromPage, 'securitypolicyviolation events under the meta-only policy').toEqual([]);
  expect(violations, 'console CSP errors under the meta-only policy').toEqual([]);
});

// --- Reporting, which the policy itself cannot ask for ---------------------------------------------
//
// `report-uri` is header-only, so under the <meta> delivery the policy has no way to request reports.
// csp-client.js reports from the page instead. The unit tests cover the de-duplication, the cap and
// the payload shape; what only a browser can prove is the part the unit tests have to assume: that a
// REAL violation reaches the inline queue installed above the preloads, and that install() then drains
// it. If the inline listener were placed too late, or the event shape differed from what fromEvent
// reads, every unit test would still pass and nothing would ever be reported.
test('a real violation reaches the inline queue, and install() drains it', async ({ page, metaOnlyURL }) => {
  await page.goto(metaOnlyURL + '/');
  await page.waitForSelector('[data-testid="setup-mode-local"], [data-testid="nav-drawer"], .v-application', { timeout: 30_000 });

  // The queue must exist from the very first bytes of <head>, before anything was fetched.
  expect(await page.evaluate(() => Array.isArray(window.__cspViolationQueue)),
    'the inline violation queue is installed').toBe(true);

  const result = await page.evaluate(async () => {
    // Provoke a genuine script-src violation: this origin is not in the policy, so the browser refuses
    // the load and fires securitypolicyviolation. Nothing is fetched -- it is blocked before the request.
    window.__cspViolationQueue.length = 0;
    const el = document.createElement('script');
    el.src = 'https://blocked.example/evil.js';
    document.head.appendChild(el);
    await new Promise((r) => setTimeout(r, 300));

    const queued = window.__cspViolationQueue.slice();

    // Now wire the reporter the way a configured deployment would, with the transport captured.
    const posted = [];
    window.CspClient.install('https://collector.example/report', { post: (b) => posted.push(b) });
    return { queued, posted };
  });

  expect(result.queued.length, 'the inline listener caught the blocked script').toBeGreaterThan(0);
  expect(result.queued[0].directive).toContain('script-src');
  expect(result.queued[0].blockedURI).toContain('blocked.example');

  // install() drained the queue into a report body the collectors understand.
  expect(result.posted.length, 'install() drained the queue and posted').toBeGreaterThan(0);
  const body = result.posted[0]['csp-report'];
  expect(body['effective-directive']).toContain('script-src');
  expect(body['blocked-uri']).toContain('blocked.example');
  expect(body['document-uri']).toBeTruthy();
});

// Reporting is OFF until a deployment sets Csp.REPORT_ENDPOINT, and that must cost nothing: no
// listener, no posts, no console noise on the overwhelming majority of deployments that never set one.
test('with no endpoint configured, nothing is posted and nothing breaks', async ({ page, metaOnlyURL }) => {
  await page.goto(metaOnlyURL + '/');
  await page.waitForSelector('[data-testid="setup-mode-local"], [data-testid="nav-drawer"], .v-application', { timeout: 30_000 });
  const r = await page.evaluate(() => ({
    endpoint: window.CspClient.endpointFrom(document),
    installed: window.CspClient.install('', {}),
    reporter: window.__cspReporter,
  }));
  expect(r.endpoint, 'ships empty: a collector URL belongs to a deployment').toBe('');
  expect(r.installed, 'install() with no endpoint does nothing at all').toBeNull();
  expect(r.reporter, 'so the self-install left no reporter behind either').toBeFalsy();
});
