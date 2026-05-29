const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA, VIEWS } = require('../schema');

// Pure logic extracted from app-core.html computed properties

function resolveTableSelection(selected, prev) {
  if (selected.indexOf('all') >= 0 && prev.indexOf('all') < 0) return 'all';
  if (selected.indexOf('all') >= 0 && selected.length > 1) return selected.filter(function(s) { return s !== 'all'; });
  if (selected.indexOf('all') >= 0) return 'all';
  return selected.length ? selected : 'all';
}

function getVisibleLists(listsCache, userTables, schema) {
  if (userTables === 'all') return listsCache;
  var allowedLists = {};
  (Array.isArray(userTables) ? userTables : []).forEach(function(t) {
    if (!schema[t]) return;
    var cols = schema[t].columns || {};
    Object.keys(cols).forEach(function(c) {
      var def = cols[c];
      var listName = (typeof def === 'object' && def.list) ? def.list : null;
      if (listName) allowedLists[listName] = true;
    });
  });
  var result = {};
  Object.keys(listsCache).forEach(function(name) { if (allowedLists[name]) result[name] = listsCache[name]; });
  return result;
}

function getVisibleViews(views, allowedTables) {
  if (!allowedTables) return Object.keys(views);
  return Object.keys(views).filter(function(v) {
    var sources = views[v].sources || [];
    return sources.every(function(s) { return allowedTables.indexOf(s) >= 0; });
  });
}

function getFirebaseRole(userList, email) {
  if (!userList.length) return 'admin'; // bootstrap
  var u = userList.find(function(x) { return x.addr === email; });
  return u ? u.role : null;
}

describe('Table selection logic', () => {
  it('selecting All clears individual tables', () => {
    assert.equal(resolveTableSelection(['all', 'tasks'], ['tasks']), 'all');
  });
  it('selecting table removes All', () => {
    var result = resolveTableSelection(['all', 'tasks'], ['all']);
    assert.deepEqual(result, ['tasks']);
  });
  it('empty selection defaults to all', () => {
    assert.equal(resolveTableSelection([], ['tasks']), 'all');
  });
  it('keeps selected tables', () => {
    assert.deepEqual(resolveTableSelection(['tasks', 'notes'], ['tasks']), ['tasks', 'notes']);
  });
});

describe('Visible lists filtering', () => {
  const lists = { status: ['open', 'closed'], priority: ['high', 'low'], category: ['a', 'b'] };
  const schema = {
    tasks: { columns: { status: { type: 'select', list: 'status' }, title: 'text' } },
    notes: { columns: { priority: { type: 'select', list: 'priority' }, body: 'text' } }
  };

  it('admin sees all lists', () => {
    assert.deepEqual(getVisibleLists(lists, 'all', schema), lists);
  });
  it('user with tasks access sees only status list', () => {
    var result = getVisibleLists(lists, ['tasks'], schema);
    assert.deepEqual(Object.keys(result), ['status']);
  });
  it('user with both tables sees both lists', () => {
    var result = getVisibleLists(lists, ['tasks', 'notes'], schema);
    assert.deepEqual(Object.keys(result).sort(), ['priority', 'status']);
  });
  it('user with no matching tables sees nothing', () => {
    var result = getVisibleLists(lists, ['other'], schema);
    assert.deepEqual(result, {});
  });
});

describe('View access filtering', () => {
  const views = {
    combined: { sources: ['tasks', 'notes'] },
    tasks_only: { sources: ['tasks'] }
  };

  it('null allowedTables shows all views', () => {
    assert.deepEqual(getVisibleViews(views, null), ['combined', 'tasks_only']);
  });
  it('user with all sources sees the view', () => {
    assert.deepEqual(getVisibleViews(views, ['tasks', 'notes']), ['combined', 'tasks_only']);
  });
  it('user missing a source table hides the view', () => {
    assert.deepEqual(getVisibleViews(views, ['tasks']), ['tasks_only']);
  });
  it('user with no matching tables sees no views', () => {
    assert.deepEqual(getVisibleViews(views, ['other']), []);
  });
});

describe('Firebase role resolution', () => {
  it('empty user list returns admin (bootstrap)', () => {
    assert.equal(getFirebaseRole([], 'a@b.com'), 'admin');
  });
  it('registered user gets their role', () => {
    var list = [{ addr: 'a@b.com', role: 'editor' }];
    assert.equal(getFirebaseRole(list, 'a@b.com'), 'editor');
  });
  it('unregistered user gets null', () => {
    var list = [{ addr: 'a@b.com', role: 'admin' }];
    assert.equal(getFirebaseRole(list, 'other@b.com'), null);
  });
  it('viewer role', () => {
    var list = [{ addr: 'v@b.com', role: 'viewer' }];
    assert.equal(getFirebaseRole(list, 'v@b.com'), 'viewer');
  });
});

describe('Embed access filtering', () => {
  function filterEmbeds(embeds, allowedTables) {
    if (!allowedTables) return embeds;
    return embeds.filter(function(e) {
      if (e._text) return true;
      var sources = e.sources || [];
      return sources.every(function(s) { return allowedTables.indexOf(s) >= 0; });
    });
  }

  const embeds = [
    { sources: ['tasks'], columns: ['date', 'title'] },
    { sources: ['notes'], columns: ['content'] },
    { sources: ['tasks', 'notes'], columns: ['date', 'content'] },
    { _text: 'section.header' }
  ];

  it('null allowedTables shows all embeds', () => {
    assert.equal(filterEmbeds(embeds, null).length, 4);
  });
  it('user with all sources sees all embeds', () => {
    assert.equal(filterEmbeds(embeds, ['tasks', 'notes']).length, 4);
  });
  it('user missing notes hides notes-only and multi-source embeds', () => {
    var result = filterEmbeds(embeds, ['tasks']);
    assert.equal(result.length, 2); // tasks embed + text
    assert.deepEqual(result[0].sources, ['tasks']);
    assert.equal(result[1]._text, 'section.header');
  });
  it('text entries always visible regardless of access', () => {
    var result = filterEmbeds(embeds, []);
    assert.equal(result.length, 1);
    assert.equal(result[0]._text, 'section.header');
  });
});

describe('Server-side table access check', () => {
  function checkTableAccess(tableId, users, userEmail) {
    if (!users) return true;
    const u = Object.values(users).find(v => v.user === userEmail);
    if (!u) return false;
    if (u.role === 'admin' || u.tables === 'all') return true;
    const base = tableId ? tableId.split('__')[0] : '';
    return (u.tables || []).indexOf(base) >= 0;
  }

  const users = {
    'admin@dev': { role: 'admin', user: 'admin@dev', tables: 'all' },
    'editor@dev': { role: 'editor', user: 'editor@dev', tables: ['tasks', 'notes'] },
    'viewer@dev': { role: 'viewer', user: 'viewer@dev', tables: ['tasks'] }
  };

  it('admin can access any table', () => {
    assert.equal(checkTableAccess('cities__active', users, 'admin@dev'), true);
  });
  it('editor can access allowed table', () => {
    assert.equal(checkTableAccess('tasks__active', users, 'editor@dev'), true);
  });
  it('editor cannot access disallowed table', () => {
    assert.equal(checkTableAccess('cities__active', users, 'editor@dev'), false);
  });
  it('viewer can access allowed table', () => {
    assert.equal(checkTableAccess('tasks__active', users, 'viewer@dev'), true);
  });
  it('viewer cannot access disallowed table', () => {
    assert.equal(checkTableAccess('notes__active', users, 'viewer@dev'), false);
  });
  it('unknown user has no access', () => {
    assert.equal(checkTableAccess('tasks__active', users, 'unknown@dev'), false);
  });
  it('no users config = unrestricted', () => {
    assert.equal(checkTableAccess('tasks__active', null, 'anyone@dev'), true);
  });
  it('handles partition suffix correctly', () => {
    assert.equal(checkTableAccess('tasks__archive', users, 'editor@dev'), true);
    assert.equal(checkTableAccess('cities__archive', users, 'editor@dev'), false);
  });
});
