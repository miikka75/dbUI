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
// and legacy shorthand conditional columns — calling cb(listName, value). Two consumers used to
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

// The rotation engine (interval math + resolvers + buildRotationViewRows) lives in /rotation.js;
// validateSchema (below) calls isValidInterval as a global from that module. fmtDate() (canonical
// local YYYY-MM-DD formatter) is a global from calendar.js. Both load before this fragment.
function toDateStr(v) { if (!v) return ''; var s = String(v); if (s.length === 10) return s; return fmtDate(new Date(s)); }
function parseTableResult(r) { if (!r) return { headers: [], rows: [] }; if (typeof r === 'string') return JSON.parse(r); return r; }
function validateSchema() {
  var errors = [];
  var allCols = {};
  for (var t in SCHEMA) { for (var c in SCHEMA[t].columns) allCols[c] = t; }
  // The column VOCABULARY. Both halves of a column def fail silently when they are wrong, which is why
  // they are checked at all: `columnType` defaults to 'text', so `"type": "slect"` renders a perfectly
  // working text column and the author is left wondering where their dropdown went; and a key nobody
  // reads is a no-op, so `"allowNews": true` changes nothing and says nothing. Neither is detectable
  // downstream -- the document is valid JSON either way, and the app behaves.
  //
  // The lists themselves are in columns.js, next to the readers that consume them, and the check is a
  // pure function over the tables map so the unit suite runs the SAME one (dev/test/schema-vocabulary
  // .test.js) rather than a copy. `schema.schema.json` states the same vocabulary for the author's
  // editor, and schema-meta.test.js holds the two together.
  errors = errors.concat(Columns.vocabularyErrors(SCHEMA));
  // A table NAME is a storage identifier, not a label. Every partition store is `<table>__<part>`
  // (BackendHelpers.storeName), and all three access layers invert that by TRUNCATION at the first
  // `__`: `collection.split('__')[0]` in firestore.rules, `split_part(coll, '__', 1)` in the Postgres
  // RLS mirror, BackendHelpers.tableOf in JavaScript. Two names therefore fail in ways nothing
  // downstream can notice:
  //
  //   `a__b`        collapses onto table `a`. A grant on `a` silently carries read AND WRITE on `a__b`
  //                 in Firestore and in Postgres alike -- the grant key is the truncation, so the two
  //                 tables are one table to every rule. And `a__archive` collides outright with the
  //                 archive partition of table `a`.
  //   `_x`          is reserved: the app's own collections are `_meta`, `_users`, `_lists`, `_pages`,
  //                 `_assets`, `_profiles`, `_list_users`, and firestore.rules' base() refuses
  //                 `^_.*` wholesale -- so such a table is denied every read and write, with no
  //                 diagnostic on any layer.
  //
  // Checked here because there is nowhere else it could be: table names come from an authored schema
  // document (there is no create-a-table UI), so load time is the only moment anyone is watching.
  for (var tn in SCHEMA) {
    if (tn.indexOf('__') >= 0) errors.push('table "' + tn + '": a table name may not contain "__" — it is the separator between a table and its partition in every store name, so this name collides with another table\'s archive partition and shares its access grant');
    else if (tn.charAt(0) === '_') errors.push('table "' + tn + '": a leading underscore is reserved for the app\'s own collections (_meta, _users, _lists, _pages, _assets); the access rules refuse such a name outright');
  }
  // `archiveAfter` is easy to write and easy to have silently do nothing: it needs somewhere to move
  // rows TO (an archivable table) and a clock to measure (`updated_at`, which a columnar backend only
  // persists when the table declares it). Both are load-time detectable, so say so rather than let the
  // sweep find no eligible rows forever.
  // `ownerWritableWhile` freezes an owner's own row once it leaves the listed states. It is mirrored to
  // the two rules layers as ONE column + a value list, so more than one key cannot be enforced there —
  // reject it here rather than silently apply a random one. It is also inert without `ownerWritable`
  // (nothing bounds an owner write in the first place), which is the mistake worth naming.
  for (var ot in SCHEMA) {
    var gate = SCHEMA[ot] && SCHEMA[ot].ownerWritableWhile;
    if (gate === undefined) continue;
    var ocols = SCHEMA[ot].columns || {};
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) { errors.push('table "' + ot + '": `ownerWritableWhile` must be an object like { "status": "logged" }'); continue; }
    var gk = Object.keys(gate);
    if (gk.length !== 1) errors.push('table "' + ot + '": `ownerWritableWhile` takes exactly one column (got ' + gk.length + ') — the rules layers check one column against a value list');
    gk.forEach(function(k) {
      if (!(k in ocols)) errors.push('table "' + ot + '": `ownerWritableWhile` column "' + k + '" is not a column of the table');
      var vals = Array.isArray(gate[k]) ? gate[k] : [gate[k]];
      if (!vals.length || vals.some(function(v) { return v === null || typeof v === 'object'; })) errors.push('table "' + ot + '": `ownerWritableWhile.' + k + '` must be a value or a non-empty list of values');
    });
    if (!Array.isArray(SCHEMA[ot].ownerWritable)) errors.push('table "' + ot + '": `ownerWritableWhile` has no effect without `ownerWritable` (nothing bounds an owner-scoped write to begin with)');
  }
  // `stamped` marks a column the app fills in and nobody rewrites -- it binds a grant-holder, not just
  // an owner. It only works on a `defaultFrom: "@me"` column backed by a list: that is what fills it in
  // and what the write layers verify the value against. Silently ignoring a malformed one would leave a
  // column that LOOKS protected and is not, which is the worst of the three outcomes.
  for (var st in SCHEMA) {
    var scols = (SCHEMA[st] && SCHEMA[st].columns) || {}, seen = 0;
    for (var sc in scols) {
      var sd = scols[sc];
      if (!sd || typeof sd !== 'object' || !sd.stamped) continue;
      seen++;
      if (sd.defaultFrom !== '@me') errors.push('table "' + st + '": column "' + sc + '" is `stamped` but has no `defaultFrom: "@me"` — there would be nothing to fill it in with, and nothing to check a value against');
      else if (!sd.list) errors.push('table "' + st + '": stamped column "' + sc + '" needs a `list` — without one the identity is the profile display name, which the user writes themselves');
      if (seen === 2) errors.push('table "' + st + '": more than one `stamped` column — the rules layers resolve ONE column against its list and cannot loop a map');
    }
  }
  for (var at in SCHEMA) {
    var aa = SCHEMA[at] && SCHEMA[at].archiveAfter;
    if (!aa) continue;
    var acols = SCHEMA[at].columns || {};
    if (!SCHEMA[at].archivable) errors.push('table "' + at + '": `archiveAfter` needs `archivable: true` (there is no archive partition to move rows into)');
    if (!aa.column || !(aa.column in acols)) errors.push('table "' + at + '": `archiveAfter.column` "' + (aa.column || '') + '" is not a column of the table');
    if (!Array.isArray(aa.values) || !aa.values.length) errors.push('table "' + at + '": `archiveAfter.values` must be a non-empty array of the values that count as finished');
    if (!isFinite(Number(aa.days)) || Number(aa.days) < 0) errors.push('table "' + at + '": `archiveAfter.days` must be a non-negative number');
    if (!('updated_at' in acols)) errors.push('table "' + at + '": `archiveAfter` measures from `updated_at`, so the table must declare that column (`{ "name": "updated_at", "type": "text", "hidden": true }`)');
  }
  // `partitionLabels` renames the two tabs of a `{{view:x@both}}` embed. Its values are TRANSLATION
  // KEYS, and both halves of it fail silently: an unknown partition key is simply never read, and a
  // non-string value resolves to no label at all. Check the shape on both carriers (a view and a table
  // can each be the target of a `@both` token).
  var partLabelCheck = function(what, name, cfg) {
    var pl = cfg && cfg.partitionLabels;
    if (pl === undefined) return;
    if (!pl || typeof pl !== 'object' || Array.isArray(pl)) { errors.push(what + ' "' + name + '": `partitionLabels` must be an object like { "active": "text.upcoming", "archive": "text.past" }'); return; }
    Object.keys(pl).forEach(function(k) {
      if (k !== 'active' && k !== 'archive') errors.push(what + ' "' + name + '": `partitionLabels` key "' + k + '" is not a partition — use "active" and/or "archive"');
      else if (typeof pl[k] !== 'string' || !pl[k]) errors.push(what + ' "' + name + '": `partitionLabels.' + k + '` must be a translation key (a non-empty string)');
    });
  };
  for (var pt in SCHEMA) partLabelCheck('table', pt, SCHEMA[pt]);
  // "Is `col` a column of any of these tables" — the one predicate behind the view-column check, the
  // stats-tile check and the filter check below, so the three cannot come to disagree about it.
  var colOfTables = function(tables, col) {
    return (tables || []).some(function(s) { return SCHEMA[s] && SCHEMA[s].columns && SCHEMA[s].columns[col]; });
  };
  // A `filter` naming a column that is not there fails the same silent way every check around it does:
  // condMatches compares each row's `undefined` against the value, no row matches, and the view renders
  // an empty list — which reads as "no rows yet", not as a typo. Nothing downstream can notice, because
  // the filter is valid JSON and the matcher answers false for every row exactly as it would for a real
  // column nobody has filled in yet. (The inverse spelling, `{ typo: { empty: true } }`, is worse: every
  // row matches and the filter quietly does nothing at all.)
  //
  // Only what can be PROVEN wrong. A filter runs inside buildRows, over the rows of `sources`, BEFORE
  // `compute` and before aggregation — so the columns available to it are the declared columns of those
  // tables and nothing else. Carriers whose rows are not built that way are left alone: a rotationView's
  // `filter` matches GENERATED period rows, and `groupBy.filter` matches the aggregated key row (the same
  // reason the stats check further down skips an aggregate view).
  var filterColCheck = function(cfg, what) {
    var tables = cfg.sources || [];
    forEachCondCol(cfg.filter, function(col) {
      // `_source` / `_status` are row fields the pipeline itself adds; a leading underscore is reserved
      // from column names (above), so nothing declared can collide with one and nothing here can prove
      // one wrong.
      if (col.charAt(0) === '_') return;
      if (colOfTables(tables, col)) return;
      // A computed column of this very view is the near-miss worth naming apart: it IS a column of the
      // rendered rows, so "not found in sources" would send the author looking in the wrong place for a
      // name that is spelled right and can still never match.
      var computed = (cfg.columns || []).concat(cfg.compute || []).some(function(c) {
        return c && typeof c === 'object' && c.computed && c.name === col;
      });
      errors.push(what + ': filter column "' + col + '"' + (computed
        ? ' is computed by this view — `filter` runs on the source rows, before computed values exist, so it can never match'
        : ' not found in sources [' + tables.join(', ') + ']'));
    });
  };
  // The kinds whose rows ARE their `sources` rows passed through `filter` — loadTableData's union/join
  // branch, which data, board, form and stats all fall through to. Every other kind either generates its
  // rows (rotation) or reads through a config of its own that this `filter` is no part of.
  var FILTERS_SOURCE_ROWS = { data: 1, board: 1, form: 1, stats: 1 };
  for (var v in VIEWS) {
    var view = VIEWS[v];
    partLabelCheck('View', v, view);
    // `{{view:x@both}}` renders the Upcoming/Past toggle, which needs somewhere to toggle TO. Aimed at a
    // target with no archive partition the token renders as a plain embed forever — the tab strip the
    // author is waiting for can never appear — so say so at load rather than let it look like a bug.
    if (typeof view.markdown === 'string') {
      var bre = /\{\{\s*(view|table)\s*:\s*([^\s@?{}:]+)@both\??\s*\}\}/g, bm;
      while ((bm = bre.exec(view.markdown))) {
        var tgt = bm[2], bsrcs = bm[1] === 'view' ? ((VIEWS[tgt] && VIEWS[tgt].sources) || []) : [tgt];
        if (!bsrcs.some(function(s) { return SCHEMA[s] && SCHEMA[s].archivable; })) errors.push('View "' + v + '": `{{' + bm[1] + ':' + tgt + '@both}}` has no archive partition to toggle to (no source of "' + tgt + '" is `archivable: true`)');
      }
    }
    // Check sources exist
    (view.sources || []).forEach(function(s) { if (!SCHEMA[s]) errors.push('View "' + v + '" references non-existent table "' + s + '"'); });
    // A restricted doc-view's `access` lists the tables whose grant unlocks the page; each must exist.
    // The literal "all" is a first-class sentinel meaning "only full-access users" (`tables: 'all'` +
    // admins): no real grant array ever contains it, so canAccessPage / dev-server filterPages /
    // firestore.rules pageAllowed all deny every partial-grant user while the `tables == 'all'` check
    // still admits full-access users. It is NOT a table name, so exempt it from the existence check.
    if (typeof view.markdown === 'string' && view.access !== undefined) {
      if (!Array.isArray(view.access)) errors.push('doc-view "' + v + '": `access` must be an array of table names');
      else view.access.forEach(function(t) { if (t !== 'all' && !SCHEMA[t]) errors.push('doc-view "' + v + '": `access` references non-existent table "' + t + '"'); });
    }
    // A view background is presentation, so nothing downstream fails loudly when it is malformed -- the
    // image just silently doesn't appear. Check it here instead. `image` is either an `asset:<id>`
    // reference (bytes in the _assets table, the no-bucket tier) or a URL safeImgSrc accepts; both
    // predicates come from embeds.js, which loads before this fragment (see index.html appModulesReady).
    if (view.background !== undefined) {
      var bgv = view.background;
      if (!bgv || typeof bgv !== 'object' || Array.isArray(bgv)) errors.push('View "' + v + '": `background` must be an object, e.g. { "image": "https://…", "fit": "cover" }');
      else {
        if (typeof bgv.image !== 'string' || !bgv.image) errors.push('View "' + v + '": `background.image` must be a non-empty string (an https URL or "asset:<id>")');
        else if (!isAssetRef(bgv.image) && !safeImgSrc(bgv.image)) errors.push('View "' + v + '": `background.image` "' + bgv.image + '" is not a usable image source (http(s) URL, raster data: URI, or "asset:<id>")');
        if (bgv.fit !== undefined && ['cover', 'contain', 'tile', 'width'].indexOf(bgv.fit) < 0) errors.push('View "' + v + '": `background.fit` must be one of cover/contain/tile/width');
        if (bgv.fit === 'width' && bgv.width !== undefined && !(Number(bgv.width) >= 1 && Number(bgv.width) <= 100)) errors.push('View "' + v + '": `background.width` must be a percentage between 1 and 100');
        if (bgv.opacity !== undefined && !(Number(bgv.opacity) >= 0 && Number(bgv.opacity) <= 1)) errors.push('View "' + v + '": `background.opacity` must be a number between 0 and 1');
        if (bgv.position !== undefined && ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'].indexOf(bgv.position) < 0) errors.push('View "' + v + '": `background.position` must be one of center/top/bottom/left/right or a corner pair like "top left"');
      }
    }
    // Does `col` name something this view's rows will actually carry? Either a column of one of its
    // sources, or one the view declares itself (a `computed`). Shared by the column check below and by
    // the stats-tile check further down, so the two cannot disagree about what a column IS.
    var colInSources = function(col) { return colOfTables(view.sources, col); };
    var viewDeclaresCol = function(col) {
      return (view.columns || []).some(function(c) { return !isEmbed(c) && !isViewEmbed(c) && !isText(c) && colName(c) === col; });
    };
    // Check columns exist in at least one source (skip aggregate views)
    if (!view.groupBy) (view.columns || []).forEach(function(c) {
      if (isEmbed(c) || isViewEmbed(c) || isText(c) || (c && typeof c === 'object' && c.computed)) return;
      if (!colInSources(colName(c))) errors.push('View "' + v + '": column "' + colName(c) + '" not found in sources [' + (view.sources || []).join(', ') + ']');
    });
    // The view's own row filter, and the filter each of its embeds carries. An inline embed declares its
    // own `sources`; a named-view embed inherits the named view's, with the entry's own keys winning —
    // the same merge embedConfigs performs to build it. A `{view:...}` pointing nowhere is skipped
    // rather than reported twice: with no view to inherit from there is nothing left to check against.
    if (FILTERS_SOURCE_ROWS[SchemaNormalize.viewKind(view)]) filterColCheck(view, 'View "' + v + '"');
    (view.columns || []).forEach(function(c) {
      if (!c || typeof c !== 'object' || !c.filter) return;
      var ecfg = isViewEmbed(c) ? (VIEWS[c.view] ? Object.assign({}, VIEWS[c.view], c) : null) : (isEmbed(c) ? c : null);
      if (!ecfg || !FILTERS_SOURCE_ROWS[SchemaNormalize.viewKind(ecfg)]) return;
      filterColCheck(ecfg, 'View "' + v + '" embed ' + (c.view ? '"' + c.view + '"' : '[' + (c.sources || []).join(', ') + ']'));
    });
    // An explicit `valueCol` must name a real column on the roster table it reads, or every cell
    // silently renders empty (the resolvers fall back to [] for a missing column). Only checked when
    // set — the `people` default is left alone so existing rosters keep loading unchanged.
    function badValueCol(table, valueCol) {
      return valueCol && SCHEMA[table] && SCHEMA[table].columns && !SCHEMA[table].columns[valueCol];
    }
    // Rotation computed columns: trigger must be declared and references must resolve.
    (view.columns || []).forEach(function(c) {
      if (!c || typeof c !== 'object' || !c.computed || !c.computed.rotationTable) return;
      var comp = c.computed, nm = c.name || '?';
      if (!SCHEMA[comp.rotationTable]) errors.push('View "' + v + '": rotation column "' + nm + '" references non-existent rotationTable "' + comp.rotationTable + '"');
      if (comp.advanceBy !== 'occurrence' && comp.advanceBy !== 'calendar') errors.push('View "' + v + '": rotation column "' + nm + '" needs advanceBy "occurrence" or "calendar"');
      if (comp.advanceBy === 'occurrence' && comp.occurrenceSource && !SCHEMA[comp.occurrenceSource]) errors.push('View "' + v + '": rotation column "' + nm + '" occurrenceSource "' + comp.occurrenceSource + '" not found');
      if (comp.advanceBy === 'calendar' && !isValidInterval(comp.interval)) errors.push('View "' + v + '": calendar rotation column "' + nm + '" needs a valid interval (daily/weekly/monthly/yearly or "<n><d|w|m|y>" e.g. "3w")');
      if (badValueCol(comp.rotationTable, comp.valueCol)) errors.push('View "' + v + '": rotation column "' + nm + '": valueCol "' + comp.valueCol + '" is not a column of rotationTable "' + comp.rotationTable + '"');
    });
    // rotationView (third view kind): calendar-mode columns only.
    if (view.rotation) {
      var rvv = view.rotation;
      // `rosterRef`: one 2-D lookup replaces the slots+rosters pair. Slots are DATA (the distinct values
      // of `rosterBy`), so nothing here can check them — what is checkable is that the table and the two
      // columns exist, which is every way to get this wrong that yields a silently empty matrix.
      if (rvv.rosterRef) {
        if (rvv.slots || rvv.rosters) errors.push('rotationView "' + v + '": use `rosterRef` OR `slots`+`rosters`, not both');
        if (!SCHEMA[rvv.rosterRef]) errors.push('rotationView "' + v + '" references non-existent rosterRef table "' + rvv.rosterRef + '"');
        else {
          var rrCols = SCHEMA[rvv.rosterRef].columns || {};
          if (!rvv.rosterBy) errors.push('rotationView "' + v + '": `rosterRef` needs `rosterBy` (the column whose values are the slots)');
          else if (!(rvv.rosterBy in rrCols)) errors.push('rotationView "' + v + '": rosterBy "' + rvv.rosterBy + '" is not a column of "' + rvv.rosterRef + '"');
          if (!rvv.valueCol) errors.push('rotationView "' + v + '": `rosterRef` needs `valueCol` (the column holding the duty)');
          else if (badValueCol(rvv.rosterRef, rvv.valueCol)) errors.push('rotationView "' + v + '": valueCol "' + rvv.valueCol + '" is not a column of "' + rvv.rosterRef + '"');
          if (rvv.rosterBy && rvv.valueCol && rvv.rosterBy === rvv.valueCol) errors.push('rotationView "' + v + '": `rosterBy` and `valueCol` must be different columns');
        }
        if (!isValidInterval(rvv.interval)) errors.push('rotationView "' + v + '" needs a valid interval (daily/weekly/monthly/yearly or "<n><d|w|m|y>" e.g. "3w")');
      }
      if (rvv.slots && rvv.rosters) {
        if (rvv.advanceBy && rvv.advanceBy !== 'calendar') errors.push('rotationView "' + v + '" supports advanceBy "calendar" only (use a data view for occurrence mode)');
        if (!isValidInterval(rvv.interval)) errors.push('rotationView "' + v + '" needs a valid interval (daily/weekly/monthly/yearly or "<n><d|w|m|y>" e.g. "3w")');
        (rvv.rosters || []).forEach(function(t3) {
          if (!SCHEMA[t3]) errors.push('rotationView "' + v + '" references non-existent roster table "' + t3 + '"');
          else if (badValueCol(t3, rvv.valueCol)) errors.push('rotationView "' + v + '": valueCol "' + rvv.valueCol + '" is not a column of roster table "' + t3 + '"');
        });
        if ((rvv.rosters || []).length < (rvv.slots || []).length) errors.push('rotationView "' + v + '": fewer rosters (' + (rvv.rosters || []).length + ') than slots (' + (rvv.slots || []).length + ') — some slots would be unstaffed or double-booked each period');
        if (rvv.rotateEvery != null) {
          var _re = Array.isArray(rvv.rotateEvery) ? rvv.rotateEvery : [rvv.rotateEvery];
          _re.forEach(function(_e) {
            var _ok = (_e === 'cycle') || (typeof _e === 'number' && _e >= 0 && _e === Math.floor(_e));
            if (!_ok) errors.push('rotationView "' + v + '" rotateEvery elements must be a non-negative integer or "cycle" (got ' + JSON.stringify(_e) + ')');
          });
        }
      } else {
      (view.rotation.columns || []).forEach(function(c) {
        var nm = (c && c.name) || '?';
        if (!c || !SCHEMA[c.rotationTable]) errors.push('rotationView "' + v + '" column "' + nm + '" references non-existent rotationTable "' + (c && c.rotationTable) + '"');
        if (c && c.advanceBy && c.advanceBy !== 'calendar') errors.push('rotationView "' + v + '" column "' + nm + '" supports advanceBy "calendar" only (use a data view for occurrence mode)');
        if (!c || !isValidInterval(c.interval)) errors.push('rotationView "' + v + '" column "' + nm + '" needs a valid interval (daily/weekly/monthly/yearly or "<n><d|w|m|y>" e.g. "3w")');
        if (c && badValueCol(c.rotationTable, c.valueCol)) errors.push('rotationView "' + v + '" column "' + nm + '": valueCol "' + c.valueCol + '" is not a column of rotationTable "' + c.rotationTable + '"');
      });
      }
      // `mineOnly` sits on the VIEW (beside hideEmpty/obscureNames), not inside `rotation` — putting it
      // in the wrong place would silently show everyone the whole matrix, so name the mistake.
      if (rvv.mineOnly != null) errors.push('rotationView "' + v + '": `mineOnly` belongs on the view, not inside `rotation`');
      if (view.mineOnly != null) {
        var _mo = view.mineOnly;
        // A BARE STRING is rejected on purpose: `obscureNames` sits in the same config and takes an
        // array of COLUMNS, so a loose string/array here would read as columns to anyone who learned
        // that one. The list form says which key it is.
        if (typeof _mo === 'string' || Array.isArray(_mo)) errors.push('View "' + v + '": `mineOnly` takes true or { "list": "' + (Array.isArray(_mo) ? '<listName>' : _mo) + '" } — a bare string reads like the column array `obscureNames` takes');
        else if (_mo !== true && (typeof _mo !== 'object' || typeof _mo.list !== 'string' || !_mo.list)) errors.push('View "' + v + '": `mineOnly` must be true, or { "list": "<listName>" } naming the list that identifies a slot');
      }
    }
    // Calendar view (fourth view kind): validate source(s) + date columns.
    if (view.calendar) {
      var cvv = view.calendar;
      if (cvv.source && cvv.sources) errors.push('calendar "' + v + '": use `source` OR `sources`, not both');
      if (cvv.defaultView && ['month', 'week', 'list'].indexOf(cvv.defaultView) < 0) errors.push('calendar "' + v + '" defaultView must be month/week/list');
      var csrcs = cvv.sources || [{ table: cvv.source, dateColumn: cvv.dateColumn, titleColumns: cvv.titleColumns }];
      // `addTo` names which source a day-add creates in (needed once there are several). A name that is
      // not one of them silently leaves the button off, so say so.
      if (cvv.addTo && !csrcs.some(function(s) { return s && s.table === cvv.addTo; })) {
        errors.push('calendar "' + v + '": addTo "' + cvv.addTo + '" is not one of its sources');
      }
      csrcs.forEach(function(s) {
        if (!s || !s.table) { errors.push('calendar "' + v + '": each source needs a table'); return; }
        if (!SCHEMA[s.table]) { errors.push('calendar "' + v + '" references non-existent table "' + s.table + '"'); return; }
        var ccols = SCHEMA[s.table].columns || {};
        if (!s.dateColumn) { errors.push('calendar "' + v + '" source "' + s.table + '" needs a dateColumn'); }
        else {
          var dd = ccols[s.dateColumn], dt = (typeof dd === 'string') ? dd : (dd && dd.type);
          if (!dd) errors.push('calendar "' + v + '" dateColumn "' + s.dateColumn + '" not found in "' + s.table + '"');
          else if (dt !== 'date') errors.push('calendar "' + v + '" dateColumn "' + s.dateColumn + '" in "' + s.table + '" must be a date column');
        }
        (s.titleColumns || []).forEach(function(tc) { if (!ccols[tc]) errors.push('calendar "' + v + '" titleColumns references non-existent column "' + tc + '" in "' + s.table + '"'); });
        // A calendar source's `filter` runs over that ONE table's rows (calEventsFor), so the same proof
        // holds: its columns are that table's columns. A wrong one drops every event of that source off
        // the grid, and a calendar with one source left is still a working calendar — nothing looks broken.
        filterColCheck({ sources: [s.table], filter: s.filter }, 'calendar "' + v + '" source "' + s.table + '"');
      });
      (cvv.rotationSources || []).forEach(function(rs) { if (!rs || !rs.view) errors.push('calendar "' + v + '": each rotationSources entry needs a view'); });
    }
    // RSVP view: the response<->event link is a REQUIRED `ref` column on the responses table pointing at
    // the events table (its valueCol is the event key). There is no linkColumn/eventKey config.
    if (view.rsvp) {
      var rvp = view.rsvp;
      if (!rvp.events || !SCHEMA[rvp.events]) errors.push('rsvp "' + v + '" references non-existent events table "' + rvp.events + '"');
      if (!rvp.responses || !SCHEMA[rvp.responses]) errors.push('rsvp "' + v + '" references non-existent responses table "' + rvp.responses + '"');
      else if (rvp.events && SCHEMA[rvp.events]) {
        var rcols = SCHEMA[rvp.responses].columns || {}, hasLink = false;
        for (var rc in rcols) { var rd = rcols[rc]; if (rd && typeof rd === 'object' && rd.type === 'ref' && rd.table === rvp.events) { hasLink = true; break; } }
        if (!hasLink) errors.push('rsvp "' + v + '": responses table "' + rvp.responses + '" needs a `ref` column pointing at the events table "' + rvp.events + '" (it is the response↔event link — replaces linkColumn/eventKey)');
      }
    }
    // Board (kanban) view: exactly one writable source + a select lane column (drag writes that column).
    if (view.board) {
      var bd = view.board;
      if (!bd.lane) errors.push('board "' + v + '" needs a `lane` column');
      if (!view.sources || view.sources.length !== 1) errors.push('board "' + v + '" needs exactly one source table (drag writes go to one table)');
      else {
        var bt = view.sources[0], bcols = (SCHEMA[bt] && SCHEMA[bt].columns) || {};
        var ld = bcols[bd.lane], lt = (typeof ld === 'string') ? ld : (ld && ld.type);
        if (bd.lane && !ld) errors.push('board "' + v + '" lane "' + bd.lane + '" not found in "' + bt + '"');
        else if (bd.lane && lt !== 'select' && lt !== 'ref') errors.push('board "' + v + '" lane "' + bd.lane + '" in "' + bt + '" must be a select or ref column');
      }
      (bd.laneGroups || []).forEach(function(g) { if (!g || !Array.isArray(g.lanes)) errors.push('board "' + v + '" laneGroups entries need a `lanes` array'); });
    }
    // Stats view: every mistake here renders a tile showing nothing, or a bar with no track, and the
    // view still "works" -- which is exactly the class of silent failure the rest of this function
    // exists for. A stats view is a data view plus a render config, so its sources/filter/aggregate are
    // already checked by the data-view rules above; what is checked here is only the `stats` object.
    if (view.stats) {
      var st = view.stats;
      var stAggs = ['count', 'sum', 'avg', 'min', 'max', 'latest'];
      if (st.perRow && st.tiles) errors.push('stats "' + v + '": use `perRow` OR `tiles`, not both');
      else if (!st.perRow && !Array.isArray(st.tiles)) errors.push('stats "' + v + '" needs `tiles` (an array) or `perRow`');
      // A goal is either a number to measure against or the string "max" (scale to the largest tile).
      // Any other string is silently treated as "no goal" by the engine, so the bar the author asked
      // for simply never appears.
      // A ladder ([100,200,300], or [{at,label}]) must ASCEND: the rung being worked toward is found by
      // scanning, so an out-of-order list picks a nonsense one. The engine sorts defensively; saying so
      // here is what stops the author wondering why their bar re-targeted the wrong way.
      var stTiersOk = function(g, where) {
        if (!g.length) { errors.push('stats "' + v + '" ' + where + ': `goal` list is empty'); return; }
        var prev = null;
        g.forEach(function(e, i) {
          var at = (e && typeof e === 'object' && !Array.isArray(e)) ? e.at : e;
          if (typeof at !== 'number' || !(at > 0)) { errors.push('stats "' + v + '" ' + where + ': `goal` step ' + i + ' must be a positive number (or { at, label })'); return; }
          if (prev !== null && at <= prev) errors.push('stats "' + v + '" ' + where + ': `goal` steps must ascend — ' + at + ' comes after ' + prev);
          prev = at;
        });
      };
      var stGoalOk = function(g, where) {
        if (g === undefined || g === null) return;
        if (g === 'max') return;
        if (Array.isArray(g)) { stTiersOk(g, where); return; }
        if (typeof g !== 'number' || !(g > 0)) errors.push('stats "' + v + '" ' + where + ': `goal` must be a positive number, an ascending list of levels, or "max"');
      };
      // A column name that resolves to nothing fails the same silent way a missing one does: the tile
      // reads every row's `undefined` and shows an em dash forever, which looks like "no data yet".
      // Every neighbouring check names this class of mistake (`valueCol` is not a column of...), and
      // a tile is where it is hardest to spot, since a stats view has no header row to look wrong.
      //
      // Skipped on an aggregate view, for exactly the reason the data-view column check above skips
      // one: its rows carry synthetic columns -- the group key, the aggregate outputs -- that no table
      // declares, so there is nothing here to check them against. That is also the case perRow exists
      // for, so in practice this catches the explicit-tiles mistakes and stays quiet on leaderboards.
      var stCol = function(col, where) {
        if (!col || view.groupBy) return;
        if (!colInSources(col) && !viewDeclaresCol(col)) {
          errors.push('stats "' + v + '" ' + where + ': column "' + col + '" not found in sources [' + (view.sources || []).join(', ') + ']');
        }
      };
      stGoalOk(st.goal, 'view');
      if (st.perRow) {
        if (!st.perRow.label || !st.perRow.value) errors.push('stats "' + v + '": `perRow` needs both `label` and `value` column names');
        stCol(st.perRow.label, 'perRow.label');
        stCol(st.perRow.value, 'perRow.value');
        stGoalOk(st.perRow.goal, 'perRow');
      }
      (st.tiles || []).forEach(function(t, ti) {
        var at = 'tile ' + ti;
        if (!t || typeof t !== 'object') { errors.push('stats "' + v + '" ' + at + ' must be an object'); return; }
        var ag = t.agg || 'count';
        if (stAggs.indexOf(ag) < 0) errors.push('stats "' + v + '" ' + at + ': unknown agg "' + ag + '" (' + stAggs.join('/') + ')');
        // Every aggregate but `count` reads a column. Without one they return null and the tile shows
        // an em dash forever, which looks like "no data yet" rather than like a schema mistake.
        else if (ag !== 'count' && !t.column) errors.push('stats "' + v + '" ' + at + ': `' + ag + '` needs a `column`');
        stCol(t.column, at);
        stGoalOk(t.goal, at);
      });
    }
  }
  // Check list references
  for (var t2 in SCHEMA) { for (var c2 in SCHEMA[t2].columns) {
    var def = SCHEMA[t2].columns[c2];
    if (def && typeof def === 'object' && def.syncFrom && !SCHEMA[def.syncFrom]) errors.push('Table "' + t2 + '": mirror source "' + def.syncFrom + '" not found');
    if (def && typeof def === 'object' && def.type === 'ref' && def.table && !SCHEMA[def.table]) errors.push('Table "' + t2 + '": ref table "' + def.table + '" not found');
  }}
  // Check embed view references and circular embeds
  for (var v3 in VIEWS) {
    (VIEWS[v3].columns || []).forEach(function(c) {
      if (isEmbed(c)) { (c.sources || []).forEach(function(s) { if (!SCHEMA[s]) errors.push('View "' + v3 + '": embed references non-existent table "' + s + '"'); }); }
    });
  }
  // Mirror-cluster archive consistency: a table that syncFrom an ARCHIVABLE master should itself be
  // archivable. delete cascades across the mirror cluster, but archive skips non-archivable tables --
  // so archiving a master row leaves the mirrored detail row behind, and any view over the detail keeps
  // showing the orphan (e.g. a rotation over the stale rows). Advisory: the schema still loads.
  for (var dt in SCHEMA) {
    var dcols = (SCHEMA[dt] && SCHEMA[dt].columns) || {};
    for (var dc in dcols) {
      var dd = dcols[dc], master = (dd && typeof dd === 'object') ? dd.syncFrom : null;
      if (master && SCHEMA[master] && SCHEMA[master].archivable && !SCHEMA[dt].archivable) {
        errors.push('Table "' + dt + '" mirrors archivable "' + master + '" (syncFrom on "' + dc + '") but is not archivable — archiving a "' + master + '" row will orphan its "' + dt + '" row; add "archivable": true to "' + dt + '"');
        break; // one advisory per detail table
      }
    }
  }
  return errors;
}
// Structural dangling-reference check on a raw schema (names only; safe to run pre-normalization, e.g. on import).
function validateRefs(schema) {
  var errs = [], tables = schema.tables || {}, views = {};
  (Array.isArray(schema.views) ? schema.views : []).forEach(function(v) { if (v && v.name) views[v.name] = v; });
  var hasView = function(n) { return !!views[n]; }, hasTable = function(n) { return !!tables[n]; };
  // `userWritableLists` opens named lists to non-admins (list editing is otherwise admin-only). A typo
  // here fails SILENTLY — the list simply stays admin-only — so check the names against the lists that
  // columns actually reference. Same check shape as the nav/view dangling-reference walks below.
  if (schema.userWritableLists !== undefined) {
    if (!Array.isArray(schema.userWritableLists)) errs.push('`userWritableLists` must be an array of list names');
    else {
      var known = listOwnershipMap(tables);
      schema.userWritableLists.forEach(function(n) {
        if (typeof n !== 'string' || !n) errs.push('`userWritableLists` entries must be list names');
        else if (!(n in known)) errs.push('`userWritableLists` -> no column references a list named "' + n + '"');
      });
    }
  }
  Object.keys(views).forEach(function(n) {
    var v = views[n];
    (v.sources || []).forEach(function(s) { if (!hasTable(s)) errs.push('View "' + n + '" -> missing table "' + s + '"'); });
    (v.columns || []).forEach(function(c) {
      if (c && typeof c === 'object' && typeof c.view === 'string' && !hasView(c.view)) errs.push('View "' + n + '" embed -> missing view "' + c.view + '"');
      if (c && typeof c === 'object' && Array.isArray(c.sources)) c.sources.forEach(function(s) { if (!hasTable(s)) errs.push('View "' + n + '" embed -> missing table "' + s + '"'); });
    });
    if (typeof v.markdown === 'string') {
      var re = /\{\{\s*(view|table)\s*:\s*([^\s@?{}:]+)/g, m;
      while ((m = re.exec(v.markdown))) {
        if (m[1] === 'view' && !hasView(m[2])) errs.push('View "' + n + '" markdown -> missing view "' + m[2] + '"');
        if (m[1] === 'table' && !hasTable(m[2])) errs.push('View "' + n + '" markdown -> missing table "' + m[2] + '"');
      }
    }
  });
  (function walk(items) { (items || []).forEach(function(it) {
    if (it.view && !hasView(it.view) && !hasTable(it.view)) errs.push('Nav -> missing view "' + it.view + '"');
    if (it.table && !hasTable(it.table)) errs.push('Nav -> missing table "' + it.table + '"');
    // A truthy non-boolean (e.g. "admin") would hide the entry too, but silently reads as a role name
    // rather than the flag it is — say so rather than let it look like it does something finer.
    if (it.adminOnly !== undefined && typeof it.adminOnly !== 'boolean') errs.push('Nav -> `adminOnly` must be true or false (got ' + JSON.stringify(it.adminOnly) + ')');
    if (it.hideFromAdmin !== undefined && typeof it.hideFromAdmin !== 'boolean') errs.push('Nav -> `hideFromAdmin` must be true or false (got ' + JSON.stringify(it.hideFromAdmin) + ')');
    // Both together hides the entry from EVERYONE, which is never what anyone means by writing them.
    if (it.adminOnly && it.hideFromAdmin) errs.push('Nav -> "' + (it.view || it.table || it.group) + '" sets both `adminOnly` and `hideFromAdmin`, which hides it from every user');
    if (it.items) walk(it.items);
  }); })(schema.nav && schema.nav.items);
  return errs;
}
// NavService: build sidebar/tab model from nav config. Pure function (no Vue dependency).
// t(key): translator, canAccess(id): permission check, opts: {isAdmin, hasLookup}
function buildNavTabs(navItems, t, canAccess, opts) {
  var tabs = [];
  function navTab(it) {
    // `adminOnly` hides an entry (a group and everything under it, or a single view/table) from
    // non-admins; `hideFromAdmin` is its mirror, for the views that are about being a PARTICIPANT —
    // "my chores", "my rewards" — which an admin who only approves is not. Both are TIDINESS, not
    // access control: what a member may read or write is decided by their table grants, and these only
    // keep the wrong menu out of the wrong hands. Put either on a group to hide the whole branch.
    if (it.adminOnly && !opts.isAdmin) return null;
    if (it.hideFromAdmin && opts.isAdmin) return null;
    if (it.group) { var ch = (it.items || []).map(navTab).filter(Boolean); return ch.length ? { id: 'grp:' + it.group, title: t('nav.' + it.group) || it.group, icon: it.icon || 'mdi-folder', children: ch } : null; }
    var gid = it.view || it.table;
    if (!gid || !canAccess(gid)) return null;
    if (it.view && !VIEWS[gid]) return null;
    if (it.table && !SCHEMA[gid]) return null;
    var isV = !!it.view, isDoc = isV && typeof VIEWS[gid].markdown === 'string';
    var isRot = isV && VIEWS[gid] && !!VIEWS[gid].rotation;
    var tb = { id: gid, title: t((isV ? 'view.' : 'tab.') + gid) || gid, icon: it.icon || (isDoc ? 'mdi-file-document-outline' : (isRot ? 'mdi-calendar-clock' : (isV ? 'mdi-view-list' : 'mdi-table'))) };
    if (it.items) { var kids = it.items.map(navTab).filter(Boolean); if (kids.length) tb.children = kids; }
    return tb;
  }
  navItems.forEach(function(it) { var tb = navTab(it); if (tb) tabs.push(tb); });
  tabs.push({ divider: true });
  if (opts.isAdmin) tabs.push({ id: '__languages', title: t('tab.languages'), icon: 'mdi-translate' });
  if (opts.hasLookup) tabs.push({ id: '__lookup', title: t('tab.lookup'), icon: 'mdi-database-outline' });
  tabs.push({ id: '__settings', title: t('tab.settings'), icon: 'mdi-cog-outline' });
  return tabs;
}
