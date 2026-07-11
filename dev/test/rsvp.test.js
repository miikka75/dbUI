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
    assert.deepEqual(r.events[0].participants, [
      { owner: 'me@x', status: 'coming' },
      { owner: 'you@x', status: 'maybe' }
    ]);
    // the caller only ever gets the responses the backend returned -> owner-scoped reads naturally
    // shrink this list to just the viewer's own row.
    const scoped = Rsvp.build(events, responses.filter(x => x.owner === 'me@x'), opts);
    assert.deepEqual(scoped.events[0].participants, [{ owner: 'me@x', status: 'coming' }]);
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
});
