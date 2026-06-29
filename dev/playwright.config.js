const { defineConfig } = require('@playwright/test');

// Tests run against an ISOLATED server: a dedicated port + an in-memory SQLite DB (APP_DB=:memory:),
// seeded per-test from test-ui/fixture-schema.json via ensureAppReady. This guarantees the suite never
// reads or clobbers the real dev dev/local.db (the church data) — no snapshot/restore needed.
const TEST_PORT = 3100;

module.exports = defineConfig({
  testDir: './test-ui',
  timeout: 8000,
  expect: { timeout: 4000 },
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:' + TEST_PORT,
    headless: true,
  },
  webServer: {
    command: 'node server.js',
    env: { PORT: String(TEST_PORT), APP_DB: ':memory:' },
    port: TEST_PORT,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
