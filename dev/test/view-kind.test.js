// view-kind.test.js — `kind` is now the discriminator, so it has to be TRUE.
//
// A view's kind used to be worked out by probing for a `calendar`/`rotation`/`pivot`/... key, in every
// consumer that needed it: app-core's seven `is*View` computeds, `SchemaNormalize.isView`, and
// `Migrations.kindOf`. An implicit discriminator cannot be kept in sync because there is nothing to
// sync — dev/schema.js's copy had already drifted a kind behind before it was deleted.
//
// There is one answer now (`SchemaNormalize.viewKind`), read off the `kind` the schema carries. That
// only works while the stored label matches what the entry actually is, which is what this file checks:
// against the shipped schemas, against the vocabulary the meta-schema publishes, and against the shape
// that kept `kind` from being usable for two versions — a nav group.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Migrations = require('../../migrations');
const SchemaNormalize = require('../../schema-normalize');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));

// Bare schema documents plus the one bundle, whose document sits under `.schema`.
const SHIPPED = [
  ['examples/chores-schema.json', (d) => d],
  ['examples/bishopric-schema.json', (d) => d.schema],
  ['dev/schema.json', (d) => d],
];

const eachNamed = (schema, fn) => Migrations.eachView(schema.views, (v) => { if (v && v.name) fn(v); });

describe('viewKind — the stored label matches what the entry is', () => {
  for (const [rel, pick] of SHIPPED) {
    it(rel, () => {
      // A stored `kind` that disagrees with the entry's own shape is worse than no kind at all: the
      // loader now trusts it, so a stale label routes a rotation view to the data renderer and the
      // failure looks like a rendering bug rather than a schema one.
      const schema = pick(read(rel));
      let checked = 0;
      eachNamed(schema, (v) => {
        checked++;
        assert.equal(v.kind, Migrations.kindOf(v), rel + ': view "' + v.name + '" is labelled ' + v.kind);
        assert.equal(SchemaNormalize.viewKind(v), v.kind);
      });
      assert.ok(checked > 0, rel + ': no named views found — this test would pass vacuously');
    });
  }
});

describe('viewKind — one discriminator, not nine', () => {
  it('derives the kind when the document carries none', () => {
    // A hand-written schema (the E2E fixture is one) has no `kind` on anything until the migration
    // chain runs, and schema-loader flattens the bundled defaultSchema before anything migrates it.
    const cases = [
      [{ name: 'd', sources: ['t'] }, 'data'],
      [{ name: 'p', markdown: '# hi' }, 'page'],
      [{ name: 'r', rotation: {} }, 'rotation'],
      [{ name: 'c', calendar: {} }, 'calendar'],
      [{ name: 'v', pivot: {} }, 'pivot'],
      [{ name: 's', rsvp: {} }, 'rsvp'],
      [{ name: 'b', board: {} }, 'board'],
      [{ name: 'f', form: {} }, 'form'],
      [{ name: 'g', views: [] }, 'group'],
    ];
    for (const [v, kind] of cases) assert.equal(SchemaNormalize.viewKind(v), kind, v.name);
  });

  it('prefers a written kind over the shape, so an author can override', () => {
    assert.equal(SchemaNormalize.viewKind({ name: 'x', sources: ['t'], kind: 'board' }), 'board');
  });

  it('labels an entry by what it RENDERS when it has both a body and nested views', () => {
    // Precedence, not an edge case: a kind answers "what does this draw", and a folder is the answer
    // only when there is nothing else to draw.
    assert.equal(SchemaNormalize.viewKind({ name: 'x', markdown: '#', views: [{ name: 'i', pivot: {} }] }), 'page');
  });

  it('has no kind for a bare table, which is not a view', () => {
    assert.equal(SchemaNormalize.viewKind(undefined), null);
    assert.equal(SchemaNormalize.viewKind(null), null);
  });
});

describe('viewKind — the vocabulary is published, so it must be complete', () => {
  it('the meta-schema lists every kind kindOf can return', () => {
    // schema.schema.json offers these to the author's editor. A kind the app produces but the editor
    // does not know is a red underline under a schema the app wrote itself — which is how a `group`
    // would have looked the moment migration started writing one.
    const meta = read('schema.schema.json');
    const published = meta.$defs.view.properties.kind.enum;
    const produced = [
      { rotation: {} }, { calendar: {} }, { pivot: {} }, { rsvp: {} }, { board: {} },
      { form: {} }, { markdown: '' }, { views: [] }, {},
    ].map((v) => Migrations.kindOf(v));
    assert.deepEqual([...new Set(produced)].sort(), [...published].sort());
  });
});
