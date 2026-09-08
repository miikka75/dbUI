// chore-cadence.test.js — the chores example's `chore_cadence` view, driven end-to-end.
//
// This is the shipped demonstration of a goal each ROW carries: `goal: { column: "target" }`, where
// `target` is a computed lookup of that chore's own `ref_chores.target_per_month`. Every other stats
// view measures its tiles against one number, so "bedding once a month" and "wash up daily" could not
// live in one view before this.
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

const cache = { chore_log: data.tables.chore_log, ref_chores: data.tables.ref_chores };
// The pipeline app-core runs for an aggregate view, in its order: source rows, group them, then
// resolve the view's own computeds over the GROUPED rows — which is what makes `target` one lookup
// per chore rather than one per log entry.
const rows = Rows.resolveComputed(Rows.aggregateRows(view, Rows.buildRows(view, cache, 'active')), view.columns, { dataCache: cache });
const tiles = Stats.build(rows, view.stats).tiles;
const byChore = Object.fromEntries(tiles.map((t) => [t.label, t]));

describe('chore_cadence — the shipped per-row goal', () => {
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
    assert.equal(tiles[0].label, 'Empty dishwasher');   // 1 of 30: the least kept-up chore on the page
  });

  it('a chore nobody logged is absent, not a zero bar', () => {
    // Documented in ROADMAP.md as the half this feature does NOT fix: `aggregateRows` builds its groups
    // from the rows it is handed, so a chore with no approved log rows has no group and no tile — and
    // that is exactly the chore a reminder would exist for. Asserted so the day it changes is visible.
    const logged = new Set(data.tables.chore_log.filter((r) => r.status === 'approved').map((r) => r.chore));
    const missing = data.tables.ref_chores.map((c) => c.chore).filter((c) => !logged.has(c));
    assert.ok(missing.length > 0, 'the seed no longer demonstrates the gap');
    for (const c of missing) assert.equal(byChore[c], undefined, c);
  });
});
