// timeline.js — Pure timeline/gantt builder: rows with a START and an END date, placed as bars across
// a window divided into periods. Framework-agnostic + Node-tested, mirroring board.js / pivot.js.
//   Browser: <script src="/timeline.js"> after rotation.js; then Timeline.build(rows, opts).
//   Node:    const Timeline = require('../timeline').
//
// This is the shape the calendar cannot hold. A calendar places a row on ONE day (its dateColumn), so
// anything spanning days is either invisible or reduced to its start. A timeline's unit is the SPAN.
//
// opts:
//   start     column holding the start date (required)
//   end       column holding the end date. Absent or empty on a row -> a bar of exactly one period,
//             which is also what makes a single-date table render here without being reshaped.
//   from      window start, 'YYYY-MM-DD' (required)
//   periods   how many periods the window covers (required, >= 1)
//   interval  period size, in rotation.js's vocabulary: 'daily' | 'weekly' | 'monthly' or '<n><d|w|m|y>'
//             (default 'weekly'). Reused rather than reinvented so "a week" means the same thing here
//             as it does in a rotation, including multi-count specs like '2w'.
//
// Returns { periods: ['YYYY-MM-DD', ...], bars: [bar] } where each bar is
//   { row, start, end, offset, span, clippedStart, clippedEnd }
// `offset` is the index of the period the bar begins in and `span` how many periods it covers, both
// CLAMPED to the window; `clippedStart`/`clippedEnd` say the real range continues past the edge, so a
// renderer can show that rather than implying the work begins or ends at the window boundary.
//
// A row is DROPPED when it has no usable start, or when its range does not intersect the window at all.
// Dropping is the honest answer for the second case -- a zero-width bar at the edge would claim the row
// is here, which is exactly the misreading a chart is supposed to prevent.
(function(root) {
  var isNode = typeof module !== 'undefined' && module.exports;
  var Rotation = isNode ? require('./rotation') : root.Rotation;

  // 'YYYY-MM-DD' out of whatever the cell holds; '' when there is nothing usable. Deliberately strict:
  // a bar is a claim about two specific dates, and guessing at a half-parsed one draws a wrong span
  // rather than no span.
  function dateOf(v) {
    if (!v) return '';
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    return isNaN(d.getTime()) ? '' : (d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }

  function build(rows, opts) {
    var o = opts || {};
    var interval = o.interval || 'weekly';
    var count = Math.max(1, Number(o.periods) || 0);
    var from = dateOf(o.from);
    if (!from || !o.start) return { periods: [], bars: [] };

    var periods = [];
    for (var i = 0; i < count; i++) periods.push(Rotation.addIntervals(from, i, interval));
    // One period PAST the last, so a bar ending inside the final period is bounded by a real date
    // rather than by the last period's start (which would clip it to zero).
    var toExclusive = Rotation.addIntervals(from, count, interval);

    var bars = [];
    (rows || []).forEach(function(r) {
      var s = dateOf(r[o.start]);
      if (!s) return;                                   // no start, no bar
      // An absent end means a one-period bar, not an open-ended one: a row that says when it starts and
      // nothing else is a point in time, and drawing it to the window edge would invent a duration.
      var e = o.end ? dateOf(r[o.end]) : '';
      if (!e || e < s) e = s;                           // an end before its start is bad data, not a
                                                        // negative span -- collapse it to the start day
      if (e < from || s >= toExclusive) return;         // no intersection with the window

      // Clamp to the window, remembering which end was cut.
      var clippedStart = s < from, clippedEnd = e >= toExclusive;
      var vs = clippedStart ? from : s;
      var ve = clippedEnd ? toExclusive : e;

      var offset = Rotation.wholeIntervalsBetween(from, vs, interval);
      var last = Rotation.wholeIntervalsBetween(from, ve, interval);
      if (offset < 0) offset = 0;
      if (last >= count) last = count - 1;
      if (last < offset) last = offset;

      bars.push({
        row: r, start: s, end: e,
        offset: offset, span: (last - offset) + 1,
        clippedStart: clippedStart, clippedEnd: clippedEnd
      });
    });

    // Earliest first, then longest -- the reading order of a gantt chart. Ties keep input order, which
    // is already the view's own sort, so a schema's defaultSort still decides between equals.
    bars.sort(function(a, b) { return (a.offset - b.offset) || (b.span - a.span); });
    return { periods: periods, bars: bars };
  }

  var M = { build: build, dateOf: dateOf };
  if (isNode) module.exports = M;
  else root.Timeline = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
