// events.js — The calendar EVENT MODEL: rows + rotation config -> { 'YYYY-MM-DD': [events] }.
// Framework-agnostic and Node-tested, mirroring pivot.js / board.js / print.js.
//   Browser: <script src="/events.js"> after calendar/rotation/rows/access-features; exposes Events.*.
//   Node:    const Events = require('../events').
//
// This was the last piece of the calendar/rotation pipeline still on the Vue root, and it stayed there
// (see the note this replaces in calendar.js) because it is entangled with i18n, access, rotation
// config and dataCache. Those are exactly the things print.js's `_printCtx` and embeds.js's
// `_embedCtx` already carry, so it takes the same seam: pure over an explicit `ctx` the root builds
// (app-core `_eventsCtx()`).
//
// Why it was worth moving rather than leaving: the overlay half kept its OWN copy of how a rotation
// slot and its value resolve, the `rosterRef` fix never reached it, and the shipped chores example
// showed translated chore names in the matrix and untranslated ones in the calendar -- from the same
// rows, in the same deployment, with nothing to notice because the overlay renders something either
// way. That class of bug needs a unit tier to catch, and event building had none.
//
// ctx =
//   { views, dataCache, today(), toDateStr(v), t(k), tOr(k, fallback),
//     displayValue(col, val, ns, viewCfg), canReachTable(tbl), hashColor(key), resolveMeTokens(filter),
//     rotation: { rangeFor(name), anchorFor(name), rotateEveryFor(name),
//                 mineOnlySlot(view), slotsFor(rv), slotLabel(name, slot), valueColFor(name, slot) } }
//
// The `rotation` half is nested rather than flattened because those seven are one question -- how is
// THIS rotation view configured for THIS viewer -- and the root is the only layer that can answer it:
// they read appConfig (per-user anchor/range/rotateEvery overrides), the signed-in identity
// (mineOnly), and dataCache (a rosterRef's slots are values of a lookup, not schema columns).
(function(root) {
  var isNode = typeof module !== 'undefined' && module.exports;
  var Calendar = isNode ? require('./calendar') : root.Calendar;
  var Rotation = isNode ? require('./rotation') : root.Rotation;
  var Rows = isNode ? require('./rows') : root.Rows;
  var AccessFeatures = isNode ? require('./access-features') : root.AccessFeatures;

  // Periods to generate from `fromStr` (the rotation view's OWN start) to reach `toExclusive`. We start
  // from the rotation's own `from` -- not the grid start -- so the numeric slot-swap phase (floor(i/n))
  // matches the rotation view exactly (single source of truth); events are then clipped to the window.
  // 0 when the window ends before the rotation begins.
  function periodsToCover(fromStr, toExclusive, interval) {
    var n = Rotation.wholeIntervalsBetween(fromStr, toExclusive, interval);
    return n < 0 ? 0 : n + 2;
  }

  // A view's own `sources`: ordinary rows placed on the day their dateColumn names.
  // Fail-closed per source -- a table the viewer cannot READ contributes nothing rather than throwing
  // or leaking, which is what lets a calendar be in a member's nav because only ONE of its sources is
  // self-serviceable.
  function rowEvents(name, ctx, out) {
    var calCfg = ctx.views[name] || null;   // the calendar being drawn, for obscureNames: an EMBEDDED
                                            // calendar obscures by its own config, not by the page it sits on
    Calendar.sources(ctx.views, name).forEach(function(s) {
      if (!s || !s.table || !s.dateColumn) return;
      if (!ctx.canReachTable(s.table)) return;
      var rows = Rows.filterRows(ctx.dataCache[s.table] || [], ctx.resolveMeTokens(s.filter));
      var tag = s.label || ctx.t('tab.' + s.table);
      rows.forEach(function(r) {
        var title = (s.titleColumns || []).map(function(c) { return ctx.displayValue(c, r[c], '', calCfg); }).filter(Boolean).join(' — ');
        var d = ctx.toDateStr(r[s.dateColumn]);
        var key = d || '__undated__';                 // an undated row is still the user's row: bucket it
        (out[key] = out[key] || []).push({            // rather than dropping it silently
          id: s.table + ':' + s.dateColumn + ':' + r.id, title: title || tag, label: tag,
          color: ctx.hashColor(s.label || s.table), table: s.table, dateCol: s.dateColumn, row: r
        });
      });
    });
  }

  // A view's `rotationSources`: generated read-only duty events from another view's rotation matrix,
  // bounded to the visible window. Asked through the SAME resolvers the matrix renders with -- slot
  // heading and cell namespace both -- or the same duties read differently in the two places the app
  // shows them.
  function rotationEvents(name, win, ctx, out) {
    Calendar.rotationSources(ctx.views, name).forEach(function(rs) {
      var v = ctx.views[rs.view]; if (!v || !v.rotation) return;
      var rv = v.rotation, rosters = AccessFeatures.viewRosters(v);
      if (rosters.length && !rosters.some(function(t) { return ctx.canReachTable(t); })) return;   // per-roster access (fail-closed)
      var range = ctx.rotation.rangeFor(rs.view);
      var fromStr = (!range.from || range.from === 'today') ? ctx.today() : range.from;
      var interval = rv.interval || 'weekly';
      var periods = periodsToCover(fromStr, win.toExclusive, interval);
      if (!periods) return;
      var rows = Rotation.buildRotationViewRows(v, ctx.dataCache, ctx.today(), ctx.rotation.anchorFor(rs.view),
                                                { from: fromStr, periods: Math.min(periods, 520) }, ctx.rotation.rotateEveryFor(rs.view));
      // Honor the rotation's own mineOnly here too -- an overlay that showed every slot would hand back
      // exactly what the narrowed view withholds.
      var mine = ctx.rotation.mineOnlySlot(v);
      var slots = ctx.rotation.slotsFor(rv).filter(function(s) { return mine === null || String(s).toLowerCase() === mine; });
      var tag = rs.label || ctx.tOr('tab.' + rs.view, rs.view);
      // Slot -> the column whose list labels ITS cells. Both halves of an overlay event's title are
      // shape-dependent, and both are the rotation view's own question, not the calendar's: a
      // `rosterRef` slot is a VALUE of the lookup (so `field.<slot>` never matches) and its cells come
      // from the roster's valueCol (so the slot name resolves no list). Hoisted out of the row loop:
      // it depends only on the view.
      var slotNs = {};
      slots.forEach(function(sl) { slotNs[sl] = ctx.rotation.valueColFor(rs.view, sl) || ''; });
      rows.forEach(function(r) {
        if (r._period < win.from || r._period >= win.toExclusive) return;   // clip to visible grid
        slots.forEach(function(slot) {
          var ppl = r[slot]; if (!(ppl && ppl.length)) return;
          var title = ctx.rotation.slotLabel(rs.view, slot) + ': ' + ctx.displayValue(slot, ppl, slotNs[slot], v);
          (out[r._period] = out[r._period] || []).push({
            id: 'rot:' + rs.view + ':' + slot + ':' + r._period, title: title, label: tag,
            color: ctx.hashColor(rs.label || rs.view), table: null, readOnly: true, row: r
          });
        });
      });
    });
  }

  // The { 'YYYY-MM-DD': [events] } map for a calendar view. Undated rows -> '__undated__'.
  // `win` ({from, toExclusive}) is what bounds rotation generation; without it the overlay is skipped
  // entirely, since generating unbounded periods is what the window exists to prevent.
  function build(name, win, ctx) {
    var out = {};
    rowEvents(name, ctx, out);
    if (win) rotationEvents(name, win, ctx, out);
    // One stable order per day, so two renders of the same data agree and a print matches the screen.
    Object.keys(out).forEach(function(k) {
      out[k].sort(function(a, b) { return (a.label + a.title).localeCompare(b.label + b.title); });
    });
    return out;
  }

  var M = { build: build, periodsToCover: periodsToCover };
  if (isNode) module.exports = M;
  else root.Events = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
