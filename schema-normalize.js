// schema-normalize.js — THE authored-schema -> runtime-schema conversion: run the migration chain,
// canonicalize view filters, flatten the nav tree into the VIEWS map, fold an array `columns` into the
// name->def map (recording the authored order), inject the implicit `id`.
//
// WHY THIS IS A MODULE: it existed twice. schema-loader.js did it for the browser, and dev/schema.js
// did it again for the unit-test files that load a schema in Node — which meant THE TEST SUITE
// NORMALIZED SCHEMAS DIFFERENTLY FROM THE APP. That is not a theoretical risk: the copy's view
// discriminator had already drifted a kind behind (latent only because validateSchema forced the
// missing case down another branch), and the copy ran neither the migration chain nor
// convertViewFilters — so no test ever took a legacy schema through the real load path, which is
// exactly the path legacy schemas need covered. Same extraction as columns.js and list-access.js.
//
//   Browser: <script src="/schema-normalize.js"> after columns.js / rows.js / migrations.js;
//            schema-loader.js calls it and assigns the globals (SCHEMA/VIEWS/_columnOrders).
//   Node:    const SchemaNormalize = require('./schema-normalize');
//
// Mutates the schema it is given, as Migrations.migrate does and for the same reason: callers pass a
// freshly parsed document, and copying a whole schema per load would buy nothing.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // Resolved on first use, so this file can be loaded in any order relative to the modules it leans
  // on. Both are optional: a caller that only wants the column folding (an import preview, a fixture)
  // gets it without rows.js/migrations.js present.
  var _deps = null;
  function deps() {
    if (!_deps) {
      _deps = isNode
        ? { migrate: require('./migrations').migrate, kindOf: require('./migrations').kindOf,
            convertViewFilters: require('./rows').convertViewFilters }
        : { migrate: (root.Migrations && root.Migrations.migrate) || null,
            kindOf: (root.Migrations && root.Migrations.kindOf) || null,
            convertViewFilters: root.convertViewFilters || null };
    }
    return _deps;
  }

  // What KIND of thing a nav entry is: 'data' | 'page' | 'rotation' | 'calendar' | 'pivot' | 'rsvp' |
  // 'board' | 'form' | 'group'. THE discriminator — every consumer that used to work the answer out by
  // probing for a `calendar`/`rotation`/... key asks this instead.
  //
  // It prefers the `kind` the schema carries (migration v1->v2 writes one, and v3->v4 corrected it for
  // nav groups — that single wrong answer is why this could not read `kind` before), and derives one
  // through Migrations.kindOf otherwise: schema-loader flattens the bundled `defaultSchema` at module
  // load, before anything migrates it. Deriving is DELEGATED rather than copied. A local copy of the
  // eight-way test is exactly the drift this whole change exists to remove, and it would be invisible
  // in Node, where migrations.js is always present and the copy would never run.
  //
  // The label only works while it is TRUE, so dev/test/view-kind.test.js asserts every shipped
  // schema's stored `kind` still matches what the entry is.
  function viewKind(v) {
    if (!v || typeof v !== 'object') return null;
    if (v.kind) return v.kind;
    var k = deps().kindOf;
    return k ? k(v) : null;
  }

  // Does this nav entry render something — i.e. is it a VIEW rather than a folder? A named entry of any
  // kind but 'group' is one. This used to be a hand-written disjunction over the same six body fields
  // `kindOf` probes, re-derived by every consumer; there is now one answer and one place it comes from.
  //
  // The null branch is for a caller that loaded this module WITHOUT migrations.js, so no kind can be
  // derived. It falls back to the one distinction this function actually needs — a folder carries
  // nested `views` and no body — rather than to a second copy of the kind vocabulary.
  function isView(v) {
    if (!v || !v.name) return false;
    var k = viewKind(v);
    return k === null ? !Array.isArray(v.views) : k !== 'group';
  }

  // Flatten the nested nav tree into { name: view }. Recurses through `views` (nav groups nest).
  function flattenViews(arr, into) {
    var out = into || {};
    (arr || []).forEach(function(v) {
      if (isView(v)) out[v.name] = v;
      if (v && v.views) flattenViews(v.views, out);
    });
    return out;
  }

  // Fold every table's authored array `columns` into the runtime name->def map, returning the authored
  // ORDER per table (which the map shape cannot carry, and which the grid renders by). A def that
  // holds nothing but its name collapses to the bare string 'text'. Already-map tables are left alone
  // and simply report their key order. Entries without a name are not columns and are dropped.
  function foldColumns(tables) {
    var orders = {};
    Object.keys(tables || {}).forEach(function(t) {
      var def = tables[t] || {};
      if (Array.isArray(def.columns)) {
        var colMap = {};
        orders[t] = [];
        def.columns.forEach(function(c) {
          if (!c || !c.name) return;
          orders[t].push(c.name);
          var d = Object.assign({}, c);
          delete d.name;
          colMap[c.name] = Object.keys(d).length ? d : 'text';
        });
        def.columns = colMap;
      } else {
        orders[t] = Object.keys(def.columns || {});
      }
    });
    return orders;
  }

  // id is implicit: auto-inject into every table so schemas needn't declare it. It stays the storage
  // PK and the join/archive key. Re-run by app-core after a column-order override, so: idempotent.
  function ensureImplicitId(tables, orders) {
    Object.keys(tables || {}).forEach(function(t) {
      var cols = tables[t] && tables[t].columns;
      if (!cols) return;
      if (!cols.id) cols.id = 'text';
      if (orders && orders[t] && orders[t].indexOf('id') === -1) orders[t].unshift('id');
    });
  }

  // The whole conversion, in the order the app has always applied it:
  //   1. migrate  — bring an older shape forward BEFORE anything reads it, so nothing downstream has
  //                 to know which version it was written in. The result is REPORTED, not written back:
  //                 that needs a caller who may save, so the chain re-runs every load and every step
  //                 is idempotent.
  //   2. convertViewFilters — the pre-versioning shim, still permanent: legacy array-IN filters -> $or
  //                 and shorthand conditional columns -> { name, when }.
  //   3. fold columns + implicit id + flatten views.
  // Returns the pieces; assigning them to globals is the caller's job (the browser has SCHEMA/VIEWS/
  // window._columnOrders, Node has module-local bindings).
  function normalize(parsed) {
    var p = parsed || {};
    var d = deps();
    var migration = (d.migrate ? d.migrate(p) : null);
    if (d.convertViewFilters) d.convertViewFilters(p.views);
    var tables = p.tables || {};
    var views = Array.isArray(p.views) ? p.views : [];
    var orders = foldColumns(tables);
    ensureImplicitId(tables, orders);
    return { tables: tables, views: views, viewsMap: flattenViews(views), orders: orders, migration: migration };
  }

  var N = { isView: isView, viewKind: viewKind, flattenViews: flattenViews, foldColumns: foldColumns,
            ensureImplicitId: ensureImplicitId, normalize: normalize };
  if (isNode) module.exports = N;
  else root.SchemaNormalize = N;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
