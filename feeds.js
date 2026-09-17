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
  var Rows = isNode ? require('./rows') : root.Rows;

  // Which KIND of feed a view declares. `true` and "shared" are one file every subscriber fetches;
  // "per-person" is one file each, filtered to that subscriber.
  //
  // An unrecognised value is NOT a feed. A typo ("per-pesron") could plausibly resolve either way, and
  // the two directions fail very differently: treated as shared it would publish an @me calendar
  // rendered against whoever pressed publish and serve it to everyone, while treating it as nothing
  // publishes nothing and `configErrors` says why. So the allowlist is explicit rather than a
  // truthiness test, and everything outside it falls out of the feature entirely.
  function modeOf(v) {
    if (!v || !v.calendar) return '';
    var f = v.feed;
    if (f === true || f === 'shared') return 'shared';
    if (f === 'per-person') return 'per-person';
    return '';
  }

  // isFeed is DERIVED from modeOf rather than testing `v.feed` itself, so "is this published" and "how
  // is it published" cannot drift apart -- a truthiness test here would answer yes for exactly the
  // unrecognised values modeOf refuses to publish.
  function isFeed(v) { return !!modeOf(v); }
  function isPerPerson(v) { return modeOf(v) === 'per-person'; }

  // Does a filter name @me anywhere? The condition may be a bare value or an operator object
  // ({ eq: "@me" }), so this serializes the whole condition rather than String()-ing it -- which for an
  // object is "[object Object]" and misses every non-bare spelling.
  function hasMe(filter) {
    var found = false;
    Rows.forEachCondCol(filter, function(col, cond) {
      if (JSON.stringify(cond === undefined ? null : cond).indexOf('@me') >= 0) found = true;
    });
    return found;
  }

  // Every view published as a feed.
  function names(views) {
    return Object.keys(views || {}).filter(function(n) { return isFeed(views[n]); });
  }

  // The tables whose rows a CALENDAR reads: its sources, plus the rosters behind any rotation overlaid
  // on it. The rosters are the ones easy to forget -- a duty overlay's content lives in a lookup table
  // the calendar never names directly, so editing the roster changes what the calendar says while its
  // own `sources` are untouched.
  //
  // Not gated on `feed`. It answers a question three callers have -- what to preload when the view
  // opens, what to wait for before writing a FILE from it, and what invalidates a published feed -- and
  // those were three separate answers until they disagreed: the export waited on a helper that returns
  // nothing for a calendar, so it waited for nothing and wrote an empty file.
  function tablesOf(views, name) {
    var v = (views || {})[name];
    if (!v || !v.calendar) return [];
    var out = [], seen = {};
    var add = function(t) { if (t && !seen[t]) { seen[t] = 1; out.push(t); } };
    Calendar.sources(views, name).forEach(function(s) { add(s && s.table); });
    Calendar.rotationSources(views, name).forEach(function(rs) {
      var rv = views[rs.view];
      // rotationTables, not viewRosters: the wider set, matching what a calendar preloads. viewRosters
      // is the GRANTABLE subset, which is a different question.
      if (rv) AccessFeatures.rotationTables(rv).forEach(add);
    });
    return out;
  }

  // Which feeds a write to `tableId` invalidates. The republish trigger reads this.
  function forTable(views, tableId) {
    if (!tableId) return [];
    return names(views).filter(function(n) { return tablesOf(views, n).indexOf(tableId) >= 0; });
  }

  // What is wrong with a view's `feed` declaration. Owned here rather than by validateSchema for the
  // reason Scan.configErrors is: the module that READS a config reports what is wrong with it, which is
  // what makes this a Node-tested property rather than an error string nobody executes.
  //
  // The two modes are checked in OPPOSITE directions, and that inversion is the whole point of this
  // function. A shared feed refuses @me, because a file served to everyone has no viewer to resolve
  // "me" against and would carry whoever pressed publish. A per-person feed REQUIRES it on every
  // source, because a source without it contributes its rows unfiltered -- and unlike the shared case
  // that is not a visibly wrong calendar, it is a correct-looking one with somebody else's rows in it.
  //
  // Why per SOURCE and not per view: events.js filters a calendar's rows through `s.filter` only
  // (rowEvents), never through `view.filter`. A view-level @me on a calendar therefore filters NOTHING,
  // so accepting one here would be accepting a guard that does not run.
  function configErrors(views, name, view) {
    var errors = [], f = view && view.feed, at = 'view "' + name + '": ';
    if (f === undefined || f === null || f === false) return errors;
    if (!view.calendar) {
      errors.push(at + '`feed` publishes a calendar as .ics, and this view is not a calendar');
      return errors;
    }
    var mode = modeOf(view);
    if (!mode) {
      errors.push(at + '`feed` must be true, "shared" or "per-person" — ' + JSON.stringify(f) +
                  ' is not one of those, and an unrecognised value publishes nothing at all');
      return errors;
    }
    var srcs = Calendar.sources(views, name) || [];
    var rots = Calendar.rotationSources(views, name) || [];

    if (mode === 'shared') {
      if (view.mineOnly) errors.push(at + '`feed` cannot be combined with `mineOnly` — a published file has no viewer to resolve "me" against (use `feed: "per-person"`)');
      var meFound = hasMe(view.filter) || srcs.some(function(s) { return hasMe(s && s.filter); });
      if (meFound) errors.push(at + '`feed` cannot be combined with an `@me` filter — a published file is served to everyone, so it would carry whoever published it (use `feed: "per-person"`)');
      return errors;
    }

    // per-person. Every way rows reach this calendar has to narrow to the subscriber, so each is named
    // individually: "one of your sources is unfiltered" is not actionable when a calendar has four.
    if (!srcs.length && !rots.length) {
      errors.push(at + '`feed: "per-person"` has nothing to filter — the calendar has no sources');
      return errors;
    }
    srcs.forEach(function(s, i) {
      if (!s || hasMe(s.filter)) return;
      errors.push(at + '`feed: "per-person"` needs an `@me` filter on every source, and source ' + (i + 1) +
                  ' ("' + ((s && s.table) || '?') + '") has none — it would put its rows in every subscriber\'s file');
    });
    // A rotation overlay narrows through the MATRIX's own `mineOnly`, not through a filter, so it is
    // checked against the rotation view rather than against the source entry that names it.
    rots.forEach(function(rs) {
      var rv = (views || {})[rs && rs.view];
      if (!rv) return;                       // a missing rotation view is already an error elsewhere
      if (!rv.mineOnly) errors.push(at + '`feed: "per-person"` overlays rotation "' + rs.view +
                                    '", which is not `mineOnly` — it would draw every slot\'s duties into every subscriber\'s file');
    });
    return errors;
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

  var M = { isFeed: isFeed, isPerPerson: isPerPerson, modeOf: modeOf, hasMe: hasMe, configErrors: configErrors,
            names: names, tablesOf: tablesOf, forTable: forTable, pathFor: pathFor, newId: newId };
  if (isNode) module.exports = M;
  else root.Feeds = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
