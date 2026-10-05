// csp-report-function.test.js — the Supabase Edge Function itself, run under Node with Deno stubbed.
//
// The SQL it calls is tested against real PostgreSQL in supabase-csp-collector.test.js. What is left is
// the routing: which request reaches which RPC, and what the function does when an RPC fails. That half
// decides whether a rotated token stays rotated, so it is run rather than read: Node strips the types,
// `Deno.serve` hands over the handler, and `fetch` stands in for PostgREST.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let handler;
let rpc = {};
const calls = [];
const J = (v, status = 200) => new Response(JSON.stringify(v), { status });

before(async () => {
  globalThis.Deno = {
    env: { get: (k) => ({ DBUI_CSP_REPORT_TOKEN: 'env-secret', SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'svc' })[k] },
    serve: (h) => { handler = h; },
  };
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const f = rpc[String(url).split('/rpc/')[1]];
    return f ? f(JSON.parse(init.body)) : J([]);
  };
  await import(pathToFileURL(path.join(__dirname, '..', '..', 'supabase', 'functions', 'csp-report', 'index.ts')).href);
});
const get = (token) => handler(new Request('https://fn/csp-report?token=' + encodeURIComponent(token)));
const rotate = (token) => handler(new Request('https://fn/csp-report?rotate&token=' + encodeURIComponent(token), { method: 'POST' }));

describe('csp-report function — the read gate', () => {
  it('asks the database which token is current, passing the environment one as the bootstrap', async () => {
    let asked;
    rpc.csp_report_token_ok = (b) => { asked = b; return J(b.p_token === 'stored'); };
    assert.equal((await get('stored')).status, 200);
    assert.deepEqual(asked, { p_token: 'stored', p_env: 'env-secret' });
    assert.equal((await get('env-secret')).status, 403, 'the environment token opens the log after a rotation');
  });

  it('falls back to the environment token only when the SQL predates rotation (404)', async () => {
    rpc.csp_report_token_ok = () => new Response('', { status: 404 });
    assert.equal((await get('env-secret')).status, 200);
    assert.equal((await get('guess')).status, 403);
  });

  it('denies on any other failure, so a storage error cannot revive a rotated-out token', async () => {
    rpc.csp_report_token_ok = () => new Response('', { status: 500 });
    assert.equal((await get('env-secret')).status, 403);
  });
});

describe('csp-report function — rotation', () => {
  it('mints 32 random bytes, stores them by compare-and-swap, and answers the new token once', async () => {
    let asked;
    rpc.csp_report_rotate = (b) => { asked = b; return J(b.p_current === 'env-secret'); };
    const res = await rotate('env-secret');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'the panel cannot read the new token');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { token } = await res.json();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.deepEqual(asked, { p_current: 'env-secret', p_env: 'env-secret', p_new: token });
  });

  it('refuses a wrong token, and says so when the SQL has not been re-applied', async () => {
    rpc.csp_report_rotate = () => J(false);
    assert.equal((await rotate('guess')).status, 403);
    rpc.csp_report_rotate = () => new Response('', { status: 404 });
    assert.equal((await rotate('env-secret')).status, 501);
  });

  it('a plain report POST never reaches the rotation', async () => {
    calls.length = 0;
    const res = await handler(new Request('https://fn/csp-report', { method: 'POST',
      body: JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'https://x/y.png' } }) }));
    assert.equal(res.status, 204);
    assert.deepEqual(calls, ['https://sb/rest/v1/rpc/csp_report_record']);
  });
});
