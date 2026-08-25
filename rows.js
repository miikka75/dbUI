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
  // These resolve to the module under Node and to globals hung off the root object in the browser.
  // tsc cannot type that: `module.exports = M` sits inside an `if (isNode)` within this IIFE, so the
  // inferred export shape comes out incomplete, and the globalThis branch has no declarations at all.
  // Both are therefore `any`, which means CALLS THROUGH THESE ARE NOT TYPE-CHECKED. Everything inside
  // each module still is, which is where the value has been so far. Closing this gap needs either
  // .d.ts companions (a second copy of the API to keep in sync -- the exact duplication this codebase
  // is trying to shed) or ES modules; neither is worth doing ahead of the store refactor.
  /** @type {any} */ var Rot = isNode ? require('./rotation') : root;

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
  //   { "f": { "lt"|"gt"|"lte"|"gte": v } }        ordered comparison (see _cmp) — combinable in one object
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
          if ('lt' in c && !(_cmp(v, c.lt) < 0)) return false;
          if ('gt' in c && !(_cmp(v, c.gt) > 0)) return false;
          if ('lte' in c && !(_cmp(v, c.lte) <= 0)) return false;
          if ('gte' in c && !(_cmp(v, c.gte) >= 0)) return false;
        }
      } else {
        if (v !== c) return false;
      }
    }
    return true;
  }

  // Ordered comparison behind lt/gt/lte/gte. Numeric when BOTH sides parse as numbers (so 9 < 10, not
  // "9" > "10"), otherwise a plain string compare — which orders ISO YYYY-MM-DD dates correctly, so a
  // date column works without a separate operator. Returns NaN when either side is blank or missing:
  // every comparison against NaN is false, so an unset value matches NO ordered filter in either
  // direction (fail-closed, matching `within`) instead of silently sorting as zero.
  function _cmp(a, b) {
    if (a == null || a === '' || b == null || b === '') return NaN;
    var na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    var sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // Whole days between a YYYY-MM-DD value and today (or `today`, which tests pin to a fixed date).
  // Parsed at local midnight on both ends and rounded, so a DST boundary inside the span can't turn a
  // whole number of days into 6.96. '' for a missing or unparseable date.
  function _daysSince(dateVal, today) {
    if (!dateVal) return '';
    var from = new Date(String(dateVal).slice(0, 10) + 'T00:00:00');
    var to = new Date(String(today || fmtDate(new Date())).slice(0, 10) + 'T00:00:00');
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return '';
    return Math.round((to.getTime() - from.getTime()) / 86400000);
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

  // ---- Runtime search ---------------------------------------------------------------------------
  // The schema's `filter` is authored: it decides what a view IS. This is the other kind — what the
  // person looking at it wants to see right now — and the app had no way to express it at all. On a
  // list of a hundred members or four years of meetings, typing a name is worth more than any view.
  //
  // Deliberately a SUBSTRING match over the row's text, not the condition language: someone typing
  // into a box is not writing a filter, and `condMatches` cannot express "appears anywhere".
  //
  // Folded before comparing, because the data is not English. `normalize('NFD')` splits an accented
  // letter into its base plus a combining mark, which the class below then strips — so "hameen" finds
  // "Hämeen" and "saestaja" finds "säestäjä". Without it a Finnish name is only findable by someone
  // who can type the diacritic, which on a phone keyboard is most of the point of searching.
  function fold(v) {
    if (v === undefined || v === null) return '';
    var s = Array.isArray(v) ? v.join(' ') : String(v);
    // The regex is built from a range rather than written literally so the file stays ASCII.
    return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() : s.toLowerCase();
  }

  // Columns that carry no meaning to a reader. Searching them would match ids and timestamps, which is
  // never what someone typing into a box means, and `owner` would surface e-mail addresses in a view
  // that deliberately shows display names instead.
  var SEARCH_SKIP = ['id', 'created_at', 'updated_at', 'owner', 'rosterPublic', '_status', '_source'];

  // Every token must appear SOMEWHERE in the row — "kati tup" finds "Kati Tuppurainen" even though no
  // single column contains that string. One substring over the whole term would not, and that is the
  // way people actually type a name they half remember.
  function searchRows(rows, term, cols) {
    var q = fold(term).trim();
    if (!q) return rows || [];                 // no term is not a filter: everything, unchanged
    var tokens = q.split(/\s+/);
    var only = (Array.isArray(cols) && cols.length) ? cols : null;
    return (rows || []).filter(function (r) {
      if (!r || typeof r !== 'object') return false;
      var hay = '';
      if (only) {
        for (var i = 0; i < only.length; i++) hay += ' ' + fold(r[only[i]]);
      } else {
        for (var k in r) { if (SEARCH_SKIP.indexOf(k) < 0) hay += ' ' + fold(r[k]); }
      }
      for (var t = 0; t < tokens.length; t++) if (hay.indexOf(tokens[t]) < 0) return false;
      return true;
    });
  }

  // What a view's `search` setting means, normalized. Mirrors `obscureNames`, which is the same shape
  // for the same reason: `true` is the common case and naming columns is the exception.
  //   absent / false -> null   (no search box)
  //   true           -> []     (every column the row carries, minus bookkeeping)
  //   ["a","b"]      -> those columns
  function searchColumns(cfg) {
    var s = cfg && cfg.search;
    if (!s) return null;
    return Array.isArray(s) ? s.filter(function (c) { return typeof c === 'string' && c; }) : [];
  }

  // ---- Which partition a row is in ------------------------------------------------------------
  // A partition used to be a STORE: `tasks` held the active rows and `tasks__archive` the filed-away
  // ones, and "which partition is this row in" was answered by which of the two it came out of. It is
  // becoming a FIELD instead -- one source, `_status`, and a saved filter -- because as a store it
  // costs a cross-collection move to archive anything (non-atomic, as the backend contract admits), a
  // second read to see history, and a special case in every view kind that has to look at both.
  //
  // Both shapes exist at once for as long as rows written under the old one are still around, so the
  // rule has to cover both: the FIELD wins where it is present, and where it is not the store the row
  // came from still decides. That makes this a no-op on data written before the change -- an active
  // store full of rows with no `_status` reads exactly as it did.
  //
  // Note the transitional case this deliberately admits: a row sitting in the archive STORE carrying
  // `_status: 'active'` counts as active. That state only exists mid-migration, and honouring it is
  // what lets a restore be a field write rather than another cross-store move.
  function partitionOf(row, storePart) {
    var s = row && row._status;
    return (typeof s === 'string' && s) ? s : (storePart || 'active');
  }

  // Every row of one partition for one source, across both stores. This is the single accessor every
  // caller that used to index dataCache by store name should go through: with the two shapes coexisting
  // there is no longer any one key that holds "the archived rows".
  //
  // The archive store is consulted only when it is loaded -- boot no longer fetches it unless
  // `preload_archive` is on -- so a caller that wants history still has to have asked for it. Absent,
  // this returns what the active store knows, which is the same answer it gave before.
  function partitionRows(dataCache, src, part) {
    var want = part || 'active';
    var cache = dataCache || {};
    var out = [], seen = {};
    (cache[src] || []).forEach(function (r) {
      if (partitionOf(r, 'active') !== want) return;
      if (r && r.id != null) seen[r.id] = 1;
      out.push(r);
    });
    // Deduped by id, with the ACTIVE store winning. Migrating a row means writing it to the active
    // store and clearing it from the archive one, and those are two writes with nothing joining them --
    // a failure between leaves the same id in both. Counting it twice would corrupt every total that
    // uses includeArchive, silently, which is worse than the stale copy being ignored until the next
    // migration pass clears it.
    (cache[src + '__archive'] || []).forEach(function (r) {
      if (partitionOf(r, 'archive') !== want) return;
      if (r && r.id != null && seen[r.id]) return;
      out.push(r);
    });
    return out;
  }

  // Merge a view's source tables into one row list (union tags _source; join merges by id), then filter.
  // `part` is the partition to read, 'active' by default. It is a PARAMETER rather than something the
  // caller pre-projects into the cache, because projecting archived rows onto the plain source key and
  // letting this filter them again drops every one of them -- they still carry `_status: 'archive'`.
  function buildRows(cfg, dataCache, part) {
    var want = part || 'active';
    var rows = [];
    var byId = new Map();   // join mode only: id -> the merged row in `rows`
    var sources = cfg.sources || [];
    sources.forEach(function(src) {
      // `includeArchive` folds the archive partition in beside the active one. A view reads only the
      // active rows by default, which is right for a worklist and wrong for a TOTAL: archiving a row
      // would silently remove it from the sum, so a balance that nets earned against spent goes wrong
      // the moment either side ages out (see `archiveAfter`). Opt in wherever the history is the point.
      // Through partitionRows, not dataCache[src]: with `_status` in play the active store can hold a
      // row that is filed away, and the archive store one that has been restored. Indexing by store
      // name would show both in the wrong list.
      var srcRows = partitionRows(dataCache, src, want);
      // `includeArchive` means "the history too", so it folds in whichever partition is NOT being read.
      if (cfg.includeArchive) srcRows = srcRows.concat(partitionRows(dataCache, src, want === 'active' ? 'archive' : 'active'));
      if (cfg.mode === 'join') {
        // Indexed by id rather than a `rows.find` per source row: the scan made a join O(rows^2) in the
        // number of rows already merged. `byId` spans the whole join (all sources), which is exactly the
        // set `find` searched, and holds the SAME row objects the output does, so merging through it
        // mutates the row in `rows`.
        srcRows.forEach(function(r) {
          var e = byId.get(r.id);
          if (e) { Object.assign(e, r); return; }
          var nr = Object.assign({ _source: src }, r);
          byId.set(nr.id, nr);
          rows.push(nr);
        });
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
    // Per-CALL lookup indexes, keyed (table, on). Scoped to the call because `cache` cannot change
    // during one -- the pipeline is synchronous and pure over it -- so nothing here can go stale, and
    // nothing has to be invalidated. Built lazily: a view with no lookup def pays nothing.
    var idx = Object.create(null);
    rows.forEach(function(r) {
      defs.forEach(function(d) {
        // Per-source compute (union views only): apply this def only to rows from `d.source`, which
        // buildRows tags as _source. Two defs writing the SAME output column — one per source table,
        // one of them scaled -1 — is how a single aggregate sums a signed quantity across tables
        // (points earned minus points spent). Rows no def matched keep the column unset, and
        // aggregateRows skips non-numeric cells, so they contribute nothing rather than a zero.
        if (d.source && r._source !== d.source) return;
        _computeInto(r, d, rows, cache, ctx, idx);
        // `scale` multiplies a numeric result (use -1 to subtract in an aggregate). Left alone when the
        // computed value isn't numeric — scaling a name or a rotation array is meaningless, not an error.
        if (d.scale != null) { var sv = Number(r[d.name]); if (!isNaN(sv) && r[d.name] !== '' && r[d.name] != null) r[d.name] = sv * Number(d.scale); }
      });
    });
    return rows;
  }

  // value -> FIRST row of `src` carrying it in `col`. First wins, because the linear scan this replaces
  // stopped at the first hit; a keyed table with a duplicate key resolves to the same row it always did.
  // Rows that aren't objects are skipped rather than thrown on: the index is built eagerly, so a broken
  // row that the old scan would have stopped short of must not take down the whole render.
  function _indexBy(src, col) {
    var m = new Map();
    for (var i = 0; i < src.length; i++) { var r = src[i]; if (!r || typeof r !== 'object') continue; var k = r[col]; if (!m.has(k)) m.set(k, r); }
    return m;
  }

  // One computed def resolved into one row. Split out of resolveComputed so the per-source / scale
  // wrapper above stays readable; the branches are unchanged and mutually exclusive.
  // `idx` is resolveComputed's per-CALL lookup index cache (see there); never null when called from it.
  function _computeInto(r, d, rows, cache, ctx, idx) {
    var comp = d.computed;
    // Rotation columns: index into a pre-authored ordered list (rotationTable) by computed POSITION
    // (occurrence count or elapsed calendar intervals). Output is the slot's value (often an array).
    if (comp.rotationTable) {
      var rot = cache[comp.rotationTable] || [];
      if (comp.advanceBy === 'occurrence') {
        // Occurrence rank must be ABSOLUTE, so archiving a past occurrence never renumbers future
        // ones. When the occurrenceSource is an archivable mirror (e.g. usher turns mirroring
        // meetings), archived rows still count toward the rank. They sort before the active rows
        // (earlier dates), so an active row keeps its index as earlier rows move to the archive
        // (+1 archived, -1 active cancel). Without this, archiving one meeting slides the whole
        // roster by a slot. Falls back to the view rows when no explicit occurrenceSource.
        var occSrc = comp.occurrenceSource
          ? (cache[comp.occurrenceSource] || []).concat(cache[comp.occurrenceSource + '__archive'] || [])
          : rows;
        r[d.name] = Rot.resolveByOccurrence(rot, occSrc, r, comp.occurrenceSort, comp.valueCol);
      } else if (comp.advanceBy === 'calendar') {
        var target = comp.dateField ? r[comp.dateField] : (ctx && ctx.todayDate);
        r[d.name] = Rot.resolveByCalendar(rot, target, Rot.resolveAnchorDate(comp, ctx && ctx.rotationAnchor), comp.interval, comp.valueCol);
      } else {
        r[d.name] = [];
      }
      return;
    }
    // daysSince: whole days from a date column to today — the age of a row. Negative for a future date.
    // Recomputed every render (never stored), so an "overdue" filter re-evaluates as the day rolls over.
    // A blank/unparseable date yields '' rather than 0, so `empty` still reads correctly and the ordered
    // operators (which treat '' as incomparable) leave undated rows out of both < and > filters.
    if (comp.daysSince) {
      r[d.name] = _daysSince(r[comp.daysSince], ctx && ctx.todayDate);
      return;
    }
    // Lookup: denormalize ONE field from a keyed/referenced table into this row. Matches the local
    // column `lookup.match` against the target table's `lookup.on` column (defaults to the same name)
    // and copies `lookup.field`. General — reusable for chore->points, member->role/phone, etc.
    if (comp.lookup) {
      // Indexed once per (table, on) per resolveComputed call, not scanned per row: this runs on every
      // view render, and a chore-log row looking up points on the chores table made the render path
      // O(rows x lookupTable) -- the only super-linear term in it. Map, not a plain object, because the
      // scan compared with === : an object would coerce every key to a string and make 1 match "1".
      var lk = comp.lookup, onCol = lk.on || lk.match, ikey = lk.table + '|' + onCol;
      var lmap = idx[ikey] || (idx[ikey] = _indexBy(cache[lk.table] || [], onCol));
      var lhit = lmap.get(r[lk.match]);
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
    compareValues: compareValues, listOrderFor: listOrderFor,
    partitionOf: partitionOf, partitionRows: partitionRows,
    searchRows: searchRows, searchColumns: searchColumns, fold: fold
  };
  if (isNode) module.exports = M;
  else { root.Rows = M; for (var k in M) root[k] = M[k]; } // also expose each as a global for bare callers
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
// ^ globalThis (not `this`): in Node CJS, module-scope `this` is module.exports, and the runtime-bound
//   lookups (root._listsCache / root.getColumnList) must see the real global that tests assign to.
