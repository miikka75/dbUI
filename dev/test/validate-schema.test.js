// validate-schema.test.js — the SHIPPED load-time check (schema-validate.js), run the way boot runs it:
// an authored schema, normalized, then validated. Each case is one mistake an author can make and the
// message that names it; the shipped schemas are the case for "nothing to say".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SchemaNormalize = require('../../schema-normalize');
const { validate, validateRefs } = require('../../schema-validate');

const ROOT = path.join(__dirname, '..', '..');
function check(schema, ctx) {
  const n = SchemaNormalize.normalize(schema);
  return validate(schema.tables, n.viewsMap, Object.assign({ columnsOf: (t) => n.orders[t] || [] }, ctx));
}
const tasks = { columns: { title: { type: 'text' }, due: { type: 'date' } } };

describe('validateSchema — the shipped schemas are clean', () => {
  const files = fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => f.endsWith('-schema.json'))
    .map((f) => path.join('examples', f)).concat([path.join('dev', 'test-ui', 'fixture-schema.json')]);
  for (const f of files) {
    it(f, () => assert.deepEqual(check(JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'))), []));
  }
});

describe('validateSchema — each mistake is named', () => {
  const cases = [
    ['a view over a table that does not exist',
      { tables: { tasks }, views: [{ name: 'all', sources: ['ghost'] }] },
      'View "all" references non-existent table "ghost"'],
    ['a table name with the partition separator',
      { tables: { a__b: tasks }, views: [] },
      'table "a__b": a table name may not contain "__"'],
    ['a table name with the reserved underscore',
      { tables: { _x: tasks }, views: [] },
      'table "_x": a leading underscore is reserved'],
    ['a mirror of a table that does not exist',
      { tables: { tasks: { columns: { title: { type: 'text', syncFrom: 'ghost' } } } }, views: [] },
      'mirror source "ghost" not found'],
    ['a ref to a table that does not exist',
      { tables: { tasks: { columns: { owner_ref: { type: 'ref', table: 'ghost' } } } }, views: [] },
      'ref table "ghost" not found'],
    ['a mirror of an archivable table that cannot archive',
      { tables: { master: Object.assign({ archivable: true }, tasks), detail: { columns: { title: { type: 'text', syncFrom: 'master' } } } }, views: [] },
      'Table "detail" mirrors archivable "master"'],
    ['archiveAfter with no duration',
      { tables: { tasks: Object.assign({ archivable: true, archiveAfter: { after: 'soon' } }, tasks) }, views: [] },
      '`archiveAfter.after` "soon" is not a duration'],
    ['a doc page restricted to a table that does not exist',
      { tables: { tasks }, views: [{ name: 'home', markdown: '# Hi', access: ['ghost'] }] },
      'doc-view "home": `access` references non-existent table "ghost"'],
    ['a stats view with nothing to draw',
      { tables: { tasks }, views: [{ name: 'kpi', sources: ['tasks'], stats: {} }] },
      'needs `tiles` (an array) or `rowTiles`'],
  ];
  for (const [what, schema, message] of cases) {
    it(what, () => {
      const errs = check(schema);
      assert.ok(errs.some((e) => e.includes(message)), 'expected "' + message + '" in:\n' + errs.join('\n'));
    });
  }

  it('a feed language is checked against the languages the app passes in', () => {
    const schema = { tables: { tasks }, views: [{ name: 'cal', calendar: { sources: [{ table: 'tasks', dateColumn: 'due', titleColumns: ['title'] }], ics: { lang: 'xx' } } }] };
    const msg = '`ics.lang` "xx" is not a language this database declares';
    assert.ok(check(schema, { languages: [{ code: 'en' }] }).some((e) => e.includes(msg)));
    assert.ok(!check(schema, { languages: [{ code: 'xx' }] }).some((e) => e.includes(msg)));
  });
});

describe('validateRefs — dangling names in a raw schema', () => {
  it('names a newUser grant on a table that does not exist', () => {
    const errs = validateRefs({ tables: { tasks }, views: [], newUser: { role: 'viewer', tables: { ghost: 'r' } } });
    assert.ok(errs.some((e) => e.includes('`newUser.tables` -> missing table "ghost"')), errs.join('\n'));
  });
  it('says nothing about a consistent schema', () => {
    assert.deepEqual(validateRefs({ tables: { tasks }, views: [{ name: 'all', sources: ['tasks'] }] }), []);
  });
});
