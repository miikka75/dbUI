// column-deps.test.js — which OTHER tables a column needs loaded before it can resolve.
//
// The reason this derivation exists is a failure mode with no symptom. A ref dropdown, a lookup
// computed, a rotation column, its occurrence source and a mirror's master all read the row cache
// directly, and every one of them resolves to [] or undefined when the cache has no entry. Nothing
// throws; the dropdown is just empty and the cell is just blank. Today that never happens because boot
// loads every granted table — so this suite is the thing standing between that accident and a lazier
// boot, and it is asserted against the schemas actually shipped in the repo, not only toy ones.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Columns = require('../../columns');

describe('columns — defTables covers every shape that names another table', () => {
  const CASES = [
    ['ref column',          { type: 'ref', table: 'people' },                     ['people']],
    ['lookup computed',     { computed: { lookup: { table: 'chores', field: 'points' } } }, ['chores']],
    ['rotation column',     { computed: { rotationTable: 'roster' } },            ['roster']],
    ['occurrence source',   { computed: { occurrenceSource: 'turns' } },          ['turns']],
    ['mirror column',       { syncFrom: 'master' },                               ['master']],
    ['rotation + source',   { computed: { rotationTable: 'r', occurrenceSource: 's' } }, ['r', 's']]
  ];
  for (const [what, def, expected] of CASES) {
    it(what + ' -> ' + JSON.stringify(expected), () => {
      assert.deepEqual(Columns.defTables(def), expected);
    });
  }

  const NONE = [
    ['a plain string column',      'text'],
    ['a select column',            { type: 'select', list: 'members' }],
    ['a bare "ref" STRING',        'ref'],
    ['type ref with no table',     { type: 'ref' }],
    ['a non-ref carrying a table', { type: 'text', table: 'people' }],
    ['a computed with no table',   { computed: { daysSince: 'created_at' } }],
    ['null',                       null],
    ['undefined',                  undefined]
  ];
  for (const [what, def] of NONE) {
    it(what + ' needs nothing', () => assert.deepEqual(Columns.defTables(def), []));
  }

  it('a bare "ref" string is not a ref — matching columnRef, which is object-only', () => {
    // columns.js:columnRef requires an OBJECT with type 'ref'. If defTables disagreed, it would
    // request a table named by a column that the rest of the app does not treat as a ref at all.
    assert.deepEqual(Columns.defTables('ref'), []);
    assert.equal(Columns.columnRef({ t: { columns: { c: 'ref' } } }, 't', 'c'), null);
  });
});

describe('columns — tableDeps and entryTables', () => {
  const schema = {
    tasks: {
      columns: {
        who:    { type: 'ref', table: 'people' },
        points: { computed: { lookup: { table: 'chores', field: 'points' } } },
        self:   { type: 'ref', table: 'tasks' },      // self-reference
        dup:    { type: 'ref', table: 'people' },     // same table again
        plain:  'text'
      }
    }
  };

  it('unions a table\u2019s columns, deduped, in order of first appearance', () => {
    assert.deepEqual(Columns.tableDeps(schema, 'tasks'), ['people', 'chores']);
  });

  it('drops a self-reference — the caller already holds that table', () => {
    // Returning it would make a caller re-request the very table it is loading, which on Firestore is
    // a duplicated read of every document in it.
    assert.ok(!Columns.tableDeps(schema, 'tasks').includes('tasks'));
  });

  it('reads `columns` in BOTH shapes — a map and an array of defs', () => {
    // examples/bishopric-schema.json declares columns as an ARRAY of {name,...}. A derivation that only
    // understood the map form would report no dependencies for it at all — silently, and for exactly
    // the schema that has the most of them.
    const asArray = { m: { columns: [
      { name: 'date', type: 'date', syncFrom: 'agenda' },
      { name: 'who', type: 'ref', table: 'people' },
      { name: 'plain', type: 'text' }
    ] } };
    assert.deepEqual(Columns.tableDeps(asArray, 'm'), ['agenda', 'people']);
  });

  it('a missing table yields nothing rather than throwing', () => {
    assert.deepEqual(Columns.tableDeps(schema, 'nope'), []);
    assert.deepEqual(Columns.tableDeps({}, undefined), []);
  });

  it('entryTables unions a view\u2019s column entries, skipping plain names', () => {
    const entries = ['name', { name: 'who', type: 'ref', table: 'people' }, { name: 'p', computed: { lookup: { table: 'chores' } } }, { name: 'q', computed: { lookup: { table: 'chores' } } }];
    assert.deepEqual(Columns.entryTables(entries), ['people', 'chores']);
    assert.deepEqual(Columns.entryTables([]), []);
    assert.deepEqual(Columns.entryTables(null), []);
  });

  it('entryTables keeps a self-named table — a view is not a table', () => {
    // tableDeps excludes the table it was asked about; entryTables has no such subject, so a view
    // whose column refs the view's own source must still report it.
    assert.deepEqual(Columns.entryTables([{ type: 'ref', table: 'tasks' }]), ['tasks']);
  });
});

describe('columns — every dependency in the shipped schemas points at a real table', () => {
  // The derivation is only useful if what it returns can actually be fetched. A typo'd table name in a
  // schema would otherwise become a request for a table that does not exist.
  const files = [];
  const add = (p) => { if (fs.existsSync(p)) files.push(p); };
  add(path.join(ROOT, 'dev', 'data', 'schema.json'));
  add(path.join(ROOT, 'dev', 'schema.json'));
  const exDir = path.join(ROOT, 'examples');
  if (fs.existsSync(exDir)) for (const f of fs.readdirSync(exDir)) if (f.endsWith('.json')) add(path.join(exDir, f));

  it('found schemas to check', () => assert.ok(files.length > 0, 'this suite would pass vacuously'));

  for (const file of files) {
    it(path.relative(ROOT, file).split(path.sep).join('/'), () => {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const schema = (raw.schema && raw.schema.tables) || raw.tables || null;
      if (!schema) return;
      for (const table of Object.keys(schema)) {
        for (const dep of Columns.tableDeps(schema, table)) {
          assert.ok(schema[dep], table + ' depends on a table that is not in the schema: ' + dep);
        }
      }
    });
  }
});
