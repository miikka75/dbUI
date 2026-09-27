// nav.js — Pure navigation tree: build it from `nav.items`, check it, and find a node in it.
// Framework-agnostic + Node-tested, mirroring board.js / pivot.js / reorder.js.
//   Browser: <script src="/nav.js">, then Nav.build(items, t, canAccess, opts). Node: const Nav = require('../nav').
//
// The tree is what every nav renderer draws — the drawer, the top tabs, the bottom bar — so it is
// built once here and access-filtered here, and the renderers only decide how deep to draw it.
(function(root) {
  // items      the schema's nav.items
  // t          translate(key) -> string ('' when missing)
  // canAccess  (viewOrTableId) -> boolean
  // opts       { isAdmin, hasLookup, views, schema, display, appearance }
  //
  // A node carries what a renderer draws: id, title, icon, and — where the schema gives them — the
  // `description` a tile or list row shows under the title, and on a node with children the
  // `display` its page uses ('list' | 'tiles'; a group's own, else the nav's, else 'list'). An `image`
  // (with its crop `focus`) is what tiles and list rows show in place of the icon.
  //
  // `opts.appearance` is the deployment's override per entry id (appConfig.navAppearance, edited in
  // Settings -> Appearance) over the schema's `icon` / `image` / `focus`. It is applied HERE, so every
  // renderer of the tree follows it. An override `image: ''` is a tombstone hiding the schema's image.
  function build(navItems, t, canAccess, opts) {
    var views = opts.views || {}, schema = opts.schema || {}, looks = opts.appearance || {};
    function look(tb, it) {
      var ov = looks[tb.id] || {};
      if (ov.icon) tb.icon = ov.icon;
      var own = ov.image !== undefined;
      var img = own ? ov.image : it.image;
      if (img) { tb.image = img; tb.focus = (own ? ov.focus : it.focus) || 'center'; }
      return tb;
    }
    // The description is translatable under nav.desc.<group label | view | table>; the authored text is
    // the fallback, since t() answers an untranslated key with the key itself.
    function describe(tb, it, key) {
      var k = 'nav.desc.' + key, d = t(k);
      if (!d || d === k) d = it.description;
      if (d) tb.description = d;
      return tb;
    }
    function withKids(tb, it, kids) {
      if (!kids.length) return tb;
      tb.children = kids;
      tb.display = it.display || opts.display || 'list';
      return tb;
    }
    function node(it) {
      // `adminOnly` hides an entry (a group and everything under it, or a single view/table) from
      // non-admins; `hideFromAdmin` is its mirror, for the views that are about being a PARTICIPANT —
      // "my chores", "my rewards" — which an admin who only approves is not. Both are TIDINESS, not
      // access control: what a member may read or write is decided by their table grants, and these only
      // keep the wrong menu out of the wrong hands. Put either on a group to hide the whole branch.
      if (it.adminOnly && !opts.isAdmin) return null;
      if (it.hideFromAdmin && opts.isAdmin) return null;
      if (it.group) {
        var ch = (it.items || []).map(node).filter(Boolean);
        return ch.length ? withKids(look(describe({ id: 'grp:' + it.group, title: t('nav.' + it.group) || it.group, icon: it.icon || 'mdi-folder' }, it, it.group), it), it, ch) : null;
      }
      var gid = it.view || it.table;
      if (!gid || !canAccess(gid)) return null;
      if (it.view && !views[gid]) return null;
      if (it.table && !schema[gid]) return null;
      var isV = !!it.view, isDoc = isV && typeof views[gid].markdown === 'string';
      var isRot = isV && !!views[gid].rotation;
      var tb = { id: gid, title: t((isV ? 'view.' : 'tab.') + gid) || gid, icon: it.icon || (isDoc ? 'mdi-file-document-outline' : (isRot ? 'mdi-calendar-clock' : (isV ? 'mdi-view-list' : 'mdi-table'))) };
      return withKids(look(describe(tb, it, gid), it), it, (it.items || []).map(node).filter(Boolean));
    }
    var tabs = [];
    (navItems || []).forEach(function(it) { var tb = node(it); if (tb) tabs.push(tb); });
    tabs.push({ divider: true });
    if (opts.isAdmin) tabs.push({ id: '__languages', title: t('tab.languages'), icon: 'mdi-translate' });
    if (opts.hasLookup) tabs.push({ id: '__lookup', title: t('tab.lookup'), icon: 'mdi-database-outline' });
    tabs.push({ id: '__settings', title: t('tab.settings'), icon: 'mdi-cog-outline' });
    return tabs;
  }

  // The nav's own rules — the ones that need no schema to check. validateRefs adds the ones that do
  // (an entry naming a view or table that does not exist).
  var DISPLAYS = ['list', 'tiles'];
  // Which part of an image a 16:9 tile keeps when it crops.
  var FOCUS = ['top', 'center', 'bottom'];
  function errors(nav) {
    var errs = [], groups = {};
    if (nav && nav.display !== undefined && DISPLAYS.indexOf(nav.display) < 0) errs.push('Nav -> `display` must be "list" or "tiles" (got ' + JSON.stringify(nav.display) + ')');
    (function walk(items) { (items || []).forEach(function(it) {
      if (!it) return;
      // A truthy non-boolean (e.g. "admin") would hide the entry too, but silently reads as a role name
      // rather than the flag it is — say so rather than let it look like it does something finer.
      if (it.adminOnly !== undefined && typeof it.adminOnly !== 'boolean') errs.push('Nav -> `adminOnly` must be true or false (got ' + JSON.stringify(it.adminOnly) + ')');
      if (it.hideFromAdmin !== undefined && typeof it.hideFromAdmin !== 'boolean') errs.push('Nav -> `hideFromAdmin` must be true or false (got ' + JSON.stringify(it.hideFromAdmin) + ')');
      // Both together hides the entry from EVERYONE, which is never what anyone means by writing them.
      if (it.adminOnly && it.hideFromAdmin) errs.push('Nav -> "' + (it.view || it.table || it.group) + '" sets both `adminOnly` and `hideFromAdmin`, which hides it from every user');
      if (it.display !== undefined && DISPLAYS.indexOf(it.display) < 0) errs.push('Nav -> "' + (it.view || it.table || it.group) + '": `display` must be "list" or "tiles" (got ' + JSON.stringify(it.display) + ')');
      if (it.description !== undefined && typeof it.description !== 'string') errs.push('Nav -> "' + (it.view || it.table || it.group) + '": `description` must be text');
      if (it.image !== undefined && typeof it.image !== 'string') errs.push('Nav -> "' + (it.view || it.table || it.group) + '": `image` must be text (an https URL or "asset:<id>")');
      if (it.focus !== undefined && FOCUS.indexOf(it.focus) < 0) errs.push('Nav -> "' + (it.view || it.table || it.group) + '": `focus` must be "top", "center" or "bottom"');
      // A group's id IS its label ('grp:' + label), and so is its translation key (nav.<label>), so two
      // groups with one label are one screen in the address bar and one title in every language.
      if (it.group) {
        if (groups[it.group]) errs.push('Nav -> two groups are labelled "' + it.group + '"; a group label names its page and its translation, so each must be unique');
        groups[it.group] = true;
      }
      walk(it.items);
    }); })(nav && nav.items);
    return errs;
  }

  // The translation keys the nav asks for: a group's label (nav.<label>) and every description
  // (nav.desc.<group label | view | table>). Offered by the Languages editor like view.* and tab.*.
  function translationKeys(nav) {
    var keys = [];
    (function walk(items) { (items || []).forEach(function(it) {
      if (!it) return;
      if (it.group) keys.push('nav.' + it.group);
      var key = it.group || it.view || it.table;
      if (key && it.description) keys.push('nav.desc.' + key);
      walk(it.items);
    }); })(nav && nav.items);
    return keys;
  }

  // Every node, depth-first, parents before their children; dividers dropped. Groups are included:
  // a caller that wants only openable screens filters them itself.
  function flatten(tabs) {
    var out = [];
    (function walk(list) { (list || []).forEach(function(n) { if (!n || n.divider) return; out.push(n); walk(n.children); }); })(tabs);
    return out;
  }

  // { node, path } for the FIRST node with this id — `path` is its ancestors from the root, the
  // breadcrumb — or null. Searches the tree it is given, so a tree built for this user never finds a
  // node this user cannot reach, and a deep link to one resolves to nothing.
  function find(tabs, id) {
    if (!id) return null;
    var hit = null;
    (function walk(list, path) {
      (list || []).some(function(n) {
        if (!n || n.divider) return false;
        if (n.id === id) { hit = { node: n, path: path }; return true; }
        walk(n.children, path.concat(n));
        return !!hit;
      });
    })(tabs, []);
    return hit;
  }

  var M = { FOCUS: FOCUS, build: build, errors: errors, translationKeys: translationKeys, flatten: flatten, find: find };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Nav = M;
})(typeof self !== 'undefined' ? self : this);
