#!/usr/bin/env node
// setup-supabase-auth.mjs — email sign-in for a hosted Supabase project: the code-and-link emails and the
// mail server that sends them, in one re-runnable command. Asks for whatever flags and environment leave out.
//
//   cd dev && npm run supabase:auth -- --project-ref <ref> [--site <url>] [--app-name <name>]
//            [--smtp resend|brevo|custom|none] [--smtp-host h] [--smtp-port p] [--smtp-user u]
//            [--smtp-from <address>] [--rate-limit <emails/hour>] [--dry-run] [--yes]
//
//   SUPABASE_ACCESS_TOKEN  a personal access token (supabase.com/dashboard/account/tokens); asked if unset
//   SMTP_PASS              the mail server password or API key; asked (hidden) if unset -- never a flag,
//                          so it stays out of the shell history
//
// What it sets, through the Management API (PATCH /v1/projects/<ref>/config/auth), and nothing else:
//   - email sign-in on, confirmation ON (mailer_autoconfirm false: an unconfirmed address counts for
//     nothing in the policies anyway -- app_email_verified)
//   - the site URL and redirect URLs (the deployed site, and localhost for dev)
//   - the Magic Link and Confirm signup emails, both carrying the 6-digit code ({{ .Token }}) and the link
//     ({{ .ConfirmationURL }}); a first-time address gets the signup one, so both need the code
//   - the SMTP server (Supabase's own mailer reaches only the project's team, a few emails an hour) and
//     the email rate limit
// It then reads the config back and names any field that did not take.
//
// What it cannot do: prove you own the sender's domain to the mail service. That is DNS records at your
// registrar, which the service shows you; until then it refuses to send.
import { asker } from './ask.mjs';
import { pathToFileURL } from 'node:url';

// --- the pure half, tested in dev/test/setup-auth.test.js ----------------------------------------------

export const SMTP_PRESETS = {
  resend: { host: 'smtp.resend.com', port: '465', user: 'resend', passHint: 'your Resend API key (re_...)' },
  brevo: { host: 'smtp-relay.brevo.com', port: '587', user: '', passHint: 'your Brevo SMTP key' }
};

export function parseArgs(argv) {
  const o = { ref: '', site: '', appName: '', smtp: '', smtpHost: '', smtpPort: '', smtpUser: '', smtpFrom: '', rateLimit: '', dryRun: false, yes: false, errors: [] };
  const val = { '--project-ref': 'ref', '--site': 'site', '--app-name': 'appName', '--smtp': 'smtp', '--smtp-host': 'smtpHost',
    '--smtp-port': 'smtpPort', '--smtp-user': 'smtpUser', '--smtp-from': 'smtpFrom', '--rate-limit': 'rateLimit' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (val[a]) o[val[a]] = argv[++i] || '';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else o.errors.push('unknown argument: ' + a);
  }
  if (o.smtp && ['resend', 'brevo', 'custom', 'none'].indexOf(o.smtp) < 0) o.errors.push('--smtp is resend, brevo, custom or none');
  return o;
}

export function validRef(ref) { return /^[a-z0-9]{20}$/.test(String(ref || '')); }
export function siteUrl(u) {
  try { const x = new URL(String(u || '').trim()); return (x.protocol === 'https:' || x.hostname === 'localhost') ? x.origin + (x.pathname.endsWith('/') ? x.pathname : x.pathname + '/') : ''; } catch (e) { return ''; }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function emailTemplate(appName, heading) {
  return '<h2>' + esc(heading) + '</h2>'
    + '<p>Your ' + esc(appName) + ' sign-in code: <strong style="font-size:1.4em;letter-spacing:0.1em">{{ .Token }}</strong></p>'
    + '<p>Or <a href="{{ .ConfirmationURL }}">open this link to sign in</a>.</p>'
    + '<p style="color:#888">If you did not ask for this, ignore this email.</p>';
}

// The auth config PATCH. `smtp` null leaves the mail server as it is (and the rate limit with it).
export function buildAuthConfig({ site, appName, smtp, rateLimit }) {
  const cfg = {
    external_email_enabled: true,
    mailer_autoconfirm: false,
    site_url: site,
    uri_allow_list: [site, 'http://localhost:3000/'].join(','),
    mailer_subjects_magic_link: appName + ' sign-in code',
    mailer_templates_magic_link_content: emailTemplate(appName, 'Sign in to ' + appName),
    mailer_subjects_confirmation: appName + ' sign-in code',
    mailer_templates_confirmation_content: emailTemplate(appName, 'Welcome to ' + appName)
  };
  if (smtp) {
    Object.assign(cfg, { smtp_host: smtp.host, smtp_port: String(smtp.port), smtp_user: smtp.user, smtp_pass: smtp.pass,
      smtp_admin_email: smtp.from, smtp_sender_name: appName });
    const n = Number(rateLimit);
    if (n > 0) cfg.rate_limit_email_sent = n;
  }
  return cfg;
}

export function masked(cfg) {
  const o = Object.assign({}, cfg);
  if (o.smtp_pass) o.smtp_pass = '********';
  ['mailer_templates_magic_link_content', 'mailer_templates_confirmation_content'].forEach((k) => { if (o[k]) o[k] = '(' + o[k].length + ' chars, with {{ .Token }} and the link)'; });
  return o;
}

// Fields that read back differently from what was sent (the password is never read back).
export function mismatches(sent, got) {
  return Object.keys(sent).filter((k) => k !== 'smtp_pass' && String(got && got[k]) !== String(sent[k]));
}

// --- the I/O half ---------------------------------------------------------------------------------------------

async function api(method, ref, token, body) {
  const r = await fetch('https://api.supabase.com/v1/projects/' + ref + '/config/auth', {
    method, headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(method + ' auth config: HTTP ' + r.status + ' ' + text.slice(0, 300));
  try { return JSON.parse(text); } catch (e) { return {}; }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.errors.length) { console.error(o.errors.join('\n')); process.exit(2); }
  const a = asker();
  try {
    let ref = o.ref;
    while (!validRef(ref)) ref = await a.ask('Project ref (the 20-character id in supabase.com/dashboard/project/<ref>)');
    let token = process.env.SUPABASE_ACCESS_TOKEN || '';
    if (!token && !o.dryRun) token = await a.ask('Personal access token (supabase.com/dashboard/account/tokens, sbp_...)', { secret: true });
    let site = siteUrl(o.site);
    while (!site) site = siteUrl(await a.ask('Site URL (the deployed app, https://...)', { def: 'https://dbui.ddns.net/' }));
    const appName = o.appName || await a.ask('Name in the emails', { def: 'Fitness Club' });

    let kind = o.smtp || await a.choose('Mail server', ['resend', 'brevo', 'custom', 'none'], 'resend');
    let smtp = null;
    if (kind !== 'none') {
      const p = SMTP_PRESETS[kind] || { host: '', port: '587', user: '', passHint: 'the mail server password' };
      const host = o.smtpHost || (p.host && kind !== 'custom' ? p.host : await a.ask('SMTP host', { def: p.host }));
      const port = o.smtpPort || (kind !== 'custom' ? p.port : await a.ask('SMTP port', { def: p.port }));
      const user = o.smtpUser || p.user || await a.ask('SMTP username');
      const pass = process.env.SMTP_PASS || (o.dryRun ? 'dry-run' : await a.ask('SMTP password (' + p.passHint + ')', { secret: true }));
      let from = o.smtpFrom;
      while (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from || '')) from = await a.ask('Sender address (on a domain verified with the mail service)');
      smtp = { host, port, user, pass, from };
    }
    const rateLimit = smtp ? (o.rateLimit || await a.ask('Emails per hour', { def: '100' })) : '';
    const cfg = buildAuthConfig({ site, appName, smtp, rateLimit });

    console.log('\nWill set on project ' + ref + ':\n' + JSON.stringify(masked(cfg), null, 2));
    if (o.dryRun) { console.log('\n--dry-run: nothing sent.'); return; }
    if (!o.yes && !(await a.confirm('\nApply', true))) { console.log('Nothing changed.'); return; }

    await api('PATCH', ref, token, cfg);
    const got = await api('GET', ref, token);
    const off = mismatches(cfg, got);
    if (off.length) { console.error('\nSent, but these read back differently: ' + off.join(', ')); process.exit(1); }
    console.log('\nDone: email sign-in is configured' + (smtp ? ', sending through ' + smtp.host : ' (mail server unchanged)') + '.');
    if (smtp) console.log('Next: verify ' + smtp.from.split('@')[1] + ' with the mail service (the DNS records it shows you), or it will not send.');
  } finally { a.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
