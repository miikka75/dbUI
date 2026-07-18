const { defineConfig } = require('@playwright/test');

// Tests run against an ISOLATED server: a dedicated port + an in-memory SQLite DB (APP_DB=:memory:),
// seeded per-test from test-ui/fixture-schema.json via ensureAppReady. This guarantees the suite never
// reads or clobbers the real dev/local.db — no snapshot/restore needed.
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
    // CSP: '1' -> the app's Content-Security-Policy is ENFORCED for every E2E test (see /csp.js),
    // so a policy that would break the app fails CI before production flips Report-Only to enforcing.
    env: { PORT: String(TEST_PORT), APP_DB: ':memory:', CSP: '1' },
    port: TEST_PORT,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
