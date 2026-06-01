// sheets-helpers.js — Pure data-transformation helpers shared by Code.gs and unit tests.
// In Apps Script: add this as a .gs file (functions become global, the module export is ignored).
// In Node: require('./sheets-helpers'). No GoogleAppsScript globals are referenced here.

// Format a cell value for safe serialization:
//   Date -> 'YYYY-MM-DD' (local date, avoids toISOString UTC shift), null/undefined -> '', else String.
function formatCell(val) {
  if (val instanceof Date) {
    return val.getFullYear() + '-' + String(val.getMonth() + 1).padStart(2, '0') + '-' + String(val.getDate()).padStart(2, '0');
  }
  if (val === null || val === undefined) return '';
  return String(val);
}

// Normalize a columns definition to an array of column names.
// Accepts: object map {name: type}, array of strings, or array of {name,...} objects.
function normalizeColumns(columns) {
  if (Array.isArray(columns)) return columns.map(function(c) { return typeof c === 'object' ? c.name : c; }).filter(Boolean);
  return Object.keys(columns || {});
}

// Convert a 2D sheet value array (row 0 = headers) into { headers, rows } of string-coerced objects.
// Empty headers are dropped but remaining columns keep their original positions (no misalignment).
function valuesToObjects(values) {
  if (!values || !values.length) return { headers: [], rows: [] };
  var cols = [];
  values[0].forEach(function(h, i) { var name = String(h || ''); if (name) cols.push({ name: name, idx: i }); });
  var headers = cols.map(function(c) { return c.name; });
  if (values.length < 2) return { headers: headers, rows: [] };
  var rows = values.slice(1).map(function(row) {
    var obj = {};
    cols.forEach(function(c) { obj[c.name] = formatCell(row[c.idx]); });
    return obj;
  });
  return { headers: headers, rows: rows };
}

// Map a row object to a values array ordered by headers (missing keys -> '').
function objectToValues(rowData, headers) {
  return headers.map(function(h) { return rowData[h] !== undefined ? rowData[h] : ''; });
}

// Find the 0-based index into `data` whose `idCol` column matches `id` (string compare).
// data[0] is the header row, so a match at data[i] corresponds to sheet row i+1. Returns -1 if none.
function findRowIndex(data, idCol, id) {
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(id)) return i;
  }
  return -1;
}

// Build a per-table column-order map from a tables object (arrays preserve order through RPC).
function buildColumnOrders(tables) {
  return Object.keys(tables).reduce(function(acc, t) {
    acc[t] = normalizeColumns(tables[t].columns);
    return acc;
  }, {});
}

// Parse a 2D [key, text] value array (row 0 = header) into a {key: text} map (both cells required).
function parseTranslations(values) {
  var out = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][0] && values[i][1]) out[values[i][0]] = values[i][1];
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatCell, normalizeColumns, valuesToObjects, objectToValues, findRowIndex, buildColumnOrders, parseTranslations };
}
