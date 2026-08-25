// schema.js — the Node test harness's schema loader: SCHEMA/VIEWS/_columnOrders from schema.json.
//
// The CONVERSION is /schema-normalize.js — the same module schema-loader.js runs in the browser. This
// file used to re-implement it (flatten + colMap + implicit id), which meant the unit suite normalized
// schemas differently from the app: its view discriminator drifted a kind behind, and it ran neither
// the migration chain nor convertViewFilters, so no test took a legacy schema through the real load
// path. What is left here is genuinely harness-local: the module bindings, and the partition fields.
var _defaultSchema;
if (typeof require !== 'undefined') {
  _defaultSchema = require('./schema.json');
} else if (typeof window !== 'undefined' && window._loadedSchema) {
  _defaultSchema = window._loadedSchema;
}

var SchemaNormalize = require('../schema-normalize');
var _norm = SchemaNormalize.normalize(_defaultSchema || {});

var SCHEMA = _norm.tables;
var VIEWS = _norm.viewsMap;
var _viewsNav = _norm.views;
var _columnOrders = _norm.orders;
var DEFAULT_LANGUAGE = (_defaultSchema && _defaultSchema.defaultLanguage) || 'en';

// HARNESS-ONLY: the browser never sets these. `partition`/`archivePartition` name the storage tabs a
// table occupies, and the Node backends (backend-local's initSchema, storage-fs) read them off the
// table def to decide which physical tables to create — where the browser passes the tab around
// explicitly. Kept here rather than in the shared normalizer so the app's schema does not grow two
// fields it has no use for.
for (var t in SCHEMA) {
  SCHEMA[t].partition = 'active';
  SCHEMA[t].archivePartition = (SCHEMA[t].archivable || SCHEMA[t].archivePartition) ? 'archive' : null;
}

// Column typing primitives come from the shared /columns.js module (also used by the browser app),
// bound here to this module's SCHEMA. getColumns is order-dependent (_columnOrders) so it stays local.
var Columns = require('../columns');
function getColumns(table) { return _columnOrders[table] || Object.keys((SCHEMA[table] && SCHEMA[table].columns) || {}); }
function getColumnType(table, col) { return Columns.columnType(SCHEMA, table, col); }
function getColumnList(table, col) { return Columns.columnList(SCHEMA, table, col); }
function getColumnRef(table, col) { return Columns.columnRef(SCHEMA, table, col); }

if (typeof module !== 'undefined') module.exports = { SCHEMA, VIEWS, DEFAULT_LANGUAGE, getColumns, getColumnType, getColumnList, getColumnRef, _viewsNav };
