// view-kind.test.js — `kind` is now the discriminator, so it has to be TRUE.
//
// A view's kind used to be worked out by probing for a `calendar`/`rotation`/`pivot`/... key, in every
// consumer that needed it: app-core's seven `is*View` computeds, `SchemaNormalize.isView`, and
// `Migrations.kindOf`. An implicit discriminator cannot be kept in sync because there is nothing to
// sync — dev/schema.js's copy had already drifted a kind behind before it was deleted.
//
// There is one answer now (`SchemaNormalize.viewKind`), read off the `kind` the schema carries. That
// only works while the stored label matches what the entry actually is, which is what this file checks:
// against the shipped schemas, against the vocabulary the meta-schema publishes, and against the shape
// that kept `kind` from being usable for two versions — a nav group.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Migrations = require('../../migrations');
const SchemaNormalize = require('../../schema-normalize');
const { appCoreFn } = require('./app-core-fn');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8'));

// Bare schema documents plus the one bundle, whose document sits under `.schema`.
const SHIPPED = [
  ['examples/chores-schema.json', (d) => d],
  ['examples/bishopric-schema.json', (d) => d.schema],
  ['examples/demo-schema.json', (d) => d],
];

const eachNamed = (schema, fn) => Migrations.eachView(schema.views, (v) => { if (v && v.name) fn(v); });

describe('viewKind — the stored label matches what the entry is', () => {
  for (const [rel, pick] of SHIPPED) {
    it(rel, () => {
      // A stored `kind` that disagrees with the entry's own shape is worse than no kind at all: the
      // loader now trusts it, so a stale label routes a rotation view to the data renderer and the
      // failure looks like a rendering bug rather than a schema one.
      const schema = pick(read(rel));
      let checked = 0;
      eachNamed(schema, (v) => {
        checked++;
        assert.equal(v.kind, Migrations.kindOf(v), rel + ': view "' + v.name + '" is labelled ' + v.kind);
        assert.equal(SchemaNormalize.viewKind(v), v.kind);
      });
      assert.ok(checked > 0, rel + ': no named views found — this test would pass vacuously');
    });
  }
});

describe('viewKind — one discriminator, not nine', () => {
  it('derives the kind when the document carries none', () => {
    // A hand-written schema (the E2E fixture is one) has no `kind` on anything until the migration
    // chain runs, and schema-loader flattens the bundled defaultSchema before anything migrates it.
    const cases = [
      [{ name: 'd', sources: ['t'] }, 'data'],
      [{ name: 'p', markdown: '# hi' }, 'page'],
      [{ name: 'r', rotation: {} }, 'rotation'],
      [{ name: 'c', calendar: {} }, 'calendar'],
      [{ name: 'v', pivot: {} }, 'pivot'],
      [{ name: 's', rsvp: {} }, 'rsvp'],
      [{ name: 'b', board: {} }, 'board'],
      [{ name: 'f', form: {} }, 'form'],
      [{ name: 'g', views: [] }, 'group'],
    ];
    for (const [v, kind] of cases) assert.equal(SchemaNormalize.viewKind(v), kind, v.name);
  });

  it('prefers a written kind over the shape, so an author can override', () => {
    assert.equal(SchemaNormalize.viewKind({ name: 'x', sources: ['t'], kind: 'board' }), 'board');
  });

  it('labels an entry by what it RENDERS when it has both a body and nested views', () => {
    // Precedence, not an edge case: a kind answers "what does this draw", and a folder is the answer
    // only when there is nothing else to draw.
    assert.equal(SchemaNormalize.viewKind({ name: 'x', markdown: '#', views: [{ name: 'i', pivot: {} }] }), 'page');
  });

  it('has no kind for a bare table, which is not a view', () => {
    assert.equal(SchemaNormalize.viewKind(undefined), null);
    assert.equal(SchemaNormalize.viewKind(null), null);
  });
});

describe('viewKind — the vocabulary is published, so it must be complete', () => {
  it('the meta-schema lists every kind kindOf can return', () => {
    // schema.schema.json offers these to the author's editor. A kind the app produces but the editor
    // does not know is a red underline under a schema the app wrote itself — which is how a `group`
    // would have looked the moment migration started writing one.
    const meta = read('schema.schema.json');
    const published = meta.$defs.view.properties.kind.enum;
    const produced = [
      { rotation: {} }, { calendar: {} }, { pivot: {} }, { rsvp: {} }, { board: {} },
      { form: {} }, { stats: {} }, { timeline: {} }, { scan: {} }, { markdown: '' }, { views: [] }, {},
    ].map((v) => Migrations.kindOf(v));
    assert.deepEqual([...new Set(produced)].sort(), [...published].sort());
  });
});

// --- "what does it RENDER" vs "does it render its own prose" ---------------------------------------
//
// Two different questions, and the codebase needs both. Conflating them is the specific mistake this
// block exists to prevent, because the honest-looking fix is the broken one.
describe('rendersOwnProse -- the {{self}} invariant, which is NOT the page kind', () => {
  const VIEWS = {
    doc_only: { name: 'doc_only', kind: 'page', markdown: '# hi' },
    // demo-schema's task_doc shape: prose ABOVE its own grid, placed with the self token.
    doc_with_grid: { name: 'doc_with_grid', kind: 'page', sources: ['tasks'], markdown: 'Above {{self}}' },
    plain: { name: 'plain', kind: 'data', sources: ['tasks'] },
  };
  const rendersOwnProse = appCoreFn('rendersOwnProse', { VIEWS });

  it('both markdown views ARE the page kind', () => {
    assert.equal(SchemaNormalize.viewKind(VIEWS.doc_only), 'page');
    assert.equal(SchemaNormalize.viewKind(VIEWS.doc_with_grid), 'page');
  });

  // THE INVARIANT. The self token expands to a view embed of the page's OWN name (Embeds.mdBlocks),
  // so a sourced doc-view embeds itself. If that embed rendered the prose again it would recurse --
  // bounded only by embed-view's depth cap, so five nested copies of the page instead of the grid the
  // author asked for. Answering false here is what makes the self token mean "my rows, here".
  it('a SOURCED doc-view does not render its prose when embedded, so the self token is its grid', () => {
    assert.equal(rendersOwnProse('doc_with_grid'), false);
  });

  it('a sourceless doc-view does render its prose', () => {
    assert.equal(rendersOwnProse('doc_only'), true);
  });

  it('a view with no markdown never does', () => {
    assert.equal(rendersOwnProse('plain'), false);
    assert.equal(rendersOwnProse('nonexistent'), false);
  });

  // An executable warning: `kind === "page"` is the tempting simplification, and it differs on exactly
  // the shape that matters. A future reader who "unifies" these will fail here.
  it('is deliberately NOT equivalent to kind === page', () => {
    assert.equal(SchemaNormalize.viewKind(VIEWS.doc_with_grid) === 'page', true);
    assert.notEqual(rendersOwnProse('doc_with_grid'), true,
      'if these ever agree, the self token on a sourced doc-view has started recursing into its prose');
  });

  it('the shipped schema that depends on this still has the shape', () => {
    // demo-schema's task_doc is the only shipped view carrying both, so if it loses one, the tests
    // above stop covering anything real.
    const demo = read('examples/demo-schema.json');
    let found = null;
    Migrations.eachView(demo.views, (v) => { if (v && v.name === 'task_doc') found = v; });
    assert.ok(found, 'demo-schema still ships task_doc');
    assert.equal(found.kind, 'page');
    assert.ok(found.sources && found.sources.length, 'task_doc still has sources');
    assert.ok(found.markdown.includes('{{self}}'), 'task_doc still places its grid with the self token');
    assert.equal(SchemaNormalize.viewKind(found), 'page');
  });
});

describe('viewKind -- the classifiers ask it, rather than sniffing a body key', () => {
  // A hand-written `kind` is supported (schema.schema.json says so, and viewKind prefers it). A
  // classifier that probes `v.calendar` instead disagrees with the discriminator for exactly those
  // schemas -- which is what isCalendarName and isRotationName did until the 2026-09-22 review.
  const VIEWS = {
    declared_cal: { name: 'declared_cal', kind: 'calendar', sources: ['t'] },
    declared_rot: { name: 'declared_rot', kind: 'rotation', sources: ['t'] },
    bodied_cal: { name: 'bodied_cal', calendar: { sources: [] } },
    bodied_rot: { name: 'bodied_rot', rotation: {} },
    plain: { name: 'plain', kind: 'data', sources: ['t'] },
  };
  const isCalendarName = appCoreFn('isCalendarName', { VIEWS, SchemaNormalize });
  const isRotationName = appCoreFn('isRotationName', { VIEWS, SchemaNormalize });

  it('honours a declared kind with no matching body key', () => {
    assert.equal(isCalendarName('declared_cal'), true, 'kind calendar with no calendar body');
    assert.equal(isRotationName('declared_rot'), true, 'kind rotation with no rotation body');
  });

  it('still recognises the body-only form a legacy schema carries', () => {
    assert.equal(isCalendarName('bodied_cal'), true);
    assert.equal(isRotationName('bodied_rot'), true);
  });

  it('says no to everything else, including an unknown name', () => {
    for (const fn of [isCalendarName, isRotationName]) {
      assert.equal(fn('plain'), false);
      assert.equal(fn('nope'), false);
    }
  });
});

describe('viewKind -- every renderable kind has a component to render it', () => {
  it('VIEW_KINDS covers the vocabulary, minus the one kind that draws nothing', () => {
    // A kind the discriminator can produce but the registry cannot dispatch renders a blank screen.
    // `group` is the deliberate exception: a nav folder draws nothing, which is what makes it a folder.
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const from = src.indexOf('window.VIEW_KINDS = {');
    assert.ok(from > 0, 'found the VIEW_KINDS registry');
    const block = src.slice(from, src.indexOf('};', from));
    const published = read('schema.schema.json').$defs.view.properties.kind.enum;
    const missing = published.filter((k) => k !== 'group' && !block.includes(k + ':'));
    assert.deepEqual(missing, [],
      'VIEW_KINDS has no component for: ' + missing.join(', ') + ' -- a view of that kind renders blank');
    assert.ok(!block.includes('group:'), 'a nav group must NOT have a component: it is a folder');
  });
});

describe('viewKind -- which kinds an EMBED can render as themselves', () => {
  // "Embedding is free" is what ROADMAP.md promises a new view kind: embed-view dispatches on the same
  // classifier, so a {{view:x}} renders x properly the day the kind exists. That is true of six kinds.
  //
  // It is NOT true of board, form and timeline. All three have components that accept an `embed` prop,
  // but embed-view's template has no branch for them, so they fall through to the data grid: embedding
  // a kanban board in a document silently renders a table of its rows instead. Nothing said so, which
  // is the actual problem -- the fallthrough is indistinguishable from a deliberate choice.
  //
  // This test does not decide which it should be (that question is recorded in ROADMAP.md). It makes
  // the current answer EXPLICIT, so adding a kind without an embed branch is a failing test rather
  // than a surprise for whoever first embeds one.
  const embedBranches = () => {
    const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
    const from = src.indexOf("app.component('embed-view'");
    assert.ok(from > 0, 'found the embed-view component');
    const block = src.slice(from);
    return [...new Set([...block.matchAll(/kind===[^a-z]*([a-z]+)/g)].map((m) => m[1]))].sort();
  };

  it('dispatches these kinds to their own component', () => {
    assert.deepEqual(embedBranches(), ['calendar', 'doc', 'pivot', 'rotation', 'rsvp', 'scan', 'stats']);
  });

  it('board, form and timeline fall through to the data grid -- recorded, not endorsed', () => {
    const branches = embedBranches();
    for (const kind of ['board', 'form', 'timeline']) {
      assert.ok(!branches.includes(kind),
        kind + ' now has an embed branch. Good -- delete it from this list, and from the ROADMAP entry ' +
        'that records the gap.');
    }
  });

  // `doc` is the embed-level name for a page that renders its own prose, and it is deliberately NOT
  // the schema kind `page`: a SOURCED page embeds as `data` (see rendersOwnProse above), so the two
  // vocabularies answer different questions and cannot be merged into one word.
  it('the embed vocabulary says doc, the schema vocabulary says page, and that is not drift', () => {
    const published = read('schema.schema.json').$defs.view.properties.kind.enum;
    assert.ok(published.includes('page'), 'the schema kind is `page`');
    assert.ok(embedBranches().includes('doc'), 'the embed rendering mode is `doc`');
    assert.ok(!published.includes('doc'), '`doc` is not a schema kind and must not become one');
  });
});
