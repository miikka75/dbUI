// schema.js — Derives SCHEMA/VIEWS from schema.json for Node tests and legacy loading
var _defaultSchema;
if (typeof require !== 'undefined') {
  _defaultSchema = require('../schema.json');
} else if (typeof window !== 'undefined' && window._loadedSchema) {
  _defaultSchema = window._loadedSchema;
}

var SCHEMA = _defaultSchema ? _defaultSchema.tables : {};
var VIEWS = _defaultSchema ? _defaultSchema.views : {};
var DEFAULT_LANGUAGE = _defaultSchema ? (_defaultSchema.defaultLanguage || 'en') : 'en';

function getColumns(table) { return Object.keys(SCHEMA[table].columns); }
function getColumnType(table, col) {
  var def = SCHEMA[table].columns[col];
  if (!def) return 'text';
  if (typeof def === 'string') return def;
  return def.type || 'text';
}
function getColumnList(table, col) {
  var def = SCHEMA[table].columns[col];
  return (def && typeof def === 'object') ? def.list : null;
}
function getColumnRef(table, col) {
  var def = SCHEMA[table].columns[col];
  return (def && typeof def === 'object' && def.type === 'ref') ? def : null;
}

if (typeof module !== 'undefined') module.exports = { SCHEMA, VIEWS, DEFAULT_LANGUAGE, getColumns, getColumnType, getColumnList, getColumnRef };
