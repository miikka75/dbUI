const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// A response table's `capacity`, enforced by the Postgres trigger in supabase-schema.sql (app_capacity_trg)
// -- the one Supabase runs, applied here to PGlite with the real RLS policies. Members write their own
// bookings with no grant on the classes table; the trigger keeps the count on the class row and refuses
// the booking that would take a place past the limit.
const { createPgliteStorage } = require('../../storage-pglite');
const { createKvBackend } = require('../../backend-kv');

const SCHEMA = {
  tables: {
    classes: { columns: [{ name: 'title' }, { name: 'capacity', type: 'number' }, { name: 'booked', type: 'number' }, { name: 'walk_ins', type: 'number' }] },
    bookings: {
      columns: [{ name: 'owner', type: 'owner' }, { name: 'class', type: 'ref', table: 'classes', valueCol: 'id' },
                { name: 'booking', type: 'select', list: 'booking_status' }, { name: 'note' }],
      ownerWritable: ['class', 'booking', 'note'],
      capacity: { link: 'class', status: 'booking', column: 'capacity', count: 'booked', reserved: 'walk_ins', holds: ['booked'] }
    }
  },
  views: []
};

let S, B, U;
let email = 'admin@x.com';
const as = (e) => { email = e; S.setCaller(e); };
const attempt = (p) => Promise.resolve(p).then(() => 'ok', (e) => (/is full/.test(e.message) ? 'full' : /row-level security/.test(e.message) ? 'denied' : 'threw: ' + e.message));
const count = async (id) => { as('admin@x.com'); return (await S.get('classes__active', id)).booked; };
const book = (who, id, cls, status) => { as(who); return S.put('bookings__active', id, { id, owner: who, class: cls, booking: status === undefined ? 'booked' : status, rosterPublic: false }); };

before(async () => {
  S = await createPgliteStorage({});
  const kv = createKvBackend(S, {
    name: 'test', myEmail: () => email,
    noUsers: () => S._query('select public.app_no_users() as none').then((r) => !!(r && r.rows && r.rows[0] && r.rows[0].none)).catch(() => false)
  });
  B = kv.backend; U = kv.users;
  as('admin@x.com');
  await B.saveSchema(SCHEMA);
  await U.setUserRole('admin@x.com', 'admin', 'admin@x.com', 'all');
  for (const m of ['ann@x.com', 'bob@x.com', 'cy@x.com']) await U.setUserRole(m, 'editor', m, { classes: 'r' });
  as('admin@x.com');
  await S.put('classes__active', 'c1', { id: 'c1', title: 'Spin', capacity: 2 });
  await S.put('classes__active', 'c2', { id: 'c2', title: 'Yoga', capacity: '' });
});
after(async () => { if (S) await S.close(); });

describe('capacity (Postgres trigger)', () => {
  it('saveSchema mirrors the config both rules layers read', async () => {
    as('admin@x.com');
    assert.deepEqual((await S.getMeta('ownerTables')).capacity, {
      responses: { bookings: { events: 'classes', link: 'class', status: 'booking', capacity: 'capacity', count: 'booked', reserved: 'walk_ins', holds: ['booked'] } },
      events: { classes: 'bookings' }
    });
  });

  it('a member books with no grant on the class, and the count follows', async () => {
    assert.equal(await attempt(book('ann@x.com', 'b1', 'c1')), 'ok');
    assert.equal(await count('c1'), 1);
    assert.equal(await attempt(book('bob@x.com', 'b2', 'c1')), 'ok');
    assert.equal(await count('c1'), 2);
  });

  it('the booking past the limit is refused, and nothing is written', async () => {
    assert.equal(await attempt(book('cy@x.com', 'b3', 'c1')), 'full');
    assert.equal(await count('c1'), 2);
    as('admin@x.com');
    assert.equal(await S.get('bookings__active', 'b3'), undefined);
  });

  it('a status that does not hold a place takes none, and switching to one that does is checked', async () => {
    assert.equal(await attempt(book('cy@x.com', 'b3', 'c1', 'maybe')), 'ok');
    assert.equal(await count('c1'), 2);
    as('cy@x.com');
    assert.equal(await attempt(S.put('bookings__active', 'b3', { booking: 'booked' })), 'full');
  });

  it('cancelling frees the place, for whoever books next', async () => {
    as('ann@x.com');
    await S.delete('bookings__active', 'b1');
    assert.equal(await count('c1'), 1);
    as('cy@x.com');
    assert.equal(await attempt(S.put('bookings__active', 'b3', { booking: 'booked' })), 'ok');
    assert.equal(await count('c1'), 2);
  });

  it('editing a booking that already holds a place is not "taking" one, even over a shrunk limit', async () => {
    as('admin@x.com');
    await S.put('classes__active', 'c1', { capacity: 1 });
    as('bob@x.com');
    assert.equal(await attempt(S.put('bookings__active', 'b2', { note: 'running late' })), 'ok');
  });

  it('a blank limit is no limit', async () => {
    for (const [who, id] of [['ann@x.com', 'y1'], ['bob@x.com', 'y2'], ['cy@x.com', 'y3']]) assert.equal(await attempt(book(who, id, 'c2')), 'ok');
    assert.equal(await count('c2'), 3);
  });

  it('walk-ins on the class (`reserved`) take places: the booking they leave no room for is refused', async () => {
    as('admin@x.com');
    await S.put('classes__active', 'c3', { id: 'c3', title: 'Pump', capacity: 2, walk_ins: 2 });
    assert.equal(await attempt(book('ann@x.com', 'w1', 'c3')), 'full');
    as('admin@x.com');
    await S.put('classes__active', 'c3', { walk_ins: 1 });
    assert.equal(await attempt(book('ann@x.com', 'w1', 'c3')), 'ok');
    assert.equal(await count('c3'), 1);
  });

  it('a member still cannot write the count themselves', async () => {
    as('ann@x.com');
    assert.equal(await attempt(S.put('classes__active', 'c2', { booked: 0 })), 'denied');
  });
});
