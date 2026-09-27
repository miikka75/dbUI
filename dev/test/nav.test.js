// nav.test.js — the nav tree (Nav.build), finding a node in it (Nav.find / Nav.flatten), and the `?at=`
// parameter that puts the open screen in the address bar (Nav.readAt / Nav.withAt).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Nav = require('../../nav');

const VIEWS = { home: { markdown: '# Home' }, board: { kind: 'board' }, rota: { rotation: {} }, secret: {} };
const SCHEMA = { tasks: {}, notes: {} };
const t = (k) => ({ 'nav.Data': 'Data!', 'view.home': 'Home' })[k] || '';
const all = () => true;
const opts = (o) => Object.assign({ isAdmin: false, hasLookup: false, views: VIEWS, schema: SCHEMA }, o);

const ITEMS = [
  { view: 'home' },
  { group: 'Data', items: [{ table: 'tasks' }, { group: 'Deep', items: [{ table: 'notes' }] }] },
  { view: 'board', items: [{ view: 'rota' }] },
];

describe('Nav.build', () => {
  it('builds groups, views with children, and the system tabs after a divider', () => {
    const tabs = Nav.build(ITEMS, t, all, opts({ isAdmin: true, hasLookup: true }));
    assert.deepEqual(tabs.map((n) => n.id || 'divider'),
      ['home', 'grp:Data', 'board', 'divider', '__languages', '__lookup', '__settings']);
    assert.equal(tabs[1].title, 'Data!');
    assert.equal(tabs[0].title, 'Home');
    assert.equal(tabs[0].icon, 'mdi-file-document-outline');
    assert.deepEqual(tabs[1].children.map((n) => n.id), ['tasks', 'grp:Deep']);   // a group inside a group builds
    assert.deepEqual(tabs[2].children.map((n) => n.id), ['rota']);
  });

  it('drops what the user cannot reach, and a group left empty by that', () => {
    const tabs = Nav.build(ITEMS, t, (id) => id !== 'tasks' && id !== 'notes', opts());
    assert.deepEqual(tabs.map((n) => n.id || 'divider'), ['home', 'board', 'divider', '__settings']);
  });

  it('drops entries naming a view or table that does not exist', () => {
    const tabs = Nav.build([{ view: 'nope' }, { table: 'nope' }, { view: 'home' }], t, all, opts());
    assert.deepEqual(tabs.map((n) => n.id || 'divider'), ['home', 'divider', '__settings']);
  });

  it('applies adminOnly and hideFromAdmin, on a group to the whole branch', () => {
    const items = [{ view: 'home', hideFromAdmin: true }, { group: 'Data', adminOnly: true, items: [{ table: 'tasks' }] }];
    assert.deepEqual(Nav.build(items, t, all, opts({ isAdmin: false })).map((n) => n.id || 'divider'), ['home', 'divider', '__settings']);
    assert.deepEqual(Nav.build(items, t, all, opts({ isAdmin: true })).map((n) => n.id || 'divider'), ['grp:Data', 'divider', '__languages', '__settings']);
  });
});

describe('Nav.find / Nav.flatten', () => {
  const tabs = Nav.build(ITEMS, t, all, opts());

  it('finds a node at any depth, with its ancestors as the path', () => {
    const hit = Nav.find(tabs, 'notes');
    assert.equal(hit.node.id, 'notes');
    assert.deepEqual(hit.path.map((n) => n.id), ['grp:Data', 'grp:Deep']);
    assert.deepEqual(Nav.find(tabs, 'home').path, []);
    assert.equal(Nav.find(tabs, 'grp:Deep').node.children[0].id, 'notes');
    assert.equal(Nav.find(tabs, '__settings').node.id, '__settings');
  });

  it('finds nothing for an unknown, empty, or filtered-out id', () => {
    assert.equal(Nav.find(tabs, 'secret'), null);   // a view that exists but is not in the nav
    assert.equal(Nav.find(tabs, ''), null);
    assert.equal(Nav.find(tabs, null), null);
    const member = Nav.build(ITEMS, t, (id) => id !== 'tasks', opts());
    assert.equal(Nav.find(member, 'tasks'), null);
  });

  it('flattens depth-first, parents before children, without dividers', () => {
    assert.deepEqual(Nav.flatten(tabs).map((n) => n.id),
      ['home', 'grp:Data', 'tasks', 'grp:Deep', 'notes', 'board', 'rota', '__settings']);
  });
});

describe('Nav.readAt / Nav.withAt', () => {
  it('reads the open screen from a query string', () => {
    assert.equal(Nav.readAt('?db=x&at=tasks'), 'tasks');
    assert.equal(Nav.readAt('?at=grp%3AData'), 'grp:Data');
    assert.equal(Nav.readAt(''), null);
    assert.equal(Nav.readAt('?at='), null);
  });

  it('sets `at` and keeps every other parameter', () => {
    assert.equal(Nav.withAt('?db=club&user=a%40b.c', 'tasks'), '?db=club&user=a%40b.c&at=tasks');
    assert.equal(Nav.withAt('?at=home&db=club', 'tasks'), '?at=tasks&db=club');
    assert.equal(Nav.withAt('', 'grp:Data'), '?at=grp%3AData');
    assert.equal(Nav.readAt(Nav.withAt('', 'grp:Data')), 'grp:Data');
  });

  it('removes `at` for a falsy id, leaving no bare "?"', () => {
    assert.equal(Nav.withAt('?at=home', null), '');
    assert.equal(Nav.withAt('?db=x&at=home', ''), '?db=x');
  });
});

describe('Nav.errors', () => {
  it('passes a clean nav, and no nav at all', () => {
    assert.deepEqual(Nav.errors({ items: ITEMS }), []);
    assert.deepEqual(Nav.errors(undefined), []);
  });

  it('rejects two groups with one label, at any depth', () => {
    const errs = Nav.errors({ items: [{ group: 'Data', items: [{ table: 'tasks' }] }, { group: 'X', items: [{ group: 'Data', items: [] }] }] });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /two groups are labelled "Data"/);
  });

  it('rejects non-boolean flags, and both flags on one entry', () => {
    const errs = Nav.errors({ items: [{ view: 'a', adminOnly: 'admin' }, { view: 'b', adminOnly: true, hideFromAdmin: true }] });
    assert.equal(errs.length, 2);
    assert.match(errs[0], /`adminOnly` must be true or false/);
    assert.match(errs[1], /"b" sets both/);
  });
});

describe('descriptions, display, and translation keys', () => {
  const items = [
    { group: 'Data', display: 'tiles', description: 'Raw tables', items: [{ table: 'tasks', description: 'Things to do' }] },
    { view: 'board', items: [{ view: 'rota' }] },
    { view: 'home' },
  ];

  it('carries a description, translated when a translation exists, else as authored', () => {
    const tr = (k) => ({ 'nav.desc.tasks': 'Tehtävät' })[k] || k;   // t() answers a missing key with the key
    const tabs = Nav.build(items, tr, all, opts());
    assert.equal(tabs[0].description, 'Raw tables');
    assert.equal(tabs[0].children[0].description, 'Tehtävät');
    assert.equal(tabs[2].description, undefined);
  });

  it('gives a node with children its display: its own, else the nav\'s, else list', () => {
    assert.equal(Nav.build(items, t, all, opts())[0].display, 'tiles');
    assert.equal(Nav.build(items, t, all, opts())[1].display, 'list');
    assert.equal(Nav.build(items, t, all, opts({ display: 'tiles' }))[1].display, 'tiles');
    assert.equal(Nav.build(items, t, all, opts())[2].display, undefined);   // a leaf has no page of entries
  });

  it('asks for every group label and every description', () => {
    assert.deepEqual(Nav.translationKeys({ items }), ['nav.Data', 'nav.desc.Data', 'nav.desc.tasks']);
    assert.deepEqual(Nav.translationKeys(undefined), []);
  });

  it('rejects an unknown display and a non-text description', () => {
    const errs = Nav.errors({ display: 'grid', items: [{ view: 'a', display: 'cards' }, { view: 'b', description: 3 }] });
    assert.equal(errs.length, 3);
    assert.match(errs[0], /`display` must be "list" or "tiles"/);
    assert.match(errs[1], /"a": `display`/);
    assert.match(errs[2], /"b": `description` must be text/);
  });

});
