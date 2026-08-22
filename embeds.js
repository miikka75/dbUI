// embeds.js — Pure embed resolution: markdown -> render blocks (mdToHtml/mdBlocks), embed spec
// normalization (resolveEmbed -> kind-tagged spec for the unified embed-view renderer), and the
// embed cols/rows readers. Extracted from the app-core root so the resolution logic gets Node tests.
//
// Every function is pure over an explicit `ctx` built by the root (app-core `_embedCtx()`):
//   { views, schema, getColumns, dataCache, currentTable, t, viewWithMe, anchorForView, rotationRowsFor,
//     rotationColsFor }
// The root keeps thin same-named wrappers, so components/templates/tests are unchanged.
//   Browser: <script src="/embeds.js"> after columns.js + rows.js (needs their globals). Exposes
//            Embeds.* plus mdToHtml as a bare global (schema-loader-era callers + the XSS test).
//   Node:    const Embeds = require('../embeds');
// Runtime-bound global: root._listsCache (embedRowsForItem's filterBy matchList), looked up at call
// time through globalThis — same pattern (and same Node gotcha) as rows.js.
(function(root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // These resolve to the module under Node and to globals hung off the root object in the browser.
  // tsc cannot type that: `module.exports = M` sits inside an `if (isNode)` within this IIFE, so the
  // inferred export shape comes out incomplete, and the globalThis branch has no declarations at all.
  // Both are therefore `any`, which means CALLS THROUGH THESE ARE NOT TYPE-CHECKED. Everything inside
  // each module still is, which is where the value has been so far. Closing this gap needs either
  // .d.ts companions (a second copy of the API to keep in sync -- the exact duplication this codebase
  // is trying to shed) or ES modules; neither is worth doing ahead of the store refactor.
  /** @type {any} */ var Rows = isNode ? require('./rows') : root;   // buildRows/resolveComputed/aggregateRows/sortByCol/condMatches
  /** @type {any} */ var Cols = isNode ? require('./columns') : root;   // colName/isEmbed/isViewEmbed shape predicates

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

  // --- Asset references (the bucket-free image tier) ------------------------------------------------
  // An image address stored in the schema / folder config / a row is ONE string: either an http(s) URL,
  // or `asset:<id>` pointing at an _assets__active row whose `src` holds a raster data: URI. The second
  // form is what lets a deployment with no storage bucket (Firebase Spark, where uploadFile's put()
  // fails at runtime) still hold an uploaded image -- the same trade the profile avatar already makes.
  // The id charset is deliberately narrow: it becomes a document id / jsonb key on every backend.
  function isAssetRef(v) { return /^asset:[\w.-]+$/.test(String(v || '')); }
  function assetId(v) { return isAssetRef(v) ? String(v).slice(6) : ''; }

  // A CSS `url("…")` token for a background-image, or '' when the address isn't a safe image source.
  // safeImgSrc returns the ORIGINAL string (not the URL-normalized one), so a value that satisfies
  // new URL() can still carry `"` or `)` -- which would close the url() token and append further
  // declarations. Percent-escape those (plus \ and newlines) so the token can only ever be one URL.
  // Callers must still bind through a Vue style OBJECT (el.style.setProperty parses a single
  // declaration) rather than concatenating a style="…" attribute.
  // NB: encodeURIComponent is NOT usable as the escaper here -- it leaves the unreserved marks
  // !'()*-._~ alone, so `)` would pass straight through and close the url() token. Percent-encode the
  // dangerous characters explicitly instead.
  function safeCssUrl(u) {
    var s = safeImgSrc(u);
    if (!s) return '';
    var pct = function(c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); };
    return 'url("' + s.replace(/["'()\\\r\n]/g, pct) + '")';
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

  // ---- Renderer seam -------------------------------------------------------------------------
  // mdToHtml above is the DEFAULT prose renderer, not the only possible one. Swapping in a real
  // markdown parser (for images, tables, code blocks) is one call at boot rather than an edit here:
  //
  //   Embeds.setRenderer(function (text) { return md.render(text); });
  //
  // The contract, in full:
  //   - input is PROSE ONLY. mdBlocks has already split the {{...}} embeds out, so a renderer never
  //     sees them and must never try to interpret them.
  //   - output is an HTML STRING inserted with v-html. It must not contain raw user HTML. mdToHtml
  //     escapes; a parser must be configured to escape too (markdown-it: `html: false`) and to run
  //     URLs through safeUrl, so the javascript:/data: allowlist survives the swap.
  // Passing a non-function resets to the built-in renderer.
  var _renderProse = mdToHtml;
  function setRenderer(fn) { _renderProse = (typeof fn === 'function') ? fn : mdToHtml; }

  // ---- Block directive registry --------------------------------------------------------------
  // `{{view:x}}` / `{{table:x}}` are two entries in a table, not two hardcoded branches. Adding a
  // directive used to mean three edits in this file -- the split regex, buildEmbedBlock, and the
  // hide-when-empty test. Now it is one registration:
  //
  //   Embeds.registerBlock('gauge', {
  //     resolve: function (name, part, ctx) { return {...} | null; },  // null -> "Unknown embed"
  //     count:   function (name, part, ctx) { return <rows>; }         // drives the `?` suffix
  //   });
  //
  // Kind names must be word characters -- they are spliced into the split pattern.
  var BLOCKS = {};
  function registerBlock(kind, handler) {
    if (!/^\w+$/.test(String(kind))) throw new Error('embed kind must be word characters: ' + kind);
    BLOCKS[kind] = handler;
  }
  function _kinds() { return Object.keys(BLOCKS).join('|'); }
  // The patterns come from real regex literals via .source, with the kind alternation spliced in.
  // Building them from quoted strings instead means every backslash has to survive being written
  // twice, which is a silent failure: a lost escape yields a regex that still compiles but matches
  // the wrong thing.
  var _SPLIT_SRC = /\{\{\s*(KINDS)\s*:\s*([^\s@?{}:]+(?:@[^\s?{}:]+)?\??)\s*\}\}/.source;
  var _SCAN_SRC  = /\{\{\s*(KINDS)\s*:\s*([^\s@?{}:]+)(@[^\s?{}:]+)?\??\s*\}\}/.source;
  // Built at call time, not once at load, so a directive registered later still parses.
  function _blockSplitRe() { return new RegExp(_SPLIT_SRC.replace('KINDS', _kinds())); }
  function _blockScanRe() { return new RegExp(_SCAN_SRC.replace('KINDS', _kinds()), 'g'); }

  registerBlock('view', {
    resolve: function(name, part, ctx) { return ctx.views[name] ? { embedType: 'view', embedName: name, embedPart: part || null } : null; },
    count: function(name, part, ctx) { return embedRows('view', name, part, ctx).length; }
  });
  registerBlock('table', {
    resolve: function(name, part, ctx) { return ctx.schema[name] ? { embedType: 'table', embedName: name, embedPart: part || null } : null; },
    count: function(name, part, ctx) { return embedRows('table', name, part, ctx).length; }
  });

  // `@both` is not the name of a partition: it asks for BOTH of them behind one Upcoming/Past toggle,
  // the embedded counterpart of the top-level archive tabs. The block carries no fixed part (the
  // component owns which half is showing) plus the `embedBoth` flag that turns the tab strip on.
  // It is handled HERE rather than in a directive because it is a property of partitions, which every
  // registered kind shares -- a handler resolves a name, it does not decide what a partition means.
  var BOTH = 'both';

  // v3 pages: a {{view:x}}/{{table:x}} embed block — the embed-view component resolves cols/rows itself.
  function buildEmbedBlock(type, name, part, ctx) {
    var h = BLOCKS[type], both = part === BOTH;
    var blk = h && h.resolve(name, both ? null : part, ctx);
    if (!blk) return { html: '<em>Unknown embed: ' + type + ':' + name + '</em>' };
    blk.embedBoth = both;
    return blk;
  }

  // How many rows a block has for the `?` hide-when-empty test. A `@both` block counts BOTH partitions:
  // a member whose active list is empty must still get the block when something has aged into the
  // archive, or the toggle that would reveal it is exactly what got hidden.
  function embedRowCount(type, name, part, ctx) {
    var h = BLOCKS[type];
    if (!h) return 0;                       // unreachable from mdBlocks -- the split pattern is BUILT
                                            // from the registered kinds, so an unknown one is never
                                            // parsed as an embed at all. Defensive, for direct callers.
    if (part !== BOTH) return h.count(name, part, ctx);
    return h.count(name, null, ctx) + h.count(name, 'archive', ctx);
  }

  // Every embed a page REFERS to, as {kind, name, part}, without resolving or rendering any of them.
  // Callers use it to answer "what does this page need loaded?" -- a doc-view renders its embeds
  // straight out of the row cache, so without this the only thing standing them up is a boot that
  // happened to load every table. Uses the same registered-kind pattern as mdBlocks, so a directive
  // added later is scanned for too.
  //
  // `{{self}}` is expanded first, exactly as mdBlocks does it, so a page embedding its own view reports
  // that view rather than nothing.
  function blockRefs(markdown, selfName) {
    var md = String(markdown || '').replace(/\{\{\s*self\s*\}\}/g, selfName ? '{{view:' + selfName + '}}' : '');
    var re = _blockScanRe(), m, out = [], seen = {};
    while ((m = re.exec(md))) {
      var part = m[3] ? m[3].slice(1) : null;
      var key = m[1] + ':' + m[2] + ':' + (part || '');
      if (seen[key]) continue;
      seen[key] = 1;
      out.push({ kind: m[1], name: m[2], part: part });
    }
    return out;
  }

  // Parse markdown into render blocks: {html} or {embedType,embedName,embedPart}. `?` hides empty embeds.
  function mdBlocks(markdown, selfName, ctx) {
    var md = String(markdown || '').replace(/\{\{\s*self\s*\}\}/g, selfName ? '{{view:' + selfName + '}}' : '').replace(/\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/g, function(_, k) { return ctx.t(k) || ''; });
    var parts = md.split(_blockSplitRe());
    var blocks = [], i = 0;
    while (i < parts.length) {
      // Guard on the RENDERED html, not the raw text: whitespace-only prose (the newline after a closing
      // {{view:x}}, say) renders to '' and would be pushed as a block with a falsy `html`. Both templates
      // dispatch with `v-if="blk.html" … v-else <embed-view>`, so such a block fell through to the embed
      // branch with no type/name — a phantom empty grid plus an "Add" button at the end of the page.
      if (parts[i]) { var _h = _renderProse(parts[i]); if (_h) blocks.push({ html: _h }); }
      if (i + 2 < parts.length) {
        var type = parts[i + 1], raw = parts[i + 2];
        var optional = raw.charAt(raw.length - 1) === '?'; if (optional) raw = raw.slice(0, -1);
        var at = raw.indexOf('@'), part = at >= 0 ? raw.slice(at + 1) : null, name = at >= 0 ? raw.slice(0, at) : raw;
        if (!(optional && embedRowCount(type, name, part, ctx) === 0)) blocks.push(buildEmbedBlock(type, name, part, ctx)); // hide-when-empty
        i += 3;
      } else break;
    }
    return blocks;
  }

  // For an embedded doc-view: false only if it has data embeds and ALL of them are empty (hide whole doc-view).
  function docHasData(markdown, selfName, ctx) {
    var md = String(markdown || '').replace(/\{\{\s*self\s*\}\}/g, selfName ? '{{view:' + selfName + '}}' : '');
    var re = _blockScanRe(), m, any = false;
    while ((m = re.exec(md))) { any = true; if (embedRowCount(m[1], m[2], m[3] ? m[3].slice(1) : null, ctx)) return true; }
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
      // Columns come from the root's rotationColsFor so the mineOnly / hideEmpty narrowing that the
      // on-screen view applies also reaches the print path (which renders from spec.columns).
      return { config: cfg, kind: 'rotation', name: anchorName, columns: ctx.rotationColsFor(anchorName, rrows, cfg), rows: rrows };
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
      var v = ctx.views[name];
      // A partition-scoped embed used to read the `<src>__<part>` store directly. `_status` moved that
      // answer onto the row, so the partition goes to buildRows as a parameter.
      var vMe = ctx.viewWithMe(v);
      var esrc = Rows.buildRows(vMe, ctx.dataCache, part || 'active');
      if (v.compute) esrc = Rows.resolveComputed(esrc, v.compute, { dataCache: ctx.dataCache, rotationAnchor: ctx.anchorForView(v.name) });
      return Rows.sortByCol(Rows.resolveComputed(Rows.aggregateRows(vMe, esrc), v.columns, { dataCache: ctx.dataCache, rotationAnchor: ctx.anchorForView(v.name) }), v.defaultSort, v);
    }
    if (type === 'table' && ctx.schema[name]) return Rows.sortByCol(Rows.partitionRows(ctx.dataCache, name, part || 'active'), ctx.schema[name].defaultSort);
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
    mdToHtml: mdToHtml, setRenderer: setRenderer, registerBlock: registerBlock, buildEmbedBlock: buildEmbedBlock, mdBlocks: mdBlocks, docHasData: docHasData, blockRefs: blockRefs,
    resolveEmbed: resolveEmbed, embedCols: embedCols, embedRows: embedRows, embedRowCount: embedRowCount,
    embedRowsForItem: embedRowsForItem, embedWhenOk: embedWhenOk, embedVisible: embedVisible, safeUrl: safeUrl, safeImgSrc: safeImgSrc,
    isAssetRef: isAssetRef, assetId: assetId, safeCssUrl: safeCssUrl
  };
  if (isNode) module.exports = M;
  else { root.Embeds = M; root.mdToHtml = mdToHtml; root.safeUrl = safeUrl; root.safeImgSrc = safeImgSrc; root.isAssetRef = isAssetRef; root.safeCssUrl = safeCssUrl; } // bare globals: mdToHtml (pageBlocks-era + tests), safeUrl/safeImgSrc (ROOT_PROXY), isAssetRef/safeCssUrl (validateSchema + background style)
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
