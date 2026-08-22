// column-multiple.test.js — cardinality is a flag, not a column type.
//
// `select` and `multiselect` differed in exactly one thing: whether the cell holds one value or several.
// As a separate TYPE that difference could not compose — `ref` had no multi-valued form at all, so a
// schema wanting several values from a lookup table had to point a `multiselect` at it through `list`
// and lose every reference behaviour on the way. examples/chores-schema.json does exactly that.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Columns = require('../../columns');
const Migrations = require('../../migrations');

describe('columns — `multiple` makes a column hold several values', () => {
  const schema = {
    t: {
      columns: {
        legacy:   { type: 'multiselect', list: 'members' },
        flagged:  { type: 'select', list: 'members', multiple: true },
        single:   { type: 'select', list: 'members' },
        multiref: { type: 'ref', table: 'chores', valueCol: 'chore', multiple: true },
        oneref:   { type: 'ref', table: 'chores', valueCol: 'chore' }
      }
    }
  };

  it('the flag and the legacy type mean the same thing', () => {
    assert.equal(Columns.colIsMultiselect(schema, 'legacy'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'flagged'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'single'), false);
  });

  it('a ref can be multi-valued, which no type name could express', () => {
    // The whole point. Both predicates are true at once: it is a reference AND it holds several.
    assert.equal(Columns.colIsRef(schema, 'multiref'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'multiref'), true);
    assert.equal(Columns.colIsRef(schema, 'oneref'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'oneref'), false);
  });

  it('columnRef still resolves the target table for a multi-valued ref', () => {
    const r = Columns.columnRef(schema, 't', 'multiref');
    assert.ok(r, 'a multi-valued ref must still be a ref');
    assert.equal(r.table, 'chores');
    assert.equal(r.valueCol, 'chore');
  });

  it('and tableDeps still reports the lookup table it needs loaded', () => {
    // The behaviour a faked multi-ref lost: nothing knew the lookup table was involved, so nothing
    // loaded it.
    assert.ok(Columns.tableDeps(schema, 't').includes('chores'));
  });

  it('the flag is per column, not per column NAME across tables', () => {
    // colIsMultiselect answers for a name across the whole schema (a column is typed the same in every
    // table, by convention). Assert the convention holds rather than pretending otherwise: a name
    // flagged anywhere reads as multi everywhere, exactly as `type: multiselect` always did.
    const mixed = {
      a: { columns: { tags: { type: 'select', list: 'l' } } },
      b: { columns: { tags: { type: 'select', list: 'l', multiple: true } } }
    };
    assert.equal(Columns.colIsMultiselect(mixed, 'tags'), true);
  });

  it('ignores a falsy or absent flag', () => {
    const s = { t: { columns: { a: { type: 'select', list: 'l', multiple: false }, b: { type: 'select', list: 'l' } } } };
    assert.equal(Columns.colIsMultiselect(s, 'a'), false);
    assert.equal(Columns.colIsMultiselect(s, 'b'), false);
  });
});

describe('migrations — v2 to v3 moves multiselect onto the flag', () => {
  it('rewrites the type and sets the flag', () => {
    const s = { schemaVersion: 2, tables: { t: { columns: { a: { type: 'multiselect', list: 'x' } } } }, views: [] };
    Migrations.migrate(s);
    assert.deepEqual(s.tables.t.columns.a, { type: 'select', list: 'x', multiple: true });
  });

  it('handles the array shape of `columns` too', () => {
    // examples/bishopric-schema.json declares columns as an array of {name,...}.
    const s = { schemaVersion: 2, tables: { t: { columns: [{ name: 'a', type: 'multiselect', list: 'x' }] } }, views: [] };
    Migrations.migrate(s);
    assert.deepEqual(s.tables.t.columns[0], { name: 'a', type: 'select', list: 'x', multiple: true });
  });

  it('leaves every other column alone', () => {
    const s = { schemaVersion: 2, tables: { t: { columns: {
      a: { type: 'select', list: 'x' }, b: { type: 'text' }, c: { type: 'ref', table: 'y' }, d: 'text'
    } } }, views: [] };
    Migrations.migrate(s);
    assert.deepEqual(s.tables.t.columns, {
      a: { type: 'select', list: 'x' }, b: { type: 'text' }, c: { type: 'ref', table: 'y' }, d: 'text'
    });
  });

  it('is idempotent, like every step in the chain', () => {
    const s = { schemaVersion: 2, tables: { t: { columns: { a: { type: 'multiselect', list: 'x' } } } }, views: [] };
    Migrations.migrate(s);
    const again = Migrations.migrate(s);
    assert.deepEqual(again.applied, []);
    assert.deepEqual(s.tables.t.columns.a, { type: 'select', list: 'x', multiple: true });
  });

  it('renames no translation keys, because no column NAME moves', () => {
    // The reason this migration needs no _langs rewrite: it changes definitions, not identities.
    const s = { schemaVersion: 2, tables: { t: { columns: { a: { type: 'multiselect', list: 'x' } } } }, views: [] };
    assert.deepEqual(Migrations.migrate(s).renames, []);
  });

  it('a migrated column behaves identically to the legacy one it replaced', () => {
    // The property that makes this safe to run on live schemas: same answers, different spelling.
    const before = { t: { columns: { a: { type: 'multiselect', list: 'x' } } } };
    const s = { schemaVersion: 2, tables: JSON.parse(JSON.stringify(before)), views: [] };
    Migrations.migrate(s);
    for (const fn of ['colIsMultiselect', 'colIsList', 'colIsRef', 'colIsDate', 'colIsNumber']) {
      assert.equal(Columns[fn](s.tables, 'a'), Columns[fn](before, 'a'), fn);
    }
  });
});
