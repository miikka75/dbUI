// ics.js — iCalendar (RFC 5545) serialization of a calendar view's events.
// Framework-agnostic and Node-tested, mirroring pivot.js / events.js / print.js.
//   Browser: <script src="/ics.js">; exposes Ics.*.  Node: const Ics = require('../ics').
//
// Pure over the map events.js already builds -- { 'YYYY-MM-DD': [event] } -- so it serializes exactly
// what the screen shows, including the rotation overlay's generated duties, and inherits the per-source
// access gating that map was built under. There is no ctx: the events arrive resolved, and a date has
// no i18n.
//
// This is the half of "calendar export" that every version needs. A downloaded file and a subscribable
// URL differ in how the text is DELIVERED, not in the text, so this module is deliberately ignorant of
// both -- it takes events and returns a document.
//
// Three details in RFC 5545 that are easy to get wrong and are the reason this is a tested module
// rather than a template string:
//   * All-day events are DTSTART;VALUE=DATE with a NON-INCLUSIVE DTEND of the next day. Omitting DTEND
//     or making it the same day renders a zero-length event that some clients hide entirely.
//   * Content lines are folded at 75 OCTETS, not characters, and a fold must never split a UTF-8
//     sequence -- so the fold walks code points and counts their encoded length.
//   * TEXT values escape backslash, semicolon, comma and newline. Colon is NOT escaped (it is only
//     special in the property name/value separator, which is not part of the value).
(function(root) {
  var CRLF = '\r\n';

  // RFC 5545 3.3.11: escape \ ; , and newline. Order matters -- backslash first, or the escapes we add
  // get escaped again.
  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n/g, '\\n');
  }

  // Encoded length of one code point, so folding can count octets without a Buffer/TextEncoder (this
  // runs in the browser too).
  function octets(cp) { return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }

  // Fold a content line to <=75 octets per physical line; continuations begin with one space, which
  // counts toward the 75. Splitting is on code-point boundaries: a surrogate pair is one code point and
  // is never divided, so no client ever receives half a character.
  function fold(line) {
    var out = [], cur = '', len = 0, limit = 75;
    for (var i = 0; i < line.length; ) {
      var cp = line.codePointAt(i);
      var ch = String.fromCodePoint(cp);
      i += ch.length;
      var n = octets(cp);
      if (len + n > limit) { out.push(cur); cur = ' '; len = 1; limit = 75; }
      cur += ch; len += n;
    }
    out.push(cur);
    return out.join(CRLF);
  }

  // 'YYYY-MM-DD' -> 'YYYYMMDD' (the DATE value form).
  function dateVal(d) { return String(d).replace(/-/g, ''); }

  // The day AFTER `d`, as a DATE value. All-day DTEND is exclusive, so a one-day event ends tomorrow.
  function nextDay(d) {
    var p = String(d).split('-');
    var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1);
    return dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, '0') + String(dt.getDate()).padStart(2, '0');
  }

  // UTC timestamp form, for DTSTAMP. Accepts a Date, an ISO string, or a ready-made value.
  function stamp(v) {
    if (typeof v === 'string' && /^\d{8}T\d{6}Z$/.test(v)) return v;
    var d = (v instanceof Date) ? v : (v ? new Date(v) : new Date());
    return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0')
         + 'T' + String(d.getUTCHours()).padStart(2, '0') + String(d.getUTCMinutes()).padStart(2, '0')
         + String(d.getUTCSeconds()).padStart(2, '0') + 'Z';
  }

  // A UID must be globally unique and STABLE across regenerations -- a changed UID is a different event
  // to every client, so an unstable one makes each refresh delete and re-add the whole calendar.
  // events.js already assigns each event a within-database identity (table:col:rowid, or
  // rot:view:slot:period); the domain makes it global.
  function uid(ev, domain) {
    return String(ev.id).replace(/[\s@]+/g, '_') + '@' + (domain || 'dbui.local');
  }

  // One VEVENT. All-day by construction: the app's calendar places rows on a DAY, and no source carries
  // a time of day, so inventing one (or a timezone to interpret it in) would be fabricating precision
  // the data does not have.
  function event(date, ev, meta) {
    var lines = [
      'BEGIN:VEVENT',
      'UID:' + uid(ev, meta.domain),
      'DTSTAMP:' + meta.dtstamp,
      'DTSTART;VALUE=DATE:' + dateVal(date),
      'DTEND;VALUE=DATE:' + nextDay(date),
      'SUMMARY:' + escapeText(ev.title || ev.label || '')
    ];
    // The source tag (a table's tab label, a roster's name) as a category -- clients group and colour on
    // it, which is the same thing the on-screen chip colour conveys.
    if (ev.label) lines.push('CATEGORIES:' + escapeText(ev.label));
    // A generated duty is not an editable row anywhere; saying so keeps a client from offering to.
    if (ev.readOnly) lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
    return lines;
  }

  // Serialize an events map to a VCALENDAR document.
  //   meta = { name, domain, prodId, dtstamp }  -- all optional; dtstamp is fixed for reproducible tests.
  // Undated rows are DROPPED, and that is the only data loss: '__undated__' is the bucket events.js uses
  // for a row whose date column is empty, and an event with no date is not expressible in iCalendar.
  // They stay visible in the app's own undated strip.
  function build(eventsByDate, meta) {
    var m = meta || {};
    var ctx = { domain: m.domain, dtstamp: stamp(m.dtstamp) };
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:' + (m.prodId || '-//dbUI//Calendar//EN'),
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH'
    ];
    // X-WR-CALNAME is not in RFC 5545, but it is what every major client reads to name a subscribed
    // calendar; without it the calendar is named after its URL.
    if (m.name) lines.push('X-WR-CALNAME:' + escapeText(m.name));
    Object.keys(eventsByDate || {}).filter(function(d) { return d !== '__undated__'; }).sort()
      .forEach(function(d) {
        (eventsByDate[d] || []).forEach(function(ev) { lines = lines.concat(event(d, ev, ctx)); });
      });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join(CRLF) + CRLF;
  }

  var M = { build: build, escapeText: escapeText, fold: fold, uid: uid, nextDay: nextDay, stamp: stamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Ics = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
