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
