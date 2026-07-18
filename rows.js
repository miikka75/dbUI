// rows.js — Pure view row pipeline: build (union/join) -> filter (condMatches) -> aggregate ->
// computed columns -> sort. Extracted from schema-loader.js so the pipeline gets real Node unit
// tests (dev/test previously re-implemented "simulated" unions/aggregates instead of testing this).
//   Browser: <script src="/rows.js"> after calendar.js + rotation.js. Exposes Rows.* AND each function
//            as a global (schema-loader.js internals, app-core.js and the tests call them bare) —
//            so it must load before the schema-loader fragment.
//   Node:    const Rows = require('../rows');
//
// Runtime-bound globals (looked up through `root` at call time, never captured):
//   root._listsCache   — the loaded named lists (matchList/notMatchList operators, list-ordered sort).
//                        Node tests set global._listsCache.
//   root.getColumnList — SCHEMA-bound column->list resolver (defined by app-core.js in the browser).
//                        Only the list-ordered branch of sortByCol needs it; guarded when absent.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // fmtDate from calendar.js; rotation resolvers from rotation.js (globals in the browser, required in Node).
  var fmtDate = isNode ? require('./calendar').fmtDate : root.fmtDate;
  var Rot = isNode ? require('./rotation') : root;

  // Unified per-row condition matcher. Single source of truth for BOTH row filtering (view/embed
  // `filter`, via condMatches/filterRows) AND column/embed visibility (conditional columns, the `when`
  // clause, embedWhenOk — via isColumnHidden/embedWhenOk). True = row matches.
  // Forms (a field maps to a scalar = equality, or an operator object):
  //   { "$or": [ ... ] } / { "$and": [ ... ] }   logical groups (nestable)
  //   { "f": "v" }                                 equality
  //   { "f": { "matchList": "L" } }                value is in named list L (dynamic, Lookup tab)
  //   { "f": { "notMatchList": "L" } }             value is NOT in named list L
  //   { "f": { "notEmpty": true } }                value is truthy (set) — works on computed values
  //   { "f": { "empty": true } }                   value is falsy (blank)
  //   { "f": { "ne": v } }                         !==  (equality is the scalar form above)
  // Membership is expressed with `$or` of equalities (array-IN shorthand was retired; convertViewFilters
  // upgrades any legacy `{f:[a,b]}` to `$or` at load). Empty/absent cond => true.
  function condMatches(item, cond) {
    if (!cond || typeof cond !== 'object') return true;
    item = item || {};
    if (cond.$or) return cond.$or.some(function(s) { return condMatches(item, s); });
    if (cond.$and) return cond.$and.every(function(s) { return condMatches(item, s); });
    for (var k in cond) {
      if (k[0] === '$') continue;
      var c = cond[k], v = item[k];
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        if (c.matchList) { var _L = root._listsCache && root._listsCache[c.matchList]; var _ok = _L && (Array.isArray(v) ? v.some(function(x){ return _L.indexOf(x) >= 0; }) : _L.indexOf(v) >= 0); if (!_ok) return false; }
        else if (c.notMatchList) { var _Ln = root._listsCache && root._listsCache[c.notMatchList]; var _hit = _Ln && (Array.isArray(v) ? v.some(function(x){ return _Ln.indexOf(x) >= 0; }) : _Ln.indexOf(v) >= 0); if (_hit) return false; }
        else if ('within' in c) { if (!_withinPeriod(v, c.within)) return false; }
        else {
          if (c.notEmpty && !v) return false;
          if (c.empty && v) return false;
          if ('ne' in c && v === c.ne) return false;
        }
      } else {
        if (v !== c) return false;
      }
    }
    return true;
  }

  // Relative period membership for the `within` filter operator. Token: @today|@day|@week|@month|@year,
  // with an optional back-offset (@month-1 = last month, @week-2 = two weeks ago). Computed from *now*
  // each call, so it auto-resets (a `@month` leaderboard rolls to the new month automatically). Weeks are
  // Monday-start. Compares the row's YYYY-MM-DD date against [start, end) as ISO strings (lexicographic).
  function _withinPeriod(dateVal, token) {
    if (!dateVal) return false;
    var m = /^@(today|day|week|month|year)(?:-(\d+))?$/.exec(String(token || '').trim());
    if (!m) return false;
    var unit = (m[1] === 'day') ? 'today' : m[1], back = m[2] ? parseInt(m[2], 10) : 0;
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var start, end;
    if (unit === 'today') { start = new Date(now); start.setDate(start.getDate() - back); end = new Date(start); end.setDate(end.getDate() + 1); }
    else if (unit === 'week') { var dow = (now.getDay() + 6) % 7; start = new Date(now); start.setDate(now.getDate() - dow - back * 7); end = new Date(start); end.setDate(start.getDate() + 7); }
    else if (unit === 'month') { start = new Date(now.getFullYear(), now.getMonth() - back, 1); end = new Date(start.getFullYear(), start.getMonth() + 1, 1); }
    else { start = new Date(now.getFullYear() - back, 0, 1); end = new Date(start.getFullYear() + 1, 0, 1); }
    var ds = String(dateVal).slice(0, 10);
    return ds >= fmtDate(start) && ds < fmtDate(end);
  }

  function filterRows(rows, filter) { if (!filter) return rows; return rows.filter(function(r) { return condMatches(r, filter); }); }

  // Rewrite array-IN filter values ({col:[a,b]}) into explicit $or of equalities, recursively.
  // Used by export + migrate so the array shorthand can eventually be retired; runtime still accepts both.
  function filterToOr(f) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return f;
    if (f.$or) return { $or: f.$or.map(filterToOr) };
    if (f.$and) return { $and: f.$and.map(filterToOr) };
    var keys = Object.keys(f);
    if (!keys.some(function(k) { return Array.isArray(f[k]); })) return f; // no array values -> leave flat (AND)
    var clauses = keys.map(function(k) {
      var v = f[k];
      if (Array.isArray(v)) return { $or: v.map(function(x) { var o = {}; o[k] = x; return o; }) };
      var o = {}; o[k] = v; return o;
    });
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  // Walk a views array: upgrade legacy array-IN filters to $or (view/groupBy/embed/conditional/when),
  // and canonicalize the legacy shorthand conditional column { "<col>": {cond} } -> { name, when }.
  function convertViewFilters(views) {
    (views || []).forEach(function(v) {
      if (v.filter) v.filter = filterToOr(v.filter);
      if (v.groupBy && v.groupBy.filter) v.groupBy.filter = filterToOr(v.groupBy.filter);
      (function walkCols(cols) {
        if (!Array.isArray(cols)) return;
        cols.forEach(function(c, i) {
          if (!c || typeof c !== 'object') return;
          if (c.filter) c.filter = filterToOr(c.filter);
          if (c.when) c.when = filterToOr(c.when);
          if (!c.name && !c.sources && !c.view && !c.markdown && !c.computed) { // legacy shorthand conditional column { "<col>": {cond} }
            var ck = Object.keys(c)[0];
            if (ck && c[ck] && typeof c[ck] === 'object' && !Array.isArray(c[ck])) {
              cols[i] = { name: ck, when: filterToOr(c[ck]) }; // canonicalize to { name, when } — one syntax
              return;
            }
          }
          if (Array.isArray(c.columns)) walkCols(c.columns);
        });
      })(v.columns);
    });
  }

  // THE comparator for every sortable surface (the data grid, embed defaultSort, rsvp, pivot). Views
  // that aren't a data grid address their values differently -- pivot by cell index, rsvp by an event
  // field -- so the reusable unit is a value comparator, not a row/column one.
  //   asc===false  -> descending. Blanks always sort LAST, in both directions.
  //   listOrder    -> optional {value: index}; list-backed values follow the list's authored order.
  function compareValues(va, vb, asc, listOrder) {
    if (listOrder) {
      var ia = listOrder[va] !== undefined ? listOrder[va] : 9999;
      var ib = listOrder[vb] !== undefined ? listOrder[vb] : 9999;
      return asc === false ? ib - ia : ia - ib;
    }
    var ea = (va == null || va === ''), eb = (vb == null || vb === '');
    if (ea && eb) return 0;
    if (ea) return 1; if (eb) return -1;                       // blanks last regardless of direction
    // Real numbers (an aggregate's count/sum, a pivot cell) compare numerically; anything else is
    // coerced before localeCompare, which only exists on strings. numeric:true keeps string-stored
    // numbers ("2" before "10") ordering correctly, so both storage shapes agree.
    if (typeof va === 'number' && typeof vb === 'number') return asc === false ? vb - va : va - vb;
    var sa = String(va), sb = String(vb);
    return asc === false ? sb.localeCompare(sa, undefined, { numeric: true })
                         : sa.localeCompare(sb, undefined, { numeric: true });
  }

  // Resolve a column's list order, if it is list-backed (via root.getColumnList + root._listsCache,
  // both runtime-bound). `view` lets an aggregate's groupBy column inherit its source column's list.
  function listOrderFor(col, view) {
    var gcl = root.getColumnList;
    var ln = gcl ? gcl(null, col) : null;
    if (!ln && gcl && view && view.groupBy && typeof view.groupBy === 'object' && view.groupBy.column === col && view.groupBy.from) {
      for (var i = 0; i < view.groupBy.from.length && !ln; i++) ln = gcl(null, view.groupBy.from[i]);
    }
    if (!ln || !root._listsCache || !root._listsCache[ln]) return null;
    var order = {}; root._listsCache[ln].forEach(function(v, i) { order[v] = i; });
    return order;
  }

  // Sort rows by a column name. `asc` defaults to true (embed defaultSort has no direction control).
  function sortByCol(rows, col, view, asc) {
    if (!col) return rows;
    var listOrder = listOrderFor(col, view);
    return rows.slice().sort(function(a, b) { return compareValues(a[col], b[col], asc !== false, listOrder); });
  }

  // Merge a view's source tables into one row list (union tags _source; join merges by id), then filter.
  function buildRows(cfg, dataCache) {
    var rows = [];
    var sources = cfg.sources || [];
    sources.forEach(function(src) {
      var srcRows = dataCache[src] || [];
      if (cfg.mode === 'join') {
        srcRows.forEach(function(r) { var e = rows.find(function(x) { return x.id === r.id; }); if (e) Object.assign(e, r); else rows.push(Object.assign({ _source: src }, r)); });
      } else {
        srcRows.forEach(function(r) { rows.push(Object.assign({}, r, { _source: src })); });
      }
    });
    return filterRows(rows, cfg.filter);
  }

  // Aggregate a groupBy/collect view's rows into one row per key (collected values -> Nth columns).
  function aggregateRows(view, rows) {
    // Leaderboard-style numeric aggregate: one row per group with a count or a sum, ranked highest-first.
    // aggregate = { count:true } | { sum:"<col>" }, optional `into` (output column, default "total").
    if (view.aggregate && view.groupBy) {
      var akeyCol = view.groupBy.column, akeysFrom = view.groupBy.from || [akeyCol];
      var agg = view.aggregate, sumCol = agg.sum, into = agg.into || 'total', agf = view.groupBy.filter || null;
      var totals = {};
      rows.forEach(function(r) {
        akeysFrom.forEach(function(k) {
          var key = r[k];
          if (key == null || key === '') return;
          if (agf) { var tmp = {}; tmp[akeyCol] = key; if (!condMatches(tmp, agf)) return; }
          if (totals[key] == null) totals[key] = 0;
          if (sumCol) { var n = Number(r[sumCol]); if (!isNaN(n)) totals[key] += n; }
          else totals[key] += 1;
        });
      });
      return Object.keys(totals).map(function(key) { var row = { id: key }; row[akeyCol] = key; row[into] = totals[key]; return row; })
        .sort(function(a, b) { return b[into] - a[into]; });   // rank: highest total first
    }
    if (!(view.groupBy && view.collect)) return rows;
    var keyCol = view.groupBy.column;
    var keysFrom = view.groupBy.from;
    var withRole = view.collectWith; // e.g. "role" — if set, collected values include the source column name
    var groups = {};
    var groupFilter = view.groupBy.filter || null;
    rows.forEach(function(r) {
      keysFrom.forEach(function(k) {
        var key = r[k];
        if (!key || !r[view.collect]) return;
        if (groupFilter) { var tmp = {}; tmp[keyCol] = key; if (!condMatches(tmp, groupFilter)) return; }
        if (!groups[key]) groups[key] = [];
        groups[key].push(withRole ? { date: r[view.collect], role: k } : r[view.collect]);
      });
    });
    var valCols = (view.columns || []).filter(function(c) { return c !== keyCol; });
    return Object.keys(groups).map(function(key) {
      var vals = groups[key].sort(function(a, b) { var da = withRole ? a.date : a, db = withRole ? b.date : b; return da > db ? -1 : da < db ? 1 : 0; });
      var row = { id: key };
      row[keyCol] = key;
      for (var i = 0; i < valCols.length; i++) {
        var v = vals[i];
        row[valCols[i]] = !v ? '' : withRole ? v.date + ' (' + v.role + ')' : v;
      }
      return row;
    });
  }

  function resolveComputed(rows, columns, ctx) {
    if (!columns) return rows;
    var defs = [];
    (Array.isArray(columns) ? columns : []).forEach(function(c) {
      if (c && typeof c === 'object' && c.name && c.computed) defs.push(c);
    });
    if (!defs.length) return rows;
    var cache = (ctx && ctx.dataCache) || {};
    rows.forEach(function(r) {
      defs.forEach(function(d) {
        var comp = d.computed;
        // Rotation columns: index into a pre-authored ordered list (rotationTable) by computed POSITION
        // (occurrence count or elapsed calendar intervals). Output is the slot's value (often an array).
        if (comp.rotationTable) {
          var rot = cache[comp.rotationTable] || [];
          if (comp.advanceBy === 'occurrence') {
            r[d.name] = Rot.resolveByOccurrence(rot, cache[comp.occurrenceSource] || rows, r, comp.occurrenceSort);
          } else if (comp.advanceBy === 'calendar') {
            var target = comp.dateField ? r[comp.dateField] : (ctx && ctx.todayDate);
            r[d.name] = Rot.resolveByCalendar(rot, target, Rot.resolveAnchorDate(comp, ctx && ctx.rotationAnchor), comp.interval);
          } else {
            r[d.name] = [];
          }
          return;
        }
        // Lookup: denormalize ONE field from a keyed/referenced table into this row. Matches the local
        // column `lookup.match` against the target table's `lookup.on` column (defaults to the same name)
        // and copies `lookup.field`. General — reusable for chore->points, member->role/phone, etc.
        if (comp.lookup) {
          var lk = comp.lookup, lsrc = cache[lk.table] || [], onCol = lk.on || lk.match, lkey = r[lk.match], lhit = null;
          for (var li = 0; li < lsrc.length; li++) { if (lsrc[li][onCol] === lkey) { lhit = lsrc[li]; break; } }
          r[d.name] = (lhit && lhit[lk.field] != null) ? lhit[lk.field] : (lk.default != null ? lk.default : '');
          return;
        }
        var ml = comp.matchList;
        if (!ml || !root._listsCache) return;
        if (typeof ml === 'string') {
          // String matchList: collect values from fromColumns that are in the named list
          var list = root._listsCache[ml] || [];
          var vals = (comp.fromColumns || []).reduce(function(acc, c) { var x = r[c]; if (Array.isArray(x)) { acc.push.apply(acc, x); } else if (x != null && x !== '') { acc.push(x); } return acc; }, []).filter(function(v) { return list.indexOf(v) >= 0; });
          r[d.name] = vals.join(', ');
        } else if (typeof ml === 'object') {
          // Object matchList: categorize fromColumn value by which list it belongs to
          var src = r[comp.fromColumn];
          r[d.name] = '';
          for (var ln in ml) { if (root._listsCache[ln] && root._listsCache[ln].indexOf(src) >= 0) { r[d.name] = ml[ln]; break; } }
        }
      });
    });
    return rows;
  }

  // A filter value that is a per-user TOKEN, not a literal value. '@me' is rewritten to the signed-in
  // user's profile display name at filter time (resolveMeTokens in app-core), so it must never be
  // seeded into a list or locked: doing so offers it in a select picker, lets it be stored as data
  // (a phantom "@me" person that no @me filter can ever match), and mints a list.<list>.@me
  // translation key. Add any future token here so both seeding and locking skip it.
  function isFilterToken(v) { return v === '@me'; }

  var M = {
    condMatches: condMatches, _withinPeriod: _withinPeriod, filterRows: filterRows, filterToOr: filterToOr,
    convertViewFilters: convertViewFilters, sortByCol: sortByCol, buildRows: buildRows,
    aggregateRows: aggregateRows, resolveComputed: resolveComputed, isFilterToken: isFilterToken,
    compareValues: compareValues, listOrderFor: listOrderFor
  };
  if (isNode) module.exports = M;
  else { root.Rows = M; for (var k in M) root[k] = M[k]; } // also expose each as a global for bare callers
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
// ^ globalThis (not `this`): in Node CJS, module-scope `this` is module.exports, and the runtime-bound
//   lookups (root._listsCache / root.getColumnList) must see the real global that tests assign to.
