const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLocalBackend } = require('../backend-local');
const { createFsBackend } = require('../storage-fs');

// The app + dev server call `backend.<method>()` uniformly across five interchangeable backends
// (SQLite, FS, Firebase, OAuth/Sheets, CRDT). Nothing else enforces that they stay in parity, so a
// method added to one and forgotten in another silently breaks that backend. This is a drift guard:
// the COMMON CONTRACT below is the floor every backend must implement (individual backends add extras
// — bootData, renameLanguage, getFileModifiedTime, the Firebase user/profile RPCs — which are fine).
const CONTRACT = [
  'getSchema', 'saveSchema', 'initSchema', 'validateFolder',
  'getFolderConfig', 'setFolderConfig',
  'getAvailableTables', 'getAvailableLanguages',
  'getTableData', 'putRow', 'deleteRow', 'moveRow',
  'getLists', 'saveLists', 'putListItem',
  'getTranslations', 'updateTranslations', 'createLanguage', 'deleteLanguage',
  'saveChangesets', 'loadChangesets'
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

  for (const file of ['backend-firebase.js', 'backend-supabase.js', 'backend-oauth.js', 'crdt-backend.js']) {
    it(file + ' defines every contract method', () => {
      const defined = definedMethods(file);
      const missing = CONTRACT.filter(m => !defined.has(m));
      assert.deepEqual(missing, [], file + ' is missing: ' + missing.join(', '));
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
  const FOLDER = 'local';        // both Node backends take folderId first
  const FS_DIR = path.join(__dirname, '.test-lang-' + process.pid);
  const sqlite = createLocalBackend();          // in-memory
  const fsb = createFsBackend(FS_DIR);
  after(() => { try { sqlite.close(); } catch (e) {} try { fsb.close(); } catch (e) {} fs.rmSync(FS_DIR, { recursive: true, force: true }); });

  for (const [name, backend] of [['SQLite', sqlite], ['FS', fsb]]) {
    it(name + ': a second import layers onto the first instead of replacing it', () => {
      // Pack one: schema strings.
      backend.createLanguage(FOLDER, 'en', 'English', ['field.topic', 'field.place']);
      backend.updateTranslations(FOLDER, 'en', { 'field.topic': 'Topic', 'field.place': 'Place' });

      // Pack two: app strings, a disjoint key set — the shape of the real app-lang / schema-lang split.
      backend.createLanguage(FOLDER, 'en', 'English', ['btn.add', 'msg.saved']);
      backend.updateTranslations(FOLDER, 'en', { 'btn.add': 'Add', 'msg.saved': 'Saved' });

      const t = backend.getTranslations(FOLDER, 'en');
      assert.equal(t['field.topic'], 'Topic', name + ': the first pack was erased by the second');
      assert.equal(t['field.place'], 'Place', name + ': the first pack was erased by the second');
      assert.equal(t['btn.add'], 'Add');
      assert.equal(t['msg.saved'], 'Saved');
    });

    it(name + ': re-seeding a key that already has a value does not blank it', () => {
      backend.createLanguage(FOLDER, 'sv', 'Svenska', ['btn.add']);
      backend.updateTranslations(FOLDER, 'sv', { 'btn.add': 'Lägg till' });
      backend.createLanguage(FOLDER, 'sv', 'Svenska', ['btn.add']);      // same key, second time
      assert.equal(backend.getTranslations(FOLDER, 'sv')['btn.add'], 'Lägg till');
    });

    it(name + ': a genuinely new language is created, with no invented strings', () => {
      // Asserted as "absent or empty" rather than "empty", because the two backends genuinely differ
      // here and neither is wrong: the document backends store {key: ''} and hand it back, while
      // SQLite stores the blank row but filters it out on read (getTranslations skips falsy text). The
      // app cannot tell -- t() is `strings[key] || key`, so an empty string and a missing one both fall
      // back to the key. Pinning one shape would force a change with no behavioural payoff.
      backend.createLanguage(FOLDER, 'fi', 'Suomi', ['btn.add', 'msg.saved']);
      const t = backend.getTranslations(FOLDER, 'fi');
      assert.ok(t && typeof t === 'object', name + ': no translations map for a new language');
      for (const k of ['btn.add', 'msg.saved']) {
        assert.ok(t[k] === '' || t[k] === undefined, name + ': invented a value for ' + k + ': ' + t[k]);
      }
      assert.ok((backend.getAvailableLanguages(FOLDER) || []).some((l) => (l.code || l) === 'fi'),
        name + ': the language was not registered');
    });
  }
});

describe('backend contract — the browser backends use the shared seed rule', () => {
  // Firebase and Supabase are plain scripts that assign globals, so they cannot be exercised in Node.
  // Asserted against the source instead, because the failure is silent data loss on a production
  // deployment and the runtime cases above cannot reach it.
  for (const file of ['backend-firebase.js', 'backend-supabase.js']) {
    it(file + ' seeds translations without overwriting what is stored', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      const fn = src.slice(src.indexOf('createLanguage: function'), src.indexOf('deleteLanguage'));
      assert.ok(fn.length > 50, file + ': createLanguage not found — this test would pass vacuously');
      assert.match(fn, /seedTranslations/, file + ' still writes a blank document over the stored one');
      assert.ok(!/setMeta\('lang_' \+ code, BackendHelpers\.emptyTranslations/.test(fn),
        file + ' writes emptyTranslations straight over the language document');
    });
  }
});
