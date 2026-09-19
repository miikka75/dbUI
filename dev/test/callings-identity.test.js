// callings-identity.test.js — the bishopric example's identity namespace is the WARD's positions, not
// the bishopric's three.
//
// `lists.callings` (marked `userlink-name`) is what `@me`, the `matchList` filters, the per-person card
// view and the per-person calendar feed all resolve through: an admin links each position to an
// account, and every "what am I responsible for" answer is a lookup in that namespace. Widening it from
// three roles to every single-holder ward position is what makes this a ward tool rather than a
// bishopric one.
//
// Two halves, and the second is the one worth having:
//
//   1. the namespace is COHERENT — it agrees with the `ref_callings` catalogue, every column that
//      carries an identity points at it, and every value has a label in both language packs;
//   2. a row assigned to a non-bishopric calling actually REACHES that person's card, driven through
//      the real modules (Rows.buildRows -> Rows.aggregateRows -> Embeds.embedRowsForItem).
//
// (2) breaks silently. Every filter in this view is a `matchList` against the namespace, and
// `condMatches` fails CLOSED when the list is missing a value — so a position left out of the list, or
// a column still pointing at the old one, renders a permanently empty card rather than an error.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Rows = require('../../rows');
const Embeds = require('../../embeds');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', f), 'utf8'));
const doc = read('bishopric-schema.json');
const schema = doc.schema;
const callings = doc.lists.callings;
const view = schema.views.find((v) => v.name === 'admin_bishopric');

// Every column in the schema whose `list:` (or dual-list `listSwitch.list`) names one thing.
const columnsNaming = (list) => {
  const out = [];
  for (const [t, tv] of Object.entries(schema.tables))
    for (const c of tv.columns || [])
      if (c && (c.list === list || (c.listSwitch && c.listSwitch.list === list))) out.push(t + '.' + c.name);
  return out.sort();
};

describe('the identity namespace is the ward, not the bishopric', () => {
  it('is a userlink-name list, and the bishopric namespace is gone from every declaration', () => {
    assert.equal(schema.listSources.callings, 'userlink-name');   // values are positions; the cell shows who holds one
    assert.equal(schema.listSources.bishopric, undefined);
    assert.equal(doc.lists.bishopric, undefined);
    assert.ok(schema.translatableLists.includes('callings'), 'a position nobody can read is a position nobody can fill');
    assert.ok(!schema.translatableLists.includes('bishopric'));
  });

  it('every column that carries an identity points at it — none left behind', () => {
    // The six the example assigns work through. A column still naming `bishopric` would not error:
    // its picker would simply offer an empty list.
    assert.deepEqual(columnsNaming('callings'), [
      'admin_callings.responsible', 'admin_interviews.responsible', 'admin_reminders.responsible',
      'admin_responsibilities.responsible', 'meeting_agenda.presiding', 'meeting_agenda.responsible'
    ]);
    assert.deepEqual(columnsNaming('bishopric'), []);
  });

  it('holds more than the bishopric, and every value is a position the catalogue knows', () => {
    const pairs = new Set(doc.tables.ref_callings.map((r) => r.organization + '_' + r.calling));
    const LEGACY = ['bishop', 'counselor1', 'counselor2'];   // kept verbatim so no live row needs rewriting
    const derived = callings.filter((v) => !LEGACY.includes(v));

    assert.ok(derived.length > 20, 'the point of the change is that most of the ward is in here');
    for (const v of LEGACY) assert.ok(callings.includes(v), v + ' must survive the widening');
    // Nothing invented: a value that drifted from the catalogue would offer a position no calling can
    // be recorded against, and `admin_callings` is where a calling to it gets recorded.
    for (const v of derived) assert.ok(pairs.has(v), v + ' names no row in ref_callings');
    // And the catalogue gained the bishopric itself, which is what makes it the whole ward.
    assert.ok(pairs.has('bishopric_bishop'), 'a calling TO the bishopric could not be recorded');
  });

  it('every position is labelled in both language packs', () => {
    for (const [file, code] of [['bishopric-lang-fi.json', 'fi'], ['bishopric-lang-en.json', 'en']]) {
      const t = read(file).translations[code];
      for (const v of callings)
        assert.ok(t['list.callings.' + v], code + ' has no label for ' + v + ' — a card headed by a slug');
      assert.equal(t['list.bishopric.bishop'], undefined, code + ' still carries the retired namespace');
    }
  });
});

describe('a calling outside the bishopric reaches its own card', () => {
  // One row per source table, all assigned to the Primary president, plus one assigned elsewhere and
  // one assigned to nobody — the two that must NOT land on her card.
  const cache = {
    meeting_agenda: [{ id: 'm1', date: '2026-03-01', theme: 'Faith', presiding: 'bishop', responsible: 'primary_president' }],
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

  const withLists = (fn) => {
    globalThis._listsCache = { callings: callings };
    try { return fn(); } finally { delete globalThis._listsCache; }
  };
  const cards = () => withLists(() => Rows.aggregateRows(view, Rows.buildRows(view, cache)));

  it('gets a card of her own, and so does a ward officer who is not in the bishopric', () => {
    const keys = cards().map((c) => c.callings);
    assert.ok(keys.includes('primary_president'), 'the Primary president got no card — the whole point');
    assert.ok(keys.includes('ward_executive_secretary'), 'only presidencies would be a narrower tool, not a ward one');
    assert.ok(keys.includes('bishop'), 'the bishopric must not lose what it already had');
    assert.ok(!keys.includes(''), 'an unassigned row must not mint a card for nobody');
  });

  it('and her card carries every kind of responsibility, sliced by the block filters', () => {
    const card = cards().find((c) => c.callings === 'primary_president');
    withLists(() => {
      const blocks = view.columns.filter((c) => c && typeof c === 'object');
      const seen = blocks.map((b) => {
        const ei = { kind: 'data', config: b, rows: Rows.buildRows(b, cache) };
        return [b.sources[0] + ':' + Object.keys(b.filterBy)[0], Embeds.embedRowsForItem(ei, card).length];
      });
      // Five tables, six blocks (the agenda appears twice — presiding and responsible are different
      // questions about the same meeting). She is `responsible` on five of them and presides at none.
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
