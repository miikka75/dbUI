// examples.test.js — /examples.js, the pure half of installing a shipped bundle from the browser.
//
// Two things here are load-bearing and neither is obvious from reading the module:
//
//   1. mergeFiles has to fold the documented import ORDER (schema -> schema labels -> app labels ->
//      sample rows) into one object that the existing import applies in one run. Getting the merge
//      wrong does not throw; it silently drops a language or duplicates rows.
//   2. fingerprint has to give the SAME answer for a bundle as for that bundle after the app has
//      stored it — the app writes back the migrated, column-folded form. If those two disagree, every
//      unit reads as "you edited this" and a future merge would refuse to touch anything.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const Examples = require('../../examples');
const SchemaNormalize = require('../../schema-normalize');

const read = (f) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));

describe('hashing', () => {
  it('ignores key order but not array order', () => {
    assert.equal(Examples.hash({ a: 1, b: 2 }), Examples.hash({ b: 2, a: 1 }));
    assert.notEqual(Examples.hash([1, 2]), Examples.hash([2, 1]));
  });

  it('separates values a lazy hash would collide', () => {
    const distinct = ['', '0', 0, null, false, [], {}, [[]], [{}], { a: '' }, { a: null }];
    const hashes = new Set(distinct.map(Examples.hash));
    assert.equal(hashes.size, distinct.length);
  });

  it('hashText is blind to CRLF and a BOM, so Windows and CI agree', () => {
    const lf = '{\n  "a": 1\n}\n';
    assert.equal(Examples.hashText(lf), Examples.hashText(lf.replace(/\n/g, '\r\n')));
    assert.equal(Examples.hashText(lf), Examples.hashText('﻿' + lf));
  });
});

describe('asBundle', () => {
  it('wraps a bare schema document, and leaves an export-shaped one alone', () => {
    const bare = read('chores-schema.json');
    assert.equal(bare.schema, undefined);
    assert.equal(Examples.asBundle(bare).schema, bare);

    const wrapped = read('bishopric-schema.json');
    assert.equal(Examples.asBundle(wrapped), wrapped);
  });
});

describe('listsForInstall', () => {
  // Reinstalling an example to pick up a schema change used to hand the bundle's lists straight to
  // saveLists. Every shipped bundle ships them EMPTY, and the Firestore backend prunes what the map
  // omits -- so reinstalling emptied every vocabulary the deployment had filled in, and deleted every
  // list the bundle had never heard of. These cases are that bug, from several directions.
  it('fills a vocabulary the database has not started', () => {
    assert.deepEqual(Examples.listsForInstall({ hymns: [] }, { hymns: ['1. Hymn'] }), { hymns: ['1. Hymn'] });
  });

  it('fills one the database does not have at all', () => {
    assert.deepEqual(Examples.listsForInstall({}, { bishopric: ['bishop'] }), { bishopric: ['bishop'] });
  });

  it('leaves a vocabulary that already has values exactly as it is', () => {
    const existing = { hymns: ['1. Hymn', '2. Hymn'] };
    assert.deepEqual(Examples.listsForInstall(existing, { hymns: [] }), existing);
    assert.deepEqual(Examples.listsForInstall(existing, { hymns: ['something else'] }), existing);
  });

  it('keeps a list the bundle never mentions, which is what pruning would delete', () => {
    assert.deepEqual(Examples.listsForInstall({ ward_only: ['a'] }, { hymns: [] }),
      { ward_only: ['a'], hymns: [] });
  });

  it('costs the bishopric example nothing on a filled-in database', () => {
    const shipped = read('bishopric-schema.json').lists;
    // Every shipped list is empty except `bishopric` -- which is exactly why applying them verbatim hurt.
    assert.deepEqual(Object.keys(shipped).filter((n) => shipped[n].length), ['bishopric']);
    const ward = { hymns: ['1. Hymn'], members: ['Someone'], bishopric: ['bishop', 'counselor1'], retired: ['x'] };
    const after = Examples.listsForInstall(ward, shipped);
    for (const name of Object.keys(ward)) assert.deepEqual(after[name], ward[name], name + ' survived');
    assert.deepEqual(after.cleaners, [], 'a vocabulary the ward never started still arrives');
  });
});

describe('mergeFiles', () => {
  it('folds the demo bundle — schema, three language packs, sample rows — into one import', () => {
    const merged = Examples.mergeFiles([
      read('demo-schema.json'), read('demo-lang-en.json'), read('demo-lang-es.json'),
      read('demo-lang-sv.json'), read('app-lang-en.json'), read('demo-data.json')
    ]);

    assert.ok(merged.schema.tables.tasks, 'the schema survived');
    assert.deepEqual(merged.languages.map((l) => l.code), ['en', 'es', 'sv']);
    assert.deepEqual(Object.keys(merged.translations).sort(), ['en', 'es', 'sv']);
    // The app pack and the schema pack both carry `en` and must COMBINE, exactly as importing them
    // one after the other does.
    assert.ok(merged.translations.en['tab.tasks'], 'schema labels');
    assert.ok(merged.translations.en['settings.import'], 'app UI labels');
    assert.ok(merged.tables.tasks.length, 'sample rows');
    assert.ok(merged.config.rotationAnchors, 'rotation config');
  });

  it('later files win, per key, without dropping what earlier ones set', () => {
    const merged = Examples.mergeFiles([
      { lists: { crew: ['Ann'] }, translations: { en: { a: '1', b: '2' } }, languages: [{ code: 'en', name: 'English' }] },
      { lists: { status: ['open'] }, translations: { en: { b: 'two', c: '3' } }, languages: [{ code: 'en', name: 'Duplicate' }] }
    ]);
    assert.deepEqual(merged.lists, { crew: ['Ann'], status: ['open'] });
    assert.deepEqual(merged.translations.en, { a: '1', b: 'two', c: '3' });
    assert.deepEqual(merged.languages, [{ code: 'en', name: 'English' }], 'a language is declared once');
  });

  it('merges rows by id rather than importing the same row twice', () => {
    const merged = Examples.mergeFiles([
      { tables: { tasks: [{ id: 't1', title: 'first' }, { id: 't2' }] } },
      { tables: { tasks: [{ id: 't1', title: 'second' }, { id: 't3' }] } }
    ]);
    assert.deepEqual(merged.tables.tasks.map((r) => r.id), ['t1', 't2', 't3']);
    assert.equal(merged.tables.tasks[0].title, 'second');
  });

  it('an empty list of files is an empty import, not a crash', () => {
    assert.deepEqual(Examples.mergeFiles([]), {});
    assert.deepEqual(Examples.mergeFiles(null), {});
  });
});

describe('fingerprint', () => {
  const bundle = Examples.mergeFiles([read('chores-schema.json'), read('chores-lang-en.json')]);
  const units = Examples.fingerprint(bundle);

  it('names one unit per column, per view and per translation string', () => {
    assert.ok(units['tables/ref_chores/columns/points'], 'a column');
    assert.ok(units['tables/chore_log'], 'the table\'s own attributes');
    assert.ok(units['views/chore_board'], 'a view');
    assert.ok(units['views/_tree'], 'the nav tree');
    assert.ok(units['schema/theme'], 'a top-level schema key');
    assert.ok(units['tr/en/tab.chore_log'], 'a translation string');
    assert.equal(units['tables'], undefined, 'tables are not one unit');
  });

  it('carries no rows, pages or assets — data is never part of an update', () => {
    const withData = Examples.fingerprint(Examples.mergeFiles([read('chores-schema.json'), read('chores-data.json')]));
    assert.deepEqual(Object.keys(withData).filter((k) => /^(tables\/[^/]+\/rows|pages|assets)/.test(k)), []);
  });

  it('is unchanged by the normalization the app applies before storing a schema', () => {
    // This is the whole point: what the app has in the database is the migrated, column-folded, id-
    // injected form. Fingerprinting that must land on the same units as fingerprinting the file.
    const stored = JSON.parse(JSON.stringify(read('chores-schema.json')));
    SchemaNormalize.normalize(stored);
    assert.deepEqual(Examples.fingerprint({ schema: stored }), Examples.fingerprint({ schema: read('chores-schema.json') }));
  });

  it('moves for a changed column, and for a view moved between nav groups', () => {
    const edited = JSON.parse(JSON.stringify(read('chores-schema.json')));
    edited.tables.ref_chores.columns.find((c) => c.name === 'points').type = 'text';
    const after = Examples.fingerprint({ schema: edited });
    assert.notEqual(after['tables/ref_chores/columns/points'], units['tables/ref_chores/columns/points']);
    assert.equal(after['views/chore_board'], units['views/chore_board'], 'an unrelated view stays put');

    const moved = JSON.parse(JSON.stringify(read('chores-schema.json')));
    moved.views.push(moved.views.shift());
    assert.notEqual(Examples.fingerprint({ schema: moved })['views/_tree'], units['views/_tree']);
  });
});

describe('compare', () => {
  const manifest = read('index.json');
  const installed = (over) => Object.assign({
    bundle: 'chores', revision: 1,
    files: Examples.fileHashes(manifest.bundles.find((b) => b.id === 'chores'), manifest)
  }, over || {});

  it('says nothing when the deployment ships exactly what was installed', () => {
    assert.equal(Examples.compare(installed(), manifest), null);
  });

  it('names the files that moved, and only those', () => {
    const stale = installed();
    stale.files['chores-schema.json'] = 'deadbeefdeadbeef';
    const found = Examples.compare(stale, manifest);
    assert.deepEqual(found.changed, ['chores-schema.json']);
    assert.equal(found.bundle, 'chores');
    assert.equal(found.title, 'Our Home');
  });

  it('notices an app-language pack moving, since it installs alongside the bundle', () => {
    const stale = installed();
    stale.files['app-lang-en.json'] = 'deadbeefdeadbeef';
    assert.deepEqual(Examples.compare(stale, manifest).changed, ['app-lang-en.json']);
  });

  it('stays quiet for a database that never installed one, or whose bundle is gone', () => {
    assert.equal(Examples.compare(null, manifest), null);
    assert.equal(Examples.compare({ bundle: 'not-shipped-here', files: {} }, manifest), null);
    assert.equal(Examples.compare(installed(), null), null);
  });
});
