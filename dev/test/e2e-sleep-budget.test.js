// e2e-sleep-budget.test.js — keeps fixed sleeps out of tests that cannot afford them.
//
// The failure this guards against does not look like a bug. `Archive / Restore > archive moves row to
// archived view` spent 2400ms of its 8000ms budget on page.waitForTimeout, so on a loaded machine it
// timed out -- reported as a red test in a feature nobody had touched, of the kind that gets re-run
// until it passes and then trusted. Eight concurrent repeats of it failed half the time.
//
// The rule is deliberately about the BUDGET, not about waitForTimeout itself. A fixed sleep is
// sometimes the honest tool: the import tests wait for the app to reload ITSELF 1500ms after a clean
// import, and there is no event for that. What makes such a test safe is declaring it slow with
// test.setTimeout, and that is exactly what this checks.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SPEC_DIR = path.join(__dirname, '..', 'test-ui');
// playwright.config.js sets timeout: 8000. A test may spend a quarter of that asleep before it has to
// say so out loud; past that, the margin left for a slow CI runner is too thin to rely on.
const BUDGET_MS = 2000;

// Every `test(...)` in a spec, with the fixed-sleep total inside it and whether it raised its own
// timeout. Line-based on purpose: a parser would be more precise and much more to maintain, and the
// shape it needs to recognise is two literal call forms.
function testsOf(file) {
  const lines = fs.readFileSync(path.join(SPEC_DIR, file), 'utf8').split(/\r?\n/);
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    const t = /^\s*test\(\s*(?:'|")(.+?)(?:'|")/.exec(line);
    if (t) { cur = { file, line: i + 1, name: t[1], sleep: 0, ownTimeout: false }; out.push(cur); }
    if (!cur) return;
    if (/test\.setTimeout\(/.test(line)) cur.ownTimeout = true;
    const s = /waitForTimeout\((\d+)\)/.exec(line);
    if (s) cur.sleep += Number(s[1]);
  });
  return out;
}

describe('E2E fixed-sleep budget', () => {
  const specs = fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.spec.js'));

  it('finds the specs it is supposed to be guarding', () => {
    assert.ok(specs.length >= 5, 'no spec files found — this test would pass vacuously');
    const all = specs.flatMap(testsOf);
    assert.ok(all.length > 100, `only ${all.length} tests parsed — the test() shape changed?`);
  });

  it(`no test on the default timeout sleeps more than ${BUDGET_MS}ms`, () => {
    const over = specs.flatMap(testsOf)
      .filter((t) => !t.ownTimeout && t.sleep > BUDGET_MS)
      .map((t) => `${t.file}:${t.line} sleeps ${t.sleep}ms — ${t.name}`);
    assert.deepEqual(over, [], 'these will time out on a loaded machine. Wait for the CONDITION '
      + '(expect(locator) and expect.poll both retry), or declare the test slow with test.setTimeout');
  });
});
