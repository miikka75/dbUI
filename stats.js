// stats.js — Pure KPI-tile builder: turn a row list into a handful of headline numbers, each
// optionally measured against a goal so it can be drawn as a progress bar. The ZERO-dimensional
// member of the aggregate family — rows.js `aggregate` collapses rows to a list (one row per group),
// pivot.js to a grid (two axes), and this to single numbers. Framework-agnostic + Node-tested,
// mirroring pivot.js / board.js / rsvp.js / rotation.js.
//   Browser: <script src="/stats.js"> after rows.js. Node: const Stats = require('../stats').
//
// It deliberately does NOT read tables, filter by view, or group. Those already exist and are better
// tested where they live: a stats view carries the same `sources`/`filter`/`groupBy`/`aggregate`/
// `compute` a data view does, the root feeds the resulting rows in here, and this only decides what
// number to show and how wide the bar is. That is the whole reason the feature is small.
//
// Two modes, mutually exclusive:
//
//   tiles   — explicit tiles over the WHOLE row set. Each names an aggregate:
//               { label, agg, column, goal, when, display, decimals }
//             `agg` is count | sum | avg | min | max | latest. `column` is required by all but count.
//             `when` narrows the rows for that tile only (the shared condition language), which is how
//             "signed in today" and "signed in this week" become two tiles over one view.
//
//   rowTiles  — ONE TILE PER ROW, for a view that has already aggregated. { label: <col>, value: <col> }
//             names which column is the caption and which the number, so an existing leaderboard
//             (person -> total) renders as a column of bars with no new data plumbing at all.
//             `goal: { column: <col> }` reads the target off the ROW too, which is what lets one view
//             hold targets that differ per row (bedding monthly, bins weekly), and
//             `order: "behind"` ranks by how much of its own goal each row has reached rather than by
//             raw value -- "what is neglected" instead of "who is winning".
//
// `goal` sets the bar's 100% mark. A number is an absolute target ("120 sign-ins"). The string "max"
// means "the largest value among these tiles", which is what a leaderboard wants — the leader's bar is
// full and everyone else is drawn relative to them. Resolved AFTER every value is computed, since it
// cannot be known before. No goal at all -> `pct` is null and the tile is just a number.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // Resolved the same way embeds.js does it: the module under Node, globals off the root in the
  // browser. Only `condMatches` is used, and only by a tile that declares `when`.
  /** @type {any} */ var Rows = isNode ? require('./rows') : root;

  function num(v) { var n = Number(v); return isNaN(n) ? null : n; }

  // One aggregate over an already-narrowed bucket of rows.
  //
  // Blank cells are SKIPPED rather than read as zero, matching rows.js aggregateRows. The difference
  // is only visible on avg/min — a table where half the rows never filled the column in would
  // otherwise report an average dragged toward zero by rows that said nothing, which reads as a real
  // decline rather than as missing data.
  function reduce(rows, agg, col) {
    if (agg === 'count') return rows.length;
    var vals = [];
    for (var i = 0; i < rows.length; i++) {
      var raw = rows[i][col];
      if (raw == null || raw === '') continue;
      vals.push(raw);
    }
    // `latest` is the LAST non-empty value in the order the rows arrived. It does not sort: the view
    // has a defaultSort and has already been through sortByCol by the time these rows get here, so
    // sorting again would silently disagree with what the same view shows as a list.
    if (agg === 'latest') return vals.length ? vals[vals.length - 1] : null;
    var nums = [];
    for (var j = 0; j < vals.length; j++) { var n = num(vals[j]); if (n !== null) nums.push(n); }
    if (!nums.length) return agg === 'sum' ? 0 : null;   // a sum of nothing is 0; an average/min of nothing is not a number
    if (agg === 'sum') return nums.reduce(function(s, n) { return s + n; }, 0);
    if (agg === 'min') return Math.min.apply(null, nums);
    if (agg === 'max') return Math.max.apply(null, nums);
    if (agg === 'avg') return nums.reduce(function(s, n) { return s + n; }, 0) / nums.length;
    return null;                                          // unknown agg — validateSchema rejects it at load
  }

  // Only `avg` is rounded, and only because it is the one aggregate that manufactures digits the data
  // never had (7/3 = 2.3333333333333335 in a tile is noise). Everything else is returned exactly as it
  // came out of the column: rounding a sum or a min would corrupt a decimal quantity to make it prettier.
  function roundAvg(v, decimals) {
    if (typeof v !== 'number') return v;
    var d = (decimals == null) ? 1 : decimals;
    var f = Math.pow(10, d);
    return Math.round(v * f) / f;
  }

  // --- Tiered goals -------------------------------------------------------------------------------
  // A `goal` may be a LADDER instead of one number: [100, 200, 300], or with names,
  // [{at:100,label:"Bronze"}, …]. The bar then measures against the next rung up, so reaching a level
  // re-targets it at the one after — which is what a points scheme wants, since a fixed goal stops
  // saying anything the moment it is met.
  //
  // The bar runs from ZERO to the next rung, not from the previous rung. "Bar max sets to the next
  // level" is the literal reading, and it keeps the whole ladder legible: at 250 of 100/200/300 the bar
  // is 83% of the way up the scheme, not 50% through one band. (Measuring within the band is the other
  // defensible choice; it is simply not this one.)
  function normTiers(list) {
    var out = [];
    (list || []).forEach(function(e) {
      var at = num(e && typeof e === 'object' ? e.at : e);
      if (at === null || !(at > 0)) return;            // validateSchema reports these; skip rather than throw
      out.push({ at: at, label: (e && typeof e === 'object' && e.label) ? e.label : null });
    });
    // Sorted rather than trusted: the resolution below is a scan, so an out-of-order ladder would
    // otherwise pick a nonsense rung. validateSchema rejects one at load; this keeps the engine total.
    return out.sort(function(a, b) { return a.at - b.at; });
  }

  // A goal of `{ column: <col> }` is a target the ROW carries: each chore measured against the cadence
  // that chore keeps, rather than every tile against one number. It is resolved HERE, while the source
  // row is still in hand, because the pass that turns rawGoal into a bar runs over the built tiles and
  // no longer has one. Resolving it to a plain number also means everything downstream — "max", the
  // ladder, the pct/over arithmetic — keeps working unchanged and unaware.
  //
  // A row whose target column is blank or non-numeric resolves to null, which is the same "no goal"
  // every other unusable goal produces: the tile shows its number with no bar. That is the honest
  // reading — a chore nobody has set a cadence for has no bar to be short of.
  function rowGoal(g, row) {
    if (!g || typeof g !== 'object' || Array.isArray(g) || !g.column) return g;
    return num(row[g.column]);
  }

  // How much of its OWN goal a tile has reached, as a fraction. The sort key for `order: "behind"`,
  // and null for a tile there is no answer for -- no goal, or a value that is not a number.
  //
  // The RATIO, not the shortfall (`goal - value`). Shortfall is dominated by whichever row has the
  // biggest goal -- wash-up 28 short outranks bedding 1 short every time, however complete the
  // bedding is -- which puts every row back on one scale, the exact thing a per-row goal exists to
  // escape. It is also computed from value/goal rather than read off `pct`, which is rounded for
  // display: 1/20 and 1/19 are both "5%" on screen and must not become a tie in the order.
  function reached(t) {
    if (t.goal === null || typeof t.value !== 'number') return null;
    return t.value / t.goal;
  }

  // -> { goal, tier } : the rung being worked toward, and the highest rung actually reached (or null).
  // Past the top rung the goal STAYS there, so the bar reads full and `over` carries the overshoot —
  // the same contract a plain numeric goal has.
  function resolveTiers(value, tiers) {
    if (!tiers.length) return { goal: null, tier: null };
    var reached = null, next = null;
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i].at <= value) reached = tiers[i];
      else if (next === null) next = tiers[i];
    }
    return { goal: (next || tiers[tiers.length - 1]).at, tier: reached };
  }

  function build(rows, opts) {
    rows = rows || [];
    opts = opts || {};
    var defDisplay = opts.display || 'bar';
    var out = [];

    if (opts.rowTiles) {
      var rt = opts.rowTiles;
      rows.forEach(function(r) {
        out.push({
          label: r[rt.label] == null ? '' : r[rt.label],
          labelCol: rt.label,                      // so the renderer can run it through displayValue
          value: num(r[rt.value]),
          rawGoal: rowGoal(rt.goal !== undefined ? rt.goal : opts.goal, r),
          display: rt.display || defDisplay
        });
      });
    } else {
      (opts.tiles || []).forEach(function(t) {
        var bucket = t.when ? rows.filter(function(r) { return Rows.condMatches(r, t.when); }) : rows;
        var v = reduce(bucket, t.agg || 'count', t.column);
        if ((t.agg || 'count') === 'avg') v = roundAvg(v, t.decimals);
        out.push({
          label: t.label || '',
          labelCol: null,
          value: v,
          rawGoal: (t.goal !== undefined ? t.goal : opts.goal),
          display: t.display || defDisplay,
          column: t.column || null                 // lets the renderer format through the column's type
        });
      });
    }

    // "max" resolves against the tiles that actually produced a NUMBER. A `latest` tile showing a
    // status string is not part of the scale, and a max of 0 (an empty period, everyone on zero)
    // leaves every bar at null rather than dividing by it.
    var peak = 0;
    out.forEach(function(t) { if (typeof t.value === 'number' && t.value > peak) peak = t.value; });

    out.forEach(function(t) {
      var raw = t.rawGoal;
      delete t.rawGoal;
      t.tier = null;
      var g;
      if (Array.isArray(raw)) {
        // A ladder is per-TILE by nature: on a rowTiles leaderboard each person is measured against the
        // rung they are personally working toward, so the bars answer "how close am I to the next
        // level" rather than "how do I compare". `goal: "max"` is the one that answers the other.
        var r = resolveTiers(typeof t.value === 'number' ? t.value : -Infinity, normTiers(raw));
        g = r.goal;
        t.tier = r.tier;
      } else {
        g = raw === 'max' ? peak : num(raw);
      }
      t.goal = (g && g > 0) ? g : null;
      // A bar is only drawn for a numeric value against a positive goal. `pct` is clamped to 0..100 so
      // the bar cannot overflow its track, and `over` carries the fact that it would have — the two
      // together let a renderer show "138 / 120" with a full bar rather than pretending the goal was met
      // exactly, or silently rendering a 138%-wide element.
      if (t.goal === null || typeof t.value !== 'number') { t.pct = null; t.over = false; return; }
      var pct = (t.value / t.goal) * 100;
      t.over = pct > 100;
      t.pct = Math.max(0, Math.min(100, Math.round(pct)));
    });

    // `behind` answers "what is neglected", against the default's "who is winning". A tile with no
    // goal has no answer and sorts LAST rather than first, which is the rule sortRosterRows settled
    // for a missing `position` -- absent means no opinion, not zero. Array.sort is stable, so tiles
    // that tie (0/1 and 0/30 are both nothing done) keep the ranking they arrived in, and there is no
    // second-order rule to invent.
    if (opts.rowTiles && opts.rowTiles.order === 'behind') {
      out.sort(function(a, b) {
        var x = reached(a), y = reached(b);
        if (x === null) return y === null ? 0 : 1;
        if (y === null) return -1;
        return x - y;
      });
    }
    // Applied LAST, so `limit` means "the first N in the order asked for" rather than "the first N
    // aggregateRows happened to hand over". Nothing changes for the default order -- the rows arrive
    // ranked, so ordering them by rank is a no-op and the top-ranked tile is the `max` peak either
    // way -- but "the five most neglected" is inexpressible if the slice happens first.
    if (opts.rowTiles && opts.limit) out = out.slice(0, opts.limit);

    return { tiles: out };
  }

  var M = { build: build };
  if (isNode) module.exports = M;
  else root.Stats = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
