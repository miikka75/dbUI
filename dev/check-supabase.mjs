#!/usr/bin/env node
// check-supabase.mjs — make ONE REAL REQUEST per claim against a live deployment.
//
// WHY THIS EXISTS. The CSP reporting feature shipped four bugs, and the unit suite was green through
// all of them:
//
//   1. `csp-reports.sql` was never applied, because the docs said `db push` would do it.
//   2. The report POST tripped a CORS preflight the collector answered with 405.
//   3. The GET response carried no CORS headers, so the log was curl-only.
//   4. The collector never checked `res.ok`, so a failed write logged nothing at all.
//
// Every one was invisible in every direction: no console error, no log line, and an empty violation
// table that looks exactly like a healthy site's. None was findable by a test that stubs the network,
// because all four lived precisely at the boundary the stubs replaced.
//
// So this does the opposite of the unit suite. It stubs nothing, asserts against a deployment that
// really exists, and each check is one request whose failure names what to do about it.
//
//   node dev/check-supabase.mjs [siteUrl]
//
//   DBUI_CSP_REPORT_TOKEN   needed for the read-back; without it the round-trip is skipped
//   SUPABASE_URL            optional, enables the kv + storage checks
//   SUPABASE_ANON_KEY       optional, ditto (publishable or legacy anon; both are public by design)
//
// Exits non-zero if anything FAILED, so it can gate a deploy.
const SITE = process.argv[2] || 'https://dbui.ddns.net';
const TOKEN = process.env.DBUI_CSP_REPORT_TOKEN || '';
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';

// A STABLE canary, not a unique one. The collector counts by (directive, blocked_uri), so reusing one
// URI means every run for the rest of time increments a single row instead of appending a new one.
// A unique-per-run canary would quietly turn the health check into the biggest writer the table has.
const CANARY = 'https://healthcheck.invalid/probe.js';

const results = [];
const record = (state, name, detail) => { results.push({ state, name, detail }); };
const pass = (n, d) => record('PASS', n, d);
const fail = (n, d) => record('FAIL', n, d);
const skip = (n, d) => record('SKIP', n, d);

const get = (url, init) => fetch(url, { redirect: 'follow', ...init });

// --- 1. The deployed page actually carries the policy ----------------------------------------------
let endpoint = '';
try {
  const res = await get(SITE);
  const html = await res.text();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
  const ep = /<meta name="csp-report-endpoint" content="([^"]*)">/.exec(html);

  if (!res.ok) fail('site reachable', `${SITE} -> HTTP ${res.status}`);
  else pass('site reachable', `${SITE} -> ${res.status}`);

  if (!csp) {
    fail('CSP is delivered', 'no <meta http-equiv="Content-Security-Policy"> in the served HTML — a '
      + 'static host cannot send the header, so this tag is the whole policy. Run `npm run csp:sync`.');
  } else if (/report-only/i.test(csp[0])) {
    fail('CSP is ENFORCING', 'the tag is Report-Only: violations are observed, not blocked');
  } else {
    pass('CSP is ENFORCING', csp[1].split(';')[0].trim() + ' …');
  }

  // Position matters: a meta CSP governs only what is fetched after the parser reaches it.
  const at = html.indexOf('http-equiv="Content-Security-Policy"');
  const firstFetch = Math.min(...['<link ', '<script src'].map((t) => {
    const i = html.indexOf(t); return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }));
  if (at > 0 && at < firstFetch) pass('CSP precedes the first fetch', 'nothing loads unprotected');
  else if (at > 0) fail('CSP precedes the first fetch', 'the tag sits BELOW the first <link>/<script>, '
    + 'so everything above it loads with no policy at all');

  endpoint = (ep && ep[1]) || '';
  if (endpoint) pass('report endpoint published', endpoint);
  else skip('report endpoint published', 'empty — violation reporting is off for this deployment');
} catch (e) {
  fail('site reachable', `${SITE}: ${e.message}`);
}

// --- 2. The collector, if one is configured --------------------------------------------------------
if (endpoint) {
  // A cross-origin POST with a non-safelisted content type preflights. A collector that 405s the
  // preflight drops every report from such a client, silently.
  try {
    const res = await get(endpoint, {
      method: 'OPTIONS',
      headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    if (res.ok || res.status === 204) pass('collector answers CORS preflight', `OPTIONS -> ${res.status}`);
    else fail('collector answers CORS preflight', `OPTIONS -> ${res.status}. Redeploy the function: `
      + 'npx supabase@latest functions deploy csp-report --no-verify-jwt');
  } catch (e) { fail('collector answers CORS preflight', e.message); }

  // The write path the PAGE uses: text/plain, which is CORS-safelisted so it never preflights.
  let posted = false;
  try {
    const res = await get(endpoint, {
      method: 'POST',
      headers: { Origin: SITE, 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ 'csp-report': {
        'effective-directive': 'script-src', 'blocked-uri': CANARY, 'document-uri': SITE + '/',
      } }),
    });
    posted = res.status === 204 || res.ok;
    if (posted) pass('collector accepts a report', `POST -> ${res.status}`);
    else fail('collector accepts a report', `POST -> ${res.status}`);
  } catch (e) { fail('collector accepts a report', e.message); }

  // --- 3. THE ONE THAT MATTERS: does a posted report come back out again? --------------------------
  //
  // Every other check here can pass while nothing is stored — that is exactly the state this
  // deployment sat in. A 204 means "accepted", never "saved": the collector answers 204 even when the
  // write fails, deliberately, because a collector that 500s at a browser teaches it nothing.
  if (!TOKEN) {
    skip('a report survives the round trip', 'set DBUI_CSP_REPORT_TOKEN to check the half that matters');
  } else {
    try {
      // The write is a fire-and-forget RPC; give it a breath before reading back.
      await new Promise((r) => setTimeout(r, 1500));
      const res = await get(endpoint + '?token=' + encodeURIComponent(TOKEN), { headers: { Origin: SITE } });
      const body = await res.text();

      if (res.status === 403) {
        fail('violation log is readable', 'Forbidden — wrong token, or DBUI_CSP_REPORT_TOKEN is unset '
          + 'on the function (an empty secret is never a valid token, by design)');
      } else if (res.status === 502 || /storage error/i.test(body)) {
        fail('violation log is readable', 'Storage error — the csp_reports table is missing. Paste all '
          + 'of supabase/csp-reports.sql into the SQL Editor (NOT `supabase db push`).');
      } else if (!res.ok) {
        fail('violation log is readable', `HTTP ${res.status}: ${body.slice(0, 200)}`);
      } else {
        const log = JSON.parse(body);
        pass('violation log is readable', `${log.total} report(s) across ${log.violations.length} violation(s)`);

        const hit = (log.violations || []).find((v) => v.blocked_uri === CANARY);
        if (hit) {
          pass('a report survives the round trip', `canary stored, count=${hit.count} — the whole chain works`);
        } else {
          fail('a report survives the round trip',
            'the POST was accepted and the canary is NOT in the log, so the write is failing inside the '
            + 'function. Check the Edge Function logs for `csp-report: storing failed` (it now logs '
            + "PostgREST's own reason). Most likely a stale schema cache: run `NOTIFY pgrst, 'reload "
            + "schema';` in the SQL Editor.");
        }
      }
      // CORS on the read is what a browser-based panel needs; curl never notices its absence.
      const acao = res.headers.get('access-control-allow-origin');
      if (acao) pass('violation log is browser-readable', `Access-Control-Allow-Origin: ${acao}`);
      else fail('violation log is browser-readable', 'no Access-Control-Allow-Origin on the GET, so only '
        + 'curl can read it. Redeploy the function.');
    } catch (e) { fail('violation log is readable', e.message); }
  }
} else {
  skip('collector checks', 'no endpoint configured');
}

// --- 4. The app's own backend, when credentials are supplied ---------------------------------------
if (SB_URL && SB_KEY) {
  const h = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
  try {
    const res = await get(`${SB_URL}/rest/v1/kv?select=k&limit=1`, { headers: h });
    // 200 or an RLS-shaped empty answer both prove the table exists and PostgREST can see it.
    if (res.ok) pass('kv table reachable', `HTTP ${res.status} — supabase-schema.sql has been applied`);
    else fail('kv table reachable', `HTTP ${res.status}: ${(await res.text()).slice(0, 160)} — apply `
      + 'supabase-schema.sql in the SQL Editor');
  } catch (e) { fail('kv table reachable', e.message); }

  try {
    const res = await get(`${SB_URL}/storage/v1/bucket/uploads`, { headers: h });
    if (res.ok) pass('uploads bucket exists', 'image and feed uploads have somewhere to go');
    else if (res.status === 400 || res.status === 404) fail('uploads bucket exists',
      `HTTP ${res.status} — re-run supabase-schema.sql; it creates the bucket and its policies`);
    else skip('uploads bucket exists', `HTTP ${res.status} (anon key cannot inspect buckets here)`);
  } catch (e) { skip('uploads bucket exists', e.message); }
} else {
  skip('backend checks', 'set SUPABASE_URL and SUPABASE_ANON_KEY to include them');
}

// --- Report -----------------------------------------------------------------------------------------
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const mark = r.state === 'PASS' ? '  ok  ' : r.state === 'FAIL' ? ' FAIL ' : ' skip ';
  console.log(`${mark} ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => r.state === 'FAIL').length;
console.log(`\n${results.filter((r) => r.state === 'PASS').length} ok, ${failed} failed, `
  + `${results.filter((r) => r.state === 'SKIP').length} skipped`);
if (failed) console.log('\nThe canary is a STABLE uri, so repeated runs increment one row rather than '
  + `adding rows. Remove it with:\n  delete from public.csp_reports where blocked_uri = '${CANARY}';`);
process.exit(failed ? 1 : 0);
