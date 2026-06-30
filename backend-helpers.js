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

    // Append {code,name} to a languages list (non-mutating)
    addLanguage: function(list, code, name) {
      return (list || []).concat([{ code: code, name: name }]);
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
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = H;
  else root.BackendHelpers = H;
})(typeof self !== 'undefined' ? self : this);
