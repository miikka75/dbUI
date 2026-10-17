#!/usr/bin/env node
// setup-firebase-auth.mjs — sign-in without Google for a Firebase project, and the rules that go with it, in
// one re-runnable command. Asks for whatever the flags leave out.
//
//   cd dev && npm run firebase:auth -- --project <firebase-project-id> [--site <url>] [--deploy-rules|--no-deploy-rules]
//                                      [--dry-run] [--yes]
//
// Needs the Google Cloud CLI (`gcloud auth login` once) for the auth settings, and the Firebase CLI for the
// rules. What it sets, through the Identity Toolkit admin API:
//   - Email/Password on, with Email link (passwordless) sign-in -- the app emails a link; Firebase sends it
//     itself, so there is no mail server to configure
//   - the deployed site's host (and localhost) among the authorized domains, keeping the ones already there
// and then, when asked, `firebase deploy --only firestore:rules,storage` -- the rules only count a VERIFIED
// email (signedIn()), which is what makes adding a sign-in method safe.
import { spawnSync } from 'node:child_process';
import { asker } from './ask.mjs';
import { pathToFileURL } from 'node:url';

// --- the pure half, tested in dev/test/setup-auth.test.js ----------------------------------------------

export function parseArgs(argv) {
  const o = { project: '', site: '', deployRules: null, dryRun: false, yes: false, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') o.project = argv[++i] || '';
    else if (a === '--site') o.site = argv[++i] || '';
    else if (a === '--deploy-rules') o.deployRules = true;
    else if (a === '--no-deploy-rules') o.deployRules = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else o.errors.push('unknown argument: ' + a);
  }
  return o;
}

export function validProject(id) { return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(String(id || '')); }
export function hostOf(u) { try { return new URL(String(u || '').trim()).hostname; } catch (e) { return ''; } }

// The authorized domains after adding the site's host and localhost, keeping what is there, in order.
export function mergeDomains(existing, host) {
  const out = (existing || []).slice();
  [host, 'localhost'].forEach((d) => { if (d && out.indexOf(d) < 0) out.push(d); });
  return out;
}

export function buildPatch(domains) {
  return { mask: 'signIn.email,authorizedDomains', body: { signIn: { email: { enabled: true, passwordRequired: false } }, authorizedDomains: domains } };
}

// --- the I/O half ---------------------------------------------------------------------------------------------

function run(cmd, args, opts) {
  // shell on Windows: gcloud and firebase are .cmd shims there
  return spawnSync(cmd, args, Object.assign({ encoding: 'utf8', shell: process.platform === 'win32' }, opts || {}));
}

function gcloudToken() {
  const r = run('gcloud', ['auth', 'print-access-token']);
  if (r.error || r.status !== 0) {
    throw new Error('Could not get a Google Cloud token. Install the Google Cloud CLI (cloud.google.com/sdk) and run `gcloud auth login`.\n' + ((r.stderr || '') + '').trim());
  }
  return r.stdout.trim();
}

async function api(method, project, token, mask, body) {
  const url = 'https://identitytoolkit.googleapis.com/admin/v2/projects/' + project + '/config' + (mask ? '?updateMask=' + encodeURIComponent(mask) : '');
  const r = await fetch(url, {
    method, headers: Object.assign({ Authorization: 'Bearer ' + token, 'X-Goog-User-Project': project }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(method + ' auth config: HTTP ' + r.status + ' ' + text.slice(0, 400));
  return JSON.parse(text || '{}');
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.errors.length) { console.error(o.errors.join('\n')); process.exit(2); }
  const a = asker();
  try {
    let project = o.project;
    while (!validProject(project)) project = await a.ask('Firebase project id (Project settings -> General)');
    let host = hostOf(o.site);
    while (!host) host = hostOf(await a.ask('Site URL (the deployed app)', { def: 'https://dbui.ddns.net/' }));

    const token = o.dryRun ? '' : gcloudToken();
    const current = o.dryRun ? { authorizedDomains: [] } : await api('GET', project, token);
    const patch = buildPatch(mergeDomains(current.authorizedDomains, host));
    console.log('\nWill set on ' + project + ' (' + patch.mask + '):\n' + JSON.stringify(patch.body, null, 2));
    const deploy = o.deployRules !== null ? o.deployRules : await a.confirm('Also deploy firestore.rules and storage.rules', true);
    if (o.dryRun) { console.log('\n--dry-run: nothing sent' + (deploy ? '; would then run firebase deploy --only firestore:rules,storage' : '') + '.'); return; }
    if (!o.yes && !(await a.confirm('\nApply', true))) { console.log('Nothing changed.'); return; }

    const got = await api('PATCH', project, token, patch.mask, patch.body);
    const email = (got.signIn || {}).email || {};
    if (!email.enabled || email.passwordRequired) { console.error('Sent, but email-link sign-in did not read back as on.'); process.exit(1); }
    console.log('Email link sign-in is on; authorized domains: ' + (got.authorizedDomains || []).join(', '));

    if (deploy) {
      console.log('\nfirebase deploy --only firestore:rules,storage --project ' + project);
      const r = run('firebase', ['deploy', '--only', 'firestore:rules,storage', '--project', project], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
      if (r.error || r.status !== 0) { console.error('The rules deploy failed (is the Firebase CLI installed and logged in? npm i -g firebase-tools; firebase login).'); process.exit(1); }
    }
    console.log('\nDone. Firebase sends the sign-in emails itself; the text is under Authentication -> Templates.');
  } finally { a.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
