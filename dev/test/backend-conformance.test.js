const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLocalBackend } = require('../backend-local');
const { createFsBackend } = require('../storage-fs');

// The app + dev server call `backend.<method>()` uniformly across the interchangeable backends
// (SQLite, FS, Firebase, Supabase). Nothing else enforces that they stay in parity, so a method added
// to one and forgotten in another silently breaks that backend. This is a drift guard: the COMMON
// CONTRACT below is the floor every backend must implement (individual backends add extras — e.g.
// renameLanguage, the Firebase user/profile RPCs — which are fine).
const CONTRACT = [
  'getSchema', 'saveSchema', 'initSchema', 'validateFolder',
  'getFolderConfig', 'setFolderConfig',
  'getAvailableTables', 'getAvailableLanguages',
  'getTableData', 'putRow', 'deleteRow', 'moveRow',
  'getLists', 'saveLists', 'putListItem',
  'getTranslations', 'updateTranslations', 'createLanguage', 'deleteLanguage'
];

describe('backend contract — Node backends (runtime)', () => {
  const FS_DIR = path.join(__dirname, '.test-conformance-' + process.pid);
  const sqlite = createLocalBackend();          // in-memory
  const fsb = createFsBackend(FS_DIR);
  after(() => { try { sqlite.close(); } catch (e) {} try { fsb.close(); } catch (e) {} fs.rmSync(FS_DIR, { recursive: true, force: true }); });

  for (const [name, backend] of [['SQLite', sqlite], ['FS', fsb]]) {
    it(name + ' implements every contract method', () => {
      const missing = CONTRACT.filter(m => typeof backend[m] !== 'function');
      assert.deepEqual(missing, [], name + ' is missing: ' + missing.join(', '));
    });
  }
});

// BACKEND_API.md is the contract as PROSE, and prose rots quietly: it had fallen eighteen methods
// behind -- uploads, profiles, membership requests, user-linked lists, doc-view bodies and the
// self-scoped access read were all undocumented, so anyone writing a backend from it would have
// shipped one that boots and then fails at the first feature.
//
// The floor above (CONTRACT) is what a backend MUST have; this is the other direction -- what a
// backend HAS must be written down somewhere a reader can find it.
describe('BACKEND_API.md documents the methods the backends actually expose', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'BACKEND_API.md'), 'utf8');

  // `_`-prefixed members are internals, deliberately not part of the contract.
  const methodsIn = (file) => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    return [...src.matchAll(/^\s{2,6}([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*function/gm)].map((m) => m[1]);
  };

  for (const file of ['backend-firebase.js', 'backend-kv.js']) {
    it(file + ': every method it exposes appears in the doc', () => {
      const undocumented = [...new Set(methodsIn(file))].filter((m) => !doc.includes('`' + m)).sort();
      assert.deepEqual(undocumented, [], file + ' exposes methods BACKEND_API.md never mentions: '
        + undocumented.join(', '));
    });
  }

  it('the doc lists every method the CONTRACT floor requires', () => {
    const missing = CONTRACT.filter((m) => !doc.includes('`' + m));
    assert.deepEqual(missing, [], 'BACKEND_API.md omits required methods: ' + missing.join(', '));
  });
});

describe('backend contract — putRow merge semantics', () => {
  // Pinned contract: a PARTIAL putRow (a subset of columns) MERGES onto the stored row — it must not
  // blank the columns it omits. This is what Firestore ({merge:true}) and the CRDT engine (per-field
  // LWW) do; SQLite's INSERT OR REPLACE used to silently blank absent columns, so any partial-row
  // caller would lose data on exactly one backend.
  const FS_DIR = path.join(__dirname, '.test-merge-' + process.pid);
  const sqlite = createLocalBackend();          // in-memory
  const fsb = createFsBackend(FS_DIR);
  after(() => { try { sqlite.close(); } catch (e) {} fs.rmSync(FS_DIR, { recursive: true, force: true }); });

  for (const [name, backend] of [['SQLite', sqlite], ['FS', fsb]]) {
    it(name + ': partial putRow keeps the stored values of omitted columns', () => {
      backend.putRow('mergetest', { id: 'r1', a: 'A', b: 'B' }, 'active');
      backend.putRow('mergetest', { id: 'r1', a: 'A2' }, 'active');
      const row = backend.getTableData('mergetest', 'active').rows.find(r => r.id === 'r1');
      assert.equal(row.a, 'A2', name + ' updated column');
      assert.equal(row.b, 'B', name + ' omitted column preserved');
    });
  }
});

describe('backend contract — browser backends (source scan)', () => {
  // Browser backends are plain scripts that assign globals (not requireable modules); scan the source
  // for each contract method, defined as `name: function` or `async name(`.
  function definedMethods(file) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const set = new Set();
    let m;
    const re = /(?:async\s+)?([a-zA-Z_]\w*)\s*(?::\s*function|\()/g;
    while ((m = re.exec(src))) set.add(m[1]);
    return set;
  }

  // backend-kv.js is where the contract is actually written for the two key-value backends (Supabase and
  // the browser-local PGlite): they are PLATFORM files -- auth, realtime, uploads -- and share this one
  // implementation. Scanning them individually would find nothing and pass vacuously.
  for (const file of ['backend-firebase.js', 'backend-kv.js']) {
    it(file + ' defines every contract method', () => {
      const defined = definedMethods(file);
      const missing = CONTRACT.filter(m => !defined.has(m));
      assert.deepEqual(missing, [], file + ' is missing: ' + missing.join(', '));
    });
  }

  // ...which only holds while they really do delegate. A platform file that grew its own copy of a
  // contract method would satisfy nothing here and drift silently, so pin the delegation itself.
  for (const file of ['backend-supabase.js', 'backend-local-pglite.js']) {
    it(file + ' gets its contract from backend-kv.js rather than its own copy', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      assert.match(src, /createKvBackend\(/, file + ' no longer builds its backend from the shared factory');
      const own = definedMethods(file);
      const copied = CONTRACT.filter(m => own.has(m));
      assert.deepEqual(copied, [], file + ' re-implements shared contract methods: ' + copied.join(', '));
    });
  }
});

describe('backend contract — createLanguage never erases existing translations', () => {
  // Pinned contract: createLanguage SEEDS blank slots for the keys it is given, and leaves every string
  // already stored alone -- including keys it was not told about.
  //
  // This was broken on three of the four backends. Import calls createLanguage once per language in the
  // file, so importing an app-translations pack wrote a blank document over the schema translations for
  // that language, and importing a schema pack did the same in reverse. There was no way to layer the
  // two, and nothing said so: the strings were simply gone afterwards. SQLite was the only backend that
  // got it right (INSERT OR IGNORE per key), which is exactly the kind of drift the shared helper in
  // backend-helpers exists to stop.
  const FS_DIR = path.join(__dirname, '.test-lang-' + process.pid);
  const sqlite = createLocalBackend();          // in-memory
  const fsb = createFsBackend(FS_DIR);
  after(() => { try { sqlite.close(); } catch (e) {} try { fsb.close(); } catch (e) {} fs.rmSync(FS_DIR, { recursive: true, force: true }); });

  for (const [name, backend] of [['SQLite', sqlite], ['FS', fsb]]) {
    it(name + ': a second import layers onto the first instead of replacing it', () => {
      // Pack one: schema strings.
      backend.createLanguage('en', 'English', ['field.topic', 'field.place']);
      backend.updateTranslations('en', { 'field.topic': 'Topic', 'field.place': 'Place' });

      // Pack two: app strings, a disjoint key set — the shape of the real app-lang / schema-lang split.
      backend.createLanguage('en', 'English', ['btn.add', 'msg.saved']);
      backend.updateTranslations('en', { 'btn.add': 'Add', 'msg.saved': 'Saved' });

      const t = backend.getTranslations('en');
      assert.equal(t['field.topic'], 'Topic', name + ': the first pack was erased by the second');
      assert.equal(t['field.place'], 'Place', name + ': the first pack was erased by the second');
      assert.equal(t['btn.add'], 'Add');
      assert.equal(t['msg.saved'], 'Saved');
    });

    it(name + ': re-seeding a key that already has a value does not blank it', () => {
      backend.createLanguage('sv', 'Svenska', ['btn.add']);
      backend.updateTranslations('sv', { 'btn.add': 'Lägg till' });
      backend.createLanguage('sv', 'Svenska', ['btn.add']);      // same key, second time
      assert.equal(backend.getTranslations('sv')['btn.add'], 'Lägg till');
    });

    it(name + ': a genuinely new language is created, with no invented strings', () => {
      // Asserted as "absent or empty" rather than "empty", because the two backends genuinely differ
      // here and neither is wrong: the document backends store {key: ''} and hand it back, while
      // SQLite stores the blank row but filters it out on read (getTranslations skips falsy text). The
      // app cannot tell -- t() is `strings[key] || key`, so an empty string and a missing one both fall
      // back to the key. Pinning one shape would force a change with no behavioural payoff.
      backend.createLanguage('fi', 'Suomi', ['btn.add', 'msg.saved']);
      const t = backend.getTranslations('fi');
      assert.ok(t && typeof t === 'object', name + ': no translations map for a new language');
      for (const k of ['btn.add', 'msg.saved']) {
        assert.ok(t[k] === '' || t[k] === undefined, name + ': invented a value for ' + k + ': ' + t[k]);
      }
      assert.ok((backend.getAvailableLanguages() || []).some((l) => (l.code || l) === 'fi'),
        name + ': the language was not registered');
    });
  }
});

describe('backend contract — the browser backends use the shared seed rule', () => {
  // Firebase and the shared kv contract are plain scripts that assign globals, so they cannot be
  // exercised in Node.
  // Asserted against the source instead, because the failure is silent data loss on a production
  // deployment and the runtime cases above cannot reach it.
  // backend-pglite is requireable, but exercising createLanguage on it means standing up a WASM
  // Postgres and applying the whole schema — supabase-rls.test.js already pays that cost for the
  // policies. Scanned here instead, alongside the two it mirrors, so all three document backends are
  // held to the rule in one place.
  for (const file of ['backend-firebase.js', 'backend-kv.js', 'dev/backend-pglite.js']) {
    it(file + ' seeds translations without overwriting what is stored', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', ...file.split('/')), 'utf8');
      const at = Math.max(src.indexOf('createLanguage: function'), src.indexOf('async createLanguage('));
      const fn = src.slice(at, src.indexOf('deleteLanguage', at));
      assert.ok(fn.length > 50, file + ': createLanguage not found — this test would pass vacuously');
      assert.match(fn, /seedTranslations/, file + ' still writes a blank document over the stored one');
      assert.ok(!/setMeta\('lang_' \+ code, BackendHelpers\.emptyTranslations/.test(fn),
        file + ' writes emptyTranslations straight over the language document');
      assert.match(fn, /getMeta\('lang_' \+ code\)/, file + ' must READ the stored document first');
    });
  }
});
