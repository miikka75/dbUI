// query.js — split a view filter into what a backend can PUSH DOWN and what must still be filtered here.
//
// WHY: every view load reads a whole table and filters it in the browser. On Firebase's free plan that
// spends the daily document-read quota on rows the user never sees, and it is the ceiling on how much
// data the app can hold at all. Pushing the filter into the query is what fixes both.
//
// The problem is that no backend can express the whole condition language. Firestore's query model is
// narrow, Postgres' is wide but not identical, and `matchList` resolves against a runtime list that the
// database has never heard of. So this does not translate a filter — it SPLITS one:
//
//   compile(cond) -> { constraints, residual }
//
//   constraints  what the backend can be asked for, as [field, op, value] triples
//   residual     what is left, still evaluated by condMatches on whatever comes back
//
// THE INVARIANT, which is what makes the split safe rather than merely plausible:
//
//   filter(rows, cond)  ===  filter(query(rows, constraints), residual)
//
// Note the direction that must hold: constraints may only ever return a SUPERSET of the matching rows.
// A constraint that excludes a row the condition would have kept is a row silently missing from a view,
// which is the kind of bug that gets noticed months later by someone who trusted the screen. When in
// doubt this compiles to nothing and leaves the work to the residual — slower is always correctable,
// wrong is not.
//
//   Browser: <script src="/query.js"> defines the global Query.
//   Node:    const Query = require('./query');
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);

  // Operators whose meaning is IDENTICAL in the matcher and in a backend query. Deliberately short.
  // `ne` is absent: Firestore's != excludes documents missing the field entirely, while condMatches
  // treats a missing field as undefined and therefore not equal — so pushing it down would drop rows.
  // `lt`/`gt`/`lte`/`gte` are absent for now because _cmp compares numerically when BOTH sides parse as
  // numbers and lexically otherwise, and no backend reproduces that rule.
  var OPS = { eq: '==' };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // A single {col: <spec>} entry -> a constraint, or null when it cannot be pushed down safely.
  function constraintFor(col, spec) {
    if (isPlainObject(spec)) return null;        // an operator object: nothing here is safe yet
    if (Array.isArray(spec)) return null;        // legacy array-IN, upgraded to $or at load anyway
    if (spec === undefined || spec === null) return null;
    return { field: col, op: OPS.eq, value: spec };
  }

  // Returns { constraints: [...], residual: <condition|null> }.
  //
  // Only the TOP-LEVEL conjunction is examined. A branch of an $or cannot become a constraint on its
  // own — narrowing to one branch would discard the rows the other branch matches — and $and could be
  // flattened but is left alone until something needs it.
  function compile(cond) {
    if (!isPlainObject(cond)) return { constraints: [], residual: null };
    if (cond.$or || cond.$and) return { constraints: [], residual: cond };

    var constraints = [];
    var residual = null;
    Object.keys(cond).forEach(function (k) {
      if (k.charAt(0) === '$') { residual = residual || {}; residual[k] = cond[k]; return; }
      var c = constraintFor(k, cond[k]);
      if (c) constraints.push(c);
      else { residual = residual || {}; residual[k] = cond[k]; }
    });
    return { constraints: constraints, residual: residual };
  }

  // Apply constraints in memory. This is what the equivalence test drives, and the fallback for a
  // backend that cannot push down: the split must produce the same rows either way, or the split is
  // wrong rather than the backend being slow.
  function applyConstraints(rows, constraints) {
    if (!constraints || !constraints.length) return rows || [];
    return (rows || []).filter(function (r) {
      return constraints.every(function (c) {
        if (c.op !== '==') return true;          // unknown op: keep the row, let the residual decide
        return (r || {})[c.field] === c.value;
      });
    });
  }

  var Q = { compile: compile, applyConstraints: applyConstraints, OPS: OPS };
  if (isNode) module.exports = Q;
  else root.Query = Q;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
