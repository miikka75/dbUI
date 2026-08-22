// form.js — Pure builder for the `form` view: one focused record, filled in properly, rather than a
// cell edited in a grid. Framework-agnostic + Node-tested, like calendar/rotation/pivot/rsvp.
//
//   Browser: <script src="/form.js">, then Form.build(rows, opts).  Node: require('../form').
//
// WHY A KIND AT ALL, given `rsvp` exists: rsvp is this shape hard-wired to one question ("what is your
// status for each of these events?"). Everything underneath — an owner-stamped row the member writes
// themselves, gated by ownerWritable/ownerWritableWhile — is the same machinery. What rsvp cannot
// express is a record with SEVERAL fields, grouped, where some are required and the thing is submitted
// once rather than toggled. That is surveys, applications, intake, feedback.
//
// This module answers only the questions that are pure over data:
//   which row is mine · which fields go in which section · what is still missing · may I still edit it
// Rendering the fields (data-cell) and writing them (saveField) stay in the component and the root,
// exactly as they do for every other kind.
//
// opts:
//   me            the owner value identifying the current user (an email); '' when signed out
//   ownerCol      owner column on the record rows (default 'owner')
//   columns       ordered column names the form edits, when no sections are declared
//   sections      [{ title?, columns: [...] }] — declared grouping; `columns` above is ignored if set
//   required      column names that must be non-empty before the record counts as complete
//   once          true (default) = one record per person; false = a fresh blank record each time
//   whileCol      ownerWritableWhile column, if the table declares one
//   whileVals     the values of whileCol that keep the record owner-editable
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);

  // A value counts as filled unless it is blank. An empty ARRAY counts as blank too -- a multi-value
  // column with nothing chosen is exactly as unanswered as an empty text box, and `required` would
  // otherwise be satisfied by a field the person never touched.
  function filled(v) {
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    return String(v).trim() !== '';
  }

  // Normalize the declared grouping into [{ title, columns }]. A form with no `sections` is one
  // untitled section over `columns`, so the component renders one shape rather than two.
  function sectionsOf(opts) {
    var declared = opts.sections;
    if (Array.isArray(declared) && declared.length) {
      return declared
        .filter(function (s) { return s && Array.isArray(s.columns) && s.columns.length; })
        .map(function (s) { return { title: s.title || '', columns: s.columns.slice() }; });
    }
    var cols = Array.isArray(opts.columns) ? opts.columns.slice() : [];
    return cols.length ? [{ title: '', columns: cols }] : [];
  }

  // Every column the form touches, in section order, deduped. The caller needs this to decide what to
  // stamp on a new record and what to compare against `required`.
  function columnsOf(sections) {
    var seen = {}, out = [];
    (sections || []).forEach(function (s) {
      (s.columns || []).forEach(function (c) { if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
    });
    return out;
  }

  // The caller's own record. `once` forms have at most one; without it the caller starts a new blank
  // each time and nothing here is theirs to find.
  //
  // Signed out (no `me`) matches NOTHING, deliberately: an owner column is stamped with an identity,
  // and matching rows whose owner is also blank would hand one anonymous visitor another's draft.
  function mine(rows, opts) {
    var me = opts.me || '', ownerCol = opts.ownerCol || 'owner';
    if (!me || opts.once === false) return null;
    var found = null;
    (rows || []).forEach(function (r) {
      if (!r || r[ownerCol] !== me) return;
      // Last wins: if a duplicate ever exists (two tabs, a failed delete), the most recently updated
      // one is the one the person last worked on.
      if (!found || String(r.updated_at || '') >= String(found.updated_at || '')) found = r;
    });
    return found;
  }

  // Is the record still the owner's to change? Mirrors ownerWritableWhile in both rule layers: an empty
  // whileCol means no state gate. Read off the STORED record, never a proposed one -- the same reason
  // the rules read `resource.data`.
  //
  // A record that does not exist yet is writable: creating it is what the form is for.
  function editable(record, opts) {
    if (!record) return true;
    var col = opts.whileCol;
    if (!col) return true;
    var vals = opts.whileVals || [];
    if (!vals.length) return true;
    return vals.indexOf(record[col]) >= 0;
  }

  // Returns everything the component needs to render one form:
  //   record     the caller's own row, or null when there is none yet
  //   sections   [{ title, columns }]
  //   columns    every column the form touches, in order
  //   missing    required columns still blank on `record` (all of them when there is no record)
  //   complete   nothing missing
  //   submitted  a record exists
  //   editable   the owner may still change it
  function build(rows, opts) {
    opts = opts || {};
    var sections = sectionsOf(opts);
    var columns = columnsOf(sections);
    var record = mine(rows, opts);
    var required = (opts.required || []).filter(function (c) { return columns.indexOf(c) >= 0; });
    var missing = required.filter(function (c) { return !filled(record ? record[c] : undefined); });
    return {
      record: record,
      sections: sections,
      columns: columns,
      required: required,
      missing: missing,
      complete: missing.length === 0,
      submitted: !!record,
      editable: editable(record, opts)
    };
  }

  var M = { build: build, filled: filled, sectionsOf: sectionsOf, columnsOf: columnsOf, mine: mine, editable: editable };
  if (isNode) module.exports = M;
  else root.Form = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
