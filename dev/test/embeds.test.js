const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Embeds = require('../../embeds');

beforeEach(() => { delete globalThis._listsCache; });

// Minimal root ctx (what app-core's _embedCtx() builds from live state).
function makeCtx(over) {
  const schema = {
    tasks: { columns: { id: 'text', title: 'text', status: 'text', secret: { hidden: true } }, defaultSort: 'title' },
    notes: { columns: { id: 'text', title: 'text' } },
    // Everything aged out: the shape a `@both` toggle exists for (nothing active, history in the archive).
    logs: { columns: { id: 'text', title: 'text' } }
  };
  const views = {
    open: { name: 'open', sources: ['tasks'], filter: { status: 'open' }, columns: ['title', 'status'] },
    doc: { name: 'doc', markdown: '# Doc\n\n{{view:open}}' }
  };
  const dataCache = {
    tasks: [{ id: 't1', title: 'B-task', status: 'open' }, { id: 't2', title: 'A-task', status: 'done' }],
    tasks__archive: [{ id: 'old', title: 'Old', status: 'done' }],
    logs: [],
    logs__archive: [{ id: 'l1', title: 'Aged out' }]
  };
  return Object.assign({
    views, schema, dataCache, currentTable: 'host',
    getColumns: t => Object.keys(schema[t].columns),
    t: k => '',
    viewWithMe: v => v,
    anchorForView: () => '2026-01-01',
    rotationRowsFor: () => [{ id: 'rv0', _period: '2026-01-01', area: ['A'] }],
    // Root-side slot narrowing (mineOnly/hideEmpty) lives in app-core; the stub just shapes the contract.
    rotationColsFor: (n, rows, cfg) => ['_period'].concat(((cfg && cfg.rotation) || {}).slots || [])
  }, over || {});
}

describe('embeds.js — mdToHtml', () => {
  it('renders headings, emphasis, lists, paragraphs', () => {
    const html = Embeds.mdToHtml('## Hi\n\n**b** and *i*\n\n- one\n- two');
    assert.match(html, /<h2>Hi<\/h2>/);
    assert.match(html, /<strong>b<\/strong>/);
    assert.match(html, /<em>i<\/em>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  });

  it('escapes HTML and blocks non-http(s) link protocols', () => {
    assert.match(Embeds.mdToHtml('<script>x</script>'), /&lt;script&gt;/);
    const xss = Embeds.mdToHtml('[click](javascript:alert(1))');
    assert.match(xss, /href=""/);          // javascript: URL stripped
    const ok = Embeds.mdToHtml('[site](https://example.com)');
    assert.match(ok, /href="https:\/\/example.com"/);
  });
});

describe('embeds.js — mdBlocks / docHasData / buildEmbedBlock', () => {
  it('whitespace-only trailing prose yields NO block (it would render as a phantom embed)', () => {
    const ctx = makeCtx();
    // Both templates dispatch `v-if="blk.html" ... v-else <embed-view>`, so a block whose html renders
    // empty is treated as an embed with no type/name — an empty grid plus a stray "Add" at the page end.
    const blocks = Embeds.mdBlocks('# Title\n\n{{view:open}}\n', null, ctx);
    assert.equal(blocks.length, 2);
    assert.ok(blocks.every(b => b.html || b.embedType), 'every block must be renderable as html OR an embed');
    assert.equal(blocks[1].embedName, 'open');
    // Trailing blank lines / spaces alone, likewise.
    assert.deepEqual(Embeds.mdBlocks('{{view:open}}   \n\n  ', null, ctx).map(b => b.embedName || 'html'), ['open']);
    // Real trailing prose is still kept.
    assert.deepEqual(Embeds.mdBlocks('{{view:open}}\n\nAfter', null, ctx).map(b => b.embedName || 'html'), ['open', 'html']);
  });

  it('splits prose and embed tokens; unknown embeds become an inline note', () => {
    const ctx = makeCtx();
    const blocks = Embeds.mdBlocks('Intro\n\n{{view:open}}\n\nOutro\n\n{{table:nope}}', null, ctx);
    assert.equal(blocks.length, 4);
    assert.match(blocks[0].html, /Intro/);
    assert.deepEqual(blocks[1], { embedType: 'view', embedName: 'open', embedPart: null, embedBoth: false });
    assert.match(blocks[3].html, /Unknown embed/);
  });

  it('{{t:key}} substitution, {{self}} expansion, @part suffix, `?` hides empty embeds', () => {
    const ctx = makeCtx({ t: k => (k === 'greet' ? 'Hello' : '') });
    const blocks = Embeds.mdBlocks('{{t:greet}}\n\n{{self}}\n\n{{table:tasks@archive}}\n\n{{table:notes?}}', 'open', ctx)
      .filter(b => b.html !== '');   // whitespace between adjacent tokens yields empty html blocks (render as nothing)
    assert.match(blocks[0].html, /Hello/);
    assert.deepEqual(blocks[1], { embedType: 'view', embedName: 'open', embedPart: null, embedBoth: false });   // {{self}} -> own view
    assert.deepEqual(blocks[2], { embedType: 'table', embedName: 'tasks', embedPart: 'archive', embedBoth: false });
    assert.equal(blocks.length, 3);   // notes has no rows -> optional embed dropped
  });

  it('@both carries no fixed part — the component owns which half shows', () => {
    const ctx = makeCtx();
    const blocks = Embeds.mdBlocks('{{table:tasks@both}}', null, ctx);
    assert.deepEqual(blocks[0], { embedType: 'table', embedName: 'tasks', embedPart: null, embedBoth: true });
    // `both` is a request, not a partition name: it must never reach embedRows as one.
    assert.deepEqual(Embeds.mdBlocks('{{table:tasks@archive}}', null, ctx)[0].embedBoth, false);
  });

  it('`?` on a @both embed counts BOTH partitions', () => {
    const ctx = makeCtx();
    // logs: nothing active, one archived row. Hiding the block would hide the toggle that reveals it.
    assert.equal(Embeds.mdBlocks('{{table:logs?}}', null, ctx).length, 0);          // active only -> empty
    assert.equal(Embeds.mdBlocks('{{table:logs@both?}}', null, ctx).length, 1);     // archive counts too
    assert.equal(Embeds.mdBlocks('{{table:notes@both?}}', null, ctx).length, 0);    // both halves empty -> hidden
    assert.equal(Embeds.embedRowCount('table', 'logs', 'both', ctx), 1);
  });

  it('docHasData: false only when every data embed is empty', () => {
    const ctx = makeCtx();
    assert.equal(Embeds.docHasData('x {{view:open}}', null, ctx), true);      // open has a row
    assert.equal(Embeds.docHasData('x {{table:notes}}', null, ctx), false);   // notes empty
    assert.equal(Embeds.docHasData('prose only', null, ctx), true);           // no embeds -> show
    assert.equal(Embeds.docHasData('x {{table:logs}}', null, ctx), false);    // active half empty
    assert.equal(Embeds.docHasData('x {{table:logs@both}}', null, ctx), true); // ...but the archive half is not
  });
});

describe('embeds.js — resolveEmbed (kind-tagged specs)', () => {
  it('doc / calendar / rotation kinds', () => {
    const ctx = makeCtx();
    assert.equal(Embeds.resolveEmbed({ name: 'doc', markdown: '# t' }, ctx).kind, 'doc');
    const cal = Embeds.resolveEmbed({ view: 'c', calendar: {} }, ctx);
    assert.equal(cal.kind, 'calendar'); assert.equal(cal.name, 'c');
    const rot = Embeds.resolveEmbed({ view: 'r', rotation: { slots: ['area'] } }, ctx);
    assert.equal(rot.kind, 'rotation');
    assert.deepEqual(rot.columns, ['_period', 'area']);
    assert.equal(rot.rows[0]._period, '2026-01-01');   // via ctx.rotationRowsFor
  });

  it('data kind: builds+filters rows, sorts, hides empty columns, splits inline {{self}} markdown', () => {
    const ctx = makeCtx();
    const spec = Embeds.resolveEmbed({
      sources: ['tasks'], columns: ['title', 'status', 'ghost'],
      defaultSort: 'title', hideEmpty: true, markdown: 'Above\n\n{{self}}'
    }, ctx);
    assert.equal(spec.kind, 'data');
    assert.deepEqual(spec.columns, ['title', 'status']);            // ghost empty in every row -> dropped
    assert.deepEqual(spec.rows.map(r => r.title), ['A-task', 'B-task']); // defaultSort applied
    assert.equal(spec.inlineBlocks.length, 2);
    assert.match(spec.inlineBlocks[0].html, /Above/);
    assert.deepEqual(spec.inlineBlocks[1], { self: true });
  });
});

describe('embeds.js — embedCols / embedRows', () => {
  it('view cols skip embed entries; table cols skip id + hidden', () => {
    const ctx = makeCtx();
    ctx.views.mix = { name: 'mix', sources: ['tasks'], columns: ['title', { view: 'open' }, { sources: ['notes'] }] };
    assert.deepEqual(Embeds.embedCols('view', 'mix', ctx), ['title']);
    assert.deepEqual(Embeds.embedCols('table', 'tasks', ctx), ['title', 'status']);
  });

  it('view rows run the real pipeline (filter via condMatches); table rows honor @part', () => {
    const ctx = makeCtx();
    assert.deepEqual(Embeds.embedRows('view', 'open', null, ctx).map(r => r.id), ['t1']);  // status:open only
    assert.deepEqual(Embeds.embedRows('table', 'tasks', 'archive', ctx).map(r => r.id), ['old']);
  });
});

describe('embeds.js — per-row slicing + visibility', () => {
  const ei = { kind: 'data', config: { filterBy: { assigned: 'person' } }, rows: [{ assigned: 'Ann' }, { assigned: 'Bob' }] };

  it('embedRowsForItem slices by the card row value; matchList form uses the live lists cache', () => {
    assert.deepEqual(Embeds.embedRowsForItem(ei, { person: 'Ann' }), [{ assigned: 'Ann' }]);
    globalThis._listsCache = { crew: ['Bob'] };
    const ml = { kind: 'data', config: { filterBy: { assigned: { matchList: 'crew' } } }, rows: ei.rows };
    assert.deepEqual(Embeds.embedRowsForItem(ml, { person: 'x' }), [{ assigned: 'Bob' }]);
  });

  it('embedVisible: doc uses show, calendar always, data needs non-empty (sliced) rows', () => {
    assert.equal(Embeds.embedVisible({ kind: 'doc', show: false, config: {} }), false);
    assert.equal(Embeds.embedVisible({ kind: 'calendar', config: {} }), true);
    assert.equal(Embeds.embedVisible(ei, { person: 'Zed' }), false);   // slice empty for Zed
    assert.equal(Embeds.embedVisible(ei, { person: 'Ann' }), true);
  });

  it('embedWhenOk gates by the `when` clause via condMatches', () => {
    const gated = { config: { when: { status: 'open' } } };
    assert.equal(Embeds.embedWhenOk(gated, { status: 'open' }), true);
    assert.equal(Embeds.embedWhenOk(gated, { status: 'done' }), false);
    assert.equal(Embeds.embedWhenOk({ config: {} }, { status: 'done' }), true);  // no when -> ok
  });
});

describe('embeds.js — safeUrl (url/image cell + markdown-link sanitizer)', () => {
  it('allows http(s) URLs unchanged', () => {
    assert.equal(Embeds.safeUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
    assert.equal(Embeds.safeUrl('http://localhost:3000/uploads/x.png'), 'http://localhost:3000/uploads/x.png');
  });
  it('allows a relative URL (resolves onto the page origin at runtime)', () => {
    // In Node there is no `location`, so the fallback base is http://localhost/ -> http scheme -> kept.
    assert.equal(Embeds.safeUrl('/uploads/pic.png'), '/uploads/pic.png');
  });
  it('blocks javascript:, data:, vbscript:, file: -> empty (the XSS cases)', () => {
    assert.equal(Embeds.safeUrl('javascript:alert(1)'), '');
    assert.equal(Embeds.safeUrl('JavaScript:alert(1)'), '');           // scheme is case-insensitive
    assert.equal(Embeds.safeUrl('  javascript:alert(1)'), '');         // leading space doesn't smuggle it
    assert.equal(Embeds.safeUrl('data:text/html,<script>alert(1)</script>'), '');
    assert.equal(Embeds.safeUrl('vbscript:msgbox(1)'), '');
    assert.equal(Embeds.safeUrl('file:///etc/passwd'), '');
  });
  it('empty / nullish -> empty string', () => {
    for (const v of ['', null, undefined]) assert.equal(Embeds.safeUrl(v), '');
  });
  it('mdToHtml uses it: a javascript: link renders an empty href, not the payload', () => {
    const html = Embeds.mdToHtml('[click](javascript:alert(1))');
    assert.ok(html.includes('href=""'), 'unsafe scheme dropped: ' + html);
    assert.ok(!html.includes('javascript:'), 'no javascript: in output: ' + html);
  });
  it('mdToHtml keeps a safe link and escapes its & in the href attribute', () => {
    const html = Embeds.mdToHtml('[x](https://e.com/a?b=1&c=2)');
    assert.ok(html.includes('href="https://e.com/a?b=1&amp;c=2"'), html);
  });
});

describe('embeds.js — safeImgSrc (img src: http(s) + raster data image)', () => {
  it('allows a raster data:image (the paste-a-URL image fallback)', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(Embeds.safeImgSrc(png), png);
    assert.equal(Embeds.safeImgSrc('data:image/gif;base64,R0lGOD=='), 'data:image/gif;base64,R0lGOD==');
  });
  it('allows http(s) image URLs', () => {
    assert.equal(Embeds.safeImgSrc('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  });
  it('blocks data:image/svg+xml (an SVG can carry script)', () => {
    assert.equal(Embeds.safeImgSrc('data:image/svg+xml,<svg onload=alert(1)>'), '');
  });
  it('blocks data:text/html and javascript: (same as href)', () => {
    assert.equal(Embeds.safeImgSrc('data:text/html,<script>alert(1)</script>'), '');
    assert.equal(Embeds.safeImgSrc('javascript:alert(1)'), '');
  });
});

describe('embeds.js — asset references (the no-bucket image tier)', () => {
  it('recognizes asset:<id> and extracts the id', () => {
    assert.equal(Embeds.isAssetRef('asset:bg_frontPage'), true);
    assert.equal(Embeds.assetId('asset:bg_frontPage'), 'bg_frontPage');
    assert.equal(Embeds.isAssetRef('asset:img_1720000000000_a1b2c3'), true);
  });
  it('rejects anything that is not a bare asset id', () => {
    // The id becomes a document id / jsonb key on every backend, so the charset stays narrow.
    for (const bad of ['asset:', 'asset:a/b', 'asset:a b', 'asset:../x', 'https://e.com/a.png', '', null, undefined]) {
      assert.equal(Embeds.isAssetRef(bad), false, String(bad));
    }
    assert.equal(Embeds.assetId('https://e.com/a.png'), '');
  });
});

describe('embeds.js — safeCssUrl (background-image url() token)', () => {
  it('wraps a safe image source in a url() token', () => {
    assert.equal(Embeds.safeCssUrl('https://cdn.example.com/a.png'), 'url("https://cdn.example.com/a.png")');
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal(Embeds.safeCssUrl(png), 'url("' + png + '")');
  });
  it('inherits safeImgSrc\'s rejections (svg, html, javascript:)', () => {
    assert.equal(Embeds.safeCssUrl('data:image/svg+xml,<svg onload=alert(1)>'), '');
    assert.equal(Embeds.safeCssUrl('javascript:alert(1)'), '');
    assert.equal(Embeds.safeCssUrl(''), '');
  });
  it('cannot be broken out of to append further CSS declarations', () => {
    // safeImgSrc returns the ORIGINAL string, so a URL that satisfies new URL() may still carry a quote
    // or a paren. Neither may survive into the token or the value could close url() and add declarations.
    // (Regression: encodeURIComponent leaves `)` untouched — it is an unreserved mark — so it is NOT a
    // usable escaper here. The paren assertion below is what caught that.)
    const out = Embeds.safeCssUrl('https://e.com/a.png");background-color:red;');
    assert.ok(out.startsWith('url("') && out.endsWith('")'), out);
    const inner = out.slice(5, -2);
    assert.equal(inner.includes('"'), false, 'a quote survived: ' + out);
    assert.equal(inner.includes(')'), false, 'a paren survived: ' + out);
    assert.equal(inner.includes('('), false, 'a paren survived: ' + out);
    assert.equal(inner.includes('\\'), false, 'a backslash survived: ' + out);
  });
  it('strips newlines (a raw newline also terminates a declaration)', () => {
    const out = Embeds.safeCssUrl('https://e.com/a.png\n:hover{}');
    assert.equal(out.includes('\n'), false, out);
  });
});
