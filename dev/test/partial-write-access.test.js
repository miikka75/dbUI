const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// A cell edit now writes only the column it changed (app-core saveField), relying on putRow's pinned
// merge semantics. That moved the ground under the dev server's self-service write gate: the owner
// column it judges a writer by is no longer IN the payload, it is on the stored row.
//
// The production layers were always merge-aware — Firestore evaluates request.resource.data AFTER the
// merge, and Supabase's _merge/app_kv_merge send or compute the merged value — so the dev server had to
// be taught the same thing to keep the four gates saying one thing. These tests pin that: a partial
// write by a self-service member is allowed exactly when the same write as a full row would have been.

const { startDevServer, stopDevServer } = require('./dev-server');

const DEV_DIR = path.join(__dirname, '..');
// The port is the OS's to choose and the server's to announce — see dev-server.js. Polling a port
// derived from the pid was what turned a slow WebAssembly Postgres boot under CI concurrency into
// seven tests "cancelled by parent", with nothing on screen about the server that never came up.
let BASE;
const DB_REL = path.join('test', '.pwa-' + process.pid + '.db');
const DB_ABS = path.join(DEV_DIR, DB_REL);

let child;

async function put(data, user, tableId) {
  const res = await fetch(BASE + '/api/putRow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: JSON.stringify({ tableId: tableId || 'signups', tab: 'active', data })
  });
  return res.status;
}

function post(route, body, user) {
  return fetch(BASE + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'admin@dev' },
    body: JSON.stringify(body || {})
  }).then(r => r.json());
}

async function rowById(id, user) {
  const d = await post('getTableData', { tableId: 'signups', tab: 'active' }, user || 'admin@dev');
  return ((d && d.rows) || []).find(r => r.id === id);
}

// `signups` is the canonical self-service shape: an owner column (auto-stamped, read-only) plus an
// ownerWritable bound naming the one column a member may actually set on their own row.
const SCHEMA = {
  tables: {
    signups: {
      ownerWritable: ['status'],
      columns: {
        owner: { type: 'owner' },
        status: { type: 'text' },
        organizerNote: { type: 'text' }     // NOT ownerWritable — a member must never change it
      }
    }
  }
};

describe('dev server — self-service writes are gated on the MERGED row', () => {
  before(async () => {
    const started = await startDevServer(DB_REL);
    child = started.child;
    BASE = started.base;
    await post('saveSchema', { schema: SCHEMA });
    await post('initSchema', { schema: SCHEMA.tables });
    // member holds NO grant on `signups` — everything they can do comes from the owner column.
    await post('setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await post('setUserRole', { uid: 'member@dev', role: 'viewer', user: 'member@dev', tables: {} });
    await post('setUserRole', { uid: 'other@dev', role: 'viewer', user: 'other@dev', tables: {} });
  });

  after(async () => {
    await stopDevServer(child);   // waits for the exit before the sweep below — see dev-server.js
    for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
      if (f.startsWith('.pwa-' + process.pid)) { try { fs.rmSync(path.join(DEV_DIR, 'test', f), { recursive: true, force: true }); } catch (e) {} }
    }
    try { fs.rmSync(DB_ABS, { recursive: true, force: true }); } catch (e) {}
  });

  it('a member can CREATE their own owner-stamped row (full payload, unchanged behaviour)', async () => {
    assert.equal(await put({ id: 'm1', owner: 'member@dev', status: 'yes' }, 'member@dev'), 200);
    assert.equal((await rowById('m1')).status, 'yes');
  });

  it('a create still has to carry the owner itself — there is no stored row to inherit it from', async () => {
    assert.equal(await put({ id: 'm2', status: 'yes' }, 'member@dev'), 403);
  });

  it('a member can PATCH their own row without resending the owner column', async () => {
    // The case that broke when saveField went partial: the patch names no owner, so gating the payload
    // alone would deny it, while Firestore (which sees the merged document) allows it.
    assert.equal(await put({ id: 'm1', status: 'no' }, 'member@dev'), 200);
    const row = await rowById('m1');
    assert.equal(row.status, 'no', 'the patched column');
    assert.equal(row.owner, 'member@dev', 'the owner survived the merge');
  });

  it('a member still cannot patch SOMEONE ELSE\'s row', async () => {
    assert.equal(await put({ id: 'm1', status: 'hijacked' }, 'other@dev'), 403);
    assert.equal((await rowById('m1')).status, 'no', 'unchanged');
  });

  it('a member still cannot claim someone else\'s row by stamping themselves as owner', async () => {
    assert.equal(await put({ id: 'm1', owner: 'other@dev', status: 'x' }, 'other@dev'), 403);
  });

  it('a partial write is still bounded by ownerWritable', async () => {
    // The bound is the point of ownerWritable: `organizerNote` is not a column a member may set, and
    // shrinking the payload must not smuggle it past the check.
    assert.equal(await put({ id: 'm1', organizerNote: 'mine now' }, 'member@dev'), 403);
    assert.equal((await rowById('m1')).organizerNote || '', '', 'untouched');
  });

  it('an admin patch is unaffected by any of this', async () => {
    assert.equal(await put({ id: 'm1', organizerNote: 'reviewed' }, 'admin@dev'), 200);
    const row = await rowById('m1');
    assert.equal(row.organizerNote, 'reviewed');
    assert.equal(row.status, 'no', 'the admin patch did not blank the columns it omitted');
  });
});
