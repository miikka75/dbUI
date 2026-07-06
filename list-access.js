// list-access.js — Pure per-list access model: each list is owned by the tables whose columns reference
// it (via `list` or the dual-list `listSwitch.list`); a restricted user may read only the lists owned by
// a table they can access. A list with no owning table (orphan) is admin-only.
//
// This was previously defined in schema-loader.html and HAND-COPIED in dev/server.js, dev/backend-local.js
// and dev/test/list-access.test.js — four drift-prone copies of access-control logic. One module now:
//   Browser: <script src="/list-access.js"> before the schema-loader fragment; backend-firebase.html
//            calls listOwningTables as a global to stamp each _lists/{name} doc with its owning tables.
//   Node:    const LA = require('../list-access')  (dev/server.js request filtering, backend-local stamping).
//
// Shape-agnostic: `columns` may be an object map (runtime/normalized) or an array of {name,...}
// (stored/exported schema).
(function(root) {
  function listOwningTables(schemaTables, listName) {
    var out = [];
    Object.keys(schemaTables || {}).forEach(function(t) {
      var cols = (schemaTables[t] && schemaTables[t].columns) || {};
      var defs = Array.isArray(cols) ? cols : Object.keys(cols).map(function(k) { return cols[k]; });
      var hit = defs.some(function(d) {
        return d && typeof d === 'object' && (d.list === listName || (d.listSwitch && d.listSwitch.list === listName));
      });
      if (hit) out.push(t);
    });
    return out;
  }
  // Filter list names to those a user may access. allowedTables===null => unrestricted (admin) => all.
  function accessibleListNames(schemaTables, allowedTables, allListNames) {
    if (!allowedTables) return (allListNames || []).slice();
    return (allListNames || []).filter(function(name) {
      return listOwningTables(schemaTables, name).some(function(t) { return allowedTables.indexOf(t) >= 0; });
    });
  }
  // Filter a {name: items} lists map to the entries the user may access (the server-side read filter).
  function filterLists(allLists, schemaTables, allowedTables) {
    if (!allowedTables) return allLists;
    var out = {};
    Object.keys(allLists || {}).forEach(function(name) {
      if (listOwningTables(schemaTables, name).some(function(t) { return allowedTables.indexOf(t) >= 0; })) out[name] = allLists[name];
    });
    return out;
  }

  var M = { listOwningTables: listOwningTables, accessibleListNames: accessibleListNames, filterLists: filterLists };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else { root.ListAccess = M; for (var k in M) root[k] = M[k]; } // globals for bare callers (backend-firebase)
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
