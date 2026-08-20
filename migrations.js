// migrations.js — the schema's version, and the chain that brings an older one forward.
//
// WHY: until now, older schema shapes were handled by permanent load-time shims — convertViewFilters
// rewrites legacy array-IN filters to $or on every single load, forever, because there is nowhere to
// put the result. SCHEMA.md carries a "Removed shapes (hand-migrate)" section for the ones nobody wrote
// a shim for. Both are the same missing thing: a version number and a place to upgrade.
//
// Every migration here MUST be idempotent. The migrated schema is not yet written back (that needs an
// admin session and is a separate step), so the chain runs on every load, and running it twice has to
// mean the same as running it once.
//
//   Browser: <script src="/migrations.js"> defines the global Migrations.
//   Node:    const Migrations = require('./migrations');
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);

  // Bump when a migration is added. A schema with no version is v1: everything written before this
  // existed.
  var CURRENT_VERSION = 2;

  // Walk the nested view tree (nav groups nest views inside `views`), applying fn to each leaf.
  function eachView(list, fn) {
    (list || []).forEach(function (v) {
      if (!v || typeof v !== 'object') return;
      fn(v);
      if (Array.isArray(v.views)) eachView(v.views, fn);
    });
  }

  // ---- v1 -> v2: name the view kind instead of inferring it ----------------------------------------
  // The kind used to be worked out by sniffing for a `calendar`/`rotation`/`pivot`/`rsvp`/`board`/
  // `markdown` key through an ordered if-chain. Order was silently load-bearing there: a view carrying
  // two of those keys resolved by whichever branch came first, and nothing could report an unknown kind
  // because there was nothing to compare against.
  //
  // The derivation below reproduces that chain exactly, so migrating changes no view's behaviour. What
  // it changes is that the answer is now written down.
  function kindOf(v) {
    if (v.rotation) return 'rotation';
    if (v.calendar) return 'calendar';
    if (v.pivot) return 'pivot';
    if (v.rsvp) return 'rsvp';
    if (v.board) return 'board';
    if (typeof v.markdown === 'string') return 'page';
    return 'data';
  }

  function v1_to_v2(schema) {
    eachView(schema.views, function (v) {
      if (!v.name) return;                 // a bare nav group is not a view
      if (!v.kind) v.kind = kindOf(v);     // idempotent, and never overrides a hand-written kind
    });
    return schema;
  }

  var CHAIN = [
    { to: 2, apply: v1_to_v2, describes: 'name each view kind instead of inferring it from key presence' }
  ];

  // Returns { schema, from, to, applied: [description] }. Mutates and returns the schema it is given:
  // callers pass the freshly parsed document, and copying a whole schema per load to avoid that would
  // buy nothing.
  function migrate(schema) {
    var s = schema || {};
    var from = Number(s.schemaVersion) || 1;
    var applied = [];
    CHAIN.forEach(function (step) {
      if (from < step.to) { s = step.apply(s); applied.push(step.describes); }
    });
    s.schemaVersion = Math.max(from, CURRENT_VERSION);
    return { schema: s, from: from, to: s.schemaVersion, applied: applied };
  }

  var M = { CURRENT_VERSION: CURRENT_VERSION, migrate: migrate, kindOf: kindOf, eachView: eachView };
  if (isNode) module.exports = M;
  else root.Migrations = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
