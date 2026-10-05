// rsvp-attendance.spec.js — "did the people who signed up turn up?", as schema config.
//
// The pattern (SCHEMA.md, "Verified attendance"): an `attendance` column with a real default, left out of
// `ownerWritable` so a member cannot mark themselves present, and `ownerWritableWhile` freezing their
// response once an organizer has marked it. Written down as "config, not code" -- and it was not quite:
// the RSVP writer built its row without column defaults, so the gate column was born blank, the write
// layers refused the create (a non-owner-writable column must equal its default), and had they not, the
// row would have been frozen from birth. This walks the whole arrangement against the dev server's
// enforcement, as a member and as the organizer.
const { test, expect } = require('./server-fixture');

const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    practices: { columns: [{ name: 'date', type: 'date' }, { name: 'title', type: 'text' }] },
    rsvps: {
      columns: [
        { name: 'owner', type: 'owner' },
        { name: 'practice', type: 'ref', table: 'practices', valueCol: 'id' },
        { name: 'response', type: 'select', list: 'rsvp_status' },
        { name: 'note', type: 'text' },
        { name: 'attendance', type: 'select', list: 'attendance_status', default: 'pending' }
      ],
      ownerWritable: ['practice', 'response', 'note'],
      ownerWritableWhile: { attendance: 'pending' }
    }
  },
  views: [{ name: 'my_rsvp', kind: 'rsvp', rsvp: { events: 'practices', dateColumn: 'date', titleColumns: ['title'],
            responses: 'rsvps', statusColumn: 'response', picker: 'toggle' } }],
  nav: { items: [{ view: 'my_rsvp' }] }
};
const ADMIN = { 'X-User': 'org@x' };
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

async function setup(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'editor', user: 'ann@x', tables: { practices: 'r', rsvps: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { rsvp_status: ['coming', 'out'], attendance_status: ['pending', 'attended', 'absent'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: future, title: 'Tuesday' } }, headers: ADMIN });
}
async function bootAs(page, user) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((u) => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', u); }, user);
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('my_rsvp'));
  await expect(page.locator('[data-testid="rsvp-toggle"]')).toBeVisible();
}
const stored = async (page) => {
  const res = await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN });
  return ((await res.json()).rows || []).filter((r) => r.owner === 'ann@x');
};

test('a member responds, an organizer marks attendance, and the response is then frozen', async ({ page }) => {
  await setup(page);
  await bootAs(page, 'ann@x');

  // The response row is born with the gate column at its default, so the server accepts it.
  await page.locator('[data-testid="rsvp-toggle"] button', { hasText: 'coming' }).click();
  await expect.poll(async () => (await stored(page)).map((r) => [r.response, r.attendance])).toEqual([['coming', 'pending']]);
  const id = (await stored(page))[0].id;

  // Still pending: the member may change their mind.
  await page.locator('[data-testid="rsvp-toggle"] button', { hasText: 'out' }).click();
  await expect.poll(async () => (await stored(page))[0].response).toBe('out');

  // A member cannot mark themselves present: attendance is not in ownerWritable.
  const self = await page.request.post('/api/putRow', { headers: { 'X-User': 'ann@x' },
    data: { tableId: 'rsvps', tab: 'active', data: Object.assign({}, (await stored(page))[0], { attendance: 'attended' }) } });
  expect(self.status()).toBe(403);

  // The organizer marks it.
  const row = (await stored(page))[0];
  const marked = await page.request.post('/api/putRow', { headers: ADMIN, data: { tableId: 'rsvps', tab: 'active', data: Object.assign({}, row, { attendance: 'attended' }) } });
  expect(marked.ok()).toBe(true);

  // Now the response is out of the member's hands: the picker says so, and the server agrees.
  await bootAs(page, 'ann@x');
  expect(await page.evaluate(() => appInstance.rsvpFrozen('my_rsvp', 'p1'))).toBe(true);
  for (const b of await page.locator('[data-testid="rsvp-toggle"] button').all()) await expect(b).toBeDisabled();
  await page.evaluate(() => appInstance.setRsvp('my_rsvp', 'p1', 'coming'));
  expect(await page.evaluate((rid) => appInstance.dataCache.rsvps.find((r) => r.id === rid).response, id)).toBe('out');
  const late = await page.request.post('/api/putRow', { headers: { 'X-User': 'ann@x' },
    data: { tableId: 'rsvps', tab: 'active', data: Object.assign({}, row, { attendance: 'attended', response: 'coming' }) } });
  expect(late.status()).toBe(403);
});
