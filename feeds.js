// feeds.js — which calendar views are published as subscribable .ics files, and what invalidates one.
// Framework-agnostic + Node-tested, mirroring events.js / ics.js.
//   Browser: <script src="/feeds.js"> after calendar.js and access-features.js; exposes Feeds.*.
//   Node:    const Feeds = require('../feeds').
//
// A feed is a calendar view with `feed: true`. The app renders its .ics and uploads it to the backend's
// blob store at a STABLE path; the object's public URL is the subscription. Delivery is the backend's
// `uploadFile`, which already exists for image columns — see ROADMAP "Four ways to deliver the file".
//
// The one piece of real logic here is `forTable`: which feeds a write to a given table invalidates. Get
// it wrong in the missing direction and a feed is stale forever with nothing to notice, since nobody
// looks at an .ics until it is already wrong on their phone. So it asks the SAME resolvers the calendar
// itself renders through rather than re-deriving the source list.
(function(root) {
  var isNode = typeof module !== 'undefined' && module.exports;
  var Calendar = isNode ? require('./calendar') : root.Calendar;
  var AccessFeatures = isNode ? require('./access-features') : root.AccessFeatures;

  function isFeed(v) { return !!(v && v.calendar && v.feed); }

  // Every view published as a feed.
  function names(views) {
    return Object.keys(views || {}).filter(function(n) { return isFeed(views[n]); });
  }

  // The tables whose rows can change what a feed contains: its calendar sources, plus the ROSTERS behind
  // any rotation overlaid on it. The rosters are the ones easy to forget -- a duty overlay's content
  // lives in a lookup table the calendar never names directly, so editing the roster changes the feed
  // while the calendar's own `sources` are untouched.
  function tablesOf(views, name) {
    var v = (views || {})[name];
    if (!isFeed(v)) return [];
    var out = [], seen = {};
    var add = function(t) { if (t && !seen[t]) { seen[t] = 1; out.push(t); } };
    Calendar.sources(views, name).forEach(function(s) { add(s && s.table); });
    Calendar.rotationSources(views, name).forEach(function(rs) {
      var rv = views[rs.view];
      if (rv) AccessFeatures.viewRosters(rv).forEach(add);
    });
    return out;
  }

  // Which feeds a write to `tableId` invalidates. The republish trigger reads this.
  function forTable(views, tableId) {
    if (!tableId) return [];
    return names(views).filter(function(n) { return tablesOf(views, n).indexOf(tableId) >= 0; });
  }

  // The storage path a feed's file lives at. STABLE across republishes -- the whole point of a
  // subscription is that the URL does not move -- and unguessable, because a public bucket's URL shape
  // is predictable and the path is therefore the only thing standing between the calendar and anyone
  // who tries. `id` is minted once per feed and kept in the folder config.
  function pathFor(id) { return 'feeds/' + String(id) + '.ics'; }

  // A url-safe random id, long enough that guessing is not a strategy. Uses the platform CSPRNG; there
  // is no Math.random fallback, because a predictable id here is a readable calendar and failing loudly
  // is the only safe answer.
  function newId(crypto) {
    var c = crypto || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!c || !c.getRandomValues) throw new Error('feeds: no CSPRNG available');
    var b = new Uint8Array(16), out = '';
    c.getRandomValues(b);
    for (var i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
    return out;
  }

  var M = { isFeed: isFeed, names: names, tablesOf: tablesOf, forTable: forTable, pathFor: pathFor, newId: newId };
  if (isNode) module.exports = M;
  else root.Feeds = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
