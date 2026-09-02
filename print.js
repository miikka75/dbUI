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

  var M = { escape: escape, cell: cell, table: table, printable: printable, embed: embed, cardHtml: cardHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Print = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
