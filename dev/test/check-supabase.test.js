// check-supabase.test.js — guards the DESIGN decisions in the live health check, not its I/O.
//
// The script itself is the test for the deployment; there is nothing to gain from mocking fetch and
// asserting it calls fetch. What is worth pinning is the handful of choices inside it that are wrong
// in ways nobody would notice for months.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'check-supabase.mjs'), 'utf8');

describe('check-supabase — the health check itself', () => {
  it('is wired into package.json so it is runnable by name', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['check:live'], 'node check-supabase.mjs');
  });

  // THE TRAP. The collector counts by (directive, blocked_uri), so a canary that varied per run would
  // append a row every time and quietly make the health check the largest writer the table has ever
  // had. A stable one increments a single row forever.
  it('uses a STABLE canary, not a generated one', () => {
    const m = /const CANARY = '([^']+)'/.exec(SRC);
    assert.ok(m, 'the canary is a single named constant');
    assert.ok(!/CANARY[^\n]*(Date\.now|Math\.random|randomUUID)/.test(SRC),
      'a per-run canary appends a row per run instead of incrementing one');
    assert.match(m[1], /\.invalid\//,
      'a .invalid host cannot resolve, so the canary can never be mistaken for a real violation');
  });

  it('tells the reader how to remove the canary it leaves behind', () => {
    assert.match(SRC, /delete from public\.csp_reports/,
      'a check that writes must say how to undo it');
  });

  // A health check that always exits 0 cannot gate anything.
  it('exits non-zero when something failed', () => {
    assert.match(SRC, /process\.exit\(failed \? 1 : 0\)/);
  });

  // The round trip is the only check that distinguishes "accepted" from "stored" — 204 means the
  // former and never the latter. Losing it would leave a suite that passes on a collector storing
  // nothing, which is the exact state this script was written to detect.
  it('keeps the POST-then-read-back check, which is the point of the script', () => {
    assert.match(SRC, /a report survives the round trip/);
    const idx = SRC.indexOf('a report survives the round trip');
    assert.ok(SRC.slice(0, idx).includes('method: \'POST\''), 'it posts before it reads back');
  });

  // Each failure has to say what to DO -- but only where the remedy is non-obvious. "site
  // unreachable" needs no instructions; "the canary was accepted and never stored" absolutely does,
  // and those are exactly the four failures this script was written to catch. A red line that only
  // states a symptom sends the reader back to the guesswork it replaces.
  //
  // Scoped by NAME rather than asserted over every fail() call: a blanket "must contain a verb" rule
  // is a lint, and it failed on messages that were already fine.
  it('the non-obvious failures carry a remedy', () => {
    // Pull each fail(...) call whole, by matching parens -- the messages contain semicolons and
    // newlines, so a lazy regex truncates them mid-sentence (which is how this test was wrong first).
    const calls = {};
    for (const m of SRC.matchAll(/fail\('([^']+)',/g)) {
      let i = SRC.indexOf('(', m.index), depth = 0, end = i;
      for (; end < SRC.length; end++) {
        if (SRC[end] === '(') depth++;
        else if (SRC[end] === ')' && --depth === 0) break;
      }
      calls[m[1]] = (calls[m[1]] || '') + SRC.slice(i, end);
    }

    // One per bug this script exists to catch, plus the enforcing check.
    const needsRemedy = {
      'CSP is delivered': /csp:sync/,
      'violation log is readable': /SQL Editor|csp-reports\.sql|token/i,
      'a report survives the round trip': /NOTIFY pgrst|Edge Function logs/,
      'violation log is browser-readable': /[Rr]edeploy/,
      'collector answers CORS preflight': /functions deploy/,
      'uploads bucket exists': /supabase-schema\.sql/,
    };
    const missing = Object.entries(needsRemedy)
      .filter(([name, re]) => !calls[name] || !re.test(calls[name]))
      .map(([name]) => name);
    assert.deepEqual(missing, [],
      'these failures must name the fix, because the reader cannot guess it: ' + missing.join(', '));
  });
});
