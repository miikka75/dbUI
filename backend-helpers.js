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

    // The stored /_users/<key> document for a grant. `tables` may be 'all', a legacy name array, or a
    // per-table mode map { table: 'r' | 'rw' }. For the map shape ONLY, the writable subset is
    // denormalized alongside as `rwTables`: neither firestore.rules nor the Supabase RLS functions can
    // filter a map, so the write gates read this list (same denormalize-for-schema-blind-rules trick as
    // _meta/ownerTables). Omitted for 'all' and legacy arrays, whose write gates fall back to plain
    // membership -- which is why no stored grant needs migrating.
    userGrantDoc: function(key, role, user, tables) {
      var doc = { role: role, user: user || key, tables: (tables == null ? 'all' : tables) };
      if (doc.tables && typeof doc.tables === 'object' && !Array.isArray(doc.tables)) {
        doc.rwTables = Object.keys(doc.tables).filter(function(t) { return doc.tables[t] !== 'r'; });
      }
      return doc;
    },

    // Per-column write bounds for OWNER-scoped writes, mirrored to _meta/ownerWritable by saveSchema:
    //   "chore_log": { "ownerWritable": ["chore", "done_on", "note", "person"] }
    // The `owner` branch of the data rules is otherwise all-or-nothing — a member may rewrite every
    // field of their own row, which on a table with an approval column means approving themselves. This
    // says which fields that branch may touch; everything else on the table is LOCKED and must simply
    // hold its create-time value.
    //
    // Shape per table: { cols: [...allowed], locked: { col: valueItMustHaveAtCreate } }.
    //   - `locked` carries each gated column's declared `default` (or '' — what _createBlankRow writes
    //     for a column with none), so a create can be checked with one map diff instead of a loop the
    //     rules language does not have.
    //   - `defaultFrom` columns are omitted from `locked`: they resolve per user at create time, so no
    //     server-side rule can know what to expect. List them in `ownerWritable` if the owner sets them.
    //   - Only tables that BOTH declare ownerWritable and have an owner column are emitted; anywhere
    //     else the key would be inert and the rules should not pay to read it.
    ownerWritableOf: function(schema) {
      var tables = (schema && schema.tables) || {}, out = {};
      var SYSTEM = ['id', 'owner', 'created_at', 'updated_at', 'rosterPublic'];
      for (var t in tables) {
        var def = tables[t] || {}, list = def.ownerWritable;
        if (!Array.isArray(list)) continue;
        var cols = def.columns, defs = {};
        if (Array.isArray(cols)) cols.forEach(function(c) { if (c && c.name) defs[c.name] = c; });
        else for (var k in (cols || {})) defs[k] = cols[k];
        var hasOwner = false;
        for (var n in defs) { var d = defs[n]; if (d && typeof d === 'object' && d.type === 'owner') hasOwner = true; }
        if (!hasOwner) continue;
        var locked = {};
        for (var c2 in defs) {
          var d2 = defs[c2];
          if (list.indexOf(c2) >= 0 || SYSTEM.indexOf(c2) >= 0) continue;
          if (d2 && typeof d2 === 'object' && (d2.type === 'owner' || d2.defaultFrom)) continue;
          locked[c2] = (d2 && typeof d2 === 'object' && d2['default'] !== undefined) ? d2['default'] : '';
        }
        out[t] = { cols: list.slice(), locked: locked };
      }
      return out;
    },

    // Rows a table's `archiveAfter` policy has aged out of the ACTIVE partition:
    //   "archiveAfter": { "column": "status", "values": ["approved","rejected"], "days": 7 }
    // A row qualifies once `column` holds one of `values` AND the row has gone `days` without an edit.
    // The clock is `updated_at`, which every write stamps -- so it is "settled for N days", not "N days
    // since the status changed": correcting a note afterwards restarts it, which is the forgiving
    // reading (a row someone is still touching is not finished with). Rows with no `updated_at` are
    // left alone rather than archived on sight. Pure over (rows, cfg, now) so it is testable in Node
    // and identical wherever it runs.
    autoArchiveIds: function(rows, cfg, now) {
      if (!cfg || !cfg.column || !Array.isArray(cfg.values) || !cfg.values.length) return [];
      var days = Number(cfg.days);
      if (!isFinite(days) || days < 0) return [];
      var cutoff = (now instanceof Date ? now.getTime() : Date.parse(now)) - days * 86400000;
      if (isNaN(cutoff)) return [];
      return (rows || []).filter(function(r) {
        if (!r || !r.id || cfg.values.indexOf(r[cfg.column]) < 0) return false;
        var t = Date.parse(r.updated_at);
        return !isNaN(t) && t <= cutoff;
      }).map(function(r) { return r.id; });
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
