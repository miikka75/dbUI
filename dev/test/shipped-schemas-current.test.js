// shipped-schemas-current.test.js — the schemas we SHIP must be written in the current shape.
//
// Every schema in the repo was v1: no `kind` on any view, and `multiselect` columns, a type v3 does
// not have. Nothing broke, because `migrate()` runs on import and an admin's first boot writes the
// result back — so what is stored in any database was always current, and only the files were stale.
//
// It still mattered, because these files are documentation. Someone opening chores-schema.json to
// learn the schema language read `"type": "multiselect"` while SCHEMA.md documented `multiple`, and
// there was nothing to notice the two had drifted apart.
//
// This does not test the migration — the fixtures in column-multiple.test.js and migrations.test.js
// do that, and they are hand-written in the old shape on purpose so the v1 path keeps its coverage.
// It tests that the shipped files no longer NEED it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const Migrations = require('../../migrations.js');

// Every file in the repo that carries a schema. `bishopric-schema.json` is a bundle whose schema sits
// under `.schema`; the others are bare.
const SHIPPED = ['examples/chores-schema.json', 'examples/bishopric-schema.json', 'dev/schema.json'];

describe('shipped schemas are written in the current version', () => {
  for (const rel of SHIPPED) {
    it(rel + ' needs no migration', () => {
      const doc = JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));
      const schema = doc.schema || doc;

      assert.ok(schema.views && schema.tables,
        rel + ': no schema found here — this test would pass vacuously');
      assert.equal(schema.schemaVersion, Migrations.CURRENT_VERSION,
        rel + ' does not declare the current schemaVersion, so migrate() treats it as v1');

      // The real check: running the chain over it changes nothing. Stamping the version alone would
      // satisfy the assertion above while leaving v1 CONTENT that the stamp now hides from migrate().
      const before = JSON.stringify(schema);
      const r = Migrations.migrate(JSON.parse(before));
      assert.deepEqual(r.applied, [],
        rel + ' still needs migration steps: ' + r.applied.join(' | '));
      assert.equal(JSON.stringify(r.schema), before,
        rel + ' is changed by migrate(), so it is not in current shape');
    });

    it(rel + ' carries no v1 leftovers', () => {
      // Named directly rather than inferred, so the failure says which shape to fix. A stamped file
      // whose content is still v1 would otherwise sail past migrate(), which trusts the stamp.
      const doc = JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));
      const schema = doc.schema || doc;

      const untyped = (schema.views || []).filter((v) => !v.kind).map((v) => v.name || '(unnamed)');
      assert.deepEqual(untyped, [], rel + ': views without an explicit `kind`');

      const multiselect = [];
      for (const [table, def] of Object.entries(schema.tables || {})) {
        const cols = (def || {}).columns || [];
        for (const c of (Array.isArray(cols) ? cols : Object.values(cols))) {
          if (c && c.type === 'multiselect') multiselect.push(table + '.' + (c.name || '?'));
        }
      }
      assert.deepEqual(multiselect, [], rel + ': `multiselect` columns (v3 spells this `multiple: true`)');
    });
  }
});
