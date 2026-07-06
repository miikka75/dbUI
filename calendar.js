// calendar.js — Pure calendar geometry + the canonical date-string primitive. Shared by app-core.html
// (browser) and Node unit tests, mirroring columns.js / access-features.js.
//   Browser: <script src="/calendar.js">, then Calendar.* ; also exposes fmtDate() as a global (the app's
//            canonical local YYYY-MM-DD formatter — schema-loader.html + app-core.html call it bare).
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
  // Deterministic palette color for an event key (stable across renders).
  function hashColor(key) {
    var pal = ['#5b8def', '#26a69a', '#ab47bc', '#ef6c00', '#66bb6a', '#ec407a', '#8d6e63', '#c62828', '#00897b', '#7e57c2'];
    var s = String(key || ''), h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return pal[h % pal.length];
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
    hashColor: hashColor, sources: sources, rotationSources: rotationSources
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Calendar = C; root.fmtDate = fmtDate; }
})(typeof self !== 'undefined' ? self : this);
