// callings-identity.test.js — the bishopric example's identity namespace is the WARD's positions, and
// it lives in the CATALOGUE rather than in a list beside it.
//
// `ref_callings` holds one row per (organization, calling) pair — which is what a ward position is —
// and each row is known by a HANDLE naming that pair. That handle is the namespace `@me`, the
// per-person card view and the per-person calendar feed all resolve through: an admin links a position
// to an account, and `_list_users` stores it under `{list: "ref_callings", value: <handle>}`.
//
// The handle is DERIVED from the row's own two dimensions, with the `slug` cell left as an override
// nothing currently uses. It began as data to be typed, which made the catalogue unusable: the column
// is hidden plumbing, the lookup editor renders a hierarchy as parent and value only, and a row added
// in the app carried no handle and could never be linked to anybody. Deriving it also means a
// catalogue that predates the handle needs no migration — which is the property this file pins.
//
// Three halves, and the last is the one worth having:
//
//   1. the namespace is coherent — one catalogue, no parallel list, every value labelled;
//   2. the columns draw on the right DIMENSION of it (a `valueCol` that silently fell back would
//      offer organizations where positions belong, which looks like a working picker);
//   3. a row assigned to a non-bishopric calling reaches that person's card, driven through the real
//      modules (Rows.buildRows -> Rows.aggregateRows -> Embeds.embedRowsForItem).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Rows = require('../../rows');
const Embeds = require('../../embeds');
const Columns = require('../../columns');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8'));
const doc = read('bishopric-schema.json');
const schema = doc.schema;
const catalogue = doc.tables.ref_callings;
// What the app will offer: every row, named the way Columns.rowHandle names it.
const handleOf = (r) => r.slug || (r.organization + '_' + r.calling);
const positions = catalogue.map(handleOf);
const view = schema.views.find((v) => v.name === 'admin_bishopric');

// Every column whose options come from one named namespace, with the dimension it asks for.
const drawnFrom = (list) => {
  const out = [];
  for (const [t, tv] of Object.entries(schema.tables))
    for (const c of tv.columns || [])
      if (c && c.list === list) out.push(t + '.' + c.name + ':' + (c.valueCol || '(default)'));
  return out.sort();
};

describe('one catalogue holds the organizations, the callings and the positions', () => {
  it('is the lookup itself that is user-linked — there is no list beside it', () => {
    assert.equal(schema.listSources.ref_callings, 'userlink-name');
    assert.equal(schema.listSources.callings, undefined);
    assert.equal(doc.lists.callings, undefined, 'a parallel vocabulary is the thing this removed');
    assert.ok(schema.translatableLists.includes('ref_callings'));
    assert.ok(Object.values(doc.lists).every((v) => !v.length), 'the example ships no populated list at all');
  });

  it('every row is named, and no two rows share a name', () => {
    assert.ok(positions.length > 20, 'the point of the change is that most of the ward is in here');
    // The uniqueness the handle exists for: `president` belongs to five organizations, so neither
    // dimension names a row on its own. Two rows sharing a handle is two people on one card.
    assert.equal(new Set(positions).size, positions.length);
    assert.ok(positions.includes('bishopric_bishop'), 'the bishopric must be in the catalogue');
    assert.ok(positions.includes('primary_president'));
    // Nothing is stored: the bundle ships NO handle cells, so every one of these is derived. A
    // deployment whose catalogue predates the handle gets the same values for the same reason.
    assert.deepEqual(catalogue.filter((r) => r.slug), [], 'a shipped override is data nobody can edit');
  });

  it('every identity column asks for the position dimension, and the organization column does not', () => {
    // A `valueCol` that went unread would fall back to the lookup's group dimension and offer
    // ORGANIZATIONS in a column meant to hold positions — a picker full of plausible wrong values.
    // Eight columns, one catalogue, two dimensions: the organization columns take the lookup's group
    // dimension (the default), the identity columns ask for `slug`. That one table now answers three
    // different questions is the whole reason `valueCol` had to become readable on a select.
    assert.deepEqual(drawnFrom('ref_callings'), [
      'admin_callings.organization:(default)', 'admin_callings.responsible:slug',
      'admin_interviews.responsible:slug', 'admin_reminders.responsible:slug',
      'admin_responsibilities.organization:(default)', 'admin_responsibilities.responsible:slug',
      'meeting_agenda.presiding:slug', 'meeting_agenda.responsible:slug'
    ]);
    // And the key is readable: a typo here is silent, so validateSchema checks it and so does this.
    for (const [, tv] of Object.entries(schema.tables))
      for (const c of tv.columns || [])
        if (c && c.valueCol && c.list)
          assert.ok(c.valueCol in Columns.columnDefs(schema.tables[c.list]),
            c.name + ' asks for a dimension "' + c.valueCol + '" the catalogue does not have');
  });

  it('every position is labelled in both language packs, under the catalogue namespace', () => {
    for (const [file, code] of [['bishopric-lang-fi.json', 'fi'], ['bishopric-lang-en.json', 'en']]) {
      const t = read(file).translations[code];
      for (const v of positions)
        assert.ok(t['list.ref_callings.' + v], code + ' has no label for ' + v + ' — a card headed by a slug');
      assert.equal(t['list.callings.bishop'], undefined, code + ' still carries the retired namespace');
      assert.equal(t['list.ref_callings.counselor1'], undefined, code + ' still labels a handle nothing derives');
    }
  });

  it('keeps presiding a select, so its visitor toggle survives', () => {
    // This is why the identity columns stayed `select` with a `valueCol` rather than becoming `ref`:
    // `listSwitch` is a select-only feature, and a visiting authority is not a ward position.
    const presiding = schema.tables.meeting_agenda.columns.find((c) => c.name === 'presiding');
    assert.equal(presiding.type, 'select');
    assert.equal(presiding.listSwitch.list, 'visitors');
  });
});

describe('a calling outside the bishopric reaches its own card', () => {
  const cache = {
    meeting_agenda: [
      { id: 'm1', date: '2026-03-01', theme: 'Faith', presiding: 'bishopric_bishop', responsible: 'primary_president' },
      { id: 'm2', date: '2026-04-01', theme: 'Visit', presiding: 'Visiting Seventy', responsible: '' }
    ],
    admin_callings: [{ id: 'c1', date: '2026-02-01', person: 'Ann', organization: 'primary', calling: 'teacher',
                       status: 'under_discussion', responsible: 'primary_president' }],
    admin_interviews: [{ id: 'i1', meeting: 'Sun', person: 'Bo', topic: 'temple', responsible: 'primary_president' }],
    admin_reminders: [{ id: 'r1', date: '2026-02-10', item: 'Order manuals', person: 'Cy', responsible: 'primary_president' }],
    admin_responsibilities: [
      { id: 'p1', organization: 'primary', responsible: 'primary_president' },
      { id: 'p2', organization: 'music', responsible: 'ward_executive_secretary' },
      { id: 'p3', organization: 'sunday_school', responsible: '' }
    ]
  };

  // `visitors` is a plain list and IS cached; the catalogue is not, which is exactly why the view's
  // filter says `notEmpty` for the picker-only column and names the visitors list for the other.
  const withLists = (fn) => {
    globalThis._listsCache = { visitors: ['Visiting Seventy'] };
    try { return fn(); } finally { delete globalThis._listsCache; }
  };
  const cards = () => withLists(() => Rows.aggregateRows(view, Rows.buildRows(view, cache)));

  it('gets a card of her own, and so does a ward officer who is not in the bishopric', () => {
    const keys = cards().map((c) => c.callings);
    assert.ok(keys.includes('primary_president'), 'the Primary president got no card — the whole point');
    assert.ok(keys.includes('ward_executive_secretary'), 'only presidencies would be a narrower tool, not a ward one');
    assert.ok(keys.includes('bishopric_bishop'), 'the bishopric must not lose what it already had');
    assert.ok(!keys.includes(''), 'an unassigned row must not mint a card for nobody');
    assert.ok(!keys.includes('Visiting Seventy'), 'a visiting authority is not a ward position');
  });

  it('and her card carries every kind of responsibility, sliced by the block filters', () => {
    const card = cards().find((c) => c.callings === 'primary_president');
    withLists(() => {
      const blocks = view.columns.filter((c) => c && typeof c === 'object');
      const seen = blocks.map((b) => {
        const ei = { kind: 'data', config: b, rows: Rows.buildRows(b, cache) };
        return [b.sources[0] + ':' + Object.keys(b.filterBy)[0], Embeds.embedRowsForItem(ei, card).length];
      });
      assert.deepEqual(seen, [
        ['meeting_agenda:presiding', 0], ['meeting_agenda:responsible', 1], ['admin_callings:responsible', 1],
        ['admin_interviews:responsible', 1], ['admin_reminders:responsible', 1], ['admin_responsibilities:responsible', 1]
      ]);
    });
  });

  it('and nothing belonging to somebody else', () => {
    const card = cards().find((c) => c.callings === 'primary_president');
    withLists(() => {
      const block = view.columns.find((c) => c && c.sources && c.sources[0] === 'admin_responsibilities');
      const ei = { kind: 'data', config: block, rows: Rows.buildRows(block, cache) };
      assert.deepEqual(Embeds.embedRowsForItem(ei, card).map((r) => r.id), ['p1']);
    });
  });
});
