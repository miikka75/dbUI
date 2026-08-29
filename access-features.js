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
  // THE tables a rotation reads, over all three shapes it can be written in. This is the single place
  // the shape vocabulary appears: everything that needs to know which tables feed a rotation -- the
  // access chips below, the calendar overlay's per-roster gate, the row-cache preload, the write gate
  // -- asks here instead of re-deriving it. `rosterRef` arrived by adding a branch at five separate
  // call sites, which is precisely the cost that shape was introduced to remove (a new family member
  // should be a row, not a schema edit); a fourth shape must not cost five more.
  //
  //   (a) rosterRef          one 2-D lookup feeds every slot
  //   (b) slots + rosters    one table per slot
  //   (c) columns[]          LEGACY per-column rotationTable
  function rotationTables(v) {
    var rv = v && v.rotation;
    if (!rv) return [];
    if (rv.rosterRef) return [rv.rosterRef];
    if (rv.rosters) return rv.rosters.slice();
    return (rv.columns || []).map(function(c) { return c && c.rotationTable; }).filter(Boolean);
  }
  // The GRANTABLE subset: shapes (a) and (b), where each roster is a table an admin ticks on its own.
  // Shape (c)'s targets are satellites instead -- viewComputedHelpers collects them, and widening this
  // to include them would change what a grant chip materializes.
  function viewRosters(v) {
    var rv = v && v.rotation;
    if (!rv || (!rv.rosterRef && !Array.isArray(rv.rosters))) return [];
    return rotationTables(v);
  }
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

  // Every table a SOURCELESS view actually reads. The presentation kinds (calendar/pivot/rsvp) name
  // their inputs per-kind rather than in `sources`, so a gate that only consults `sources` + rosters
  // sees nothing to check and lets the view through to anyone. Deliberately NOT folded into
  // viewHelperTables: that one feeds featureClosure, and widening it would change what a grant chip
  // materializes. This is a read-side question only ("what would this view try to load"), and the nav
  // gate unlocks on ANY of the answers -- an input you lack renders blank, per the roster rule.
  function viewImplicitTables(v, views, _seen) {
    if (!v) return [];
    var out = viewHelperTables(v);
    if (v.calendar) {
      (v.calendar.sources || []).forEach(function(s) { if (s && s.table) out.push(s.table); });
      // A calendar may overlay a rotation VIEW's generated duties; that view's own tables are just as
      // much this calendar's inputs. `seen` guards a schema that points two calendars at each other.
      var seen = _seen || {};
      (v.calendar.rotationSources || []).forEach(function(r) {
        var n = r && r.view;
        if (!n || seen[n]) return;
        seen[n] = true;
        var rv = (views || {})[n];
        if (rv) out = out.concat(viewTables(rv), viewImplicitTables(rv, views, seen));
      });
    }
    if (v.pivot && v.pivot.source) out.push(v.pivot.source);
    if (v.rsvp) {
      if (v.rsvp.events) out.push(v.rsvp.events);
      if (v.rsvp.responses) out.push(v.rsvp.responses);
    }
    return out.filter(function(t, i) { return t && out.indexOf(t) === i; });
  }

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

  // --- Grant shapes -------------------------------------------------------------------------------
  // A user's stored `tables` value has three accepted shapes. Everything that asks "what may this user
  // do with table X" goes through grantMode, so the shapes are normalized in exactly one place:
  //   'all'                       unrestricted — every table, read+write
  //   ['tasks','notes']           LEGACY: read+write on each. Still honored; never written anymore.
  //   { tasks:'rw', notes:'r' }   per-table mode. 'r' = read but not write (reference data an editor
  //                               should see and not change); anything else stored is treated as 'rw'.
  // Both rules layers can read the legacy and the map shape with the SAME membership test (Firestore
  // `x in map` matches keys; Postgres `jsonb ? k` matches array elements or object keys), which is why
  // no migration is needed — only the write checks had to learn the difference.
  function grantMode(tables, table) {
    if (tables === 'all') return 'rw';
    if (Array.isArray(tables)) return tables.indexOf(table) >= 0 ? 'rw' : null;
    if (tables && typeof tables === 'object') {
      if (!Object.prototype.hasOwnProperty.call(tables, table)) return null;
      return tables[table] === 'r' ? 'r' : 'rw';
    }
    return null;
  }
  function _namesByMode(tables, wantWrite) {
    if (tables === 'all') return null;                                  // null = unrestricted
    if (Array.isArray(tables)) return tables.slice();                   // legacy: every grant is rw
    if (tables && typeof tables === 'object') {
      return Object.keys(tables).filter(function(t) { return !wantWrite || grantMode(tables, t) === 'rw'; });
    }
    return [];                                                          // no grants (fail closed)
  }
  // Tables this user may SEE (r or rw) / may WRITE (rw only). null = unrestricted, [] = none.
  function readableTables(tables) { return _namesByMode(tables, false); }
  function writableTables(tables) { return _namesByMode(tables, true); }

  // Two selected-feature lists (edit chips, view chips) -> the stored `tables` map. Edit wins where a
  // feature appears in both, and each list expands through the same closure the single-list grant used.
  function buildGrants(editFeatureIds, viewFeatureIds, schema, views) {
    var out = {};
    expandFeatureGrants(viewFeatureIds, schema, views).forEach(function(t) { out[t] = 'r'; });
    expandFeatureGrants(editFeatureIds, schema, views).forEach(function(t) { out[t] = 'rw'; });
    return out;
  }

  // Reverse: which feature ids are fully covered by a stored table list (for chip selection state).
  function selectedFeatures(tableList, schema, views) {
    var have = {}; (tableList || []).forEach(function(t) { have[t] = true; });
    return grantFeatures(schema, views).filter(function(f) {
      return featureClosure(f.id, schema, views).every(function(t) { return have[t]; });
    }).map(function(f) { return f.id; });
  }

  var AF = {
    viewRosters: viewRosters, rotationTables: rotationTables, viewComputedHelpers: viewComputedHelpers, viewHelperTables: viewHelperTables,
    viewTables: viewTables, viewImplicitTables: viewImplicitTables,
    isPureMirror: isPureMirror, satelliteTables: satelliteTables,
    grantFeatures: grantFeatures, featureClosure: featureClosure,
    expandFeatureGrants: expandFeatureGrants, selectedFeatures: selectedFeatures,
    grantMode: grantMode, readableTables: readableTables, writableTables: writableTables,
    buildGrants: buildGrants
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = AF;
  else root.AccessFeatures = AF;
})(typeof self !== 'undefined' ? self : this);
