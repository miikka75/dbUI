// leftovers.test.js — which lists and lookup tables nothing in the schema names any more.
// The property that matters is one-sided: the answer may be silent, never wrong.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Leftovers = require('../../leftovers');

const schemaDoc = {
  listSources: { members: 'users' },
  translatableLists: ['ticket_stages'],
  tables: {
    tasks: { columns: [
      { name: 'status', type: 'select' },                               // the column's NAME is its list
      { name: 'who', type: 'select', list: 'people', listSwitch: { list: 'visitors' } },
      { name: 'chore', type: 'ref', table: 'ref_chores', valueCol: 'chore' }
    ] },
    ref_chores: { isLookup: true, columns: [{ name: 'chore', type: 'text' }] },
    ref_unused: { isLookup: true, columns: [{ name: 'x', type: 'text' }] },
    teams: { isLookup: true, columns: [{ name: 'parent', type: 'ref', table: 'teams' }] }
  },
  views: [{ name: 'v', filter: { kind: { matchList: 'leads' } }, markdown: 'See {{view:summary}} and list.archived_terms.x' }]
};
const text = Leftovers.corpus([schemaDoc], [schemaDoc.tables]);
const unref = (n) => Leftovers.unreferenced(n, text);

describe('leftovers.js — unreferenced', () => {
  it('every way a list is reached counts: list, listSwitch, a column name, listSources keys, matchList, translatableLists', () => {
    for (const n of ['people', 'visitors', 'status', 'members', 'leads', 'ticket_stages']) assert.equal(unref(n), false, n);
  });

  it('a list nothing names is unreferenced', () => {
    assert.equal(unref('hymns'), true);
  });

  it('a lookup table is referenced by a ref, not by being declared', () => {
    assert.equal(unref('ref_chores'), false);
    assert.equal(unref('ref_unused'), true);
  });

  it('a self-referencing lookup stays silent: unsure is not unreferenced', () => {
    assert.equal(unref('teams'), false);
  });

  it('matches whole names only, and prose counts', () => {
    assert.equal(Leftovers.unreferenced('ref_chores', Leftovers.corpus([{ a: 'ref_chores_old' }])), true);
    assert.equal(Leftovers.unreferenced('my-list', Leftovers.corpus([{ a: 'my-list-2' }])), true);
    assert.equal(Leftovers.unreferenced('my-list', Leftovers.corpus([{ a: 'x my-list y' }])), false);
    assert.equal(unref('archived_terms'), false);
  });

  it('an empty name is never reported', () => {
    assert.equal(Leftovers.unreferenced('', ''), false);
  });
});
