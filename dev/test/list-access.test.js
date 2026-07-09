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
