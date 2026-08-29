const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Columns = require('../../columns');

// Schema (tables map) with the image/url column types alongside the existing ones.
const schema = {
  gallery: { columns: {
    title: { type: 'text' },
    photo: { type: 'image' },
    link:  { type: 'url' },
    when:  { type: 'date' }
  } },
  other: { columns: { tags: { type: 'multiselect', list: 'tags' }, points: { type: 'number' } } },
  tasks: { columns: {
    status: { type: 'select', list: 'status', picker: 'chips' },
    prio:   { type: 'select', list: 'prio', picker: 'toggle' },
    owner:  { type: 'select', list: 'people' }   // no picker -> dropdown
  } }
};

describe('columns.js — image/url column scanners', () => {
  it('colIsImage / colIsUrl detect the new types (any-table, memoized scan)', () => {
    assert.equal(Columns.colIsImage(schema, 'photo'), true);
    assert.equal(Columns.colIsUrl(schema, 'link'), true);
    assert.equal(Columns.colIsImage(schema, 'link'), false);
    assert.equal(Columns.colIsUrl(schema, 'photo'), false);
  });

  it('does not confuse image/url with other types', () => {
    assert.equal(Columns.colIsImage(schema, 'title'), false);
    assert.equal(Columns.colIsUrl(schema, 'when'), false);
    assert.equal(Columns.colIsDate(schema, 'when'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'tags'), true);
    assert.equal(Columns.colIsImage(schema, 'tags'), false);
  });

  it('colIsNumber detects `number` by column name across tables (a view has no schema entry of its own)', () => {
    assert.equal(Columns.colIsNumber(schema, 'points'), true);
    assert.equal(Columns.colIsNumber(schema, 'title'), false);
    assert.equal(Columns.colIsNumber(schema, 'when'), false);
    assert.equal(Columns.colIsNumber(schema, 'nope'), false);   // unknown column -> false, no throw
  });

  it('colPicker returns a select column\'s widget choice (chips/toggle), else null', () => {
    assert.equal(Columns.colPicker(schema, 'status'), 'chips');
    assert.equal(Columns.colPicker(schema, 'prio'), 'toggle');
    assert.equal(Columns.colPicker(schema, 'owner'), null);   // default dropdown
    assert.equal(Columns.colPicker(schema, 'nope'), null);
  });

  // columnRef's `null` table is the any-table scan its sibling columnList already had. The point of
  // pinning it here is the EQUIVALENCE: it must answer exactly what the `for (var t in SCHEMA)` loop
  // it replaced answered, including first-table-wins, or a ref cell resolves its lookup elsewhere.
  it('columnRef(schema, null, col) matches the any-table loop it replaces', () => {
    const s = {
      events: { columns: { date: { type: 'date' } } },
      a:      { columns: { link: { type: 'ref', table: 'events', valueCol: 'date' }, plain: 'text' } },
      b:      { columns: { link: { type: 'ref', table: 'other', valueCol: 'x' } } },
      other:  { columns: { x: 'text' } }
    };
    const loop = (col) => { for (const t in s) { const r = Columns.columnRef(s, t, col); if (r) return r; } return null; };
    ['link', 'plain', 'date', 'nope'].forEach((col) => assert.deepEqual(Columns.columnRef(s, null, col), loop(col), col));
    assert.equal(Columns.columnRef(s, null, 'link').table, 'events');   // first table wins, as the loop did
    assert.equal(Columns.columnRef(s, null, 'plain'), null);            // not a ref -> null, not undefined
    assert.equal(Columns.columnRef(s, null, 'nope'), null);             // unknown column -> null, no throw
  });

  it('colIsRef and columnRef(null) agree — they are read together on the per-cell path', () => {
    const s = { t: { columns: { r: { type: 'ref', table: 'u' }, s: 'ref', n: 'text' } }, u: { columns: { n: 'text' } } };
    ['r', 's', 'n'].forEach((c) => assert.equal(Columns.colIsRef(s, c), !!Columns.columnRef(s, null, c), c));
    assert.equal(Columns.colIsRef(s, 's'), false);   // a bare 'ref' STRING is not a ref, in both
  });

  it('tableRefCol finds a table\'s ref column pointing at a target table', () => {
    const s = {
      events: { columns: { date: { type: 'date' } } },
      resp:   { columns: { owner: { type: 'owner' }, link: { type: 'ref', table: 'events', valueCol: 'date' }, note: { type: 'text' } } }
    };
    assert.deepEqual(Columns.tableRefCol(s, 'resp', 'events'), { name: 'link', valueCol: 'date' });
    assert.equal(Columns.tableRefCol(s, 'resp', 'nope'), null);   // no ref to that table
    assert.equal(Columns.tableRefCol(s, 'events', 'resp'), null); // events has no ref column
  });

  it('unknown column falls through to the empty info (no throw)', () => {
    assert.equal(Columns.colIsImage(schema, 'nope'), false);
    assert.equal(Columns.colIsUrl(schema, 'nope'), false);
    assert.equal(Columns.columnType(schema, 'gallery', 'photo'), 'image');
  });
});

describe('columns.js — tableDefaultCols (seed-on-create columns)', () => {
  const schema = {
    log: { columns: {
      person: { type: 'select', list: 'members', defaultFrom: '@me' },
      status: { type: 'select', list: 'st', default: 'logged' },
      count:  { type: 'number', default: 0 },
      flag:   { type: 'text', default: '' },
      plain:  { type: 'text' },
      both:   { type: 'text', defaultFrom: '@me', default: 'ignored' }
    } },
    bare: { columns: { a: 'text' } }
  };

  it('reports the token columns and the literal ones, distinguished by shape', () => {
    const byName = Object.fromEntries(Columns.tableDefaultCols(schema, 'log').map(d => [d.name, d]));
    assert.deepEqual(byName.person, { name: 'person', from: '@me' });
    assert.deepEqual(byName.status, { name: 'status', value: 'logged' });
  });

  it('falsy literals are defaults too — 0 and "" are values, not "unset"', () => {
    const byName = Object.fromEntries(Columns.tableDefaultCols(schema, 'log').map(d => [d.name, d]));
    assert.deepEqual(byName.count, { name: 'count', value: 0 });
    assert.deepEqual(byName.flag, { name: 'flag', value: '' });
  });

  it('a column with neither is absent; the token wins when both are set', () => {
    const names = Columns.tableDefaultCols(schema, 'log').map(d => d.name);
    assert.equal(names.includes('plain'), false);
    assert.deepEqual(Columns.tableDefaultCols(schema, 'log').find(d => d.name === 'both'), { name: 'both', from: '@me' });
  });

  it('a table with no defaults, or no such table, yields []', () => {
    assert.deepEqual(Columns.tableDefaultCols(schema, 'bare'), []);
    assert.deepEqual(Columns.tableDefaultCols(schema, 'nope'), []);
  });
});

// --- The two column shapes -----------------------------------------------------------------------
// `columns` ships as the AUTHORED array of {name,...} defs and as the RUNTIME name->def map, and every
// reader that walks a table's columns used to branch on which one it held -- eleven sites, five of them
// character-for-character identical, which is how the shapes drifted apart in the first place (the
// rules mirrors refused a bare-string `owner`, the client accepted one). These are that branch.
describe('columns.js — the two column shapes', () => {
  const arrayShape = { columns: [
    { name: 'title', type: 'text' },
    { name: 'mine', type: 'owner' },
    { name: 'note' },                                    // a def carrying nothing but its name
    { type: 'text' }                                     // no name -> not a column at all
  ] };
  const mapShape = { columns: {
    title: { type: 'text' },
    mine:  { type: 'owner' },
    note:  'text'
  } };

  it('columnDefs reads both shapes, keyed by name', () => {
    assert.deepEqual(Object.keys(Columns.columnDefs(arrayShape)), ['title', 'mine', 'note']);
    assert.deepEqual(Object.keys(Columns.columnDefs(mapShape)), ['title', 'mine', 'note']);
    assert.equal(Columns.columnDefs(arrayShape).mine.type, 'owner');
    assert.equal(Columns.columnDefs(mapShape).mine.type, 'owner');
  });

  it('preserves the authored order, so "the first column that ..." means the same in both', () => {
    const arr = { columns: [{ name: 'b', type: 'owner' }, { name: 'a', type: 'owner' }] };
    assert.deepEqual(Columns.columnDefList(arr).map(d => d.name), ['b', 'a']);
    assert.equal(Columns.ownerColOf(arr), 'b');
  });

  it('the map shape is returned as-is (hot paths must not pay for a copy)', () => {
    assert.equal(Columns.columnDefs(mapShape), mapShape.columns);
  });

  it('a missing table, a table with no columns, and null are all empty — never a throw', () => {
    assert.deepEqual(Columns.columnDefs(undefined), {});
    assert.deepEqual(Columns.columnDefList(null), []);
    assert.deepEqual(Columns.columnDefList({}), []);
    assert.equal(Columns.ownerColOf(undefined), null);
  });

  it('ownerColOf finds the owner column in either shape, and null when there is none', () => {
    assert.equal(Columns.ownerColOf(arrayShape), 'mine');
    assert.equal(Columns.ownerColOf(mapShape), 'mine');
    assert.equal(Columns.ownerColOf({ columns: { a: { type: 'text' } } }), null);
  });

  it('a BARE-STRING def is never the owner column — the mirrors have always refused one', () => {
    // BackendHelpers.ownerTablesOf (what firestore.rules and the RLS policies read) counts object defs
    // only. A client that disagreed would offer self-service on a table the store denies at write time,
    // so the two agree here, fail-closed.
    const bare = { columns: { mine: 'owner' } };
    assert.equal(Columns.ownerColOf(bare), null);
    assert.equal(Columns.tableOwnerCol({ t: bare }, 't'), null);
  });

  it('tableOwnerCol is ownerColOf bound to a schema, and tolerates a missing table', () => {
    assert.equal(Columns.tableOwnerCol({ t: arrayShape }, 't'), 'mine');
    assert.equal(Columns.tableOwnerCol({ t: mapShape }, 't'), 'mine');
    assert.equal(Columns.tableOwnerCol({}, 'nope'), null);
  });
});

// A source guard, like rules-parity's: re-implementing the branch would not fail any behavioural test.
// It would just quietly become a twelfth answer to the same question, which is how the shapes drifted
// apart the first time.
describe('columns.js — nothing re-implements the shape branch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..', '..');
  // Every shipped module that reads a table's columns. columns.js itself is where the branch belongs.
  const FILES = ['backend-firebase.js', 'backend-kv.js', 'backend-helpers.js', 'list-access.js',
                 'migrations.js', 'schema-normalize.js', 'app-core.js', 'rows.js', 'embeds.js',
                 'dev/server.js', 'dev/backend-local.js', 'dev/schema.js'];

  it('the array-or-map conversion appears only in columns.js', () => {
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
      assert.doesNotMatch(src, /Array\.isArray\(cols\)\s*\?\s*cols\s*:\s*Object\.keys\(cols\)/,
        rel + ': use Columns.columnDefs / Columns.columnDefList');
    }
  });

  it('nobody hand-rolls an owner-column scan either', () => {
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
      assert.doesNotMatch(src, /c\.type === 'owner'\s*\)\s*;\s*return o \? o\.name : null/,
        rel + ': use Columns.ownerColOf');
    }
  });
});
