// backend-pglite.test.js — the dev storage contract served from Postgres, with the production policy
// enforcing underneath.
//
// backend-local.js (SQLite) is gated by hand-written JavaScript in dev/server.js. This backend is gated
// by supabase-schema.sql itself. These tests drive the SAME contract and assert the SAME outcomes, so
// what they establish is that dev can stop carrying its own copy of the access model.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createPgliteBackend } = require('../backend-pglite');

const SCHEMA = {
  tables: {
    tasks: { columns: [{ name: 'id' }, { name: 'title' }, { name: 'status', list: 'status' }] },
    notes: { columns: [{ name: 'id' }, { name: 'body' }] }
  },
  views: []
};

let B;
before(async () => {
  B = await createPgliteBackend();
  B.setCaller('admin@x.com');          // bootstrap: no members yet, so this caller is admin
  await B.saveSchema(SCHEMA);
  // Close bootstrap by seeding the registry (not a user action -> seeded as owner).
  await B._seed('_users', 'admin@x.com',  { role: 'admin',  user: 'admin@x.com',  tables: 'all' });
  await B._seed('_users', 'editor@x.com', { role: 'editor', user: 'editor@x.com', tables: ['tasks'] });
  await B._seed('_users', 'viewer@x.com', { role: 'viewer', user: 'viewer@x.com', tables: [] });
});
after(async () => { if (B) await B.close(); });

const attempt = (p) => p.then(() => 'ok', (e) => (/row-level security/.test(e.message) ? 'denied' : 'threw: ' + e.message));

describe('backend-pglite — schema', () => {
  // Key ORDER is deliberately not asserted: the schema lives in a jsonb column and Postgres normalises
  // jsonb object keys (sorted by length, then bytewise), so insertion order does not survive a
  // round-trip. Firestore preserves it. Nothing reads that order today -- see the note on tableOrder --
  // but a test that pinned it here would be pinning a difference between backends, not a contract.
  it('round-trips the schema document', async () => {
    B.setCaller('admin@x.com');
    const s = await B.getSchema();
    assert.deepEqual(Object.keys(s.tables).sort(), ['notes', 'tasks']);
  });

  it('mirrors the schema-derived facts the schema-blind policies read', async () => {
    // If these are missing the policies still RUN, they just evaluate against nothing -- which fails
    // open or closed depending on the rule. That is why they are asserted directly rather than inferred
    // from behaviour.
    B.setCaller('admin@x.com');
    for (const key of ['ownerTables', 'pageAccess', 'ownerWritable', 'listTables', 'listWritable']) {
      const v = await B._storage.getMeta(key);
      assert.ok(v !== undefined, '_meta/' + key + ' must be mirrored by saveSchema');
    }
  });

  it('getAvailableTables reads the schema, not a table registry', async () => {
    B.setCaller('admin@x.com');
    assert.deepEqual((await B.getAvailableTables()).map((t) => t.id).sort(), ['notes', 'tasks']);
  });
});

describe('backend-pglite — rows are gated by RLS, not by this file', () => {
  it('an admin writes and reads back', async () => {
    B.setCaller('admin@x.com');
    assert.equal(await attempt(B.putRow('tasks', { id: 'r1', title: 'One' }, 'active')), 'ok');
    const d = await B.getTableData('tasks', 'active');
    assert.deepEqual(d.rows.map((r) => r.id), ['r1']);
    assert.ok(d.headers.includes('title'), 'headers are derived from the rows');
  });

  it('an editor granted `tasks` may write tasks but not notes', async () => {
    B.setCaller('editor@x.com');
    assert.equal(await attempt(B.putRow('tasks', { id: 'r2', title: 'Two' }, 'active')), 'ok');
    assert.equal(await attempt(B.putRow('notes', { id: 'n1', body: 'nope' }, 'active')), 'denied');
  });

  it('a viewer with no grants reads nothing and writes nothing', async () => {
    B.setCaller('viewer@x.com');
    assert.deepEqual((await B.getTableData('tasks', 'active')).rows, []);
    assert.equal(await attempt(B.putRow('tasks', { id: 'r3', title: 'no' }, 'active')), 'denied');
  });

  it('a partial write merges rather than replacing', async () => {
    B.setCaller('admin@x.com');
    await B.putRow('tasks', { id: 'r1', status: 'open' }, 'active');   // no title in the payload
    const row = (await B.getTableData('tasks', 'active')).rows.find((r) => r.id === 'r1');
    assert.deepEqual(row, { id: 'r1', title: 'One', status: 'open' }, 'title must survive the patch');
  });

  it('moveRow relocates a row between partitions', async () => {
    B.setCaller('admin@x.com');
    await B.putRow('tasks', { id: 'mv', title: 'Move me' }, 'active');
    await B.moveRow('tasks', { id: 'mv', title: 'Move me' }, 'active', 'archive');
    const act = (await B.getTableData('tasks', 'active')).rows.map((r) => r.id);
    const arc = (await B.getTableData('tasks', 'archive')).rows.map((r) => r.id);
    assert.ok(!act.includes('mv'), 'gone from active');
    assert.ok(arc.includes('mv'), 'present in archive');
  });

  it('deleteRow removes it', async () => {
    B.setCaller('admin@x.com');
    await B.deleteRow('tasks', 'r2', 'active');
    assert.ok(!(await B.getTableData('tasks', 'active')).rows.some((r) => r.id === 'r2'));
  });
});

describe('backend-pglite — lists carry their ownership label', () => {
  it('saveLists writes items plus the owning tables the policy reads', async () => {
    B.setCaller('admin@x.com');
    await B.saveLists({ status: ['open', 'done'] });
    assert.deepEqual(await B.getLists(), { status: ['open', 'done'] });
    const doc = await B._storage.get('_lists', 'status');
    assert.deepEqual(doc.items, ['open', 'done']);
    assert.ok(Array.isArray(doc.tables), 'the ownership label must be written WITH the row');
    assert.ok(doc.tables.includes('tasks'), 'status is referenced by tasks');
  });

  it('putListItem appends without duplicating', async () => {
    B.setCaller('admin@x.com');
    await B.putListItem('status', 'blocked');
    await B.putListItem('status', 'blocked');
    assert.deepEqual((await B.getLists()).status, ['open', 'done', 'blocked']);
  });

  it('saveLists prunes lists that were dropped', async () => {
    B.setCaller('admin@x.com');
    await B.saveLists({ status: ['open'] , extra: ['x'] });
    assert.deepEqual(Object.keys(await B.getLists()).sort(), ['extra', 'status']);
    await B.saveLists({ status: ['open'] });
    assert.deepEqual(Object.keys(await B.getLists()), ['status']);
  });
});

describe('backend-pglite — languages and translations', () => {
  it('creates a language with empty keys, then merges updates into it', async () => {
    B.setCaller('admin@x.com');
    await B.createLanguage('fi', 'Suomi', ['greet', 'bye']);
    assert.deepEqual((await B.getAvailableLanguages()).map((l) => l.code || l), ['fi']);
    assert.deepEqual(await B.getTranslations('fi'), { greet: '', bye: '' });

    await B.updateTranslations('fi', { greet: 'Moi' });
    assert.deepEqual(await B.getTranslations('fi'), { greet: 'Moi', bye: '' }, 'an update MERGES');
  });

  it('renames and deletes a language', async () => {
    B.setCaller('admin@x.com');
    await B.renameLanguage('fi', 'Finnish');
    assert.deepEqual((await B.getAvailableLanguages())[0], { code: 'fi', name: 'Finnish' });
    await B.deleteLanguage('fi');
    assert.deepEqual(await B.getAvailableLanguages(), []);
    assert.deepEqual(await B.getTranslations('fi'), {});
  });
});

describe('backend-pglite — app config and user-linked lists', () => {
  it('folder config round-trips and REPLACES on write', async () => {
    B.setCaller('admin@x.com');
    await B.setFolderConfig({ theme: 'dark', extra: 1 });
    await B.setFolderConfig({ theme: 'light' });
    assert.deepEqual(await B.getFolderConfig(), { theme: 'light' });
  });

  it('list-user links round-trip', async () => {
    B.setCaller('admin@x.com');
    assert.deepEqual(await B.getListUsers(), {});
    await B.saveListUsers({ crew: { Alex: 'alex@x.com' } });
    assert.deepEqual(await B.getListUsers(), { crew: { Alex: 'alex@x.com' } });
  });
});

describe('backend-pglite — pushing a filter into the query returns the same rows', () => {
  // The pushdown property, against a real database rather than the in-memory stand-in query.test.js
  // uses:  read(constraints) + residual  ===  read(all) + whole condition.
  //
  // Getting this wrong does not throw. It returns a view with rows quietly missing, so the comparison is
  // the test — not a check that the SQL ran.
  const Query = require('../../query');
  const Rows = require('../../rows');

  before(async () => {
    B.setCaller('admin@x.com');
    await B.putRow('tasks', { id: 'p1', title: 'a', status: 'open',  owner: 'ann' }, 'active');
    await B.putRow('tasks', { id: 'p2', title: 'b', status: 'done',  owner: 'ann' }, 'active');
    await B.putRow('tasks', { id: 'p3', title: 'c', status: 'open',  owner: 'bob' }, 'active');
    await B.putRow('tasks', { id: 'p4', title: 'd',                  owner: 'bob' }, 'active');   // no status
  });

  const CASES = [
    { status: 'open' },
    { status: 'open', owner: 'ann' },
    { status: 'missing-value' },
    { status: { ne: 'open' } },              // not pushable -- must still come out right
    { $or: [{ status: 'open' }, { owner: 'bob' }] },
    {}
  ];

  for (const cond of CASES) {
    it('agrees for ' + JSON.stringify(cond), async () => {
      B.setCaller('admin@x.com');
      const { constraints, residual } = Query.compile(cond);

      const pushed = (await B.getTableData('tasks', 'active', { constraints })).rows
        .filter((r) => Rows.condMatches(r, residual)).map((r) => r.id).sort();

      const whole = (await B.getTableData('tasks', 'active')).rows
        .filter((r) => Rows.condMatches(r, cond)).map((r) => r.id).sort();

      assert.deepEqual(pushed, whole, 'pushing the filter down changed which rows came back');
    });
  }

  it('actually narrows, rather than quietly ignoring the constraints', async () => {
    // Equivalence would also hold if getAll ignored constraints entirely, and then the whole exercise
    // would buy nothing. This is what proves the database did the work.
    B.setCaller('admin@x.com');
    const { constraints } = Query.compile({ status: 'open' });
    const narrowed = await B.getTableData('tasks', 'active', { constraints });
    const all = await B.getTableData('tasks', 'active');
    assert.ok(narrowed.rows.length < all.rows.length, 'the query returned everything');
    assert.ok(narrowed.rows.every((r) => r.status === 'open'));
  });

  it('a row missing the field is excluded by an equality, matching condMatches', async () => {
    B.setCaller('admin@x.com');
    const { constraints } = Query.compile({ status: 'open' });
    const ids = (await B.getTableData('tasks', 'active', { constraints })).rows.map((r) => r.id);
    assert.ok(!ids.includes('p4'), 'p4 has no status and must not match status == open');
  });
});
