// writes.js — the single path every row write takes.
//
// WHY A FUNNEL AT ALL: app-core called backend.putRow / deleteRow / moveRow from twenty-six places.
// Nothing was wrong with any one of them, but there was no ONE place to stand if you wanted to change
// what a write does — and three things on the roadmap all want exactly that:
//
//   - optimistic updates, which need the row applied locally before the round-trip and rolled back if
//     it fails;
//   - a write queue, if offline ever comes back. That is about a hundred lines IF there is a single
//     chokepoint, and a rewrite if there is not. It is the cheap insurance this file exists to keep;
//   - uniform failure handling, instead of each call site deciding for itself whether to notify.
//
// None of those are here yet, deliberately. This lands as a pure pass-through so it can be verified as
// a no-op, and the interesting behaviour goes in afterwards against a suite that already passes.
//
// The invariant is enforced, not just intended: dev/test/write-funnel.test.js asserts that no direct
// backend.putRow/deleteRow/moveRow call survives outside this file. A funnel with a bypass is not one.
//
//   Browser: <script src="/writes.js"> defines the global Writes.
//   Node:    const Writes = require('./writes');
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);

  // `backend` is resolved at CALL time, never captured: it is a global the boot sequence assigns after
  // this file loads, and it is replaced outright when the app switches backends.
  function be() {
    var b = (typeof root.backend !== 'undefined') ? root.backend : null;
    if (!b) throw new Error('writes: no backend is loaded');
    return b;
  }

  // ALWAYS a promise, including when the failure is synchronous. A funnel that throws on some paths and
  // rejects on others makes every caller handle both, which is precisely the per-call-site variation it
  // exists to remove. Backends differ here too: the dev SQLite one is synchronous, the HTTP adapter is
  // not, and callers must not be able to tell.
  function run(fn) {
    try { return Promise.resolve(fn(be())); }
    catch (e) { return Promise.reject(e); }
  }

  // Observers, notified with the table id AFTER a write resolves. This is the first thing to use the
  // chokepoint the file was built for: calendar feeds republish on write, and there is exactly one
  // place that knows a write happened.
  //
  // Two deliberate properties. Notification is POST-SUCCESS -- a rejected write changes nothing, so
  // republishing on one would push a file that disagrees with the database. And an observer that throws
  // is swallowed: a feed that cannot be regenerated must not turn a saved row into a failed one, since
  // the row is the thing the user actually asked for.
  var observers = [];
  function notify(tableId) {
    observers.forEach(function (fn) { try { fn(tableId); } catch (e) {} });
  }
  function after(tableId, p) {
    return p.then(function (r) { notify(tableId); return r; });
  }

  var Writes = {
    // Register an observer. Returns an unsubscribe, so a test can leave no trace.
    onWrite: function (fn) {
      observers.push(fn);
      return function () { var i = observers.indexOf(fn); if (i >= 0) observers.splice(i, 1); };
    },

    // Upsert a row. `part` is the partition ('active' by default), as in the backend contract.
    putRow: function (tableId, row, part) {
      return after(tableId, run(function (b) { return b.putRow(tableId, row, part); }));
    },

    deleteRow: function (tableId, id, part) {
      return after(tableId, run(function (b) { return b.deleteRow(tableId, id, part); }));
    },

    // Not atomic on any backend — the contract says so, and moving that guarantee here would be
    // pretending. It funnels through for the same reason the others do.
    moveRow: function (tableId, row, fromPart, toPart) {
      return after(tableId, run(function (b) { return b.moveRow(tableId, row, fromPart, toPart); }));
    }
  };

  if (isNode) module.exports = Writes;
  else root.Writes = Writes;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
