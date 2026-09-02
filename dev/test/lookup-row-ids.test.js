// lookup-row-ids.test.js — the id of a row a BUNDLE ships is its identity forever.
//
// An import merges rows by id. So a shipped lookup row's id is a contract with every deployment that
// ever installed it: change it and the next reinstall does not update that row, it adds a second one
// beside the first. That is exactly how a live deployment came to list the same organization twice,
// with half its callings catalogue in each of two vocabularies — a second file numbered from the same
// rc-1xx range, overwriting where the two collided and interleaving where they did not.
//
// Two invariants, and neither can be checked by reading one file:
//   1. WITHIN a bundle, ids are unique and no two rows say the same thing.
//   2. ACROSS revisions, a row that says the same thing keeps the same id. Checked against HEAD, so a
//      regenerated catalogue whose ids shifted with its row order fails here instead of silently
//      duplicating in someone's database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const Examples = require('../../examples');

const bundleIds = [...new Set(fs.readdirSync(EXAMPLES)
  .map((n) => /^(.+)-schema\.json$/.exec(n)).filter(Boolean).map((m) => m[1]))];

// The columns that SAY WHAT THE ROW IS: everything visible, which is the same set the app treats as a
// lookup's value column and a 2-D lookup's two dimensions.
const identityCols = (def) => (def.columns || [])
  .filter((c) => c && !c.hidden && ['id', 'created_at', 'updated_at'].indexOf(c.name) < 0)
  .map((c) => c.name);

// A bundle's lookup rows, wherever they ship: the schema file carries the definitions, the rows may be
// in either the schema file or its data file.
function lookupRows(readFile, id) {
  const schema = readFile(id + '-schema.json');
  if (!schema) return {};
  const defs = (schema.schema || schema).tables || {};
  const rows = Object.assign({}, schema.tables || {}, (readFile(id + '-data.json') || {}).tables || {});
  const out = {};
  for (const table of Object.keys(defs)) {
    if (!defs[table] || !defs[table].isLookup || !Array.isArray(rows[table])) continue;
    out[table] = { cols: identityCols(defs[table]), rows: rows[table] };
  }
  return out;
}

const fromDisk = (f) => (fs.existsSync(path.join(EXAMPLES, f))
  ? JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8')) : null);

// The committed version of the same file. Absent (a new file, or no git) means there is nothing to
// have broken yet, so those bundles simply have no baseline to compare against.
function fromHead(f) {
  try { return JSON.parse(execFileSync('git', ['show', 'HEAD:examples/' + f], { cwd: ROOT, encoding: 'utf8' })); }
  catch (e) { return null; }
}

const tupleOf = (cols, row) => cols.map((c) => String(row[c] == null ? '' : row[c])).join(' / ');

describe('lookupRowId', () => {
  it('derives the same id from the same content, whoever generates the file', () => {
    assert.equal(Examples.lookupRowId('rc', ['aaronic_priesthood', 'priest']), 'rc-aaronic_priesthood-priest');
    assert.equal(Examples.lookupRowId('rc', ['aaronic_priesthood', 'priest']),
                 Examples.lookupRowId('rc', ['Aaronic_Priesthood', ' PRIEST ']));
  });

  it('keeps different content apart, and survives punctuation and spaces', () => {
    assert.notEqual(Examples.lookupRowId('rc', ['primary', 'teacher']), Examples.lookupRowId('rc', ['primary', 'president']));
    assert.equal(Examples.lookupRowId('rc', ['Nuoret Miehet - Papit', '1. neuvonantaja']), 'rc-nuoret-miehet-papit-1-neuvonantaja');
  });

  it('ignores a blank dimension rather than leaving a dangling separator', () => {
    assert.equal(Examples.lookupRowId('rc', ['ward', '']), 'rc-ward');
  });
});

describe('shipped lookup rows', () => {
  for (const id of bundleIds) {
    const tables = lookupRows(fromDisk, id);
    for (const table of Object.keys(tables)) {
      const { cols, rows } = tables[table];

      it(id + '/' + table + ': every row has a unique id', () => {
        const seen = new Map();
        for (const row of rows) {
          assert.ok(row.id, table + ': a row with no id — an import would insert a duplicate of it every time');
          assert.ok(!seen.has(row.id), table + ': id "' + row.id + '" is used twice');
          seen.set(row.id, row);
        }
      });

      it(id + '/' + table + ': no two rows say the same thing', () => {
        const seen = new Map();
        for (const row of rows) {
          const key = tupleOf(cols, row);
          assert.ok(!seen.has(key), table + ': "' + key + '" appears as both ' + seen.get(key) + ' and ' + row.id);
          seen.set(key, row.id);
        }
      });
    }
  }
});

describe('shipped lookup ids never move', () => {
  for (const id of bundleIds) {
    it(id + ': a row that says the same thing keeps the same id', () => {
      const now = lookupRows(fromDisk, id), was = lookupRows(fromHead, id);
      const moved = [];
      for (const table of Object.keys(now)) {
        if (!was[table]) continue;                       // a new lookup has no baseline
        const before = new Map(was[table].rows.map((r) => [tupleOf(was[table].cols, r), r.id]));
        for (const row of now[table].rows) {
          const key = tupleOf(now[table].cols, row), had = before.get(key);
          if (had && had !== row.id) moved.push(table + ' "' + key + '": ' + had + ' -> ' + row.id);
        }
      }
      assert.deepEqual(moved, [], id + ': renumbering a shipped row makes the next reinstall ADD it '
        + 'rather than update it. Keep the id and change the content, or ship a migration that deletes the old row.');
    });
  }
});
