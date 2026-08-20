const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// End-to-end guard for the dev server's live-sync stream (/api/events), the local counterpart of
// Firestore onSnapshot / Supabase realtime. Two claims are being tested, and the second is the one that
// matters: a write reaches other clients, and it reaches ONLY the clients allowed to read that table.
// A live stream that skipped the access model would be a read channel around it.
//
// Runs the real server as a child process on its own port and its own database, so it cannot touch
// dev/local.db or the sidecar users.json of a running dev instance.

const DEV_DIR = path.join(__dirname, '..');
const PORT = 3737 + (process.pid % 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DB_REL = path.join('test', '.sse-' + process.pid + '.db');
const DB_ABS = path.join(DEV_DIR, DB_REL);

let child;

function post(route, body, user) {
  return fetch(BASE + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'admin@dev' },
    body: JSON.stringify(body || {})
  }).then(r => r.json());
}

// A minimal SSE reader: connect, collect parsed `data:` frames into an array, return a handle. Node's
// fetch gives a byte stream, and frames are separated by a blank line.
async function openStream(user) {
  const res = await fetch(BASE + '/api/events?user=' + encodeURIComponent(user), {
    headers: { Accept: 'text/event-stream' }
  });
  assert.equal(res.status, 200);
  const handle = { events: [], close: null };
  const reader = res.body.getReader();
  handle.close = () => reader.cancel().catch(() => {});
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (line) { try { handle.events.push(JSON.parse(line.slice(6))); } catch (e) {} }
        }
      }
    } catch (e) { /* cancelled */ }
  })();
  return handle;
}

// Poll rather than sleep a fixed amount: the assertion is "arrives", not "arrives in exactly N ms".
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise(r => setTimeout(r, 25));
  }
}

const SCHEMA = {
  tables: {
    tasks: { columns: { title: { type: 'text' }, note: { type: 'text' } } },
    secrets: { columns: { title: { type: 'text' } } }
  }
};

describe('dev server — live-sync SSE stream', () => {
  before(async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: DEV_DIR,
      env: Object.assign({}, process.env, { PORT: String(PORT), APP_DB: DB_REL }),
      stdio: 'ignore'
    });
    let up = false;
    // 45s: the dev server's default backend is PGlite, so this spawn boots a WebAssembly Postgres and
    // applies supabase-schema.sql before it answers -- seconds on its own, and node --test runs the
    // suites that do this concurrently. The ceiling costs nothing when the server is up sooner.
    const deadline = Date.now() + 45000;
    while (!up && Date.now() < deadline) {
      try {
        const r = await fetch(BASE + '/api/serverInfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        up = r.ok;
      } catch (e) { await new Promise(r => setTimeout(r, 50)); }
    }
    assert.ok(up, 'dev server started');
    await post('saveSchema', { schema: SCHEMA });
    await post('initSchema', { schema: SCHEMA.tables });
  });

  after(async () => {
    // Wait for the child to actually exit before sweeping: SQLite writes its -wal/-shm companions out
    // as it closes, so cleaning while the process is still dying leaves them behind as stray files.
    if (child) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
    }
    // Sidecars travel with the database (server.js sidecarPath), so clear the whole family.
    for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
      if (f.startsWith('.sse-' + process.pid)) { try { fs.rmSync(path.join(DEV_DIR, 'test', f), { recursive: true, force: true }); } catch (e) {} }
    }
    try { fs.rmSync(DB_ABS, { recursive: true, force: true }); } catch (e) {}
  });

  it('a putRow reaches a listening client, carrying the STORED row', async () => {
    const s = await openStream('admin@dev');
    await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 't1', title: 'Hello', note: 'N' } });
    const ev = await waitFor(() => s.events.find(e => e.key === 't1'));
    s.close();
    assert.ok(ev, 'event delivered');
    assert.equal(ev.store, 'tasks__active');
    assert.equal(ev.value.title, 'Hello');
  });

  it('a PARTIAL putRow broadcasts the merged row, not the patch', async () => {
    // saveField now writes only the column it changed. A subscriber applies what it receives as the
    // row's new state, so the stream has to carry the row as stored — the merge, not the patch.
    await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 't2', title: 'Full', note: 'Keep' } });
    const s = await openStream('admin@dev');
    await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 't2', title: 'Patched' } });
    const ev = await waitFor(() => s.events.find(e => e.key === 't2'));
    s.close();
    assert.ok(ev, 'event delivered');
    assert.equal(ev.value.title, 'Patched', 'the changed column');
    assert.equal(ev.value.note, 'Keep', 'the untouched column survived the merge and is in the broadcast');
  });

  it('a deleteRow reaches listeners as a null value', async () => {
    await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 't3', title: 'Doomed' } });
    const s = await openStream('admin@dev');
    await post('deleteRow', { tableId: 'tasks', tab: 'active', id: 't3' });
    const ev = await waitFor(() => s.events.find(e => e.key === 't3' && e.value === null));
    s.close();
    assert.ok(ev, 'delete delivered');
    assert.equal(ev.store, 'tasks__active');
  });

  it('a restricted subscriber receives only the tables they may READ', async () => {
    // Grant viewer read on `tasks` and nothing on `secrets`, then write to both. This is the assertion
    // that keeps the live stream inside the access model rather than beside it.
    await post('setUserRole', { uid: 'viewer@dev', role: 'viewer', user: 'viewer@dev', tables: { tasks: 'r' } });
    await post('setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    const s = await openStream('viewer@dev');
    await post('putRow', { tableId: 'secrets', tab: 'active', data: { id: 's1', title: 'Nope' } }, 'admin@dev');
    await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 't4', title: 'Yes' } }, 'admin@dev');

    // Wait for the allowed one; the denied one was written FIRST, so if it were coming it would already
    // be here — this ordering is what makes the negative assertion meaningful rather than a race.
    const allowed = await waitFor(() => s.events.find(e => e.key === 't4'));
    s.close();
    assert.ok(allowed, 'the granted table came through');
    assert.equal(s.events.find(e => e.store === 'secrets__active'), undefined, 'the ungranted table did not');
  });
});
