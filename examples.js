// examples.js — the shipped example bundles, as something the RUNNING APP can read.
//
// examples/ ships on both publish paths (it is absent from firebase.json's hosting.ignore and
// survives the prune in .github/workflows/deploy-pages.yml), so every deployment already serves its
// own bundles as SAME-ORIGIN assets. That is the whole enabling fact: the app can fetch them under
// `connect-src 'self'` with no CORS, no CDN and no third party — the only thing missing was a
// machine-readable index and the code to fold several files into one import.
//
// What lives here is the pure half of that: no fetch, no Vue, no DOM.
//
//   mergeFiles  — several bundle files (schema + language packs + optional sample rows) folded into
//                 ONE import object, so the picker runs the existing import once instead of asking
//                 the user to repeat it four times in the documented order.
//   fingerprint — a hash per UNIT of a bundle (per column, per view, per translation string, per
//                 list), recorded at install time. It is what lets a later change tell "upstream
//                 changed this" from "you changed this": the live database and the new bundle supply
//                 two of the three points a merge needs, and this supplies the third — what the unit
//                 looked like when it was installed — in ~1-2 kB instead of a copy of the bundle.
//   compare     — which of an installed bundle's files have moved on in the manifest.
//
//   Browser: <script src="/examples.js"> — defines the global Examples.
//   Node   : require('./examples') — the same object (scripts/examples-manifest.js and the tests).
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // Resolved on first use so this file can load in any order relative to schema-normalize.js — the
  // same lazy-deps pattern that file uses for migrations.js/rows.js.
  var _norm = null;
  function normalizer() {
    if (!_norm) _norm = isNode ? require('./schema-normalize') : root.SchemaNormalize;
    return _norm;
  }

  // --- Hashing -----------------------------------------------------------------------------------
  // Key order in a JSON object is not meaning, so it must not be identity: an editor that rewrites a
  // schema alphabetically would otherwise report every table as changed. Arrays keep their order,
  // because in this document order IS meaning (column order, nav order).
  function canonical(v) {
    if (v === undefined) return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(v[k]);
    }).join(',') + '}';
  }

  // FNV-1a. Deliberately not SubtleCrypto: that is async and secure-context-only, and this is not a
  // security boundary — it answers "same or different" about small values, where a 64-bit answer is
  // far past sufficient. Synchronous also means the manifest generator, the tests and the browser run
  // the identical function.
  function fnv1a(str, seed) {
    var h = seed >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // h * 16777619, kept in 32 bits without Math.imul's float round-trip
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }
  function hex8(n) { return ('00000000' + n.toString(16)).slice(-8); }

  // 64 bits, as two FNV runs over the same string from different offset bases.
  function hash(value) {
    var s = canonical(value);
    return hex8(fnv1a(s, 0x811c9dc5)) + hex8(fnv1a(s, 0x01000193));
  }

  // A whole FILE's identity, for the manifest. A byte-order mark and CRLF line endings are normalised
  // away first: this repo checks out LF (core.autocrlf=input), but a clone that did not would hash
  // byte-identical content differently, and the manifest drift guard would then fail on Windows and
  // pass in CI.
  function hashText(text) {
    return hash(String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  }

  // --- Folding files into one import ---------------------------------------------------------------
  // A bundle file is either an EXPORT-shaped object ({schema, tables, lists, translations, …}) or a
  // bare schema document (examples/chores-schema.json). The same detection app-core's importData has
  // always done, moved here so the file picker and the example picker cannot disagree about it.
  function asBundle(parsed) {
    var raw = parsed && parsed.tables && !parsed.schema && Object.keys(parsed.tables).some(function (t) {
      var def = parsed.tables[t];
      return def && def.columns;
    });
    return raw ? { schema: parsed, tables: {} } : (parsed || {});
  }

  // Rows are merged by id rather than concatenated: two files may legitimately carry the same table,
  // and an import writes each row by id anyway, so a duplicate would only be written twice.
  function mergeRows(into, key, rows) {
    var list = into[key] || (into[key] = []);
    (Array.isArray(rows) ? rows : (rows && rows.rows) || []).forEach(function (row) {
      if (!row) return;
      var at = -1;
      for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === row.id) { at = i; break; } }
      if (at >= 0) list[at] = row; else list.push(row);
    });
  }

  // Fold files, IN APPLY ORDER, into one import object. Later files win: the documented order is
  // schema -> schema labels -> app UI labels -> sample rows, and each step is meant to layer onto the
  // one before it (translations merge per language, exactly as importing them one at a time does).
  function mergeFiles(files) {
    var out = {};
    (files || []).forEach(function (file) {
      var b = asBundle(file);
      if (b.schema) out.schema = b.schema;
      if (b.config) out.config = Object.assign(out.config || {}, b.config);
      if (b.lists) { out.lists = out.lists || {}; Object.keys(b.lists).forEach(function (n) { out.lists[n] = b.lists[n]; }); }
      if (b.tables) { out.tables = out.tables || {}; Object.keys(b.tables).forEach(function (t) { mergeRows(out.tables, t, b.tables[t]); }); }
      if (b.translations) {
        out.translations = out.translations || {};
        Object.keys(b.translations).forEach(function (code) {
          out.translations[code] = Object.assign(out.translations[code] || {}, b.translations[code]);
        });
      }
      if (Array.isArray(b.languages)) {
        out.languages = out.languages || [];
        b.languages.forEach(function (lang) {
          if (!lang || !lang.code) return;
          var seen = out.languages.some(function (l) { return l.code === lang.code; });
          if (!seen) out.languages.push(lang);
        });
      }
      if (Array.isArray(b.pages)) mergeRows(out, 'pages', b.pages);
      if (Array.isArray(b.assets)) mergeRows(out, 'assets', b.assets);
    });
    return out;
  }

  // --- Fingerprinting ------------------------------------------------------------------------------
  // The unit KEYS are the merge granularity, so they are chosen where the two sides realistically edit
  // different things: a column each, a view each, one translation string each. Coarser (per table)
  // would call an added column a conflict; finer buys nothing.
  //
  // Rows, pages and assets are deliberately absent. They are DATA — a sample-row file re-imported
  // overwrites whatever the household actually recorded — and they are never part of an update.
  function fingerprintSchema(schema, out) {
    // The stored schema is the migrated, column-FOLDED form (app-core writes schemaData back after
    // the migration chain), while a shipped file is authored as arrays with no implicit `id`. Both
    // sides go through the app's own normalizer first, or a schemaVersion bump alone would report
    // every unit as edited. On a copy: normalize() mutates, and the caller's bundle is about to be
    // imported.
    var copy = JSON.parse(JSON.stringify(schema));
    var n = normalizer();
    var norm = n ? n.normalize(copy) : { tables: copy.tables || {}, views: copy.views || [], viewsMap: {} };

    Object.keys(copy).forEach(function (k) {
      if (k === 'tables' || k === 'views') return;       // covered per table / per view below
      out['schema/' + k] = hash(copy[k]);
    });

    var tables = norm.tables || {};
    Object.keys(tables).forEach(function (t) {
      var def = tables[t] || {};
      var attrs = {};
      Object.keys(def).forEach(function (k) { if (k !== 'columns') attrs[k] = def[k]; });
      out['tables/' + t] = hash(attrs);
      var cols = def.columns || {};
      Object.keys(cols).forEach(function (c) { out['tables/' + t + '/columns/' + c] = hash(cols[c]); });
    });

    var views = norm.viewsMap || {};
    Object.keys(views).forEach(function (v) {
      var body = Object.assign({}, views[v]);
      delete body.views;                                  // a nav group's children are the tree, below
      out['views/' + v] = hash(body);
    });
    // The nav TREE — grouping and order — with each view reduced to its name, so moving a view between
    // groups registers as a change here rather than nowhere.
    out['views/_tree'] = hash(shapeOf(norm.views));
  }

  function shapeOf(arr) {
    return (arr || []).map(function (v) {
      if (!v || typeof v !== 'object') return null;
      return Array.isArray(v.views) ? { name: v.name || '', views: shapeOf(v.views) } : (v.name || '');
    });
  }

  function fingerprint(bundle) {
    var b = asBundle(bundle);
    var out = {};
    if (b.schema) fingerprintSchema(b.schema, out);
    if (b.lists) Object.keys(b.lists).forEach(function (n) { out['lists/' + n] = hash(b.lists[n]); });
    if (b.translations) {
      Object.keys(b.translations).forEach(function (code) {
        var map = b.translations[code] || {};
        Object.keys(map).forEach(function (k) { out['tr/' + code + '/' + k] = hash(map[k]); });
      });
    }
    return out;
  }

  // --- What has moved on ---------------------------------------------------------------------------
  // `stored` is appConfig.example, written at install: { bundle, revision, files: { name: hash } }.
  // Returns null when there is nothing installed, nothing matching in the manifest, or nothing new.
  function compare(stored, manifest) {
    if (!stored || !stored.bundle || !manifest) return null;
    var entry = (manifest.bundles || []).filter(function (b) { return b.id === stored.bundle; })[0];
    if (!entry) return null;                              // the deployment no longer ships it
    var current = fileHashes(entry, manifest);
    var changed = Object.keys(stored.files || {}).filter(function (name) {
      return current[name] && current[name] !== stored.files[name];
    });
    if (!changed.length) return null;
    return {
      bundle: entry.id,
      title: entry.title || entry.id,
      revision: entry.revision || 0,
      installedRevision: stored.revision || 0,
      changed: changed.sort()
    };
  }

  // Every file the manifest knows for one bundle, by filename -> hash. The app-language packs are
  // top-level (they are schema-independent) but install alongside a bundle, so an update to them is
  // an update to what you installed.
  function fileHashes(entry, manifest) {
    var out = {};
    function add(f) { if (f && f.file) out[f.file] = f.hash; }
    add(entry.schema);
    (entry.languages || []).forEach(add);
    add(entry.data);
    ((manifest && manifest.appLanguages) || []).forEach(add);
    return out;
  }

  var E = {
    hash: hash, hashText: hashText, canonical: canonical,
    asBundle: asBundle, mergeFiles: mergeFiles,
    fingerprint: fingerprint, compare: compare, fileHashes: fileHashes
  };
  if (isNode) module.exports = E;
  else root.Examples = E;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
