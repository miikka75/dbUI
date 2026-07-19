// backend-helpers.js — Pure transforms shared by client backends (Firebase, CRDT) + unit tests.
// Browser: <script src="/backend-helpers.js">, then use via BackendHelpers.*
// Node:    const BackendHelpers = require('../../backend-helpers');
(function(root) {
  var H = {
    // Storage key for a table partition: ('tasks','active') -> 'tasks__active'
    storeName: function(table, tab) { return table + '__' + (tab || 'active'); },

    // Column headers from row objects (first row's keys); [] when empty
    deriveHeaders: function(rows) { return rows && rows.length ? Object.keys(rows[0]) : []; },

    // Unwrap a schema doc: legacy {_json:"..."} -> parsed, {tables} -> as-is, else null
    unwrapSchemaDoc: function(d) {
      if (!d) return null;
      if (d._json) { try { return JSON.parse(d._json); } catch (e) { return null; } }
      if (d.tables) return d;
      return null;
    },

    // Upsert {code,name} into a languages list (non-mutating). `code` is the identity: re-adding an
    // existing code refreshes its name in place rather than appending a duplicate — re-importing a
    // bundle calls createLanguage for every language it carries, and the SQLite backend already
    // upserts (INSERT OR REPLACE on a `code` PRIMARY KEY), so appending here diverged from it.
    addLanguage: function(list, code, name) {
      var out = [], seen = {};
      (list || []).forEach(function(l) {
        if (!l || seen[l.code]) return;                  // collapse any duplicate codes already stored
        seen[l.code] = true;
        out.push(l.code === code ? { code: code, name: name } : l);
      });
      if (!seen[code]) out.push({ code: code, name: name });
      return out;
    },

    // Remove a language by code (non-mutating)
    removeLanguage: function(list, code) {
      return (list || []).filter(function(l) { return l.code !== code; });
    },

    // Rename a language's display NAME by code (code stays stable) — non-mutating.
    // Decouples display name from the stable code used to key translations.
    renameLanguage: function(list, code, newName) {
      return (list || []).map(function(l) { return l.code === code ? { code: l.code, name: newName } : l; });
    },

    // Build an empty-string translation map from keys
    emptyTranslations: function(keys) {
      var t = {}; if (keys) keys.forEach(function(k) { t[k] = ''; }); return t;
    },

    // Table names whose schema declares an `owner`-typed column -- the SELF-SERVICE set. An owner column
    // means each row belongs to a member (auto-stamped, read-only), so those are exactly the tables where
    // a member may create/edit/delete THEIR OWN row without a table grant (the RSVP/sign-up pattern,
    // generalized). Firestore rules are schema-blind, so saveSchema mirrors this to _meta/ownerTables and
    // the rules gate owner-create on membership in it -- turning "owner-create allowed on any table" into
    // "only on tables meant for it". Sorted; handles both column shapes (array [{name,type}] and map
    // {name: 'text' | {type}}). A bare-string column def can't be `owner`, so only object defs count.
    ownerTablesOf: function(schema) {
      var tables = (schema && schema.tables) || {}, out = [];
      var isOwner = function(def) { return !!(def && typeof def === 'object' && def.type === 'owner'); };
      for (var t in tables) {
        var cols = tables[t] && tables[t].columns, has = false;
        if (Array.isArray(cols)) has = cols.some(isOwner);
        else if (cols) { for (var c in cols) { if (isOwner(cols[c])) { has = true; break; } } }
        if (has) out.push(t);
      }
      return out.sort();
    },

    // Per-page access map for RESTRICTED doc-views: { pageName: [tables...] } for every markdown view
    // that declares a non-empty `access` array ("visible to users granted any of these tables"). A page
    // WITHOUT `access` is omitted -> readable by every registered user (the default). Firestore rules are
    // schema-blind, so saveSchema mirrors this to _meta/pageAccess and the _pages__active read rule gates
    // on it (see firestore.rules). Table grants are reused as the vocabulary -- no new permission type.
    // Walks nested `views` like the app's flattener; tables sorted for a stable mirror doc.
    pageAccessOf: function(schema) {
      var out = {};
      (function walk(arr) {
        (arr || []).forEach(function(v) {
          if (v && v.name && typeof v.markdown === 'string' && Array.isArray(v.access) && v.access.length) {
            out[v.name] = v.access.slice().sort();
          }
          if (v && v.views) walk(v.views);
        });
      })((schema && schema.views) || []);
      return out;
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = H;
  else root.BackendHelpers = H;
})(typeof self !== 'undefined' ? self : this);
