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

test('rotating code: while the QR is open it stamps by itself, accepts the previous code, and drops the one before', async ({ page }) => {
  const ymd = await setupCheckin(page);
  // setupCheckin saved check-in without rotation; turn it on.
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.rsvps.columns.push({ name: 'checkin_code', type: 'text' });
  schema.tables.rsvps.ownerWritable.push('checkin_code');
  schema.views[0].rsvp.checkin = { codeColumn: 'checkin_code', set: { attendance: 'attended' }, rotateMinutes: 5 };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  for (const u of ['cy@x']) await page.request.post('/api/setUserRole', { data: { uid: u, role: 'editor', user: u, tables: { practices: 'r', rsvps: 'r' } }, headers: ADMIN });
  // A member's claim, written as that member through the server's owner enforcement.
  const claim = (user, code) => page.request.post('/api/putRow', { headers: { 'X-User': user }, data: { tableId: 'rsvps', tab: 'active',
    data: { id: 'r-' + user, owner: user, practice: 'p1', response: 'coming', attendance: 'pending', checkin_code: code, rosterPublic: true } } });
  const att = async () => Object.fromEntries(((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.owner, r.attendance]));

  await page.clock.install({ time: new Date(ymd + 'T10:00:00') });
  await bootAs(page, 'org@x');
  // No box to type in: the code is made, not typed.
  await expect(page.locator('[data-testid="rsvp-checkin-real"]')).toHaveCount(0);
  await page.locator('[data-testid="rsvp-checkin-qr"]').click();
  const caption = page.locator('[data-testid="qr-dialog-caption"]');
  await expect(caption).toHaveText(/^[A-HJKMNP-Z2-9]{5}$/);
  const first = await caption.textContent();

  // Ann claims the code on screen and is marked with no press.
  expect((await claim('ann@x', first.toLowerCase())).ok()).toBe(true);
  await page.clock.fastForward(20000);
  await expect.poll(att).toEqual({ 'ann@x': 'attended' });

  // Five minutes on: a new code, and the first still counts for Bob, who scanned as it changed.
  await page.clock.fastForward(5 * 60000);
  await expect(caption).not.toHaveText(first);
  const second = await caption.textContent();
  await claim('bob@x', first);
  await page.clock.fastForward(20000);
  await expect.poll(att).toEqual({ 'ann@x': 'attended', 'bob@x': 'attended' });

  // Another five: the first code is two back and refused; the second is still accepted.
  await page.clock.fastForward(5 * 60000);
  await expect(caption).not.toHaveText(second);
  await claim('cy@x', first);
  await page.clock.fastForward(20000);
  await expect.poll(att).toEqual({ 'ann@x': 'attended', 'bob@x': 'attended', 'cy@x': 'pending' });
  await claim('cy@x', second);
  await page.clock.fastForward(20000);
  await expect.poll(att).toEqual({ 'ann@x': 'attended', 'bob@x': 'attended', 'cy@x': 'attended' });
});

test('validateSchema: rotateMinutes must be a positive number', async ({ page }) => {
  await setupCheckin(page);
  await bootAs(page, 'org@x');
  const errs = await page.evaluate(() => {
    const out = [];
    for (const bad of [0, -5, '5']) { VIEWS.my_rsvp.rsvp.checkin.rotateMinutes = bad; out.push(validateSchema().join(' | ')); }
    VIEWS.my_rsvp.rsvp.checkin.rotateMinutes = 10; out.push(validateSchema().join(' | '));
    return out;
  });
  for (const e of errs.slice(0, 3)) expect(e).toContain('rotateMinutes');
  expect(errs[3]).not.toContain('rotateMinutes');
});

test('checkin.link "submit": the code from the QR saves itself, with no press', async ({ page, browser }) => {
  await setupCheckin(page);
  // Turn it on for this view: the gym's room QR, where scanning IS the check-in.
  const schema = (await (await page.request.post('/api/getSchema', { headers: ADMIN })).json());
  schema.views[0].rsvp.checkin.link = 'submit';
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await bootAs(p, 'ann@x');
  await p.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' }).click();
  const code = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => r.checkin_code || '');
  await expect.poll(code).toEqual(['']);

  const link = new URL(await p.evaluate(() => appInstance.scanDeepLink('my_rsvp', 'otter')));
  await p.goto('/' + link.search);
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await expect.poll(code).toEqual(['otter']);
  // Saved, so nothing is left waiting for a press.
  await expect(p.locator('[data-testid="rsvp-checkin-claim-save"]')).toHaveCount(0);
  await ctx.close();
});

test('validateSchema: checkin.link is "arm" or "submit"', async ({ page }) => {
  await setupCheckin(page);
  await bootAs(page, 'org@x');
  const errs = await page.evaluate(() => {
    const out = [];
    for (const v of ['auto', 'submit', 'arm']) { VIEWS.my_rsvp.rsvp.checkin.link = v; out.push(validateSchema().join(' | ')); }
    return out;
  });
  expect(errs[0]).toContain('`link`');
  expect(errs[1]).not.toContain('`link`');
  expect(errs[2]).not.toContain('`link`');
});

test('a member with NO grant on the responses table still gets the status options (self-service lists)', async ({ page }) => {
  await setup(page);
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'editor', user: 'ann@x', tables: { practices: 'r' } }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  await expect(page.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' })).toBeVisible();
});

test('scanning with nothing booked: the list narrows to today, and booking a class there checks you in', async ({ page, browser }) => {
  await setupCheckin(page);
  const schema = (await (await page.request.post('/api/getSchema', { headers: ADMIN })).json());
  schema.views[0].rsvp.checkin.link = 'submit';
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const tomorrow = new Date(Date.now() + 86400000); const ymd2 = [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-');
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p3', date: ymd2, title: 'Tomorrow' } }, headers: ADMIN });

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await bootAs(p, 'ann@x');
  await expect(p.locator('[data-testid="rsvp-toggle"]')).toHaveCount(2);     // today and tomorrow
  const link = new URL(await p.evaluate(() => appInstance.scanDeepLink('my_rsvp', 'heron')));
  await p.goto('/' + link.search);
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });

  // Only today's class is offered, and the code is shown but has nowhere to go yet.
  await expect(p.locator('[data-testid="rsvp-toggle"]')).toHaveCount(1);
  await expect(p.locator('[data-testid="rsvp-checkin-claim"] input')).toHaveValue('heron');
  await expect(p.locator('[data-testid="rsvp-checkin-claim"] input')).toBeDisabled();

  await p.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' }).click();
  const rows = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.practice, r.checkin_code || '']);
  await expect.poll(rows).toEqual([['p1', 'heron']]);
  // Done with the code, the whole list is back.
  await expect(p.locator('[data-testid="rsvp-toggle"]')).toHaveCount(2);
  await ctx.close();
});

test('capacity: places left are shown, a full event cannot be joined, and losing the race says so', async ({ page, browser }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns.push({ name: 'capacity', type: 'number' }, { name: 'booked', type: 'number' });
  schema.tables.rsvps.capacity = { link: 'practice', status: 'response', column: 'capacity', count: 'booked', holds: ['coming'] };
  schema.views[0].rsvp.showCounts = true;
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  for (const u of ['ann@x', 'bob@x']) await page.request.post('/api/setUserRole', { data: { uid: u, role: 'editor', user: u, tables: { practices: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { rsvp_status: ['coming', 'out'], attendance_status: ['pending', 'attended', 'absent'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: future, title: 'Tuesday', capacity: 1 } }, headers: ADMIN });

  // Bob opens the page while the place is still free.
  const ctx = await browser.newContext();
  const bob = await ctx.newPage();
  await bootAs(bob, 'bob@x');
  await expect(bob.locator('[data-testid="rsvp-places"]')).toContainText('1');

  // Ann takes it.
  await bootAs(page, 'ann@x');
  await page.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' }).click();
  await expect(page.locator('[data-testid="rsvp-places"]')).toHaveText(/full/i);
  // Hers to give up: a member holding a place in a full event is not locked out of it.
  await expect(page.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' })).toBeEnabled();

  // Bob's open screen hears about it: the class shows full and his choice locks, with no reload.
  await expect(bob.locator('[data-testid="rsvp-places"]')).toHaveText(/full/i);
  await expect(bob.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' })).toBeDisabled();
  // The race the lock cannot close -- he pressed in the moment before the news arrived. The server
  // refuses, his row goes away, and he is told why.
  await bob.evaluate(() => { const ev = appInstance.dataCache.practices.find((e) => e.id === 'p1'); ev.booked = 0; appInstance.setRsvp('my_rsvp', 'p1', 'coming'); });
  await expect.poll(() => bob.evaluate(() => appInstance.snackText)).toBe('msg.capacity_full');
  const rows = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => r.owner);
  expect(await rows()).toEqual(['ann@x']);
  await expect.poll(() => bob.evaluate(() => (appInstance.dataCache.rsvps || []).filter((r) => r.owner === 'bob@x').length)).toBe(0);

  // A fresh look shows him it is full, and the choice is locked.
  await bootAs(bob, 'bob@x');
  await expect(bob.locator('[data-testid="rsvp-places"]')).toHaveText(/full/i);
  await expect(bob.locator('[data-testid="rsvp-toggle"]').first().locator('button', { hasText: 'coming' })).toBeDisabled();
  await ctx.close();
});

test('validateSchema: a capacity config that does not resolve is named', async ({ page }) => {
  await setup(page);
  await bootAs(page, 'org@x');
  const errs = await page.evaluate(() => {
    const t = SCHEMA.rsvps, out = [];
    const tries = [
      { link: 'note', status: 'response', column: 'x', count: 'y' },                       // not a ref
      { link: 'practice', status: 'response', column: 'title', count: 'nope' },           // not a number; missing
      { link: 'practice', status: 'response', column: 'title', count: 'title', holds: [] } // empty holds
    ];
    for (const c of tries) { t.capacity = c; out.push(validateSchema().filter((e) => /capacity/.test(e)).join(' | ')); }
    delete t.capacity;
    out.push(validateSchema().filter((e) => /capacity/.test(e)).join(' | '));
    return out;
  });
  expect(errs[0]).toContain('must be a ref column');
  expect(errs[1]).toContain('must be a number column');
  expect(errs[1]).toContain('"nope" is not a column');
  expect(errs[2]).toContain('`holds` must be a non-empty list');
  expect(errs[3]).toBe('');
});

test('Lookup is offered to whoever can change something in it, not to a member who can only read', async ({ page }) => {
  await setup(page);
  await bootAs(page, 'ann@x');
  expect(await page.evaluate(() => appInstance.sidebarTabs.some((t) => t.id === '__lookup'))).toBe(false);
  await bootAs(page, 'org@x');
  expect(await page.evaluate(() => appInstance.sidebarTabs.some((t) => t.id === '__lookup'))).toBe(true);
});

test('closeBefore: booking from anywhere stops before the start, and reopens for a member at the venue', async ({ page, browser }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns[0] = { name: 'date', type: 'datetime' };
  schema.tables.rsvps.columns.push({ name: 'checkin_code', type: 'text' });
  schema.tables.rsvps.ownerWritable.push('checkin_code');
  Object.assign(schema.views[0].rsvp, { closeBefore: 30, checkin: { codeColumn: 'checkin_code', set: { attendance: 'attended' }, link: 'submit' } });
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'viewer', user: 'ann@x', tables: { practices: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { rsvp_status: ['coming', 'out'], attendance_status: ['pending', 'attended', 'absent'] } }, headers: ADMIN });
  // Noon today, fixed in the member's browser: "20 minutes from now" must stay TODAY, which it is not
  // when the suite runs at 23:50 -- and the venue reopens only today's events.
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  const at = (min) => new Date(noon.getTime() + min * 60000).toISOString();
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'soon', date: at(20), title: 'Soon' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'later', date: at(120), title: 'Later' } }, headers: ADMIN });

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.clock.setFixedTime(noon);
  await bootAs(p, 'ann@x');
  const row = (title) => p.locator('tr', { hasText: title });
  // From home: 20 minutes before is inside the window, so it says where to book; two hours is not.
  await expect(row('Soon').locator('[data-testid="rsvp-places"]')).toHaveText('rsvp.closed');
  await expect(row('Soon').locator('button', { hasText: 'coming' })).toBeDisabled();
  await expect(row('Later').locator('button', { hasText: 'coming' })).toBeEnabled();

  // At the gym: the venue's link reopens today's closing event, and booking it checks her in.
  const link = new URL(await p.evaluate(() => appInstance.scanDeepLink('my_rsvp', 'heron')));
  await p.goto('/' + link.search);
  await p.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await expect(row('Soon').locator('button', { hasText: 'coming' })).toBeEnabled();
  await row('Soon').locator('button', { hasText: 'coming' }).click();
  const stored = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'rsvps', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => [r.practice, r.checkin_code || '']);
  await expect.poll(stored).toEqual([['soon', 'heron']]);
  await ctx.close();
});

test('validateSchema: closeBefore needs a datetime dateColumn', async ({ page }) => {
  await setup(page);
  await bootAs(page, 'org@x');
  const err = await page.evaluate(() => { VIEWS.my_rsvp.rsvp.closeBefore = 30; const e = validateSchema().join(' | '); delete VIEWS.my_rsvp.rsvp.closeBefore; return e; });
  expect(err).toContain('`closeBefore` needs `dateColumn` to be a datetime column');
});

test('booking from a calendar (respond), and the booking on my own calendar through its event\'s date', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.rsvps.columns.push({ name: 'practice_date', type: 'date', computed: { lookup: { table: 'practices', match: 'practice', on: 'id', field: 'date' } } });
  schema.views.push(
    { name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'practices', dateColumn: 'date', titleColumns: ['title'], respond: 'my_rsvp' }], defaultView: 'list' } },
    { name: 'mine_cal', kind: 'calendar', calendar: { sources: [{ table: 'rsvps', dateColumn: 'practice_date', titleColumns: ['practice'], label: 'Booked', filter: { response: 'coming' } }], defaultView: 'list' } }
  );
  schema.nav.items.push({ view: 'timetable' }, { view: 'mine_cal' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('timetable'));
  const book = page.locator('[data-testid="cal-book"]').first();
  await book.locator('button', { hasText: 'coming' }).click();
  await expect.poll(async () => (await stored(page)).map((r) => [r.owner, r.response])).toEqual([['ann@x', 'coming']]);
  // Never stored: the derived date rides on reads only.
  expect((await stored(page))[0].practice_date).toBeUndefined();
  await page.evaluate(() => appInstance.selectTab('mine_cal'));
  await expect.poll(() => page.evaluate(() => { const e = appInstance.calEventsFor('mine_cal', { from: '2000-01-01', to: '2100-01-01' }); return Object.keys(e).filter((k) => e[k].length); })).toEqual([future]);
});

test('validateSchema: a calendar source can only respond through an rsvp view over its own table', async ({ page }) => {
  await setup(page);
  await bootAs(page, 'org@x');
  const err = await page.evaluate(() => {
    VIEWS.bad_cal = { name: 'bad_cal', calendar: { sources: [{ table: 'rsvps', dateColumn: 'note', respond: 'my_rsvp' }] } };
    const e = validateSchema().join(' | '); delete VIEWS.bad_cal; return e;
  });
  expect(err).toContain('books events of "practices", not this source');
});

test('a calendar list starts today, orders a day by time and shows it; range settings are for admins', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns[0] = { name: 'date', type: 'datetime' };
  schema.views.push({ name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'practices', dateColumn: 'date', titleColumns: ['title'], respond: 'my_rsvp' }], defaultView: 'list' } });
  schema.nav.items.push({ view: 'timetable' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  for (const [id, title, when] of [['late', 'Late', at(1, 19)], ['early', 'Early', at(1, 7)], ['past', 'Yesterday', at(-1, 12)]]) {
    await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id, date: when, title } }, headers: ADMIN });
  }
  await page.request.post('/api/deleteRow', { data: { tableId: 'practices', tab: 'active', id: 'p1' }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('timetable'));
  const rows = page.locator('[data-testid="cal-book"]').locator('xpath=..');
  await expect(rows).toHaveCount(2);                      // yesterday's is not listed
  await expect(rows.first()).toContainText('Early');      // 07:00 before 19:00
  await expect(page.locator('[data-testid="cal-event-time"]').first()).toContainText('07');
  await expect(page.locator('[data-testid="cal-window"]')).toHaveCount(0);
});

test('calendar filters: pick values of a column to narrow the events, remembered in the browser', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns.push({ name: 'venue', type: 'select', list: 'venues' });
  schema.views.push({ name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'practices', dateColumn: 'date', titleColumns: ['title'] }], defaultView: 'list', filters: ['venue'] } });
  schema.nav.items.push({ view: 'timetable' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { rsvp_status: ['coming', 'out'], attendance_status: ['pending', 'attended', 'absent'], venues: ['North', 'South'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: future, title: 'Tuesday', venue: 'North' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p2', date: future, title: 'Other', venue: 'South' } }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('timetable'));
  const titles = () => page.locator('[data-testid="cal-view"]').innerText();
  await expect.poll(titles).toContain('Other');
  await page.locator('[data-testid="cal-filter-venue"]').click();
  await page.locator('.v-overlay .v-list-item', { hasText: 'North' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(titles).not.toContain('Other');
  await expect.poll(titles).toContain('Tuesday');
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('timetable'));
  await expect.poll(titles).not.toContain('Other');       // remembered
});

test('a viewer adds their own row from a calendar day (self-service is decided before the role)', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.logs = { ownerWritable: ['done_on', 'what'], columns: [{ name: 'owner', type: 'owner' }, { name: 'done_on', type: 'date' }, { name: 'what', type: 'text' }] };
  schema.views.push({ name: 'mycal', kind: 'calendar', calendar: { sources: [{ table: 'logs', dateColumn: 'done_on', titleColumns: ['what'] }], defaultView: 'month', addTo: 'logs' } });
  schema.nav.items.push({ view: 'mycal' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'viewer', user: 'ann@x', tables: { practices: 'r' } }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('mycal'));
  await page.locator('[data-testid="cal-add-on-day"]').click();
  await expect.poll(async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'logs', tab: 'active' }, headers: ADMIN })).json()).rows || []).map((r) => r.owner)).toEqual(['ann@x']);
});

test('a row that lasts (endColumn) is on every day it spans, with its range; a pause blocks booking those days', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.leaves = { ownerWritable: ['starts_on', 'ends_on'], columns: [{ name: 'owner', type: 'owner' }, { name: 'starts_on', type: 'date' }, { name: 'ends_on', type: 'date' }] };
  schema.views[0].rsvp.blockedBy = { table: 'leaves', from: 'starts_on', to: 'ends_on', message: 'On leave' };
  schema.views.push({ name: 'mycal', kind: 'calendar', calendar: { sources: [{ table: 'leaves', dateColumn: 'starts_on', endColumn: 'ends_on', label: 'Leave' }], defaultView: 'list' } });
  schema.nav.items.push({ view: 'mycal' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const day = (n) => { const d = new Date(future + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p2', date: day(5), title: 'After' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'leaves', tab: 'active', data: { id: 'l1', owner: 'ann@x', starts_on: day(-1), ends_on: day(1) } }, headers: ADMIN });
  await bootAs(page, 'ann@x');
  const row = (title) => page.locator('tr', { hasText: title });
  await expect(row('Tuesday').locator('[data-testid="rsvp-places"]')).toHaveText('On leave');
  await expect(row('Tuesday').locator('button', { hasText: 'coming' })).toBeDisabled();
  await expect(row('After').locator('button', { hasText: 'coming' })).toBeEnabled();
  const days = await page.evaluate(() => { const e = appInstance.calEventsFor('mycal', { from: '2000-01-01', to: '2100-01-01' }); return Object.keys(e).filter((k) => e[k].length).sort(); });
  expect(days).toEqual([day(-1), day(0), day(1)]);
  await page.evaluate(() => appInstance.selectTab('mycal'));
  await expect(page.locator('[data-testid="cal-event-range"]').first()).toBeVisible();
});

test('one app clock: a class closes on the calendar left open, without a reload', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns[0] = { name: 'date', type: 'datetime' };
  schema.views[0].rsvp.closeBefore = 30;
  schema.views.push({ name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'practices', dateColumn: 'date', titleColumns: ['title'], respond: 'my_rsvp' }], defaultView: 'list' } });
  schema.nav.items.push({ view: 'timetable' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: new Date(noon.getTime() + 45 * 60000).toISOString(), title: 'Spin' } }, headers: ADMIN });
  await page.clock.install({ time: noon });
  await bootAs(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('timetable'));
  const coming = page.locator('[data-testid="cal-book"]').first().locator('button', { hasText: 'coming' });
  await expect(coming).toBeEnabled();
  await page.clock.fastForward(20 * 60000);               // 25 minutes before: inside closeBefore
  await expect(coming).toBeDisabled();
});

test('a started event: nobody joins or leaves, holder included, and the calendar list moves past it', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns[0] = { name: 'date', type: 'datetime' };
  schema.views.push({ name: 'timetable', kind: 'calendar', calendar: { sources: [{ table: 'practices', dateColumn: 'date', titleColumns: ['title'], respond: 'my_rsvp' }], defaultView: 'list' } });
  schema.nav.items.push({ view: 'timetable' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const noon = new Date(); noon.setHours(12, 0, 0, 0);
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: new Date(noon.getTime() + 10 * 60000).toISOString(), title: 'Spin' } }, headers: ADMIN });
  await page.clock.install({ time: noon });
  await bootAs(page, 'ann@x');
  const row = page.locator('tr', { hasText: 'Spin' });
  await row.locator('button', { hasText: 'coming' }).click();
  await expect.poll(async () => (await stored(page)).map((r) => r.response)).toEqual(['coming']);
  await page.clock.fastForward(15 * 60000);
  await expect(row.locator('[data-testid="rsvp-places"]')).toHaveText('rsvp.started');
  await expect(row.locator('button', { hasText: 'out' })).toBeDisabled();
  await page.evaluate(() => appInstance.selectTab('timetable'));
  await expect(page.locator('[data-testid="cal-view"]')).not.toContainText('Spin');
});

test('staff: walk-ins with − / + take places, and a tap on a booked name marks them arrived', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.practices.columns.push({ name: 'capacity', type: 'number' }, { name: 'booked', type: 'number' }, { name: 'walk_ins', type: 'number' });
  schema.tables.rsvps.capacity = { link: 'practice', status: 'response', column: 'capacity', count: 'booked', reserved: 'walk_ins', holds: ['coming'] };
  Object.assign(schema.views[0].rsvp, { rosterVisibility: 'admins', checkin: { codeColumn: 'note', set: { attendance: 'attended' } } });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'practices', tab: 'active', data: { id: 'p1', date: future, title: 'Tuesday', capacity: 5, booked: 1, walk_ins: 0 } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'rsvps', tab: 'active', data: { id: 'r1', owner: 'ann@x', practice: 'p1', response: 'coming', attendance: 'pending', rosterPublic: false } }, headers: ADMIN });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  await page.evaluate(() => appInstance.selectTab('my_rsvp'));
  const row = page.locator('tr', { hasText: 'Tuesday' });
  await row.locator('[data-testid="count-stepper-plus"]').click();
  await row.locator('[data-testid="count-stepper-plus"]').click();
  await expect(row.locator('[data-testid="count-stepper-value"]')).toHaveText('2');
  await expect(row.locator('[data-testid="rsvp-places"]')).toContainText('2');           // 5 − 1 booked − 2 walk-ins
  const stored = async (t, id) => ((await (await page.request.post('/api/getTableData', { data: { tableId: t, tab: 'active' }, headers: ADMIN })).json()).rows || []).find((r) => r.id === id);
  await expect.poll(async () => (await stored('practices', 'p1')).walk_ins).toBe(2);
  await row.locator('[data-testid="rsvp-arrive"]').click();
  await expect.poll(async () => (await stored('rsvps', 'r1')).attendance).toBe('attended');
  await row.locator('[data-testid="rsvp-arrive"]').click();
  await expect.poll(async () => (await stored('rsvps', 'r1')).attendance).toBe('pending');
});
