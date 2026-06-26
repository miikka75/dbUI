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

describe('Permission features (primary chips + materialized closure)', () => {
  // Pure copies of the app-core.html feature helpers, parameterized by (schema, views).
  function getMirrorSource(schema, t) {
    var cols = (schema[t] && schema[t].columns) || {};
    for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.syncFrom) return d.syncFrom; }
    return null;
  }
  function viewRosters(v) { return (v && v.rotation && Array.isArray(v.rotation.rosters)) ? v.rotation.rosters.slice() : []; }
  function viewComputedHelpers(v) {
    var out = [];
    if (v && v.rotation && Array.isArray(v.rotation.columns)) v.rotation.columns.forEach(function(c) { if (c && c.rotationTable) out.push(c.rotationTable); });
    ((v && v.columns) || []).forEach(function(c) {
      if (c && typeof c === 'object' && c.computed) {
        if (c.computed.rotationTable) out.push(c.computed.rotationTable);
        if (c.computed.occurrenceSource) out.push(c.computed.occurrenceSource);
      }
    });
    return out;
  }
  function viewHelperTables(v) { return viewRosters(v).concat(viewComputedHelpers(v)); }
  function viewTables(v) { return ((v && v.sources) || []).concat(viewHelperTables(v)); }
  function isPureMirror(schema, t) {
    var cols = (schema[t] && schema[t].columns) || {}, hasMirror = false, hasOwn = false;
    Object.keys(cols).forEach(function(c) {
      if (c === 'id') return;
      var d = cols[c];
      if (d && typeof d === 'object' && d.syncFrom) hasMirror = true; else hasOwn = true;
    });
    return hasMirror && !hasOwn;
  }
  function satelliteTables(schema, views) {
    var sat = {};
    Object.keys(views).forEach(function(n) { viewComputedHelpers(views[n]).forEach(function(t) { sat[t] = true; }); });
    Object.keys(schema).forEach(function(t) { if (isPureMirror(schema, t)) sat[t] = true; });
    return sat;
  }
  function grantFeatures(schema, views) {
    var sat = satelliteTables(schema, views), feats = [];
    Object.keys(schema).forEach(function(t) { if (!sat[t]) feats.push(t); });
    Object.keys(views).forEach(function(n) {
      var v = views[n], srcs = v.sources || [];
      if (v.rotation && viewRosters(v).length) return;       // rosters are the chips, not the view
      var hasPrimarySource = srcs.some(function(s) { return !sat[s]; });
      if (srcs.length && !hasPrimarySource) feats.push(n);
    });
    return feats;
  }
  function featureClosure(id, schema, views) {
    var S = {};
    if (views[id]) viewTables(views[id]).forEach(function(t) { S[t] = true; });
    else S[id] = true;
    var changed = true;
    while (changed) {
      changed = false;
      Object.keys(views).forEach(function(n) {
        var v = views[n], src = v.sources || [];
        if (!src.length) return;
        if (!src.every(function(s) { return S[s]; })) return;
        viewHelperTables(v).forEach(function(t) { if (!S[t]) { S[t] = true; changed = true; } });
      });
    }
    return Object.keys(S).sort();
  }
  // canAccess for a sourceless rotation view: unlocked by ANY roster (missing roster -> blank cells).
  function canAccessRotationView(viewName, views, allowedTables) {
    var v = views[viewName]; var rosters = viewRosters(v);
    if (v.sources && v.sources.length) return v.sources.every(function(s) { return allowedTables.indexOf(s) >= 0; });
    if (rosters.length) return rosters.some(function(t) { return allowedTables.indexOf(t) >= 0; });
    return true;
  }
  function expandFeatureGrants(ids, schema, views) {
    var S = {};
    ids.forEach(function(f) { featureClosure(f, schema, views).forEach(function(t) { S[t] = true; }); });
    return Object.keys(S).sort();
  }
  function selectedFeatures(tableList, schema, views) {
    var have = {}; tableList.forEach(function(t) { have[t] = true; });
    return grantFeatures(schema, views).filter(function(f) { return featureClosure(f, schema, views).every(function(t) { return have[t]; }); });
  }

  // Church-shaped fixture: kokoukset master; musiikki mirrors it but has OWN song columns (-> own feature);
  // ovimiehet_vuorot is a pure mirror (only pvm) -> satellite; rosters feed rotation/occurrence.
  const schema = {
    kokoukset: { columns: { pvm: 'date', johtaja: { type: 'select', list: 'p' } } },
    musiikki: { columns: { pvm: { syncFrom: 'kokoukset' }, laulu: { type: 'select', list: 'laulut' } } },
    ovimiehet_vuorot: { columns: { pvm: { syncFrom: 'kokoukset' } } },
    ovimiehet_lista: { columns: { people: { type: 'multiselect', list: 's' } } },
    siivous_a: { columns: { people: { type: 'multiselect', list: 's' } } },
    siivous_b: { columns: { people: { type: 'multiselect', list: 's' } } },
    tehtavat: { columns: { who: { type: 'select', list: 's' } } }
  };
  const views = {
    kokous: { sources: ['kokoukset'] },
    musiikki: { sources: ['musiikki'] },
    ohjelma: { sources: ['kokoukset', 'musiikki'], columns: [{ name: 'ovimies', computed: { rotationTable: 'ovimiehet_lista', occurrenceSource: 'ovimiehet_vuorot' } }] },
    ovimiehet: { sources: ['ovimiehet_vuorot'], columns: [{ name: 'ovimies', computed: { rotationTable: 'ovimiehet_lista', occurrenceSource: 'ovimiehet_vuorot' } }] },
    siivous: { rotation: { rosters: ['siivous_a', 'siivous_b'] } },
    tehtavat: { sources: ['tehtavat'] }
  };

  it('rotation rosters are NOT satellites (per-roster grants); only computed helpers + pure mirrors are', () => {
    assert.equal(isPureMirror(schema, 'ovimiehet_vuorot'), true);
    assert.equal(isPureMirror(schema, 'musiikki'), false);
    assert.deepEqual(Object.keys(satelliteTables(schema, views)).sort(),
      ['ovimiehet_lista', 'ovimiehet_vuorot']);          // siivous_a/b no longer satellites
  });
  it('siivous_a and siivous_b are separate chips; the siivous view is NOT a chip', () => {
    assert.deepEqual(grantFeatures(schema, views).sort(),
      ['kokoukset', 'musiikki', 'ovimiehet', 'siivous_a', 'siivous_b', 'tehtavat']);
  });
  it('each siivous roster grants ONLY itself (siivous_b never pulls siivous_a)', () => {
    assert.deepEqual(featureClosure('siivous_a', schema, views), ['siivous_a']);
    assert.deepEqual(featureClosure('siivous_b', schema, views), ['siivous_b']);
  });
  it('siivous view is unlocked by ANY roster; the missing roster simply renders blank', () => {
    assert.equal(canAccessRotationView('siivous', views, ['siivous_b']), true);  // siivous_b coordinator
    assert.equal(canAccessRotationView('siivous', views, ['siivous_a']), true);
    assert.equal(canAccessRotationView('siivous', views, []), false);            // neither roster -> hidden
  });
  it('siivous_b coordinator cannot access the siivous_a table (server-enforced blanking)', () => {
    var allowed = featureClosure('siivous_b', schema, views);
    assert.equal(allowed.indexOf('siivous_a'), -1);
    assert.equal(allowed.indexOf('siivous_b') >= 0, true);
  });
  it('musiikki closure is musiikki only — it does NOT pull kokoukset', () => {
    var c = featureClosure('musiikki', schema, views);
    assert.deepEqual(c, ['musiikki']);
    assert.equal(c.indexOf('kokoukset'), -1);
  });
  it('ovimiehet closure = its roster + date mirror only (seurakuntalaiset list auto-derives)', () => {
    assert.deepEqual(featureClosure('ovimiehet', schema, views), ['ovimiehet_lista', 'ovimiehet_vuorot']);
  });
  it('kokoukset closure is decoupled: just kokoukset (no doormen, no music)', () => {
    assert.deepEqual(featureClosure('kokoukset', schema, views), ['kokoukset']);
  });
  it('independent primary stays isolated', () => {
    assert.deepEqual(featureClosure('tehtavat', schema, views), ['tehtavat']);
  });
  it('materializes the union of selected feature closures', () => {
    assert.deepEqual(expandFeatureGrants(['kokoukset', 'musiikki', 'ovimiehet', 'siivous_b'], schema, views),
      ['kokoukset', 'musiikki', 'ovimiehet_lista', 'ovimiehet_vuorot', 'siivous_b']);
  });
  it('reverse-maps a stored table list back to selected features', () => {
    assert.deepEqual(selectedFeatures(['ovimiehet_lista', 'ovimiehet_vuorot'], schema, views), ['ovimiehet']);
    assert.deepEqual(selectedFeatures(['siivous_b'], schema, views), ['siivous_b']);
    assert.deepEqual(selectedFeatures(['kokoukset'], schema, views), ['kokoukset']);
  });
  it('a partially-granted feature is not shown as selected', () => {
    // ovimiehet_vuorot alone (missing the roster ovimiehet_lista) -> ovimiehet not covered
    assert.deepEqual(selectedFeatures(['ovimiehet_vuorot'], schema, views), []);
  });
});
