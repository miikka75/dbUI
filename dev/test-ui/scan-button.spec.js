// The scan button (`nav.scan`): one button for every code the app prints. The QR names its own view, a
// typed code goes to the view picked in the dialog, and either SAVES -- the person pointing the camera
// is the intent, where a forwarded deep link only arms the box.
//
// The browser here has no BarcodeDetector, which is the iPhone/Windows case: the button opens the
// typing dialog. The camera's half is the same routeScan a decoded picture is handed to, called directly.
const { test, expect } = require('./server-fixture');

const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    ref_doors: { isLookup: true, hierarchy: false, columns: [{ name: 'door', type: 'text' }, { name: 'code', type: 'text' }] },
    visits: {
      ownerWritable: ['door', 'seen_on'],
      columns: [{ name: 'owner', type: 'owner' }, { name: 'door', type: 'ref', table: 'ref_doors', valueCol: 'door' }, { name: 'seen_on', type: 'date' }]
    },
    classes: { columns: [{ name: 'date', type: 'date' }, { name: 'title', type: 'text' }] },
    bookings: {
      ownerWritable: ['class', 'booking', 'checkin_code'],
      ownerWritableWhile: { attendance: 'pending' },
      columns: [{ name: 'owner', type: 'owner' }, { name: 'class', type: 'ref', table: 'classes', valueCol: 'id' },
                { name: 'booking', type: 'select', list: 'booking_status' }, { name: 'checkin_code', type: 'text' },
                { name: 'attendance', type: 'select', list: 'attendance_status', default: 'pending' }]
    }
  },
  views: [
    { name: 'door', kind: 'scan', sources: ['visits'], mode: 'union', columns: ['seen_on', 'door'],
      scan: { column: 'door', codeCol: 'code', set: { seen_on: '@today' }, label: 'Door code' } },
    { name: 'book', kind: 'rsvp', rsvp: { events: 'classes', dateColumn: 'date', titleColumns: ['title'], responses: 'bookings',
      statusColumn: 'booking', picker: 'toggle', checkin: { codeColumn: 'checkin_code', set: { attendance: 'attended' } } } },
    { name: 'home', kind: 'page', markdown: '# Home' }
  ],
  nav: { items: [{ view: 'home' }, { view: 'book' }], fab: 'scan', scan: ['door', 'book'] }
};
const ADMIN = { 'X-User': 'org@x' };
const ymd = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

async function setup(page, schema) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'viewer', user: 'ann@x', tables: { classes: 'r', ref_doors: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema: schema || SCHEMA }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { booking_status: ['booked'], attendance_status: ['pending', 'attended'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'ref_doors', tab: 'active', data: { id: 'd1', door: 'Front', code: 'FRONT-1' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'classes', tab: 'active', data: { id: 'c1', date: ymd(new Date()), title: 'Spin' } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'bookings', tab: 'active', data: { id: 'b1', owner: 'ann@x', class: 'c1', booking: 'booked', attendance: 'pending', checkin_code: '', rosterPublic: false } }, headers: ADMIN });
}
async function boot(page, user) {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.addInitScript((u) => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', u); }, user);
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
const rows = async (page, table) => ((await (await page.request.post('/api/getTableData', { data: { tableId: table, tab: 'active' }, headers: ADMIN })).json()).rows || []);

test('scan button: a typed door code logs a visit, a typed check-in code checks in -- both without a second press', async ({ page }) => {
  await setup(page);
  await boot(page, 'ann@x');
  const fab = page.locator('[data-testid="scan-fab"]');
  await expect(fab).toBeVisible();

  await fab.click();
  await page.locator('[data-testid="scan-typed"] input').fill('FRONT-1');
  await page.locator('[data-testid="scan-typed-go"]').click();
  await expect.poll(async () => (await rows(page, 'visits')).map((r) => r.door)).toEqual(['Front']);

  // No choice of which code it is: a changing code starts with its destination's tag -- the second
  // entry of nav.scan is "B" -- and the printed door code above was found in the door catalogue.
  await fab.click();
  await expect(page.locator('[data-testid="scan-pick"]')).toHaveCount(0);
  await page.locator('[data-testid="scan-typed"] input').fill('bk7pqm');
  await page.locator('[data-testid="scan-typed-go"]').click();
  await expect.poll(async () => (await rows(page, 'bookings')).map((r) => r.checkin_code)).toEqual(['bk7pqm']);

  // A code that is neither is refused, with the field left open to try again.
  await fab.click();
  await page.locator('[data-testid="scan-typed"] input').fill('ZZZZZZ');
  await page.locator('[data-testid="scan-typed-go"]').click();
  expect(await page.evaluate(() => appInstance.scanNote)).toBe('scan.unknown');
});

test('scan button: a QR names its own view; a link to another site is refused', async ({ page }) => {
  await setup(page);
  await boot(page, 'ann@x');
  // The button covers check-in here, so Ann has no box of her own on the booking page.
  await page.evaluate(() => appInstance.selectTab('book'));
  await expect(page.locator('[data-testid="rsvp-checkin"]')).toBeAttached();
  await expect(page.locator('[data-testid="rsvp-checkin-claim"]')).toHaveCount(0);
  // What the camera would hand over: the room's QR, a link to the check-in view.
  await page.evaluate(() => appInstance.routeScan(location.origin + '/?view=book&scan=heron', null));
  await expect.poll(async () => (await rows(page, 'bookings')).map((r) => r.checkin_code)).toEqual(['heron']);
  expect(await page.evaluate(() => appInstance.currentTable)).toBe('book');

  await page.evaluate(() => appInstance.routeScan('https://elsewhere.example/?view=door&scan=FRONT-1', null));
  await expect(page.locator('[data-testid="scan-dialog"]')).toBeVisible();
  expect(await page.evaluate(() => appInstance.scanNote)).toBe('scan.foreign');
  expect(await rows(page, 'visits')).toEqual([]);
});

test('scan button: absent without nav.scan, and validateSchema names a view that takes no code', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  delete schema.nav.scan; delete schema.nav.fab;
  await setup(page, schema);
  await boot(page, 'org@x');
  await expect(page.locator('[data-testid="scan-fab"]')).toHaveCount(0);
  const err = await page.evaluate(() => validateRefs({ tables: SCHEMA, views: [{ name: 'home', markdown: '# x' }], nav: { items: [], scan: ['home', 'nope'] } }).join(' | '));
  expect(err).toContain('scan view "home" takes no code');
  expect(err).toContain('missing view "nope"');
});

test('the corner button is the screen\'s: nav.fab sets the default, a view\'s own `fab` overrides it', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.views.find((v) => v.name === 'book').fab = 'none';
  await setup(page, schema);
  await boot(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('home'));
  await expect(page.locator('[data-testid="scan-fab"]')).toBeVisible();
  await page.evaluate(() => appInstance.selectTab('book'));
  await expect(page.locator('[data-testid="scan-fab"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="add-fab"]')).toHaveCount(0);
  const err = await page.evaluate(() => validateRefs({ tables: SCHEMA, views: [{ name: 'x', fab: 'jump' }], nav: { items: [], fab: 'scan' } }).join(' | '));
  expect(err).toContain('`fab` is "jump"');
  expect(err).toContain('`fab: "scan"` needs `nav.scan`');
});

test('door code that changes (scan.verify): the door screen shows it, the member claims it, the screen confirms and names the door', async ({ page, browser }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  const visits = schema.tables.visits;
  visits.columns.push({ name: 'door_code', type: 'text' }, { name: 'verified', type: 'text' });
  visits.ownerWritable = ['seen_on', 'door_code'];
  schema.views[0].scan.verify = { claim: 'door_code', set: { verified: 'yes' }, rotateMinutes: 5 };
  await setup(page, schema);
  await page.request.post('/api/putRow', { data: { tableId: 'ref_doors', tab: 'active', data: { id: 'd2', door: 'Back', code: 'BACK-1' } }, headers: ADMIN });

  // The door screen: staff, at the Back door, showing the code. Its clock is the test's, so the 15 s
  // stamping can be run on demand.
  await page.clock.install();
  await boot(page, 'org@x');
  await page.evaluate(() => appInstance.selectTab('door'));
  await page.locator('[data-testid="scan-door"]').click();
  await page.locator('.v-overlay .v-list-item', { hasText: 'Back' }).click();
  await page.locator('[data-testid="scan-door-qr"]').click();
  const code = (await page.locator('[data-testid="qr-dialog-caption"]').innerText()).trim();
  expect(code).toMatch(/^A[A-Z2-9]{5}$/);   // the door is nav.scan's first entry, so its codes start "A"

  // The member: the printed code of old is now just a claim nobody confirms; the screen's code is not.
  const ctx = await browser.newContext();
  const ann = await ctx.newPage();
  await boot(ann, 'ann@x');
  // Typed off the screen, with no word about which code it is: the tag takes it to the door.
  await ann.locator('[data-testid="scan-fab"]').click();
  await ann.locator('[data-testid="scan-typed"] input').fill(code);
  await ann.locator('[data-testid="scan-typed-go"]').click();
  await expect(ann.locator('[data-testid="scan-outcome"]')).toHaveAttribute('data-outcome', 'claimed');
  await expect.poll(async () => (await rows(page, 'visits')).map((r) => [r.door_code, r.verified || '', r.door || ''])).toEqual([[code, '', '']]);

  // Within one 15 s round the screen confirms it, and records where.
  await page.clock.runFor(16000);
  await expect.poll(async () => (await rows(page, 'visits')).map((r) => [r.verified, r.door])).toEqual([['yes', 'Back']]);
  await ctx.close();
});

test('validateSchema: a door screen\'s verdict cannot be the member\'s to write', async ({ page }) => {
  await setup(page);
  await boot(page, 'org@x');
  const err = await page.evaluate(() => {
    SCHEMA.visits.ownerWritable = ['door', 'seen_on', 'door_code', 'verified'];
    SCHEMA.visits.columns.door_code = { type: 'text' }; SCHEMA.visits.columns.verified = { type: 'text' };
    VIEWS.door.scan.verify = { claim: 'door_code', set: { verified: 'yes' } };
    return validateSchema().join(' | ');
  });
  expect(err).toContain('"verified" is in ownerWritable');
  expect(err).toContain('"door" is in ownerWritable');
});

test('with no `fab` anywhere, the corner button is Add on a phone, as it always was', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  delete schema.nav.scan; delete schema.nav.fab;
  schema.views.push({ name: 'all_classes', sources: ['classes'], columns: ['date', 'title'] });
  schema.nav.items.push({ view: 'all_classes' });
  await setup(page, schema);
  await boot(page, 'org@x');
  await page.evaluate(() => appInstance.selectTab('all_classes'));
  await expect(page.locator('[data-testid="add-fab"]')).toBeVisible();
  await expect(page.locator('[data-testid="scan-fab"]')).toHaveCount(0);
});

test('a page names its own activity: { add: view } adds a row there, { open: view } goes there, and nothing usable means no button', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  delete schema.nav.fab;
  schema.views.push(
    { name: 'my_visits', sources: ['visits'], columns: ['seen_on', 'door'] },
    { name: 'log_page', kind: 'page', markdown: '{{view:my_visits}}', fab: { add: 'my_visits', label: 'Log a visit' } },
    { name: 'go_page', kind: 'page', markdown: '# Go', fab: { open: 'book', label: 'Book' } },
    { name: 'class_list', sources: ['classes'], columns: ['date', 'title'], readonly: true, fab: { add: 'class_list', label: 'Add class' } }
  );
  schema.nav.items.push({ view: 'log_page' }, { view: 'go_page' }, { view: 'class_list' });
  await setup(page, schema);
  await boot(page, 'ann@x');
  const fab = page.locator('[data-testid="action-fab"]');

  await page.evaluate(() => appInstance.selectTab('log_page'));
  await expect(fab).toHaveText('Log a visit');
  await fab.click();
  await expect.poll(() => page.evaluate(() => (appInstance.dataCache.visits || []).length)).toBe(1);

  await page.evaluate(() => appInstance.selectTab('go_page'));
  await fab.click();
  expect(await page.evaluate(() => appInstance.currentTable)).toBe('book');

  // A read-only class list Ann cannot add to: the button would do nothing, so there is none.
  await page.evaluate(() => appInstance.selectTab('class_list'));
  await expect(fab).toHaveCount(0);
  await page.evaluate(() => appInstance.selectTab('home'));
  await expect(fab).toHaveCount(0);
  await expect(page.locator('[data-testid="scan-fab"]')).toHaveCount(0);

  const err = await page.evaluate(() => validateRefs({ tables: SCHEMA, views: [{ name: 'x', fab: { add: 'nope' } }, { name: 'y', fab: { add: 'x', open: 'x' } }], nav: { items: [] } }).join(' | '));
  expect(err).toContain('`fab.add` names missing view "nope"');
  expect(err).toContain('`fab` object names one activity');
});

test('blockedBy: on a day inside my own pause, the door scan and the class check-in are refused, with the reason', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.leaves = { ownerWritable: ['starts_on', 'ends_on'], columns: [{ name: 'owner', type: 'owner' }, { name: 'starts_on', type: 'date' }, { name: 'ends_on', type: 'date' }] };
  const blk = { table: 'leaves', from: 'starts_on', to: 'ends_on', message: 'On leave' };
  schema.views[0].scan.blockedBy = blk;
  schema.views[1].rsvp.blockedBy = blk;
  await setup(page, schema);
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  await page.request.post('/api/putRow', { data: { tableId: 'leaves', tab: 'active', data: { id: 'l1', owner: 'ann@x', starts_on: day(-2), ends_on: day(4) } }, headers: ADMIN });
  await boot(page, 'ann@x');
  await page.locator('[data-testid="scan-fab"]').click();
  await page.locator('[data-testid="scan-typed"] input').fill('FRONT-1');
  await page.locator('[data-testid="scan-typed-go"]').click();
  await expect(page.locator('[data-testid="scan-outcome"]')).toHaveAttribute('data-outcome', 'blocked');
  await expect(page.locator('[data-testid="scan-outcome"]')).toContainText('On leave');
  await page.locator('[data-testid="scan-fab"]').click();
  await page.locator('[data-testid="scan-typed"] input').fill('bk7pqm');
  await page.locator('[data-testid="scan-typed-go"]').click();
  await page.evaluate(() => appInstance.selectTab('book'));
  // She booked before the pause: leaving stays open, but the check-in claim is not saved.
  await expect(page.locator('[data-testid="rsvp-toggle"]').first()).toBeVisible();
  expect((await rows(page, 'visits')).length).toBe(0);
  expect((await rows(page, 'bookings')).map((r) => r.checkin_code)).toEqual(['']);
  // validateSchema names a period it cannot read.
  const err = await page.evaluate(() => { VIEWS.door.scan.blockedBy = { table: 'leaves', from: 'nope' }; const e = validateSchema().join(' | '); return e; });
  expect(err).toContain('`from` "nope" is not a column of "leaves"');
});
