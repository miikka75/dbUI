// chore-cadence.test.js — the chores example's `chore_cadence` view, driven end-to-end.
//
// This is the shipped demonstration of both halves of a per-chore cadence. A goal each ROW carries:
// `goal: { column: "target" }`, where `target` is a computed lookup of that chore's own
// `ref_chores.target_per_month` -- every other stats view measures its tiles against one number, so
// "bedding once a month" and "wash up daily" could not live in one view before it. And the tiles that
// were never there: `groupBy.seed` takes the key set from the catalogue `chore` references rather than
// from the log rows, so a chore nobody has done is an empty bar at the top rather than no bar at all,
// with `skipUntargeted` dropping the rows nobody set a cadence for.
//
// It is tested against the REAL schema and the REAL seed data rather than a fixture, because what
// breaks here breaks silently. The target is resolved by name through three files — the column in
// ref_chores, the `computed.lookup` in the view, and the `goal.column` in the stats block — and any
// one of them renamed leaves a view that still loads, still lists every chore, and quietly draws no
// bars at all. There is no error and no empty screen to notice.
//
// The date filter is dropped rather than resolved: `within: "@month"` is relative to today and the
// seed dates are fixed (see dev/seed-import.js), so keeping it would make this pass or fail by the
// calendar. The period token is orthogonal to what this proves and is covered in rows/query tests.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Rows = require('../../rows');
const Stats = require('../../stats');
const Columns = require('../../columns');
const SchemaNormalize = require('../../schema-normalize');

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const read = (f) => JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));
const schema = read('chores-schema.json');
const data = read('chores-data.json');

const findView = (views, name) => {
  for (const v of views || []) {
    if (v.name === name) return v;
    const hit = findView(v.views, name);
    if (hit) return hit;
  }
  return null;
};

const view = JSON.parse(JSON.stringify(findView(schema.views, 'chore_cadence')));
delete view.filter.done_on;

// `groupBy.seed` reads the key set off the `chore` column's own `ref` declaration, through the
// SCHEMA-bound resolver app-core defines as a global. Bound here from the REAL chores schema, run
// through the app's own normalizer, so what this proves is that the declaration and the view agree.
const tables = SchemaNormalize.normalize(JSON.parse(JSON.stringify(schema))).tables;
globalThis.getColumnRef = (t, col) => Columns.columnRef(tables, t, col);

const cache = { chore_log: data.tables.chore_log, ref_chores: data.tables.ref_chores };
// The pipeline app-core runs for an aggregate view, in its order: source rows, group them, then
// resolve the view's own computeds over the GROUPED rows — which is what makes `target` one lookup
// per chore rather than one per log entry. ONE context for all of it: the computeds resolve their
// lookups out of it, and the seeded groupBy reads ref_chores from the same cache.
const ctx = { dataCache: cache };
const rows = Rows.resolveComputed(Rows.aggregateRows(view, Rows.buildRows(view, cache, 'active'), ctx), view.columns, ctx);
const tiles = Stats.build(rows, view.stats).tiles;
const byChore = Object.fromEntries(tiles.map((t) => [t.label, t]));

describe('chore_cadence — the shipped per-row goal, over a seeded key set', () => {
  it('every chore in the catalogue declares a monthly target', () => {
    // The lookup has a `default: 0`, so a chore missing one would render a bar-less tile rather than
    // anything that looks wrong. The catalogue is the thing that has to stay complete.
    for (const c of data.tables.ref_chores) {
      assert.equal(typeof c.target_per_month, 'number', c.chore + ' has no target_per_month');
      assert.ok(c.target_per_month > 0, c.chore + ' has a non-positive target');
    }
  });

  it('each tile is measured against ITS OWN target, resolved from ref_chores', () => {
    const target = Object.fromEntries(data.tables.ref_chores.map((c) => [c.chore, c.target_per_month]));
    for (const t of tiles) assert.equal(t.goal, target[t.label], t.label);
    // The point of the feature, stated as the contrast that motivated it: two tiles in one view on
    // completely different scales. A single `goal` could express neither of these next to the other.
    assert.deepEqual([byChore['Change bedding'].value, byChore['Change bedding'].goal], [1, 1]);
    assert.deepEqual([byChore['Wash up'].value, byChore['Wash up'].goal], [2, 30]);
    assert.equal(byChore['Change bedding'].pct, 100);   // a month's bedding: done
    assert.equal(byChore['Wash up'].pct, 7);            // twice out of thirty: barely started
  });

  it('reads worst-first, which is what makes it a reminder rather than a scoreboard', () => {
    // The view declares order: "behind". Without it the tiles arrive ranked by raw count, where the
    // chore done twice leads the chore done once -- true, and useless, when the two are on different
    // cadences. Asserted as a monotonic ratio rather than a fixed list of chores so that editing the
    // seed data does not falsely fail this.
    const ratios = tiles.filter((t) => t.goal !== null).map((t) => t.value / t.goal);
    assert.deepEqual(ratios, ratios.slice().sort((a, b) => a - b), tiles.map((t) => t.label).join(' < '));
    assert.ok(byChore['Empty dishwasher'].pct < byChore['Change bedding'].pct);
    // The head of the page is now a SEEDED chore -- nothing done at all is a ratio of 0, which is what
    // the two halves were built to put there. 'Empty dishwasher' (1 of 30) leads the rest.
    assert.equal(tiles[0].value, 0);
    const started = tiles.filter((t) => t.value > 0);
    assert.equal(started[0].label, 'Empty dishwasher');
  });

  it('a chore nobody logged is a zero bar, not an absence', () => {
    // The other half, and the whole point of it: `aggregateRows` used to build its groups from the rows
    // it was handed, so a chore with no approved log rows had no group and no tile — and that is
    // exactly the chore a reminder exists for. `groupBy.seed` takes the key set from `ref_chores`
    // instead, which the `chore` column already references, so every chore gets a tile and the
    // neglected ones are the ones that lead.
    const logged = new Set(data.tables.chore_log.filter((r) => r.status === 'approved').map((r) => r.chore));
    const missing = data.tables.ref_chores.map((c) => c.chore).filter((c) => !logged.has(c));
    assert.ok(missing.length > 0, 'the seed no longer demonstrates the case');
    assert.equal(tiles.length, data.tables.ref_chores.length);   // one tile per chore, logged or not
    for (const c of missing) {
      assert.equal(byChore[c].value, 0, c);
      assert.equal(byChore[c].pct, 0, c);                        // an empty bar, measured against its own target
      assert.ok(byChore[c].goal > 0, c);
    }
    // They lead, because nothing done is the least of your own goal there is.
    assert.deepEqual(tiles.slice(0, missing.length).map((t) => t.label).sort(), missing.slice().sort());
  });

  it('a chore with no target keeps no tile, which is how the catalogue retires one', () => {
    // `skipUntargeted` is the gate that makes the seeded set self-maintaining: clearing the target in
    // the Lookup tab drops the chore off the page, with no schema edit. Driven over a COPY of the
    // catalogue rather than the shipped one, which is complete on purpose (asserted above).
    const retired = { ...cache, ref_chores: cache.ref_chores.map((c) => (c.chore === 'Hoover' ? { ...c, target_per_month: '' } : c)) };
    const rctx = { dataCache: retired };
    const rrows = Rows.resolveComputed(Rows.aggregateRows(view, Rows.buildRows(view, retired, 'active'), rctx), view.columns, rctx);
    const labels = Stats.build(rrows, view.stats).tiles.map((t) => t.label);
    assert.ok(!labels.includes('Hoover'), labels.join(' | '));
    assert.equal(labels.length, tiles.length - 1);
    // Without the gate it would still be there — as a bar-less tile that looks like a chore nobody
    // has got to yet, which is the opposite of what clearing its target meant.
    const kept = Stats.build(rrows, { rowTiles: { ...view.stats.rowTiles, skipUntargeted: false } }).tiles;
    assert.ok(kept.some((t) => t.label === 'Hoover' && t.goal === null));
  });
});
