// columns.js — Pure schema-derived column typing, shared by app-core.js (browser) + dev/schema.js
// (Node) + unit tests. Previously duplicated as globals in app-core and again in dev/schema.js.
// Browser: <script src="/columns.js">, then use via Columns.*
// Node:    const Columns = require('../columns');
//
// All functions are pure over `schema` (the tables map). The single-table accessors are null-guarded
// (missing table -> text/null, never throws); columnList(schema, null, col) scans every table.
(function(root) {
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
    var cols = schema[table] && schema[table].columns;
    if (!cols) return null;
    for (var c in cols) { if (columnType(schema, table, c) === 'owner') return c; }
    return null;
  }
  // Columns carrying a `defaultFrom` token -> [{ name, from }]. The token is resolved by the caller
  // (only '@me' = my profile display name today) and stamped on row CREATE only, so the value stays
  // editable afterwards — unlike an `owner` column, which is auto-stamped and then read-only.
  function tableDefaultCols(schema, table) {
    var cols = schema[table] && schema[table].columns, out = [];
    if (!cols) return out;
    for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.defaultFrom) out.push({ name: c, from: d.defaultFrom }); }
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

  var C = {
    columnType: columnType, columnList: columnList, columnRef: columnRef,
    isMirror: isMirror, tableMirrorSource: tableMirrorSource, tableOwnerCol: tableOwnerCol,
    tableDefaultCols: tableDefaultCols, tableRefCol: tableRefCol,
    colIsList: colIsList, colIsMultiselect: colIsMultiselect, colIsDate: colIsDate, colIsNumber: colIsNumber,
    colIsRef: colIsRef, colListSwitch: colListSwitch, colAllowNew: colAllowNew, colIsSorted: colIsSorted,
    colIsImage: colIsImage, colIsUrl: colIsUrl, colPicker: colPicker,
    colName: colName, isEmbed: isEmbed, isViewEmbed: isViewEmbed, isText: isText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Columns = C; root.colName = colName; root.isEmbed = isEmbed; root.isViewEmbed = isViewEmbed; root.isText = isText; } // shape predicates as bare globals (schema-loader + app-core call them unqualified)
})(typeof self !== 'undefined' ? self : this);
