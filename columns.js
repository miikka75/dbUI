// columns.js — Pure schema-derived column typing, shared by app-core.html (browser) + dev/schema.js
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
    if (!table) { for (var t in schema) { var l = columnList(schema, t, col); if (l) return l; } return null; }
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

  // Any-table scanners: a column name is typed the same wherever it appears (mirror clusters share names).
  function scanProp(schema, col, pred) {
    for (var t in schema) { var d = schema[t].columns[col]; if (d && typeof d === 'object' && pred(d)) return true; }
    return false;
  }
  function colIsList(schema, col) { return columnList(schema, null, col); }              // list name or null
  function colIsMultiselect(schema, col) { for (var t in schema) { if (columnType(schema, t, col) === 'multiselect') return true; } return false; }
  function colIsDate(schema, col) { for (var t in schema) { if (columnType(schema, t, col) === 'date') return true; } return false; }
  function colIsRef(schema, col) { for (var t in schema) { if (columnRef(schema, t, col)) return true; } return false; }
  function colListSwitch(schema, col) { for (var t in schema) { var d = schema[t].columns[col]; if (d && typeof d === 'object' && d.listSwitch) return d.listSwitch; } return null; }
  function colAllowNew(schema, col) { return scanProp(schema, col, function(d) { return !!d.allowNew; }); }
  function colIsSorted(schema, col) { return scanProp(schema, col, function(d) { return !!d.sorted; }); }

  // View column-entry shape predicates (a view's `columns` array mixes plain names, {name,...} defs,
  // inline embeds, named-view embeds and legacy text blocks). Moved here from schema-loader.html so the
  // embed/row modules can require them; the browser also gets them as bare globals (see export below).
  function colName(c) { return c && typeof c === 'object' ? (c.name || Object.keys(c)[0]) : c; }
  function isEmbed(c) { return typeof c === 'object' && c.sources && !c.name; }
  function isViewEmbed(c) { return typeof c === 'object' && typeof c.view === 'string'; } // {view:name,filter?,hideEmpty?} -> embed a named view
  function isText(c) { return typeof c === 'object' && c.text && !c.name && !c.sources; }

  var C = {
    columnType: columnType, columnList: columnList, columnRef: columnRef,
    isMirror: isMirror, tableMirrorSource: tableMirrorSource,
    colIsList: colIsList, colIsMultiselect: colIsMultiselect, colIsDate: colIsDate,
    colIsRef: colIsRef, colListSwitch: colListSwitch, colAllowNew: colAllowNew, colIsSorted: colIsSorted,
    colName: colName, isEmbed: isEmbed, isViewEmbed: isViewEmbed, isText: isText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  else { root.Columns = C; root.colName = colName; root.isEmbed = isEmbed; root.isViewEmbed = isViewEmbed; root.isText = isText; } // shape predicates as bare globals (schema-loader + app-core call them unqualified)
})(typeof self !== 'undefined' ? self : this);
