// embeds.js — Pure embed resolution: markdown -> render blocks (mdToHtml/mdBlocks), embed spec
// normalization (resolveEmbed -> kind-tagged spec for the unified embed-view renderer), and the
// embed cols/rows readers. Extracted from the app-core root so the resolution logic gets Node tests.
//
// Every function is pure over an explicit `ctx` built by the root (app-core `_embedCtx()`):
//   { views, schema, getColumns, dataCache, currentTable, t, viewWithMe, anchorForView, rotationRowsFor }
// The root keeps thin same-named wrappers, so components/templates/tests are unchanged.
//   Browser: <script src="/embeds.js"> after columns.js + rows.js (needs their globals). Exposes
//            Embeds.* plus mdToHtml as a bare global (schema-loader-era callers + the XSS test).
//   Node:    const Embeds = require('../embeds');
// Runtime-bound global: root._listsCache (embedRowsForItem's filterBy matchList), looked up at call
// time through globalThis — same pattern (and same Node gotcha) as rows.js.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  var Rows = isNode ? require('./rows') : root;         // buildRows/resolveComputed/aggregateRows/sortByCol/condMatches
  var Cols = isNode ? require('./columns') : root;      // colName/isEmbed/isViewEmbed shape predicates

  // A URL safe to place in an href/src attribute: http(s) only. Relative URLs are allowed when they
  // resolve against the page onto http/https. Everything else -- javascript:, data:, vbscript:, file:,
  // or malformed -- returns '' so the attribute renders empty instead of executing. Returns the URL
  // UNESCAPED; a caller building a raw HTML string must esc() the result, while a Vue :href/:src binding
  // escapes automatically. Used by mdToHtml (markdown links) AND the url/image data cells, which store a
  // user-supplied string -- an unchecked `javascript:...` in a url cell runs on click, writer != victim
  // on a shared-write (rsvp) table.
  function safeUrl(u) {
    if (!u) return '';
    var base = (typeof location !== 'undefined') ? location.href : 'http://localhost/';
    try { return /^https?:$/.test(new URL(String(u), base).protocol) ? String(u) : ''; } catch (e) { return ''; }
  }

  // Safe value for an <img src>: http(s), OR an inline RASTER data image. A raster data: URI can't
  // execute script in an <img>, so it's allowed (the paste-a-URL image fallback). data:image/svg+xml is
  // deliberately NOT allowed -- an SVG can carry scripts, and while <img> won't run them, the same value
  // also lands in the wrapping <a href> where navigating to it would. href uses the stricter safeUrl.
  function safeImgSrc(u) {
    if (!u) return '';
    var s = String(u);
    if (/^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(s)) return s;
    return safeUrl(s);
  }

  // Tiny markdown -> HTML for pages (headings, bold/italic, lists, links, paragraphs). Embed tokens are
  // split out before this runs. (Moved from schema-loader.js; location is browser-only, so guard.)
  function mdToHtml(md) {
    var esc = function(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    // `url` here is already HTML-escaped (esc ran on the whole line first), so safeUrl's result is used
    // as-is -- re-escaping would double-encode & in query strings. safeUrl still drops unsafe schemes.
    var inline = function(t) { return esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, text, url) { return '<a href="' + safeUrl(url) + '" target="_blank">' + text + '</a>'; }); };
    var lines = String(md || '').split('\n'), out = [], i = 0;
    while (i < lines.length) {
      var l = lines[i], h = /^(#{1,4})\s+(.*)/.exec(l);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*[-*]\s+/.test(l)) { var items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>'); i++; } out.push('<ul>' + items.join('') + '</ul>'); continue; }
      if (l.trim() === '') { i++; continue; }
      out.push('<p>' + inline(l) + '</p>'); i++;
    }
    return out.join('');
  }

  // v3 pages: a {{view:x}}/{{table:x}} embed block — the embed-view component resolves cols/rows itself.
  function buildEmbedBlock(type, name, part, ctx) {
    if ((type === 'view' && ctx.views[name]) || (type === 'table' && ctx.schema[name])) return { embedType: type, embedName: name, embedPart: part || null };
    return { html: '<em>Unknown embed: ' + type + ':' + name + '</em>' };
  }

  // Parse markdown into render blocks: {html} or {embedType,embedName,embedPart}. `?` hides empty embeds.
  function mdBlocks(markdown, selfName, ctx) {
    var md = String(markdown || '').replace(/\{\{\s*self\s*\}\}/g, selfName ? '{{view:' + selfName + '}}' : '').replace(/\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/g, function(_, k) { return ctx.t(k) || ''; });
    var parts = md.split(/\{\{\s*(view|table)\s*:\s*([^\s@?{}:]+(?:@[^\s?{}:]+)?\??)\s*\}\}/);
    var blocks = [], i = 0;
    while (i < parts.length) {
      // Guard on the RENDERED html, not the raw text: whitespace-only prose (the newline after a closing
      // {{view:x}}, say) renders to '' and would be pushed as a block with a falsy `html`. Both templates
      // dispatch with `v-if="blk.html" … v-else <embed-view>`, so such a block fell through to the embed
      // branch with no type/name — a phantom empty grid plus an "Add" button at the end of the page.
      if (parts[i]) { var _h = mdToHtml(parts[i]); if (_h) blocks.push({ html: _h }); }
      if (i + 2 < parts.length) {
        var type = parts[i + 1], raw = parts[i + 2];
        var optional = raw.charAt(raw.length - 1) === '?'; if (optional) raw = raw.slice(0, -1);
        var at = raw.indexOf('@'), part = at >= 0 ? raw.slice(at + 1) : null, name = at >= 0 ? raw.slice(0, at) : raw;
        if (!(optional && embedRows(type, name, part, ctx).length === 0)) blocks.push(buildEmbedBlock(type, name, part, ctx)); // hide-when-empty
        i += 3;
      } else break;
    }
    return blocks;
  }

  // For an embedded doc-view: false only if it has data embeds and ALL of them are empty (hide whole doc-view).
  function docHasData(markdown, selfName, ctx) {
    var md = String(markdown || '').replace(/\{\{\s*self\s*\}\}/g, selfName ? '{{view:' + selfName + '}}' : '');
    var re = /\{\{\s*(view|table)\s*:\s*([^\s@?{}:]+)(@[^\s?{}:]+)?\??\s*\}\}/g, m, any = false;
    while ((m = re.exec(md))) { any = true; if (embedRows(m[1], m[2], m[3] ? m[3].slice(1) : null, ctx).length) return true; }
    return !any;
  }

  // Normalize one embed config into a render `spec` for the unified embed renderer. The `kind` field
  // drives dispatch: 'doc' (markdown blocks), 'calendar'/'rotation' (delegated to those components),
  // 'data' (a view/table's rows). Shared by embedItems (data-view) and the page/doc paths.
  function resolveEmbed(cfg, ctx) {
    if (typeof cfg.markdown === 'string' && !cfg.filterBy && cfg.name) { // named doc-view embed (no filterBy: global show/hide)
      return { config: cfg, kind: 'doc', blocks: mdBlocks(cfg.markdown, cfg.name, ctx), show: docHasData(cfg.markdown, cfg.name, ctx) };
    }
    if (cfg.calendar) { // calendarView embed -> delegate to the calendar-view component (embed mode)
      return { config: cfg, kind: 'calendar', name: cfg.view || cfg.name || ctx.currentTable };
    }
    if (cfg.pivot) { // pivotView embed -> delegate to the pivot-view component (embed mode)
      return { config: cfg, kind: 'pivot', name: cfg.view || cfg.name || ctx.currentTable };
    }
    if (cfg.rsvp) { // rsvpView embed -> delegate to the rsvp-view component (embed mode)
      return { config: cfg, kind: 'rsvp', name: cfg.view || cfg.name || ctx.currentTable };
    }
    if (cfg.rotation) { // rotationView embed (a {view:x} where x is a rotationView) -> generate period rows
      var anchorName = cfg.view || cfg.name || ctx.currentTable;
      var rrows = ctx.rotationRowsFor(anchorName, cfg.rotation);
      var slotNames = cfg.rotation.slots ? cfg.rotation.slots.slice() : (cfg.rotation.columns || []).map(function(c) { return c.name; });
      return { config: cfg, kind: 'rotation', name: anchorName, columns: ['_period'].concat(slotNames), rows: rrows };
    }
    var raw = cfg.columns || (cfg.view && ctx.views[cfg.view] ? ctx.views[cfg.view].columns : []);
    var columns = raw.map(function(c) { return Cols.colName(c); });
    var rows = Rows.buildRows(ctx.viewWithMe(cfg), ctx.dataCache);
    Rows.resolveComputed(rows, cfg.columns || [], { dataCache: ctx.dataCache, rotationAnchor: ctx.anchorForView(ctx.currentTable) });
    if (cfg.defaultSort) { rows = Rows.sortByCol(rows, cfg.defaultSort); }
    if (cfg.hideEmpty) { columns = columns.filter(function(col) { return rows.some(function(r) { return r[col]; }); }); }
    // Inline embed markdown: build blocks (prose + {{self}} markers for own table)
    var inlineBlocks = null;
    if (typeof cfg.markdown === 'string') {
      var md = String(cfg.markdown).replace(/\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/g, function(_, k) { return ctx.t(k) || ''; });
      var blockParts = md.split(/\{\{\s*self\s*\}\}/);
      inlineBlocks = [];
      blockParts.forEach(function(part, i) {
        if (part.trim()) inlineBlocks.push({ html: mdToHtml(part.trim()) });
        if (i < blockParts.length - 1) inlineBlocks.push({ self: true }); // marker: render own table here
      });
    }
    return { config: cfg, kind: 'data', columns: columns, rows: rows, inlineBlocks: inlineBlocks };
  }

  // Visible (non-embed, non-hidden) columns of an embedded view/table.
  function embedCols(type, name, ctx) {
    if (type === 'view' && ctx.views[name]) return (ctx.views[name].columns || []).filter(function(c) { return !Cols.isEmbed(c) && !Cols.isViewEmbed(c); }).map(Cols.colName);
    if (type === 'table' && ctx.schema[name]) return ctx.getColumns(name).filter(function(c) { var d = ctx.schema[name].columns[c]; return c !== 'id' && !(d && typeof d === 'object' && d.hidden); });
    return [];
  }

  // Rows of an embedded view/table (@part reads the partition caches, e.g. tasks__archive).
  function embedRows(type, name, part, ctx) {
    if (type === 'view' && ctx.views[name]) {
      var v = ctx.views[name], cache = ctx.dataCache;
      if (part) { cache = {}; var dc = ctx.dataCache; (v.sources || []).forEach(function(s) { cache[s] = dc[s + '__' + part] || []; }); }
      var vMe = ctx.viewWithMe(v);
      var esrc = Rows.buildRows(vMe, cache);
      if (v.compute) esrc = Rows.resolveComputed(esrc, v.compute, { dataCache: ctx.dataCache, rotationAnchor: ctx.anchorForView(v.name) });
      return Rows.sortByCol(Rows.resolveComputed(Rows.aggregateRows(vMe, esrc), v.columns, { dataCache: ctx.dataCache, rotationAnchor: ctx.anchorForView(v.name) }), v.defaultSort, v);
    }
    if (type === 'table' && ctx.schema[name]) return Rows.sortByCol(ctx.dataCache[part ? name + '__' + part : name] || [], ctx.schema[name].defaultSort);
    return [];
  }

  // Per-card slice of an embed's rows: filterBy maps embed columns to the card row's values (or to a
  // named list via matchList). No filterBy / no card row -> the embed's own rows.
  function embedRowsForItem(ei, item) {
    if (!ei.config.filterBy || !item) return ei.rows;
    var fb = ei.config.filterBy; // { embedCol: cardCol } or { embedCol: { matchList: "listName" } }
    return ei.rows.filter(function(r) {
      for (var k in fb) { var v = fb[k]; if (v && typeof v === 'object' && v.matchList) { var _L = root._listsCache && root._listsCache[v.matchList]; var _rv = r[k]; var _ok = _L && (Array.isArray(_rv) ? _rv.some(function(x){ return _L.indexOf(x) >= 0; }) : _L.indexOf(_rv) >= 0); if (!_ok) return false; } else if (r[k] !== item[v]) return false; }
      return true;
    });
  }

  // Per-row embed visibility: an embed entry may carry a `when` filter (same condMatches engine
  // as columns/row-filters) to show a prose/data block only on cards whose row matches.
  function embedWhenOk(ei, item) { return !ei.config.when || Rows.condMatches(item || {}, ei.config.when); }

  // Whether an embed has content to show at all (drives the wrapper v-if in every position). doc ->
  // its own show flag; calendar -> always (the component handles its own emptiness); otherwise the
  // relevant rows (per-row filterBy slice when an `item` context is given) must be non-empty.
  function embedVisible(ei, item) {
    if (ei.kind === 'doc') return !!ei.show;
    if (ei.kind === 'calendar' || ei.kind === 'pivot' || ei.kind === 'rsvp') return true;
    var rows = (ei.config.filterBy && item) ? embedRowsForItem(ei, item) : ei.rows;
    return !!(rows && rows.length);
  }

  var M = {
    mdToHtml: mdToHtml, buildEmbedBlock: buildEmbedBlock, mdBlocks: mdBlocks, docHasData: docHasData,
    resolveEmbed: resolveEmbed, embedCols: embedCols, embedRows: embedRows,
    embedRowsForItem: embedRowsForItem, embedWhenOk: embedWhenOk, embedVisible: embedVisible, safeUrl: safeUrl, safeImgSrc: safeImgSrc
  };
  if (isNode) module.exports = M;
  else { root.Embeds = M; root.mdToHtml = mdToHtml; root.safeUrl = safeUrl; root.safeImgSrc = safeImgSrc; } // bare globals: mdToHtml (pageBlocks-era + tests), safeUrl/safeImgSrc (ROOT_PROXY)
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
