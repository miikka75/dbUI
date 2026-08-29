const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA, VIEWS } = require('../schema');

// Pure logic extracted from app-core.js computed properties

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

describe('Sourceless views declare their inputs per-kind (viewImplicitTables)', () => {
  // The nav gate unlocks a sourceless view on ANY of these tables. Before they were collected, the gate
  // saw an empty input set and let every calendar/pivot/rsvp through to a user granted nothing it reads
  // -- a tab that could only ever render empty. The REAL module function, not a copy of it.
  const AF = require('../../access-features');

  it('a calendar is unlocked by its per-source tables', () => {
    const cal = { calendar: { sources: [{ table: 'chores', dateColumn: 'on' }, { table: 'shopping', dateColumn: 'by' }] } };
    assert.deepEqual(AF.viewImplicitTables(cal, {}), ['chores', 'shopping']);
  });
  it("a calendar's rotation overlay pulls in the rotation view's own tables", () => {
    const views = { duty: { rotation: { columns: [{ name: 'duty', rotationTable: 'duty_rota' }] } } };
    const cal = { calendar: { sources: [{ table: 'chores' }], rotationSources: [{ view: 'duty' }] } };
    assert.deepEqual(AF.viewImplicitTables(cal, views), ['chores', 'duty_rota']);
  });
  it('a rotation view still reports its rosters and computed helpers', () => {
    const rot = { rotation: { rosters: ['team_a', 'team_b'], columns: [{ rotationTable: 'slots' }] } };
    assert.deepEqual(AF.viewImplicitTables(rot, {}), ['team_a', 'team_b', 'slots']);
  });
  it('a pivot reports the table it cross-tabulates', () => {
    assert.deepEqual(AF.viewImplicitTables({ pivot: { source: 'chore_log', row: 'p', column: 'c' } }, {}), ['chore_log']);
  });
  it('an rsvp reports BOTH the events and the responses table', () => {
    const rsvp = { rsvp: { events: 'practices', responses: 'rsvps', dateColumn: 'date', statusColumn: 's' } };
    assert.deepEqual(AF.viewImplicitTables(rsvp, {}), ['practices', 'rsvps']);
  });
  it('a plain data view reports nothing implicit — its `sources` already gate it', () => {
    assert.deepEqual(AF.viewImplicitTables({ sources: ['tasks'] }, {}), []);
  });
  it('duplicates collapse, so one shared table cannot be double-counted', () => {
    const views = { duty: { sources: ['chores'] } };
    const cal = { calendar: { sources: [{ table: 'chores' }, { table: 'chores' }], rotationSources: [{ view: 'duty' }] } };
    assert.deepEqual(AF.viewImplicitTables(cal, views), ['chores']);
  });
  it('a calendar pointing at a missing view is ignored, not fatal', () => {
    const cal = { calendar: { sources: [{ table: 'chores' }], rotationSources: [{ view: 'nope' }] } };
    assert.deepEqual(AF.viewImplicitTables(cal, {}), ['chores']);
  });
  it('two calendars overlaying each other terminate instead of recursing forever', () => {
    const views = {};
    views.a = { calendar: { sources: [{ table: 'ta' }], rotationSources: [{ view: 'b' }] } };
    views.b = { calendar: { sources: [{ table: 'tb' }], rotationSources: [{ view: 'a' }] } };
    assert.deepEqual(AF.viewImplicitTables(views.a, views), ['ta', 'tb']);
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

describe('Doc-view embed access gating (access + "all" sentinel)', () => {
  // Mirrors app-core.js canAccessPage() and embed-view's blocks() gating for a doc-view embedded in a
  // page ({{view:x}}). The block renders the ACCESS-GATED server body: hidden unless canAccessPage
  // passes, then built from the loaded pageCache body (schema seed only as a pre-load fallback).
  // `allowed` is userAllowedTables: null = admin / tables:'all' (unrestricted), [] = registered no-grant.
  function canAccessPage(view, allowed) {
    if (!view || typeof view.markdown !== 'string') return true;   // not a doc-view
    var acc = view.access;
    if (!Array.isArray(acc) || !acc.length) return true;           // untagged -> all registered
    if (!allowed) return true;                                     // admin / unrestricted
    return acc.some(function(t) { return allowed.indexOf(t) >= 0; });
  }
  // Returns the markdown text a doc embed would render, or null if the block is hidden. `mdBlocks` is
  // the identity here (we assert on the resolved source text, not on parsed blocks).
  function docEmbedText(view, allowed, cacheBody, depth) {
    if ((depth || 0) > 4) return null;                             // recursion cap for doc<->doc cycles
    if (!canAccessPage(view, allowed)) return null;                // access-gated: no grant -> nothing
    return cacheBody != null ? cacheBody : (view.markdown || '');  // server body wins; seed is fallback
  }

  const restricted = { name: 'sisainen', markdown: '# seed', access: ['all'] };
  const untagged = { name: 'welcome', markdown: '# hi' };

  it('access:["all"] — admin / tables:all (allowed=null) can see it', () => {
    assert.equal(canAccessPage(restricted, null), true);
  });
  it('access:["all"] — a partial-grant user is denied, even with a real table', () => {
    assert.equal(canAccessPage(restricted, ['musiikki']), false);
  });
  it('access:["all"] — a registered no-grant user ([]) is denied', () => {
    assert.equal(canAccessPage(restricted, []), false);
  });
  it('untagged doc-view stays visible to every registered user', () => {
    assert.equal(canAccessPage(untagged, []), true);
    assert.equal(canAccessPage(untagged, ['musiikki']), true);
  });

  it('embed renders the loaded server body for a full-access user', () => {
    assert.equal(docEmbedText(restricted, null, '# real links'), '# real links');
  });
  it('embed falls back to the schema seed before the body loads', () => {
    assert.equal(docEmbedText(restricted, null, undefined), '# seed');
  });
  it('embed renders NOTHING for a restricted user (no seed leak either)', () => {
    assert.equal(docEmbedText(restricted, ['musiikki'], '# real links'), null);
  });
  it('embed is capped past max recursion depth', () => {
    assert.equal(docEmbedText(untagged, null, '# x', 5), null);
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
  // Feature helpers are the REAL module (../../access-features), shared with app-core.js — no more
  // hand-copied logic that can drift. Thin adapters preserve this suite's expected shapes: grantFeatures
  // -> ids (the module returns { id, view }); featureClosure/expandFeatureGrants sorted for stable
  // assertions (the module returns insertion order, which the app doesn't depend on).
  const AF = require('../../access-features');
  const viewRosters = AF.viewRosters;
  const isPureMirror = (schema, t) => AF.isPureMirror(t, schema);
  const satelliteTables = AF.satelliteTables;
  const grantFeatures = (schema, views) => AF.grantFeatures(schema, views).map((f) => f.id);
  const featureClosure = (id, schema, views) => AF.featureClosure(id, schema, views).sort();
  const expandFeatureGrants = (ids, schema, views) => AF.expandFeatureGrants(ids, schema, views).sort();
  const selectedFeatures = AF.selectedFeatures;
  // canAccess for a sourceless rotation view: unlocked by ANY roster (missing roster -> blank cells).
  // Kept local — this mirrors inline canAccess logic in sidebarTabs, not a standalone module function.
  function canAccessRotationView(viewName, views, allowedTables) {
    var v = views[viewName]; var rosters = viewRosters(v);
    if (v.sources && v.sources.length) return v.sources.every(function(s) { return allowedTables.indexOf(s) >= 0; });
    if (rosters.length) return rosters.some(function(t) { return allowedTables.indexOf(t) >= 0; });
    return true;
  }

  // Mirror-shaped fixture: meetings master; music mirrors its date but has its OWN columns (-> own feature);
  // ushers_turns is a pure mirror (only date) -> satellite; rosters feed rotation/occurrence.
  const schema = {
    meetings: { columns: { date: 'date', chair: { type: 'select', list: 'p' } } },
    music: { columns: { date: { syncFrom: 'meetings' }, song: { type: 'select', list: 'songs' } } },
    ushers_turns: { columns: { date: { syncFrom: 'meetings' } } },
    ushers_list: { columns: { people: { type: 'multiselect', list: 's' } } },
    team_a: { columns: { people: { type: 'multiselect', list: 's' } } },
    team_b: { columns: { people: { type: 'multiselect', list: 's' } } },
    todos: { columns: { who: { type: 'select', list: 's' } } }
  };
  const views = {
    meeting: { sources: ['meetings'] },
    music: { sources: ['music'] },
    program: { sources: ['meetings', 'music'], columns: [{ name: 'usher', computed: { rotationTable: 'ushers_list', occurrenceSource: 'ushers_turns' } }] },
    ushers: { sources: ['ushers_turns'], columns: [{ name: 'usher', computed: { rotationTable: 'ushers_list', occurrenceSource: 'ushers_turns' } }] },
    cleaning: { rotation: { rosters: ['team_a', 'team_b'] } },
    todos: { sources: ['todos'] }
  };

  it('rotation rosters are NOT satellites (per-roster grants); only computed helpers + pure mirrors are', () => {
    assert.equal(isPureMirror(schema, 'ushers_turns'), true);
    assert.equal(isPureMirror(schema, 'music'), false);
    assert.deepEqual(Object.keys(satelliteTables(schema, views)).sort(),
      ['ushers_list', 'ushers_turns']);          // team_a/b no longer satellites
  });
  it('team_a and team_b are separate chips; the cleaning view is NOT a chip', () => {
    assert.deepEqual(grantFeatures(schema, views).sort(),
      ['meetings', 'music', 'team_a', 'team_b', 'todos', 'ushers']);
  });
  it('each cleaning roster grants ONLY itself (team_b never pulls team_a)', () => {
    assert.deepEqual(featureClosure('team_a', schema, views), ['team_a']);
    assert.deepEqual(featureClosure('team_b', schema, views), ['team_b']);
  });
  it('cleaning view is unlocked by ANY roster; the missing roster simply renders blank', () => {
    assert.equal(canAccessRotationView('cleaning', views, ['team_b']), true);  // team_b coordinator
    assert.equal(canAccessRotationView('cleaning', views, ['team_a']), true);
    assert.equal(canAccessRotationView('cleaning', views, []), false);            // neither roster -> hidden
  });
  // rotationTables is THE answer to "which tables feed this rotation", over all three shapes. The
  // app asks it in four places (the calendar overlay's access gate, two row-cache preloads, the write
  // gate); each used to re-derive it, and adding `rosterRef` meant adding a branch to each.
  it('rotationTables covers all three rotation shapes', () => {
    const AFT = AF.rotationTables;
    assert.deepEqual(AFT({ rotation: { rosters: ['team_a', 'team_b'] } }), ['team_a', 'team_b']);
    assert.deepEqual(AFT({ rotation: { rosterRef: 'ref_duties', rosterBy: 'person', valueCol: 'tasks' } }), ['ref_duties']);
    assert.deepEqual(AFT({ rotation: { columns: [{ name: 'a', rotationTable: 'team_a' }, { name: 'b', rotationTable: 'team_b' }] } }),
      ['team_a', 'team_b']);
    // A columns entry with no rotationTable contributes nothing rather than an `undefined` table name
    // — one preload passed that straight into the row cache before this was in one place.
    assert.deepEqual(AFT({ rotation: { columns: [{ name: 'a' }, { name: 'b', rotationTable: 'team_b' }] } }), ['team_b']);
    assert.deepEqual(AFT({ sources: ['todos'] }), []);   // not a rotation at all
    assert.deepEqual(AFT(null), []);
  });
  it('viewRosters is the GRANTABLE subset: shapes (a) and (b), never the legacy per-column one', () => {
    // Shape (c)'s targets are satellites (viewComputedHelpers grants them); promoting them to chips
    // would change what an existing grant materializes, so the two answers stay deliberately apart.
    assert.deepEqual(viewRosters({ rotation: { rosterRef: 'ref_duties' } }), ['ref_duties']);
    assert.deepEqual(viewRosters({ rotation: { rosters: ['team_a'] } }), ['team_a']);
    assert.deepEqual(viewRosters({ rotation: { columns: [{ name: 'a', rotationTable: 'team_a' }] } }), []);
  });

  it('team_b coordinator cannot access the team_a table (server-enforced blanking)', () => {
    var allowed = featureClosure('team_b', schema, views);
    assert.equal(allowed.indexOf('team_a'), -1);
    assert.equal(allowed.indexOf('team_b') >= 0, true);
  });
  it('music closure is music only — it does NOT pull meetings', () => {
    var c = featureClosure('music', schema, views);
    assert.deepEqual(c, ['music']);
    assert.equal(c.indexOf('meetings'), -1);
  });
  it('ushers closure = its roster + date mirror only (staff list auto-derives)', () => {
    assert.deepEqual(featureClosure('ushers', schema, views), ['ushers_list', 'ushers_turns']);
  });
  it('meetings closure is decoupled: just meetings (no shifts, no music)', () => {
    assert.deepEqual(featureClosure('meetings', schema, views), ['meetings']);
  });
  it('independent primary stays isolated', () => {
    assert.deepEqual(featureClosure('todos', schema, views), ['todos']);
  });
  it('materializes the union of selected feature closures', () => {
    assert.deepEqual(expandFeatureGrants(['meetings', 'music', 'ushers', 'team_b'], schema, views),
      ['meetings', 'music', 'team_b', 'ushers_list', 'ushers_turns']);
  });
  it('reverse-maps a stored table list back to selected features', () => {
    assert.deepEqual(selectedFeatures(['ushers_list', 'ushers_turns'], schema, views), ['ushers']);
    assert.deepEqual(selectedFeatures(['team_b'], schema, views), ['team_b']);
    assert.deepEqual(selectedFeatures(['meetings'], schema, views), ['meetings']);
  });
  it('a partially-granted feature is not shown as selected', () => {
    // ushers_turns alone (missing the roster ushers_list) -> ushers not covered
    assert.deepEqual(selectedFeatures(['ushers_turns'], schema, views), []);
  });
});

// Lifts a member out of app-core.js and runs it, so these assertions bind to the SHIPPED code rather
// than a copy of it — a mirrored re-implementation is what let the `|| []` drift through last time.
// Members sit at a fixed 6-space indent as `name: function(<args>) { ... },`.
function appCoreFn(name) {
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');
  const head = '      ' + name + ': function(';
  const start = src.indexOf(head);
  assert.ok(start >= 0, 'could not find ' + name + ' in app-core.js');
  const argsEnd = src.indexOf(')', start);
  const open = src.indexOf('{', argsEnd);
  const end = src.indexOf('\n      },', start);
  assert.ok(end > start, 'could not find the end of ' + name);
  // The trailing newline matters: a body whose last line ends in a // comment would otherwise swallow
  // the closing brace.
  return new Function('AccessFeatures',
    'return function(' + src.slice(start + head.length, argsEnd) + ') {' + src.slice(open + 1, end) + '\n};'
  )(require('../../access-features'));
}
function runAppCore(name, ctx, ...args) { return appCoreFn(name).apply(ctx, args); }

describe('canReachTable — the one reachability test every read gate shares', () => {
  // Nav, the embed filter, the boot preload, _ensureCached and the calendar's per-source gate all ask
  // this one question. They used to each re-derive it, and the copies disagreed: a grantless member got
  // a self-service view in the menu whose embeds were filtered out and whose rows were never fetched.
  const ctx = (allowed, selfServe) => ({
    userAllowedTables: allowed,
    canSelfServe: (t) => (selfServe || []).indexOf(t) >= 0
  });

  it('an unrestricted user reaches every table', () => {
    assert.equal(runAppCore('canReachTable', ctx(null, []), 'anything'), true);
  });
  it('a granted table is reachable', () => {
    assert.equal(runAppCore('canReachTable', ctx(['tasks'], []), 'tasks'), true);
  });
  it('a self-serviceable table is reachable with NO grant on it', () => {
    assert.equal(runAppCore('canReachTable', ctx([], ['chore_log']), 'chore_log'), true);
  });
  it('an ungranted, non-self-service table is not reachable', () => {
    assert.equal(runAppCore('canReachTable', ctx(['tasks'], ['chore_log']), 'secrets'), false);
  });
  it('a registered user with no grants and no self-service reaches nothing', () => {
    assert.equal(runAppCore('canReachTable', ctx([], []), 'tasks'), false);
  });
});

describe('Grant modes (r / rw) across the three stored shapes', () => {
  const AF = require('../../access-features');
  const BH = require('../../backend-helpers');
  const schema = { chores: { columns: { a: 'text' } }, catalogue: { columns: { b: 'text' } }, shopping: { columns: { c: 'text' } } };
  const views = {};

  it("'all' is unrestricted: every table rw, and both name sets read null", () => {
    assert.equal(AF.grantMode('all', 'anything'), 'rw');
    assert.equal(AF.readableTables('all'), null);
    assert.equal(AF.writableTables('all'), null);
  });

  // REGRESSION: the reader's null sentinel has to survive the trip into app-core's userAllowedTables /
  // userWritableTables. Those computeds once ended in `|| []`, which turned "unrestricted" into "no
  // tables" and fail-closed every non-admin holding tables:'all' -- the shape addUser() writes and the
  // one _saveGrants() falls back to when an admin clears every chip. Both rules layers read 'all' as
  // full access, so the collapse showed up as a client-only empty nav.
  //
  // This runs the REAL computed bodies lifted out of app-core.js rather than a copy of them: a mirrored
  // re-implementation is exactly what let the drift through last time -- the mirror stayed correct while
  // the shipped code changed underneath it.
  describe("a NON-ADMIN on 'all' stays unrestricted through the app-core gate", () => {
    const asUser = (tables) => ({ selfUnregistered: false, isAdmin: false, currentUserEntry: { tables: tables } });

    it("'all' reaches the gate as null (unrestricted), not as an empty list", () => {
      assert.equal(runAppCore('userAllowedTables', asUser('all')), null);
      assert.equal(runAppCore('userWritableTables', asUser('all')), null);
    });
    it('a registered user with no grants still fails closed', () => {
      assert.deepEqual(runAppCore('userAllowedTables', asUser({})), []);
      assert.deepEqual(runAppCore('userWritableTables', asUser({})), []);
    });
    it('a mode map still separates read from write', () => {
      const u = asUser({ chores: 'rw', catalogue: 'r' });
      assert.deepEqual(runAppCore('userAllowedTables', u), ['chores', 'catalogue']);
      assert.deepEqual(runAppCore('userWritableTables', u), ['chores']);
    });
  });

  it('a LEGACY array still means read+write on each name (no migration needed)', () => {
    const legacy = ['chores', 'catalogue'];
    assert.equal(AF.grantMode(legacy, 'chores'), 'rw');
    assert.equal(AF.grantMode(legacy, 'shopping'), null);
    assert.deepEqual(AF.readableTables(legacy), ['chores', 'catalogue']);
    assert.deepEqual(AF.writableTables(legacy), ['chores', 'catalogue']);
  });

  it('a mode map separates read from write', () => {
    const map = { chores: 'rw', catalogue: 'r' };
    assert.equal(AF.grantMode(map, 'chores'), 'rw');
    assert.equal(AF.grantMode(map, 'catalogue'), 'r');
    assert.equal(AF.grantMode(map, 'shopping'), null);
    assert.deepEqual(AF.readableTables(map), ['chores', 'catalogue']);   // 'r' is still visible
    assert.deepEqual(AF.writableTables(map), ['chores']);                // ...but not writable
  });

  it('an unrecognized mode value is treated as rw, never as silent extra restriction', () => {
    assert.equal(AF.grantMode({ chores: 'write' }, 'chores'), 'rw');
    assert.equal(AF.grantMode({ chores: true }, 'chores'), 'rw');
  });

  it('no grant at all fails closed', () => {
    assert.deepEqual(AF.readableTables(undefined), []);
    assert.deepEqual(AF.writableTables(null), []);
    assert.equal(AF.grantMode({}, 'chores'), null);
  });

  it('buildGrants merges the two chip rows, edit winning over view', () => {
    assert.deepEqual(AF.buildGrants(['chores'], ['catalogue'], schema, views), { chores: 'rw', catalogue: 'r' });
    assert.deepEqual(AF.buildGrants(['chores'], ['chores'], schema, views), { chores: 'rw' });
    assert.deepEqual(AF.buildGrants([], ['catalogue'], schema, views), { catalogue: 'r' });
  });

  it('userGrantDoc denormalizes rwTables for a map — and only for a map', () => {
    // The rules layers cannot filter a map, so the writable subset is materialized at write time.
    assert.deepEqual(BH.userGrantDoc('k@x', 'editor', 'k@x', { chores: 'rw', catalogue: 'r' }),
      { role: 'editor', user: 'k@x', tables: { chores: 'rw', catalogue: 'r' }, rwTables: ['chores'] });
    // 'all' and legacy arrays carry no rwTables: their write gates fall back to plain membership.
    assert.equal('rwTables' in BH.userGrantDoc('k@x', 'admin', 'k@x', 'all'), false);
    assert.equal('rwTables' in BH.userGrantDoc('k@x', 'editor', 'k@x', ['chores']), false);
    assert.equal(BH.userGrantDoc('k@x', 'editor', 'k@x', null).tables, 'all');
  });

  it('the chore-app shape: read the catalogue, self-serve the log', () => {
    // A member granted 'r' on reference data and nothing on the owner-column table they log into.
    const grant = { catalogue: 'r' };
    assert.equal(AF.grantMode(grant, 'catalogue'), 'r');      // visible, not editable
    assert.equal(AF.grantMode(grant, 'chores'), null);        // no grant -> self-service handles it
    assert.deepEqual(AF.writableTables(grant), []);
  });
});
