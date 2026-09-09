// scan.js — Pure resolver for the `scan` view: one code somebody scanned or typed, turned into the row
// it should write. Framework-agnostic + Node-tested, like calendar/rotation/pivot/rsvp/form/board/stats.
//
//   Browser: <script src="/scan.js"> (after calendar.js), then Scan.plan(code, opts).
//   Node:    const Scan = require('../scan').
//
// WHY THIS IS NOT `checkin.js`, which the roadmap first proposed: a scan resolves a code to a WRITE.
// Whether that write APPENDS a row (a chore logged, a checkpoint visited, a control punched) or UPDATES
// one that already exists (an attendee marked present) is the only difference between the two
// arrangements, and it is a difference of configuration rather than of mechanism. This module owns the
// appending half; the updating half is a second branch over the same resolver.
//
// It answers only what is pure over data:
//   which catalogue row does this code name · have I logged it already · what columns does the row carry
// Performing the write stays in the root (_createBlankRow), exactly as it does for rsvp and form — so a
// scanned row is an ordinary row, with the owner stamp, the mirrors, the undo entry and the roster
// policy every other create gets.
//
// opts:
//   catalog    rows of the lookup table the scanned column references
//   rows       STORED rows of the target table — what `once` is checked against. Not the view's
//              filtered rows: a view showing this week must still refuse a code logged last week.
//   column     the column the resolved value is written to
//   codeCol    the catalogue column the code is matched against (default: valueCol)
//   valueCol   the catalogue column holding the value that `column` stores (default: 'id')
//   set        { column: literal | '@today' | '@now' } — the rest of the row
//   once       '' (append every time) | 'day' | 'ever'
//   me         the owner value identifying the current user; '' when signed out
//   ownerCol   owner column on the target rows (default 'owner')
//   today      'YYYY-MM-DD' in the caller's local time
//   now        an ISO timestamp
(function (root) {
  var isNode = (typeof module !== 'undefined' && module.exports);
  // toDateStr turns a stored ISO timestamp into a LOCAL date, which is the whole reason `once: "day"`
  // reads it rather than slicing the string: created_at is UTC, and a 03:00 scan east of Greenwich
  // belongs to the day the person thinks it is, not to the previous one.
  var Calendar = isNode ? require('./calendar') : root.Calendar;
  var Cols = function () { return isNode ? require('./columns') : root.Columns; };

  // A scanned code and a typed one must resolve identically, and neither is worth failing over
  // whitespace: a wedge scanner appends Enter and sometimes a stray carriage return, and somebody
  // typing `cp-07` means the label that reads `CP-07`. Case and surrounding space are not part of a code.
  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  // Every catalogue row this code names. Plural on purpose: two rows carrying one code is a broken
  // catalogue, and picking the first would silently log the wrong door.
  function matches(catalog, code, codeCol) {
    var want = norm(code), out = [];
    if (!want) return out;
    (catalog || []).forEach(function (r) { if (r && norm(r[codeCol]) === want) out.push(r); });
    return out;
  }

  // The two tokens a scan resolves itself. `@today` is the day the thing happened; `@now` is the moment,
  // and it is what makes a round legible — four controls sharing a date says nothing, four controls
  // sharing a minute says everything. Anything else is a literal, and an unknown `@word` is rejected at
  // load (validateSchema) rather than written through as text nobody meant.
  var TOKENS = ['@today', '@now'];
  function resolveSet(set, opts) {
    var out = {};
    for (var c in (set || {})) {
      var v = set[c];
      out[c] = v === '@today' ? (opts.today || '') : v === '@now' ? (opts.now || '') : v;
    }
    return out;
  }

  // Have I logged this code already, inside the window `once` names? Scoped to the OWNER: two guards
  // walking one route each record their own visit, while one person scanning a door twice records one.
  // A single-use TICKET wants the opposite scope — once per code, whoever presents it — which belongs
  // with the verifier arrangement and is not expressible here.
  //
  // Signed out matches NOTHING, deliberately, exactly as form.js's `mine` does: an owner column holds an
  // identity, and treating blank as one would hand an anonymous visitor somebody else's row.
  //
  // The day is taken from `created_at` rather than from the date column the scan stamps. That column is
  // what the row MEANS ("done on the 9th") and can be back-dated; created_at is when the scan happened,
  // which is the question `once` is asking. A row carrying no created_at (imported, or written by
  // something else) has no day and so never blocks a scan.
  function priorScan(rows, value, opts) {
    var once = opts.once || '', me = opts.me || '', ownerCol = opts.ownerCol || 'owner';
    if (!once || !me) return null;
    var found = null;
    (rows || []).forEach(function (r) {
      if (!r || r[ownerCol] !== me || r[opts.column] !== value) return;
      if (once === 'day' && Calendar.toDateStr(r.created_at || '') !== (opts.today || '')) return;
      // First wins: what the scanner needs on screen is when this was ALREADY logged, which is the
      // earliest one, not whichever happens to sort last.
      if (!found || String(r.created_at || '') < String(found.created_at || '')) found = r;
    });
    return found;
  }

  // One code -> one outcome. Every outcome is a value the view can render; none is an exception, because
  // a scanner standing at a door needs to be told which of these happened:
  //
  //   unknown    the code names no catalogue row — refuse, and write nothing
  //   ambiguous  it names several — refuse, because guessing writes the wrong row
  //   already    `once` says this is logged — refuse, and hand back the row holding the first time
  //   created    write `prefill` into the target table
  //
  // Silence is the one answer that must never happen: a scan that quietly does nothing is
  // indistinguishable from a scan that did not register, and that is how someone stops trusting it.
  function plan(code, opts) {
    opts = opts || {};
    var valueCol = opts.valueCol || 'id';
    var found = matches(opts.catalog, code, opts.codeCol || valueCol);
    var typed = String(code == null ? '' : code).trim();
    if (!found.length) return { outcome: 'unknown', code: typed };
    if (found.length > 1) return { outcome: 'ambiguous', code: typed };

    var value = found[0][valueCol];
    var prior = priorScan(opts.rows, value, opts);
    if (prior) return { outcome: 'already', code: typed, value: value, existing: prior };

    var prefill = resolveSet(opts.set, opts);
    prefill[opts.column] = value;   // last, so a `set` naming the scanned column cannot overwrite the scan
    return { outcome: 'created', code: typed, value: value, prefill: prefill };
  }

  // What a decoder handed back, reduced to a code. Two payload shapes reach this, and both are ours:
  //
  //   a 1D label   the code itself, as printed by the label sheet
  //   a QR         the deep link `…?view=<view>&scan=<code>`, which is what a QR generated for this app
  //                carries -- so photographing one INSIDE the app resolves it here rather than opening
  //                a second copy of the app to do the same write.
  //
  // Only the `scan` parameter is read; the rest of the URL is ignored, and nothing navigates. A payload
  // that is not one of ours comes back as itself and fails the catalogue match like any unknown code.
  function codeFrom(raw) {
    var v = String(raw == null ? '' : raw).trim();
    if (!/^https?:\/\//i.test(v)) return v;
    var q = v.indexOf('?');
    if (q < 0) return v;
    var found = '';
    v.slice(q + 1).split('#')[0].split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq) === 'scan') {
        try { found = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')); } catch (e) { found = pair.slice(eq + 1); }
      }
    });
    return found || v;
  }

  // ---- Code 39, the symbology the printed sheet uses ---------------------------------------------
  //
  // Chosen because it needs no library and no vendoring ceremony: 44 characters, each nine elements --
  // five bars and four spaces, exactly three of them wide, which is where "3 of 9" comes from -- drawn
  // as rectangles. Every handheld wedge scanner and every phone decoder reads it. QR is denser and more
  // robust, and needs a real encoder; that is phase 3's cost, not this one's.
  //
  // Standard Code 39 has NO LOWERCASE, so a label is printed uppercase. That costs nothing here,
  // because `norm` lowercases both sides of a match: a label reading DISHES resolves the catalogue
  // value "Dishes". A code carrying anything outside the 43 data characters cannot be printed at all,
  // and says so on the sheet rather than coming out as a barcode that scans to something else.
  var C39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
    'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
    'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
    'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'   // '*' delimits, never data
  };
  // 3:1 is the tolerant end of the standard's 2:1..3:1 range, which is what an office printer and a
  // scuffed label need. Units are narrow modules; the caller scales.
  var NARROW = 1, WIDE = 3;

  // A code as bar geometry: { text, bars: [{x, w}], width } in narrow modules, or NULL when the text
  // cannot be encoded. Null is the answer the sheet prints a warning for -- a row that silently lost its
  // barcode is a door nobody can scan and nobody knows about.
  function code39(text) {
    var up = String(text == null ? '' : text).trim().toUpperCase();
    if (!up) return null;
    for (var i = 0; i < up.length; i++) {
      var ch = up.charAt(i);
      if (ch === '*' || !C39[ch]) return null;
    }
    var chars = ('*' + up + '*').split(''), bars = [], x = 0;
    chars.forEach(function (ch, ci) {
      var pat = C39[ch];
      for (var j = 0; j < 9; j++) {
        var w = pat.charAt(j) === 'w' ? WIDE : NARROW;
        if (j % 2 === 0) bars.push({ x: x, w: w });   // even element = bar, odd = space
        x += w;
      }
      if (ci < chars.length - 1) x += NARROW;         // one narrow space between characters
    });
    return { text: up, bars: bars, width: x };
  }

  // Which scan views resolve their codes against this lookup table. The catalogue does not know it is
  // scannable -- a `ref` column points AT it, not the other way round -- so this walks the views to
  // answer "are there codes worth printing for these rows, and where would scanning one write?".
  //
  // The label sheet needs a view because the QR carries a deep link, and a link names a destination.
  // Several views over one catalogue is legitimate (the same route, logged two different ways), so this
  // returns them all and the caller decides; it does not pick.
  function viewsForCatalog(schema, views, table) {
    var out = [];
    if (!table) return out;
    for (var name in (views || {})) {
      var v = views[name];
      var cfg = v && v.scan;
      if (!cfg || !cfg.column) continue;
      var src = (v.sources || [])[0];
      var defs = (schema[src] && schema[src].columns) || {};
      var d = defs[cfg.column];
      if (d && typeof d === 'object' && d.type === 'ref' && d.table === table) out.push(name);
    }
    return out;
  }

  // Every way a `scan` view can be misconfigured, as load-time errors — the shape belongs to this module,
  // so its errors do too, exactly as `Columns.vocabularyErrors` owns a table's vocabulary and hands
  // validateSchema a list. Called once per view; a view with no `scan` object returns nothing.
  //
  // The last check is the one no other kind has to make. A scan view over a table the member may not
  // write RENDERS perfectly and then refuses at the rules layer, silently, with nothing on the page to
  // point at — so the mismatch has to be caught where a schema is loaded rather than where a scan fails.
  function configErrors(schema, name, view) {
    var errors = [], sc = view && view.scan;
    if (!sc) return errors;
    var at = 'scan "' + name + '": ';
    var srcs = view.sources || [], table = srcs[0];
    var defs = (schema[table] && schema[table].columns) || {};
    if (!srcs.length) errors.push(at + 'needs `sources` naming the ONE table the scan writes to');
    else if (srcs.length > 1) errors.push(at + 'writes one table, so `sources` takes one name (got ' + srcs.length + ': ' + srcs.join(', ') + ')');

    // The scanned column has to be a `ref`: the catalogue it points at is what a code is checked
    // against, and a scan that writes unrecognised text into a free column is exactly the untrustworthy
    // log this kind exists to avoid.
    var ref = null;
    if (!sc.column) errors.push(at + 'needs `column` — the column a scanned code resolves into');
    else if (schema[table] && !defs[sc.column]) errors.push(at + '`column` "' + sc.column + '" is not a column of "' + table + '"');
    else if (schema[table]) {
      var d = defs[sc.column];
      if (!d || typeof d !== 'object' || d.type !== 'ref' || !d.table) errors.push(at + '`column` "' + sc.column + '" must be a `ref` column — a code is resolved against the lookup table it points at, and there is nothing to check it against otherwise');
      else if (!schema[d.table]) errors.push(at + '`column` "' + sc.column + '" references non-existent lookup table "' + d.table + '"');
      else ref = d;
    }
    // `codeCol` is what the label carries when that is not the value the row stores — an EAN, a badge
    // number, a stamped control id. It names a column of the LOOKUP, not of the log.
    if (sc.codeCol && ref && !((schema[ref.table] && schema[ref.table].columns) || {})[sc.codeCol]) {
      errors.push(at + '`codeCol` "' + sc.codeCol + '" is not a column of the lookup table "' + ref.table + '"');
    }

    var setOk = sc.set && typeof sc.set === 'object' && !Array.isArray(sc.set);
    if (sc.set !== undefined && !setOk) errors.push(at + '`set` must be an object like { "done_on": "@today" }');
    var set = setOk ? sc.set : {};
    for (var k in set) {
      if (schema[table] && !defs[k]) errors.push(at + '`set` column "' + k + '" is not a column of "' + table + '"');
      if (k === sc.column) errors.push(at + '`set` names "' + k + '", which is the scanned column — the scanned value always wins, so this could never take effect');
      // An unrecognised @token would be written through as literal text, and read as bad data long
      // after the typo. There are exactly two, and both are resolved at scan time.
      var val = set[k];
      if (typeof val === 'string' && val.charAt(0) === '@' && TOKENS.indexOf(val) < 0) {
        errors.push(at + '`set.' + k + '` is "' + val + '" — the only tokens are ' + TOKENS.join(' and ') + ' (anything else is written literally)');
      }
    }
    if (sc.once !== undefined && sc.once !== 'day' && sc.once !== 'ever') {
      errors.push(at + '`once` is "' + sc.once + '" — use "day" (one scan per code per day) or "ever", or omit it to append every time');
    }
    // What a `?scan=` deep link does when it arrives. "arm" (the default) puts the code in the box and
    // waits for a press; "submit" logs it outright. The default is the cautious one because a link is
    // something anyone can send you, and under "submit" a link somebody else wrote records a row as
    // you. That is a household chore in one deployment and a falsified patrol round in another, which
    // is why this is a per-view decision and not one answer baked in.
    if (sc.link !== undefined && sc.link !== 'arm' && sc.link !== 'submit') {
      errors.push(at + '`link` is "' + sc.link + '" — use "submit" (a deep-linked code logs itself) or "arm" (the default: it waits for a press)');
    }

    // A scan writes an owner-stamped row through the self-service path, which both rules layers gate on
    // the table having an `owner` column and on `ownerWritable` naming every column the write carries:
    // a column left out of that list is `locked` to its declared default, so the create is refused whole
    // rather than trimmed. A table declaring no `ownerWritable` at all has no gate, and needs no listing.
    if (schema[table]) {
      if (!Cols().tableOwnerCol(schema, table)) errors.push(at + 'table "' + table + '" has no `owner` column, so a scanned row would belong to nobody and the self-service write layers will refuse it');
      var ow = schema[table].ownerWritable;
      if (Array.isArray(ow)) {
        [sc.column].concat(Object.keys(set)).forEach(function (col) {
          if (col && defs[col] && ow.indexOf(col) < 0) errors.push(at + '"' + col + '" is written by the scan but missing from "' + table + '".ownerWritable, so the write layers would refuse the row');
        });
      }
    }
    return errors;
  }

  var M = { plan: plan, matches: matches, resolveSet: resolveSet, priorScan: priorScan, configErrors: configErrors,
            code39: code39, C39: C39, codeFrom: codeFrom, viewsForCatalog: viewsForCatalog, TOKENS: TOKENS };
  if (isNode) module.exports = M;
  else root.Scan = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
