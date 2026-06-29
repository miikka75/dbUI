const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure copies of the per-list access helpers (schema-loader.html / server.js). Per-list access:
// each list is owned by the tables whose columns reference it (list or listSwitch.list); a restricted
// user may read only the lists owned by a table they can access.
function listOwningTables(schemaTables, listName) {
  const out = [];
  Object.keys(schemaTables || {}).forEach(t => {
    const cols = (schemaTables[t] && schemaTables[t].columns) || {};
    const defs = Array.isArray(cols) ? cols : Object.keys(cols).map(k => cols[k]);
    if (defs.some(d => d && typeof d === 'object' && (d.list === listName || (d.listSwitch && d.listSwitch.list === listName)))) out.push(t);
  });
  return out;
}
function accessibleListNames(schemaTables, allowedTables, allListNames) {
  if (!allowedTables) return (allListNames || []).slice();
  return (allListNames || []).filter(name => listOwningTables(schemaTables, name).some(t => allowedTables.indexOf(t) >= 0));
}
// Mirrors server.js getLists filtering (object-map input).
function filterLists(allLists, schemaTables, allowedTables) {
  if (!allowedTables) return allLists;
  const out = {};
  Object.keys(allLists).forEach(name => {
    if (listOwningTables(schemaTables, name).some(t => allowedTables.indexOf(t) >= 0)) out[name] = allLists[name];
  });
  return out;
}

describe('Per-list access (owning tables + filtering)', () => {
  // Church-shaped: team_a uses staff, team_b uses cleaners; meetings speech columns
  // use staff primary + guests via listSwitch; music uses its own song lists.
  const schemaTables = {
    team_a: { columns: { people: { type: 'multiselect', list: 'staff' } } },
    team_b: { columns: { people: { type: 'multiselect', list: 'cleaners' } } },
    ushers_list: { columns: { people: { type: 'multiselect', list: 'staff' } } },
    meetings: { columns: { speaker1: { type: 'select', list: 'staff', listSwitch: { list: 'guests' } } } },
    music: { columns: [{ name: 'laulu', list: 'songs' }, { name: 'saestaja', list: 'accompanists' }] } // array-form columns
  };
  const allLists = { staff: ['A'], cleaners: ['B'], guests: ['C'], songs: ['D'], accompanists: ['E'], orphan: ['Z'] };

  it('derives owning tables (object- and array-form columns; listSwitch counts)', () => {
    assert.deepEqual(listOwningTables(schemaTables, 'cleaners'), ['team_b']);
    assert.deepEqual(listOwningTables(schemaTables, 'staff').sort(), ['meetings', 'team_a', 'ushers_list']);
    assert.deepEqual(listOwningTables(schemaTables, 'guests'), ['meetings']);   // via listSwitch
    assert.deepEqual(listOwningTables(schemaTables, 'songs'), ['music']);     // array-form
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

  it('meetings grant exposes both the primary and the listSwitch alt list', () => {
    const got = accessibleListNames(schemaTables, ['meetings'], Object.keys(allLists)).sort();
    assert.deepEqual(got, ['guests', 'staff']);
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

  it('music coordinator gets only the song lists', () => {
    assert.deepEqual(accessibleListNames(schemaTables, ['music'], Object.keys(allLists)).sort(), ['accompanists', 'songs']);
  });
});
