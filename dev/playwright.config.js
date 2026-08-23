const { defineConfig } = require('@playwright/test');

// Tests run against an ISOLATED server, one PER WORKER: a free port the server picks itself and an
// in-memory database, spawned by the worker fixture in test-ui/server-fixture.js and seeded per-test
// from test-ui/fixture-schema.json via ensureAppReady. This guarantees the suite never reads or
// clobbers the real dev/local.db -- no snapshot/restore needed -- and, because no two workers share a
// database, /api/resetData in one test cannot wipe rows another test is asserting over.
//
// That shared database was the only reason this config used to pin `workers: 1`. Removing it took
// app.spec.js (235 tests) from 288s to 48s. Specs must import `test` from ./server-fixture, not from
// @playwright/test, or they get a baseURL pointing at no server.

// Each worker runs a WebAssembly Postgres alongside a browser, so the ceiling is memory, not cores --
// on a 20-core machine Playwright's default would start 10 of each. 8 is the most this suite has
// actually been measured green at (4, 6 and 8 all passed); PW_WORKERS overrides for a bigger box.
const WORKERS = process.env.PW_WORKERS
  ? Number(process.env.PW_WORKERS)
  : Math.max(1, Math.min(8, Math.ceil(require('node:os').cpus().length / 2)));

module.exports = defineConfig({
  testDir: './test-ui',
  timeout: 8000,
  expect: { timeout: 4000 },
  workers: WORKERS,
  fullyParallel: true,
  use: {
    headless: true,
  },
});
