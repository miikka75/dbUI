const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Public tables and open sign-up, enforced by the real supabase-schema.sql policies on PGlite: a visitor
// (Postgres `anon`) reads the public tables, the lists they name, the schema and the translations -- and
// nothing else; a signed-in account with no record may write its own, exactly the mirrored grant.
const { createPgliteStorage } = require('../../storage-pglite');
const { createKvBackend } = require('../../backend-kv');

const SCHEMA = {
  newUser: { role: 'viewer', tables: { classes: 'r' }, open: true },
  tables: {
    classes: { public: true, columns: [{ name: 'title' }, { name: 'coach', type: 'select', list: 'coaches' }] },
    secrets: { columns: [{ name: 'note' }] },
    diary: { columns: [{ name: 'owner', type: 'owner' }, { name: 'text' }], ownerWritable: ['text'] }
  },
  views: []
};

let S, B, U;
let email = 'admin@x.com';
const as = (e) => { email = e; S.setCaller(e); };
const rows = async (store) => (await S._all(store)).map((r) => r.key).sort();

before(async () => {
  S = await createPgliteStorage({});
  const kv = createKvBackend(S, {
    name: 'test', myEmail: () => email,
    noUsers: () => S._query('select public.app_no_users() as none').then((r) => !!(r && r.rows && r.rows[0] && r.rows[0].none)).catch(() => false)
  });
  B = kv.backend; U = kv.users;
  as('admin@x.com');
  await U.setUserRole('admin@x.com', 'admin', 'admin@x.com', 'all');
  await B.saveSchema(SCHEMA);
  await S.put('classes__active', 'c1', { id: 'c1', title: 'Spin', coach: 'Kim' });
  await S.put('secrets__active', 's1', { id: 's1', note: 'hush' });
  await S.put('diary__active', 'd1', { id: 'd1', owner: 'ann@x.com', text: 'mine' });
  await B.saveLists({ coaches: ['Kim'], other: ['x'] });
});
after(async () => { if (S) await S.close(); });

describe('public tables (anon) and open sign-up (Postgres policies)', () => {
  it('the mirror says which tables, which lists, and the sign-up grant', async () => {
    as('admin@x.com');
    const m = await S.getMeta('ownerTables');
    assert.deepEqual(m.public, { tables: ['classes'], lists: ['coaches'] });
    assert.deepEqual(m.signup, { role: 'viewer', tables: { classes: 'r' }, rwTables: [] });
  });

  it('a visitor reads the public table, its list, the schema -- and nothing else', async () => {
    as('');
    assert.deepEqual(await rows('classes__active'), ['c1']);
    assert.deepEqual(await rows('secrets__active'), []);
    assert.deepEqual(await rows('diary__active'), []);
    assert.ok(await S.getMeta('schema'));
    assert.equal(await S.getMeta('config'), undefined);
    assert.equal(await S.getMeta('users'), undefined);
    assert.ok(await S.get('_lists', 'coaches'));
    assert.equal(await S.get('_lists', 'other'), undefined);
  });

  it('a visitor cannot write a public table', async () => {
    as('');
    await assert.rejects(S.put('classes__active', 'c2', { id: 'c2', title: 'Hack' }));
  });

  it('a signed-in stranger reads the public table too, and signs up with exactly the grant', async () => {
    as('new@x.com');
    assert.deepEqual(await rows('classes__active'), ['c1']);
    await U.selfRegister();
    as('admin@x.com');
    const rec = await S.get('_users', 'new@x.com');
    assert.equal(rec.role, 'viewer');
    assert.deepEqual(rec.tables, { classes: 'r' });
  });

  it('nobody signs up for more, or for someone else', async () => {
    as('greedy@x.com');
    await assert.rejects(S.put('_users', 'greedy@x.com', { role: 'admin', user: 'greedy@x.com', tables: 'all' }));
    await assert.rejects(S.put('_users', 'greedy@x.com', { role: 'viewer', user: 'greedy@x.com', tables: { classes: 'r', secrets: 'r' }, rwTables: [] }));
    await assert.rejects(S.put('_users', 'victim@x.com', { role: 'viewer', user: 'victim@x.com', tables: { classes: 'r' }, rwTables: [] }));
    as('admin@x.com');
    assert.equal(await S.get('_users', 'greedy@x.com'), undefined);
    assert.equal(await S.get('_users', 'victim@x.com'), undefined);
  });

  it('with sign-up closed, a self-written record is refused', async () => {
    as('admin@x.com');
    await B.saveSchema(Object.assign({}, SCHEMA, { newUser: { role: 'viewer', tables: { classes: 'r' } } }));
    as('late@x.com');
    await assert.rejects(U.selfRegister());
    await assert.rejects(S.put('_users', 'late@x.com', { role: 'viewer', user: 'late@x.com', tables: { classes: 'r' }, rwTables: [] }));
  });
});
