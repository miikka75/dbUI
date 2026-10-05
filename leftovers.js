// leftovers.js — What the database still holds that the schema no longer refers to.
//
//   Browser: <script src="/leftovers.js">, then Leftovers.corpus(docs) / Leftovers.unreferenced(name, corpus).
//   Node:    const Leftovers = require('../leftovers').
//
// A schema moves on; the database does not. A list a retired column used, a lookup table nothing points
// at any more: none of it announces itself, and the Lists tab renders a dead vocabulary exactly like a
// live one. This module answers "does anything still name it?".
//
// THE ANSWER MAY BE SILENT, NEVER WRONG. A plain list is reached by `list` and `listSwitch.list`, but
// also by a column's own NAME (the per-column-name list resolver), by `listSources` KEYS, by `matchList`
// in a filter, by `translatableLists`; a lookup table by `ref`, `list:`, a board's ref lane, `rosterRef`,
// `computed.lookup`, a nav entry, a user-built calendar. Enumerating those paths is how a badge ends up
// telling someone their live catalogue is dead the day a new path is added. So this does not enumerate:
// a name counts as referenced if it occurs as a whole word in ANY string -- key or value -- of anything
// that can refer to it. A false "referenced" costs a missing badge; a false "unreferenced" invites the
// deletion of the only copy of somebody's data.
(function (root) {
  // Every string in the documents, keys included, as one text to search. `skipKeysOf` names objects
  // whose own KEYS are declarations rather than references -- the schema's `tables` map, where a table
  // being declared is not the table being used. Their contents are still walked: a lookup that refers
  // to itself (an id-keyed hierarchy) is referenced, and silence is the safe answer there.
  function corpus(docs, skipKeysOf) {
    var out = [], seen = [];
    var skip = skipKeysOf || [];
    function walk(v) {
      if (v == null) return;
      if (typeof v === 'string') { out.push(v); return; }
      if (typeof v !== 'object') return;
      if (seen.indexOf(v) >= 0) return;   // VIEWS and the schema doc share objects; walk each once
      seen.push(v);
      if (Array.isArray(v)) { v.forEach(walk); return; }
      var declaresOnly = skip.indexOf(v) >= 0;
      Object.keys(v).forEach(function (k) {
        if (!declaresOnly) out.push(k);
        walk(v[k]);
      });
    }
    (docs || []).forEach(walk);
    return out.join('\n');
  }

  // Whole word, where a word is what a name may be made of. `ref_chores` inside `ref_chores_old` is not
  // a reference to it; `ref_chores` inside `{{view:x}}`-style prose or `list.ref_chores.x` is.
  function escape(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function unreferenced(name, text) {
    if (!name) return false;
    return !new RegExp('(^|[^A-Za-z0-9_-])' + escape(name) + '($|[^A-Za-z0-9_-])').test(text || '');
  }

  var M = { corpus: corpus, unreferenced: unreferenced };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Leftovers = M;
})(typeof self !== 'undefined' ? self : this);
