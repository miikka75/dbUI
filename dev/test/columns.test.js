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
// A lookup's parent/child shape. Three places used to answer this question independently and two of
// them disagreed: the Lookup editor required EXACTLY two author-facing columns, the board's ref lane
// accepted any number. A lookup that grew a third column therefore kept its board lanes and silently
// lost its hierarchy in the editor -- a flat grid, no error, and nothing in the schema to point at,
// because no schema could SAY the table was hierarchical.
describe('columns.js — a lookup declares its hierarchy, and one function answers it', () => {
  // The shipped shape: two author-facing columns, `position` and the timestamps hidden.
  const callings = { isLookup: true, reorderable: true, columns: [
    { name: 'organization', type: 'text' }, { name: 'calling', type: 'text' },
    { name: 'position', type: 'number', hidden: true },
    { name: 'created_at', type: 'text', hidden: true }, { name: 'updated_at', type: 'text', hidden: true }
  ] };

  it('infers the historical shape, so a schema written before the declaration is unchanged', () => {
    assert.deepEqual(Columns.lookupCols(callings), ['organization', 'calling']);
    assert.deepEqual(Columns.lookupHierarchy(callings), { parent: 'organization', value: 'calling' });
  });

  it('a third column flattens an UNDECLARED lookup -- the behaviour preserved, not the bug kept', () => {
    // Left inferring, this is what the editor has always done. The declaration below is the way out;
    // changing the inference instead would re-render every deployed lookup on somebody else's guess.
    const withNote = { isLookup: true, columns: callings.columns.concat([{ name: 'note', type: 'text' }]) };
    assert.equal(Columns.lookupHierarchy(withNote), null);
  });

  it('the declaration survives the third column, and both screens read the same one', () => {
    const declared = { isLookup: true, hierarchy: { parent: 'organization', value: 'calling' },
                       columns: callings.columns.concat([{ name: 'note', type: 'text' }]) };
    // The editor asks with no hint; a board ref lane asks with its `valueCol`. Same answer, which is
    // the whole invariant: the matrix, the lanes and the editor cannot disagree about the group.
    assert.deepEqual(Columns.lookupHierarchy(declared), { parent: 'organization', value: 'calling' });
    assert.deepEqual(Columns.lookupHierarchy(declared, null, 'calling'), { parent: 'organization', value: 'calling' });
  });

  it('`hierarchy: false` says flat -- a value and its attribute, not a group and its members', () => {
    // ref_chores is `chore` + `points`. Two columns, so the inference calls it a hierarchy and the
    // editor renders every chore as a GROUP whose one child is a number. Only the table can say
    // otherwise: nothing about the shape distinguishes it from organization + calling.
    const chores = { isLookup: true, hierarchy: false,
                     columns: [{ name: 'chore', type: 'text' }, { name: 'points', type: 'number' }] };
    assert.equal(Columns.lookupHierarchy(chores), null);
    assert.equal(Columns.lookupHierarchy(chores, null, 'points'), null);   // a ref lane honours it too
  });

  it('a ref lane hint names the child; a ref with no valueCol still takes the last column', () => {
    const three = { isLookup: true, columns: [
      { name: 'phase', type: 'text' }, { name: 'code', type: 'text' }, { name: 'status', type: 'text' } ] };
    assert.deepEqual(Columns.lookupHierarchy(three, null, 'status'), { parent: 'phase', value: 'status' });
    assert.deepEqual(Columns.lookupHierarchy(three, null, null), { parent: 'phase', value: 'status' });
    assert.equal(Columns.lookupHierarchy(three), null);                    // no hint, three columns -> flat
  });

  it('a one-column lookup has no group dimension', () => {
    assert.equal(Columns.lookupHierarchy({ isLookup: true, columns: [{ name: 'thing', type: 'text' }] }, null, null), null);
  });

  it('authored column ORDER decides the parent, not the map key order', () => {
    const map = { isLookup: true, columns: { calling: { type: 'text' }, organization: { type: 'text' } } };
    assert.deepEqual(Columns.lookupHierarchy(map), { parent: 'calling', value: 'organization' });
    // ...and an explicit order (the browser's _columnOrders) wins over both.
    assert.deepEqual(Columns.lookupHierarchy(map, ['organization', 'calling']), { parent: 'organization', value: 'calling' });
  });

  describe('buildHierarchy', () => {
    const h = { parent: 'organization', value: 'calling' };
    const rows = [{ id: 'a', organization: 'ward', calling: 'clerk' },
                  { id: 'b', organization: 'music', calling: 'chorister' },
                  { id: 'c', organization: 'ward', calling: 'secretary' }];

    it('groups rows in row order, with the row on the child and never on the group', () => {
      const t = Columns.buildHierarchy(rows, h);
      assert.deepEqual(t.map((n) => n.value), ['ward', 'music']);
      assert.equal(t[0].row, null);                                  // a group is a value rows carry
      assert.deepEqual(t[0].children.map((c) => c.row.id), ['a', 'c']);
      assert.deepEqual(t[0].children.map((c) => c.value), ['clerk', 'secretary']);
      assert.deepEqual(t[0].children[0].children, []);               // depth 2 today: children are leaves
    });

    it('keeps `position` order even when the group values look like numbers', () => {
      // The map this replaces could not: an object iterates integer-like keys first and ascending, so
      // a lookup grouped by year came back 2024, 2025 however the arrows had been used.
      const years = [{ id: 'y1', organization: '2025', calling: 'a' }, { id: 'y2', organization: '2024', calling: 'b' }];
      assert.deepEqual(Columns.buildHierarchy(years, h).map((n) => n.value), ['2025', '2024']);
      assert.deepEqual(Object.keys({ 2025: 1, 2024: 1 }), ['2024', '2025']);   // what the old shape did
    });

    it('a missing group value is its own group, not a dropped row', () => {
      const t = Columns.buildHierarchy([{ id: 'x', calling: 'parked' }], h);
      assert.deepEqual(t.map((n) => n.value), ['']);
      assert.equal(t[0].children[0].row.id, 'x');
    });

    it('a flat lookup builds no tree at all', () => {
      assert.deepEqual(Columns.buildHierarchy(rows, null), []);
    });
  });
});

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

  it('nobody re-derives which lookup column is the parent', () => {
    // The exact line that used to live in app-core's board ref lane, beside the editor's own
    // incompatible answer. Ask Columns.lookupHierarchy -- that disagreement is the bug it exists for.
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
      assert.doesNotMatch(src, /cols\[0\] === childCol \? cols\[1\] : cols\[0\]/,
        rel + ': use Columns.lookupHierarchy');
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
