// ics.test.js — the iCalendar serializer.
//
// Worth testing at this tier because the failures are all silent-at-the-boundary: a client that cannot
// parse a folded line, or that treats an unstable UID as a new event, does not report an error. It
// shows the wrong calendar, or a duplicated one, on someone's phone.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ics = require('../../ics');
const Events = require('../../events');

const META = { name: 'Chores', domain: 'example.test', dtstamp: '20260901T120000Z' };
const lines = (s) => s.split('\r\n');
// Unfold the way a client does, so assertions can be made against logical content lines.
const unfold = (s) => s.replace(/\r\n /g, '');

describe('ics.js — document shape', () => {
  const doc = Ics.build({ '2026-07-06': [{ id: 'tasks:due:r1', title: 'Pay rent', label: 'Tasks' }] }, META);

  it('is a VCALENDAR with the required properties, CRLF-terminated', () => {
    const l = lines(doc);
    assert.equal(l[0], 'BEGIN:VCALENDAR');
    assert.ok(l.includes('VERSION:2.0'));
    assert.ok(l.includes('PRODID:-//dbUI//Calendar//EN'));
    assert.ok(l.includes('END:VCALENDAR'));
    assert.ok(doc.endsWith('\r\n'), 'the document ends with CRLF');
    assert.ok(!/[^\r]\n/.test(doc), 'every line break is CRLF, never a bare LF');
  });

  it('names the calendar so a subscription is not titled after its URL', () => {
    assert.ok(lines(doc).includes('X-WR-CALNAME:Chores'));
  });

  it('emits an all-day VEVENT whose DTEND is the NEXT day (non-inclusive)', () => {
    const l = lines(doc);
    assert.ok(l.includes('DTSTART;VALUE=DATE:20260706'));
    assert.ok(l.includes('DTEND;VALUE=DATE:20260707'), 'a same-day DTEND renders as a zero-length event');
    assert.ok(l.includes('SUMMARY:Pay rent'));
    assert.ok(l.includes('CATEGORIES:Tasks'));
  });

  it('carries a DTSTAMP, which RFC 5545 requires of a published VEVENT', () => {
    assert.ok(lines(doc).includes('DTSTAMP:20260901T120000Z'));
  });
});

describe('ics.js — escaping', () => {
  it('escapes backslash, semicolon, comma and newline; leaves the colon alone', () => {
    assert.equal(Ics.escapeText('a\\b;c,d\ne:f'), 'a\\\\b\\;c\\,d\\ne:f');
  });

  it('escapes the backslash FIRST, so an escape is not escaped twice', () => {
    // Naive ordering turns ';' into '\;' and then that backslash into '\\;', which a client renders
    // as a literal backslash followed by an unescaped separator.
    assert.equal(Ics.escapeText(';'), '\\;');
  });

  it('a title with a comma survives into the document intact', () => {
    const doc = Ics.build({ '2026-07-06': [{ id: 'x:y:1', title: 'Dishes, then bins' }] }, META);
    assert.ok(lines(doc).includes('SUMMARY:Dishes\\, then bins'));
  });

  it('empty and null values do not throw or emit "null"', () => {
    assert.equal(Ics.escapeText(null), '');
    assert.equal(Ics.escapeText(undefined), '');
  });
});

describe('ics.js — line folding', () => {
  it('leaves a short line alone', () => {
    assert.equal(Ics.fold('SUMMARY:short'), 'SUMMARY:short');
  });

  it('folds at 75 octets, continuing with a single leading space', () => {
    const folded = Ics.fold('SUMMARY:' + 'a'.repeat(200));
    const parts = folded.split('\r\n');
    assert.ok(parts.length > 1, 'it folded');
    parts.forEach((p) => assert.ok(Buffer.byteLength(p, 'utf8') <= 75, 'line is <=75 octets: ' + p.length));
    parts.slice(1).forEach((p) => assert.equal(p[0], ' ', 'continuation starts with a space'));
  });

  it('unfolds back to exactly the original', () => {
    const line = 'SUMMARY:' + 'x'.repeat(300);
    assert.equal(unfold(Ics.fold(line)), line);
  });

  it('counts OCTETS, not characters — a multi-byte line folds sooner', () => {
    // 'ä' is two octets. 40 of them plus the 8-octet name is 88 octets but only 48 characters, so a
    // character-counting fold would emit one over-long line and never notice.
    const folded = Ics.fold('SUMMARY:' + 'ä'.repeat(40));
    folded.split('\r\n').forEach((p) => assert.ok(Buffer.byteLength(p, 'utf8') <= 75, 'octet limit held'));
    assert.ok(folded.includes('\r\n'), 'it folded despite being under 75 characters');
  });

  it('never splits a multi-byte character or a surrogate pair', () => {
    for (const ch of ['ä', '€', '😀']) {
      const folded = Ics.fold('SUMMARY:' + ch.repeat(60));
      assert.equal(unfold(folded), 'SUMMARY:' + ch.repeat(60), ch + ' survived the fold');
      assert.ok(!folded.includes('�'), 'no replacement character appeared');
    }
  });
});

describe('ics.js — UIDs', () => {
  it('is stable across regenerations, so a refresh updates rather than duplicates', () => {
    const one = { '2026-07-06': [{ id: 'tasks:due:r1', title: 'A' }] };
    const two = { '2026-07-06': [{ id: 'tasks:due:r1', title: 'A renamed' }] };
    const uidOf = (d) => lines(Ics.build(d, META)).find((l) => l.startsWith('UID:'));
    assert.equal(uidOf(one), uidOf(two), 'the same row keeps its UID even when its title changes');
  });

  it('distinguishes two rows, and is domain-qualified', () => {
    const doc = Ics.build({ '2026-07-06': [{ id: 'tasks:due:r1', title: 'A' }, { id: 'tasks:due:r2', title: 'B' }] }, META);
    const uids = lines(doc).filter((l) => l.startsWith('UID:'));
    assert.equal(new Set(uids).size, 2);
    uids.forEach((u) => assert.ok(u.endsWith('@example.test')));
  });

  it('strips whitespace and stray @ so the UID cannot be malformed by data', () => {
    assert.equal(Ics.uid({ id: 'a b@c' }, 'x.test'), 'a_b_c@x.test');
  });
});

describe('ics.js — what it drops, and what it keeps', () => {
  it('DROPS undated rows: an event with no date is not expressible', () => {
    const doc = Ics.build({
      '2026-07-06': [{ id: 'a:b:1', title: 'Dated' }],
      '__undated__': [{ id: 'a:b:2', title: 'Someday' }]
    }, META);
    assert.ok(doc.includes('SUMMARY:Dated'));
    assert.ok(!doc.includes('Someday'), 'the undated bucket is not emitted');
    assert.equal(lines(doc).filter((l) => l === 'BEGIN:VEVENT').length, 1);
  });

  it('an empty calendar is still a valid document', () => {
    const doc = Ics.build({}, META);
    assert.ok(doc.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(doc.includes('END:VCALENDAR'));
    assert.ok(!doc.includes('BEGIN:VEVENT'));
  });

  it('emits days in date order regardless of the map\'s key order', () => {
    const doc = Ics.build({
      '2026-09-01': [{ id: 'a:b:2', title: 'Later' }],
      '2026-07-06': [{ id: 'a:b:1', title: 'Earlier' }]
    }, META);
    // Asserted on the DTSTART lines, not on a substring search of the document: DTSTAMP is itself a
    // date and matches first, which is exactly the false pass this phrasing avoids.
    const starts = lines(doc).filter((l) => l.startsWith('DTSTART'));
    assert.deepEqual(starts, ['DTSTART;VALUE=DATE:20260706', 'DTSTART;VALUE=DATE:20260901']);
  });

  it('marks a generated duty TRANSP:TRANSPARENT — it is not a row anyone can edit', () => {
    const doc = Ics.build({ '2026-07-06': [{ id: 'rot:duties:dishes:2026-07-06', title: 'Dishes: Ann', readOnly: true }] }, META);
    assert.ok(lines(doc).includes('TRANSP:TRANSPARENT'));
  });
});

describe('ics.js — over the real events.js output', () => {
  // The pairing that matters: whatever the calendar screen shows is what the file contains, rotation
  // overlay included. Built through Events.build rather than a hand-made map, so a change to the event
  // shape breaks here instead of silently emitting an empty calendar.
  const dataCache = {
    tasks: [{ id: 't1', due: '2026-03-04', title: 'Pay rent' }, { id: 't2', due: '', title: 'Someday' }],
    ref_chores: [{ id: '1', chore: 'dishes', person: 'Ann', position: 1 }]
  };
  const views = {
    cal: {
      calendar: {
        sources: [{ table: 'tasks', dateColumn: 'due', titleColumns: ['title'] }],
        rotationSources: [{ view: 'duties' }]
      }
    },
    duties: { rotation: { rosterRef: 'ref_chores', rosterBy: 'chore', valueCol: 'person', interval: 'weekly', anchorDate: '2026-03-01' } }
  };
  const ctx = {
    views, dataCache,
    today: () => '2026-03-01',
    t: (k) => k, tOr: (k, fb) => fb,
    displayValue: (c, v) => (Array.isArray(v) ? v.join(', ') : String(v == null ? '' : v)),
    canReachTable: () => true, hashColor: () => '#000', resolveMeTokens: (f) => f,
    rotation: {
      rangeFor: () => ({}), anchorFor: () => null, rotateEveryFor: () => undefined,
      mineOnlySlot: () => null,
      slotsFor: (rv) => require('../../rotation').rosterGroups(rv, dataCache).slots,
      slotLabel: (n, s) => s, valueColFor: () => ''
    }
  };

  it('serializes both a source row and a generated duty from one build', () => {
    const ev = Events.build('cal', { from: '2026-03-01', toExclusive: '2026-03-29' }, ctx);
    const doc = Ics.build(ev, META);
    assert.ok(doc.includes('SUMMARY:Pay rent'), 'the source row is there');
    assert.ok(lines(doc).some((l) => l.startsWith('UID:rot:duties:')), 'the rotation duty is there too');
    assert.ok(!doc.includes('Someday'), 'the undated row is not');
  });

  it('every VEVENT is balanced and carries the four required properties', () => {
    const ev = Events.build('cal', { from: '2026-03-01', toExclusive: '2026-03-29' }, ctx);
    const l = lines(Ics.build(ev, META));
    const begins = l.filter((x) => x === 'BEGIN:VEVENT').length;
    assert.equal(begins, l.filter((x) => x === 'END:VEVENT').length);
    assert.ok(begins > 1);
    ['UID:', 'DTSTAMP:', 'DTSTART;VALUE=DATE:', 'SUMMARY:'].forEach((p) => {
      assert.equal(l.filter((x) => x.startsWith(p)).length, begins, 'every event has ' + p);
    });
  });
});
