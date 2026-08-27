// schema-vocabulary.test.js — Columns.vocabularyErrors: the load-time half of the schema vocabulary.
//
// This is the check validateSchema runs over every column of every table. It exists because both ways
// a column def can be wrong about itself are INVISIBLE: `columnType` defaults to 'text', so a mistyped
// type renders a perfectly working text column, and a key nobody reads is a no-op. The document stays
// valid JSON, the app keeps working, and the author is left looking for a bug in the wrong place.
//
// `schema.schema.json` says the same thing to the author's editor; dev/test/schema-meta.test.js holds
// the two statements together.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Columns = require('../../columns');
const ROOT = path.resolve(__dirname, '../..');

const cols = (list) => ({ t: { columns: list } });
const only = (errs) => errs.join('\n');

describe('Columns.vocabularyErrors — unknown column types', () => {
  it('names the column, the bad type, and what it silently became', () => {
    const errs = Columns.vocabularyErrors(cols([{ name: 'status', type: 'slect', list: 'status' }]));
    assert.equal(errs.length, 1);
    // The message has to carry the consequence, not just the fact: "unknown type" alone leaves the
    // author wondering whether the column works at all. It does — that is the problem.
    assert.match(errs[0], /column "status"/);
    assert.match(errs[0], /"slect"/);
    assert.match(errs[0], /silently reads as "text"/);
  });

  it('accepts every type the app implements', () => {
    for (const type of Columns.COLUMN_TYPES) {
      assert.deepEqual(Columns.vocabularyErrors(cols([{ name: 'c', type }])), [], type);
    }
  });

  it('accepts `multiselect`, which is legacy but still on disk', () => {
    // Migration v3 rewrites it to select + multiple, and the migration runs at LOAD. Rejecting it here
    // would fail the document before it got the chance to be upgraded.
    assert.deepEqual(Columns.vocabularyErrors(cols([{ name: 'people', type: 'multiselect', list: 'crew' }])), []);
  });

  it('accepts a column with no type at all (text is the documented default)', () => {
    assert.deepEqual(Columns.vocabularyErrors(cols([{ name: 'title' }])), []);
  });

  it('checks the bare-string shorthand too, which is how the implicit `id` is injected', () => {
    assert.deepEqual(Columns.vocabularyErrors({ t: { columns: { id: 'text' } } }), []);
    assert.equal(Columns.vocabularyErrors({ t: { columns: { id: 'txet' } } }).length, 1);
  });
});

describe('Columns.vocabularyErrors — unknown column properties', () => {
  it('names the property and says it does nothing', () => {
    const errs = Columns.vocabularyErrors(cols([{ name: 'who', type: 'select', list: 'x', allowNews: true }]));
    assert.equal(errs.length, 1, only(errs));
    assert.match(errs[0], /unknown property "allowNews"/);
    assert.match(errs[0], /does nothing/);
  });

  it('accepts every property the app reads', () => {
    // Built from the vocabulary itself rather than hand-listed: a key added to COLUMN_KEYS without a
    // reader is a different bug, and one this test cannot see anyway.
    // `type` gets a real value rather than the placeholder: `"type": null` reads as "text" through the
    // same `|| 'text'` fallback a typo does, so the enum check flags it, and rightly.
    const def = { name: 'c', type: 'text' };
    Columns.COLUMN_KEYS.forEach((k) => { if (k !== 'name' && k !== 'type') def[k] = null; });
    assert.deepEqual(Columns.vocabularyErrors(cols([def])), []);
  });

  it('reports every mistake in one pass, not just the first', () => {
    const errs = Columns.vocabularyErrors({
      a: { columns: [{ name: 'x', type: 'nope' }] },
      b: { columns: [{ name: 'y', sortd: true }] },
    });
    assert.equal(errs.length, 2, only(errs));
    assert.ok(errs.some((e) => e.includes('table "a"')));
    assert.ok(errs.some((e) => e.includes('table "b"')));
  });

  it('reads both column shapes, because both are stored', () => {
    const bad = { name: 'x', type: 'nope' };
    assert.equal(Columns.vocabularyErrors({ t: { columns: [bad] } }).length, 1);
    assert.equal(Columns.vocabularyErrors({ t: { columns: { x: bad } } }).length, 1);
  });

  it('survives a table with no columns, and no tables at all', () => {
    assert.deepEqual(Columns.vocabularyErrors({ t: {} }), []);
    assert.deepEqual(Columns.vocabularyErrors({}), []);
    assert.deepEqual(Columns.vocabularyErrors(null), []);
  });
});

describe('Columns.vocabularyErrors — against what the repo actually ships', () => {
  // The check is only worth having if it is silent on every real schema. A false positive here is
  // worse than no check at all: it makes a working document report errors on load.
  const SHIPPED = [
    ['examples/demo-schema.json', (j) => j.tables],
    ['dev/test-ui/fixture-schema.json', (j) => j.tables],
    ['examples/chores-schema.json', (j) => j.tables],
    ['examples/bishopric-schema.json', (j) => j.schema.tables],
  ];
  for (const [file, pick] of SHIPPED) {
    it(file, () => {
      const tables = pick(JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')));
      assert.deepEqual(Columns.vocabularyErrors(tables), []);
    });
  }
});
