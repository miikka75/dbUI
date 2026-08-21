// supabase-rls.test.js — Executes the REAL supabase-schema.sql policies against a real PostgreSQL.
//
// Until now the Supabase access layer was the only one of the four with no behavioural coverage: the
// Firestore rules have an emulator suite, the dev server has HTTP tests, the client has unit tests, and
// the RLS had nothing but a static text-comparison (rules-parity.test.js). This runs the policies.
//
// HOW: @electric-sql/pglite is PostgreSQL compiled to WASM — a plain devDependency, no Docker, no
// service container, no JVM, so it runs in the existing `build` CI job alongside the unit tests rather
// than needing a lane of its own.
//
// WHAT IS REPRODUCED vs REAL SUPABASE:
//   - auth.jwt() is shimmed as a read of the `request.jwt.claims` GUC, which is exactly how Supabase
//     defines it. Every policy here bottoms out at auth.jwt() ->> 'email'.
//   - `set role authenticated` drops superuser, so RLS genuinely applies (a superuser bypasses it, and
//     a suite that forgot this would pass everything).
//   - The SECURITY DEFINER helpers are owned by the bootstrapping superuser, which is what lets them
//     read the FORCE-RLS kv table without recursing. In Supabase that role is `postgres` (BYPASSRLS).
//     So this validates the DESIGN; it cannot prove your project's role attributes.
//   - NOT covered: the storage.* policies (S-A). Stock Postgres has no `storage` schema, so that block
//     is stripped below and stays guarded by rules-parity.test.js only.
//
// THE SEMANTIC TRAP this suite exists to navigate: Firestore DENIES a forbidden read (it throws).
// Postgres RLS FILTERS it — a forbidden SELECT returns zero rows, and a forbidden UPDATE/DELETE reports
// zero affected rows, neither of which is an error. Only a WITH CHECK violation raises. So "denied" is
// asserted through the helpers below, never through try/catch alone.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STORAGE_MARKER = '-- ---------- Storage bucket';

let db;
const q = (sql, params) => db.query(sql, params);
const exec = (sql) => db.exec(sql);

// --- identity -------------------------------------------------------------------------------------
const asSuper = () => exec('reset role');                       // seeding / arranging
async function as(email) {
  await exec('reset role');
  await q(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(email ? { email } : {})]);
  await exec('set role authenticated');
}
const asSignedOut = () => as(null);                             // authenticated role, no email claim

// --- verdict helpers ------------------------------------------------------------------------------
const isRlsError = (e) => /row-level security|permission denied/i.test(e.message);

async function canRead(store, key) {
  const r = await q(`select 1 from public.kv where store = $1 and key = $2`, [store, key]);
  return r.rows.length > 0;
}
async function readKeys(store) {
  const r = await q(`select key from public.kv where store = $1 order by key`, [store]);
  return r.rows.map((x) => x.key);
}
async function tryInsert(store, key, value) {
  try {
    const r = await q(`insert into public.kv (store, key, value) values ($1, $2, $3::jsonb) returning key`,
      [store, key, JSON.stringify(value)]);
    return r.rows.length ? 'ok' : 'denied';
  } catch (e) { if (isRlsError(e)) return 'denied'; throw e; }
}
async function tryUpdate(store, key, value) {
  try {
    const r = await q(`update public.kv set value = $3::jsonb where store = $1 and key = $2 returning key`,
      [store, key, JSON.stringify(value)]);
    return r.rows.length ? 'ok' : 'denied';        // 0 rows = filtered out by USING, which IS a denial
  } catch (e) { if (isRlsError(e)) return 'denied'; throw e; }
}
async function tryDelete(store, key) {
  try {
    const r = await q(`delete from public.kv where store = $1 and key = $2 returning key`, [store, key]);
    return r.rows.length ? 'ok' : 'denied';
  } catch (e) { if (isRlsError(e)) return 'denied'; throw e; }
}
// The write path the app actually takes: the app_kv_merge RPC, with a PARTIAL patch.
async function tryMerge(store, key, patch) {
  try {
    await q(`select public.app_kv_merge($1, $2, $3::jsonb)`, [store, key, JSON.stringify(patch)]);
    return 'ok';
  } catch (e) { if (isRlsError(e)) return 'denied'; throw e; }
}
async function seed(store, key, value) {
  await asSuper();
  await q(`insert into public.kv (store, key, value) values ($1, $2, $3::jsonb)
           on conflict (store, key) do update set value = excluded.value`,
    [store, key, JSON.stringify(value)]);
}

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();

  // Roles must exist before the schema's REVOKE/GRANT statements name them.
  await exec(`create role authenticated; create role anon;`);

  // The auth.jwt() shim — Supabase's own definition, reproduced.
  await exec(`
    create schema auth;
    create or replace function auth.jwt() returns jsonb language sql stable as $shim$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
    $shim$;
    grant usage on schema auth to authenticated, anon;
  `);

  const full = fs.readFileSync(path.join(ROOT, 'supabase-schema.sql'), 'utf8');
  const cut = full.indexOf(STORAGE_MARKER);
  assert.ok(cut > 0, 'the storage section marker moved — this suite strips it by that comment');
  await exec(full.slice(0, cut));                 // the real policies, verbatim
});

after(async () => { if (db) await db.close(); });

// ==================================================================================================
describe('supabase RLS — bootstrap', () => {
  it('with no members at all, any signed-in account acts as admin', async () => {
    await as('first@x.com');
    assert.equal((await q('select public.app_no_users() as b')).rows[0].b, true);
    assert.equal((await q('select public.app_role() as r')).rows[0].r, 'admin');
    assert.equal(await tryInsert('_meta', 'schema', { tables: {} }), 'ok');
  });

  it('a caller with no email claim is refused everything', async () => {
    await asSignedOut();
    assert.equal(await tryInsert('tasks__active', 'x', { id: 'x' }), 'denied');
    assert.deepEqual(await readKeys('_meta'), []);
  });
});

// ==================================================================================================
describe('supabase RLS — the registry closes bootstrap', () => {
  before(async () => {
    await seed('_users', 'admin@x.com',  { role: 'admin',  user: 'admin@x.com',  tables: 'all' });
    await seed('_users', 'editor@x.com', { role: 'editor', user: 'editor@x.com', tables: ['tasks'] });
    await seed('_users', 'viewer@x.com', { role: 'viewer', user: 'viewer@x.com', tables: [] });
  });

  it('app_no_users() is false once _users rows exist', async () => {
    await as('viewer@x.com');
    assert.equal((await q('select public.app_no_users() as b')).rows[0].b, false);
  });

  it('an unregistered signed-in account gets no role and no data', async () => {
    await as('stranger@x.com');
    assert.equal((await q('select public.app_role() as r')).rows[0].r, null);
    assert.equal((await q('select public.app_is_registered() as b')).rows[0].b, false);
    assert.deepEqual(await readKeys('tasks__active'), []);
  });
});

// ==================================================================================================
// The Firestore analogue: the data catch-all must not also govern a SYSTEM store, or its owner-create
// branch lets any registered member mint a _users row naming themselves admin.
describe('supabase RLS — system stores are not reachable through the data branch', () => {
  it('viewer CANNOT mint an admin _users row', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_users', 'evil@x.com', { owner: 'viewer@x.com', role: 'admin', tables: 'all' }), 'denied');
  });
  it('viewer CANNOT create their OWN _users row either', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_users', 'viewer@x.com', { owner: 'viewer@x.com', role: 'admin', tables: 'all' }), 'denied');
  });
  it("viewer CANNOT forge someone else's _profiles row", async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_profiles', 'victim@x.com', { name: 'Spoofed', shared: true }), 'denied');
  });
  it("viewer CANNOT forge someone else's _access_requests row", async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_access_requests', 'victim@x.com', { email: 'victim@x.com', name: 'x' }), 'denied');
  });
  it('an unknown system store is denied by the fail-safe underscore branch', async () => {
    await as('admin@x.com');
    assert.equal(await tryInsert('_future_thing', 'k', { a: 1 }), 'denied');
  });
  it('viewer reads only their OWN _users row, never the registry', async () => {
    await as('viewer@x.com');
    assert.deepEqual(await readKeys('_users'), ['viewer@x.com']);
  });
  it('admin reads the whole registry', async () => {
    await as('admin@x.com');
    assert.equal((await readKeys('_users')).length >= 3, true);
  });
});

// ==================================================================================================
describe('supabase RLS — self-service rows are bounded to owner-column tables', () => {
  before(async () => { await seed('_meta', 'ownerTables', { tables: ['rsvps', 'chore_log', 'claims'] }); });

  it('member CAN create their own owner-stamped row in a self-service table', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('rsvps__active', 'mine', { id: 'mine', owner: 'viewer@x.com', s: 'coming' }), 'ok');
  });
  it('member CANNOT create a row owned by someone else', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('rsvps__active', 'r2', { id: 'r2', owner: 'other@x.com', s: 'coming' }), 'denied');
  });
  it('member CANNOT owner-inject into a table with no owner column', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('tasks__active', 'spam', { id: 'spam', owner: 'viewer@x.com' }), 'denied');
  });
  it('member CAN update and delete their own row in a self-service table', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('rsvps__active', 'mine', { id: 'mine', owner: 'viewer@x.com', s: 'out' }), 'ok');
    assert.equal(await tryDelete('rsvps__active', 'mine'), 'ok');
  });
  // A PARTIAL write, which is what the app actually sends: app-core's saveField puts
  // { id, <col>, updated_at } and nothing else, so the owner column is on the STORED row rather than in
  // the patch. app_kv_merge used to be `insert ... on conflict do update`, and Postgres evaluates the
  // INSERT policy's WITH CHECK against the row proposed for insertion -- the bare patch -- before any
  // conflict is detected. app_can_create saw no owner and refused, so every self-service member's cell
  // edit was silently rejected on Supabase while working on Firebase and on the dev server.
  // `claims`, not `rsvps`: the read-gate suite below asserts the exact key set of rsvps__active, and
  // these cases would otherwise seed rows into it. One shared database across describes.
  it('member CAN patch their own row WITHOUT resending the owner column', async () => {
    await seed('claims__active', 'partial', { id: 'partial', owner: 'viewer@x.com', s: 'coming' });
    await as('viewer@x.com');
    assert.equal(await tryMerge('claims__active', 'partial', { s: 'out' }), 'ok');
    await asSuper();
    const row = (await q("select value from public.kv where store = 'claims__active' and key = 'partial'")).rows[0].value;
    assert.deepEqual(row, { id: 'partial', owner: 'viewer@x.com', s: 'out' }, 'the owner must survive the patch');
  });
  it('...and that route does not let a member patch a row they do not own', async () => {
    // The merge must not become a way to reach somebody else's row by simply leaving the owner out.
    await seed('claims__active', 'theirs', { id: 'theirs', owner: 'other@x.com', s: 'coming' });
    await as('viewer@x.com');
    assert.equal(await tryMerge('claims__active', 'theirs', { s: 'hijacked' }), 'denied');
  });
  it('member CANNOT update or delete an owner-stamped row in a NON-self-service table', async () => {
    await seed('tasks__active', 'stray', { id: 'stray', owner: 'viewer@x.com', title: 'x' });
    await as('viewer@x.com');
    assert.equal(await tryUpdate('tasks__active', 'stray', { id: 'stray', owner: 'viewer@x.com', title: 'y' }), 'denied');
    assert.equal(await tryDelete('tasks__active', 'stray'), 'denied');
  });
});

// ==================================================================================================
// RLS filters rather than denies, so the read model is asserted as "exactly which rows come back".
describe('supabase RLS — the data read gate (grant / own row / public roster)', () => {
  before(async () => {
    await seed('rsvps__active', 'v-own', { id: 'v-own', owner: 'viewer@x.com', rosterPublic: true,  s: 'coming' });
    await seed('rsvps__active', 'pub',   { id: 'pub',   owner: 'ann@x.com',    rosterPublic: true,  s: 'out' });
    await seed('rsvps__active', 'priv',  { id: 'priv',  owner: 'ann@x.com',    rosterPublic: false, s: 'maybe' });
  });

  it('a grantless member sees their own row and the public ones, and nothing else', async () => {
    await as('viewer@x.com');
    assert.deepEqual(await readKeys('rsvps__active'), ['pub', 'v-own']);
  });
  it("a private row owned by someone else is invisible", async () => {
    await as('viewer@x.com');
    assert.equal(await canRead('rsvps__active', 'priv'), false);
  });
  it('an admin sees every row including the private one', async () => {
    await as('admin@x.com');
    assert.deepEqual(await readKeys('rsvps__active'), ['priv', 'pub', 'v-own']);
  });
  it('a table grant reveals the whole table', async () => {
    await seed('tasks__active', 't1', { id: 't1', title: 'a task' });
    await as('editor@x.com');                       // legacy array grant on ['tasks']
    assert.equal(await canRead('tasks__active', 't1'), true);
  });
  it('an ungranted plain table stays invisible', async () => {
    await seed('secrets__active', 's1', { id: 's1' });
    await as('editor@x.com');
    assert.deepEqual(await readKeys('secrets__active'), []);
  });
});

// ==================================================================================================
describe('supabase RLS — per-table grant modes (r / rw / legacy array)', () => {
  before(async () => {
    await seed('_users', 'mixed@x.com',  { role: 'editor', user: 'mixed@x.com',
      tables: { tasks: 'rw', refdata: 'r' }, rwTables: ['tasks'] });
    // Same modes, NO rwTables mirror. The map shape arrived WITH rwTables, so a mirror-less map is
    // malformed rather than pre-split, and must not silently promote its 'r' entries to 'rw'.
    await seed('_users', 'premig@x.com', { role: 'editor', user: 'premig@x.com',
      tables: { tasks: 'rw', refdata: 'r' } });
    await seed('refdata__active', 'ref1', { id: 'ref1', label: 'points' });
  });

  it("'r' table is READABLE", async () => {
    await as('mixed@x.com');
    assert.equal(await canRead('refdata__active', 'ref1'), true);
  });
  it("'r' table cannot be updated, created into, or deleted from", async () => {
    await as('mixed@x.com');
    assert.equal(await tryUpdate('refdata__active', 'ref1', { id: 'ref1', label: 'tampered' }), 'denied');
    assert.equal(await tryInsert('refdata__active', 'ref2', { id: 'ref2' }), 'denied');
    assert.equal(await tryDelete('refdata__active', 'ref1'), 'denied');
  });
  it("'rw' table is readable AND writable", async () => {
    await as('mixed@x.com');
    assert.equal(await tryUpdate('tasks__active', 't1', { id: 't1', title: 'edited' }), 'ok');
  });
  it('legacy ARRAY grant still reads and writes with no rwTables mirror', async () => {
    await as('editor@x.com');
    assert.equal(await tryUpdate('tasks__active', 't1', { id: 't1', title: 'legacy write' }), 'ok');
  });
  it('a MAP grant with no rwTables mirror does NOT get write on an r table (fails closed)', async () => {
    await as('premig@x.com');
    assert.equal(await tryUpdate('refdata__active', 'ref1', { id: 'ref1', label: 'promoted' }), 'denied');
  });
  it('a viewer role never writes even a granted table', async () => {
    await seed('_users', 'ro@x.com', { role: 'viewer', user: 'ro@x.com', tables: { tasks: 'rw' }, rwTables: ['tasks'] });
    await as('ro@x.com');
    assert.equal(await tryUpdate('tasks__active', 't1', { id: 't1', title: 'viewer edit' }), 'denied');
  });
});

// ==================================================================================================
describe('supabase RLS — doc-view bodies and per-page access', () => {
  before(async () => {
    await seed('_meta', 'pageAccess', { staff_handbook: ['tasks'], board_notes: ['finance'] });
    await seed('_pages__active', 'staff_handbook', { id: 'staff_handbook', markdown: 'staff only' });
    await seed('_pages__active', 'board_notes',    { id: 'board_notes',    markdown: 'board only' });
    await seed('_pages__active', 'open_notice',    { id: 'open_notice',    markdown: 'everyone' });
  });

  it('an untagged page is readable by any registered user', async () => {
    await as('viewer@x.com');
    assert.equal(await canRead('_pages__active', 'open_notice'), true);
  });
  it('a page gated on a table I hold IS readable (legacy array grant)', async () => {
    await as('editor@x.com');
    assert.equal(await canRead('_pages__active', 'staff_handbook'), true);
  });
  it('a page gated on a table I hold IS readable (MAP grant — the shape the access UI writes)', async () => {
    await as('mixed@x.com');
    assert.equal(await canRead('_pages__active', 'staff_handbook'), true);
  });
  it('a page gated on a table I lack stays unreadable', async () => {
    await as('editor@x.com');
    assert.equal(await canRead('_pages__active', 'board_notes'), false);
  });
  it('a grantless member cannot read any restricted page', async () => {
    await as('viewer@x.com');
    assert.deepEqual(await readKeys('_pages__active'), ['open_notice']);
  });
  it('an admin reads restricted pages regardless of grants', async () => {
    await as('admin@x.com');
    assert.equal(await canRead('_pages__active', 'board_notes'), true);
  });
  it('a viewer cannot write a page; an editor can', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_pages__active', 'open_notice', { id: 'open_notice', markdown: 'defaced' }), 'denied');
    await as('editor@x.com');
    assert.equal(await tryUpdate('_pages__active', 'open_notice', { id: 'open_notice', markdown: '# Edited' }), 'ok');
  });
});

// ==================================================================================================
describe('supabase RLS — _lists', () => {
  before(async () => {
    await seed('_lists', 'refvalues',  { name: 'refvalues',  items: ['a'], tables: ['refdata'] });
    await seed('_lists', 'taskvalues', { name: 'taskvalues', items: ['a'], tables: ['tasks'] });
    await seed('_meta', 'listTables', { newtasklist: ['tasks'], newreflist: ['refdata'] });
    // Editing a list is admin-only unless the schema opens it (userWritableLists -> _meta/listWritable).
    // `taskvalues`/`newtasklist` are opened; `lockedvalues` is owned by an rw table but NOT opened, which
    // is what proves the allowlist is doing the work rather than the table grant alone.
    await seed('_lists', 'lockedvalues', { name: 'lockedvalues', items: ['a'], tables: ['tasks'] });
    await seed('_meta', 'listWritable', { lists: ['taskvalues', 'newtasklist'] });
  });

  it("a list the schema does not open is readable but not writable", async () => {
    await as('mixed@x.com');
    assert.equal(await canRead('_lists', 'refvalues'), true);
    assert.equal(await tryUpdate('_lists', 'refvalues', { name: 'refvalues', items: ['a', 'b'], tables: ['refdata'] }), 'denied');
  });
  it("a list the schema OPENS is writable by a non-admin", async () => {
    await as('mixed@x.com');
    assert.equal(await tryUpdate('_lists', 'taskvalues', { name: 'taskvalues', items: ['a', 'b'], tables: ['tasks'] }), 'ok');
  });
  // The case above uses a caller who already holds a grant on the owning table, so it never asked
  // whether the ALLOWLIST alone is enough. viewer@x.com holds nothing. This is the case that was
  // silently broken: an UPDATE has to locate its row, Postgres applies the SELECT policy to do that,
  // and _lists reads used to require a table grant -- so a member could be granted the write by
  // userWritableLists and still be unable to perform it. Firestore evaluates write rules without
  // needing the read, so the same member succeeded there and on the dev server.
  it("a member with NO table grant can read and append to a list the schema opens", async () => {
    await as('viewer@x.com');
    assert.equal(await canRead('_lists', 'taskvalues'), true, 'an opened list must be readable, or it cannot be edited');
    assert.equal(await tryUpdate('_lists', 'taskvalues', { name: 'taskvalues', items: ['a', 'b', 'c'], tables: ['tasks'] }), 'ok');
  });
  it("opening a list does not leak the lists it did not open", async () => {
    await as('viewer@x.com');
    assert.equal(await canRead('_lists', 'lockedvalues'), false, 'a list that is not opened stays behind the grant');
  });
  it("a list the schema does NOT open stays admin-only, whatever the table grant", async () => {
    await as('mixed@x.com');   // rw on `tasks`, which owns lockedvalues — and that is deliberately not enough
    assert.equal(await tryUpdate('_lists', 'lockedvalues', { name: 'lockedvalues', items: ['a', 'b'], tables: ['tasks'] }), 'denied');
    await as('admin@x.com');
    assert.equal(await tryUpdate('_lists', 'lockedvalues', { name: 'lockedvalues', items: ['a', 'b'], tables: ['tasks'] }), 'ok');
  });
  it('an editor CANNOT re-stamp a list\'s ownership label on update', async () => {
    await as('mixed@x.com');
    assert.equal(await tryUpdate('_lists', 'taskvalues', { name: 'taskvalues', items: ['a'], tables: ['tasks', 'refdata'] }), 'denied');
  });
  it('a list owned by a table I cannot see is invisible', async () => {
    await seed('_lists', 'secretvalues', { name: 'secretvalues', items: ['x'], tables: ['secrets'] });
    await as('mixed@x.com');
    assert.equal(await canRead('_lists', 'secretvalues'), false);
  });

  // CREATE has no stored row, so the ownership label in the write is an unverified CLAIM — authorized
  // from the _meta/listTables mirror instead, with the claim pinned to it.
  it('a non-admin CAN create an opened list, with the ownership label pinned to the schema', async () => {
    await as('mixed@x.com');
    assert.equal(await tryInsert('_lists', 'newtasklist', { name: 'newtasklist', items: ['x'], tables: ['tasks'] }), 'ok');
  });
  it('a non-admin CANNOT create a list the schema does not open', async () => {
    await as('mixed@x.com');
    assert.equal(await tryInsert('_lists', 'newreflist', { name: 'newreflist', items: ['x'], tables: ['refdata'] }), 'denied');
  });
  it('editor CANNOT mint a list under a self-chosen ownership label', async () => {
    await as('mixed@x.com');
    assert.equal(await tryInsert('_lists', 'newreflist', { name: 'newreflist', items: ['x'], tables: ['tasks'] }), 'denied');
  });
  it('editor CANNOT create a list the schema does not own at all', async () => {
    await as('mixed@x.com');
    assert.equal(await tryInsert('_lists', 'unknownlist', { name: 'unknownlist', items: ['x'], tables: ['tasks'] }), 'denied');
  });
  it('admin creates and deletes a list regardless of the mirror', async () => {
    await as('admin@x.com');
    assert.equal(await tryInsert('_lists', 'adminlist', { name: 'adminlist', items: [], tables: [] }), 'ok');
    assert.equal(await tryDelete('_lists', 'adminlist'), 'ok');
  });
});

// ==================================================================================================
describe('supabase RLS — _profiles shape validation', () => {
  const prof = (over) => Object.assign({ name: 'Vic', shared: true }, over);

  it('a well-formed profile is accepted', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_profiles', 'viewer@x.com', prof()), 'ok');
  });
  it('a picture data-URL within the cap is accepted', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ picture: 'data:image/jpeg;base64,abc' })), 'ok');
  });
  it('an oversized name is rejected', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ name: 'x'.repeat(101) })), 'denied');
  });
  it('a non-string name is rejected', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ name: { a: 1 } })), 'denied');
  });
  it('a non-bool shared is rejected', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ shared: 'yes' })), 'denied');
  });
  it('extra keys are rejected', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ role: 'admin' })), 'denied');
  });
  it('an oversized picture is rejected (the jsonb-has-no-1MB-limit case)', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('_profiles', 'viewer@x.com', prof({ picture: 'x'.repeat(350001) })), 'denied');
  });
  it('a shared profile is world-readable; an unshared one is not', async () => {
    await seed('_profiles', 'ann@x.com',  { name: 'Ann',  shared: true });
    await seed('_profiles', 'cara@x.com', { name: 'Cara', shared: false });
    await as('viewer@x.com');
    assert.equal(await canRead('_profiles', 'ann@x.com'), true);
    assert.equal(await canRead('_profiles', 'cara@x.com'), false);
  });
  it('an admin reads unshared profiles', async () => {
    await as('admin@x.com');
    assert.equal(await canRead('_profiles', 'cara@x.com'), true);
  });
});

// ==================================================================================================
// Stored image assets: view backgrounds / image-cell bytes kept as data URIs in the database, so a
// deployment with no storage bucket (Firebase Storage needs the Blaze plan) can still hold an upload.
// Mirrors firestore.rules' _assets__active block. The cap matters MORE here than on Firestore: jsonb
// takes ~1GB where a Firestore document is refused at 1MB, so app_valid_shape is the only bound.
describe('supabase RLS — _assets shape validation and visibility', () => {
  const DATA_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const asset = (over) => Object.assign({ id: 'bg_home', src: DATA_URI }, over);

  it('an editor CAN write an asset', async () => {
    await as('editor@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_home', asset()), 'ok');
  });
  it('an admin CAN write an asset', async () => {
    await as('admin@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_admin', asset({ id: 'bg_admin' })), 'ok');
  });
  it('a viewer CANNOT write an asset', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_evil', asset({ id: 'bg_evil' })), 'denied');
  });
  it('every registered user CAN read an asset (decoration; the referencing row keeps its own gate)', async () => {
    await as('viewer@x.com');
    assert.equal(await canRead('_assets__active', 'bg_home'), true);
  });
  it('an oversized src is rejected (jsonb would otherwise take a gigabyte)', async () => {
    await as('editor@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_huge', asset({ id: 'bg_huge', src: 'x'.repeat(900001) })), 'denied');
  });
  it('an src just under the cap is accepted', async () => {
    await as('editor@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_big', asset({ id: 'bg_big', src: 'x'.repeat(900000) })), 'ok');
  });
  it('extra keys are rejected (shape is exactly { id, src })', async () => {
    await as('editor@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_extra', asset({ id: 'bg_extra', markdown: 'x' })), 'denied');
  });
  it('a non-string src is rejected', async () => {
    await as('editor@x.com');
    assert.equal(await tryInsert('_assets__active', 'bg_num', asset({ id: 'bg_num', src: 42 })), 'denied');
  });
  it('an over-cap UPDATE is rejected too (the WITH CHECK re-runs the shape test)', async () => {
    await as('editor@x.com');
    assert.equal(await tryUpdate('_assets__active', 'bg_home', asset({ src: 'x'.repeat(900001) })), 'denied');
  });
});

// ==================================================================================================
describe('supabase RLS — _access_requests shape validation', () => {
  const req = (over) => Object.assign({ email: 'stranger@x.com', name: 'Sam', note: 'hi', ts: 1 }, over);

  it('a well-formed self-created request is accepted', async () => {
    await as('stranger@x.com');
    assert.equal(await tryInsert('_access_requests', 'stranger@x.com', req()), 'ok');
  });
  it('an oversized note is rejected', async () => {
    await as('stranger@x.com');
    assert.equal(await tryUpdate('_access_requests', 'stranger@x.com', req({ note: 'x'.repeat(501) })), 'denied');
  });
  it('extra keys are rejected', async () => {
    await as('stranger@x.com');
    assert.equal(await tryUpdate('_access_requests', 'stranger@x.com', req({ role: 'admin' })), 'denied');
  });
  it('a mismatched email is rejected', async () => {
    await as('stranger2@x.com');
    assert.equal(await tryInsert('_access_requests', 'stranger2@x.com', req({ email: 'other@x.com' })), 'denied');
  });
  it('a request cannot be filed under someone else\'s key', async () => {
    await as('stranger2@x.com');
    assert.equal(await tryInsert('_access_requests', 'victim@x.com', req({ email: 'victim@x.com' })), 'denied');
  });
  it('the requester reads and withdraws their own; admins read all', async () => {
    await as('stranger@x.com');
    assert.deepEqual(await readKeys('_access_requests'), ['stranger@x.com']);
    await as('admin@x.com');
    assert.equal(await canRead('_access_requests', 'stranger@x.com'), true);
    await as('stranger@x.com');
    assert.equal(await tryDelete('_access_requests', 'stranger@x.com'), 'ok');
  });
});

// ==================================================================================================
describe('supabase RLS — _list_users shape validation and visibility', () => {
  const link = (over) => Object.assign({ list: 'people', value: 'Bob', email: 'bob@x.com', shared: true }, over);

  it('an admin writes a valid link', async () => {
    await as('admin@x.com');
    assert.equal(await tryInsert('_list_users', 'people~Bob', link()), 'ok');
  });
  it('extra keys and a non-bool shared are rejected even for an admin', async () => {
    await as('admin@x.com');
    assert.equal(await tryInsert('_list_users', 'people~BadA', link({ role: 'admin' })), 'denied');
    assert.equal(await tryInsert('_list_users', 'people~BadB', link({ shared: 'yes' })), 'denied');
  });
  it('a non-admin cannot write a link', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('_list_users', 'people~Evil', link({ value: 'Evil' })), 'denied');
  });
  it('a shared link is readable; an unshared one is not; the one naming ME is', async () => {
    await seed('_list_users', 'people~Cara',  { list: 'people',  value: 'Cara', email: 'cara@x.com',   shared: false });
    await seed('_list_users', 'members~Vic',  { list: 'members', value: 'Vic',  email: 'viewer@x.com', shared: false });
    await as('viewer@x.com');
    assert.equal(await canRead('_list_users', 'people~Bob'), true);
    assert.equal(await canRead('_list_users', 'people~Cara'), false);
    assert.equal(await canRead('_list_users', 'members~Vic'), true);   // @me resolution
  });
});

// ==================================================================================================
// The sharpest test in the suite. app_owner_fields_ok compares the incoming row against a BASELINE it
// looks up itself — the stored row on an update, the gated defaults on an insert. On an UPDATE that
// lookup happens inside a WITH CHECK, and the whole gate is only meaningful if the STABLE function
// sees the PRE-update row. If it saw the new one the baseline would equal the incoming value, the diff
// would be empty, and ownerWritable would be a silent no-op on Supabase while working on Firebase.
describe('supabase RLS — ownerWritable column bounds', () => {
  const row = (over) => Object.assign({
    id: 'mine', owner: 'viewer@x.com', person: 'Vic', chore: 'Hoover',
    done_on: '2026-08-01', note: '', status: 'logged', rosterPublic: true
  }, over);

  before(async () => {
    await seed('_meta', 'ownerWritable', {
      chore_log: { cols: ['chore', 'done_on', 'note', 'person'], locked: { status: 'logged' } }
      // `claims` deliberately absent -> unbounded, proving the feature is opt-in.
    });
    await seed('chore_log__active', 'mine', row());
    await seed('claims__active', 'free', { id: 'free', owner: 'viewer@x.com', status: 'logged' });
  });

  it('owner CAN edit a listed column on their own row', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('chore_log__active', 'mine', row({ note: 'took ages' })), 'ok');
  });
  it('owner CANNOT approve themselves (a gated column)', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('chore_log__active', 'mine', row({ note: 'took ages', status: 'approved' })), 'denied');
  });
  it('owner CANNOT sneak the gated column through with a legitimate edit', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('chore_log__active', 'mine', row({ note: 'x', status: 'approved' })), 'denied');
  });
  it('owner CAN create a row that starts at the gated default', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('chore_log__active', 'new1', row({ id: 'new1', chore: 'Bins' })), 'ok');
  });
  it('owner CANNOT create a row that is already approved', async () => {
    await as('viewer@x.com');
    assert.equal(await tryInsert('chore_log__active', 'new2', row({ id: 'new2', status: 'approved' })), 'denied');
  });
  it('an ADMIN still approves it (the bound binds only the owner branch)', async () => {
    await as('admin@x.com');
    assert.equal(await tryUpdate('chore_log__active', 'mine', row({ status: 'approved' })), 'ok');
  });
  it('a table with no ownerWritable entry stays unbounded (opt-in)', async () => {
    await as('viewer@x.com');
    assert.equal(await tryUpdate('claims__active', 'free', { id: 'free', owner: 'viewer@x.com', status: 'approved' }), 'ok');
  });
});

// ==================================================================================================
describe('supabase RLS — _meta hardening', () => {
  it('the users registry and the legacy lists doc are admin-only reads', async () => {
    await seed('_meta', 'users', {});
    await seed('_meta', 'lists', { mylist: ['a'] });
    await as('editor@x.com');
    assert.equal(await canRead('_meta', 'users'), false);
    assert.equal(await canRead('_meta', 'lists'), false);
    assert.equal(await canRead('_meta', 'schema'), true);      // ordinary meta stays registered-readable
  });
  it('an editor cannot write _meta at all (schema mirrors are admin-only)', async () => {
    await as('editor@x.com');
    assert.equal(await tryUpdate('_meta', 'ownerTables', { tables: ['everything'] }), 'denied');
    assert.equal(await tryUpdate('_meta', 'pageAccess', {}), 'denied');
  });
  it('not even an admin deletes _meta/users (it is the bootstrap probe)', async () => {
    await as('admin@x.com');
    assert.equal(await tryDelete('_meta', 'users'), 'denied');
  });
  it('an admin CAN delete another _meta doc (the deleteLanguage path)', async () => {
    await seed('_meta', 'lang_xx', { 'app.title': 'X' });
    await as('admin@x.com');
    assert.equal(await tryDelete('_meta', 'lang_xx'), 'ok');
  });
});
