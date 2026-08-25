// backend-kv-pglite.test.js — the BROWSER's local mode, exercised in Node.
//
// backend-local-pglite.js is a plain script that assigns globals, so it cannot be required. But it is a
// thin platform shim: everything it actually does is createKvBackend(storage-pglite, platform), and both
// of those ARE requireable. So this test stands up exactly the stack that runs in the tab — the shared
// kv contract on top of PostgreSQL-in-WASM with supabase-schema.sql applied — and drives it. What is not
// covered here is the ESM import of the vendored dist and IndexedDB persistence, which need a browser.
//
// Two things are being pinned, and the second is the reason this file exists:
//   1. backend-kv.js works on a storage adapter that is NOT storage-supabase.js. It was extracted from
//      backend-supabase.js, and an extraction that quietly kept a Supabase assumption would still pass
//      every Supabase test.
//   2. The browser-local mode really is gated by the production policy. "It runs the real RLS" is the
//      whole claim of that backend; a test that only checked round-trips would pass just as happily
//      against no policy at all.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createPgliteStorage } = require('../../storage-pglite');
const { createKvBackend } = require('../../backend-kv');

const SCHEMA = {
  tables: {
    tasks: { columns: [{ name: 'id' }, { name: 'title' }, { name: 'status', list: 'status' }] },
    notes: { columns: [{ name: 'id' }, { name: 'body' }] }
  },
  views: []
};

let S, B, U;
let email = 'admin@x.com';   // what the platform reports as "me"; the tests move it around

before(async () => {
  S = await createPgliteStorage({});                       // in-memory cluster, real policies
  // The same platform backend-local-pglite.js builds: an identity with no authority behind it, and the
  // bootstrap probe answered by the schema's own SECURITY DEFINER function rather than by a read that
  // RLS would filter.
  const kv = createKvBackend(S, {
    name: 'Local (this browser)',
    myEmail: () => email,
    noUsers: () => S._query('select public.app_no_users() as none')
      .then((r) => !!(r && r.rows && r.rows[0] && r.rows[0].none))
      .catch(() => false)
  });
  B = kv.backend;
  U = kv.users;
  const setCaller = (e) => { email = e; S.setCaller(e); };
  B._test_as = setCaller;
  setCaller('admin@x.com');
});
after(async () => { if (S) await S.close(); });

const attempt = (p) => Promise.resolve(p).then(() => 'ok', (e) => (/row-level security/.test(e.message) ? 'denied' : 'threw: ' + e.message));

describe('browser-local kv backend — first boot is a bootstrap, and closing it sticks', () => {
  it('an empty registry makes the first visitor an admin', async () => {
    B._test_as('admin@x.com');
    assert.deepEqual(await U.getMyAccess(), { bootstrap: true });
  });

  it('the schema saves, and the schema-blind policies get their mirrors', async () => {
    B._test_as('admin@x.com');
    await B.saveSchema(SCHEMA);
    for (const key of ['schema', 'ownerTables', 'pageAccess', 'ownerWritable', 'listTables', 'listWritable']) {
      assert.ok((await S.getMeta(key)) !== undefined, '_meta/' + key + ' must be mirrored by saveSchema');
    }
    assert.deepEqual(Object.keys((await B.getSchema()).tables).sort(), ['notes', 'tasks']);
  });

  it('registering the first member ends bootstrap for everyone else', async () => {
    B._test_as('admin@x.com');
    await U.setUserRole('admin@x.com', 'admin', 'admin@x.com', 'all');
    assert.deepEqual(await U.getMyAccess(), { role: 'admin', tables: 'all' });

    // The visitor who arrives second is not silently promoted -- the whole risk of a bootstrap window.
    B._test_as('stranger@x.com');
    assert.deepEqual(await U.getMyAccess(), { registered: false });
    B._test_as('admin@x.com');
  });
});

describe('browser-local kv backend — rows are gated by the production RLS', () => {
  before(async () => {
    B._test_as('admin@x.com');
    await U.setUserRole('editor@x.com', 'editor', 'editor@x.com', { tasks: 'rw' });
    await U.setUserRole('viewer@x.com', 'viewer', 'viewer@x.com', {});
  });

  it('an admin writes and reads back', async () => {
    B._test_as('admin@x.com');
    assert.equal(await attempt(B.putRow('tasks', { id: 'r1', title: 'One' }, 'active')), 'ok');
    const d = await B.getTableData('tasks', 'active');
    assert.deepEqual(d.rows.map((r) => r.id), ['r1']);
    assert.ok(d.headers.includes('title'), 'headers are derived from the rows');
  });

  it('an editor granted `tasks` may write tasks but not notes', async () => {
    B._test_as('editor@x.com');
    assert.equal(await attempt(B.putRow('tasks', { id: 'r2', title: 'Two' }, 'active')), 'ok');
    assert.equal(await attempt(B.putRow('notes', { id: 'n1', body: 'nope' }, 'active')), 'denied');
  });

  it('a member with no grants reads nothing and writes nothing', async () => {
    B._test_as('viewer@x.com');
    assert.deepEqual((await B.getTableData('tasks', 'active')).rows, []);
    assert.equal(await attempt(B.putRow('tasks', { id: 'r3', title: 'no' }, 'active')), 'denied');
  });

  it('a partial write merges rather than blanking the columns it omits', async () => {
    B._test_as('admin@x.com');
    await B.putRow('tasks', { id: 'r1', title: 'One', status: 'open' }, 'active');
    await B.putRow('tasks', { id: 'r1', status: 'done' }, 'active');
    const row = (await B.getTableData('tasks', 'active')).rows.find((r) => r.id === 'r1');
    assert.equal(row.status, 'done');
    assert.equal(row.title, 'One', 'the omitted column was blanked -- putRow must merge');
  });
});

describe('browser-local kv backend — boot, lists and languages over the shared contract', () => {
  it('bootData returns the schema and reports the caller unrestricted', async () => {
    B._test_as('admin@x.com');
    const boot = await B.bootData();
    assert.ok(boot.schema && boot.schema.tables.tasks, 'bootData did not return the schema');
    assert.equal(boot.unrestricted, true);
    assert.deepEqual(boot.data, {}, 'boot must not prefetch table data');
  });

  it('bootData refuses a non-member without pretending the database is empty', async () => {
    B._test_as('stranger@x.com');
    const boot = await B.bootData();
    assert.equal(boot.denied, true);
    assert.equal(boot.schema, null);
  });

  it('lists round-trip, and an item appends without rewriting the list', async () => {
    B._test_as('admin@x.com');
    await B.saveLists({ status: ['open', 'done'] });
    await B.putListItem('status', 'blocked');
    assert.deepEqual((await B.getLists()).status, ['open', 'done', 'blocked']);
  });

  it('a restricted member sees only the lists their tables own', async () => {
    B._test_as('editor@x.com');           // granted `tasks`, which owns the `status` list
    assert.deepEqual(Object.keys(await B.getLists()), ['status']);
    B._test_as('viewer@x.com');           // granted nothing
    assert.deepEqual(await B.getLists(), {});
  });

  it('a second language pack layers onto the first instead of erasing it', async () => {
    B._test_as('admin@x.com');
    await B.createLanguage('en', 'English', ['field.topic']);
    await B.updateTranslations('en', { 'field.topic': 'Topic' });
    await B.createLanguage('en', 'English', ['btn.add']);          // a disjoint pack, as import does
    const t = await B.getTranslations('en');
    assert.equal(t['field.topic'], 'Topic', 'the first pack was erased by the second');
    assert.ok('btn.add' in t);
    assert.ok((await B.getAvailableLanguages()).some((l) => (l.code || l) === 'en'));
  });
});

describe('browser-local kv backend — capabilities are advertised, never faked', () => {
  it('offers no uploadFile, so image columns fall through to the _assets data-URI path', () => {
    assert.equal(typeof B.uploadFile, 'undefined',
      'a stub uploadFile would light up an upload button for a store that does not exist');
  });

  it('offers no subscribeTable, because a single-tab local database has no second client', () => {
    assert.equal(typeof B.subscribeTable, 'undefined');
    assert.ok(!B.subscribeLoads);
  });
});

describe('browser-local kv backend — image columns still work, via the in-database asset store', () => {
  // The absence of uploadFile above reads like "no image uploads here", and it is the opposite: app-core's
  // uploadImage has TWO sinks and falls through to the second one, which needs nothing but putRow. So a
  // backend with no blob store keeps the feature and pays for it in row bytes -- the same tier a Firebase
  // Spark project lands in, since Firebase Storage needs Blaze. Asserted because nothing else covers the
  // combination, and because the ONLY thing bounding an upload on this path is the shape rule below:
  // jsonb would happily accept a gigabyte.
  const dataUrl = (n) => 'data:image/png;base64,' + 'A'.repeat(n);

  it('an admin stores an image as a row, and getAsset hands it back', async () => {
    B._test_as('admin@x.com');
    assert.equal(await attempt(B.putRow('_assets', { id: 'img_1', src: dataUrl(600000) }, 'active')), 'ok');
    const got = await B.getAsset('img_1');
    assert.ok(got && got.src.startsWith('data:image/png;base64,'));
    assert.equal(got.src.length, 600000 + 'data:image/png;base64,'.length);
  });

  it('an editor may store one too -- assets are not admin-only', async () => {
    B._test_as('editor@x.com');
    assert.equal(await attempt(B.putRow('_assets', { id: 'img_2', src: dataUrl(1000) }, 'active')), 'ok');
  });

  it('a viewer may not: the asset store is deliberately not self-writable', async () => {
    B._test_as('viewer@x.com');
    assert.equal(await attempt(B.putRow('_assets', { id: 'img_3', src: dataUrl(1000) }, 'active')), 'denied');
  });

  it('the 900k cap is enforced by the policy, not merely by the uploader that downscales to fit', async () => {
    // app-core shrinks an image until it fits ASSET_CAP before writing. That is a convenience, not the
    // boundary -- putRow is reachable without it, so the cap has to hold in the database as well.
    B._test_as('admin@x.com');
    assert.equal(await attempt(B.putRow('_assets', { id: 'huge', src: dataUrl(950000) }, 'active')), 'denied');
  });

  it('every registered member can READ an asset, or a shared image would render as a hole', async () => {
    B._test_as('viewer@x.com');
    assert.ok((await B.getAsset('img_1')).src, 'a member with no table grants must still see stored images');
  });
});
