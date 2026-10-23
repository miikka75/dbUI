const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// `capacity.waitlist`, run by the Postgres capacity trigger in supabase-schema.sql against PGlite with
// the real RLS policies: a freed place goes to the longest-waiting member, until `until` before the start.
const { createPgliteStorage } = require('../../storage-pglite');
const { createKvBackend } = require('../../backend-kv');

const SCHEMA = {
  tables: {
    classes: { columns: [{ name: 'starts_at', type: 'datetime' }, { name: 'capacity', type: 'number' }, { name: 'booked', type: 'number' }] },
    bookings: {
      columns: [{ name: 'owner', type: 'owner' }, { name: 'class', type: 'ref', table: 'classes', valueCol: 'id' },
                { name: 'booking', type: 'select', list: 'booking_status' }],
      ownerWritable: ['class', 'booking'],
      capacity: { link: 'class', status: 'booking', column: 'capacity', count: 'booked', holds: ['booked'],
                  waitlist: { status: 'waitlisted', start: 'starts_at', until: '10min' } }
    }
  },
  views: []
};

let S, B, U;
let email = 'admin@x.com';
const as = (e) => { email = e; S.setCaller(e); };
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const book = (who, id, cls, status) => { as(who); return S.put('bookings__active', id, { id, owner: who, class: cls, booking: status, rosterPublic: false }); };
const statuses = async (cls) => {
  as('admin@x.com');
  const rows = (await S._query("select key, value ->> 'booking' as b from public.kv where store = 'bookings__active' and value ->> 'class' = $1 order by key", [cls])).rows;
  return Object.fromEntries(rows.map((r) => [r.key, r.b]));
};
const count = async (id) => { as('admin@x.com'); return (await S.get('classes__active', id)).booked; };

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
  for (const m of ['ann@x.com', 'bob@x.com', 'cy@x.com', 'dan@x.com']) await U.setUserRole(m, 'editor', m, { classes: 'r' });
  as('admin@x.com');
  await S.put('classes__active', 'c1', { id: 'c1', starts_at: inMin(120), capacity: 1 });
  await S.put('classes__active', 'c2', { id: 'c2', starts_at: inMin(5), capacity: 1 });
});
after(async () => { if (S) await S.close(); });

describe('waitlist (Postgres trigger)', () => {
  it('a full class takes waitlisted responses, which hold no place', async () => {
    await book('ann@x.com', 'a', 'c1', 'booked');
    await book('bob@x.com', 'b', 'c1', 'waitlisted');
    await book('cy@x.com', 'c', 'c1', 'waitlisted');
    assert.equal(await count('c1'), 1);
  });

  it('cancelling promotes the longest-waiting response, and only one', async () => {
    as('ann@x.com');
    await S.delete('bookings__active', 'a');
    assert.deepEqual(await statuses('c1'), { b: 'booked', c: 'waitlisted' });
    assert.equal(await count('c1'), 1);
  });

  it('the queue is the server\'s: a backdated updated_at does not jump it', async () => {
    await book('dan@x.com', 'd', 'c1', 'waitlisted');
    as('dan@x.com');
    await S._query("update public.kv set updated_at = '2000-01-01' where store = 'bookings__active' and key = 'd'");
    as('bob@x.com');
    await S.put('bookings__active', 'b', { booking: '' });
    assert.deepEqual(await statuses('c1'), { b: '', c: 'booked', d: 'waitlisted' });
  });

  it('after `until` before the start, a freed place is left for the door', async () => {
    await book('ann@x.com', 'a2', 'c2', 'booked');
    await book('bob@x.com', 'b2', 'c2', 'waitlisted');
    as('ann@x.com');
    await S.delete('bookings__active', 'a2');
    assert.deepEqual(await statuses('c2'), { b2: 'waitlisted' });
    assert.equal(await count('c2'), 0);
  });
});
