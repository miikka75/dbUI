// localStorage shim for Apps Script sandbox (where localStorage is undefined)
if (typeof localStorage === 'undefined') { window.localStorage = { _d:{}, getItem:function(k){return this._d[k]||null;}, setItem:function(k,v){this._d[k]=String(v);}, removeItem:function(k){delete this._d[k];}, clear:function(){this._d={};} }; }

// Default schema bundled in app — used when Drive has no schema.json yet
var defaultSchema = {"tables":{},"views":[]};

// Active schema — initially from defaultSchema, overwritten from Drive on boot
var SCHEMA = defaultSchema.tables;
var _viewsNav = Array.isArray(defaultSchema.views) ? defaultSchema.views : [];
// The nav-tree flattener, the column folding and the implicit `id` live in /schema-normalize.js, so
// the Node test harness (dev/schema.js) loads a schema through the SAME code the app does instead of
// its own copy. Loaded before this fragment; called as the global SchemaNormalize.
var VIEWS = SchemaNormalize.flattenViews(_viewsNav);
// (Legacy `pages` map / {page:} nav and `text` entries are removed features with no load-time
//  handling; a legacy schema must be hand-upgraded to markdown doc-views. See SCHEMA.md.)
var DEFAULT_LANGUAGE = defaultSchema.defaultLanguage || null;

// Schema helpers
function getColumns(table) { if (!SCHEMA[table]) return []; return window._columnOrders && window._columnOrders[table] ? window._columnOrders[table] : Object.keys(SCHEMA[table].columns); }
// id is implicit: auto-inject into every table so schemas needn't declare it. It stays the storage PK
// and join/archive key. A global because app-core re-runs it after a column-order override.
function ensureImplicitId(schema, orders) { SchemaNormalize.ensureImplicitId(schema, orders); }
// Shared schema normalization: run the document through SchemaNormalize and bind the result to the
// app's globals. Returns nothing; mutates globals.
function _normalizeSchema(parsed) {
  // The conversion itself (migrate -> convertViewFilters -> fold columns -> implicit id -> flatten) is
  // SchemaNormalize.normalize. What stays here is what is BROWSER-specific: binding the result to the
  // globals the app reads, and recording the migration for the UI.
  //
  // The migration RESULT is recorded, not just applied: app-core writes the upgraded schema back once,
  // when a caller who may save it is known. Until that happens the chain re-runs on every load, which
  // is why every migration has to be idempotent.
  var n = SchemaNormalize.normalize(parsed);
  if (typeof window !== 'undefined') window._schemaMigration = (n.migration && n.migration.applied.length) ? n.migration : null;
  // `n` describes the DOCUMENT. A document carrying no `tables` / no `views` array leaves the previous
  // ones in place (that fallback predates this extraction and boot relies on it), so bind against what
  // SCHEMA/_viewsNav actually end up being rather than against a map built from nothing.
  SCHEMA = parsed.tables || SCHEMA;
  _viewsNav = Array.isArray(parsed.views) ? parsed.views : _viewsNav;
  VIEWS = Array.isArray(parsed.views) ? n.viewsMap : SchemaNormalize.flattenViews(_viewsNav);
  window._columnOrders = parsed.tables ? n.orders : SchemaNormalize.foldColumns(SCHEMA);
}
// colName/isEmbed/isViewEmbed/isText (view column-entry shape predicates) are globals from columns.js.
// Shared list-value seeding: ensure filter-referenced values exist in listsCache. Returns true if anything was added.
// THE walk over every list-backed filter VALUE a schema declares — view filters, inline-embed filters,
// legacy shorthand conditional columns, and columns' `listFilter` — calling cb(listName, value). Two consumers used to
// duplicate this traversal with different payloads: _seedListValues (adds them to the list) and
// app-core's lockedListValues (marks them undeletable + mints their translation key). SCHEMA.md pairs
// the two ("auto-seeded and non-deletable"), so they must see exactly the same values.
// They had drifted: only the seeder recursed into $or/$and, so a grouped filter's values were seeded
// but never locked — and convertViewFilters rewrites every legacy array-IN filter to $or at load, so
// that covered any `{col: [a, b]}`. Walking once removes the possibility.
// Tokens ('@me' — isFilterToken, rows.js) are skipped here once, for both callers.
function forEachFilterListValue(cb) {
  // The walk over $or/$and and over which keys are columns is forEachCondCol (rows.js), beside the
  // matcher that defines it — this callback is only what to do with each column it finds.
  function walk(filter) {
    forEachCondCol(filter, function(col, cond) {
      var ln = Columns.colIsList(SCHEMA, col);   // memoized any-table scan; was hand-rolled in 4 places
      if (!ln && Columns.colIsRef(SCHEMA, col)) {                          // a ref filter column (e.g. a 2-D board
        for (var rt in SCHEMA) { var rf = Columns.columnRef(SCHEMA, rt, col); if (rf && rf.table) { ln = rf.table; break; } }
      }                                                                    // lane): pin under its lookup TABLE name
      if (!ln) return;
      var vals = Array.isArray(cond) ? cond : [cond];
      vals.forEach(function(val) { if (typeof val === 'string' && !isFilterToken(val)) cb(ln, val); });
    });
  }
  // A column's `listFilter` pins values too, and of the LOOKUP its `list` names -- the condition is over
  // that table's columns, so the values are recorded under it directly rather than resolved through a
  // column name, which here would find whichever table happens to have a column called the same.
  // Renaming a pinned value in the Lookup tab would otherwise make the picker silently offer nothing.
  for (var lt in SCHEMA) {
    var lcols = (SCHEMA[lt] && SCHEMA[lt].columns) || {};
    for (var lc in lcols) {
      var ld = lcols[lc];
      if (!ld || typeof ld !== 'object' || !ld.listFilter || !ld.list || !SCHEMA[ld.list] || !SCHEMA[ld.list].isLookup) continue;
      forEachCondCol(ld.listFilter, function(col, cond) {
        (Array.isArray(cond) ? cond : [cond]).forEach(function(val) { if (typeof val === 'string' && !isFilterToken(val)) cb(ld.list, val); });
      });
    }
  }
  for (var vn in VIEWS) {
    var view = VIEWS[vn];
    walk(view.filter);
    (view.columns || []).forEach(function(c) {
      if (!c || typeof c !== 'object') return;
      if (c.sources && c.filter) walk(c.filter);                                                    // inline embed
      else if (!c.sources && !c.name && !c.view) { var cond = c[Object.keys(c)[0]]; if (cond && typeof cond === 'object') walk(cond); }
    });
  }
}
function _seedListValues(listsCache) {
  var seeded = false;
  forEachFilterListValue(function(ln, val) {
    if (!listsCache[ln] || listsCache[ln].indexOf(val) >= 0) return;
    listsCache[ln].push(val); seeded = true;
  });
  return seeded;
}
// dataCache/export key for a table's archive partition (fixed 'archive')
function aKey(table) { return table + '__archive'; }
// Full mirror cluster: all tables sharing a logical row via syncFrom, both directions, transitively
// (a detail's master, a master's details, and their other details).
function withMirrors(base) {
  // The walk itself is Columns.mirrorCluster, memoized per schema — it used to run here on every call,
  // which meant O(tables x columns) per nav item, per embed source and per table load. The union is
  // taken in `base` order, and a cluster starts with its own table, so a single-table base comes back
  // exactly as it always did (which is what _createBlankRow relies on: the primary must stay first).
  //
  // Copies out of the cluster rather than returning it: the cached array is shared.
  var out = [];
  (base || []).forEach(function(t) {
    Columns.mirrorCluster(SCHEMA, t).forEach(function(x) { if (out.indexOf(x) < 0) out.push(x); });
  });
  return out;
}

// The view row pipeline (condMatches/_withinPeriod, filterRows, filterToOr, convertViewFilters,
// sortByCol, buildRows, aggregateRows, resolveComputed) lives in /rows.js, loaded before this
// fragment; _normalizeSchema (convertViewFilters) and app-core call those as globals from that module.

// The per-list access model (listOwningTables/accessibleListNames/filterLists) lives in /list-access.js,
// loaded before this fragment; backend-firebase.js calls listOwningTables as a global from it.

// mdToHtml (tiny markdown -> HTML for pages) lives in /embeds.js, exposed as a global from there.

// The rotation engine (interval math + resolvers + buildRotationViewRows) lives in /rotation.js.
// The load-time schema check lives in /schema-validate.js. fmtDate() and toDateStr()
// (canonical local YYYY-MM-DD formatters) are globals from calendar.js — toDateStr was defined HERE
// until the pure modules that format dates needed it and could not require this fragment. Both load
// before this one.
function parseTableResult(r) { if (!r) return { headers: [], rows: [] }; if (typeof r === 'string') return JSON.parse(r); return r; }
function validateSchema() {
  return SchemaValidate.validate(SCHEMA, VIEWS, { columnsOf: getColumns, languages: (window.appInstance && window.appInstance.languages) || [] });
}
function validateRefs(schema) { return SchemaValidate.validateRefs(schema); }
