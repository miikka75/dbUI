// bundle.test.js — planning an export's files and an import's work (bundle.js).
//
// fileSet's parity case lifts the _downloadFileSet app-core.js shipped BEFORE bundle.js existed, catches
// the files it would have downloaded, and compares; it had to pass before the member was switched over.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Bundle = require('../../bundle');
const { appCoreFn } = require('./app-core-fn');

const SCHEMA = { ref_teams: { isLookup: true }, tasks: { archivable: true }, notes: {} };
const all = () => true;
const only = (...parts) => (p) => parts.includes(p);

describe('isReference / declaresOnly', () => {
  it('a lookup is reference data under either partition key; anything unknown is ordinary', () => {
    assert.equal(Bundle.isReference(SCHEMA, 'ref_teams'), true);
    assert.equal(Bundle.isReference(SCHEMA, 'ref_teams__archive'), true);
    assert.equal(Bundle.isReference(SCHEMA, 'tasks__archive'), false);
    assert.equal(Bundle.isReference(SCHEMA, 'ref_unknown'), false);
  });
  it('lists that are all empty are declarations; one value makes them a vocabulary', () => {
    assert.equal(Bundle.declaresOnly({ a: [], b: [] }), true);
    assert.equal(Bundle.declaresOnly({}), true);
    assert.equal(Bundle.declaresOnly({ a: [], b: ['x'] }), false);
  });
});

describe('memberRecord', () => {
  it('a refused registry read is no roster at all, never an empty one', () => {
    assert.equal(Bundle.memberRecord(null, { 'a@x': { name: 'A' } }, {}), null);
  });
  it('avatars stay behind; shared travels as a record; nameless unshared profiles are dropped', () => {
    const m = Bundle.memberRecord({ 'a@x': { role: 'admin' } },
      { 'a@x': { name: 'A', shared: true, picture: 'data:...' }, 'b@x': { picture: 'data:...' }, 'c@x': { shared: true } }, null);
    assert.deepEqual(m, { users: { 'a@x': { role: 'admin' } },
      profiles: { 'a@x': { name: 'A', shared: true }, 'c@x': { name: '', shared: true } }, listUsers: {} });
  });
});

describe('fileSet', () => {
  const payload = {
    schema: { tables: {} }, config: { theme: 'x' },
    tables: { ref_teams: [{ id: 'r1' }], tasks: [{ id: 't1' }], tasks__archive: [{ id: 't0' }] },
    lists: { colours: ['red'] },
    languages: [{ code: 'en', name: 'English' }, { code: 'fi' }],
    translations: { en: { 'a.b': 'A' }, fi: { 'a.b': 'Ä' } },
    members: { users: {} }, pages: [{ id: 'p', markdown: '#' }]
  };
  it('splits by purpose: structure with its reference rows, the ward\'s rows, one file per language', () => {
    const f = Bundle.fileSet(payload, SCHEMA, 'demo');
    assert.deepEqual(f.map((x) => x[0]), ['demo-schema.json', 'demo-data.json', 'demo-lang-en.json', 'demo-lang-fi.json',
      'demo-users.json', 'demo-pages.json']);
    assert.deepEqual(f[0][1], { schema: payload.schema, config: payload.config, tables: { ref_teams: [{ id: 'r1' }] } });
    assert.deepEqual(f[1][1], { lists: { colours: ['red'] }, tables: { tasks: [{ id: 't1' }], tasks__archive: [{ id: 't0' }] } });
    assert.deepEqual(f[3][1], { languages: [{ code: 'fi', name: 'fi' }], translations: { fi: { 'a.b': 'Ä' } } });
  });
  it('declared (empty) lists go with the structure', () => {
    const f = Bundle.fileSet({ schema: {}, lists: { colours: [] } }, SCHEMA, 'x');
    assert.deepEqual(f, [['x-schema.json', { schema: {}, lists: { colours: [] } }]]);
  });
  it('nothing in, nothing out', () => {
    assert.deepEqual(Bundle.fileSet({ exportedAt: 'now' }, SCHEMA, 'x'), []);
  });
  it('matches the files app-core\'s _downloadFileSet downloads', async () => {
    const got = [];
    const ctx = {
      _exampleId: () => 'demo', notify: () => {}, t: (k) => k,
      _downloadJson: (name, content) => { got.push([name, content]); }
    };
    // setTimeout runs for real between files; five gaps of 400 ms is the cost of binding to the shipped code.
    await appCoreFn('_downloadFileSet', { SCHEMA, Bundle }).call(ctx, payload);
    assert.deepEqual(got, Bundle.fileSet(payload, SCHEMA, 'demo'));
  });
});

describe('importPlan', () => {
  const opts = { isAdmin: true, assetCap: 10 };
  it('every row lands active; an archive key becomes a _status stamp and clears the old store', () => {
    const p = Bundle.importPlan({ tables: { tasks: [{ id: 'a' }], tasks__archive: [{ id: 'b' }, { id: 'c', _status: 'done' }] } }, all, SCHEMA, opts);
    assert.deepEqual(p.rowJobs, [
      { table: 'tasks', tab: 'active', clearArchive: false, row: { id: 'a' } },
      { table: 'tasks', tab: 'active', clearArchive: true, row: { id: 'b', _status: 'archive' } },
      { table: 'tasks', tab: 'active', clearArchive: true, row: { id: 'c', _status: 'done' } }]);
  });
  it('reference rows follow the reference part and the ward\'s rows follow the data part', () => {
    const imported = { tables: { ref_teams: [{ id: 'r' }], notes: { rows: [{ id: 'n' }] } } };
    assert.deepEqual(Bundle.importPlan(imported, only('reference'), SCHEMA, opts).rowJobs.map((j) => j.row.id), ['r']);
    assert.deepEqual(Bundle.importPlan(imported, only('data'), SCHEMA, opts).rowJobs.map((j) => j.row.id), ['n']);
  });
  it('pages and assets follow the data; an over-cap asset is dropped rather than attempted', () => {
    const imported = { pages: [{ id: 'p', markdown: 'x' }, { id: 'q' }],
      assets: [{ id: 'a', src: '12345' }, { id: 'b', src: '12345678901' }, { id: 'c' }] };
    const p = Bundle.importPlan(imported, all, SCHEMA, opts);
    assert.deepEqual(p.pages.map((x) => x.id), ['p']);
    assert.deepEqual(p.assets.map((x) => x.id), ['a']);
    assert.deepEqual(Bundle.importPlan(imported, only('schema'), SCHEMA, opts).pages, []);
  });
  it('the roster needs the file, the tick and an admin', () => {
    const imported = { members: { users: {} } };
    assert.ok(Bundle.importPlan(imported, all, SCHEMA, opts).members);
    assert.equal(Bundle.importPlan(imported, all, SCHEMA, { isAdmin: false }).members, null);
    assert.equal(Bundle.importPlan(imported, only('data'), SCHEMA, opts).members, null);
  });
  it('names what the file offered and this import declines', () => {
    const imported = { schema: {}, translations: { en: {} }, tables: { notes: [] }, members: {} };
    assert.deepEqual(Bundle.importPlan(imported, only('data'), SCHEMA, opts).declined, ['schema', 'languages', 'users']);
    assert.deepEqual(Bundle.importPlan({ tables: {} }, only('data'), SCHEMA, opts).declined, [], 'an empty part is not offered');
  });
  it('counts one step per thing the dialog will show, ending with the locked-list check', () => {
    const imported = { schema: {}, tables: { notes: [{ id: 1 }, { id: 2 }] }, lists: { a: [] }, translations: { en: {}, fi: {} },
      pages: [{ id: 'p', markdown: 'x' }], assets: [{ id: 'a', src: 'x' }], config: {}, members: {} };
    // schema 1 + rows 2 + lists 1 + languages 2 + page 1 + asset 1 + config 1 + members 1 + provenance 1 + final 1
    assert.equal(Bundle.importPlan(imported, all, SCHEMA, Object.assign({ provenance: {} }, opts)).total, 12);
  });
  it('lists the import will not apply are not counted as a step', () => {
    // Counted before, from `imported.lists` alone, so a schema-only import of a file carrying lists
    // finished with its bar one step short.
    const p = Bundle.importPlan({ schema: {}, lists: { a: ['x'] } }, only('schema'), SCHEMA, opts);
    assert.equal(p.applyLists, false);
    assert.equal(p.total, 2);   // schema + final
  });
});
