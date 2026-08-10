const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The real per-list access model from /list-access.js — the module the browser app, dev server and
// backend-local now share (this file previously tested hand-copies of it).
const { listOwningTables, accessibleListNames, filterLists } = require('../../list-access');

describe('Per-list access (owning tables + filtering)', () => {
  // Mixed shapes: team_a uses staff, team_b uses cleaners; an events table's
  // assignment column uses staff primary + leads via listSwitch; projects uses its own lists.
  const schemaTables = {
    team_a: { columns: { people: { type: 'multiselect', list: 'staff' } } },
    team_b: { columns: { people: { type: 'multiselect', list: 'cleaners' } } },
    ushers_list: { columns: { people: { type: 'multiselect', list: 'staff' } } },
    events: { columns: { host1: { type: 'select', list: 'staff', listSwitch: { list: 'leads' } } } },
    projects: { columns: [{ name: 'category', list: 'categories' }, { name: 'label', list: 'labels' }] } // array-form columns
  };
  const allLists = { staff: ['A'], cleaners: ['B'], leads: ['C'], categories: ['D'], labels: ['E'], orphan: ['Z'] };

  it('derives owning tables (object- and array-form columns; listSwitch counts)', () => {
    assert.deepEqual(listOwningTables(schemaTables, 'cleaners'), ['team_b']);
    assert.deepEqual(listOwningTables(schemaTables, 'staff').sort(), ['events', 'team_a', 'ushers_list']);
    assert.deepEqual(listOwningTables(schemaTables, 'leads'), ['events']);   // via listSwitch
    assert.deepEqual(listOwningTables(schemaTables, 'categories'), ['projects']);     // array-form
    assert.deepEqual(listOwningTables(schemaTables, 'orphan'), []);               // no owner
  });

  it('team_b coordinator sees cleaners but NOT staff', () => {
    const got = accessibleListNames(schemaTables, ['team_b'], Object.keys(allLists)).sort();
    assert.deepEqual(got, ['cleaners']);
    assert.equal(got.indexOf('staff'), -1);
  });

  it('team_a coordinator sees staff but NOT cleaners', () => {
    const got = accessibleListNames(schemaTables, ['team_a'], Object.keys(allLists)).sort();
    assert.deepEqual(got, ['staff']);
    assert.equal(got.indexOf('cleaners'), -1);
  });

  it('events grant exposes both the primary and the listSwitch alt list', () => {
    const got = accessibleListNames(schemaTables, ['events'], Object.keys(allLists)).sort();
    assert.deepEqual(got, ['leads', 'staff']);
  });

  it('admin (null allowedTables) sees every list incl. orphans', () => {
    assert.deepEqual(accessibleListNames(schemaTables, null, Object.keys(allLists)).sort(), Object.keys(allLists).sort());
  });

  it('orphan lists are hidden from restricted users (admin-only)', () => {
    assert.equal(accessibleListNames(schemaTables, ['team_b'], Object.keys(allLists)).indexOf('orphan'), -1);
  });

  it('server-side getLists filter returns only owned lists (data scoped, not just hidden)', () => {
    const filtered = filterLists(allLists, schemaTables, ['team_b']);
    assert.deepEqual(Object.keys(filtered), ['cleaners']);
    assert.deepEqual(filtered.cleaners, ['B']);
    assert.equal('staff' in filtered, false);   // team_a people never sent to team_b user
  });

  it('projects coordinator gets only its own lists', () => {
    assert.deepEqual(accessibleListNames(schemaTables, ['projects'], Object.keys(allLists)).sort(), ['categories', 'labels']);
  });
});

const LA = require('../../list-access');

describe('list-access - listOwnershipMap (the _meta/listTables mirror)', () => {
  // The inverse of listOwningTables, mirrored by saveSchema so the schema-blind rules layers can
  // authorize a _lists CREATE — where there is no stored doc to read an ownership label from, and the
  // label in the incoming write is an unverified claim.
  const tables = {
    tasks:   { columns: [{ name: 'status', list: 'statuses' }, { name: 'who', list: 'people' }] },
    notes:   { columns: { tag: { list: 'statuses' }, mood: { listSwitch: { list: 'moods' } } } },
    plain:   { columns: [{ name: 'title', type: 'text' }] }
  };

  it('maps each referenced list to every table whose columns reference it', () => {
    assert.deepEqual(LA.listOwnershipMap(tables), {
      statuses: ['tasks', 'notes'],
      people: ['tasks'],
      moods: ['notes']
    });
  });

  it('agrees with listOwningTables for every list it names', () => {
    const map = LA.listOwnershipMap(tables);
    for (const name of Object.keys(map)) {
      assert.deepEqual(map[name], LA.listOwningTables(tables, name),
        `mirror and per-list lookup disagree on "${name}" — the create rule pins one to the other`);
    }
  });

  it('omits lists nothing references, and tables with no list columns', () => {
    const map = LA.listOwnershipMap(tables);
    assert.equal('unreferenced' in map, false);
    assert.equal(Object.values(map).some((ts) => ts.includes('plain')), false);
  });

  it('does not repeat a table that references the same list twice', () => {
    const dup = { t: { columns: [{ name: 'a', list: 'L' }, { name: 'b', list: 'L' }] } };
    assert.deepEqual(LA.listOwnershipMap(dup), { L: ['t'] });
  });

  it('empty / missing schema is safe', () => {
    assert.deepEqual(LA.listOwnershipMap({}), {});
    assert.deepEqual(LA.listOwnershipMap(null), {});
  });
});
