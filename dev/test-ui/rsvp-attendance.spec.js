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
  await expect(page.locator('[data-testid="rsvp-toggle"]').first()).toBeVisible();
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

// Today's practice, with check-in configured: the claim column is the member's, the verdict is not.
async function setupCheckin(page) {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns[0] = { name: 'date', type: 'date' };
  schema.tables.rsvps.columns.push({ name: 'checkin_code', type: 'text' });
  schema.tables.rsvps.ownerWritable.push('checkin_code');
  schema.views[0].rsvp.checkin = { codeColumn: 'checkin_code', set: { attendance: 'attended' } };
  const today = new Date(); const ymd = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  for (const u of ['ann@x', 'bob@x']) await page.request.post('/api/setUserRole', { data: { uid: u, role: 'editor', user: u, tables: { practices: 'r', rsvps: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { rsvp_status: ['coming', 'out'], attendance_status: ['pending', 'attended', 'absent'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: ymd, title: 'Tonight' } }, headers: ADMIN });
  return ymd;
}

test('self check-in: members type the code shown at the event, the organizer stamps every match', async ({ page, browser }) => {
  await setupCheckin(page);

  // Two members respond and claim: Ann types what was on the slide, Bob guesses.
  for (const [user, claim] of [['ann@x', ' LION '], ['bob@x', 'tiger']]) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await bootAs(p, user);
    await p.locator('[data-testid="rsvp-toggle"] button', { hasText: 'coming' }).click();
    await expect(p.locator('[data-testid="rsvp-checkin-claim"] input')).toBeVisible();
    await p.locator('[data-testid="rsvp-checkin-claim"] input').fill(claim);
    await p.locator('[data-testid="rsvp-checkin-claim"] input').press('Tab');
    await expect.poll(async () => ((await (await p.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || [])
      .filter((r) => r.owner === user).map((r) => r.checkin_code)).toEqual([claim.trim()]);
    // A member is never offered the stamping side.
    await expect(p.locator('[data-testid="rsvp-checkin-stamp"]')).toHaveCount(0);
    await ctx.close();
  }

  // The organizer types the real code and checks the room in.
  await bootAs(page, 'org@x');
  await page.locator('[data-testid="rsvp-checkin-real"] input').fill('lion');
  await page.locator('[data-testid="rsvp-checkin-stamp"]').click();
  const att = async () => Object.fromEntries(((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.owner, r.attendance]));
  await expect.poll(att).toEqual({ 'ann@x': 'attended', 'bob@x': 'pending' });

  // One press, one undo.
  await page.evaluate(() => appInstance.undoLast());
  await expect.poll(att).toEqual({ 'ann@x': 'pending', 'bob@x': 'pending' });
});

test('self check-in by QR: one scan claims every class reserved today, one press stamps them all', async ({ page, browser }) => {
  const ymd = await setupCheckin(page);
  // A second class today, and one tomorrow that the code must not touch.
  const tomorrow = new Date(Date.now() + 86400000); const ymd2 = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-');
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p2', date: ymd, title: 'Late' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p3', date: ymd2, title: 'Tomorrow' } }, headers: ADMIN });

  // The organizer types the code and shows it: a QR, and the code in text under it.
  await bootAs(page, 'org@x');
  await expect(page.locator('[data-testid="rsvp-checkin-qr"]')).toBeDisabled();
  await page.locator('[data-testid="rsvp-checkin-real"] input').fill('lion');
  await page.locator('[data-testid="rsvp-checkin-qr"]').click();
  await expect(page.locator('[data-testid="qr-dialog"] svg')).toBeVisible();
  await expect(page.locator('[data-testid="qr-dialog-caption"]')).toHaveText('lion');
  // What the QR carries: a link to this view and this code -- the day's, not one class's.
  const link = new URL(await page.evaluate(() => appInstance.scanDeepLink('my_rsvp', 'lion')));
  expect(link.searchParams.get('scan')).toBe('lion');

  // Ann has reserved all three classes; her phone's camera opens the link.
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await bootAs(p, 'ann@x');
  for (const b of await p.locator('[data-testid="rsvp-toggle"]').all()) await b.locator('button', { hasText: 'coming' }).click();
  await expect.poll(async () => (await (await p.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows.length).toBe(3);
  await p.goto('/' + link.search);
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  // Armed, not written: the box holds the code, the link has left the address bar, nothing is stored yet.
  await expect(p.locator('[data-testid="rsvp-checkin-claim"] input')).toHaveValue('lion');
  expect(new URL(p.url()).searchParams.get('scan')).toBeNull();
  const byClass = async (col) => Object.fromEntries(((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.practice, r[col] || '']));
  expect(await byClass('checkin_code')).toEqual({ p1: '', p2: '', p3: '' });
  await p.locator('[data-testid="rsvp-checkin-claim-save"]').click();
  await expect.poll(() => byClass('checkin_code')).toEqual({ p1: 'lion', p2: 'lion', p3: '' });
  await expect(p.locator('[data-testid="rsvp-checkin-claim-save"]')).toHaveCount(0);
  await ctx.close();

  // One press marks both of today's classes; tomorrow's stays pending.
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="rsvp-checkin-stamp"]').click();
  await expect.poll(() => byClass('attendance')).toEqual({ p1: 'attended', p2: 'attended', p3: 'pending' });
});

test('self check-in, twice in a day: attend one class, leave, reserve another, come back and check in again', async ({ page, browser }) => {
  const ymd = await setupCheckin(page);
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p2', date: ymd, title: 'Evening' } }, headers: ADMIN });
  const byClass = async (col) => Object.fromEntries(((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.practice, r[col] || '']));
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await bootAs(p, 'ann@x');
  const claim = p.locator('[data-testid="rsvp-checkin-claim"] input');

  // Morning: Ann has reserved only the first class, checks in, and is marked.
  await p.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' }).click();
  await claim.fill('lion'); await claim.press('Tab');
  await expect.poll(() => byClass('checkin_code')).toEqual({ p1: 'lion' });
  await bootAs(page, 'org@x');
  await page.locator('[data-testid="rsvp-checkin-real"] input').fill('lion');
  await page.locator('[data-testid="rsvp-checkin-stamp"]').click();
  await expect.poll(() => byClass('attendance')).toEqual({ p1: 'attended' });

  // Later: she reserves the evening class; the box is empty again, because the morning row is done.
  await p.reload();
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await p.evaluate(() => appInstance.selectTab('my_rsvp'));
  await p.locator('[data-testid="rsvp-toggle"]').nth(1).locator('button', { hasText: 'coming' }).click();
  await expect(claim).toHaveValue('');
  await claim.fill('lion'); await claim.press('Tab');
  await expect.poll(() => byClass('checkin_code')).toEqual({ p1: 'lion', p2: 'lion' });
  await ctx.close();

  // The organizer presses again for the late arrivals; the morning mark is untouched.
  await page.locator('[data-testid="rsvp-checkin-stamp"]').click();
  await expect.poll(() => byClass('attendance')).toEqual({ p1: 'attended', p2: 'attended' });
});

test('registering at the venue: the organizer shows a QR for the page, and the link opens it on a member phone', async ({ page, browser }) => {
  await setup(page);
  await bootAs(page, 'org@x');
  await page.locator('[data-testid="rsvp-page-qr"]').click();
  await expect(page.locator('[data-testid="qr-dialog"] svg')).toBeVisible();
  const link = new URL(await page.evaluate(() => appInstance.viewDeepLink('my_rsvp')));
  expect(link.searchParams.get('view')).toBe('my_rsvp');
  expect(link.searchParams.get('scan')).toBeNull();

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'ann@x'); });
  // A member is not offered the page QR.
  await p.goto('/' + link.search);
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await expect.poll(() => p.evaluate(() => appInstance.currentTable)).toBe('my_rsvp');
  await expect(p.locator('[data-testid="rsvp-toggle"]').first()).toBeVisible();
  await expect(p.locator('[data-testid="rsvp-page-qr"]')).toHaveCount(0);
  expect(new URL(p.url()).searchParams.get('view')).toBeNull();
  // A link to a screen that does not exist (or is not granted) opens the app as usual, with no error.
  await p.goto('/?view=nope');
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await expect.poll(() => p.evaluate(() => appInstance.currentTable)).toBe('my_rsvp');
  await ctx.close();
});
