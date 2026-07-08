// schema.js — Derives SCHEMA/VIEWS from schema.json, builds colMap for O(1) lookup
var _defaultSchema;
if (typeof require !== 'undefined') {
  _defaultSchema = require('./schema.json');
} else if (typeof window !== 'undefined' && window._loadedSchema) {
  _defaultSchema = window._loadedSchema;
}

var SCHEMA = _defaultSchema ? _defaultSchema.tables : {};
var VIEWS = {};
var _viewsNav = _defaultSchema ? (_defaultSchema.views || []) : [];
var DEFAULT_LANGUAGE = _defaultSchema ? (_defaultSchema.defaultLanguage || 'en') : 'en';

// Flatten views array into VIEWS object (keyed by name), recursing into items
(function flattenViews(arr) {
  (arr || []).forEach(function(v) {
    if (v.name && (v.sources || typeof v.markdown === 'string' || v.rotation || v.calendar || v.pivot || v.rsvp)) { VIEWS[v.name] = v; }
    if (v.views) flattenViews(v.views);
  });
})(_viewsNav);

// Build colMap (object keyed by name) from array columns, preserving order
var _columnOrders = {};
for (var t in SCHEMA) {
  SCHEMA[t].partition = 'active';
  SCHEMA[t].archivePartition = (SCHEMA[t].archivable || SCHEMA[t].archivePartition) ? 'archive' : null;
  if (Array.isArray(SCHEMA[t].columns)) {
    var colMap = {};
    _columnOrders[t] = [];
    SCHEMA[t].columns.forEach(function(c) {
      if (!c.name) return; // skip text/embed entries
      var name = c.name;
      _columnOrders[t].push(name);
      var def = Object.assign({}, c);
      delete def.name;
      colMap[name] = Object.keys(def).length ? def : 'text';
    });
    SCHEMA[t].columns = colMap;
  } else {
    _columnOrders[t] = Object.keys(SCHEMA[t].columns || {});
  }
}
// id is implicit: auto-inject so schemas needn't declare it (stays storage PK + join/archive key)
for (var _t in SCHEMA) {
  if (SCHEMA[_t].columns && !SCHEMA[_t].columns.id) { SCHEMA[_t].columns.id = 'text'; if (_columnOrders[_t] && _columnOrders[_t].indexOf('id') === -1) _columnOrders[_t].unshift('id'); }
}

// Column typing primitives come from the shared /columns.js module (also used by the browser app),
// bound here to this module's SCHEMA. getColumns is order-dependent (_columnOrders) so it stays local.
var Columns = require('../columns');
function getColumns(table) { return _columnOrders[table] || Object.keys((SCHEMA[table] && SCHEMA[table].columns) || {}); }
function getColumnType(table, col) { return Columns.columnType(SCHEMA, table, col); }
function getColumnList(table, col) { return Columns.columnList(SCHEMA, table, col); }
function getColumnRef(table, col) { return Columns.columnRef(SCHEMA, table, col); }

if (typeof module !== 'undefined') module.exports = { SCHEMA, VIEWS, DEFAULT_LANGUAGE, getColumns, getColumnType, getColumnList, getColumnRef, _viewsNav };
