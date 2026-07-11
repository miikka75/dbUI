// rsvp.js — Pure builder for the self-service RSVP / signup view: given a list of events, everyone's
// response rows, and the current user (`me`), compute per-event { the user's own status, a tally of all
// responses }. The component renders each upcoming event with an inline status toggle bound to the
// user's own owner-stamped response row. Framework-agnostic + Node-tested, like calendar/rotation/pivot.
//   Browser: <script src="/rsvp.js">, then Rsvp.build(events, responses, opts). Node: require('../rsvp').
//
// opts:
//   me           current user's identity (the owner value to match/stamp — an email)
//   ownerCol     owner column in the response rows (default 'owner')
//   dateColumn   event date column ('YYYY-MM-DD' strings; used for upcoming filter + sort)
//   eventKey     event column that responses link by (default = dateColumn — dates must be unique)
//   titleColumns event columns joined into the display title
//   linkColumn   response column holding the event key
//   statusColumn response column holding the status (a list value: coming/maybe/out)
//   today        'YYYY-MM-DD' — events with dateColumn < today are dropped unless upcoming === false
//   upcoming     default true (only future/today events); false = all
//   limit        max events after sorting (optional)
(function(root) {
  function build(events, responses, opts) {
    events = events || []; responses = responses || [];
    var ownerCol = opts.ownerCol || 'owner';
    var dateCol = opts.dateColumn, key = opts.eventKey || dateCol;
    var linkCol = opts.linkColumn, statusCol = opts.statusColumn;
    var titleCols = opts.titleColumns || [];

    // Index responses by the event key, and note distinct statuses for a legend.
    var byEvent = {}, statusSeen = {}, statuses = [];
    responses.forEach(function(r) {
      var k = r[linkCol];
      (byEvent[k] || (byEvent[k] = [])).push(r);
      var s = r[statusCol];
      if (s != null && s !== '' && !statusSeen[s]) { statusSeen[s] = 1; statuses.push(s); }
    });

    var list = events.slice().sort(function(a, b) { return String(a[dateCol] || '').localeCompare(String(b[dateCol] || '')); });
    if (opts.upcoming !== false && opts.today) list = list.filter(function(e) { return String(e[dateCol] || '') >= opts.today; });
    if (opts.limit) list = list.slice(0, opts.limit);

    var out = list.map(function(e) {
      var k = e[key];
      var group = byEvent[k] || [];
      var mine = null;
      for (var i = 0; i < group.length; i++) { if (group[i][ownerCol] === opts.me) { mine = group[i]; break; } }
      // Only actual responses count — a row with an empty status (e.g. a vote in the middle of being
      // removed) is neither tallied nor shown in the roster.
      var responded = group.filter(function(r) { var s = r[statusCol]; return s != null && s !== ''; });
      var tally = {};
      responded.forEach(function(r) { tally[r[statusCol]] = (tally[r[statusCol]] || 0) + 1; });
      // The roster: who responded, and how. The caller only receives the responses the backend returned —
      // so with owner-scoped reads a non-organizer sees just their own row here; with a public roster,
      // everyone's. (Access is enforced server-side; this is only the display.)
      var participants = responded.map(function(r) { return { owner: r[ownerCol], status: r[statusCol] }; })
        .sort(function(a, b) { return String(a.status).localeCompare(String(b.status)) || String(a.owner).localeCompare(String(b.owner)); });
      return {
        id: e.id,
        key: k,
        date: e[dateCol],
        title: titleCols.map(function(c) { return e[c]; }).filter(function(v) { return v != null && v !== ''; }).join(' — '),
        myStatus: mine ? mine[statusCol] : '',
        myRowId: mine ? mine.id : null,
        tally: tally,
        total: responded.length,
        participants: participants
      };
    });

    return { events: out, statuses: statuses.sort() };
  }

  var M = { build: build };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Rsvp = M;
})(typeof self !== 'undefined' ? self : this);
