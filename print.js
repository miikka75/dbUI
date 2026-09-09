// print.js — Pure print-HTML builders: escape a value, a print <table> (cols/rows), a card's <dl> +
// interleaved embeds, and one embed's print HTML. Extracted from the app-core root so the print markup
// gets Node tests (it had one Playwright test); the window.open/PRINT_CSS orchestration (_printOpen /
// printView / printCard) stays on the root.
//
// Pure over an explicit `ctx` the root builds (app-core `_printCtx()`):
//   { t, colIsDate, displayValue, isColumnHidden, colHideEmpty,
//     embedItems, embedWhenOk, embedRowsForItem, embedCols, embedRows, embedPartLabel }
//   Browser: <script src="/print.js"> (after calendar.js); exposes Print.*.
//   Node:    const Print = require('../print').
(function(root) {
  // Date formatting is NOT a ctx entry: toDateStr is a pure primitive from calendar.js, so taking it
  // from the root would only let the printed date drift from the one on screen.
  var Calendar = (typeof module !== 'undefined' && module.exports) ? require('./calendar') : root.Calendar;

  function escape(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // Format a print cell to match the web grid: dates (and the rotation _period) -> toDateStr,
  // list/groupBy values -> displayValue.
  function cell(c, v, ctx) { return (c === '_period' || ctx.colIsDate(c)) ? Calendar.toDateStr(v) : ctx.displayValue(c, v); }

  // One print <table> for cols/rows (the only table shape the print path emits). Header: field.* label
  // (the rotation _period gets its own key); cells via cell().
  function table(cols, rows, ctx) {
    var h = '<table><thead><tr>';
    cols.forEach(function(c) { h += '<th>' + escape(c === '_period' ? ctx.t('field.period') : (ctx.t('field.' + c) || c)) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function(r) { h += '<tr>'; cols.forEach(function(c) { h += '<td>' + escape(cell(c, r[c], ctx)) + '</td>'; }); h += '</tr>'; });
    return h + '</tbody></table>';
  }

  // Whether an embed prints: passes its `when` gate AND has content (per-row filterBy slice when an
  // `item` context is given). doc embeds print when their show flag is set.
  function printable(ei, item, ctx) {
    if (!ctx.embedWhenOk(ei, item)) return false;
    if (ei.kind === 'doc') return !!ei.show;
    var rows = (ei.config.filterBy && item) ? ctx.embedRowsForItem(ei, item) : ei.rows;
    return !!(rows && rows.length);
  }

  // One embed's print HTML: a doc-view (prose + nested tables), an inline {{self}} grid, or a plain table.
  function embed(ei, item, ctx) {
    var rows = (ei.config.filterBy && item) ? ctx.embedRowsForItem(ei, item) : ei.rows;
    if (ei.kind === 'doc') {
      var dh = ei.config.bare ? '<div>' : '<div class="embed">';
      (ei.blocks || []).forEach(function(b) {
        if (b.html) { dh += b.html; return; }
        var cols = ctx.embedCols(b.embedType, b.embedName);
        // Paper has no tabs: a `@both` block prints BOTH partitions stacked, each under its tab label,
        // rather than silently dropping whichever half the reader had not clicked before printing.
        (b.embedBoth ? [null, 'archive'] : [b.embedPart]).forEach(function(p) {
          var brows = ctx.embedRows(b.embedType, b.embedName, p);
          if (!brows.length) return;
          if (b.embedBoth) dh += '<h4>' + escape(ctx.embedPartLabel(b.embedType, b.embedName, p || 'active')) + '</h4>';
          dh += table(cols, brows, ctx);
        });
      });
      return dh + '</div>';
    }
    var html = ei.config.bare ? '<div>' : '<div class="embed">';
    if (ei.inlineBlocks) {
      ei.inlineBlocks.forEach(function(blk) {
        if (blk.html) { html += blk.html; return; }
        if (blk.self) html += table(ei.columns, rows, ctx);
      });
    } else {
      html += table(ei.columns, rows, ctx);
    }
    return html + '</div>';
  }

  // A card's <dl> of visible fields, with embeds interleaved after their afterColumn (and unpositioned
  // embeds appended). Empty <dl></dl> pairs left by embed splits are stripped.
  function cardHtml(cols, item, ctx) {
    var html = '<div class="card"><dl>';
    cols.forEach(function(c) {
      if (!ctx.isColumnHidden(c, item) && (item[c] || !ctx.colHideEmpty(c))) html += '<dt>' + escape(ctx.t('field.' + c) || c) + '</dt><dd>' + escape(cell(c, item[c], ctx)) + '</dd>';
      ctx.embedItems.forEach(function(ei) { if (ei.config.afterColumn === c && printable(ei, item, ctx)) html += '</dl>' + embed(ei, item, ctx) + '<dl>'; });
    });
    html += '</dl>';
    ctx.embedItems.forEach(function(ei) { if (!ei.config.afterColumn && printable(ei, item, ctx)) html += embed(ei, item, ctx); });
    html = html.replace(/<dl><\/dl>/g, ''); // remove empty dl pairs left by embed splits
    return html + '</div>';
  }

  // A sheet of scannable labels, one per catalogue row: the name people read, the barcode a scanner
  // reads, and the code in text underneath. The text is not decoration -- it is the fallback a scuffed
  // label needs, and typing it is the arrangement the scan view shipped on.
  //
  // `items` is [{ code, label }]. Scan is read lazily rather than captured at module load: index.html
  // loads print.js BEFORE scan.js, so a module-scope capture would take undefined.
  function labels(items, ctx) {
    var Scan = (typeof module !== 'undefined' && module.exports) ? require('./scan') : root.Scan;
    var h = '<div class="labels">';
    (items || []).forEach(function(it) {
      h += '<div class="label"><b>' + escape(it.label) + '</b>';
      // QR when there is an encoder, because that is the one a PHONE can act on: it carries the deep
      // link, so any camera app opens the app on the right view with the code already resolved. A 1D
      // code carries the bare text, which no camera app offers to do anything with.
      var m = ctx.qr && it.link ? ctx.qr(it.link) : null;
      if (m) { h += qrSvg(m); }
      else {
        // No encoder (never loaded, or /vendor missing and offline) -> Code 39, which needs none. It is
        // read by a handheld wedge scanner rather than a camera, which is the fallback this sheet had
        // before the encoder was vendored.
        var enc = Scan.code39(it.code);
        // A code neither can carry says so on the sheet. Printing the row with no code at all would be
        // a door nobody can scan and nobody knows is missing until they are standing at it.
        h += enc ? barcode(enc) : '<div class="nocode">' + escape(ctx.t('scan.no_barcode')) + '</div>';
      }
      // The STORED code, not the uppercased Code 39 form: this line is what somebody types when a
      // label is scuffed, matching is case-insensitive either way, and under a QR the uppercase
      // form would simply be wrong.
      h += '<code>' + escape(it.code) + '</code></div>';
    });
    return h + '</div>';
  }

  // One QR as inline SVG, from a module matrix (`size` + `isDark(row, col)`) rather than from the
  // encoder itself -- so this file stays pure over ctx and its Node tests need no vendored 56 KB.
  //
  // A QUIET ZONE of four modules on every side is not decoration: without it a decoder cannot find the
  // symbol against the label's border, and the code reads as unscannable rather than as wrong.
  function qrSvg(m, px) {
    var q = 4, side = m.size + q * 2, rects = '';
    for (var r = 0; r < m.size; r++) {
      // Run-length along each row: one <rect> per horizontal run instead of per module, which is the
      // difference between a few hundred rects and a few thousand on a sheet of them.
      var run = 0;
      for (var c = 0; c <= m.size; c++) {
        var dark = c < m.size && m.isDark(r, c);
        if (dark) { run++; continue; }
        if (run) rects += '<rect x="' + (q + c - run) + '" y="' + (q + r) + '" width="' + run + '" height="1"/>';
        run = 0;
      }
    }
    var w = px || 120;
    return '<svg viewBox="0 0 ' + side + ' ' + side + '" width="' + w + '" height="' + w + '" shape-rendering="crispEdges">'
      + '<rect width="' + side + '" height="' + side + '" fill="#fff"/><g fill="#000">' + rects + '</g></svg>';
  }

  // One barcode as inline SVG. `preserveAspectRatio="none"` lets the sheet stretch it to the label
  // width: the bars scale together, so the wide-to-narrow ratio the decoder measures is unchanged.
  function barcode(enc, height) {
    var h = height || 46, rects = '';
    enc.bars.forEach(function(b) { rects += '<rect x="' + b.x + '" y="0" width="' + b.w + '" height="' + h + '" fill="#000"/>'; });
    return '<svg viewBox="0 0 ' + enc.width + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" shape-rendering="crispEdges">' + rects + '</svg>';
  }

  var M = { escape: escape, cell: cell, table: table, printable: printable, embed: embed, cardHtml: cardHtml, labels: labels, barcode: barcode, qrSvg: qrSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Print = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
