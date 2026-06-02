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
    if (v.name && v.sources) { VIEWS[v.name] = v; }
    if (v.views) flattenViews(v.views);
  });
})(_viewsNav);

// Build colMap (object keyed by name) from array columns, preserving order
var _columnOrders = {};
for (var t in SCHEMA) {
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

function getColumns(table) { return _columnOrders[table] || Object.keys((SCHEMA[table] && SCHEMA[table].columns) || {}); }
function getColumnType(table, col) {
  var def = SCHEMA[table] && SCHEMA[table].columns[col];
  if (!def) return 'text';
  if (typeof def === 'string') return def;
  return def.type || 'text';
}
function getColumnList(table, col) {
  var def = SCHEMA[table] && SCHEMA[table].columns[col];
  return (def && typeof def === 'object') ? def.list : null;
}
function getColumnRef(table, col) {
  var def = SCHEMA[table] && SCHEMA[table].columns[col];
  return (def && typeof def === 'object' && def.type === 'ref') ? def : null;
}

if (typeof module !== 'undefined') module.exports = { SCHEMA, VIEWS, DEFAULT_LANGUAGE, getColumns, getColumnType, getColumnList, getColumnRef, _viewsNav };
