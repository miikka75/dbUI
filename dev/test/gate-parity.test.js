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
// A SECOND server, this one on --pg, where the JavaScript gates are stood down and the policies are the
// only gate. Its verdicts must match the first server's, or standing them down changed behaviour.
const PG_PORT = PORT + 1;
const PG_BASE = 'http://127.0.0.1:' + PG_PORT;
const PG_DB_REL = path.join('test', '.gppg-' + process.pid + '.db');

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
    },
    // ownerWritableWhile: ownership does not expire on its own, so without this an owner could still
    // rewrite their entry the day after it was ruled on. The owner branch reaches the row only WHILE
    // status is still `logged`.
    entries: {
      ownerWritable: ['status', 'note'],
      ownerWritableWhile: { status: 'logged' },
      columns: {
        id: { type: 'text' },
        owner: { type: 'owner' },
        status: { type: 'text' },
        note: { type: 'text' }
      }
    },
    // An identity column: `defaultFrom: '@me'` inside ownerWritable. It must be owner-writable or the
    // owner could not create the row at all -- which is exactly what leaves them free to write SOMEBODY
    // ELSE'S identity and log the work as them. Both layers therefore require the caller's own value.
    logs: {
      ownerWritable: ['person', 'note'],
      columns: {
        id: { type: 'text' },
        owner: { type: 'owner' },
        person: { type: 'select', list: 'members', defaultFrom: '@me' },
        note: { type: 'text' }
      }
    }
  },
  // `access` lists TABLE names: a restricted caller may read the page only if one of their granted
  // tables appears here. `open` carries none, so everyone registered may read it.
  views: [
    { name: 'open',   markdown: '# Open' },
    { name: 'secret', markdown: '# Secret', access: ['notes'] }
  ],
  // Everything else is admin-only to edit; this one list is opened to any member.
  userWritableLists: ['status']
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

let child, pgChild, PG;

function postTo(base, route, body, user) {
  return fetch(base + '/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user || 'admin@x.com' },
    body: JSON.stringify(body || {})
  });
}
const post = (route, body, user) => postTo(BASE, route, body, user);
const postPg = (route, body, user) => postTo(PG_BASE, route, body, user);

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
  await post('putRow', { tableId: '_pages', tab: 'active', data: { id: 'open', markdown: '# Open' } }, 'admin@x.com');
  await post('putRow', { tableId: '_pages', tab: 'active', data: { id: 'secret', markdown: '# Secret' } }, 'admin@x.com');
  await post('saveLists', { lists: { status: ['a'], locked: ['a'], members: ['Ann', 'Bob'] } }, 'admin@x.com');
  // Link the list value 'Ann' to the member. The dev gate resolves identity through these links;
  // the policies read it off the grant doc, which is what setListUser mirrors in production.
  await post('setListUser', { listName: 'members', value: 'Ann', email: 'member@x.com' }, 'admin@x.com');

  // --- the RLS policies: backend-pglite, no JavaScript gate ---
  PG = await createPgliteBackend();
  PG.setCaller('admin@x.com');            // bootstrap
  await PG.saveSchema(SCHEMA);
  for (const [email, g] of Object.entries(ACTORS)) {
    const doc = { role: g.role, user: email, tables: g.tables };
    if (g.tables && typeof g.tables === 'object' && !Array.isArray(g.tables)) {
      doc.rwTables = Object.keys(g.tables).filter((t) => g.tables[t] !== 'r');
    }
    if (email === 'member@x.com') doc.identity = { members: 'Ann' };   // what setListUser mirrors
    await PG._seed('_users', email, doc);
  }
  await PG.putRow('tasks', { id: 'seed', title: 'seed' }, 'active');
  await PG.putRow('notes', { id: 'seed', body: 'seed' }, 'active');
  await PG.putRow('_pages', { id: 'open', markdown: '# Open' }, 'active');
  await PG.putRow('_pages', { id: 'secret', markdown: '# Secret' }, 'active');

  // --- the same app, served by the --pg server, with the JavaScript gates stood down ---
  pgChild = spawn(process.execPath, ['server.js', '--pg'], {
    cwd: DEV_DIR,
    env: Object.assign({}, process.env, { PORT: String(PG_PORT), APP_DB: PG_DB_REL }),
    stdio: 'ignore'
  });
  let pgUp = false;
  const pgDeadline = Date.now() + 30000;          // PGlite boots a WASM Postgres and applies the schema
  while (!pgUp && Date.now() < pgDeadline) {
    try { pgUp = (await postPg('serverInfo', {})).ok; }
    catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(pgUp, '--pg dev server started');

  await postPg('saveSchema', { schema: SCHEMA });
  for (const [email, g] of Object.entries(ACTORS)) {
    await postPg('setUserRole', { uid: email, role: g.role, user: email, email: email, tables: g.tables });
  }
  await postPg('saveLists', { lists: { status: ['a'], locked: ['a'], members: ['Ann', 'Bob'] } }, 'admin@x.com');
  await postPg('setListUser', { listName: 'members', value: 'Ann', email: 'member@x.com' }, 'admin@x.com');
  await postPg('putRow', { tableId: 'tasks', tab: 'active', data: { id: 'seed', title: 'seed' } }, 'admin@x.com');
  await postPg('putRow', { tableId: 'notes', tab: 'active', data: { id: 'seed', body: 'seed' } }, 'admin@x.com');
  await PG.saveLists({ status: ['a'], locked: ['a'], members: ['Ann', 'Bob'] });
});

after(async () => {
  if (PG) { try { await PG.close(); } catch (e) {} }
  for (const c of [child, pgChild]) {
    if (!c) continue;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
    if (f.startsWith('.gp-' + process.pid) || f.startsWith('.gppg-' + process.pid)) {
      try { fs.rmSync(path.join(DEV_DIR, 'test', f), { recursive: true, force: true }); } catch (e) {}
    }
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

// ==================================================================================================
// Doc-view access and per-list write access -- the last two gates in dev/server.js with no parity
// coverage. JavaScript side: filterPages / canReadPages, and the userWritableLists check on
// putListItem. Policy side: app_page_allowed reading _meta/pageAccess, and app_list_create_allowed
// reading _meta/listWritable.

describe('gate parity — ownerWritableWhile freezes the owner branch', () => {
  const jsPut = async (user, data) => {
    const r = await post('putRow', { tableId: 'entries', tab: 'active', data }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };
  const rlsPut = async (user, data) => {
    PG.setCaller(user);
    try { await PG.putRow('entries', data, 'active'); return 'allow'; }
    catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
  };
  const both = async (user, data) => {
    const js = await jsPut(user, data);
    const rls = await rlsPut(user, data);
    assert.equal(js, rls, `the two gates disagree (js=${js}, rls=${rls})`);
    return js;
  };

  it('an owner may edit their row while it is still in the listed state', async () => {
    assert.equal(await both('member@x.com', { id: 'e1', owner: 'member@x.com', status: 'logged', note: 'first' }), 'allow');
    assert.equal(await both('member@x.com', { id: 'e1', owner: 'member@x.com', note: 'corrected' }), 'allow');
  });

  it('once the row leaves that state the owner is frozen out, and both gates agree', async () => {
    // Only an admin can move it: `status` is owner-writable, but the freeze is judged on the STORED
    // state, so the owner cannot rule on their own entry and then keep editing it.
    assert.equal(await both('admin@x.com', { id: 'e1', owner: 'member@x.com', status: 'approved' }), 'allow');
    assert.equal(await both('member@x.com', { id: 'e1', owner: 'member@x.com', note: 'sneaky' }), 'deny');
  });

  it('the owner cannot thaw their own row by putting the state back', async () => {
    // The most obvious way round the freeze: rewrite status to the open value. The gate reads the
    // stored state, not the incoming one, so this is refused for the same reason.
    assert.equal(await both('member@x.com', { id: 'e1', owner: 'member@x.com', status: 'logged' }), 'deny');
  });

  it('an admin is unaffected by the freeze', async () => {
    assert.equal(await both('admin@x.com', { id: 'e1', owner: 'member@x.com', note: 'organiser edit' }), 'allow');
  });
});

describe('gate parity — an owner may only ever name themselves', () => {
  const jsPut = async (user, data) => {
    const r = await post('putRow', { tableId: 'logs', tab: 'active', data }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };
  const rlsPut = async (user, data) => {
    PG.setCaller(user);
    try { await PG.putRow('logs', data, 'active'); return 'allow'; }
    catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
  };
  const both = async (user, data) => {
    const js = await jsPut(user, data);
    const rls = await rlsPut(user, data);
    assert.equal(js, rls, `the two gates disagree (js=${js}, rls=${rls})`);
    return js;
  };

  it('an owner may log work as themselves', async () => {
    assert.equal(await both('member@x.com', { id: 'l1', owner: 'member@x.com', person: 'Ann', note: 'mine' }), 'allow');
  });

  it('an owner may NOT log work as somebody else, on create', async () => {
    assert.equal(await both('member@x.com', { id: 'l2', owner: 'member@x.com', person: 'Bob', note: 'theirs' }), 'deny');
  });

  it('...nor by reassigning it afterwards', async () => {
    // The column IS one they may write, so column bounds cannot catch this -- only the identity check.
    assert.equal(await both('member@x.com', { id: 'l1', owner: 'member@x.com', person: 'Bob' }), 'deny');
  });

  it('an owner may still edit a field that is not the identity', async () => {
    assert.equal(await both('member@x.com', { id: 'l1', owner: 'member@x.com', note: 'amended' }), 'allow');
  });

  it('an admin logging on somebody else behalf is unaffected', async () => {
    // Not the owner branch: an organiser recording work for a member is the ordinary grant path.
    assert.equal(await both('admin@x.com', { id: 'l3', owner: 'member@x.com', person: 'Bob', note: 'on their behalf' }), 'allow');
  });
});

describe('gate parity — doc-view access', () => {
  // Asserted as a SET, for the same reason as the owner read: "may read pages" is not the question,
  // "WHICH pages" is. A gate that leaked the restricted page would pass a boolean check.
  const visibleJs = async (user) => {
    const r = await post('getTableData', { tableId: '_pages', tab: 'active' }, user);
    return r.ok ? (((await r.json()).rows) || []).map((x) => x.id).sort() : [];
  };
  const visibleRls = async (user) => {
    PG.setCaller(user);
    return (await PG.getTableData('_pages', 'active')).rows.map((x) => x.id).sort();
  };

  it('an admin sees every page through both gates', async () => {
    assert.deepEqual(await visibleJs('admin@x.com'), await visibleRls('admin@x.com'));
    assert.deepEqual(await visibleJs('admin@x.com'), ['open', 'secret']);
  });

  it('a caller granted only `tasks` sees the open page and not the restricted one', async () => {
    const js = await visibleJs('editor@x.com');
    const rls = await visibleRls('editor@x.com');
    assert.deepEqual(js, rls, `the two gates scope pages differently (js=${js}, rls=${rls})`);
    assert.deepEqual(js, ['open'], 'secret is gated behind a `notes` grant this caller lacks');
  });
});

describe('gate parity — per-list write access', () => {
  const jsPut = async (user, list) => {
    const r = await post('putListItem', { listName: list, value: 'x-' + user }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };
  const rlsPut = async (user, list) => {
    PG.setCaller(user);
    try { await PG.putListItem(list, 'x-' + user); return 'allow'; }
    catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
  };

  for (const [user, list, expected, label] of [
    ['member@x.com', 'status', 'allow', 'a member may append to a list the schema opens'],
    ['member@x.com', 'locked', 'deny',  'a member may not touch a list the schema does not open'],
    ['admin@x.com',  'locked', 'allow', 'an admin may edit any list']
  ]) {
    it(`${label} -> ${expected}`, async () => {
      const js = await jsPut(user, list);
      const rls = await rlsPut(user, list);
      assert.equal(js, rls, `the two gates disagree (js=${js}, rls=${rls}) on: ${label}`);
      assert.equal(js, expected);
    });
  }

  // The read policy for _lists honours userWritableLists precisely so that this works: an UPDATE has
  // to locate its row, which applies the SELECT policy, so a list a member cannot read is one they
  // cannot append to either. This case is what caught that.
});

describe('gate parity — deletes', () => {
  const jsDel = async (user, table, id) => {
    const r = await post('deleteRow', { tableId: table, tab: 'active', id }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };
  const rlsDel = async (user, table, id) => {
    PG.setCaller(user);
    try { await PG.deleteRow(table, id, 'active'); return 'allow'; }
    catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
  };
  const both = async (user, table, id) => {
    const js = await jsDel(user, table, id);
    const rls = await rlsDel(user, table, id);
    assert.equal(js, rls, `the two gates disagree on delete (js=${js}, rls=${rls})`);
    return js;
  };

  it('a member with no grant cannot delete a table row', async () => {
    assert.equal(await both('member@x.com', 'tasks', 'seed'), 'deny');
  });

  it('an owner may delete their own self-service row', async () => {
    await post('putRow', { tableId: 'signups', tab: 'active', data: { id: 'd1', owner: 'member@x.com', status: 'yes' } }, 'member@x.com');
    PG.setCaller('member@x.com');
    await PG.putRow('signups', { id: 'd1', owner: 'member@x.com', status: 'yes' }, 'active');
    assert.equal(await both('member@x.com', 'signups', 'd1'), 'allow');
  });

  it("an owner may not delete somebody else's row", async () => {
    await post('putRow', { tableId: 'signups', tab: 'active', data: { id: 'd2', owner: 'other@x.com', status: 'yes' } }, 'other@x.com');
    PG.setCaller('other@x.com');
    await PG.putRow('signups', { id: 'd2', owner: 'other@x.com', status: 'yes' }, 'active');
    assert.equal(await both('member@x.com', 'signups', 'd2'), 'deny');
  });

  it('the ownerWritableWhile freeze covers delete, not just edit', async () => {
    // Ownership expiring for edits but not deletes would let an owner erase a ruled-on entry instead of
    // amending it -- the same escape by another door.
    assert.equal(await both('member@x.com', 'entries', 'e1'), 'deny');
  });
});

describe('gate parity — doc-view writes', () => {
  const jsPut = async (user, id) => {
    const r = await post('putRow', { tableId: '_pages', tab: 'active', data: { id, markdown: '# edited by ' + user } }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };
  const rlsPut = async (user, id) => {
    PG.setCaller(user);
    try { await PG.putRow('_pages', { id, markdown: '# edited by ' + user }, 'active'); return 'allow'; }
    catch (e) { if (/row-level security/.test(e.message)) return 'deny'; throw e; }
  };

  for (const [user, expected, label] of [
    ['admin@x.com',  'allow', 'an admin may edit a doc-view body'],
    ['editor@x.com', 'allow', 'an editor may edit a doc-view body'],
    ['member@x.com', 'deny',  'a member may not, even one they can read']
  ]) {
    it(`${label} -> ${expected}`, async () => {
      const js = await jsPut(user, 'open');
      const rls = await rlsPut(user, 'open');
      assert.equal(js, rls, `the two gates disagree (js=${js}, rls=${rls}) on: ${label}`);
      assert.equal(js, expected);
    });
  }
});

// ==================================================================================================
// The whole point of the phase: with --pg, the JavaScript gates are stood down and the policies are the
// only thing deciding. If that changed any answer, this is where it shows -- the same matrix, against a
// server that has no JavaScript gate left to fall back on.
describe('gate parity — the --pg server, with the JS gates stood down', () => {
  const pgHttp = async (user, table, op) => {
    if (op === 'read') {
      const r = await postPg('getTableData', { tableId: table, tab: 'active' }, user);
      if (!r.ok) return 'deny';
      const d = await r.json();
      if (d && d.error) return 'deny';
      return (d.rows || []).length ? 'allow' : 'deny';
    }
    const r = await postPg('putRow', { tableId: table, tab: 'active', data: { id: 'probe-' + user, title: 'x', body: 'x' } }, user);
    if (!r.ok) return 'deny';
    const d = await r.json();
    return (d && d.error) ? 'deny' : 'allow';
  };

  for (const [user, table, op, expected] of MATRIX) {
    it(`${op} ${table} as ${user.split('@')[0]} -> ${expected}`, async () => {
      const got = await pgHttp(user, table, op);
      assert.equal(got, expected,
        'the --pg server answered ' + got + ' where both gates agree on ' + expected +
        ' -- standing the JavaScript gates down changed behaviour');
    });
  }

  it('an owner may create their own row on a table they hold no grant on', async () => {
    const r = await postPg('putRow', { tableId: 'signups', tab: 'active', data: { id: 'pg1', owner: 'member@x.com', status: 'yes' } }, 'member@x.com');
    assert.equal((await r.json()).error, undefined);
  });

  it('...and may not create one owned by somebody else', async () => {
    const r = await postPg('putRow', { tableId: 'signups', tab: 'active', data: { id: 'pg2', owner: 'other@x.com', status: 'yes' } }, 'member@x.com');
    assert.ok((await r.json()).error, 'the policy must refuse this with no JavaScript gate in front of it');
  });

  it('...nor set a column outside ownerWritable on their own row', async () => {
    const r = await postPg('putRow', { tableId: 'signups', tab: 'active', data: { id: 'pg1', owner: 'member@x.com', organizerNote: 'hah' } }, 'member@x.com');
    assert.ok((await r.json()).error, 'ownerWritable must still bind');
  });
});

// The registry the policies read is a MIRROR of the dev server's, and a mirror has to reflect removals
// as well as additions. If it did not, removeUser would revoke access on the JavaScript side while RLS
// kept honouring the stale grant -- and under --pg RLS is the only gate left, so the revocation would
// simply not happen.
describe('gate parity — revoking a member revokes it in the policy store too', () => {
  it('a removed member loses the access they had', async () => {
    await postPg('setUserRole', { uid: 'temp@x.com', role: 'admin', user: 'temp@x.com', email: 'temp@x.com', tables: 'all' }, 'admin@x.com');
    let r = await postPg('putRow', { tableId: 'tasks', tab: 'active', data: { id: 'tmp1', title: 'as admin' } }, 'temp@x.com');
    assert.equal((await r.json()).error, undefined, 'the new admin can write');

    await postPg('removeUser', { uid: 'temp@x.com' }, 'admin@x.com');
    r = await postPg('putRow', { tableId: 'tasks', tab: 'active', data: { id: 'tmp2', title: 'after removal' } }, 'temp@x.com');
    assert.ok((await r.json()).error, 'and must not still be able to write once removed');
  });
});

// App-level config is shared state for everyone using the database, and all three layers now agree that
// only an admin may write it. The dev server used to be the permissive outlier here -- the opposite
// direction to the userWritableLists divergence, which is why one harness catches both.
describe('gate parity — app config writes', () => {
  const both = async (user, config) => {
    const r = await post('setFolderConfig', { config }, user);
    const js = r.ok && !((await r.json()) || {}).error ? 'allow' : 'deny';
    PG.setCaller(user);
    let rls = 'allow';
    try { await PG.setFolderConfig(config); }
    catch (e) { if (/row-level security/.test(e.message)) rls = 'deny'; else throw e; }
    assert.equal(js, rls, `the two gates disagree (js=${js}, rls=${rls}) on writing app config as ${user}`);
    return js;
  };

  it('a member may not write app config', async () => {
    assert.equal(await both('member@x.com', { tabsNav: true }), 'deny');
  });

  it('an editor holding a table grant may not either -- it is not a table', async () => {
    assert.equal(await both('editor@x.com', { tabsNav: true }), 'deny');
  });

  it('an admin may', async () => {
    assert.equal(await both('admin@x.com', { tabsNav: false }), 'allow');
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
