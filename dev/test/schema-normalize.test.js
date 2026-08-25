// schema-normalize.test.js — the authored-schema -> runtime-schema conversion, and the drift guard
// that is the reason it is a module at all.
//
// schema-loader.js (browser) and dev/schema.js (the Node harness nine-plus test files load a schema
// through) each had their own copy of this. The copy had already drifted a view kind behind, which
// meant the unit suite could normalize a schema differently from the app and nothing would say so.
// The last two cases below assert the extraction actually took: neither file re-implements it.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SchemaNormalize = require('../../schema-normalize');
const Migrations = require('../../migrations');

const ROOT = path.join(__dirname, '..', '..');

describe('schema-normalize — the view discriminator', () => {
  it('recognizes every kind that carries a body', () => {
    const kinds = [
      { name: 'd', sources: ['t'] }, { name: 'p', markdown: '# hi' }, { name: 'r', rotation: {} },
      { name: 'c', calendar: {} }, { name: 'v', pivot: {} }, { name: 's', rsvp: {} },
      { name: 'b', board: {} }, { name: 'f', form: {} }
    ];
    for (const v of kinds) assert.equal(SchemaNormalize.isView(v), true, v.name + ' should be a view');
  });

  it('is not fooled by a nav group, named or not', () => {
    assert.equal(SchemaNormalize.isView({ name: 'Reports', views: [] }), false);
    assert.equal(SchemaNormalize.isView({ views: [{ name: 'd', sources: ['t'] }] }), false);
    assert.equal(SchemaNormalize.isView(null), false);
    assert.equal(SchemaNormalize.isView({ sources: ['t'] }), false, 'a body with no name cannot be addressed');
  });

  it('does NOT use `kind`, because a named group gets one too', () => {
    // migrate() stamps `kind` on every NAMED entry and kindOf defaults to 'data', so a nav group that
    // only holds nested views comes out labelled `kind: "data"` while being no view at all. Trusting
    // the label here would register folders as views.
    const schema = { views: [{ name: 'Reports', views: [{ name: 'inner', pivot: {} }] }] };
    Migrations.migrate(schema);
    assert.equal(schema.views[0].kind, 'data', 'the premise: migrate labels the group');
    assert.equal(SchemaNormalize.isView(schema.views[0]), false, 'and the discriminator still says no');
  });

  it('flattenViews walks the nested nav tree', () => {
    const map = SchemaNormalize.flattenViews([
      { name: 'top', sources: ['t'] },
      { name: 'Group', views: [{ name: 'deep', calendar: {} }, { name: 'Sub', views: [{ name: 'deeper', rsvp: {} }] }] }
    ]);
    assert.deepEqual(Object.keys(map).sort(), ['deep', 'deeper', 'top']);
  });
});

describe('schema-normalize — column folding', () => {
  it('folds the authored array into the runtime map and records the order', () => {
    const tables = { t: { columns: [
      { name: 'b', type: 'select', list: 'l' }, { name: 'a', type: 'text' }, { name: 'plain' }
    ] } };
    const orders = SchemaNormalize.foldColumns(tables);
    assert.deepEqual(orders.t, ['b', 'a', 'plain'], 'the map cannot carry order; this is where it lives');
    assert.deepEqual(tables.t.columns.b, { type: 'select', list: 'l' }, 'the name becomes the key, not a field');
    assert.equal(tables.t.columns.plain, 'text', 'a def holding nothing but its name collapses to the bare type');
  });

  it('leaves an already-folded table alone and just reports its key order', () => {
    const tables = { t: { columns: { x: { type: 'text' }, y: 'text' } } };
    const orders = SchemaNormalize.foldColumns(tables);
    assert.deepEqual(orders.t, ['x', 'y']);
    assert.deepEqual(tables.t.columns, { x: { type: 'text' }, y: 'text' });
  });

  it('is idempotent — the chain re-runs on every load', () => {
    const tables = { t: { columns: [{ name: 'a', type: 'text' }] } };
    const first = SchemaNormalize.foldColumns(tables);
    const second = SchemaNormalize.foldColumns(tables);
    assert.deepEqual(second, first);
  });

  it('ensureImplicitId injects `id` first, once', () => {
    const tables = { t: { columns: [{ name: 'a', type: 'text' }] } };
    const orders = SchemaNormalize.foldColumns(tables);
    SchemaNormalize.ensureImplicitId(tables, orders);
    SchemaNormalize.ensureImplicitId(tables, orders);
    assert.equal(tables.t.columns.id, 'text');
    assert.deepEqual(orders.t, ['id', 'a']);
  });

  it('a declared `id` is not moved or duplicated', () => {
    const tables = { t: { columns: [{ name: 'a', type: 'text' }, { name: 'id', type: 'text' }] } };
    const orders = SchemaNormalize.foldColumns(tables);
    SchemaNormalize.ensureImplicitId(tables, orders);
    assert.deepEqual(orders.t, ['a', 'id']);
  });
});

describe('schema-normalize — normalize() runs the real load path', () => {
  it('migrates a v1 document before anything reads it', () => {
    const n = SchemaNormalize.normalize({
      tables: { t: { columns: [{ name: 'tags', type: 'multiselect', list: 'l' }] } },
      views: [{ name: 'c', calendar: {} }]
    });
    assert.equal(n.migration.from, 1);
    assert.equal(n.migration.applied.length > 0, true);
    assert.deepEqual(n.tables.t.columns.tags, { type: 'select', multiple: true, list: 'l' },
      'v2->v3: cardinality is a flag, not a type');
    assert.equal(n.views[0].kind, 'calendar', 'v1->v2: the kind is written down');
  });

  it('reports nothing applied for a current document', () => {
    const n = SchemaNormalize.normalize({
      schemaVersion: Migrations.CURRENT_VERSION, tables: {}, views: [{ name: 'd', kind: 'data', sources: ['t'] }]
    });
    assert.deepEqual(n.migration.applied, []);
  });

  it('canonicalizes legacy view filters — the shim dev/schema.js used to skip entirely', () => {
    // This is the gap the extraction closes: the harness never ran convertViewFilters, so no unit test
    // ever took a legacy array-IN filter through the load path the app actually uses.
    const n = SchemaNormalize.normalize({
      tables: {}, views: [{ name: 'd', sources: ['t'], filter: { status: ['open', 'doing'] } }]
    });
    assert.deepEqual(n.viewsMap.d.filter, { $or: [{ status: 'open' }, { status: 'doing' }] });
  });

  it('an empty document normalizes to empty rather than throwing', () => {
    const n = SchemaNormalize.normalize({});
    assert.deepEqual(n.tables, {});
    assert.deepEqual(n.views, []);
    assert.deepEqual(n.viewsMap, {});
    assert.deepEqual(n.orders, {});
  });
});

describe('schema-normalize — both loaders go through it', () => {
  // Source guards, like the write-funnel and rules-parity ones: a re-implementation would not fail any
  // behavioural test, it would just quietly become a second answer to the same question again.
  const loader = fs.readFileSync(path.join(ROOT, 'schema-loader.js'), 'utf8');
  const harness = fs.readFileSync(path.join(ROOT, 'dev', 'schema.js'), 'utf8');

  it('schema-loader.js calls the module and re-implements none of it', () => {
    assert.match(loader, /SchemaNormalize\.normalize\(/);
    assert.doesNotMatch(loader, /function _flattenViews/, 'the flattener moved');
    assert.doesNotMatch(loader, /Array\.isArray\(SCHEMA\[t\]\.columns\)/, 'the column folding moved');
  });

  it('dev/schema.js calls the module and re-implements none of it', () => {
    assert.match(harness, /SchemaNormalize\.normalize\(/);
    assert.doesNotMatch(harness, /function flattenViews/, 'the flattener moved');
    assert.doesNotMatch(harness, /columns = colMap/, 'the column folding moved');
  });

  it('the harness and the app agree on the shipped schema', () => {
    // The drift that motivated all of this, asserted directly: load dev/schema.json through the module
    // and compare the view set with what the harness exposes.
    const { VIEWS } = require('../schema');
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev', 'schema.json'), 'utf8'));
    const n = SchemaNormalize.normalize(doc);
    assert.deepEqual(Object.keys(n.viewsMap).sort(), Object.keys(VIEWS).sort());
    assert.ok(Object.keys(VIEWS).length > 0, 'this test would pass vacuously on an empty schema');
  });
});
