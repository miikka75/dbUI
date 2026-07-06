// rotation.js — Pure rotation engine: interval math + the rotationView row generator + the calendar/
// occurrence resolvers that computed columns use. Extracted from schema-loader.html so the app's most
// intricate logic (rotateEvery slot-swap cycling, calendar looping) gets fast Node unit tests. Its only
// external dependency is calendar.js's fmtDate.
//   Browser: <script src="/rotation.js"> after calendar.js. Exposes Rotation.* AND each function as a
//            global (schema-loader.html's resolveComputed/validateSchema + app-core.html + tests call
//            them bare) — so it must load before the schema-loader fragment.
//   Node:    const Rotation = require('../rotation');
(function(root) {
  // fmtDate comes from calendar.js: require() in Node; the global it set in the browser (loaded first).
  var fmtDate = (typeof module !== 'undefined' && module.exports) ? require('./calendar').fmtDate : root.fmtDate;

  function resolveByOccurrence(rotationRows, sourceRows, currentRow, sortKey) {
    if (!rotationRows || !rotationRows.length || !currentRow) return [];
    var sorted = (sourceRows || []).slice().sort(function(a, b) {
      var av = sortKey ? String(a[sortKey] || '') : '', bv = sortKey ? String(b[sortKey] || '') : '';
      if (av !== bv) return av.localeCompare(bv);
      return String(a.id || '').localeCompare(String(b.id || '')); // stable tie-break
    });
    var index = sorted.findIndex(function(r) { return r.id === currentRow.id; });
    if (index === -1) return [];
    var cells = sortRosterRows(rotationRows);
    return cells[index % cells.length].people;
  }

  // Order roster rows by their `position` (the 1..n value the arrow-button reorder writes). Rows with an
  // empty / missing / non-numeric position keep their insertion order AFTER all positioned rows, so
  // PARTIAL position data (e.g. rows added via addRow before any reorder) never scrambles the rotation
  // — previously `(position||0)` coerced "" to 0 and floated unpositioned rows to the front. Array.sort
  // is stable, so equal keys (incl. all-unpositioned) preserve insertion order.
  function sortRosterRows(rows) {
    return rows.slice().sort(function(a, b) {
      var pa = (a.position === '' || a.position == null) ? NaN : Number(a.position);
      var pb = (b.position === '' || b.position == null) ? NaN : Number(b.position);
      var ka = isNaN(pa) ? Infinity : pa, kb = isNaN(pb) ? Infinity : pb;
      return ka === kb ? 0 : ka - kb;
    });
  }

  // Calendar mode: position = whole intervals elapsed between anchorDate and targetDate. Looping via
  // negative-safe modulo. Independent of whether any row exists for a given interval.
  function resolveByCalendar(rotationRows, targetDate, anchorDate, interval) {
    if (!rotationRows || !rotationRows.length || !targetDate || !anchorDate) return [];
    var elapsed = wholeIntervalsBetween(anchorDate, targetDate, interval);
    var cells = sortRosterRows(rotationRows);
    var index = ((elapsed % cells.length) + cells.length) % cells.length;
    return cells[index].people;
  }

  // Resolve the calendar anchor (the date of slot position 0). A literal `anchorDate` on the column
  // wins (fixed/printable one-off schedules); otherwise the single app-wide anchor (folder config
  // `rotationAnchor`, passed in as globalAnchor) is used — one global date for all rotations, stored
  // as synced config rather than a schema literal or per-row column. Returns null if neither is set.
  function resolveAnchorDate(spec, globalAnchor) {
    return (spec && spec.anchorDate) || globalAnchor || null;
  }

  // Parse an interval spec into { count, unit } where unit ∈ d|w|m. Accepts named aliases
  // (daily/weekly/monthly/yearly) and the compact
  // "<n><d|w|m|y>" form (e.g. "1d", "3w", "2m", "1y"). Years normalize to months (1y = 12m) so
  // month/year share calendar arithmetic. Unparseable input falls back to weekly (validation rejects
  // bad values at load, so this fallback only guards against malformed runtime data).
  function parseInterval(interval) {
    var aliases = { daily: '1d', weekly: '1w', monthly: '1m', yearly: '1y' };
    var s = aliases[interval] || interval || '1w';
    var m = /^(\d+)\s*([dwmy])$/.exec(String(s).trim().toLowerCase());
    if (!m) return { count: 1, unit: 'w' };
    var n = parseInt(m[1], 10) || 1, u = m[2];
    if (u === 'y') { u = 'm'; n *= 12; }
    return { count: n, unit: u };
  }

  // True if `interval` is an accepted spec (named alias or "<n><d|w|m|y>"). Validation uses this so
  // typos surface at load instead of silently resolving to weekly.
  function isValidInterval(interval) {
    if (interval == null) return false;
    var named = { daily: 1, weekly: 1, monthly: 1, yearly: 1 };
    if (named[interval]) return true;
    return /^\d+\s*[dwmy]$/.test(String(interval).trim().toLowerCase());
  }

  // Whole intervals between two YYYY-MM-DD dates. Day/week use uniform arithmetic; month/year use real
  // calendar arithmetic (never days/30). Multi-count specs (e.g. "3w") floor-divide the base-unit count
  // — floor(floor(x/a)/b) === floor(x/(ab)) for positive a,b, so this stays correct (incl. negatives).
  function wholeIntervalsBetween(anchor, target, interval) {
    var a = new Date(anchor), t = new Date(target);
    if (isNaN(a) || isNaN(t)) return 0;
    var p = parseInterval(interval), base;
    if (p.unit === 'm') {
      base = (t.getFullYear() - a.getFullYear()) * 12 + (t.getMonth() - a.getMonth());
      if (t.getDate() < a.getDate()) base -= 1; // not a full month until the anchor day-of-month is reached
    } else {
      var days = Math.floor((t - a) / 86400000);
      base = (p.unit === 'w') ? Math.floor(days / 7) : days; // 'd' = raw days
    }
    return Math.floor(base / p.count);
  }

  // Inverse of wholeIntervalsBetween: add n whole intervals to a YYYY-MM-DD date, return YYYY-MM-DD.
  function addIntervals(dateStr, n, interval) {
    var d = new Date(dateStr), p = parseInterval(interval), step = n * p.count;
    if (p.unit === 'm') { d.setMonth(d.getMonth() + step); }
    else if (p.unit === 'w') { d.setDate(d.getDate() + step * 7); }
    else { d.setDate(d.getDate() + step); } // 'd'
    return fmtDate(d);
  }

  // rotation: the third view kind. Generates `range.periods` rows from `range.from` (calendar mode
  // only — occurrence rotations render inside ordinary data views). Pure function of (rotation tables,
  // range, global anchor) — no stored rows. Two forms:
  //   (a) columns: each area column fixed to its own rotationTable.
  //   (b) areas+lists (rotating): the list→area assignment cyclically rotates one step every
  //       `rotateEvery` periods — generalizes "swap" (2 lists, rotateEvery 1) to N lists / M areas.
  //       Each list still advances on its OWN length; only which list feeds which area rotates.
  //       `rotateEvery` may be a list of summed swap sources: a positive int n (rotate every n periods)
  //       or "cycle" (rotate once per full roster cycle so EVEN-length rosters alternate slots). E.g.
  //       [1,"cycle"] = per-period swap AND per-cycle swap. A scalar is shorthand for a 1-element list.
  function buildRotationViewRows(view, dataCache, todayStr, rotationAnchor, rangeOverride, rotateEveryOverride) {
    var rv = view && view.rotation; if (!rv) return [];
    var range = rangeOverride || rv.range || {}; // DB-backed per-view range override (folder config) wins over schema
    var periods = range.periods || 12;
    var from = (!range.from || range.from === 'today') ? todayStr : range.from;
    var out = [], i, target, row;

    if (rv.slots && rv.rosters) {
      var slots = rv.slots, rosters = rv.rosters, N = rosters.length;
      var interval = rv.interval || 'weekly';
      // DB-backed per-view rotateEvery override (folder config) wins over schema, like anchor/range.
      // undefined override = use schema; a present value (incl. []) is a full replacement.
      var rotateEveryEff = (rotateEveryOverride === undefined) ? rv.rotateEvery : rotateEveryOverride;
      var anchor = resolveAnchorDate(rv, rotationAnchor);
      // Slot-swap sources. `rotateEvery` is a list of independent offsets that are SUMMED into s, then
      // slot k <- rosters[(k + s) % N] (a bijection for any integer s -> never double-books). Each source:
      //   * positive integer n -> floor(i/n) % N (period swap: rotate one step every n periods).
      //   * "cycle"            -> floor((phase+i)/L) % N where L = live roster length (rosters[0]) and
      //     phase aligns the boundary to the global anchor -- rotates once per FULL roster cycle so even-
      //     length rosters alternate slots every duty turn (fixes the parity lock).
      // A scalar is shorthand for a 1-element list (rotateEvery: 1 == [1]); 0/absent == no swap.
      // Common: [1] fast only, ["cycle"] per-cycle only, [1,"cycle"] both. Member index within a roster
      // advances one step per period (resolveByCalendar) independent of these offsets.
      var sources = (rotateEveryEff == null) ? []
        : (Array.isArray(rotateEveryEff) ? rotateEveryEff : [rotateEveryEff]);
      var cycleLen = sources.indexOf('cycle') >= 0 ? ((dataCache[rosters[0]] || []).length || 0) : 0;
      // Absolute period index origin: periods from the rotation ANCHOR to the window start. Both swap
      // sources key off this absolute index so the assignment for a given date is invariant to `from`
      // (the display window) -- moving the window never reshuffles who is in which slot.
      var base = anchor ? wholeIntervalsBetween(anchor, from, interval) : 0;
      for (i = 0; i < periods; i++) {
        target = addIntervals(from, i, interval);
        row = { id: 'rv' + i, _period: target };
        var abs = base + i;   // absolute period index measured from the anchor
        var s = 0;
        if (N) sources.forEach(function(src) {
          if (src === 'cycle') { if (cycleLen > 0) s += Math.floor(abs / cycleLen) % N; }
          else if (typeof src === 'number' && src > 0) { s += Math.floor(abs / src) % N; }
        });
        slots.forEach(function(slot, k) {
          var rosterName = N ? rosters[(((k + s) % N) + N) % N] : null;
          row[slot] = resolveByCalendar(dataCache[rosterName] || [], target, anchor, interval);
        });
        out.push(row);
      }
      return out;
    }

    var cols = rv.columns || [];
    var stepInterval = (cols[0] && cols[0].interval) || 'weekly'; // date axis follows the first column
    for (i = 0; i < periods; i++) {
      target = addIntervals(from, i, stepInterval);
      row = { id: 'rv' + i, _period: target };
      cols.forEach(function(c) { var rot = dataCache[c.rotationTable] || []; row[c.name] = resolveByCalendar(rot, target, resolveAnchorDate(c, rotationAnchor), c.interval); });
      out.push(row);
    }
    return out;
  }

  var M = {
    resolveByOccurrence: resolveByOccurrence, sortRosterRows: sortRosterRows, resolveByCalendar: resolveByCalendar,
    resolveAnchorDate: resolveAnchorDate, parseInterval: parseInterval, isValidInterval: isValidInterval,
    wholeIntervalsBetween: wholeIntervalsBetween, addIntervals: addIntervals, buildRotationViewRows: buildRotationViewRows
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else { root.Rotation = M; for (var k in M) root[k] = M[k]; } // also expose each as a global for bare callers
})(typeof self !== 'undefined' ? self : this);
