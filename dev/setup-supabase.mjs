#!/usr/bin/env node
// setup-supabase.mjs — everything after the dashboard work, in one re-runnable command.
//
//   cd dev && npm run supabase:setup -- --project-ref <ref> [--csp-only] [--new-token] [--site <url>] [--no-check]
//
// What it does, in order, against the hosted project (Management API, so `npx supabase@latest login`
// once and no database password):
//
//   1. supabase-schema.sql          the app's backend: kv, RLS, realtime, the uploads bucket
//                                    (skipped with --csp-only: a Firestore deployment wants only the collector)
//   2. supabase/csp-reports.sql     the CSP collector's storage, and the token table + its functions
//   3. checks that both token functions exist -- a 204 from the collector proves nothing, see SUPABASE.md
//   4. deploys the csp-report Edge Function, --no-verify-jwt
//   5. the read token: created only when there is none, printed ONCE
//   6. dev/check-supabase.mjs against the deployed site
//
// What it cannot do is the dashboard half: creating the project, the Google OAuth client, the redirect
// URLs, copying the URL and key into the app. SUPABASE.md steps 1-3 and 5.
//
// RE-RUNNING IS SAFE, and that is the point of most of the decisions below. Both SQL files are
// idempotent and a deploy is a deploy. The token is the one step that is NOT: replacing it locks out
// every admin holding the old one, so it is only ever created when none exists -- neither a stored row
// nor the `DBUI_CSP_REPORT_TOKEN` secret an older setup used -- unless --new-token says to replace it.
//
// The first token is written straight into public.csp_report_token rather than set as a secret. The CLI
// login is the authorisation either way, the row wins over the secret, and it is live at once instead
// of waiting for a secret to reach the running function. The SQL carrying it goes through a temp file
// (deleted immediately), never a command line.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- the pure half, tested in dev/test/setup-supabase.test.js -------------------------------------

export function parseArgs(argv) {
  const o = { ref: '', cspOnly: false, newToken: false, site: 'https://dbui.ddns.net', check: true, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-ref') o.ref = argv[++i] || '';
    else if (a === '--csp-only') o.cspOnly = true;
    else if (a === '--new-token') o.newToken = true;
    else if (a === '--site') o.site = argv[++i] || '';
    else if (a === '--no-check') o.check = false;
    else o.errors.push('unknown argument: ' + a);
  }
  if (!/^[a-z0-9]{20}$/.test(o.ref)) o.errors.push('--project-ref <ref> is required: the 20-character id in the project URL');
  return o;
}

// The one decision that is not idempotent. 'create' and 'replace' both print a new token; 'keep' never does.
export function tokenAction({ storedRows, secretSet, newToken }) {
  if (newToken) return 'replace';
  if (storedRows > 0 || secretSet) return 'keep';
  return 'create';
}

// base64url, so it is safe both in a query string and inside a SQL literal -- asserted, not assumed,
// because this string is spliced into SQL.
export function newToken() {
  const t = randomBytes(32).toString('base64url');
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) throw new Error('unexpected token shape');
  return t;
}
export function tokenSql(token, replace) {
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error('refusing to write a token that is not base64url');
  return "insert into public.csp_report_token (id, token) values (true, '" + token + "') " +
    (replace ? 'on conflict (id) do update set token = excluded.token' : 'on conflict (id) do nothing') + ' returning 1 as written';
}

// --- the shell around it ----------------------------------------------------------------------------

function supabase(args) {
  // shell on Windows, where npx is a .cmd. No argument carries spaces or quotes: SQL goes through -f.
  const r = spawnSync('npx', ['-y', 'supabase@latest', ...args], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n');
    throw new Error('supabase ' + args[0] + ' ' + (args[1] || '') + ' failed:\n' + msg +
      (/login|access token|unauthor/i.test(msg) ? '\n-> run: npx supabase@latest login' : ''));
  }
  return r.stdout || '';
}

export function query(ref, sqlOrFile, { isFile } = {}) {
  let file = sqlOrFile, dir = null;
  if (!isFile) { dir = mkdtempSync(join(tmpdir(), 'dbui-sql-')); file = join(dir, 'q.sql'); writeFileSync(file, sqlOrFile); }
  try {
    const out = supabase(['db', 'query', '--linked', '--project-ref', ref, '--output-format', 'json', '-f', file]);
    const json = JSON.parse(out.slice(out.indexOf('{')));
    return json.rows || [];
  } finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}

function step(n, text) { console.log('\n[' + n + '] ' + text); }

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.errors.length) { console.error(o.errors.join('\n') + '\n\nusage: npm run supabase:setup -- --project-ref <ref> [--csp-only] [--new-token] [--site <url>] [--no-check]'); process.exit(2); }

  if (!o.cspOnly) { step(1, 'App schema (supabase-schema.sql)'); query(o.ref, join(ROOT, 'supabase-schema.sql'), { isFile: true }); console.log('    applied'); }
  else console.log('[1] App schema: skipped (--csp-only)');

  step(2, 'CSP collector storage (supabase/csp-reports.sql)');
  query(o.ref, join(ROOT, 'supabase', 'csp-reports.sql'), { isFile: true });
  console.log('    applied');

  step(3, 'Checking the token functions exist');
  const fns = query(o.ref, "select count(*)::int as n from pg_proc where proname in ('csp_report_token_ok', 'csp_report_rotate')");
  if (!fns[0] || fns[0].n !== 2) throw new Error('csp-reports.sql ran but the token functions are missing -- rerun with --debug on the db query');
  console.log('    both present');

  step(4, 'Deploying the csp-report Edge Function');
  supabase(['functions', 'deploy', 'csp-report', '--no-verify-jwt', '--project-ref', o.ref]);
  console.log('    deployed');

  step(5, 'Read token');
  const stored = query(o.ref, 'select count(*)::int as n from public.csp_report_token')[0].n;
  let secretSet = false;
  try { secretSet = /DBUI_CSP_REPORT_TOKEN/.test(supabase(['secrets', 'list', '--project-ref', o.ref, '--output', 'json'])); } catch (e) { /* unknown: treated as unset */ }
  const action = tokenAction({ storedRows: stored, secretSet, newToken: o.newToken });
  let token = '';
  if (action === 'keep') {
    console.log('    kept: one is already set (' + (stored ? 'stored' : 'the DBUI_CSP_REPORT_TOKEN secret') + ').');
    console.log('    Rotate it in Settings -> Security policy reports, or rerun with --new-token if it is lost.');
  } else {
    token = newToken();
    const wrote = query(o.ref, tokenSql(token, action === 'replace'));
    if (!wrote.length) throw new Error('the token row was not written');
    console.log('    ' + (action === 'replace' ? 'REPLACED -- the previous token no longer opens the log.' : 'created.'));
    console.log('\n    ' + token + '\n');
    console.log('    Shown once. Paste it into Settings -> Security policy reports (it is kept in that browser),');
    console.log('    then press Rotate token there if this terminal is not somewhere a token should live.');
  }

  if (!o.check) { console.log('\n[6] Check: skipped (--no-check)'); return; }
  step(6, 'Checking the deployment (' + o.site + ')');
  const r = spawnSync(process.execPath, [join(ROOT, 'dev', 'check-supabase.mjs'), o.site], {
    cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, token ? { DBUI_CSP_REPORT_TOKEN: token } : {})
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
}
