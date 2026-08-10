// Firestore rules are not filters: a read rule that tests document fields is provable for a QUERY only
// when the query constrains those same fields. firestore.rules therefore lets a member WITHOUT a table
// grant read only what they constrain to -- their own `owner` rows, or rows flagged `rosterPublic`. The
// emulator suite (dev/test-emulator/firestore-rules.mjs) pins which queries the rules accept; this pins
// that the client actually ISSUES them. Between the two, the self-service read path is covered end to
// end -- previously it fell in the gap: unit tests have no rules, rules tests have no client.
//
// Runs the REAL backend-firebase.js in a sandbox with the storage layer stubbed, so it records the exact
// calls the shipped code makes rather than a re-implementation of them.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function loadBackend(email) {
  const calls = [];
  const StorageFirestore = {
    getAll: function(store) { calls.push({ fn: 'getAll', store: store }); return Promise.resolve(StorageFirestore._all[store] || []); },
    getWhere: function(store, field, op, value) {
      calls.push({ fn: 'getWhere', store: store, field: field, op: op, value: value });
      return Promise.resolve((StorageFirestore._where[store] || {})[field] || []);
    },
    _all: {}, _where: {},
    get: () => Promise.resolve(null), getMeta: () => Promise.resolve(null), setMeta: () => Promise.resolve(),
    put: () => Promise.resolve(), delete: () => Promise.resolve()
  };
  const sandbox = {
    console, Promise, Date, JSON, Object, Array, String, Number, Boolean,
    StorageFirestore,
    BackendHelpers: require(path.join(ROOT, 'backend-helpers.js')),
    AccessFeatures: require(path.join(ROOT, 'access-features.js')),
    // initFirebase() runs on load; give it just enough to take its harmless "no config" path.
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: () => Promise.reject(new Error('no network in test')),
    appInstance: {},
    _auth: { currentUser: { email: email } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'backend-firebase.js'), 'utf8'), sandbox, { filename: 'backend-firebase.js' });
  // _auth is reassigned to null by the file's own top-level `var _auth = null`, so restore it after load.
  sandbox._auth = { currentUser: { email: email } };
  return { backend: sandbox.backend, calls, StorageFirestore };
}

describe('Firestore read scoping (rules are not filters)', () => {
  let env;
  beforeEach(() => { env = loadBackend('Kid@Example.test'); });

  it('a GRANTED table is read as the whole collection', async () => {
    env.backend._myTablesPromise = Promise.resolve(['chore_log']);
    env.StorageFirestore._all['chore_log__active'] = [{ id: 'a' }, { id: 'b' }];
    const res = await env.backend.getTableData('chore_log', 'active');
    assert.deepEqual(env.calls.map(c => c.fn), ['getAll']);
    assert.equal(res.rows.length, 2);
  });

  it('an UNRESTRICTED user (null) is read as the whole collection', async () => {
    env.backend._myTablesPromise = Promise.resolve(null);
    env.StorageFirestore._all['chore_log__active'] = [{ id: 'a' }];
    await env.backend.getTableData('chore_log', 'active');
    assert.deepEqual(env.calls.map(c => c.fn), ['getAll']);
  });

  it('a GRANTLESS table is read as the two rules-provable slices, never unconstrained', async () => {
    env.backend._myTablesPromise = Promise.resolve([]);
    env.StorageFirestore._where['rsvps__active'] = {
      owner: [{ id: 'mine', owner: 'kid@example.test' }],
      rosterPublic: [{ id: 'pub', owner: 'ann@example.test', rosterPublic: true }]
    };
    const res = await env.backend.getTableData('rsvps', 'active');
    assert.ok(!env.calls.some(c => c.fn === 'getAll'), 'must not issue an unconstrained read');
    assert.deepEqual(env.calls.map(c => c.field).sort(), ['owner', 'rosterPublic']);
    // The owner constraint must carry the LOWERCASED signed-in email -- firestore.rules compares
    // against request.auth.token.email.lower(), so any other casing silently matches nothing.
    const ownerCall = env.calls.find(c => c.field === 'owner');
    assert.equal(ownerCall.value, 'kid@example.test');
    assert.equal(ownerCall.op, '==');
    assert.deepEqual(res.rows.map(r => r.id).sort(), ['mine', 'pub']);
  });

  it('a row that is both mine and public is returned once', async () => {
    env.backend._myTablesPromise = Promise.resolve([]);
    const row = { id: 'mine', owner: 'kid@example.test', rosterPublic: true };
    env.StorageFirestore._where['rsvps__active'] = { owner: [row], rosterPublic: [row] };
    const res = await env.backend.getTableData('rsvps', 'active');
    assert.deepEqual(res.rows.map(r => r.id), ['mine']);
  });

  it('a denied slice degrades to empty rather than surfacing an error', async () => {
    env.backend._myTablesPromise = Promise.resolve([]);
    env.StorageFirestore.getWhere = () => Promise.reject(new Error('permission-denied'));
    const res = await env.backend.getTableData('rsvps', 'active');
    assert.deepEqual(res.rows, []);
  });

  it('the archive partition is scoped by its BASE table grant', async () => {
    env.backend._myTablesPromise = Promise.resolve(['chore_log']);
    env.StorageFirestore._all['chore_log__archive'] = [{ id: 'old' }];
    await env.backend.getTableData('chore_log', 'archive');
    assert.deepEqual(env.calls.map(c => c.store), ['chore_log__archive']);
    assert.deepEqual(env.calls.map(c => c.fn), ['getAll']);
  });

  it('the read scope is resolved once, not per table', async () => {
    let resolved = 0;
    env.backend._loadMyTables = function() { resolved++; return Promise.resolve(['chore_log']); };
    await env.backend.getTableData('chore_log', 'active');
    await env.backend.getTableData('chore_log', 'archive');
    assert.equal(resolved, 1);
  });
});
