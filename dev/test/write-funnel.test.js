// write-funnel.test.js — every row write goes through writes.js, and nothing goes around it.
//
// The funnel exists so that optimistic updates, a write queue, or uniform failure handling can be added
// in ONE place later. A funnel with a bypass gives none of that while looking as though it does, and a
// bypass is the easy thing to add by accident: `backend.putRow(...)` is what every existing call site
// looked like, and it still works.
//
// So the invariant is asserted against the real source, the same way rules-parity guards the policy
// layers: a direct call reappearing anywhere but writes.js fails here rather than quietly eroding it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WRITE_METHODS = ['putRow', 'deleteRow', 'moveRow'];

// Client-side files that could plausibly write. Backend ADAPTERS are excluded on purpose: they
// implement these methods, so `backend.putRow` inside one is the definition, not a bypass.
const CLIENT_FILES = ['app-core.js', 'embeds.js', 'rows.js', 'rsvp.js', 'board.js', 'pivot.js',
                      'print.js', 'calendar.js', 'rotation.js', 'columns.js', 'live-sync.js'];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('write funnel — nothing goes around writes.js', () => {
  for (const file of CLIENT_FILES) {
    it(file + ' has no direct backend write call', () => {
      const src = read(file);
      const found = WRITE_METHODS
        .map((m) => ({ m, n: (src.match(new RegExp('\\bbackend\\.' + m + '\\s*\\(', 'g')) || []).length }))
        .filter((x) => x.n);
      assert.deepEqual(found, [],
        file + ' calls the backend directly: ' + found.map((x) => x.m + ' x' + x.n).join(', ') +
        '. Route it through Writes.' + (found[0] ? found[0].m : 'putRow') + ' instead — the point of the ' +
        'funnel is that there is exactly one place to change what a write does.');
    });
  }

  it('writes.js is the one file that may call them', () => {
    const src = read('writes.js');
    for (const m of WRITE_METHODS) {
      assert.match(src, new RegExp('\\b' + m + '\\s*\\('), 'writes.js should funnel ' + m);
    }
  });

  it('app-core actually uses the funnel, rather than having simply stopped writing', () => {
    // Guards the lazy way to make the assertions above pass.
    const src = read('app-core.js');
    const uses = (src.match(/\bWrites\.(putRow|deleteRow|moveRow)\s*\(/g) || []).length;
    assert.ok(uses >= 20, 'expected app-core to write through the funnel in many places (found ' + uses + ')');
  });
});

describe('write funnel — the pass-through behaves', () => {
  const Writes = require('../../writes');

  it('forwards arguments unchanged and resolves with the backend result', async () => {
    const calls = [];
    globalThis.backend = {
      putRow: (t, r, p) => { calls.push(['putRow', t, r, p]); return 'put-result'; },
      deleteRow: (t, i, p) => { calls.push(['deleteRow', t, i, p]); return 'del-result'; },
      moveRow: (t, r, f, to) => { calls.push(['moveRow', t, r, f, to]); return 'move-result'; }
    };
    try {
      assert.equal(await Writes.putRow('tasks', { id: 'r1' }, 'active'), 'put-result');
      assert.equal(await Writes.deleteRow('tasks', 'r1', 'active'), 'del-result');
      assert.equal(await Writes.moveRow('tasks', { id: 'r1' }, 'active', 'archive'), 'move-result');
      assert.deepEqual(calls, [
        ['putRow', 'tasks', { id: 'r1' }, 'active'],
        ['deleteRow', 'tasks', 'r1', 'active'],
        ['moveRow', 'tasks', { id: 'r1' }, 'active', 'archive']
      ]);
    } finally { delete globalThis.backend; }
  });

  it('a synchronous backend still yields a promise', async () => {
    // backend-local is synchronous; the local-client adapter is not. Callers must not have to care,
    // or the funnel would change behaviour depending on which backend is loaded.
    globalThis.backend = { putRow: () => 42 };
    try {
      const r = Writes.putRow('t', { id: 'x' }, 'active');
      assert.ok(typeof r.then === 'function', 'must return a promise');
      assert.equal(await r, 42);
    } finally { delete globalThis.backend; }
  });

  it('fails loudly when no backend is loaded', async () => {
    delete globalThis.backend;
    await assert.rejects(() => Writes.putRow('t', { id: 'x' }, 'active'), /no backend/);
  });
});
