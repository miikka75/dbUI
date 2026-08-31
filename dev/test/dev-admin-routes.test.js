// dev-admin-routes.test.js — the dev server's admin surface refuses a member.
//
// The dev server's identity is the X-User header: trusted, not authenticated. That is fine while the
// process is bound to loopback, and the header comment says so. What was NOT fine is that the routes
// behind it accepted anyone — `setUserRole` above all, which meant any dev client could hand itself
// `role: 'admin'`. The loopback bind stops that being an exploit; it does not stop it being a hole in
// the TEST SURFACE, because a suite cannot assert "a member may not escalate" against a server where
// they can. Every case below fails against the ungated server, which is the point of writing them.
//
// The verdicts mirror firestore.rules one for one:
//   _meta writes (schema, config)          -> noUsers() || role() == 'admin'
//   _users read and write                  -> noUsers() || role() == 'admin'   (getUsers reads ALL)
//   _access_requests / _profiles read ALL  -> role() == 'admin'   (no per-document rule grants it)
//   own request / own profile name         -> myEmail() == email || role() == 'admin'
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DEV_DIR = path.join(__dirname, '..');
const PORT = 4620 + (process.pid % 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DB_REL = path.join('test', '.adm-' + process.pid + '.db');
const DB_ABS = path.join(DEV_DIR, DB_REL);

const SCHEMA = {
  tables: { tasks: { columns: { id: { type: 'text' }, title: { type: 'text' } } } },
  views: []
};

let child;

function post(route, body, user) {
  return fetch(BASE + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'boss@x.com' },
    body: JSON.stringify(body || {})
  });
}
const status = (route, body, user) => post(route, body, user).then((r) => r.status);

describe('dev server — the admin API surface is gated', () => {
  before(async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: DEV_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), APP_DB: DB_REL }),
      stdio: 'ignore'
    });
    let up = false;
    // 45s for the same reason the other dev-server suites take it: the default backend is PGlite, so
    // this spawn boots a WebAssembly Postgres and applies supabase-schema.sql before it answers.
    const deadline = Date.now() + 45000;
    while (!up && Date.now() < deadline) {
      try { up = (await post('serverInfo', {})).ok; } catch (e) { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(up, 'dev server started');

    // Bootstrap: no users yet, so the very first schema write and the very first grant must PASS.
    // This is the half of the gate that is easy to break by making it strict, and it is the half a
    // fresh database depends on.
    assert.equal(await status('saveSchema', { schema: SCHEMA }), 200, 'bootstrap may write the schema');
    assert.equal(await status('setUserRole', { uid: 'boss@x.com', role: 'admin', user: 'boss@x.com', tables: 'all' }),
      200, 'bootstrap may mint the first admin');
    await post('setUserRole', { uid: 'member@x.com', role: 'editor', user: 'member@x.com', tables: ['tasks'] });
  });

  after(async () => {
    if (child) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
      if (f.startsWith('.adm-' + process.pid)) { try { fs.rmSync(path.join(DEV_DIR, 'test', f), { recursive: true, force: true }); } catch (e) {} }
    }
    try { fs.rmSync(DB_ABS, { recursive: true, force: true }); } catch (e) {}
  });

  // The headline. An editor is the most privileged non-admin the model has, so if the escalation is
  // refused for them it is refused for everyone below.
  it('a member cannot promote themselves to admin', async () => {
    assert.equal(await status('setUserRole',
      { uid: 'member@x.com', role: 'admin', user: 'member@x.com', tables: 'all' }, 'member@x.com'), 403);
    // ...and the stored grant is unchanged, so the denial is a denial and not a 403 over a write that
    // already landed.
    const users = await (await post('getUsers', {}, 'boss@x.com')).json();
    assert.equal(users['member@x.com'].role, 'editor');
  });

  it('a member cannot delete another user', async () => {
    assert.equal(await status('removeUser', { uid: 'boss@x.com' }, 'member@x.com'), 403);
    const users = await (await post('getUsers', {}, 'boss@x.com')).json();
    assert.ok(users['boss@x.com'], 'the admin survives');
  });

  it('a member cannot read the users roster, the requests queue, or every profile', async () => {
    // These are whole-collection reads. Each one carries other people's email addresses, grants or
    // unshared display names, and no per-document rule in either policy layer grants them.
    for (const route of ['getUsers', 'getAccessRequests', 'getProfiles', 'getListUserLinks']) {
      assert.equal(await status(route, {}, 'member@x.com'), 403, route + ' must refuse a member');
      assert.equal(await status(route, {}, 'boss@x.com'), 200, route + ' must still serve an admin');
    }
  });

  it('a member cannot rewrite the schema or the shared config', async () => {
    // `resetData` is deliberately NOT in this list -- see the note beside ADMIN_ROUTES. It is the local
    // fixture reset, has no counterpart in any production backend, and storage-pglite runs it as the
    // table owner so no policy applies to it either.
    assert.equal(await status('saveSchema', { schema: { tables: {}, views: [] } }, 'member@x.com'), 403);
    assert.equal(await status('initSchema', { schema: { evil: { columns: { id: { type: 'text' } } } } }, 'member@x.com'), 403);
    assert.equal(await status('setFolderConfig', { config: { appName: 'pwned' } }, 'member@x.com'), 403);
    assert.equal(await status('saveConfig', { filename: 'firebase-config.json', data: {} }, 'member@x.com'), 403);
    // The schema the admin wrote is still the schema.
    const schema = await (await post('getSchema', {}, 'boss@x.com')).json();
    assert.ok(schema.tables.tasks, 'saveSchema was refused, not applied');
  });

  it('a member cannot link a list value to a user (that is how identity is minted)', async () => {
    // setListUser writes the `identity` mirror the stamped-column rule reads. Left open, a member could
    // name themselves as any list value and the policies would then agree they are that person.
    assert.equal(await status('setListUser', { listName: 'members', value: 'Ann', email: 'member@x.com' }, 'member@x.com'), 403);
  });

  it('self-scoped routes still work for the member they are about, and only for them', async () => {
    // Their own request and their own profile name: allowed for themselves, refused for someone else's.
    // This is the `myEmail() == email || role() == 'admin'` branch, not the admin-only one.
    assert.equal(await status('requestAccess', { name: 'Mem', note: 'hi' }, 'newbie@x.com'), 200);
    assert.equal(await status('setProfileName', { email: 'member@x.com', name: 'Mem' }, 'member@x.com'), 200);
    assert.equal(await status('setProfileName', { email: 'boss@x.com', name: 'Not The Boss' }, 'member@x.com'), 403);
    assert.equal(await status('removeAccessRequest', { email: 'newbie@x.com' }, 'member@x.com'), 403);
    assert.equal(await status('removeAccessRequest', { email: 'newbie@x.com' }, 'newbie@x.com'), 200);
    // ...and the admin may do both on anyone's behalf, which is the approval flow.
    assert.equal(await status('setProfileName', { email: 'member@x.com', name: 'Member' }, 'boss@x.com'), 200);
  });

  // saveLists is not admin-gated -- who may write which list is the policies' question. What the route
  // decides is whether a name ABSENT from the submitted map was retired or merely invisible to the
  // caller, and it answers that with the predicate backend-firebase uses (`myTabs === null`). Dev
  // merged for everyone, so a list could never be deleted here at all: the map came back with every
  // name the store already had. That is not cosmetic -- a leftover list shows in the Lists tab as a
  // live vocabulary, and until app-core stopped preferring it, hid a same-named lookup table's values
  // from the Languages editor.
  it('an unrestricted caller retires a list by omitting it; a restricted one cannot drop what they cannot see', async () => {
    assert.equal(await status('saveLists', { lists: { keep: ['a'], retire: ['b'] } }, 'boss@x.com'), 200);
    const before = await (await post('getLists', {}, 'boss@x.com')).json();
    assert.deepEqual(before.retire, ['b'], 'both lists were stored');

    // The admin sees every list, so their map IS the whole set: the missing name is a deletion.
    assert.equal(await status('saveLists', { lists: { keep: ['a'] } }, 'boss@x.com'), 200);
    const after = await (await post('getLists', {}, 'boss@x.com')).json();
    assert.deepEqual(after.keep, ['a'], 'the surviving list is untouched');
    assert.ok(!('retire' in after), 'the omitted list is retired, not resurrected by a merge');

    // A member's map is a filtered subset of what they can see, so absence means "not mine to write".
    // Their save must not take `keep` with it, whatever the policies decide about their own write.
    await post('saveLists', { lists: { mine: ['x'] } }, 'member@x.com');
    const survived = await (await post('getLists', {}, 'boss@x.com')).json();
    assert.deepEqual(survived.keep, ['a'], "a restricted caller's save leaves the lists they omitted alone");
  });

  it('an unregistered caller gets nothing from the admin surface', async () => {
    // `noUsers()` is the bootstrap grace, not "I am not in the table". Once ANY user exists, a stranger
    // is a stranger — the gate must not read an absent grant as an absent restriction.
    for (const route of ['getUsers', 'getProfiles', 'setUserRole']) {
      assert.equal(await status(route, {}, 'stranger@x.com'), 403, route + ' must refuse a stranger');
    }
  });
});
