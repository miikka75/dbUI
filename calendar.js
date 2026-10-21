// calendar.js — Pure calendar geometry + the canonical date-string primitive. Shared by app-core.js
// (browser) and Node unit tests, mirroring columns.js / access-features.js.
//   Browser: <script src="/calendar.js">, then Calendar.* ; also exposes fmtDate() and toDateStr() as
//            globals (the app's canonical local YYYY-MM-DD formatters — schema-loader.js + app-core.js
//            call them bare).
//   Node:    const Calendar = require('../calendar');
//
// Grid/window builders are pure functions of (anchor, weekStart, today); source resolvers are pure over
// the VIEWS map. The event-bucketing that reads these lives in /events.js — it is entangled with i18n,
// access, rotation config and dataCache, so it takes those through an explicit ctx rather than staying
// on the Vue root, which is where it used to be.
(function(root) {
  // Canonical local YYYY-MM-DD formatter for a Date.
  function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // The same primitive for a STORED value: a 'YYYY-MM-DD' string passes through untouched (never
  // round-tripped through Date, which would apply the local timezone to a date that has none), anything
  // else is parsed and formatted, and empty stays empty.
  // It lived in schema-loader.js, which is a browser-only fragment that exports nothing -- so the two
  // pure modules that format dates (print.js, events.js) each had to be HANDED it through their ctx,
  // and their tests had to stub or re-implement it. It is a pure function of fmtDate, which is here,
  // so this is where it belongs; app-core keeps calling it bare through the global below.
  function toDateStr(v) { if (!v) return ''; var s = String(v); if (s.length === 10) return s; return fmtDate(new Date(s)); }

  // A stored date as a PERSON reads it, in `locale` (`22.09.2026` in fi, `09/22/2026` in en-US). This is
  // a second function beside toDateStr on purpose: toDateStr is a NORMALIZER whose output is a key --
  // events.js buckets by it and rotation.js builds _period from fmtDate -- so localizing it would break
  // grouping for a change that is only about how a cell looks. Use this where a date is rendered to a
  // person and nowhere else; an <input type="date"> :value still wants the key.
  // 2-digit day/month rather than dateStyle:'short' (`22.9.2026` in fi), so the label agrees with the
  // native picker in the one place the two can. A value that is not a real date falls back to its key.
  var labelFmts = {};
  function dateLabel(v, locale) {
    var key = toDateStr(v); if (!key) return '';
    var p = key.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]);
    if (isNaN(d.getTime())) return key;
    var f = labelFmts[locale] || (labelFmts[locale] = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }));
    return f.format(d);
  }

  // A `datetime` value (an ISO instant) as a person reads it: the date label and the local time. A plain
  // date passes through as dateLabel, so a caller need not ask which it holds.
  var timeFmts = {};
  function dateTimeLabel(v, locale) {
    var s = String(v || ''); if (s.length <= 10) return dateLabel(s, locale);
    var d = new Date(s); if (isNaN(d.getTime())) return s;
    var f = timeFmts[locale] || (timeFmts[locale] = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }));
    return dateLabel(s, locale) + ' ' + f.format(d);
  }
  // An <input type="datetime-local"> speaks local wall time with no zone (`2026-10-13T18:40`); the stored
  // value is the UTC instant. These two are the only crossing between them.
  function toLocalInput(v) {
    var d = v ? new Date(v) : null; if (!d || isNaN(d.getTime())) return '';
    return fmtDate(d) + 'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fromLocalInput(s) {
    if (!s) return ''; var d = new Date(s); return isNaN(d.getTime()) ? '' : d.toISOString();
  }

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
    if (mode === 'year') return periodFor(anchor, mode, weekStart, today);
    var cells = (mode === 'week') ? cellsWeek(anchor || today, weekStart, today) : cellsMonth(anchor || today, weekStart, today);
    var last = cells[cells.length - 1].date.split('-');
    return { from: cells[0].date, toExclusive: fmtDate(new Date(+last[0], +last[1] - 1, +last[2] + 1)) };
  }
  // The PERIOD a calendar shows -- its week, month or year, not the grid (which pads a month out to whole
  // weeks). {from, toExclusive}. A list is its month. What `within: { calendar }` filters by.
  function periodFor(anchor, mode, weekStart, today) {
    var a = anchor || today, p = a.split('-');
    if (mode === 'week') { var c = cellsWeek(a, weekStart, today), l = c[6].date.split('-'); return { from: c[0].date, toExclusive: fmtDate(new Date(+l[0], +l[1] - 1, +l[2] + 1)) }; }
    if (mode === 'year') return { from: p[0] + '-01-01', toExclusive: (+p[0] + 1) + '-01-01' };
    return { from: fmtDate(new Date(+p[0], +p[1] - 1, 1)), toExclusive: fmtDate(new Date(+p[0], +p[1], 1)) };
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
  // Plan a copy of the rows dated in [from, to], `times` spans on from `target`, by local days.
  // Carries only `keep` + the date; skips copies that already exist. -> { rows, skipped, first, last }
  function copyPlan(rows, existing, o) {
    var none = { rows: [], skipped: 0, first: '', last: '' };
    var isDay = function(s) { return /^\d{4}-\d\d-\d\d$/.test(String(s || '')); };
    if (!o || !o.dateColumn || !isDay(o.from) || !isDay(o.to) || !isDay(o.target)) return none;
    var dayNum = function(s) { var p = String(s).split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5; };
    var plus = function(s, n) { var p = String(s).split('-'); return fmtDate(new Date(+p[0], +p[1] - 1, +p[2] + n)); };
    var from = dayNum(o.from), to = dayNum(o.to), times = Math.floor(Number(o.times));
    if (to < from || !(times >= 1)) return none;
    var span = to - from + 1, lead = dayNum(o.target) - from, dc = o.dateColumn, keep = o.keep || [];
    var shift = function(v, n) {
      var s = String(v);
      if (s.length === 10) return plus(s, n);
      var d = new Date(s); d.setDate(d.getDate() + n); return d.toISOString();
    };
    var moment = function(v) { var s = String(v || ''); return s.length === 10 ? s : new Date(s).toISOString(); };
    var key = function(r, when) { return JSON.stringify([keep.map(function(c) { return r[c] == null ? '' : r[c]; }), moment(when)]); };
    var seen = {};
    (existing || []).forEach(function(r) { if (r && r[dc]) seen[key(r, r[dc])] = 1; });
    var out = [], skipped = 0;
    (rows || []).forEach(function(r) {
      var d = r && toDateStr(r[dc]); if (!d) return;
      var dn = dayNum(d); if (dn < from || dn > to) return;
      for (var k = 0; k < times; k++) {
        var when = shift(r[dc], lead + k * span), kk = key(r, when);
        if (seen[kk]) { skipped++; continue; }
        seen[kk] = 1;
        var p = {}; keep.forEach(function(c) { if (r[c] !== undefined) p[c] = r[c]; });
        p[dc] = when;
        out.push(p);
      }
    });
    return { rows: out, skipped: skipped, first: plus(o.target, 0), last: plus(o.target, times * span - 1) };
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
    fmtDate: fmtDate, toDateStr: toDateStr, dateLabel: dateLabel, dateTimeLabel: dateTimeLabel, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput, cellsMonth: cellsMonth, cellsWeek: cellsWeek, windowFor: windowFor, periodFor: periodFor,
    hashColor: hashColor, paletteAt: paletteAt, sources: sources, rotationSources: rotationSources, copyPlan: copyPlan
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Calendar = C; root.fmtDate = fmtDate; root.toDateStr = toDateStr; }
})(typeof self !== 'undefined' ? self : this);
