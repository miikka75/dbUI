// One dev server per Playwright worker.
//
// Every E2E test re-seeds from scratch -- `ensureAppReady` posts /api/resetData, saves the fixture
// schema, then reloads -- so the tests themselves are independent. What was NOT independent was the
// server: all of them shared one process and one database, so a reset in one test would wipe the rows
// another test was mid-assertion over. That, and only that, is why the config pinned `workers: 1`.
//
// Giving each worker its own server + its own :memory: database removes the shared thing, and the
// suite parallelises: app.spec.js went from 288s serial to 48s across 8 workers, green at 4, 6 and 8.
//
// Import `test` and `expect` FROM HERE rather than from @playwright/test -- a spec that imports the
// bare Playwright `test` gets the config's baseURL, which no longer points at anything.
const base = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DEV_DIR = path.resolve(__dirname, '..');
// PGlite boots a WebAssembly Postgres and applies supabase-schema.sql before it serves, which is
// seconds rather than the instant open SQLite allowed for. Matches the old webServer timeout.
const READY_TIMEOUT_MS = 60_000;

// Wait for the server to say which port it bound. It is started with PORT=0 -- "any free port" -- so
// that N workers never have to agree on numbers, and never collide with a stale server still holding
// 3000 or 3100 from an earlier run.
function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR,
    env: { ...process.env, PORT: '0', APP_DB: ':memory:', CSP: '1' },
    // CSP=1 ENFORCES the app's Content-Security-Policy for every E2E test (see /csp.js), so a policy
    // that would break the app fails CI before production flips Report-Only to enforcing.
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      'dev server did not report a port within ' + READY_TIMEOUT_MS / 1000 + 's; output was:\n' + out)), READY_TIMEOUT_MS);
    const done = (fn, arg) => { clearTimeout(timer); fn(arg); };
    const scan = (buf) => {
      out += buf.toString();
      const m = out.match(/Local dev server: (http:\/\/\S+)/);
      if (m) done(resolve, m[1]);
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('exit', (code) => done(reject, new Error('dev server exited before it was ready (code ' + code + '):\n' + out)));
    child.on('error', (e) => done(reject, e));
  });

  return { child, url };
}

exports.test = base.test.extend({
  _server: [async ({}, use) => {
    const { child, url } = startServer();
    const origin = await url;
    // Nothing reads the server's output after this point, but a paused stream would back-pressure the
    // child once its pipe buffer filled, so keep draining it.
    child.stdout.resume();
    await use(origin);
    child.kill();
    // The fixture needs a timeout of its OWN. A worker fixture is created inside the first test that
    // asks for it, and without this option its setup is charged to that test's 8s budget -- so
    // READY_TIMEOUT_MS was unreachable, and a cold start slower than eight seconds failed whichever
    // test the worker happened to pick up first. Eight workers running initdb for a WebAssembly
    // Postgres at the same instant is exactly when that happens, which is why it showed up as a rare
    // failure in an arbitrary, innocent test rather than as "the server was slow to start".
  }, { scope: 'worker', timeout: READY_TIMEOUT_MS + 5_000 }],

  // Overriding Playwright's own baseURL fixture is what points `page.goto('/')` and
  // `page.request.post('/api/...')` at THIS worker's server.
  baseURL: async ({ _server }, use) => { await use(_server); },
});

exports.expect = base.expect;
