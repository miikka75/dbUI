// storage-pglite.test.js — the dev storage adapter running the REAL production policy.
//
// dev/test/supabase-rls.test.js already proves supabase-schema.sql behaves correctly by driving SQL
// directly. This suite proves something different and, for phase 02, the point: the adapter the DEV
// SERVER uses goes through those same policies, so a denial in production is a denial in dev. If these
// pass, dev has stopped being an independent implementation of the access model.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createPgliteStorage } = require('../storage-pglite');

let S;
before(async () => { S = await createPgliteStorage(); });
after(async () => { if (S) await S.close(); });

const denied = (p) => p.then(() => 'ok', (e) => (/row-level security/.test(e.message) ? 'denied' : 'threw: ' + e.message));

describe('storage-pglite — the schema is the production one', () => {
  it('applies supabase-schema.sql and exposes its policy helpers', async () => {
    // If these functions exist, the file that defines them ran -- no fixture, no reimplementation.
    const r = await S._query('select public.app_no_users() as b');
    assert.equal(r.rows[0].b, true, 'a fresh database has no members');
  });
});

describe('storage-pglite — bootstrap, then the registry closes it', () => {
  it('with no members, the first signed-in caller acts as admin', async () => {
    S.setCaller('first@x.com');
    await S.setMeta('schema', { tables: { tasks: { columns: [{ name: 'id' }, { name: 'title' }] } } });
    assert.deepEqual(await S.getMeta('schema'), { tables: { tasks: { columns: [{ name: 'id' }, { name: 'title' }] } } });
  });

  it('a caller with no email claim is refused', async () => {
    S.setCaller(null);
    assert.equal(await denied(S.put('tasks__active', 'x', { id: 'x' })), 'denied');
  });

  it('once members exist, a viewer with no grant cannot write a table', async () => {
    // Seeded as owner: creating the registry is not a user action.
    await S._seed('_users', 'admin@x.com',  { role: 'admin',  user: 'admin@x.com',  tables: 'all' });
    await S._seed('_users', 'viewer@x.com', { role: 'viewer', user: 'viewer@x.com', tables: [] });

    S.setCaller('viewer@x.com');
    assert.equal(await denied(S.put('tasks__active', 'r9', { id: 'r9', title: 'nope' })), 'denied');

    S.setCaller('admin@x.com');
    assert.equal(await denied(S.put('tasks__active', 'r9', { id: 'r9', title: 'yes' })), 'ok');
  });

  it('the denial is the SAME whether the policy errors or filters the row away', async () => {
    // USING-filtered rows come back as zero affected rows rather than an exception. A caller must not be
    // able to tell those apart, or "your write silently did nothing" becomes indistinguishable from
    // success -- which is how a fail-open bug hides.
    S.setCaller('viewer@x.com');
    assert.equal(await denied(S.delete('tasks__active', 'r9')), 'ok');   // delete of an unreadable row is a no-op
    S.setCaller('admin@x.com');
    assert.ok(await S.get('tasks__active', 'r9'), 'the row the viewer could not see is still there');
  });
});

describe('storage-pglite — merge semantics match the other backends', () => {
  it('put() merges a partial patch; the policy judges the MERGED row', async () => {
    S.setCaller('admin@x.com');
    await S.put('tasks__active', 'm1', { id: 'm1', title: 'A', status: 'open' });
    await S.put('tasks__active', 'm1', { status: 'done' });          // patch, not a replace
    assert.deepEqual(await S.get('tasks__active', 'm1'), { id: 'm1', title: 'A', status: 'done' });
  });

  it('setMeta() REPLACES rather than merging, like StorageSupabase/StorageFirestore', async () => {
    S.setCaller('admin@x.com');
    await S.setMeta('config', { a: 1, b: 2 });
    await S.setMeta('config', { a: 9 });
    assert.deepEqual(await S.getMeta('config'), { a: 9 }, 'b must be gone -- setMeta is a replace');
  });

  it('setMeta() boxes a non-object as { _value }, so BackendHelpers unwraps it identically', async () => {
    S.setCaller('admin@x.com');
    await S.setMeta('scalar', 'hello');
    assert.deepEqual(await S.getMeta('scalar'), { _value: 'hello' });
  });

  it('getAll / _all read a whole store', async () => {
    S.setCaller('admin@x.com');
    const all = await S.getAll('tasks__active');
    assert.ok(all.length >= 2);
    const keyed = await S._all('tasks__active');
    assert.deepEqual(keyed.map((r) => r.key).sort(), all.map((r) => r.id).sort());
  });
});

describe('storage-pglite — identity is per-caller, not sticky', () => {
  it('switching callers switches what is visible, with no leakage between operations', async () => {
    // Role and request.jwt.claims are CONNECTION state on a single PGlite connection. If the adapter
    // ever stopped re-establishing identity inside each critical section, this is the test that would
    // catch it: the viewer would inherit the admin's role from the previous statement.
    S.setCaller('admin@x.com');
    assert.equal(await denied(S.put('tasks__active', 'sw1', { id: 'sw1' })), 'ok');
    S.setCaller('viewer@x.com');
    assert.equal(await denied(S.put('tasks__active', 'sw2', { id: 'sw2' })), 'denied');
    S.setCaller('admin@x.com');
    assert.equal(await denied(S.put('tasks__active', 'sw3', { id: 'sw3' })), 'ok');
  });

  it('concurrent operations under different callers do not interleave identities', async () => {
    // Fired without awaiting in between: the serializing queue is what keeps each one under its own
    // identity. Without it these would race on `set role` and the viewer's write could land as admin.
    S.setCaller('admin@x.com');
    const a = S.put('tasks__active', 'c1', { id: 'c1' });
    S.setCaller('viewer@x.com');
    const b = S.put('tasks__active', 'c2', { id: 'c2' });
    const [ra, rb] = await Promise.all([denied(a), denied(b)]);
    // Whichever order they run in, neither may be evaluated under the other's identity: the admin write
    // must succeed and the viewer write must be refused.
    assert.equal(ra, 'ok');
    assert.equal(rb, 'denied');
  });
});
