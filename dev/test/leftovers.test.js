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

describe('leftovers.js — inventory', () => {
  const inv = Leftovers.inventory({
    text,
    lists: { status: ['open'], people: ['ann', 'bob'], hymns: ['a', 'b', 'c'], ref_chores: ['x'] },
    lookups: { ref_chores: 4, ref_unused: 2 },
    tables: Object.keys(schemaDoc.tables),
    pages: ['v', 'old_page'],
    views: { v: {} },
    links: { people: { ann: 'ann@x', carl: 'carl@x' }, gone_list: { x: 'x@x' }, ref_chores: { anything: 'a@x' } },
    translations: {
      en: { 'field.who': 'Who', 'field.retired_col': 'R', 'tab.ref_unused': 'U', 'view.v': 'V', 'view.dropped': 'D',
            'list.people.ann': 'Ann', 'list.people.carl': 'Carl', 'list.ref_chores.whatever': 'W', 'list.dead_ns.x': 'X',
            'text.intro': 'Hi', 'list.locked_value': 'Locked', 'tab.lists': 'Lists' },
      fi: { 'view.dropped': 'P' }
    },
    keep: ['list.locked_value', 'tab.lists']
  });
  const by = (kind) => inv.filter((e) => e.kind === kind).map((e) => e.name + (e.count != null ? ':' + e.count : ''));

  it('lists nothing names, never one that shares its name with a table', () => {
    assert.deepEqual(by('list'), ['hymns:3']);
  });
  it('lookup tables nothing points at, with their row counts', () => {
    assert.deepEqual(by('lookup'), ['ref_unused:2']);
  });
  it('page bodies whose view is gone', () => {
    assert.deepEqual(by('page'), ['old_page']);
  });
  it('account links to a value the list no longer holds, never into a lookup', () => {
    assert.deepEqual(by('link'), ['gone_list / x', 'people / carl']);
  });
  it('translation keys for things the schema no longer has, counted across languages; prose and chrome are never reported', () => {
    // tab.ref_unused stays: the table is still declared, so its label is live even though nothing uses it.
    assert.deepEqual(by('translation'), ['field.retired_col:1', 'list.dead_ns.x:1', 'list.people.carl:1', 'view.dropped:2']);
  });
});
