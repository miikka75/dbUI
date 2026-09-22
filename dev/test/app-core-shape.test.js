// app-core-shape.test.js — structural guards over app-core.js's ROOT component, plus the one member
// whose bug motivated them.
//
// WHY A STRUCTURAL TEST EXISTS AT ALL: the root component's `methods` object is ~5,700 lines, and a
// duplicate key in an object literal that large is invisible to review. One had been sitting there —
// `copyText` defined twice — and JS silently keeps the SECOND, so the half that reported clipboard
// failure was dead code and the survivor announced "copied" even when the write rejected.
//
// It is also a correctness guard for dev/test/app-core-fn.js, which lifts a member by searching for
// the FIRST `\n      <name>: function(` in the file. With two definitions, that helper lifts the one
// the app does not run — so any test written against a duplicated member tests dead code and passes
// while production is broken. That failure mode is silent in both directions, which is why it is
// pinned here rather than left to review.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { appCoreFn } = require('./app-core-fn');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');

// The root component is the FIRST Vue.createApp({...}) in the file; every `app.component(...)` comes
// after it, so the first of those bounds it. Its option blocks sit at a 4-space indent and their
// members at 6 — the same convention app-core-fn.js lifts by, so if that stops holding both break
// together rather than one silently.
//
// Blocks are delimited by their 4-space SIBLINGS, not by brace matching. Brace counting is what
// app-core-fn.js uses and it is wrong here: the root's members carry Vue templates as string literals
// full of `{{ … }}`, so a naive depth count closes the object thousands of lines early. Slicing
// between consecutive 4-space headers needs no knowledge of what is inside them.
const ROOT_START = SRC.indexOf('Vue.createApp({');
const ROOT_END = SRC.indexOf('\n  app.component(', ROOT_START);

// Every 4-space option key of the root component, in file order, as [name, index].
const ROOT_KEYS = [...SRC.slice(ROOT_START, ROOT_END).matchAll(/^ {4}([A-Za-z_$][\w$]*):/gm)]
  .map((m) => [m[1], ROOT_START + m.index]);

function rootBlock(name) {
  const i = ROOT_KEYS.findIndex(([n]) => n === name);
  assert.ok(i >= 0, 'root block `' + name + '` not found inside Vue.createApp — known blocks: ' +
    ROOT_KEYS.map(([n]) => n).join(', '));
  const end = i + 1 < ROOT_KEYS.length ? ROOT_KEYS[i + 1][1] : ROOT_END;
  return SRC.slice(ROOT_KEYS[i][1], end);
}

// Member keys declared directly in a block: 6 spaces from line start. Nested object literals inside a
// method body indent deeper, so this does not reach into them.
function memberNames(blockSrc) {
  return (blockSrc.match(/^ {6}[A-Za-z_$][\w$]*:/gm) || []).map((s) => s.trim().slice(0, -1));
}

describe('app-core.js root component — no duplicate member keys', () => {
  it('locates the root component and its option blocks', () => {
    assert.ok(ROOT_START > 0, 'found Vue.createApp');
    assert.ok(ROOT_END > ROOT_START, 'found the first app.component after it, which bounds the root');
    // Named explicitly: if the root is ever restructured, this says so instead of the per-block tests
    // below passing vacuously against a block that silently stopped being found.
    for (const expected of ['data', 'computed', 'methods', 'watch', 'mounted']) {
      assert.ok(ROOT_KEYS.some(([n]) => n === expected), 'root carries a `' + expected + '` block');
    }
  });

  // `watch` is included because a duplicate watcher is the same silent overwrite, and `data` because
  // a duplicated data key is a reactive property that quietly loses its first initialiser.
  for (const block of ['data', 'computed', 'methods', 'watch']) {
    it(block + ': every key is declared exactly once', () => {
      const names = memberNames(rootBlock(block));
      assert.ok(names.length > 0, block + ': found no members — this test would pass vacuously');
      const seen = new Map();
      for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
      const dupes = [...seen].filter(([, c]) => c > 1).map(([n, c]) => n + ' (x' + c + ')');
      assert.deepEqual(dupes, [],
        block + ': duplicate key(s) — JS keeps the LAST, so every earlier definition is dead code and ' +
        'app-core-fn.js lifts the wrong one: ' + dupes.join(', '));
    });
  }
});

// --- copyText: the member the guard above was written for -----------------------------------------
//
// Lifted from the shipped file, so these bind to the code the app runs. `navigator` and `document` are
// passed as free bindings (they become parameters that shadow any Node globals of the same name), which
// is what lets the two clipboard paths be exercised without a DOM.
function copyTextWith(nav, doc) {
  const said = [];
  const fn = appCoreFn('copyText', { navigator: nav, document: doc });
  const ctx = { notify: (m) => said.push(m), t: (k) => k };
  return { said, run: (text) => fn.call(ctx, text) };
}

const DOM = (execResult) => {
  const removed = [];
  return {
    removed,
    createElement: () => ({ value: '', select() {} }),
    body: { appendChild() {}, removeChild: (n) => removed.push(n) },
    execCommand: () => { if (execResult instanceof Error) throw execResult; return execResult; }
  };
};

describe('copyText — it must not claim success it did not get', () => {
  it('reports copied when the async clipboard resolves', async () => {
    const c = copyTextWith({ clipboard: { writeText: () => Promise.resolve() } }, DOM(true));
    await c.run('https://example.org/feed.ics');
    assert.deepEqual(c.said, ['msg.copied']);
  });

  // THE REGRESSION. The surviving duplicate ignored the promise entirely and notified 'msg.copied'
  // unconditionally, so a denied permission or an unfocused document left the user believing a URL
  // was on their clipboard when nothing had been written.
  it('reports failure when the async clipboard REJECTS', async () => {
    const c = copyTextWith({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, DOM(true));
    await c.run('https://example.org/feed.ics');
    assert.deepEqual(c.said, ['msg.save_failed'], 'a rejected clipboard write must not say "copied"');
  });

  it('passes the text through to the clipboard unchanged', async () => {
    const seen = [];
    const c = copyTextWith({ clipboard: { writeText: (t) => { seen.push(t); return Promise.resolve(); } } }, DOM(true));
    await c.run('https://example.org/a b?x=1&y=2');
    assert.deepEqual(seen, ['https://example.org/a b?x=1&y=2']);
  });

  // The execCommand path is what keeps the button working on a non-secure origin (http://, or an older
  // browser), where navigator.clipboard is simply absent. It was the half worth keeping from the
  // duplicate; it reports its own success as a boolean, and a false there is the same lie.
  it('falls back to execCommand when there is no async clipboard, and cleans up the textarea', async () => {
    const dom = DOM(true);
    const c = copyTextWith({}, dom);
    await c.run('plain');
    assert.deepEqual(c.said, ['msg.copied']);
    assert.equal(dom.removed.length, 1, 'the scratch textarea is removed from the document');
  });

  it('reports failure when execCommand returns false', async () => {
    const c = copyTextWith({}, DOM(false));
    await c.run('plain');
    assert.deepEqual(c.said, ['msg.save_failed']);
  });

  it('reports failure when execCommand throws, and still removes the textarea', async () => {
    const dom = DOM(new Error('not allowed'));
    const c = copyTextWith({}, dom);
    await c.run('plain');
    assert.deepEqual(c.said, ['msg.save_failed']);
    assert.equal(dom.removed.length, 1, 'a throwing execCommand must not leak the scratch node');
  });

  // A browser with a `clipboard` object but no `writeText` (or a non-secure context that exposes a
  // partial API) must take the fallback rather than throwing on an undefined call.
  it('treats a clipboard without writeText as absent', async () => {
    const c = copyTextWith({ clipboard: {} }, DOM(true));
    await c.run('plain');
    assert.deepEqual(c.said, ['msg.copied']);
  });
});
