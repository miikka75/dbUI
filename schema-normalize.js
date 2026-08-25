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
        ? { migrate: require('./migrations').migrate, convertViewFilters: require('./rows').convertViewFilters }
        : { migrate: (root.Migrations && root.Migrations.migrate) || null, convertViewFilters: root.convertViewFilters || null };
    }
    return _deps;
  }

  // Does this nav entry carry a renderable body — i.e. is it a VIEW rather than a folder? This is the
  // presence discriminator every consumer used to re-derive by probing fields; there is now one copy.
  //
  // It is deliberately NOT `v.kind`, even though migration v1->v2 writes one: `kindOf` defaults to
  // 'data', and it stamps every NAMED entry, so a named nav group carrying only nested `views` comes
  // out labelled `kind: "data"` while it is not a view at all. Switching the discriminator over needs
  // the migration to name groups too; until then `kind` is a record of what a view IS, and this is the
  // answer to whether it is one.
  function isView(v) {
    return !!(v && v.name && (v.sources || typeof v.markdown === 'string' ||
              v.rotation || v.calendar || v.pivot || v.rsvp || v.board || v.form));
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

  var N = { isView: isView, flattenViews: flattenViews, foldColumns: foldColumns,
            ensureImplicitId: ensureImplicitId, normalize: normalize };
  if (isNode) module.exports = N;
  else root.SchemaNormalize = N;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
