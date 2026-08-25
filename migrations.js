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
  // Resolved on first use: columns.js executes before this file in the browser's module batch, but
  // reading the global at load time would still couple the two files' order for no reason.
  var _Cols = null;
  function Cols() { return _Cols || (_Cols = isNode ? require('./columns') : root.Columns); }

  // Bump when a migration is added. A schema with no version is v1: everything written before this
  // existed.
  var CURRENT_VERSION = 3;

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
    if (v.form) return 'form';
    if (typeof v.markdown === 'string') return 'page';
    return 'data';
  }

  // Every step takes (schema, renames) even when it renames nothing: the collector is part of the step
  // contract, not an optional extra, so a step that DOES move a column has somewhere to say so without
  // first changing how the chain is called. This one changes no column identity -- it writes down a
  // kind that was previously inferred -- so it records nothing.
  function v1_to_v2(schema, renames) {           // eslint-disable-line no-unused-vars
    eachView(schema.views, function (v) {
      if (!v.name) return;                 // a bare nav group is not a view
      if (!v.kind) v.kind = kindOf(v);     // idempotent, and never overrides a hand-written kind
    });
    return schema;
  }

  // ---- v2 -> v3: cardinality is a flag, not a type ------------------------------------------------
  // `select` and `multiselect` differed in exactly one thing: whether the cell holds one value or
  // several. As a separate TYPE that difference could not compose -- `ref` had no multi-valued form at
  // all, so a schema wanting several values from a lookup table had to point a `multiselect` at it
  // through `list` and lose every reference behaviour on the way (colIsRef false, no filterBy, invisible
  // to the ref editor). As a flag it composes with both.
  //
  // No column NAME changes, so no translation key moves and this step records no renames.
  // Both column shapes (authored array / normalized map) via columns.js -- a migration runs over a
  // schema in whichever shape it arrived in, and that branch belongs in one place.
  function eachColumnDef(schema, fn) {
    var tables = (schema && schema.tables) || {};
    Object.keys(tables).forEach(function (t) {
      Cols().columnDefList(tables[t]).forEach(function (d) { if (d && typeof d === 'object') fn(d); });
    });
  }

  function v2_to_v3(schema, renames) {           // eslint-disable-line no-unused-vars
    eachColumnDef(schema, function (d) {
      // Idempotent: after the first pass nothing is typed `multiselect` any more.
      if (d.type !== 'multiselect') return;
      d.type = 'select';
      d.multiple = true;
    });
    return schema;
  }

  var CHAIN = [
    { to: 2, apply: v1_to_v2, describes: 'name each view kind instead of inferring it from key presence' },
    { to: 3, apply: v2_to_v3, describes: 'make multi-value a `multiple` flag rather than its own column type' }
  ];

  // ---- Translation keys move with the schema ------------------------------------------------------
  // Translation keys are generated per column as `field.<col>`, so any migration that changes a
  // column's identity orphans every string stored against the old key. Nothing would report it: the
  // schema would be correct and the app would render raw keys, in every language at once, to the people
  // least able to work out why.
  //
  // So a step that changes identity RECORDS the move, by calling renames(from, to) as it goes. Applying
  // those to the stored translations is a derived step of migrating -- never a manual follow-up
  // somebody has to remember -- and `migrate` hands the list back for the caller to apply.
  //
  // Order is preserved because it is load-bearing across steps: v2->v3 may rename a -> b and v3->v4
  // rename b -> c, and only replaying them in order lands the string on c.
  function collector() {
    var list = [];
    var add = function (from, to) {
      if (!from || !to || from === to) return;
      list.push([from, to]);
    };
    add.list = list;
    return add;
  }

  // Apply recorded renames to one language's stored translations. Pure: returns a NEW map.
  //
  // Idempotent, like every migration here, and for the same reason -- the chain re-runs on every load
  // until an admin session writes the result back, so this may be applied to translations that already
  // moved. After the first pass the old key is gone, so a second pass finds nothing to move.
  //
  // Collisions keep the TARGET. If the new key already holds a non-empty string, somebody has already
  // translated it under its new name, and their string is the better one -- the value under the old key
  // is by definition the older wording.
  function renameKeys(translations, renames) {
    var out = {}, k;
    for (k in (translations || {})) out[k] = translations[k];
    (renames || []).forEach(function (pair) {
      var from = pair && pair[0], to = pair && pair[1];
      // The same validity rule the collector applies, repeated here rather than assumed: a chain step
      // may hand this list over directly, and a half-formed pair would otherwise DELETE the source key
      // and file its string under "null".
      if (!from || !to || from === to) return;
      if (!(from in out)) return;                       // already moved, or never existed
      var moving = out[from];
      delete out[from];
      if (out[to] !== undefined && out[to] !== '') return;   // target already translated -- keep it
      out[to] = moving;
    });
    return out;
  }

  // The same move expressed as a PATCH for updateTranslations, which merges and therefore cannot
  // delete: a key that has gone is sent as '' instead. t() is `strings[key] || key`, so a blanked key
  // reads exactly like an absent one -- and leaving the old key with its old VALUE would be worse than
  // cruft, because a column that later reappears under that name would silently inherit stale wording.
  function renamePatch(translations, renames) {
    var before = translations || {};
    var after = renameKeys(before, renames);
    var patch = {};
    Object.keys(after).forEach(function (k) { if (after[k] !== before[k]) patch[k] = after[k]; });
    // `!== ''` keeps this a true no-op on a second pass: a key blanked by an earlier run is already
    // gone as far as t() is concerned, and re-sending '' would make every boot issue a write.
    Object.keys(before).forEach(function (k) { if (!(k in after) && before[k] !== '') patch[k] = ''; });
    return patch;
  }

  // Every language at once: { code: translations } -> { code: translations }.
  function renameAll(byLang, renames) {
    var out = {};
    Object.keys(byLang || {}).forEach(function (code) {
      out[code] = renameKeys(byLang[code], renames);
    });
    return out;
  }

  // Returns { schema, from, to, applied: [description] }. Mutates and returns the schema it is given:
  // callers pass the freshly parsed document, and copying a whole schema per load to avoid that would
  // buy nothing.
  function migrate(schema) {
    var s = schema || {};
    var from = Number(s.schemaVersion) || 1;
    var applied = [];
    var renames = collector();
    CHAIN.forEach(function (step) {
      if (from < step.to) { s = step.apply(s, renames); applied.push(step.describes); }
    });
    s.schemaVersion = Math.max(from, CURRENT_VERSION);
    return { schema: s, from: from, to: s.schemaVersion, applied: applied, renames: renames.list };
  }

  var M = { CURRENT_VERSION: CURRENT_VERSION, migrate: migrate, kindOf: kindOf, eachView: eachView,
            renameKeys: renameKeys, renameAll: renameAll, renamePatch: renamePatch,
            eachColumnDef: eachColumnDef };
  if (isNode) module.exports = M;
  else root.Migrations = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
