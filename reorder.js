// reorder.js — Pure position arithmetic for the three "move this up/down" buttons.
// Framework-agnostic + Node-tested, mirroring board.js / pivot.js / brand.js.
//   Browser: <script src="/reorder.js">, then Reorder.renumber(rows). Node: const Reorder = require('../reorder').
//
// WHY THIS EXISTS: three root methods reordered rows — `moveRowPosition` (a data grid),
// `moveRefChild` (a value inside one lookup group) and `moveRefGroup` (a whole lookup group) — and all
// three ended with the same block: walk the final display order, number it 1..n, and write only the
// rows whose number actually changed. Three copies of that is three chances to get it subtly different,
// and they already had:
//
//   - `moveRefChild` compared the old and new positions as STRINGS, the other two as NUMBERS. So a
//     stored '01' was rewritten to '1' by one path and left alone by the other two — and '01' sorts
//     before '1' under localeCompare, which is how sortedData orders, so the display order stopped
//     matching the stored one.
//   - an older `moveRefChild` SWAPPED the two rows' position values instead of renumbering. That moves
//     nothing when neither row has a position, which is every row of a roster that arrived by import
//     or seeding: the arrows did nothing at all, silently. The comment recording that fix is what
//     pointed at this duplication in the first place.
//
// WHAT IS NOT HERE: the writes. Recording undo and calling the write funnel stays in app-core, because
// it is effectful and because each caller owns a different table and partition. This module only says
// WHICH rows must change and to what.
(function(root) {

  // Move one item by one slot, returning a NEW array — or null when the move is not possible (either
  // edge, or an index that is not in the list).
  //
  // Null rather than a clamp, deliberately: the callers treat it as "this arrow does nothing". A clamp
  // would return the unchanged order, and renumber would then rewrite every row to the number it
  // already had — a no-op that still costs a write per row if the positions happen to be untidy.
  function move(list, i, dir) {
    var arr = (list || []).slice();
    var j = i + dir;
    if (i < 0 || i >= arr.length || j < 0 || j >= arr.length) return null;
    arr.splice(j, 0, arr.splice(i, 1)[0]);
    return arr;
  }

  // Given rows in their final DISPLAY order, return the changes needed to store that order:
  // [{ row, id, from, to }], skipping every row already holding the right position.
  //
  // `to` is always a STRING because sortedData orders with localeCompare, which throws on a number.
  // The comparison is on that same string, so a position that is numerically right but written
  // differently ('01' for 1) is corrected rather than left to sort out of place.
  function renumber(rows) {
    var out = [];
    (rows || []).forEach(function(r, k) {
      if (!r) return;
      var to = String(k + 1);
      var from = r.position;
      if (String(from) === to) return;          // already right: no write, no churn
      out.push({ row: r, id: r.id, from: from, to: to });
    });
    return out;
  }

  var M = { move: move, renumber: renumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Reorder = M;
})(typeof self !== 'undefined' ? self : this);
