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

// The pglite suite is quarantined into its own project and run AFTER everything else. Each of its tests
// compiles a 10 MB WebAssembly Postgres and runs initdb, and under `fullyParallel` that landed on the
// same cores as a suite whose per-test timeout is 8 seconds. Ordinary app tests then timed out.
//
// Two arrangements were measured before this one:
//   fullyParallel: false on the pglite project -- caps it to one worker, but that worker then runs for
//     the WHOLE app phase, so the load became constant instead of bursty and `Archive / Restore` failed
//     on 3 runs out of 3.
//   dependencies: ['app'] -- the app phase runs unloaded, and the suite was clean. Its cost is that a
//     failing app project SKIPS this one ("6 did not run"), which only bites when the suite is already
//     red and something is being fixed anyway.
// So: sequenced. Costs about ten seconds of wall clock.
//
// Worth knowing separately: `Archive / Restore > archive moves row to archived view` is fragile under
// load independently of any of this -- on unmodified main, 8 concurrent repeats of it fail half the
// time. That is not this suite's doing and is not fixed here.
const PGLITE_SPEC = /pglite-local\.spec\.js/;

module.exports = defineConfig({
  testDir: './test-ui',
  timeout: 8000,
  expect: { timeout: 4000 },
  workers: WORKERS,
  fullyParallel: true,
  use: {
    headless: true,
  },
  projects: [
    { name: 'app', testIgnore: PGLITE_SPEC },
    { name: 'pglite', testMatch: PGLITE_SPEC, dependencies: ['app'] }
  ],
});
