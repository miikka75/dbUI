// list-access.js — Pure per-list access model: each list is owned by the tables whose columns reference
// it (via `list` or the dual-list `listSwitch.list`); a restricted user may read only the lists owned by
// a table they can access. A list with no owning table (orphan) is admin-only.
//
// This was previously defined in schema-loader.js and HAND-COPIED in dev/server.js, dev/backend-local.js
// and dev/test/list-access.test.js — four drift-prone copies of access-control logic. One module now:
//   Browser: <script src="/list-access.js"> before the schema-loader fragment; backend-firebase.js
//            calls listOwningTables as a global to stamp each _lists/{name} doc with its owning tables.
//   Node:    const LA = require('../list-access')  (dev/server.js request filtering, backend-local stamping).
//
// Shape-agnostic: `columns` may be an object map (runtime/normalized) or an array of {name,...}
// (stored/exported schema) -- resolved by Columns.columnDefList, not by a local branch (columns.js
// loads before this file in the browser, and is required directly in Node).
(function(root) {
  var Cols = (typeof module !== 'undefined' && module.exports) ? require('./columns') : root.Columns;
  function listOwningTables(schemaTables, listName) {
    var out = [];
    Object.keys(schemaTables || {}).forEach(function(t) {
      var hit = Cols.columnDefList(schemaTables[t]).some(function(d) {
        return d && typeof d === 'object' && (d.list === listName || (d.listSwitch && d.listSwitch.list === listName));
      });
      if (hit) out.push(t);
    });
    return out;
  }
  // The whole ownership relation at once: { listName: [owningTables] } for every list any column
  // references. This is listOwningTables inverted, and it exists because the rules layers are
  // schema-blind: saveSchema mirrors it to _meta/listTables so a rule can answer "which tables own the
  // list this doc claims to be" WITHOUT trusting the claim written into the doc. Same denormalize-for-
  // schema-blind-rules trick as _meta/ownerTables / pageAccess / ownerWritable.
  // Table order matches listOwningTables (both iterate Object.keys(schemaTables) outermost), so the
  // mirrored array and the array a client stamps onto a _lists doc compare equal — which is what lets
  // the create rule pin one to the other.
  function listOwnershipMap(schemaTables) {
    var out = {};
    Object.keys(schemaTables || {}).forEach(function(t) {
      Cols.columnDefList(schemaTables[t]).forEach(function(d) {
        if (!d || typeof d !== 'object') return;
        [d.list, d.listSwitch && d.listSwitch.list].forEach(function(ln) {
          if (!ln) return;
          if (!out[ln]) out[ln] = [];
          if (out[ln].indexOf(t) < 0) out[ln].push(t);
        });
      });
    });
    return out;
  }
  // The tables whose lists a caller may READ: their grants, plus -- for a registered caller -- every
  // self-service table (one that declares an `owner` column). A member writes their own rows there with
  // no grant at all, so without this the vocabulary of the very column they fill in (an rsvp's status
  // list) never reached them. Reading a list reveals no rows. Mirrors listAllowed in firestore.rules and
  // app_list_allowed in supabase-schema.sql, both of which read the same set from _meta/ownerTables.
  function listReaderTables(schemaTables, allowedTables, selfService) {
    if (!selfService) return allowedTables;
    var out = allowedTables.slice();
    Object.keys(schemaTables || {}).forEach(function(t) {
      if (Cols.ownerColOf(schemaTables[t]) && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }
  // Filter list names to those a user may access. allowedTables===null => unrestricted (admin) => all.
  // `selfService` is true for a registered caller (see listReaderTables).
  function accessibleListNames(schemaTables, allowedTables, allListNames, selfService) {
    if (!allowedTables) return (allListNames || []).slice();
    var readable = listReaderTables(schemaTables, allowedTables, selfService);
    return (allListNames || []).filter(function(name) {
      return listOwningTables(schemaTables, name).some(function(t) { return readable.indexOf(t) >= 0; });
    });
  }
  // Filter a {name: items} lists map to the entries the user may access (the server-side read filter).
  function filterLists(allLists, schemaTables, allowedTables, selfService) {
    if (!allowedTables) return allLists;
    var keep = accessibleListNames(schemaTables, allowedTables, Object.keys(allLists || {}), selfService);
    var out = {};
    keep.forEach(function(name) { out[name] = allLists[name]; });
    return out;
  }

  var M = { listOwningTables: listOwningTables, listOwnershipMap: listOwnershipMap,
            accessibleListNames: accessibleListNames, filterLists: filterLists };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else { root.ListAccess = M; for (var k in M) root[k] = M[k]; } // globals for bare callers (backend-firebase)
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
