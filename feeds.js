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
  function configErrors(views, name, view, schema) {
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
    return errors.concat(subscriberErrors(schema, name, view));
  }

  // The subscriber table a per-person feed renders for. Checked here rather than left to the rules
  // layer because every failure below is silent at runtime: a feed with nowhere to read subscribers
  // publishes nothing and says nothing, and a table whose url column the owner may write hands each
  // subscriber the ability to mint a link that revocation cannot reach.
  function subscriberErrors(schema, name, view) {
    var errors = [], at = 'view "' + name + '": ', cfg = view.feedSubscribers;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
      errors.push(at + '`feed: "per-person"` needs `feedSubscribers` naming the table people subscribe in — without one there is nobody to render for');
      return errors;
    }
    if (!cfg.table) { errors.push(at + '`feedSubscribers` needs a `table`'); return errors; }
    var t = (schema || {})[cfg.table];
    if (!t) { errors.push(at + '`feedSubscribers.table` "' + cfg.table + '" is not a table'); return errors; }
    var defs = t.columns || {};
    var typeOf = function(c) { var d = defs[c]; return (d && typeof d === 'object') ? d.type : d; };

    // The owner column is the whole access story: it is what stamps a row with its creator and what
    // restricts reading it back to them.
    var ownerCol = cfg.ownerColumn || 'owner';
    if (!defs[ownerCol]) errors.push(at + '`feedSubscribers` table "' + cfg.table + '" has no "' + ownerCol + '" column — a subscription has to be owner-stamped to be the subscriber\'s own');
    else if (typeOf(ownerCol) !== 'owner') errors.push(at + '`feedSubscribers` column "' + ownerCol + '" must be an `owner` column (it is "' + (typeOf(ownerCol) || 'text') + '") — nothing else stamps the caller or restricts the row to them');

    ['langColumn', 'viewColumn', 'urlColumn', 'activeColumn'].forEach(function(k) {
      if (cfg[k] && !defs[cfg[k]]) errors.push(at + '`feedSubscribers.' + k + '` "' + cfg[k] + '" is not a column of "' + cfg.table + '"');
    });
    if (!cfg.urlColumn) errors.push(at + '`feedSubscribers` needs a `urlColumn` — the subscriber has no other way to learn their own link, and it cannot be published anywhere shared');

    // The half that cannot be recovered from. A table with NO `ownerWritable` is not weakly gated, it
    // is ungated: the owner may write every column, including the one holding their own URL. Whoever
    // can set their own url column can point it at a path the publisher will never blank, so the link
    // outlives every revocation the feature offers.
    var ow = t.ownerWritable;
    if (!Array.isArray(ow)) {
      errors.push(at + '`feedSubscribers` table "' + cfg.table + '" declares no `ownerWritable`, which is not a weak gate but no gate — the subscriber could write every column, their own URL included');
    } else {
      [ownerCol, cfg.urlColumn].forEach(function(c) {
        if (c && ow.indexOf(c) >= 0) errors.push(at + '`ownerWritable` on "' + cfg.table + '" must not include "' + c + '" — a subscriber who can write it can mint a link that revoking the feed does not reach');
      });
      if (cfg.langColumn && ow.indexOf(cfg.langColumn) < 0) {
        errors.push(at + '`ownerWritable` on "' + cfg.table + '" should include "' + cfg.langColumn + '" — the language is the subscriber\'s own choice, and they cannot change it otherwise');
      }
      if (cfg.activeColumn && ow.indexOf(cfg.activeColumn) < 0) {
        errors.push(at + '`ownerWritable` on "' + cfg.table + '" should include "' + cfg.activeColumn + '" — unsubscribing is the subscriber\'s own decision, and they cannot make it otherwise');
      }
    }

    // The orphan guard, and the failure it prevents has no symptom at the moment it happens.
    //
    // A subscriber may delete their own self-service row (firestore.rules: the owner branch of `allow
    // delete`). Their url column is the ONLY record of where their file lives, and they cannot blank it
    // themselves because uploading needs full access. So an unguarded delete leaves a public file
    // frozen on its last snapshot that nothing can ever name again to revoke — "unsubscribed" reading
    // as success while the calendar stays online for good.
    //
    // `ownerWritableWhile` is the existing primitive that closes it: gating on the active column
    // freezes the row the moment they unsubscribe, and `ownerStateOk` governs their DELETE as well as
    // their edits, so the tombstone survives for the publisher to act on.
    if (cfg.urlColumn) {
      if (!cfg.activeColumn) {
        errors.push(at + '`feedSubscribers` needs an `activeColumn` — unsubscribing has to be a state the publisher can see and act on, because deleting the row destroys the only record of the file\'s path and leaves it public for ever');
      } else {
        var owWhile = t.ownerWritableWhile;
        if (!owWhile || typeof owWhile !== 'object') {
          errors.push(at + '`feedSubscribers` table "' + cfg.table + '" declares no `ownerWritableWhile`, so a subscriber may delete their own row — which strands their published file with nothing left that knows its path');
        } else if (!(cfg.activeColumn in owWhile)) {
          errors.push(at + '`ownerWritableWhile` on "' + cfg.table + '" must gate on "' + cfg.activeColumn + '" — that is what freezes the row once someone unsubscribes, so the publisher can still blank their file');
        }
      }
    }
    return errors;
  }

  // WHO a per-person feed is rendered for. Subscribing is a row the person creates for themselves in an
  // owner-stamped table, so the list is opt-in by construction: rendering one file per USER would
  // publish a calendar for people who never asked and never look, and would make the cost scale with
  // headcount instead of with interest.
  //
  // The subscription URL lives in the ROW rather than in the folder config, and that is forced rather
  // than chosen. Folder config is readable by everyone with view access (`_saveFolderConfig`: "local
  // override for everyone with view access"), and a per-person URL is a bearer credential for ONE
  // person's calendar -- putting N of them there would hand every member everyone else's. An
  // owner-stamped row is already read-restricted to its owner, so the row is the only place that is
  // both readable by the subscriber and unreadable by the rest.
  //
  // Which means the row has two halves with different writers, exactly as `chore_log` does: the
  // subscriber owns the REQUEST (that they subscribe, and in which language), and the publisher owns
  // the GRANT (the minted id and the URL). `configErrors` is what holds that split, since a subscriber
  // who could write their own url column could mint a link nothing revokes.
  function subscribersOf(view, rows, name) {
    var cfg = (view && view.feedSubscribers) || null;
    if (!cfg || !isPerPerson(view)) return [];
    var ownerCol = cfg.ownerColumn || 'owner';
    var out = [], seen = {};
    (rows || []).forEach(function(r) {
      if (!r) return;
      // One table may serve several feeds; without a viewColumn it serves this one alone.
      if (cfg.viewColumn && String(r[cfg.viewColumn] || '') !== String(name || '')) return;
      var owner = String(r[ownerCol] || '').trim().toLowerCase();
      if (!owner) return;              // an unstamped row has nobody to render for
      if (seen[owner]) return;         // one file per person, whatever the rows say
      seen[owner] = 1;
      out.push({
        owner: owner,
        // Unsubscribing is a STATE CHANGE, not a deletion, and this flag is it. A subscriber cannot
        // blank their own file (uploading needs full access) and the row is the only record of the
        // file's path -- so deleting the row would strand a public file nothing can ever name again.
        // An inactive subscriber is therefore still listed here, because the publisher has work to do
        // for them: blank the file, then clear the url.
        active: !cfg.activeColumn || isActive(r[cfg.activeColumn]),
        // Blank, or a language the database no longer declares, falls back to the CALENDAR's language
        // -- resolved by the caller, which is the only layer that knows what a database declares. Never
        // to the session's, which is the rule publishFeed already follows so a subscriber's file does
        // not change language according to who edited a row last.
        lang: cfg.langColumn ? String(r[cfg.langColumn] || '') : '',
        url: cfg.urlColumn ? String(r[cfg.urlColumn] || '') : '',
        row: r
      });
    });
    return out.sort(function(a, b) { return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0; });
  }

  // What counts as still subscribed. Anything not recognisably a "no" is a yes, because the failure
  // directions are not equal: reading a yes as no stops somebody's calendar updating for a reason they
  // cannot see, while reading a no as yes leaves one extra file that the revocation pass then blanks.
  function isActive(v) {
    if (v === undefined || v === null || v === '') return true;
    var s = String(v).trim().toLowerCase();
    return !(s === 'no' || s === 'false' || s === 'off' || s === '0' || s === 'unsubscribed' || s === 'inactive');
  }

  // Subscribers whose file is still live but who have unsubscribed — the publisher's to-do list, and
  // the only thing standing between "I unsubscribed" and a public file nobody can reach any more.
  function pendingRevocation(view, rows, name) {
    return subscribersOf(view, rows, name).filter(function(s) { return !s.active && s.url; });
  }

  function subscriberTableOf(view) {
    var cfg = (view && view.feedSubscribers) || null;
    return (cfg && isPerPerson(view) && cfg.table) ? cfg.table : '';
  }

  // Which per-person feeds a write to the SUBSCRIBER table affects. Deliberately separate from
  // `forTable`, which answers "whose CONTENT changed": a subscriber table is not a source of any
  // calendar, so `forTable` returns nothing for it and a language change or a new subscription would
  // republish nothing at all -- the stale-forever failure that function exists to prevent, arriving
  // through a table it was never taught about.
  //
  // Kept apart rather than folded in because the two answers are acted on differently. A source write
  // invalidates every subscriber's file; a subscriber write invalidates ONE person's, and folding them
  // together would make somebody changing their language cost a full re-render for everyone.
  function forSubscriberTable(views, tableId) {
    if (!tableId) return [];
    return Object.keys(views || {}).filter(function(n) { return subscriberTableOf(views[n]) === tableId; });
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
            subscribersOf: subscribersOf, pendingRevocation: pendingRevocation, isActive: isActive,
            subscriberTableOf: subscriberTableOf, forSubscriberTable: forSubscriberTable,
            names: names, tablesOf: tablesOf, forTable: forTable, pathFor: pathFor, newId: newId };
  if (isNode) module.exports = M;
  else root.Feeds = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
