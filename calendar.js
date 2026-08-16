// calendar.js — Pure calendar geometry + the canonical date-string primitive. Shared by app-core.js
// (browser) and Node unit tests, mirroring columns.js / access-features.js.
//   Browser: <script src="/calendar.js">, then Calendar.* ; also exposes fmtDate() as a global (the app's
//            canonical local YYYY-MM-DD formatter — schema-loader.js + app-core.js call it bare).
//   Node:    const Calendar = require('../calendar');
//
// Grid/window builders are pure functions of (anchor, weekStart, today); source resolvers are pure over
// the VIEWS map. The event-bucketing (calEventsFor) stays on the root — it's entangled with i18n, access,
// rotation config, and dataCache — but reads its geometry through here.
(function(root) {
  // Canonical local YYYY-MM-DD formatter for a Date.
  function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // 42-cell (6x7) month grid whose weeks start on `weekStart` (0=Sun..1=Mon), containing `anchor`.
  // `today` (a 'YYYY-MM-DD' string) drives the isToday flag; `anchor` defaults to it.
  function cellsMonth(anchor, weekStart, today) {
    var p = (anchor || today).split('-'), y = +p[0], m = +p[1] - 1;
    var first = new Date(y, m, 1), off = ((first.getDay() - weekStart) + 7) % 7, start = new Date(y, m, 1 - off), cells = [];
    for (var i = 0; i < 42; i++) { var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), key = fmtDate(dt); cells.push({ date: key, day: dt.getDate(), inMonth: dt.getMonth() === m, isToday: key === today }); }
    return cells;
  }
  // 7-cell week strip (weekStart-aligned) containing `anchor`.
  function cellsWeek(anchor, weekStart, today) {
    var p = (anchor || today).split('-'), dt0 = new Date(+p[0], +p[1] - 1, +p[2]);
    var off = ((dt0.getDay() - weekStart) + 7) % 7, start = new Date(dt0.getFullYear(), dt0.getMonth(), dt0.getDate() - off), cells = [];
    for (var i = 0; i < 7; i++) { var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i), key = fmtDate(dt); cells.push({ date: key, day: dt.getDate(), isToday: key === today }); }
    return cells;
  }
  // Visible grid window {from, toExclusive} for a calendar anchor+mode (month/list -> month grid, week
  // -> strip). Bounds rotation generation to what's on screen.
  function windowFor(anchor, mode, weekStart, today) {
    var cells = (mode === 'week') ? cellsWeek(anchor || today, weekStart, today) : cellsMonth(anchor || today, weekStart, today);
    var last = cells[cells.length - 1].date.split('-');
    return { from: cells[0].date, toExclusive: fmtDate(new Date(+last[0], +last[1] - 1, +last[2] + 1)) };
  }
  // Deterministic palette color for an event key (stable across renders). Colors a calendar event's
  // label, a rotation overlay, and a board card's left stripe (`board.color`).
  //
  // The mixing is load-bearing, and the obvious cheap hash is the wrong one here. The previous
  // `h*31 + c` collapsed entirely: 31 % 10 === 1 and the palette has 10 entries, so multiplying by 31
  // is the IDENTITY modulo the palette length and the whole thing degenerated to (sum of char codes)
  // % 10. Any two names whose letters sum alike collided — in the chores example Ann, Bob, Cara and Dan
  // all came out the same pink, a board "colored by person" that encoded nothing.
  //   FNV-1a alone does not fix it either: its avalanche is weak in the LOW bits, and `% 10` reads
  // exactly those. So the FNV pass is followed by murmur3's fmix32 finalizer, which folds the high bits
  // down before the modulo. Measured over 24 names: old = 7 in the worst bucket, FNV alone = 6,
  // FNV+fmix32 = 4, against ~2.4 for a perfect split.
  //   A hash into a FIXED palette can never promise distinct colors — 10 buckets, birthday paradox —
  // so this is a legibility improvement, not a guarantee. There is no legend either way.
  var PALETTE = ['#5b8def', '#26a69a', '#ab47bc', '#ef6c00', '#66bb6a', '#ec407a', '#8d6e63', '#c62828', '#00897b', '#7e57c2'];
  // The palette BY INDEX. A caller that already has a stable ordering (a list-backed column: the k-th
  // member of `members`) should use this instead of hashing, because it is the only way to actually get
  // distinct colors — hashing n values into 10 buckets collides ~70% of the time at n=5, which is how a
  // four-person household ended up sharing one color.
  function paletteAt(i) { return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }
  function hashColor(key) {
    var pal = PALETTE;
    var s = String(key || ''), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;   // fmix32: mix the high bits down so `% pal`
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;   // is not reading FNV's weakest bits
    h ^= h >>> 16;
    return pal[(h >>> 0) % pal.length];
  }
  // A calendar view's source specs (single-source `source` sugar -> one-element list).
  function sources(views, name) {
    var v = views[name]; if (!v || !v.calendar) return [];
    var c = v.calendar;
    return c.sources || [{ table: c.source, dateColumn: c.dateColumn, titleColumns: c.titleColumns, filter: c.filter, label: c.label }];
  }
  // Rotation views overlaid on a calendar as generated read-only duty events.
  function rotationSources(views, name) { var v = views[name]; return (v && v.calendar && v.calendar.rotationSources) || []; }

  var C = {
    fmtDate: fmtDate, cellsMonth: cellsMonth, cellsWeek: cellsWeek, windowFor: windowFor,
    hashColor: hashColor, paletteAt: paletteAt, sources: sources, rotationSources: rotationSources
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Calendar = C; root.fmtDate = fmtDate; }
})(typeof self !== 'undefined' ? self : this);
