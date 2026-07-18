// crdt-merge.test.js — Functional tests for the CRDT engine's LWW merge (crdt-engine.js).
// The engine is a browser global-assigning script (not a requireable module); evaluate it in a vm
// context with an in-memory storage adapter + fake transport, then drive it through the public
// interface (init/putRow/deleteRow/getTableData/pullChanges). Guards the row-grouped mergeChanges
// rewrite: tombstone no-resurrection, per-field LWW, compact {t,b,id,ts,d} expansion, in-order application.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadEngine() {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'crdt-engine.js'), 'utf8');
  const ctx = {
    BackendHelpers: require('../../backend-helpers'),
    setInterval, clearInterval, Promise, Date, Math, Object, JSON, console
  };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx.CrdtEngine;
}

function memStorage() {
  const stores = {};
  let meta = {};
  let pending = [];
  return {
    stores,
    ensureStore(n) { stores[n] = stores[n] || {}; return Promise.resolve(); },
    get(n, id) { return Promise.resolve(stores[n] ? stores[n][id] : undefined); },
    put(n, id, v) { stores[n][id] = JSON.parse(JSON.stringify(v)); return Promise.resolve(); },
    delete(n, id) { if (stores[n]) delete stores[n][id]; return Promise.resolve(); },
    getAll(n) { return Promise.resolve(Object.values(stores[n] || {})); },
    getMeta(k) { return Promise.resolve(meta[k] != null ? meta[k] : null); },
    setMeta(k, v) { meta[k] = v; return Promise.resolve(); },
    getPending() { return Promise.resolve(pending.slice()); },
    addPending(c) { pending.push(c); return Promise.resolve(); },
    clearPending() { pending = []; return Promise.resolve(); }
  };
}

function fakeTransport(remote) {
  return {
    pushChangesets() { return Promise.resolve(); },
    pullChangesets() { return Promise.resolve(remote); }
  };
}

describe('CrdtEngine merge (LWW + tombstones)', () => {
  let engine, storage;
  beforeEach(() => { engine = loadEngine(); storage = memStorage(); });

  it('merges compact {t,b,id,ts,d} changesets into rows (multi-field, one row)', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [{ t: 'tasks', b: 'active', id: 'r1', ts: 100, d: { title: 'hello', status: 'open' } }] }
    ]));
    await engine.pullChanges();
    const { rows } = await engine.getTableData('tasks', 'active');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'hello');
    assert.equal(rows[0].status, 'open');
    assert.equal(rows[0]._ts, undefined); // getTableData strips CRDT metadata
  });

  it('per-field LWW: an older remote change never overwrites a newer local value', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [
        { t: 'tasks', b: 'active', id: 'r1', ts: 50, d: { title: 'stale', status: 'stale-status' } }
      ] }
    ]));
    await engine.putRow('tasks', { id: 'r1', title: 'fresh' }, 'active'); // local ts = now >> 50
    await engine.pullChanges();
    const { rows } = await engine.getTableData('tasks', 'active');
    assert.equal(rows[0].title, 'fresh');          // newer local field kept
    assert.equal(rows[0].status, 'stale-status');  // untouched field merged in
  });

  it('tombstone: a write older than the delete cannot resurrect the row', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [{ t: 'tasks', b: 'active', id: 'r1', ts: 10, d: { title: 'zombie' } }] }
    ]));
    await engine.deleteRow('tasks', 'r1', 'active'); // tombstone at ts = now >> 10
    await engine.pullChanges();
    const { rows } = await engine.getTableData('tasks', 'active');
    assert.equal(rows.length, 0);
  });

  it('a write NEWER than the tombstone resurrects the row', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [{ t: 'tasks', b: 'active', id: 'r1', ts: Date.now() + 10000, d: { title: 'reborn' } }] }
    ]));
    await engine.deleteRow('tasks', 'r1', 'active');
    await engine.pullChanges();
    const { rows } = await engine.getTableData('tasks', 'active');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'reborn');
  });

  it('equal timestamps: the first-arriving change wins (strictly-newer replaces)', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'a', changes: [{ t: 'tasks', b: 'active', id: 'r1', ts: 100, d: { title: 'first' } }] },
      { siteId: 'b', changes: [{ t: 'tasks', b: 'active', id: 'r1', ts: 100, d: { title: 'second' } }] }
    ]));
    await engine.pullChanges();
    const { rows } = await engine.getTableData('tasks', 'active');
    assert.equal(rows[0].title, 'first');
  });

  it('changes across multiple rows and partitions land in the right stores', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [
        { t: 'tasks', b: 'active', id: 'r1', ts: 1, d: { title: 'a' } },
        { t: 'tasks', b: 'archive', id: 'r2', ts: 2, d: { title: 'b' } },
        { t: 'notes', b: 'active', id: 'r3', ts: 3, d: { content: 'c' } }
      ] }
    ]));
    await engine.pullChanges();
    assert.equal((await engine.getTableData('tasks', 'active')).rows[0].title, 'a');
    assert.equal((await engine.getTableData('tasks', 'archive')).rows[0].title, 'b');
    assert.equal((await engine.getTableData('notes', 'active')).rows[0].content, 'c');
  });

  it('expanded {table,tab,id,col,value,ts} changes still merge (legacy shape)', async () => {
    await engine.init(storage, fakeTransport([
      { siteId: 'peer', changes: [{ table: 'tasks', tab: 'active', id: 'r1', col: 'title', value: 'x', ts: 5 }] }
    ]));
    await engine.pullChanges();
    assert.equal((await engine.getTableData('tasks', 'active')).rows[0].title, 'x');
  });
});
