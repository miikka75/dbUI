// setup-auth.test.js — the decisions in dev/setup-supabase-auth.mjs and dev/setup-firebase-auth.mjs that are
// not plain API calls: what is sent, what is hidden, and what is kept.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let SB, FB;
before(async () => {
  SB = await import(pathToFileURL(path.join(__dirname, '..', 'setup-supabase-auth.mjs')).href);
  FB = await import(pathToFileURL(path.join(__dirname, '..', 'setup-firebase-auth.mjs')).href);
});

describe('setup-supabase-auth', () => {
  const smtp = { host: 'smtp.resend.com', port: '465', user: 'resend', pass: 're_secret', from: 'noreply@gym.fi' };

  it('keeps confirmation on, and both emails carry the code and the link', () => {
    const c = SB.buildAuthConfig({ site: 'https://gym.fi/', appName: 'Fitness <Club>', smtp, rateLimit: '50' });
    assert.equal(c.mailer_autoconfirm, false);
    assert.equal(c.external_email_enabled, true);
    for (const k of ['mailer_templates_magic_link_content', 'mailer_templates_confirmation_content']) {
      assert.match(c[k], /\{\{ \.Token \}\}/);
      assert.match(c[k], /\{\{ \.ConfirmationURL \}\}/);
      assert.match(c[k], /Fitness &lt;Club&gt;/);   // the name is escaped into the HTML
    }
    assert.equal(c.uri_allow_list, 'https://gym.fi/,http://localhost:3000/');
    assert.equal(c.smtp_host, 'smtp.resend.com');
    assert.equal(c.smtp_port, '465');
    assert.equal(c.rate_limit_email_sent, 50);
  });

  it('without a mail server, leaves the SMTP settings and the rate limit alone', () => {
    const c = SB.buildAuthConfig({ site: 'https://gym.fi/', appName: 'Gym', smtp: null, rateLimit: '50' });
    assert.equal(Object.keys(c).filter((k) => /^smtp_|^rate_limit/.test(k)).length, 0);
  });

  it('never prints the password, and never compares it on read-back', () => {
    const c = SB.buildAuthConfig({ site: 'https://gym.fi/', appName: 'Gym', smtp, rateLimit: '' });
    assert.equal(SB.masked(c).smtp_pass, '********');
    assert.doesNotMatch(JSON.stringify(SB.masked(c)), /re_secret/);
    assert.deepEqual(SB.mismatches(c, Object.assign({}, c, { smtp_pass: '' })), []);
    assert.deepEqual(SB.mismatches(c, Object.assign({}, c, { smtp_host: 'other' })), ['smtp_host']);
  });

  it('takes an https site URL (or localhost) and refuses anything else', () => {
    assert.equal(SB.siteUrl('https://gym.fi'), 'https://gym.fi/');
    assert.equal(SB.siteUrl('https://gym.fi/app'), 'https://gym.fi/app/');
    assert.equal(SB.siteUrl('http://localhost:3000'), 'http://localhost:3000/');
    assert.equal(SB.siteUrl('http://gym.fi'), '');
    assert.equal(SB.siteUrl('not a url'), '');
    assert.equal(SB.validRef('abcdefghijklmnopqrst'), true);
    assert.equal(SB.validRef('short'), false);
  });

  it('refuses an unknown flag or mail server', () => {
    assert.deepEqual(SB.parseArgs(['--smtp', 'resend', '--yes']).errors, []);
    assert.equal(SB.parseArgs(['--smtp', 'gmail']).errors.length, 1);
    assert.ok(SB.parseArgs(['--password', 'x']).errors.some((e) => /--password/.test(e)));   // no password flag at all
  });
});

describe('setup-firebase-auth', () => {
  it('adds the site and localhost to the authorized domains, keeping what is there, once', () => {
    assert.deepEqual(FB.mergeDomains(['my-app.firebaseapp.com', 'localhost'], 'gym.fi'), ['my-app.firebaseapp.com', 'localhost', 'gym.fi']);
    assert.deepEqual(FB.mergeDomains(['gym.fi'], 'gym.fi'), ['gym.fi', 'localhost']);
    assert.deepEqual(FB.mergeDomains(undefined, 'gym.fi'), ['gym.fi', 'localhost']);
  });
  it('turns on passwordless email-link sign-in, touching only those two settings', () => {
    const p = FB.buildPatch(['gym.fi']);
    assert.equal(p.mask, 'signIn.email,authorizedDomains');
    assert.deepEqual(p.body.signIn.email, { enabled: true, passwordRequired: false });
  });
  it('reads the project id and site', () => {
    assert.equal(FB.validProject('my-gym-app'), true);
    assert.equal(FB.validProject('X'), false);
    assert.equal(FB.hostOf('https://gym.fi/app/'), 'gym.fi');
    assert.deepEqual(FB.parseArgs(['--project', 'my-gym-app', '--no-deploy-rules']), { project: 'my-gym-app', site: '', deployRules: false, dryRun: false, yes: false, errors: [] });
  });
});
