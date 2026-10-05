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

  // The report: everything left over, as rows a person reads and decides about one at a time. A report,
  // never a sweep -- a rename is indistinguishable from a deletion plus a creation, and the data is the
  // only copy. Same one-sided rule as the badge: anything uncertain is left out.
  //
  // opts:
  //   text          corpus() over everything that can name things
  //   lists         { name: [values] } -- the named lists the database holds
  //   lookups       { name: rowCount } -- the schema's lookup tables
  //   tables        every table the schema declares (a list.<ns> key whose ns is a TABLE is a lookup
  //                 vocabulary, whose values this cannot judge, so it is never reported)
  //   pages         ids of the stored page bodies (_pages)
  //   views         { name: view } -- a page body whose view is gone is left over
  //   links         { list: { value: email } } -- account links
  //   translations  { langCode: { key: text } }
  //   keep          keys the app's own UI uses, never reported
  //
  // -> [{ kind: 'list'|'lookup'|'page'|'link'|'translation', name, count?, list?, value? }]
  function inventory(opts) {
    var text = opts.text || '', lists = opts.lists || {}, tables = opts.tables || [], out = [];
    var isTable = function (n) { return tables.indexOf(n) >= 0; };
    Object.keys(lists).sort().forEach(function (n) {
      if (!isTable(n) && unreferenced(n, text)) out.push({ kind: 'list', name: n, count: (lists[n] || []).length });
    });
    Object.keys(opts.lookups || {}).sort().forEach(function (n) {
      if (unreferenced(n, text)) out.push({ kind: 'lookup', name: n, count: opts.lookups[n] });
    });
    (opts.pages || []).slice().sort().forEach(function (id) {
      if (id && !(opts.views || {})[id]) out.push({ kind: 'page', name: id });
    });
    // A link is to a VALUE: left over when its list is a plain list that no longer holds the value, or a
    // name that is neither a list nor a table. A lookup's values are judged nowhere here.
    var links = opts.links || {};
    Object.keys(links).sort().forEach(function (l) {
      if (isTable(l)) return;
      Object.keys(links[l] || {}).sort().forEach(function (v) {
        var gone = lists[l] ? lists[l].indexOf(v) < 0 : unreferenced(l, text);
        if (gone && links[l][v]) out.push({ kind: 'link', name: l + ' / ' + v, list: l, value: v });
      });
    });
    // Translation keys for things the schema no longer has. Only the schema-derived namespaces: a
    // `text.*` key is named from prose, and the app's own keys (`keep`) are its chrome.
    var keep = {}, count = {};
    (opts.keep || []).forEach(function (k) { keep[k] = 1; });
    var trs = opts.translations || {};
    Object.keys(trs).forEach(function (code) {
      Object.keys(trs[code] || {}).forEach(function (k) {
        if (keep[k] || !deadKey(k, text, lists, isTable)) return;
        count[k] = (count[k] || 0) + 1;
      });
    });
    Object.keys(count).sort().forEach(function (k) { out.push({ kind: 'translation', name: k, count: count[k] }); });
    return out;
  }
  function deadKey(key, text, lists, isTable) {
    var parts = String(key).split('.');
    if (parts.length < 2) return false;
    var head = parts[0];
    // A declared table is unreferenced in the corpus by construction (its declaration is skipped), and
    // its tab label is still live while it is declared.
    if (head === 'tab') return !isTable(parts.slice(1).join('.')) && unreferenced(parts.slice(1).join('.'), text);
    if (head === 'field' || head === 'view') return unreferenced(parts.slice(1).join('.'), text);
    if (head === 'list' && parts.length >= 3) {
      var ns = parts[1], value = parts.slice(2).join('.');
      if (isTable(ns)) return false;
      if (lists[ns]) return lists[ns].indexOf(value) < 0;
      return unreferenced(ns, text);
    }
    return false;
  }

  var M = { corpus: corpus, unreferenced: unreferenced, inventory: inventory };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Leftovers = M;
})(typeof self !== 'undefined' ? self : this);
