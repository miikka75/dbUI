// schema-meta.test.js — `schema.schema.json`, the meta-schema authors point their editor at.
//
// Users hand-edit the schema document; that is the stated design. Two whole classes of mistake are
// invisible to them and to the app alike, because the document stays valid JSON and the app keeps
// working: an unknown column `type` reads as "text" (so the dropdown just never appears), and an
// unknown KEY is never read (so `"allowNews": true` changes nothing and says nothing).
//
// The vocabulary therefore exists twice on purpose — once for the editor (schema.schema.json) and once
// for the load-time check (Columns.COLUMN_TYPES / COLUMN_KEYS, enforced by validateSchema). Two copies
// of anything is what this repo spends its effort NOT having, so the copies are held together here:
// this file fails if they drift, and fails if the meta-schema rejects a schema the repo actually ships.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const Columns = require('../../columns');
const ROOT = path.resolve(__dirname, '../..');
const META = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema.schema.json'), 'utf8'));

// `strict: false`: the meta-schema carries `title` on the two `access` branches purely so an editor can
// name them in its completion list, which strict mode flags as an unknown-keyword-in-context.
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(META);

const colDef = META.$defs.column.oneOf[1];
const fail = (errs) => (errs || []).map((e) => (e.instancePath || '/') + ' ' + e.message).join('\n  ');

describe('schema.schema.json — the meta-schema and the load-time check agree', () => {
  it('states the same column types the loader accepts', () => {
    // If these ever differ, one of the two is lying to somebody: the editor accepts a type the app
    // will silently read as "text", or the app rejects a type the editor offered.
    assert.deepEqual(META.$defs.columnType.enum, Columns.COLUMN_TYPES);
  });

  it('states the same column properties the loader accepts', () => {
    assert.deepEqual(Object.keys(colDef.properties).sort(), [...Columns.COLUMN_KEYS].sort());
  });

  it('closes the column object, which is the whole point of listing its keys', () => {
    // A meta-schema that documents 16 properties and then allows a 17th catches nothing.
    assert.equal(colDef.additionalProperties, false);
    assert.deepEqual(colDef.required, ['name']);
  });
});

// Every schema document the repo ships, in the shape the app loads it. `bishopric-schema.json` is a
// BUNDLE (schema + lists + row data), so its document lives under `.schema` — validating the bundle
// itself would test the wrong object and fail on `tables` holding rows rather than table defs.
// `dev/data/schema.json` is deliberately absent: `dev/data/` is gitignored runtime state, so it does
// not exist on a fresh clone and a test naming it would pass locally and fail in CI.
const SHIPPED = [
  ['dev/schema.json', (j) => j],
  ['dev/test-ui/fixture-schema.json', (j) => j],
  ['examples/chores-schema.json', (j) => j],
  ['examples/bishopric-schema.json', (j) => j.schema],
];

describe('schema.schema.json — every schema this repo ships validates against it', () => {
  // A meta-schema nobody checks against real documents is decoration: it will be subtly wrong (the
  // first draft of this one had `listSwitch` as a string, which is an object, and dev/schema.json is
  // what said so) and the only person to find out would be an author seeing red underlines under
  // working JSON.
  for (const [file, pick] of SHIPPED) {
    it(file, () => {
      const doc = pick(JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')));
      assert.ok(validate(doc), file + ' does not validate:\n  ' + fail(validate.errors));
    });
  }
});

describe('schema.schema.json — the mistakes it exists to catch', () => {
  const withColumn = (col) => ({ tables: { t: { columns: [col] } } });

  it('rejects a mistyped column type', () => {
    assert.equal(validate(withColumn({ name: 'status', type: 'slect', list: 'status' })), false);
  });

  it('rejects a mistyped column property', () => {
    assert.equal(validate(withColumn({ name: 'who', type: 'select', list: 'x', allowNews: true })), false);
  });

  it('accepts the bare-string column shorthand the implicit `id` uses', () => {
    assert.ok(validate({ tables: { t: { columns: { id: 'text' } } } }), fail(validate.errors));
  });

  it('accepts both column shapes, because both are stored', () => {
    assert.ok(validate({ tables: { t: { columns: [{ name: 'a', type: 'text' }] } } }), fail(validate.errors));
    assert.ok(validate({ tables: { t: { columns: { a: { name: 'a', type: 'text' } } } } }), fail(validate.errors));
  });

  it('rejects a nav entry that is neither a view, a table nor a group', () => {
    assert.equal(validate({ nav: { items: [{ icon: 'mdi-home' }] } }), false);
  });

  it('rejects an unknown top-level key', () => {
    // The root vocabulary is small and closed, so a stray key here is always a typo or a dead feature.
    assert.equal(validate({ tables: {}, viewz: [] }), false);
  });
});

describe('schema.schema.json — the `access` sentinel', () => {
  const page = (access) => ({ views: [{ name: 'p', markdown: '# p', access: access }] });

  it('accepts the "all" sentinel alone', () => {
    assert.ok(validate(page(['all'])), fail(validate.errors));
  });

  it('accepts a list of table names', () => {
    assert.ok(validate(page(['tasks', 'notes'])), fail(validate.errors));
  });

  it('rejects "all" MIXED with table names, which cannot mean anything', () => {
    // The app tolerates it — canAccessPage just never finds "all" in a real grant array — but a
    // full-access user already passes any non-empty list, so ["all","tasks"] IS ["tasks"]. An author
    // writing it believes it does something it does not, which is the class of mistake this file is
    // about. Stated in the meta-schema's own description so it doesn't read as an app rule.
    assert.equal(validate(page(['all', 'tasks'])), false);
  });

  it('rejects an empty access list, which reads as "unrestricted" rather than "nobody"', () => {
    assert.equal(validate(page([])), false);
  });
});
