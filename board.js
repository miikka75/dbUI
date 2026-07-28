// board.js — Pure kanban/board builder: bucket a flat row list into lanes by one column's value.
// The one-dimensional, WRITABLE cousin of pivot.js (pivot aggregates to numbers and is read-only;
// a board keeps whole rows so cards stay editable and draggable). Framework-agnostic + Node-tested,
// mirroring pivot.js / rsvp.js / rotation.js.
//   Browser: <script src="/board.js">, then Board.build(rows, opts). Node: const Board = require('../board').
//
// opts:
//   lane        column name whose value places a row in a lane (required)
//   laneOrder   explicit ordered lane keys; keys not present in the data still render as EMPTY lanes.
//               Omit -> derive from the data in first-seen order.
//   hidden      lane keys to drop entirely (array)
//   sortWithin  optional comparator(a,b) applied to each lane's rows (default: keep input order,
//               which is already the view's defaultSort order from currentData)
//
// A row whose lane value is blank/'' goes into the '' (unassigned) lane key — surface or hide it
// via laneOrder/hidden as the view prefers. Array-valued lane columns are NOT expanded (a board card
// belongs to exactly one lane); the first array element (or '') is used.
(function(root) {
  function laneKey(v) { return Array.isArray(v) ? (v.length ? String(v[0]) : '') : (v == null ? '' : String(v)); }

  function build(rows, opts) {
    rows = rows || [];
    var laneCol = opts.lane;
    var hidden = {};
    (opts.hidden || []).forEach(function(k) { hidden[k] = 1; });

    var order = (opts.laneOrder || []).slice();
    var seen = {};
    order.forEach(function(k) { seen[k] = 1; });

    var buckets = {};
    order.forEach(function(k) { buckets[k] = []; });   // materialize declared (possibly empty) lanes

    rows.forEach(function(r) {
      var k = laneKey(r[laneCol]);
      if (hidden[k]) return;
      if (!(k in seen)) { seen[k] = 1; order.push(k); }
      (buckets[k] || (buckets[k] = [])).push(r);
    });

    var lanes = order.filter(function(k) { return !hidden[k]; }).map(function(k) {
      var items = buckets[k] || [];
      if (opts.sortWithin) items = items.slice().sort(opts.sortWithin);
      return { key: k, count: items.length, items: items };
    });

    return { lanes: lanes };
  }

  var M = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Board = M;
})(typeof self !== 'undefined' ? self : this);
