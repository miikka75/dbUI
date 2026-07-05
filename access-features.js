// access-features.js — Permission "feature" model shared by app-core + unit tests.
// Browser: <script src="/access-features.js">, then use via AccessFeatures.*
// Node:    const AccessFeatures = require('../../access-features');
//
// Features collapse helper tables under primary features so the access UI stays short, while grants
// still MATERIALIZE to literal table names (Firestore rules + reads operate on table names, not
// features). A grant chip = a primary table or a sourceless rotation view; selecting it stores that
// feature's full table closure. Pure over (schema, views) so the app and its tests share one source.
(function(root) {
  // Helper tables a view needs beyond its own `sources`: rotation rosters (each independently
  // grantable — its own chip) + computed rotationTable / occurrenceSource targets (satellites).
  function viewRosters(v) { return (v && v.rotation && Array.isArray(v.rotation.rosters)) ? v.rotation.rosters.slice() : []; }
  function viewComputedHelpers(v) {
    var out = [];
    if (v && v.rotation && Array.isArray(v.rotation.columns)) v.rotation.columns.forEach(function(c) { if (c && c.rotationTable) out.push(c.rotationTable); });
    ((v && v.columns) || []).forEach(function(c) {
      if (c && typeof c === 'object' && c.computed) {
        if (c.computed.rotationTable) out.push(c.computed.rotationTable);
        if (c.computed.occurrenceSource) out.push(c.computed.occurrenceSource);
      }
    });
    return out;
  }
  function viewHelperTables(v) { return viewRosters(v).concat(viewComputedHelpers(v)); }
  function viewTables(v) { return ((v && v.sources) || []).concat(viewHelperTables(v)); }

  // A "pure mirror" has only synced columns (+ implicit id) and no content of its own — it rides with
  // its master and is never granted directly. A mirror that ALSO has own data columns is a real feature.
  function isPureMirror(t, schema) {
    var cols = (schema[t] && schema[t].columns) || {};
    var hasMirror = false, hasOwn = false;
    Object.keys(cols).forEach(function(c) {
      if (c === 'id') return;
      var d = cols[c];
      if (d && typeof d === 'object' && d.syncFrom) hasMirror = true;
      else hasOwn = true;
    });
    return hasMirror && !hasOwn;
  }

  // "Satellite" tables (computed-helper targets + pure mirrors) are hidden from the chips and pulled in
  // automatically by the closure of whatever feature uses them. Rotation-view rosters are NOT satellites.
  function satelliteTables(schema, views) {
    var sat = {};
    Object.keys(views).forEach(function(n) { viewComputedHelpers(views[n]).forEach(function(t) { sat[t] = true; }); });
    Object.keys(schema).forEach(function(t) { if (isPureMirror(t, schema)) sat[t] = true; });
    return sat;
  }

  // Grantable features (chips): primary (non-satellite) tables incl. rotation rosters, plus data views
  // with NO primary source (sourced only by satellites). A rotation view WITH rosters is not a chip.
  // Returns { id, view } so callers can pick the tab.<id> vs view.<id> translation key.
  function grantFeatures(schema, views) {
    var sat = satelliteTables(schema, views), feats = [];
    Object.keys(schema).forEach(function(t) { if (!sat[t]) feats.push({ id: t, view: false }); });
    Object.keys(views).forEach(function(n) {
      var v = views[n], srcs = v.sources || [];
      if (v.rotation && viewRosters(v).length) return;   // per-roster grants: rosters are the chips
      var hasPrimarySource = srcs.some(function(s) { return !sat[s]; });
      if (srcs.length && !hasPrimarySource) feats.push({ id: n, view: true });
    });
    return feats;
  }

  // Full table closure granted by selecting a feature (materialized into userData().tables): the
  // feature's own tables, then the helper tables of any view fully covered by the set (fixpoint).
  function featureClosure(featureId, schema, views) {
    var S = {};
    if (views[featureId]) viewTables(views[featureId]).forEach(function(t) { S[t] = true; });
    else S[featureId] = true;
    var changed = true;
    while (changed) {
      changed = false;
      Object.keys(views).forEach(function(n) {
        var v = views[n], src = v.sources || [];
        if (!src.length) return;                                      // sourceless rotation views are their own feature
        if (!src.every(function(s) { return S[s]; })) return;
        viewHelperTables(v).forEach(function(t) { if (!S[t]) { S[t] = true; changed = true; } });
      });
    }
    return Object.keys(S);
  }

  // Selected feature ids -> the literal table list to store (union of closures).
  function expandFeatureGrants(featureIds, schema, views) {
    var S = {};
    (featureIds || []).forEach(function(f) { featureClosure(f, schema, views).forEach(function(t) { S[t] = true; }); });
    return Object.keys(S);
  }

  // Reverse: which feature ids are fully covered by a stored table list (for chip selection state).
  function selectedFeatures(tableList, schema, views) {
    var have = {}; (tableList || []).forEach(function(t) { have[t] = true; });
    return grantFeatures(schema, views).filter(function(f) {
      return featureClosure(f.id, schema, views).every(function(t) { return have[t]; });
    }).map(function(f) { return f.id; });
  }

  var AF = {
    viewRosters: viewRosters, viewComputedHelpers: viewComputedHelpers, viewHelperTables: viewHelperTables,
    viewTables: viewTables, isPureMirror: isPureMirror, satelliteTables: satelliteTables,
    grantFeatures: grantFeatures, featureClosure: featureClosure,
    expandFeatureGrants: expandFeatureGrants, selectedFeatures: selectedFeatures
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AF;
  else root.AccessFeatures = AF;
})(typeof self !== 'undefined' ? self : this);
