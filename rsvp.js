// rsvp.js — Pure builder for the self-service RSVP / signup view: given a list of events, everyone's
// response rows, and the current user (`me`), compute per-event { the user's own status, a tally of all
// responses }. The component renders each upcoming event with an inline status toggle bound to the
// user's own owner-stamped response row. Framework-agnostic + Node-tested, like calendar/rotation/pivot.
//   Browser: <script src="/rsvp.js">, then Rsvp.build(events, responses, opts). Node: require('../rsvp').
//
// opts:
//   me           current user's identity (the owner value to match/stamp — an email)
//   ownerCol     owner column in the response rows (default 'owner')
//   dateColumn   event date column: a `date` ('YYYY-MM-DD') or a `datetime` (an ISO instant), used for the
//                upcoming filter, 'today' and sort. A datetime counts on the LOCAL day it falls on.
//   eventKey     event column that responses link by (default = dateColumn — dates must be unique)
//   titleColumns event columns joined into the display title
//   linkColumn   response column holding the event key
//   statusColumn response column holding the status (a list value: coming/maybe/out)
//   today        'YYYY-MM-DD' — events with dateColumn < today are dropped unless upcoming === false
//   upcoming     default true (only future/today events); false = all
//   limit        max events after sorting (optional)
//   checkinColumn response column a member types the event's shared check-in code into (optional)
(function(root) {
  // The local day a date or datetime value falls on. A UTC instant's first ten characters are the UTC
  // day, which is the wrong day for an evening class east of Greenwich.
  function dayOf(v) {
    var s = String(v == null ? '' : v); if (s.length <= 10) return s;
    var d = new Date(s); if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
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
    if (opts.upcoming !== false && opts.today) list = list.filter(function(e) { return dayOf(e[dateCol]) >= opts.today; });
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
        myCode: mine && opts.checkinColumn ? (mine[opts.checkinColumn] || '') : '',
        isToday: !!opts.today && dayOf(e[dateCol]) === opts.today,
        tally: tally,
        total: responded.length,
        participants: participants
      };
    });

    return { events: out, statuses: statuses.sort() };
  }

  // ---- Self check-in with a shared code --------------------------------------------------------------
  //
  // A code shown at the event (on a slide, a poster) that attendees type on their own phones. The member
  // writes only their CLAIM, into a column of their own row that `ownerWritable` lets them write; the
  // VERDICT (`set`, e.g. attendance) stays out of their reach. The organizer then types the real code and
  // stamps every row whose claim matches it, which is one press for the whole room.
  //
  // The real code is stored nowhere. Kept on the event row, every member could read it from home, and the
  // only thing this arrangement buys is that being marked present takes being told the code.
  //
  // The code is the DAY's, not one event's: one scan claims every event the member reserved that day,
  // and one press stamps them all -- a gym's classes, where a member does several in a visit.
  //
  // Returns the rows to stamp: those of `eventKeys`, whose claim equals one of `codes` (case and
  // surrounding space ignored), and which do not already carry every value of `set`. Several codes,
  // because a rotating code also accepts the one before it.
  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
  function checkinTargets(responses, opts) {
    var want = (opts.codes || []).map(norm).filter(Boolean), set = opts.set || {}, cols = Object.keys(set);
    if (!want.length || !cols.length) return [];
    return (responses || []).filter(function(r) {
      if (!r || (opts.eventKeys || []).indexOf(r[opts.linkColumn]) < 0 || want.indexOf(norm(r[opts.checkinColumn])) < 0) return false;
      return !cols.every(function(c) { return String(r[c] == null ? '' : r[c]) === String(set[c]); });
    });
  }

  // A rotating check-in code (`checkin.rotateMinutes`): one character per random integer, from an alphabet
  // with no look-alikes (no 0/O, 1/I/L), since people also type it off the screen. The caller supplies
  // the integers -- crypto.getRandomValues in the browser -- so this stays pure.
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function checkinCode(ints) {
    return Array.prototype.map.call(ints || [], function(n) { return CODE_ALPHABET.charAt(n % CODE_ALPHABET.length); }).join('');
  }

  var M = { build: build, checkinTargets: checkinTargets, checkinCode: checkinCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Rsvp = M;
})(typeof self !== 'undefined' ? self : this);
