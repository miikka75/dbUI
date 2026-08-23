// list-user-sidecar.test.js — user-linked list values must survive the database being recreated.
//
// The dev server keeps its ADMIN CONFIGURATION in JSON sidecars — the member registry, access requests,
// profiles — precisely so that wiping the data does not cost you the setup. User-linked list values
// (`setListUser`) were the one piece that lived only in the database.
//
// That is not merely "the links are gone". `setListUser` also mirrors the link onto the member's GRANT
// doc as `identity`, because neither rules language can query for "the link naming me". The grant comes
// back from users.json, mirror and all — so the write layers read `identity` and believe the member is
// Ann, while `@me` finds no link and the UI tells her she is not linked to anybody. Two halves of one
// fact, disagreeing, with the visible half wrong: a member who is told to ask an admin for something
// the admin already did.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEV_DIR = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbui-links-'));
const DB = path.join(tmp, 'links.db');
const started = [];

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR, env: Object.assign({}, process.env, { PORT: '0', APP_DB: DB }),
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
const api = (base, route, body = {}, user = 'admin@dev') =>
  fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: JSON.stringify(body) }).then((r) => r.json().catch(() => null));

after(() => {
  for (const c of started) { try { c.kill(); } catch (e) { /* already gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('dev server — user-linked list values survive a recreated database', () => {
  it('restores the links a fresh store lost, so `@me` and the grant mirror still agree', async () => {
    const first = await startServer();
    await api(first.base, 'setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await api(first.base, 'setUserRole', { uid: 'ann@dev', role: 'editor', user: 'ann@dev', tables: { chores: 'r' } });
    await api(first.base, 'setListUser', { listName: 'members', value: 'Ann', email: 'ann@dev' });

    assert.deepEqual(await api(first.base, 'getListUserLinks'), { members: { Ann: 'ann@dev' } });
    assert.deepEqual(await api(first.base, 'getMyListValues', {}, 'ann@dev'), { members: 'Ann' },
      'the link should resolve @me before we touch anything');
    first.child.kill();
    await new Promise((r) => setTimeout(r, 300));

    // Recreate the database, leaving the sidecars — exactly what a fresh dataDir or a wiped store does.
    fs.rmSync(DB + '.pgdata', { recursive: true, force: true });

    const second = await startServer();
    const users = await api(second.base, 'getUsers');
    assert.equal(users['ann@dev'].identity.members, 'Ann',
      'the grant (and its identity mirror) comes back from the users sidecar — this is the half that always worked');
    assert.deepEqual(await api(second.base, 'getListUserLinks'), { members: { Ann: 'ann@dev' } },
      'THE BUG: the links did not come back, so the mirror above now describes a link nobody can see');
    assert.deepEqual(await api(second.base, 'getMyListValues', {}, 'ann@dev'), { members: 'Ann' },
      '`@me` resolves from the links, so this is what the member actually experiences');
    second.child.kill();
  });

  it('resetData clears the sidecar too, so the next boot does not resurrect the links', async () => {
    // The sidecar is a backup of a store that is normally the source of truth. If resetData emptied the
    // store and left the file, restarting would put every link back and "reset" would not have.
    const s = await startServer();
    await api(s.base, 'setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await api(s.base, 'setListUser', { listName: 'members', value: 'Bob', email: 'bob@dev' });
    await api(s.base, 'resetData');
    assert.deepEqual(await api(s.base, 'getListUserLinks'), {});
    s.child.kill();
    await new Promise((r) => setTimeout(r, 300));

    const again = await startServer();
    assert.deepEqual(await api(again.base, 'getListUserLinks'), {}, 'a reset link came back on the next boot');
    again.child.kill();
  });
});
