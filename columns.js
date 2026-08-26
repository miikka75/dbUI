// columns.js — Pure schema-derived column typing, shared by app-core.js (browser) + dev/schema.js
// (Node) + unit tests. Previously duplicated as globals in app-core and again in dev/schema.js.
// Browser: <script src="/columns.js">, then use via Columns.*
// Node:    const Columns = require('../columns');
//
// All functions are pure over `schema` (the tables map). The single-table accessors are null-guarded
// (missing table -> text/null, never throws); columnList(schema, null, col) scans every table.
(function(root) {
  // --- The two column shapes -------------------------------------------------------------------
  // A table's `columns` ships in TWO shapes and always has: the AUTHORED/stored array of {name,...}
  // defs (what a schema.json file holds, what an export carries, what the rules mirrors are computed
  // from), and the RUNTIME name->def map that _normalizeSchema builds for the browser. Every reader
  // that walks a table's columns had to branch on which one it was holding, and that branch was
  // hand-written in eleven places -- five of them character-for-character identical. This is that
  // branch, written once.
  //
  // Order is preserved in both shapes (array order; key insertion order for the map), so a caller
  // asking for "the first column that ..." gets the same answer whichever shape it was handed.
  // The map shape is returned AS-IS rather than copied: these run on hot paths (per render, per nav
  // item), and the copy would be pure waste. Treat the result as read-only.
  function columnDefs(tableDef) {
    var cols = (tableDef && tableDef.columns) || {};
    if (!Array.isArray(cols)) return cols;
    var out = {};
    cols.forEach(function(c) { if (c && c.name) out[c.name] = c; });   // nameless entries are not columns
    return out;
  }
  // The defs alone, for scans that never need the name (list references, ref targets, owner probes).
  function columnDefList(tableDef) {
    var m = columnDefs(tableDef);
    return Object.keys(m).map(function(k) { return m[k]; });
  }
  // Name of a table def's `owner` column (type:'owner'), or null -- shape-agnostic, so the backends
  // and the dev server can ask it of a STORED table def, which is not the map `tableOwnerCol` wants.
  // Object defs only, deliberately: a bare-string def (`"mine": "owner"`) is what the rules MIRROR
  // (BackendHelpers.ownerTablesOf) has always refused to count, and a table the client believed was
  // self-service while the store did not is a denial at write time. The two now agree, fail-closed.
  function ownerColOf(tableDef) {
    var defs = columnDefs(tableDef);
    for (var c in defs) { var d = defs[c]; if (d && typeof d === 'object' && d.type === 'owner') return c; }
    return null;
  }

  // --- The column vocabulary -------------------------------------------------------------------
  // What a column def is ALLOWED to say. Both lists are closed, and both are enforced at load by
  // validateSchema -- the point of writing them down is that neither failure mode is visible without
  // a check: `columnType` defaults to 'text', so `"type": "slect"` renders a working text column and
  // the author never learns why their dropdown is missing; and an unrecognised KEY is simply never
  // read, so `"allowNews": true` is a silent no-op. That is the class of bug that kept `ref`
  // validation broken for months.
  //
  // They live here, next to the readers, because every one of these names is read within a few lines
  // of this comment -- a list kept anywhere else would be a list nobody updates when a reader is
  // added. `schema.schema.json` carries the same two vocabularies for the author's EDITOR, and
  // dev/test/schema-meta.test.js compares the two so the copy cannot drift.
  //
  // `multiselect` is here despite being legacy (migration v3 rewrites it to select + multiple): the
  // migration is idempotent and runs at load, but a schema on disk may still spell it, and rejecting
  // what the migration accepts would fail the document before it got the chance to be upgraded.
  var COLUMN_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'ref', 'url', 'image', 'owner'];
  var COLUMN_KEYS = [
    'name', 'type', 'hidden',                                   // identity + display
    'list', 'listSwitch', 'allowNew', 'sorted', 'picker',        // list-backed columns
    'table', 'valueCol', 'filterBy',                             // ref columns
    'multiple',                                                  // cardinality (composes with select AND ref)
    'default', 'defaultFrom', 'stamped',                         // what a new row starts with, and who may rewrite it
    'syncFrom'                                                   // mirror columns
  ];

  // Every way a column def can be wrong ABOUT ITSELF, as a list of messages. Pure over the tables map
  // (either column shape), so validateSchema in the browser and the unit suite in Node ask the same
  // function rather than each owning a copy of the vocabulary -- which is the mistake this check
  // exists to catch, made one layer up.
  //
  // A bare-string def (`"id": "text"`) IS the type -- that is how ensureImplicitId injects `id` -- so
  // it gets the enum check and has no keys to check.
  function vocabularyErrors(tables) {
    var errors = [];
    for (var t in (tables || {})) {
      var defs = columnDefs(tables[t]);
      for (var c in defs) {
        var d = defs[c], typ = (typeof d === 'string') ? d : (d && d.type);
        if (typ !== undefined && COLUMN_TYPES.indexOf(typ) < 0) {
          errors.push('table "' + t + '": column "' + c + '" has unknown type "' + typ + '" — must be one of ' +
                      COLUMN_TYPES.join('/') + ' (an unknown type silently reads as "text")');
        }
        if (!d || typeof d !== 'object') continue;
        Object.keys(d).forEach(function(k) {
          if (COLUMN_KEYS.indexOf(k) < 0) {
            errors.push('table "' + t + '": column "' + c + '" has unknown property "' + k +
                        '" — nothing reads it, so it does nothing (see SCHEMA.md, "column properties")');
          }
        });
      }
    }
    return errors;
  }

  function columnType(schema, table, col) {
    var def = schema[table] && schema[table].columns[col];
    if (!def) return 'text';
    if (typeof def === 'string') return def;
    return def.type || 'text';
  }
  function columnList(schema, table, col) {
    if (!table) return colInfo(schema, col).list;   // any-table scan -> memoized (see scanSchema)
    var def = schema[table] && schema[table].columns[col];
    return (def && typeof def === 'object') ? def.list : null;
  }
  function columnRef(schema, table, col) {
    var def = schema[table] && schema[table].columns[col];
    return (def && typeof def === 'object' && def.type === 'ref') ? def : null;
  }
  // A mirror column syncs its value from another table (def.syncFrom).
  function isMirror(schema, table, col) {
    var def = schema[table] && schema[table].columns[col];
    return !!(def && typeof def === 'object' && def.syncFrom);
  }
  // The syncFrom source of a table's first mirror column (a "pure mirror" rides its master), or null.
  function tableMirrorSource(schema, table) {
    var cols = schema[table] && schema[table].columns;
    if (!cols) return null;
    for (var c in cols) { var def = cols[c]; if (def && typeof def === 'object' && def.syncFrom) return def.syncFrom; }
    return null;
  }
  // Name of a table's `owner` column (type:'owner' — auto-stamped with the current user's email,
  // read-only, immutable; drives per-row self-service access), or null.
  function tableOwnerCol(schema, table) {
    return ownerColOf(schema && schema[table]);
  }
  // Columns carrying a `defaultFrom` token -> [{ name, from }]. The token is resolved by the caller
  // (only '@me' = my profile display name today) and stamped on row CREATE only, so the value stays
  // editable afterwards — unlike an `owner` column, which is auto-stamped and then read-only.
  function tableDefaultCols(schema, table) {
    var cols = schema[table] && schema[table].columns, out = [];
    if (!cols) return out;
    for (var c in cols) {
      var d = cols[c];
      if (!d || typeof d !== 'object') continue;
      // `defaultFrom` resolves a token per user (only '@me'); `default` is a literal the caller writes
      // through unchanged. A column may carry either; the token wins if somebody sets both.
      if (d.defaultFrom) out.push({ name: c, from: d.defaultFrom });
      else if (d['default'] !== undefined) out.push({ name: c, value: d['default'] });
    }
    return out;
  }
  // A table's `ref` column pointing at `targetTable` -> { name, valueCol }, else null. Used by the rsvp
  // view to derive the response<->event link (linkColumn = name, eventKey = valueCol) from a ref column.
  function tableRefCol(schema, table, targetTable) {
    var cols = schema[table] && schema[table].columns;
    if (!cols) return null;
    for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.type === 'ref' && d.table === targetTable) return { name: c, valueCol: d.valueCol }; }
    return null;
  }

  // Any-table scanners: a column name is typed the same wherever it appears (mirror clusters share
  // names), so "does column `col` have property X in ANY table?" is schema-static. These were O(tables)
  // per call and are hit per-cell per-render (data-cell) — so aggregate every column's attributes into
  // one map, built once per schema and memoized in a WeakMap keyed on the schema object. Safe because
  // SCHEMA is built once at load and every runtime schema change forces a full page reload (new object
  // -> fresh cache). "First table wins" for list/listSwitch matches the old iteration-order semantics.
  var _scanCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function scanSchema(schema) {
    var info = {};
    for (var t in schema) {
      var cols = (schema[t] && schema[t].columns) || {};
      for (var c in cols) {
        var e = info[c] || (info[c] = { list: null, listSwitch: null, multiselect: false, date: false, ref: false, allowNew: false, sorted: false, image: false, url: false, number: false, picker: null });
        var typ = columnType(schema, t, c), d = cols[c];
        if (typ === 'multiselect') e.multiselect = true;
        if (typ === 'date') e.date = true;
        if (typ === 'image') e.image = true;
        if (typ === 'url') e.url = true;
        if (typ === 'number') e.number = true;
        if (d && typeof d === 'object') {
          // `multiple: true` is cardinality, and cardinality is all that ever separated `multiselect`
          // from `select`. As a flag it composes: `ref` + `multiple` is a reference that holds several
          // values, which no type name could express -- schemas wanting one had to point a
          // `multiselect` at a lookup table through `list` and lose every ref behaviour on the way.
          if (d.multiple) e.multiselect = true;
          if (d.type === 'ref') e.ref = true;   // object-only, matching columnRef (a bare 'ref' string is not a ref)
          if (e.list == null && d.list) e.list = d.list;
          if (e.listSwitch == null && d.listSwitch) e.listSwitch = d.listSwitch;
          if (d.allowNew) e.allowNew = true;
          if (d.sorted) e.sorted = true;
          if (e.picker == null && d.picker) e.picker = d.picker;   // select input widget: 'chips' | 'toggle' (else dropdown)
        }
      }
    }
    return info;
  }
  var _EMPTY = { list: null, listSwitch: null, multiselect: false, date: false, ref: false, allowNew: false, sorted: false, image: false, url: false, number: false, picker: null };
  function colInfo(schema, col) {
    var m = _scanCache && _scanCache.get(schema);
    if (!m) { m = scanSchema(schema); if (_scanCache) _scanCache.set(schema, m); }
    return m[col] || _EMPTY;
  }
  function colIsList(schema, col) { return colInfo(schema, col).list; }                    // list name or null
  function colIsMultiselect(schema, col) { return colInfo(schema, col).multiselect; }
  function colIsDate(schema, col) { return colInfo(schema, col).date; }
  function colIsNumber(schema, col) { return colInfo(schema, col).number; }                // any table declaring it `number` -> sort numerically (views have no SCHEMA entry)
  function colIsRef(schema, col) { return colInfo(schema, col).ref; }
  function colListSwitch(schema, col) { return colInfo(schema, col).listSwitch; }
  function colAllowNew(schema, col) { return colInfo(schema, col).allowNew; }
  function colIsSorted(schema, col) { return colInfo(schema, col).sorted; }
  function colIsImage(schema, col) { return colInfo(schema, col).image; }
  function colIsUrl(schema, col) { return colInfo(schema, col).url; }
  function colPicker(schema, col) { return colInfo(schema, col).picker; }   // 'chips' | 'toggle' | null (dropdown)

  // View column-entry shape predicates (a view's `columns` array mixes plain names, {name,...} defs,
  // inline embeds, named-view embeds and legacy text blocks). Moved here from schema-loader.js so the
  // embed/row modules can require them; the browser also gets them as bare globals (see export below).
  function colName(c) { return c && typeof c === 'object' ? (c.name || Object.keys(c)[0]) : c; }
  function isEmbed(c) { return typeof c === 'object' && c.sources && !c.name; }
  function isViewEmbed(c) { return typeof c === 'object' && typeof c.view === 'string'; } // {view:name,filter?,hideEmpty?} -> embed a named view
  function isText(c) { return typeof c === 'object' && c.text && !c.name && !c.sources; }

  // --- Which OTHER tables a column needs loaded ------------------------------------------------
  // Five column shapes resolve their value out of a different table, and each one reads the row cache
  // directly with no load path of its own -- a ref dropdown, a lookup computed, a rotation column, its
  // occurrence source, and a mirror's master. When the cache has no entry for that table they do not
  // fail: they resolve to [] or undefined. An empty dropdown and a blank lookup cell look like data,
  // not like a missing fetch, which is why this derivation exists as a NAMED dependency rather than
  // being left to whatever boot happened to have loaded.
  //
  // Scope, deliberately: tables a column's VALUE needs. Embed entries (`c.sources`, `{view:x}`) are a
  // rendering dependency that app-core preloads separately and cannot be resolved here anyway -- a
  // view embed names a view, and this module is pure over the TABLES map.
  function defTables(def) {
    if (!def || typeof def !== 'object') return [];
    var out = [];
    if (def.type === 'ref' && def.table) out.push(def.table);
    if (typeof def.syncFrom === 'string' && def.syncFrom) out.push(def.syncFrom);   // mirror -> its master
    var comp = def.computed;
    if (comp && typeof comp === 'object') {
      if (comp.lookup && comp.lookup.table) out.push(comp.lookup.table);
      if (comp.rotationTable) out.push(comp.rotationTable);
      if (comp.occurrenceSource) out.push(comp.occurrenceSource);
    }
    return out;
  }

  // Union of defTables over an array of column ENTRIES -- a view's `columns` or `compute`, which mix
  // plain names (no dependency) with definition objects. Deduped, order of first appearance.
  function entryTables(entries) {
    var seen = {}, out = [];
    (entries || []).forEach(function(c) {
      defTables(c).forEach(function(t) { if (!seen[t]) { seen[t] = 1; out.push(t); } });
    });
    return out;
  }

  // Every table joined to `table` by a mirror column (`syncFrom`), in BOTH directions and transitively:
  // the upstream masters this table copies from, and the downstream tables copying from it. A mirror
  // cluster is one logical row spread over several tables, so anything that creates, deletes, archives
  // or access-checks a row has to see the whole cluster.
  //
  // Memoized per schema, for the same reason scanSchema is: this is O(tables x columns) and it is asked
  // per nav item, per embed source and per table load — sidebarTabs alone ran it once for every entry on
  // every recompute. The schema object is built once at load and any runtime change forces a full page
  // reload, so a WeakMap keyed on it can never go stale.
  //
  // The returned array is CACHED, so it is read-only. schema-loader's withMirrors copies out of it.
  var _mirrorCache = (typeof WeakMap !== 'undefined') ? new WeakMap() : null;
  function mirrorCluster(schema, table) {
    var per = _mirrorCache && _mirrorCache.get(schema);
    if (!per && _mirrorCache) { per = {}; _mirrorCache.set(schema, per); }
    if (per && per[table]) return per[table];
    var set = [table];
    for (var i = 0; i < set.length; i++) {          // grows as tables are discovered -> transitive closure
      var t = set[i], cols = (schema[t] && schema[t].columns) || {};
      for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.syncFrom && set.indexOf(d.syncFrom) < 0) set.push(d.syncFrom); }
      for (var mt in schema) {                      // downstream tables mirroring t
        if (set.indexOf(mt) >= 0) continue;
        var mc = (schema[mt] && schema[mt].columns) || {};
        for (var k in mc) { var md = mc[k]; if (md && typeof md === 'object' && md.syncFrom === t) { set.push(mt); break; } }
      }
    }
    if (per) per[table] = set;
    return set;
  }

  // Union of defTables over one table's own column definitions, EXCLUDING itself: a self-reference is
  // already the table being loaded, and returning it would make callers re-request what they hold.
  // `columns` ships in BOTH shapes -- a name->def map, and an array of {name,...} defs (examples/
  // bishopric-schema.json uses the array form). Normalizing to a list of defs handles both; defTables
  // reads only the def, never the key.
  function tableDeps(schema, table) {
    var seen = {}, out = [];
    columnDefList(schema && schema[table]).forEach(function(d) {
      defTables(d).forEach(function(t) { if (t !== table && !seen[t]) { seen[t] = 1; out.push(t); } });
    });
    return out;
  }

  var C = {
    COLUMN_TYPES: COLUMN_TYPES, COLUMN_KEYS: COLUMN_KEYS, vocabularyErrors: vocabularyErrors,
    columnDefs: columnDefs, columnDefList: columnDefList, ownerColOf: ownerColOf,
    columnType: columnType, columnList: columnList, columnRef: columnRef,
    isMirror: isMirror, tableMirrorSource: tableMirrorSource, tableOwnerCol: tableOwnerCol,
    tableDefaultCols: tableDefaultCols, tableRefCol: tableRefCol,
    colIsList: colIsList, colIsMultiselect: colIsMultiselect, colIsDate: colIsDate, colIsNumber: colIsNumber,
    colIsRef: colIsRef, colListSwitch: colListSwitch, colAllowNew: colAllowNew, colIsSorted: colIsSorted,
    colIsImage: colIsImage, colIsUrl: colIsUrl, colPicker: colPicker,
    colName: colName, isEmbed: isEmbed, isViewEmbed: isViewEmbed, isText: isText,
    defTables: defTables, entryTables: entryTables, tableDeps: tableDeps, mirrorCluster: mirrorCluster
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Columns = C; root.colName = colName; root.isEmbed = isEmbed; root.isViewEmbed = isViewEmbed; root.isText = isText; } // shape predicates as bare globals (schema-loader + app-core call them unqualified)
})(typeof self !== 'undefined' ? self : this);
