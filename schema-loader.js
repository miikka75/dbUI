// localStorage shim for Apps Script sandbox (where localStorage is undefined)
if (typeof localStorage === 'undefined') { window.localStorage = { _d:{}, getItem:function(k){return this._d[k]||null;}, setItem:function(k,v){this._d[k]=String(v);}, removeItem:function(k){delete this._d[k];}, clear:function(){this._d={};} }; }

// Default schema bundled in app — used when Drive has no schema.json yet
var defaultSchema = {"tables":{},"views":[]};

// Active schema — initially from defaultSchema, overwritten from Drive on boot
var SCHEMA = defaultSchema.tables;
var _viewsNav = Array.isArray(defaultSchema.views) ? defaultSchema.views : [];var VIEWS = {};
function _flattenViews(arr) { (arr || []).forEach(function(v) { if (v.name && (v.sources || typeof v.markdown === 'string' || v.rotation || v.calendar || v.pivot || v.rsvp || v.board)) VIEWS[v.name] = v; if (v.views) _flattenViews(v.views); }); }
// (Legacy `pages` map / {page:} nav and `text` entries are removed features with no load-time
//  handling; a legacy schema must be hand-upgraded to markdown doc-views. See SCHEMA.md.)
_flattenViews(_viewsNav);
var DEFAULT_LANGUAGE = defaultSchema.defaultLanguage || null;

// Schema helpers
function getColumns(table) { if (!SCHEMA[table]) return []; return window._columnOrders && window._columnOrders[table] ? window._columnOrders[table] : Object.keys(SCHEMA[table].columns); }
// id is implicit: auto-inject into every table so schemas needn't declare it. It stays the storage PK and join/archive key.
function ensureImplicitId(schema, orders) {
  Object.keys(schema).forEach(function(t) {
    var cols = schema[t].columns; if (!cols) return;
    if (!cols.id) { cols.id = 'text'; if (orders && orders[t] && orders[t].indexOf('id') === -1) orders[t].unshift('id'); }
  });
}
// Shared schema normalization: strip dead text entries + set globals + colMap + ensureImplicitId. Returns nothing; mutates globals.
function _normalizeSchema(parsed) {
  convertViewFilters(parsed.views);   // upgrade legacy array-IN ({col:[a,b]})->$or and shorthand conditional cols ({col:{cond}})->{name,when}
  SCHEMA = parsed.tables || SCHEMA;
  _viewsNav = Array.isArray(parsed.views) ? parsed.views : _viewsNav;
  VIEWS = {};
  _flattenViews(_viewsNav);
  window._columnOrders = {};
  Object.keys(SCHEMA).forEach(function(t) {
    if (Array.isArray(SCHEMA[t].columns)) {
      var colMap = {}; window._columnOrders[t] = [];
      SCHEMA[t].columns.forEach(function(c) { if (!c.name) return; window._columnOrders[t].push(c.name); var def = Object.assign({}, c); delete def.name; colMap[c.name] = Object.keys(def).length ? def : 'text'; });
      SCHEMA[t].columns = colMap;
    } else { window._columnOrders[t] = Object.keys(SCHEMA[t].columns || {}); }
  });
  ensureImplicitId(SCHEMA, window._columnOrders);
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
  function walk(filter) {
    if (!filter || typeof filter !== 'object') return;
    if (filter.$or || filter.$and) { (filter.$or || filter.$and).forEach(walk); return; }
    for (var col in filter) {
      if (col[0] === '$') continue;
      var ln = Columns.colIsList(SCHEMA, col);   // memoized any-table scan; was hand-rolled in 4 places
      if (!ln && Columns.colIsRef(SCHEMA, col)) {                          // a ref filter column (e.g. a 2-D board
        for (var rt in SCHEMA) { var rf = Columns.columnRef(SCHEMA, rt, col); if (rf && rf.table) { ln = rf.table; break; } }
      }                                                                    // lane): pin under its lookup TABLE name
      if (!ln) continue;
      var vals = Array.isArray(filter[col]) ? filter[col] : [filter[col]];
      vals.forEach(function(val) { if (typeof val === 'string' && !isFilterToken(val)) cb(ln, val); });
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
  var set = base.slice();
  for (var i = 0; i < set.length; i++) {           // grows as tables are discovered -> transitive closure
    var t = set[i], cols = (SCHEMA[t] && SCHEMA[t].columns) || {};
    for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.syncFrom && set.indexOf(d.syncFrom) < 0) set.push(d.syncFrom); } // upstream masters
    for (var mt in SCHEMA) {                        // downstream tables mirroring t
      if (set.indexOf(mt) >= 0) continue;
      var mc = SCHEMA[mt].columns || {};
      for (var k in mc) { var md = mc[k]; if (md && typeof md === 'object' && md.syncFrom === t) { set.push(mt); break; } }
    }
  }
  return set;
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
  for (var v in VIEWS) {
    var view = VIEWS[v];
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
    // Check columns exist in at least one source (skip aggregate views)
    if (!view.groupBy) (view.columns || []).forEach(function(c) {
      if (isEmbed(c) || isViewEmbed(c) || isText(c) || (c && typeof c === 'object' && c.computed)) return;
      var col = colName(c);
      var found = (view.sources || []).some(function(s) { return SCHEMA[s] && SCHEMA[s].columns && SCHEMA[s].columns[col]; });
      if (!found) errors.push('View "' + v + '": column "' + col + '" not found in sources [' + (view.sources || []).join(', ') + ']');
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
    // non-admins. This is TIDINESS, not access control -- what a member may read or write is decided by
    // their table grants, and this only keeps admin-facing plumbing out of their menu. Put it on the
    // group to hide the whole branch.
    if (it.adminOnly && !opts.isAdmin) return null;
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
