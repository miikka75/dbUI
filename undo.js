// undo.js — one local, in-memory undo/redo stack for the writes a person makes.
//
// WHY NOT IN writes.js: the funnel is the one place that knows a write HAPPENED, and that is the wrong
// moment. `saveField` debounces its write by 300ms, so two quick edits to different cells can reach the
// funnel in the opposite order from the one they were made in — an undo stack built there would take
// things back in an order the user never typed. Recording happens at the call site, at the moment of the
// action. Replay still goes out through the funnel, so the observers, the feed republish and every
// future thing writes.js is holding the door open for apply to an undo exactly as to any other write.
//
// WHAT AN OP IS. Deliberately the same normalized change shape live-sync.js already reconciles:
//
//   { table, part, forward: {type:'put'|'delete', id, row}, inverse: {type:'put'|'delete', id, row} }
//
// so the local half of a replay is LiveSync.applyChange and not a second merge implementation. A cell
// edit's inverse is a PARTIAL put naming only the columns that changed — which is what makes undo safe
// against other people: every backend merges partials (pinned by backend-conformance's "putRow merge
// semantics"), so taking back your edit to one column cannot revert a colleague's edit to another column
// of the same row. If they edited the SAME cell, the undo wins. That is the honest behaviour of an
// inverse-op log against live data, and it is not worth pretending otherwise.
//
// UNDO IS A WRITE, NEVER A RESTORE. Every backend subscribes to its tables. An undo that reached into
// dataCache and put the old values back would leave this client alone in believing them.
//
// The stack is per-session, in memory, and local to one person. Not persisted, not shared, cleared on
// reload. A shared undo is a different feature and a much larger one.
//
//   Browser: <script src="/undo.js"> defines the global Undo.
//   Node:    const Undo = require('./undo');
(function (root) {
  // Enough to cover a work session's worth of mistakes; bounded so a long session cannot grow a stack
  // that holds a copy of every row anyone deleted all afternoon.
  var MAX_ENTRIES = 50;

  var undoStack = [];   // entries, oldest first
  var redoStack = [];
  var group = null;     // the open action's op list, or null when no action is open
  var depth = 0;        // ref-count: a nested action() JOINS the outer one rather than opening a second
  var replaying = false;
  var applyLocal = null;
  var onChange = null;

  // Resolved at CALL time, never captured — same reasoning as writes.js resolving `backend`: the boot
  // sequence assigns these globals after this file loads.
  function W() {
    var w = (typeof root.Writes !== 'undefined') ? root.Writes : null;
    if (!w) throw new Error('undo: no write funnel is loaded');
    return w;
  }

  function changed() { if (onChange) onChange(undoStack.length, redoStack.length); }

  // Push a finished entry. Any new action invalidates the redo branch: redoing after it would replay a
  // forward patch against rows that have since moved on.
  function push(entry) {
    if (!entry || !entry.ops.length) return;
    undoStack.push(entry);
    if (undoStack.length > MAX_ENTRIES) undoStack.shift();
    redoStack.length = 0;
    changed();
  }

  // Apply one side of one op: locally first so the screen answers immediately, then out through the
  // funnel. That is the order every existing call site already uses (mutate the cache, then write), so
  // an undo behaves on screen exactly like the edit it is taking back.
  //
  // The clock is stamped HERE rather than carried in the op, because an undo is a write happening now,
  // not a rewind to when the row last changed. `updated_at` is what archiveAfter measures age by and
  // what the grid sorts on, so replaying a stored timestamp would leave a row the user just touched
  // claiming it had not been touched since the edit they took back — and, given a long enough
  // archiveAfter window, would file it away for having sat still.
  function replay(op, side) {
    var change = op[side];
    if (change.type === 'put') {
      change = { type: 'put', id: change.id, row: Object.assign({}, change.row, { updated_at: new Date().toISOString() }) };
    }
    if (applyLocal) applyLocal(op.table, op.part, change);
    if (change.type === 'delete') return W().deleteRow(op.table, change.id, op.part);
    return W().putRow(op.table, change.row, op.part);
  }

  // Ops run in reverse for an undo and forward for a redo, because within one action they may not be
  // independent: a cascade writes the row and then the columns that point at it.
  function replayAll(ops, side) {
    var order = side === 'inverse' ? ops.slice().reverse() : ops;
    replaying = true;
    try {
      return Promise.all(order.map(function (op) { return replay(op, side); }));
    } finally {
      // Cleared synchronously, not in a .then: `record` is only ever called synchronously from a call
      // site, so the flag has done its job by the time replay's promises settle. Leaving it set until
      // then would swallow a real edit the user made while an undo write was still in the air.
      replaying = false;
    }
  }

  var Undo = {
    // apply(table, part, change) patches the local cache and schedules a rebuild; onChange(u, r) reports
    // the stack depths, because a plain module is not reactive and the buttons need to know.
    configure: function (opts) {
      opts = opts || {};
      if (opts.apply) applyLocal = opts.apply;
      if (opts.onChange) onChange = opts.onChange;
      changed();
    },

    // Group everything recorded inside fn into ONE entry, so a user action that fans out to several
    // writes comes back in one press. Without this the first Ctrl+Z of a forty-row rename puts one row
    // back and leaves thirty-nine — which is worse than no undo, because it looks like it worked.
    // Re-entrant: propagateMirror runs inside saveField's action and must extend it, not start another.
    action: function (label, fn) {
      if (replaying) return fn();          // a replay's own writes are not new history
      if (depth === 0) group = { label: label, ops: [] };
      depth++;
      try {
        return fn();
      } finally {
        depth--;
        if (depth === 0) { var g = group; group = null; push(g); }
      }
    },

    // Throw the open action away: this turned out not to be reversible after all. Used where a branch
    // is only discovered mid-action — restoring a row archived under the old STORE model has to move it
    // between two collections, and the inverse of that is only correct while both are cached, which is
    // exactly what the branch exists to handle not being true.
    //
    // Abandoning the WHOLE action, rather than skipping the one op, is the point: an entry that puts
    // back three of a row's four mirrors is not an undo, and it looks like one.
    // Poisons the group rather than just emptying it: the caller is usually mid-loop, and a source it
    // visits afterwards would otherwise start filling a fresh-looking entry.
    abandon: function () { if (group) { group.ops.length = 0; group.abandoned = true; } },

    // Record one reversible write. Silently ignored during a replay. A call site that records nothing
    // makes its write non-undoable, which is the safe direction to fail: an op with a wrong before-image
    // would take the row back to a value it never held.
    record: function (op) {
      if (replaying) return;
      if (!op || !op.forward || !op.inverse) return;
      if (group) { if (!group.abandoned) group.ops.push(op); return; }
      push({ label: op.label || '', ops: [op] });
    },

    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },

    // Both resolve to the entry's label (so the caller can say what it took back) or null when the stack
    // was empty. The entry moves to the other stack BEFORE the writes settle: the local cache is already
    // patched, so the screen and the stack agree even if a write is still in the air.
    undo: function () {
      if (!undoStack.length) return Promise.resolve(null);
      var entry = undoStack.pop();
      redoStack.push(entry);
      changed();
      return replayAll(entry.ops, 'inverse').then(function () { return entry.label; });
    },

    redo: function () {
      if (!redoStack.length) return Promise.resolve(null);
      var entry = redoStack.pop();
      undoStack.push(entry);
      changed();
      return replayAll(entry.ops, 'forward').then(function () { return entry.label; });
    },

    // Called when the ground moves under the stack — a full table reload, a schema import, a database
    // switch. Every op names rows by id against a cache that has just been replaced wholesale, so the
    // inverses are no longer inverses of anything.
    clear: function () {
      undoStack.length = 0; redoStack.length = 0; group = null; depth = 0;
      changed();
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Undo;
  else root.Undo = Undo;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
