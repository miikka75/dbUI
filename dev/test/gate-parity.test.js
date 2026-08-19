// gate-parity.test.js — do the dev server's JavaScript access gates and the production RLS policies
// reach the SAME verdict?
//
// This is the test that makes phase 02's last step safe. dev/server.js carries a hand-written copy of
// the access model; supabase-schema.sql carries the real one. The plan is to delete the JavaScript
// copy, and the only responsible way to do that is to first show, case by case, that the two already
// agree — then delete only where they do.
//
// It differs from rules-parity.test.js, which compares the SOURCE TEXT of the policy layers looking for
// constants that drifted. This compares BEHAVIOUR: one access matrix, two engines, same verdicts.
//
//   js  = the JavaScript gate      -> a real dev server over HTTP (SQLite), which is how it actually runs
//   rls = supabase-schema.sql      -> backend-pglite in-process, which has no JavaScript gate at all
//
// A disagreement here is a finding about the policies, not a broken test.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { createPgliteBackend } = require('../backend-pglite');

const DEV_DIR = path.join(__dirname, '..');
const PORT = 4310 + (process.pid % 200);
const BASE = 'http://127.0.0.1:' + PORT;
const DB_REL = path.join('test', '.gp-' + process.pid + '.db');

// Two ordinary tables for the grant model, plus one self-service table for the owner model.
const SCHEMA = {
  tables: {
    tasks: { columns: { id: { type: 'text' }, title: { type: 'text' } } },
    notes: { columns: { id: { type: 'text' }, body: { type: 'text' } } },
    // The canonical self-service shape: an owner column (auto-stamped, read-only) plus an
    // ownerWritable bound naming the one column a member may actually set on their own row.
    signups: {
      ownerWritable: ['status'],
      columns: {
        id: { type: 'text' },
        owner: { type: 'owner' },
        status: { type: 'text' },
        organizerNote: { type: 'text' }      // NOT ownerWritable -- a member must never change it
      }
    }
  },
  views: []
};

const ACTORS = {
  'admin@x.com':  { role: 'admin',  tables: 'all' },
  'editor@x.com': { role: 'editor', tables: ['tasks'] },
  'reader@x.com': { role: 'viewer', tables: { tasks: 'r' } },
  'nobody@x.com': { role: 'viewer', tables: [] },
  // Hold NO grant on `signups`: everything they can do there comes from the owner column.
  'member@x.com': { role: 'viewer', tables: [] },
  'other@x.com':  { role: 'viewer', tables: [] }
};

// actor x table x operation. `expect` is what BOTH engines should say; it is written down rather than
// derived so that a case where the two agree with each other but disagree with the intent is still
// visible.
const MATRIX = [
  ['admin@x.com',  'tasks', 'read',  'allow'],
  ['admin@x.com',  'tasks', 'write', 'allow'],
  ['admin@x.com',  'notes', 'write', 'allow'],
  ['editor@x.com', 'tasks', 'read',  'allow'],
  ['editor@x.com', 'tasks', 'write', 'allow'],
  ['editor@x.com', 'notes', 'read',  'deny'],
  ['editor@x.com', 'notes', 'write', 'deny'],
  ['reader@x.com', 'tasks', 'read',  'allow'],
  ['reader@x.com', 'tasks', 'write', 'deny'],   // an 'r' grant reads but must not write
  ['reader@x.com', 'notes', 'write', 'deny'],
  ['nobody@x.com', 'tasks', 'read',  'deny'],
  ['nobody@x.com', 'tasks', 'write', 'deny'],
  ['nobody@x.com', 'notes', 'write', 'deny']
];

let child, PG;

function post(route, body, user) {
  return fetch(BASE + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'admin@x.com' },
    body: JSON.stringify(body || {})
  });
}

// --- the JavaScript gate, over HTTP --------------------------------------------------------------
async function jsVerdict(user, table, op) {
  if (op === 'read') {
    const r = await post('getTableData', { tableId: table, tab: 'active' }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    if (d && d.error) return 'deny';
    // A read that returns no rows where rows exist is a denial in substance: the gate scoped them away.
    return (d.rows || []).length ? 'allow' : 'deny';
  }
  const r = await post('putRow', { tableId: table, tab: 'active', data: { id: 'probe-' + user, title: 'x', body: 'x' } }, user);
  if (!r.ok) return 'deny';
  const d = await r.json();
  return (d && d.error) ? 'deny' : 'allow';
}

// --- the RLS policies, in-process ----------------------------------------------------------------
async function rlsVerdict(user, table, op) {
  PG.setCaller(user);
  if (op === 'read') {
    const d = await PG.getTableData(table, 'active');
    return (d.rows || []).length ? 'allow' : 'deny';
  }
  try {
    await PG.putRow(table, { id: 'probe-' + user, title: 'x', body: 'x' }, 'active');
    return 'allow';
  } catch (e) {
    if (/row-level security/.test(e.message)) return 'deny';
    throw e;
  }
}

before(async () => {
  // --- the JavaScript gate: a real dev server on SQLite ---
  child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR,
    env: Object.assign({}, process.env, { PORT: String(PORT), APP_DB: DB_REL }),
    stdio: 'ignore'
  });
  let up = false;
  const deadline = Date.now() + 10000;
  while (!up && Date.now() < deadline) {
    try {
      const r = await post('serverInfo', {});
      up = r.ok;
    } catch (e) { await new Promise((r) => setTimeout(r, 50)); }
  }
  assert.ok(up, 'dev server started');

  await post('saveSchema', { schema: SCHEMA });
  await post('initSchema', { schema: SCHEMA.tables });
  for (const [email, g] of Object.entries(ACTORS)) {
    await post('setUserRole', { uid: email, role: g.role, user: email, email: email, tables: g.tables });
  }
  // Seed a row in each table so a scoped-away read is distinguishable from an empty table.
  await post('putRow', { tableId: 'tasks', tab: 'active', data: { id: 'seed', title: 'seed' } }, 'admin@x.com');
  await post('putRow', { tableId: 'notes', tab: 'active', data: { id: 'seed', body: 'seed' } }, 'admin@x.com');

  // --- the RLS policies: backend-pglite, no JavaScript gate ---
  PG = await createPgliteBackend();
  PG.setCaller('admin@x.com');            // bootstrap
  await PG.saveSchema(SCHEMA);
  for (const [email, g] of Object.entries(ACTORS)) {
    const doc = { role: g.role, user: email, tables: g.tables };
    if (g.tables && typeof g.tables === 'object' && !Array.isArray(g.tables)) {
      doc.rwTables = Object.keys(g.tables).filter((t) => g.tables[t] !== 'r');
    }
    await PG._seed('_users', email, doc);
  }
  await PG.putRow('tasks', { id: 'seed', title: 'seed' }, 'active');
  await PG.putRow('notes', { id: 'seed', body: 'seed' }, 'active');
});

after(async () => {
  if (PG) { try { await PG.close(); } catch (e) {} }
  if (child) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
    if (f.startsWith('.gp-' + process.pid)) { try { fs.rmSync(path.join(DEV_DIR, 'test', f), { force: true }); } catch (e) {} }
  }
});

describe('gate parity — the JavaScript gate and the RLS policies agree', () => {
  for (const [user, table, op, expected] of MATRIX) {
    it(`${op} ${table} as ${user.split('@')[0]} -> ${expected}`, async () => {
      const js = await jsVerdict(user, table, op);
      const rls = await rlsVerdict(user, table, op);
      assert.equal(js, rls,
        `the two gates disagree (js=${js}, rls=${rls}). That is a finding about the policies, ` +
        'not a broken test: one of them is wrong about ' + op + ' ' + table + ' as ' + user);
      assert.equal(js, expected, 'both gates agree on ' + js + ', but the intent is ' + expected);
    });
  }
});

// ==================================================================================================
// The OWNER model: a member holding no grant at all, acting on their own row. This is the surface the
// grant matrix above does not reach -- canSeeRow / scopeToOwnRows / ownerFieldsOk / selfServiceOwnerCol
// on the JavaScript side, app_owner_identity_ok / app_owner_fields_ok in the policies. Deleting the
// JavaScript without covering it would be deleting a gate nothing had checked.

// Each case is a full write payload, because that is what both engines actually judge.
const OWNER_MATRIX = [
  ['member@x.com', { id: 's-mine',  owner: 'member@x.com', status: 'yes' }, 'allow',
   'a member creates their OWN row on a table they hold no grant on'],
  ['member@x.com', { id: 's-forge', owner: 'other@x.com',  status: 'yes' }, 'deny',
   'a member cannot create a row owned by someone else'],
  ['member@x.com', { id: 's-mine',  owner: 'member@x.com', status: 'no' }, 'allow',
   'a member may set an ownerWritable column on their own row'],
  ['member@x.com', { id: 's-mine',  owner: 'member@x.com', organizerNote: 'hah' }, 'deny',
   'a member may NOT set a column outside ownerWritable, even on their own row'],
  ['other@x.com',  { id: 's-mine',  owner: 'member@x.com', status: 'hijack' }, 'deny',
   "a member may not write someone else's row"],
  ['admin@x.com',  { id: 's-mine',  owner: 'member@x.com', organizerNote: 'ok' }, 'allow',
   'an admin is not bound by ownerWritable']
];

async function jsWrite(user, data) {
  const r = await post('putRow', { tableId: 'signups', tab: 'active', data }, user);
  if (!r.ok) return 'deny';
  const d = await r.json();
  return (d && d.error) ? 'deny' : 'allow';
}

async function rlsWrite(user, data) {
  PG.setCaller(user);
  try { await PG.putRow('signups', data, 'active'); return 'allow'; }
  catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
}

describe('gate parity — the owner model', () => {
  for (const [user, data, expected, label] of OWNER_MATRIX) {
    it(`${label} -> ${expected}`, async () => {
      const js = await jsWrite(user, data);
      const rls = await rlsWrite(user, data);
      assert.equal(js, rls,
        `the two gates disagree (js=${js}, rls=${rls}) on: ${label}. That is a finding about the ` +
        'policies, not a broken test.');
      assert.equal(js, expected, 'both gates agree on ' + js + ', but the intent is ' + expected);
    });
  }

  it('a member sees only their own rows', async () => {
    // Not a boolean: the two engines must scope the READ to the same set, or one of them is leaking.
    PG.setCaller('member@x.com');
    const rlsRows = (await PG.getTableData('signups', 'active')).rows.map((r) => r.id).sort();
    const jr = await post('getTableData', { tableId: 'signups', tab: 'active' }, 'member@x.com');
    const jsRows = ((await jr.json()).rows || []).map((r) => r.id).sort();
    assert.deepEqual(jsRows, rlsRows, 'the two gates scope the read differently');
  });
});

describe('gate parity — the matrix is not vacuous', () => {
  it('covers both verdicts and every actor', async () => {
    // A matrix of all-denies would pass trivially against a gate that refuses everything.
    for (const [name, m, verdictAt] of [['grant', MATRIX, 3], ['owner', OWNER_MATRIX, 2]]) {
      assert.ok(m.some((c) => c[verdictAt] === 'allow'), name + ' matrix must contain allows');
      assert.ok(m.some((c) => c[verdictAt] === 'deny'), name + ' matrix must contain denies');
    }
    // Every declared actor must actually be exercised by one matrix or the other -- an actor that is
    // set up but never used is a case someone meant to write and did not.
    const used = new Set([...MATRIX.map((c) => c[0]), ...OWNER_MATRIX.map((c) => c[0])]);
    assert.deepEqual([...used].sort(), Object.keys(ACTORS).sort());
  });
});
