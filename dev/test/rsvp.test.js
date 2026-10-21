const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Rsvp = require('../../rsvp');

const events = [
  { id: 'p1', date: '2026-07-01', title: 'Practice', opponent: '' },
  { id: 'p2', date: '2026-07-08', title: 'Match', opponent: 'Reds' },
  { id: 'p0', date: '2026-06-01', title: 'Old', opponent: '' }
];
const responses = [
  { id: 'r1', owner: 'me@x', practice: '2026-07-01', status: 'coming' },
  { id: 'r2', owner: 'you@x', practice: '2026-07-01', status: 'maybe' },
  { id: 'r3', owner: 'me@x', practice: '2026-07-08', status: 'out' }
];
const opts = {
  me: 'me@x', dateColumn: 'date', eventKey: 'date', titleColumns: ['title', 'opponent'],
  linkColumn: 'practice', statusColumn: 'status', today: '2026-07-01'
};

describe('rsvp.js — build', () => {
  it('lists upcoming events sorted, drops past ones', () => {
    const r = Rsvp.build(events, responses, opts);
    assert.deepEqual(r.events.map(e => e.key), ['2026-07-01', '2026-07-08']); // 2026-06-01 dropped (past)
  });

  it('joins the title columns (skips blanks)', () => {
    const r = Rsvp.build(events, responses, opts);
    assert.equal(r.events[0].title, 'Practice');          // opponent blank -> not joined
    assert.equal(r.events[1].title, 'Match — Reds');
  });

  it('surfaces MY response (status + row id) matched by owner', () => {
    const r = Rsvp.build(events, responses, opts);
    assert.equal(r.events[0].myStatus, 'coming');
    assert.equal(r.events[0].myRowId, 'r1');
    assert.equal(r.events[1].myStatus, 'out');
  });

  it('no response yet -> blank status, null row id', () => {
    const r = Rsvp.build(events, [], opts);
    assert.equal(r.events[0].myStatus, '');
    assert.equal(r.events[0].myRowId, null);
  });

  it('tallies all responses per event', () => {
    const r = Rsvp.build(events, responses, opts);
    assert.deepEqual(r.events[0].tally, { coming: 1, maybe: 1 });   // me coming + you maybe
    assert.equal(r.events[0].total, 2);
    assert.deepEqual(r.events[1].tally, { out: 1 });
    assert.deepEqual(r.statuses, ['coming', 'maybe', 'out']);       // distinct, sorted
  });

  it('exposes the per-event roster (participants sorted by status, then owner)', () => {
    const r = Rsvp.build(events, responses, opts);
    const who = (ps) => ps.map((p) => ({ owner: p.owner, status: p.status }));
    assert.deepEqual(who(r.events[0].participants), [
      { owner: 'me@x', status: 'coming' },
      { owner: 'you@x', status: 'maybe' }
    ]);
    // the caller only ever gets the responses the backend returned -> owner-scoped reads naturally
    // shrink this list to just the viewer's own row.
    const scoped = Rsvp.build(events, responses.filter(x => x.owner === 'me@x'), opts);
    assert.deepEqual(who(scoped.events[0].participants), [{ owner: 'me@x', status: 'coming' }]);
  });

  it('an empty-status response is excluded from tally/total/roster (no blank line)', () => {
    const withEmpty = responses.concat([{ id: 'r4', owner: 'ann@x', practice: '2026-07-01', status: '' }]);
    const r = Rsvp.build(events, withEmpty, opts);
    assert.equal(r.events[0].total, 2);                            // the empty one doesn't count
    assert.deepEqual(r.events[0].tally, { coming: 1, maybe: 1 });
    assert.ok(!r.events[0].participants.some(p => p.owner === 'ann@x')); // and never shows in the roster
    // but if the empty row is MINE, my status still reads blank (toggle shows nothing selected)
    const mineEmpty = Rsvp.build(events, [{ id: 'rx', owner: 'me@x', practice: '2026-07-01', status: '' }], opts);
    assert.equal(mineEmpty.events[0].myStatus, '');
    assert.equal(mineEmpty.events[0].total, 0);
  });

  it('upcoming:false includes past events; limit caps the count', () => {
    assert.equal(Rsvp.build(events, responses, Object.assign({}, opts, { upcoming: false })).events.length, 3);
    assert.equal(Rsvp.build(events, responses, Object.assign({}, opts, { limit: 1 })).events.length, 1);
  });

  it('another user sees their own response, not mine', () => {
    const r = Rsvp.build(events, responses, Object.assign({}, opts, { me: 'you@x' }));
    assert.equal(r.events[0].myStatus, 'maybe');
    assert.equal(r.events[0].myRowId, 'r2');
    assert.equal(r.events[1].myStatus, '');   // you@x didn't respond to p2
  });

  it('two events on the same date stay separate when linked by id (not date)', () => {
    const evs = [
      { id: 'e1', date: '2026-07-01', title: 'Morning', opponent: '' },
      { id: 'e2', date: '2026-07-01', title: 'Evening', opponent: '' }
    ];
    const byId = { me: 'me@x', dateColumn: 'date', eventKey: 'id', linkColumn: 'practice', statusColumn: 'status', titleColumns: ['title'], today: '2026-07-01' };
    const rById = Rsvp.build(evs, [
      { id: 'r1', owner: 'me@x',  practice: 'e1', status: 'coming' },
      { id: 'r2', owner: 'you@x', practice: 'e2', status: 'out' }
    ], byId);
    const e1 = rById.events.find(e => e.id === 'e1'), e2 = rById.events.find(e => e.id === 'e2');
    assert.deepEqual(e1.tally, { coming: 1 });   // each event keeps only its own response
    assert.deepEqual(e2.tally, { out: 1 });
    assert.equal(e1.myStatus, 'coming');
    assert.equal(e2.myStatus, '');               // I didn't respond to e2

    // Contrast — keying by the (non-unique) date merges the two events' responses. This is the bug the
    // id link fixes: both responses store the same "2026-07-01" and land on BOTH events.
    const rByDate = Rsvp.build(evs, [
      { id: 'r1', owner: 'me@x',  practice: '2026-07-01', status: 'coming' },
      { id: 'r2', owner: 'you@x', practice: '2026-07-01', status: 'out' }
    ], Object.assign({}, byId, { eventKey: 'date' }));
    assert.deepEqual(rByDate.events.find(e => e.id === 'e1').tally, { coming: 1, out: 1 });
    assert.deepEqual(rByDate.events.find(e => e.id === 'e2').tally, { coming: 1, out: 1 });
  });
});

describe('rsvp.js — self check-in with a shared code', () => {
  const rows = [
    { id: 'a', owner: 'ann@x', practice: 'p1', code: ' Lion ', attendance: 'pending' },
    { id: 'b', owner: 'bob@x', practice: 'p1', code: 'tiger', attendance: 'pending' },
    { id: 'c', owner: 'cy@x', practice: 'p1', code: 'lion', attendance: 'attended' },
    { id: 'd', owner: 'dan@x', practice: 'p2', code: 'lion', attendance: 'pending' },
    { id: 'e', owner: 'eve@x', practice: 'p1', code: '', attendance: 'pending' },
    { id: 'f', owner: 'ann@x', practice: 'p3', code: 'lion', attendance: 'pending' }
  ];
  const opts = (...codes) => ({ codes, linkColumn: 'practice', eventKeys: ['p1', 'p3'], checkinColumn: 'code', set: { attendance: 'attended' } });

  it('stamps the given events\' rows whose claim matches, ignoring case and space, skipping the already-marked', () => {
    assert.deepEqual(Rsvp.checkinTargets(rows, opts('LION')).map((r) => r.id), ['a', 'f']);
  });

  it('accepts any of several codes -- a rotating code and the one before it', () => {
    assert.deepEqual(Rsvp.checkinTargets(rows, opts('puma', 'tiger')).map((r) => r.id), ['b']);
    assert.deepEqual(Rsvp.checkinTargets(rows, opts('tiger', 'lion')).map((r) => r.id), ['a', 'b', 'f']);
  });

  it('a rotating code is drawn from an alphabet without look-alikes', () => {
    assert.equal(Rsvp.checkinCode([0, 1, 30, 31, 62]), 'AB9AA');
    assert.doesNotMatch(Rsvp.checkinCode(Array.from({ length: 200 }, (_, i) => i)), /[01ILO]/);
  });

  it('a blank code or an empty `set` stamps nobody, so an unclaimed row never matches', () => {
    assert.deepEqual(Rsvp.checkinTargets(rows, opts('  ')), []);
    assert.deepEqual(Rsvp.checkinTargets(rows, Object.assign(opts('lion'), { set: {} })), []);
  });

  it('build carries my claim and whether the event is today', () => {
    const out = Rsvp.build([{ id: 'p1', date: '2026-09-09' }, { id: 'p2', date: '2026-09-10' }], rows, {
      me: 'ann@x', dateColumn: 'date', eventKey: 'id', linkColumn: 'practice', statusColumn: 'attendance',
      checkinColumn: 'code', today: '2026-09-09' });
    assert.deepEqual(out.events.map((e) => [e.key, e.isToday, e.myCode]), [['p1', true, ' Lion '], ['p2', false, '']]);
  });
});

describe('rsvp.js — a datetime dateColumn', () => {
  // A class at 21:30 Helsinki time is 18:30 UTC the same day; one at 01:30 local is the PREVIOUS UTC day.
  // "Today" and "upcoming" are the reader's local day, so the engine must not read the UTC prefix.
  const local = (y, m, d, h, mi) => new Date(y, m - 1, d, h, mi).toISOString();
  const evs = [
    { id: 'late', starts_at: local(2026, 10, 13, 23, 30), title: 'Late' },
    { id: 'early', starts_at: local(2026, 10, 13, 7, 0), title: 'Early' },
    { id: 'past', starts_at: local(2026, 10, 12, 18, 0), title: 'Yesterday' }
  ];
  const opts = { me: 'me@x', dateColumn: 'starts_at', eventKey: 'id', titleColumns: ['title'], linkColumn: 'cls', statusColumn: 's', today: '2026-10-13' };

  it('counts an event on the LOCAL day it falls on, sorted by the instant', () => {
    const r = Rsvp.build(evs, [], opts);
    assert.deepEqual(r.events.map(e => e.key), ['early', 'late']);
    assert.deepEqual(r.events.map(e => e.isToday), [true, true]);
  });
});

describe('rsvp.js — walk-ins take places, and who has arrived', () => {
  const Rsvp2 = require('../../rsvp');
  it('`capacity.reserved` adds to the places taken; a participant carrying the check-in stamp has arrived', () => {
    const ev = [{ id: 'c1', on: '2099-01-01', capacity: 3, booked: 1, walk_ins: 2 }];
    const resp = [{ id: 'b1', owner: 'a@x', class: 'c1', booking: 'booked', attendance: 'attended' }, { id: 'b2', owner: 'b@x', class: 'c1', booking: 'booked', attendance: 'pending' }];
    const out = Rsvp2.build(ev, resp, { me: 'z@x', dateColumn: 'on', linkColumn: 'class', eventKey: 'id', statusColumn: 'booking',
      capacity: { column: 'capacity', count: 'booked', reserved: 'walk_ins', holds: ['booked'] }, checkin: { set: { attendance: 'attended' } } }).events[0];
    assert.equal(out.reserved, 2);
    assert.equal(out.booked, 3);
    assert.equal(out.full, true);
    assert.deepEqual(out.participants.map((p) => [p.id, p.arrived]), [['b1', true], ['b2', false]]);
  });
});

describe('rsvp.js -- `before`: the booking list cut at a day, the rest counted', () => {
  const R = require('../../rotation');
  const evs = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-25'].map((d, i) => ({ id: 'e' + i, date: d }));
  const base = { me: 'a@x', dateColumn: 'date', today: '2026-10-19', statusColumn: 'status', linkColumn: 'event', eventKey: 'id' };
  it('keeps the days before `before`, counts the later ones, and without it keeps everything', () => {
    const r = Rsvp.build(evs, [], Object.assign({ before: R.dayAfter('2026-10-19', '3d') }, base));
    assert.deepEqual([r.events.map((e) => e.date), r.later], [['2026-10-19', '2026-10-20', '2026-10-21'], 2]);
    const all = Rsvp.build(evs, [], base);
    assert.deepEqual([all.events.length, all.later], [5, 0]);
  });
  it('dayAfter: calendar days, times repeats, a month clamps to its last day', () => {
    assert.deepEqual([R.dayAfter('2026-10-19', '3d'), R.dayAfter('2026-10-19', '3d', 2), R.dayAfter('2026-10-24', '1w'), R.dayAfter('2026-01-31', '1m')],
      ['2026-10-22', '2026-10-25', '2026-10-31', '2026-02-28']);
    assert.equal(R.dayAfter('2026-10-19', 'soon'), null);
  });
});
