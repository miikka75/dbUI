// grant-edit-keeps-identity.test.js — editing someone's grants must not un-link them.
//
// `setListUser` links a list value to a user, and mirrors the answer onto that user's GRANT doc as
// `identity: { <list>: <value> }`. It lives there because neither rules language can QUERY for "the
// link naming me": the answer has to sit on a document the rule already fetches.
//
// `setUserRole` rewrites that same document. It built a fresh grant and dropped the mirror, so
// changing anybody's table access silently un-linked them — and the identity rule ("an owner may only
// ever name themselves") falls through its migration-grace branch when the mirror is missing, and
// PERMITS ANY VALUE. So an admin adjusting a grant re-opened "log a chore as Bob", with nothing
// anywhere saying so.
//
// `userGrantDoc` has always taken an `identity` argument, and its comment has always claimed
// "Preserved across grant edits by the callers". No caller passed it.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DEV_DIR = path.join(__dirname, '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'chores-schema.json'), 'utf8'));
const started = [];
after(() => { for (const c of started) { try { c.kill(); } catch (e) { /* already gone */ } } });

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR, env: Object.assign({}, process.env, { PORT: '0', APP_DB: ':memory:' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  started.push(child);
  let buf = '';
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('server never reported a port:\n' + buf)), 60000);
    child.stdout.on('data', (b) => {
      buf += b.toString();
      const m = buf.match(/Local dev server: (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); res({ child, base: m[1] }); }
    });
    child.stderr.on('data', (b) => { buf += b.toString(); });
  });
}
const call = (base, route, body, user) =>
  fetch(base + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'admin@dev' },
    body: JSON.stringify(body || {})
  }).then(async (r) => ({ ok: r.ok, body: await r.json().catch(() => null) }));

describe('dev server — editing a grant preserves the identity link', () => {
  it('keeps the mirror, so the member cannot suddenly act as somebody else', async () => {
    const { base } = await startServer();
    const api = (r, b, u) => call(base, r, b, u);
    // Every step of the arrangement is checked. A REFUSED saveSchema leaves the policy layer without its
    // ownerWritable mirror, and a missing mirror reads as "this table has no bound" -- so the gate under
    // test goes permissive and the failure looks like a bug in the feature rather than in the setup.
    const ok = async (route, body, user) => {
      const r = await api(route, body, user);
      assert.ok(r.ok, route + ' was refused during setup: ' + JSON.stringify(r.body));
      return r;
    };
    await ok('saveSchema', { schema: SCHEMA });
    await ok('initSchema', { schema: SCHEMA.tables });
    await ok('setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await ok('setUserRole', { uid: 'ann@dev', role: 'editor', user: 'ann@dev', tables: { chore_log: 'r' } });
    await ok('setListUser', { listName: 'members', value: 'Ann', email: 'ann@dev' });

    const linked = (await api('getUsers')).body['ann@dev'];
    assert.deepEqual(linked.identity, { members: 'Ann' }, 'the link should mirror onto the grant');

    // An admin adjusts her table access. Nothing to do with the link.
    await api('setUserRole', {
      uid: 'ann@dev', role: 'editor', user: 'ann@dev',
      tables: { chore_log: 'r', home_shopping: 'rw' }
    });

    const edited = (await api('getUsers')).body['ann@dev'];
    assert.deepEqual(edited.identity, { members: 'Ann' }, 'THE BUG: editing the grant dropped the identity mirror');
    assert.deepEqual(edited.tables, { chore_log: 'r', home_shopping: 'rw' }, 'the grant edit itself must still apply');
    assert.deepEqual((await api('getMyListValues', {}, 'ann@dev')).body, { members: 'Ann' },
      'and `@me` must still resolve for her');

    // The consequence that makes this a security bug rather than an untidiness: with the mirror gone
    // the identity rule goes permissive, and she may log the work as somebody else.
    const asBob = await api('putRow', {
      tableId: 'chore_log', tab: 'active',
      data: { id: 'x1', owner: 'ann@dev', person: 'Bob', chore: 'Dishes', done_on: '2026-08-23', status: 'logged' }
    }, 'ann@dev');
    assert.equal(asBob.ok, false, 'THE BUG: after a grant edit she could log a chore as Bob');

    const asSelf = await api('putRow', {
      tableId: 'chore_log', tab: 'active',
      data: { id: 'x2', owner: 'ann@dev', person: 'Ann', chore: 'Dishes', done_on: '2026-08-23', status: 'logged' }
    }, 'ann@dev');
    assert.equal(asSelf.ok, true, 'she must still be able to log her own');
  });

  it('a member who was never linked is unaffected', async () => {
    // There is no mirror to preserve, and the grant edit must not invent one.
    const { base } = await startServer();
    const api = (r, b, u) => call(base, r, b, u);
    await api('setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await api('setUserRole', { uid: 'bob@dev', role: 'editor', user: 'bob@dev', tables: { chore_log: 'r' } });
    await api('setUserRole', { uid: 'bob@dev', role: 'editor', user: 'bob@dev', tables: { chore_log: 'rw' } });
    const rec = (await api('getUsers')).body['bob@dev'];
    assert.equal('identity' in rec, false, 'an unlinked member should carry no identity key');
  });
});

describe('backend contract — the browser backends preserve identity across a grant edit', () => {
  // Firebase and the shared kv contract (which Supabase and the browser-local PGlite both run) are
  // plain scripts that assign globals, so they cannot be exercised in Node.
  // Asserted against the source instead, the way the createLanguage rule is: the failure is a silent
  // permission hole on a production deployment, which the dev-server case above cannot reach.
  for (const file of ['backend-firebase.js', 'backend-kv.js']) {
    it(file + ' reads the stored grant and carries its identity forward', () => {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const at = src.indexOf('setUserRole: function');
      assert.ok(at > 0, file + ': setUserRole not found — this test would pass vacuously');
      const fn = src.slice(at, src.indexOf('removeUser', at));
      assert.ok(fn.length > 80, file + ': setUserRole body not found — this test would pass vacuously');
      // Two things, because either alone can be true while the bug is present: it must READ the stored
      // grant, and it must pass that grant's identity into the doc it builds.
      assert.match(fn, /\.get\(/,
        file + ': setUserRole never reads the stored grant, so it cannot know the identity to preserve');
      assert.match(fn, /userGrantDoc\([\s\S]{0,160}?identity/,
        file + ': setUserRole builds a grant doc without passing the stored identity, so it wipes the mirror');
    });
  }
});
