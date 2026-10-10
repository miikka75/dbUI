// setup-supabase.test.js — the decisions in dev/setup-supabase.mjs that are not plain shell-outs.
// The one that matters: re-running setup must never replace a token somebody holds, unless asked.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let S;
before(async () => { S = await import(pathToFileURL(path.join(__dirname, '..', 'setup-supabase.mjs')).href); });

describe('setup-supabase — the token is the one step that is not idempotent', () => {
  it('creates one only when there is none, stored or as the old secret', () => {
    assert.equal(S.tokenAction({ storedRows: 0, secretSet: false, newToken: false }), 'create');
    assert.equal(S.tokenAction({ storedRows: 1, secretSet: false, newToken: false }), 'keep');
    assert.equal(S.tokenAction({ storedRows: 0, secretSet: true, newToken: false }), 'keep');
  });
  it('--new-token replaces whatever is there', () => {
    assert.equal(S.tokenAction({ storedRows: 1, secretSet: true, newToken: true }), 'replace');
  });
  it('a first write never overwrites a row a racing run made; a replace does', () => {
    assert.match(S.tokenSql('a'.repeat(43), false), /on conflict \(id\) do nothing/);
    assert.match(S.tokenSql('a'.repeat(43), true), /do update set token = excluded\.token/);
  });
  it('mints 43 base64url characters, and refuses to splice anything else into SQL', () => {
    assert.match(S.newToken(), /^[A-Za-z0-9_-]{43}$/);
    assert.throws(() => S.tokenSql("x'; drop table kv; --" + 'a'.repeat(40), false));
  });
});

describe('setup-supabase — arguments', () => {
  it('needs a project ref, and says so', () => {
    assert.match(S.parseArgs([]).errors.join(' '), /--project-ref <ref> is required/);
    assert.deepEqual(S.parseArgs(['--project-ref', 'csbyjsibxjszduxqetbf']).errors, []);
  });
  it('reads the flags, and names an unknown one rather than ignoring it', () => {
    const o = S.parseArgs(['--project-ref', 'csbyjsibxjszduxqetbf', '--csp-only', '--new-token', '--site', 'https://x.example', '--no-check', '--force']);
    assert.deepEqual([o.cspOnly, o.newToken, o.site, o.check], [true, true, 'https://x.example', false]);
    assert.deepEqual(o.errors, ['unknown argument: --force']);
  });
});
