// live-sync.js — Pure reconciler for remote row changes pushed by a backend's subscribeTable.
//
// The transports differ wildly (Firestore onSnapshot, Supabase postgres_changes over one kv channel,
// SSE from the dev server), but every one of them lands on the SAME normalized change:
//
//   { type: 'put' | 'delete', id: <rowId>, row: <full row object | null> }
//
// against a store name (BackendHelpers.storeName -> 'tasks__active' / 'tasks__archive'). Everything
// below is the part that has to be RIGHT rather than the part that has to talk to a server, so it
// lives here as pure functions with no Vue and no DOM — app-core.js owns the dataCache and the
// rebuild, this module owns the merge semantics.
//   Browser: <script src="/live-sync.js"> -> global LiveSync
//   Node:    const LiveSync = require('../live-sync')   (dev/test/live-sync.test.js)
//
// Two invariants the rest of the app depends on:
//   1. An upsert Object.assigns ONTO the existing row object. It must never replace it: the row in
//      dataCache is the same object identity held by currentData, by an open <data-cell>'s `item`
//      prop, and by the mirror/rotation lookups. Swapping it out is what makes a remote update
//      repaint a cell the user is typing into.
//   2. A change that arrives while an edit is in flight is QUEUED, not dropped and not applied.
//      app-core decides when that is (see _liveHeld); this module only has to collapse the queue
//      correctly so a burst of remote writes replays as one merge per row.
(function(root) {
  // Store name -> dataCache key. 'tasks__active' -> 'tasks'; 'tasks__archive' stays as-is, because
  // aKey(table) (schema-loader.js) produces exactly that string for the archive partition.
  function cacheKeyFor(store) {
    var s = String(store || '');
    return /__active$/.test(s) ? s.slice(0, -('__active'.length)) : s;
  }

  // Apply one change to a row array, in place. Returns true if the array or a row actually changed —
  // the caller uses that to decide whether a (debounced, expensive) view rebuild is warranted at all.
  function applyChange(rows, change) {
    if (!rows || !change || !change.id) return false;
    var idx = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i] && rows[i].id === change.id) { idx = i; break; } }
    if (change.type === 'delete') {
      if (idx < 0) return false;                 // already gone (our own echo, or never cached)
      rows.splice(idx, 1);
      return true;
    }
    if (!change.row) return false;
    if (idx < 0) { rows.push(change.row); return true; }
    // Field-level merge onto the SAME object (invariant 1). Skip when nothing differs so an echo of
    // our own write doesn't schedule a rebuild.
    var target = rows[idx], changed = false;
    Object.keys(change.row).forEach(function(k) {
      if (target[k] !== change.row[k]) { target[k] = change.row[k]; changed = true; }
    });
    return changed;
  }

  function createState() { return { queue: {}, order: [] }; }

  // Collapse a change into the pending queue, keyed per row. Later wins:
  //   put + put    -> one put with the fields merged (a remote client writing two columns in a row)
  //   put + delete -> delete (the row is gone; the earlier field values are moot)
  //   delete + put -> put (resurrected, e.g. unarchived)
  function enqueue(state, store, change) {
    var key = store + '|' + change.id;
    var prev = state.queue[key];
    if (!prev) {
      state.order.push(key);
      state.queue[key] = { store: store, type: change.type, id: change.id, row: change.row ? Object.assign({}, change.row) : null };
      return;
    }
    if (change.type === 'delete') { prev.type = 'delete'; prev.row = null; return; }
    prev.type = 'put';
    prev.row = Object.assign({}, prev.row || {}, change.row || {});
  }

  // The one entry point app-core calls per incoming change. `held` is the edit-in-flight gate;
  // `rowsFor(cacheKey)` returns that partition's row array, or a falsy value when the table isn't
  // cached at all (then the change is dropped on purpose — the table will be fetched fresh, already
  // current, whenever something opens it).
  function queueOrApply(state, store, change, held, rowsFor) {
    if (!change || !change.id) return { applied: false, queued: false };
    if (held) { enqueue(state, store, change); return { applied: false, queued: true }; }
    var rows = rowsFor(cacheKeyFor(store));
    if (!rows) return { applied: false, queued: false };
    return { applied: applyChange(rows, change), queued: false };
  }

  // Drain the queue in arrival order. Returns the dataCache keys that actually changed, so the caller
  // can skip the rebuild entirely when a flush turns out to be a no-op (the common case: the queue
  // held nothing but echoes of the user's own edit).
  function flush(state, rowsFor) {
    var touched = [];
    state.order.forEach(function(key) {
      var c = state.queue[key];
      if (!c) return;
      var cacheKey = cacheKeyFor(c.store);
      var rows = rowsFor(cacheKey);
      if (!rows) return;
      if (applyChange(rows, c) && touched.indexOf(cacheKey) < 0) touched.push(cacheKey);
    });
    state.queue = {}; state.order = [];
    return touched;
  }

  var M = { cacheKeyFor: cacheKeyFor, applyChange: applyChange, createState: createState,
            enqueue: enqueue, queueOrApply: queueOrApply, flush: flush };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.LiveSync = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
