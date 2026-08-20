// migrations.test.js — the schema version chain.
//
// The property that matters most is not that the migration does something, but that it changes NOTHING
// about how a view behaves. v1->v2 writes down the kind that was previously inferred; if the derivation
// and the old sniffing chain ever disagreed, every schema in the wild would silently render a different
// view. So the derivation is checked against the real if-chain in app-core.js, and against every schema
// actually shipped in the repo.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Migrations = require('../../migrations');

describe('migrations — the chain', () => {
  it('an unversioned schema is v1 and comes forward', () => {
    const s = { views: [{ name: 'a', sources: ['t'] }] };
    const r = Migrations.migrate(s);
    assert.equal(r.from, 1);
    assert.equal(r.to, Migrations.CURRENT_VERSION);
    assert.equal(r.applied.length, 1);
    assert.equal(s.schemaVersion, Migrations.CURRENT_VERSION);
  });

  it('is idempotent — it runs on every load until the result is written back', () => {
    const s = { views: [{ name: 'a', calendar: {} }] };
    Migrations.migrate(s);
    const again = Migrations.migrate(s);
    assert.deepEqual(again.applied, [], 'a second pass must apply nothing');
    assert.equal(s.views[0].kind, 'calendar');
  });

  it('never overrides a kind that was written by hand', () => {
    const s = { views: [{ name: 'a', calendar: {}, kind: 'data' }] };
    Migrations.migrate(s);
    assert.equal(s.views[0].kind, 'data', 'an explicit kind wins over the inferred one');
  });

  it('reaches views nested inside nav groups', () => {
    const s = { views: [{ name: 'grp', views: [{ name: 'inner', pivot: {} }] }] };
    Migrations.migrate(s);
    assert.equal(s.views[0].views[0].kind, 'pivot');
  });

  it('leaves a nameless nav group alone', () => {
    const s = { views: [{ views: [{ name: 'inner', rsvp: {} }] }] };
    Migrations.migrate(s);
    assert.equal(s.views[0].kind, undefined, 'a bare group is not a view');
    assert.equal(s.views[0].views[0].kind, 'rsvp');
  });
});

describe('migrations — the derivation matches what app-core used to infer', () => {
  // Reproduced from app-core's viewKind chain, in its ORDER, because order was the load-bearing part:
  // a view carrying two of these keys resolved by whichever branch came first.
  const legacy = (v) => {
    if (v.rotation) return 'rotation';
    if (v.calendar) return 'calendar';
    if (v.pivot) return 'pivot';
    if (v.rsvp) return 'rsvp';
    if (v.board) return 'board';
    if (typeof v.markdown === 'string') return 'page';
    return 'data';
  };

  const SHAPES = [
    { rotation: {} }, { calendar: {} }, { pivot: {} }, { rsvp: {} }, { board: {} },
    { markdown: '# hi' }, { sources: ['t'] }, {},
    // Ambiguous ones: two keys at once. These are what an unordered derivation would get wrong.
    { rotation: {}, calendar: {} }, { calendar: {}, pivot: {} }, { board: {}, markdown: '# x' },
    { pivot: {}, rsvp: {}, board: {} }
  ];

  for (const shape of SHAPES) {
    it('agrees for ' + JSON.stringify(shape), () => {
      assert.equal(Migrations.kindOf(shape), legacy(shape));
    });
  }

  it('the chain in app-core.js still looks the way this test reproduces it', () => {
    // If someone reorders or extends that chain, this derivation silently stops matching it. Cheap
    // guard: the fallback branches must still appear in the same order in the source.
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const order = ['isCalendarView', 'isRotationView', 'isPivotView', 'isRsvpView', 'isBoardView'];
    const at = order.map((n) => src.indexOf('if (this.' + n + ')'));
    assert.ok(at.every((i) => i > 0), 'the fallback chain moved; re-check kindOf against it');
    assert.deepEqual(at.slice().sort((a, b) => a - b), at, 'the fallback chain was reordered');
  });
});

describe('migrations — every schema shipped in this repo survives it', () => {
  const bundles = [];
  const add = (p) => { if (fs.existsSync(p)) bundles.push(p); };
  add(path.join(ROOT, 'dev', 'data', 'schema.json'));
  add(path.join(ROOT, 'dev', 'schema.json'));
  const exDir = path.join(ROOT, 'examples');
  if (fs.existsSync(exDir)) {
    for (const f of fs.readdirSync(exDir)) if (f.endsWith('.json')) add(path.join(exDir, f));
  }

  it('found schemas to check', () => {
    assert.ok(bundles.length > 0, 'no schema files found — this suite would pass vacuously');
  });

  for (const file of bundles) {
    it(path.relative(ROOT, file).replace(/\\/g, '/') + ' migrates and every view gets a known kind', () => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const schema = raw.schema || raw;                 // bundles wrap it; schema.json does not
      if (!schema || !Array.isArray(schema.views)) return;   // nothing to migrate

      // What each view WOULD have rendered as, before migrating.
      const before = [];
      Migrations.eachView(schema.views, (v) => { if (v.name) before.push([v.name, Migrations.kindOf(v)]); });

      Migrations.migrate(schema);

      const after = [];
      Migrations.eachView(schema.views, (v) => { if (v.name) after.push([v.name, v.kind]); });
      assert.deepEqual(after, before, 'migrating changed what a view is');

      const KNOWN = ['calendar', 'rotation', 'pivot', 'rsvp', 'board', 'page', 'data'];
      for (const [name, kind] of after) {
        assert.ok(KNOWN.includes(kind), name + ' migrated to an unknown kind: ' + kind);
      }
    });
  }
});
