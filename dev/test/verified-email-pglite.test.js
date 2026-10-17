const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// app_email() -- the identity every policy keys on -- counts an email only once it is VERIFIED: the
// provider said so, or the sign-in itself proved the mailbox (an emailed code or link, OAuth), or
// auth.users records the confirmation. Run against the real supabase-schema.sql on PGlite, with a stand-in
// for Supabase's auth.users table so the last branch is exercised too.
const { createPgliteStorage } = require('../../storage-pglite');

let S;
const asClaims = async (claims) => {
  await S._query('reset role');
  await S._query('select set_config($1, $2, false)', ['request.jwt.claims', JSON.stringify(claims)]);
  await S._query('set role authenticated');
  const r = await S._query('select public.app_email() as e');
  await S._query('reset role');
  return r.rows[0].e;
};

before(async () => {
  S = await createPgliteStorage({});
  await S._query('create table if not exists auth.users (id uuid primary key, email_confirmed_at timestamptz)');
  await S._query("insert into auth.users values ('11111111-1111-1111-1111-111111111111', now()), ('22222222-2222-2222-2222-222222222222', null)");
});
after(async () => { if (S) await S.close(); });

describe('app_email() needs a verified email', () => {
  it('the provider says verified (Google puts it in user_metadata)', async () => {
    assert.equal(await asClaims({ email: 'Ann@x.com', user_metadata: { email_verified: true } }), 'ann@x.com');
  });
  it('the sign-in proved the mailbox: an emailed code or link, or OAuth', async () => {
    assert.equal(await asClaims({ email: 'ann@x.com', amr: [{ method: 'otp' }] }), 'ann@x.com');
    assert.equal(await asClaims({ email: 'ann@x.com', amr: [{ method: 'magiclink' }] }), 'ann@x.com');
    assert.equal(await asClaims({ email: 'ann@x.com', amr: [{ method: 'oauth' }] }), 'ann@x.com');
  });
  it('a password sign-in counts only if auth.users records the confirmation', async () => {
    assert.equal(await asClaims({ email: 'ann@x.com', sub: '11111111-1111-1111-1111-111111111111', amr: [{ method: 'password' }] }), 'ann@x.com');
    assert.equal(await asClaims({ email: 'admin@x.com', sub: '22222222-2222-2222-2222-222222222222', amr: [{ method: 'password' }] }), null);
    assert.equal(await asClaims({ email: 'admin@x.com', sub: '33333333-3333-3333-3333-333333333333', amr: [{ method: 'password' }] }), null);
  });
  it('no email is nobody', async () => {
    assert.equal(await asClaims({}), null);
  });
});
