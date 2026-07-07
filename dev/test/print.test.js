const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Print = require('../../print');

// Minimal print ctx (what app-core's _printCtx() builds from live state). displayValue echoes the raw
// value; dates/period are the only cell formatting branch.
function makeCtx(over) {
  return Object.assign({
    t: k => k,                                   // echo the i18n key so we can assert labels
    colIsDate: c => c === 'date',
    toDateStr: v => 'D:' + v,
    displayValue: (c, v) => (v == null ? '' : String(v)),
    isColumnHidden: () => false,
    colHideEmpty: () => false,
    embedItems: [],
    embedWhenOk: () => true,
    embedRowsForItem: (ei) => ei.rows,
    embedCols: () => ['x'],
    embedRows: () => []
  }, over || {});
}

describe('print.js — escape', () => {
  it('escapes HTML special characters', () => {
    assert.equal(Print.escape('<b>&"'), '&lt;b&gt;&amp;&quot;');
    assert.equal(Print.escape(null), '');
    assert.equal(Print.escape(0), '');   // falsy -> empty, matching the old _pe
  });
});

describe('print.js — cell', () => {
  it('dates and the rotation _period go through toDateStr; others through displayValue', () => {
    const ctx = makeCtx();
    assert.equal(Print.cell('date', '2026-07-06', ctx), 'D:2026-07-06');
    assert.equal(Print.cell('_period', '2026-07-06', ctx), 'D:2026-07-06');
    assert.equal(Print.cell('title', 'Hi', ctx), 'Hi');
  });
});

describe('print.js — table', () => {
  it('builds a thead/tbody with field.* labels and escaped cells', () => {
    const ctx = makeCtx();
    const html = Print.table(['title', 'date'], [{ title: 'A<b>', date: '2026-07-06' }], ctx);
    assert.match(html, /<th>field.title<\/th><th>field.date<\/th>/);
    assert.match(html, /<td>A&lt;b&gt;<\/td><td>D:2026-07-06<\/td>/);
  });

  it('the rotation _period column header uses the field.period key', () => {
    const html = Print.table(['_period', 'area'], [{ _period: '2026-01-01', area: 'A' }], makeCtx());
    assert.match(html, /<th>field.period<\/th>/);
    assert.match(html, /<td>D:2026-01-01<\/td><td>A<\/td>/);
  });
});

describe('print.js — printable (gate + content)', () => {
  it('respects the when gate, doc show flag, and non-empty (filterBy-sliced) rows', () => {
    const ctx = makeCtx();
    assert.equal(Print.printable({ kind: 'doc', show: true, config: {} }, null, ctx), true);
    assert.equal(Print.printable({ kind: 'doc', show: false, config: {} }, null, ctx), false);
    assert.equal(Print.printable({ kind: 'data', config: {}, rows: [] }, null, ctx), false);
    assert.equal(Print.printable({ kind: 'data', config: {}, rows: [{ x: 1 }] }, null, ctx), true);
    assert.equal(Print.printable({ kind: 'data', config: {}, rows: [{ x: 1 }] }, null, makeCtx({ embedWhenOk: () => false })), false);
  });
});

describe('print.js — embed', () => {
  it('data embed -> a table of its columns/rows; bare drops the .embed wrapper', () => {
    const ei = { kind: 'data', config: {}, columns: ['title'], rows: [{ title: 'Row1' }] };
    const html = Print.embed(ei, null, makeCtx());
    assert.match(html, /^<div class="embed"><table>/);
    assert.match(html, /<td>Row1<\/td>/);
    const bare = Print.embed({ kind: 'data', config: { bare: true }, columns: ['title'], rows: [{ title: 'R' }] }, null, makeCtx());
    assert.match(bare, /^<div><table>/);   // bare -> plain <div>
  });

  it('doc embed -> prose blocks verbatim + nested tables (empty embeds skipped)', () => {
    const ei = { kind: 'doc', config: { bare: true }, blocks: [{ html: '<h1>Doc</h1>' }, { embedType: 'table', embedName: 't' }] };
    const ctx = makeCtx({ embedCols: () => ['n'], embedRows: () => [{ n: 'v' }] });
    const html = Print.embed(ei, null, ctx);
    assert.match(html, /<h1>Doc<\/h1>/);       // prose kept as-is
    assert.match(html, /<td>v<\/td>/);          // nested table rendered
    // empty nested embed contributes no table
    assert.equal(/<table>/.test(Print.embed(ei, null, makeCtx({ embedCols: () => ['n'], embedRows: () => [] }))), false);
  });

  it('inline {{self}} embed renders the own-table grid where the marker sits', () => {
    const ei = { kind: 'data', config: {}, columns: ['a'], rows: [{ a: '1' }], inlineBlocks: [{ html: '<p>Intro</p>' }, { self: true }] };
    const html = Print.embed(ei, null, makeCtx());
    assert.match(html, /<p>Intro<\/p><table>/);
  });
});

describe('print.js — cardHtml', () => {
  const ctx = makeCtx();

  it('renders a <dl> of visible fields', () => {
    const html = Print.cardHtml(['title', 'date'], { title: 'Hi', date: '2026-07-06' }, ctx);
    assert.match(html, /^<div class="card"><dl>/);
    assert.match(html, /<dt>field.title<\/dt><dd>Hi<\/dd>/);
    assert.match(html, /<dt>field.date<\/dt><dd>D:2026-07-06<\/dd>/);
  });

  it('hidden columns and empty+hideEmpty columns are dropped', () => {
    const hideCtx = makeCtx({ isColumnHidden: (c) => c === 'secret', colHideEmpty: (c) => c === 'note' });
    const html = Print.cardHtml(['title', 'secret', 'note'], { title: 'Hi', secret: 'x', note: '' }, hideCtx);
    assert.equal(/field.secret/.test(html), false);   // hidden
    assert.equal(/field.note/.test(html), false);     // empty + hideEmpty
  });

  it('an afterColumn embed splits the <dl>; empty <dl></dl> pairs are stripped', () => {
    const embedCtx = makeCtx({
      embedItems: [{ config: { afterColumn: 'title' }, kind: 'data', rows: [{ z: 1 }], columns: ['z'] }]
    });
    const html = Print.cardHtml(['title'], { title: 'Hi' }, embedCtx);
    assert.match(html, /<dd>Hi<\/dd><\/dl><div class="embed">/); // embed placed right after the title field
    assert.equal(/<dl><\/dl>/.test(html), false);               // no empty dl pairs remain
  });
});
