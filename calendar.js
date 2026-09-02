// calendar.js — Pure calendar geometry + the canonical date-string primitive. Shared by app-core.js
// (browser) and Node unit tests, mirroring columns.js / access-features.js.
//   Browser: <script src="/calendar.js">, then Calendar.* ; also exposes fmtDate() as a global (the app's
//            canonical local YYYY-MM-DD formatter — schema-loader.js + app-core.js call it bare).
//   Node:    const Calendar = require('../calendar');
//
// Grid/window builders are pure functions of (anchor, weekStart, today); source resolvers are pure over
// the VIEWS map. The event-bucketing that reads these lives in /events.js — it is entangled with i18n,
// access, rotation config and dataCache, so it takes those through an explicit ctx rather than staying
// on the Vue root, which is where it used to be.
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
  // Deterministic palette color for a categorical key (stable across renders). Colors a calendar
  // event's label, a rotation overlay, and a board card's left stripe (`board.color`).
  //
  // The palette is DELIBERATELY not derived from the schema `theme`. Those roles are semantic —
  // `primary` means interactive, `error` means danger, `success` means good — while a categorical color
  // means only "this one is not that one". Reusing a status color for identity would make danger-red
  // mean "this person is Cara". There are also only ~4 usable hues among the editable roles (the rest
  // are grounds and ink) where this needs eight, and a brand pasted into Settings -> Theme cannot be
  // validated in advance: nothing stops it being eight shades of teal. Brand control, if it is ever
  // wanted, belongs in its own key that is validated on the way in.
  //
  // These eight clear every hard gate on both surfaces (lightness band, chroma floor, adjacent-pair CVD
  // separation, normal-vision floor) — the ORDER is part of that, not cosmetic, since the gates are
  // checked on adjacent pairs and adjacent slots are exactly what neighbouring list values land on.
  // The previous ten did not: #8d6e63 sat under the chroma floor (it read gray) and against #ec407a
  // gave CVD dE 4.6, under the floor of 6 — a red-blind viewer could not tell brown from pink. Two more
  // were outside the lightness band on the dark surface, which is why there are now two sets: dark is
  // its own stepping of the same eight hues, not an automatic flip.
  var PALETTE = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
  };
  function _pal(mode) { return PALETTE[mode === 'dark' ? 'dark' : 'light']; }
  // The palette BY INDEX. A caller with a stable ordering (a list-backed column: the k-th member of
  // `members`) uses this instead of hashing, because it is the only way to actually get distinct colors
  // — hashing n values into a fixed palette collides ~70% of the time at n=5, which is how a four-person
  // household ended up sharing one. Distinct for the first PALETTE.length values; past that it wraps,
  // so a ninth value twins with the first.
  function paletteAt(i, mode) { var p = _pal(mode); return p[((i % p.length) + p.length) % p.length]; }
  // Hash for keys with no ordering to borrow (a calendar source label, free text). FNV-1a followed by
  // murmur3's fmix32: the obvious `h*31 + c` collapsed outright, because 31 % 10 === 1 against the old
  // ten-slot palette made the multiply the identity modulo the length and reduced the whole hash to
  // (sum of char codes) % 10. FNV alone is not enough either — its avalanche is weak in the LOW bits,
  // which is exactly what the modulo reads — so fmix32 folds the high bits down first.
  function hashColor(key, mode) {
    var pal = _pal(mode);
    var s = String(key || ''), h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
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
