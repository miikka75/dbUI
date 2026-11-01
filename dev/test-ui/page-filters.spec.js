// A page's `filters` narrow every view embedded on it (only rows that HAVE the column), and Settings ->
// Users narrows by search, role and linked list.
const { test, expect } = require('./server-fixture');

const ADMIN = { 'X-User': 'org@x' };
const SCHEMA = {
  defaultLanguage: 'en',
  listSources: { coaches: 'userlink' },
  tables: {
    visits: { columns: [{ name: 'venue', type: 'select', list: 'venues' }] },
    sessions: { columns: [{ name: 'venue', type: 'select', list: 'venues' }, { name: 'coach', type: 'select', list: 'coaches' }] }
  },
  views: [
    { name: 'counts', kind: 'stats', sources: ['visits', 'sessions'], mode: 'union', readonly: true,
      stats: { display: 'number', tiles: [{ label: 'v', agg: 'count', when: { coach: { empty: true } } }, { label: 's', agg: 'count', when: { coach: { notEmpty: true } } }] } },
    { name: 'stats', kind: 'page', filters: ['venue', 'coach'], markdown: '{{view:counts}}' }
  ],
  nav: { items: [{ view: 'stats' }] }
};

async function boot(page) {
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', 'org@x'); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
async function setup(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { venues: ['North', 'South'], coaches: ['Kim', 'Lee'] } }, headers: ADMIN });
  const put = (t, data) => page.request.post('/api/putRow', { data: { tableId: t, tab: 'active', data }, headers: ADMIN });
  await put('visits', { id: 'v1', venue: 'North' }); await put('visits', { id: 'v2', venue: 'South' }); await put('visits', { id: 'v3', venue: 'South' });
  await put('sessions', { id: 's1', venue: 'North', coach: 'Kim' }); await put('sessions', { id: 's2', venue: 'South', coach: 'Lee' });
}

test('page filters narrow the embeds: a coach only the rows that have one, a venue both tables', async ({ page }) => {
  await setup(page);
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  const values = () => page.locator('[data-testid="stat-value"]').allInnerTexts();
  await expect.poll(values).toEqual(['3', '2']);
  await page.locator('[data-testid="page-filter-coach"]').click();
  await page.locator('.v-overlay .v-list-item', { hasText: 'Kim' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(values).toEqual(['3', '1']);          // visits have no coach: left alone
  await page.locator('[data-testid="page-filter-venue"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'North' }).click();   // Kim's venue
  await page.keyboard.press('Escape');
  await expect.poll(values).toEqual(['1', '1']);
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect.poll(values).toEqual(['1', '1']);          // remembered in this browser
});

test('a ref filter reached only through a lookup lists its catalogue', async ({ page }) => {
  await setup(page);
  const schema = {
    defaultLanguage: 'en',
    tables: {
      kinds: { isLookup: true, columns: [{ name: 'kind', type: 'text' }] },
      classes: { columns: [{ name: 'kind', type: 'ref', table: 'kinds', valueCol: 'kind' }] },
      bookings: { columns: [{ name: 'class', type: 'ref', table: 'classes', valueCol: 'id' },
        { name: 'kind', computed: { lookup: { table: 'classes', match: 'class', on: 'id', field: 'kind' } } }] }
    },
    views: [
      { name: 'counts', kind: 'stats', sources: ['bookings'], mode: 'union', readonly: true, stats: { display: 'number', tiles: [{ label: 'n', agg: 'count' }] } },
      { name: 'stats', kind: 'page', filters: ['kind'], markdown: '{{view:counts}}' }
    ],
    nav: { items: [{ view: 'stats' }] }
  };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const put = (t, data) => page.request.post('/api/putRow', { data: { tableId: t, tab: 'active', data }, headers: ADMIN });
  await put('kinds', { id: 'k1', kind: 'Yoga' });
  await put('classes', { id: 'c1', kind: 'Yoga' });
  await put('bookings', { id: 'b1', class: 'c1' });
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await page.locator('[data-testid="page-filter-kind"]').click();
  await expect(page.locator('.v-overlay .v-list-item', { hasText: 'Yoga' })).toBeVisible();
});

test('Settings users: search, role and linked-list filters narrow the list', async ({ page }) => {
  await setup(page);
  for (const [u, role] of [['ann@x', 'viewer'], ['bob@x', 'viewer'], ['kim@x', 'viewer'], ['ed@x', 'editor']]) {
    await page.request.post('/api/setUserRole', { data: { uid: u, role, user: u, tables: {} }, headers: ADMIN });
  }
  await page.request.post('/api/setListUser', { data: { listName: 'coaches', value: 'Kim', email: 'kim@x' }, headers: ADMIN });
  await boot(page);
  await page.evaluate(() => { appInstance.selectTab('__settings'); appInstance.settings._collapseUsers = false; });
  const count = page.locator('[data-testid="users-count"]');
  await expect(count).toHaveText('5 / 5');
  await page.locator('[data-testid="users-search"] input').fill('bo');
  await expect(count).toHaveText('1 / 5');
  await page.locator('[data-testid="users-search"] input').fill('');
  await page.evaluate(() => { appInstance.userFilter.roles = ['viewer']; });
  await expect(count).toHaveText('3 / 5');
  await page.evaluate(() => { appInstance.userFilter.lists = ['coaches']; });
  await expect(count).toHaveText('1 / 5');
});

test('Approve grants the schema\'s newUser access: a viewer with the tables it names', async ({ page }) => {
  await setup(page);
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.newUser = { role: 'viewer', tables: { visits: 'r' } };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await boot(page);
  const mine = await page.evaluate(async () => {
    localStorage.setItem('test_user', 'newbie@x');
    await backend_users.requestAccess('New Bie', '');
    localStorage.setItem('test_user', 'org@x');
    await appInstance.approveRequest({ email: 'newbie@x', name: 'New Bie' });
    localStorage.setItem('test_user', 'newbie@x');
    const m = await backend_users.getMyAccess();
    localStorage.setItem('test_user', 'org@x');
    return m;
  });
  expect(mine.role).toBe('viewer');
  expect(JSON.stringify(mine.tables)).toContain('visits');
  const err = await page.evaluate(() => validateRefs({ tables: { visits: { columns: [] } }, views: [], newUser: { role: 'admin', tables: ['nope'] } }).join(' | '));
  expect(err).toContain('cannot be "admin"');
  expect(err).toContain('missing table "nope"');
});

test('a filter on a filterBy ref offers each value once', async ({ page }) => {
  await setup(page);
  const schema = {
    defaultLanguage: 'en',
    tables: {
      gyms: { isLookup: true, columns: [{ name: 'gym', type: 'text' }] },
      rooms: { isLookup: true, columns: [{ name: 'gym', type: 'ref', table: 'gyms', valueCol: 'gym' }, { name: 'room', type: 'text' }] },
      classes: { columns: [{ name: 'gym', type: 'ref', table: 'gyms', valueCol: 'gym' },
        { name: 'room', type: 'ref', table: 'rooms', valueCol: 'room', filterBy: { gym: 'gym' } }] }
    },
    views: [
      { name: 'counts', kind: 'stats', sources: ['classes'], mode: 'union', readonly: true, stats: { display: 'number', tiles: [{ label: 'n', agg: 'count' }] } },
      { name: 'stats', kind: 'page', filters: ['room'], markdown: '{{view:counts}}' }
    ],
    nav: { items: [{ view: 'stats' }] }
  };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const put = (t, data) => page.request.post('/api/putRow', { data: { tableId: t, tab: 'active', data }, headers: ADMIN });
  await put('gyms', { id: 'g1', gym: 'North' }); await put('gyms', { id: 'g2', gym: 'South' });
  await put('rooms', { id: 'r1', gym: 'North', room: 'Hall' }); await put('rooms', { id: 'r2', gym: 'South', room: 'Hall' });
  await put('rooms', { id: 'r3', gym: 'North', room: 'Studio' });
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await page.locator('[data-testid="page-filter-room"]').click();
  await expect.poll(() => page.locator('.v-overlay .v-list-item').allInnerTexts()).toEqual(['Hall', 'Studio']);
});

// The filters narrow one another: pick a gym and the rooms and classes offered are the ones held there.
test('a page\'s filters offer only what the other picks leave', async ({ page }) => {
  await setup(page);
  const schema = {
    defaultLanguage: 'en',
    tables: {
      gyms: { isLookup: true, columns: [{ name: 'gym', type: 'text' }] },
      rooms: { isLookup: true, hierarchy: { parent: 'gym', value: 'room' }, columns: [{ name: 'gym', type: 'ref', table: 'gyms', valueCol: 'gym' }, { name: 'room', type: 'text' }] },
      kinds: { isLookup: true, columns: [{ name: 'kind', type: 'text' }] },
      classes: { columns: [{ name: 'gym', type: 'ref', table: 'gyms', valueCol: 'gym' },
        { name: 'room', type: 'ref', table: 'rooms', valueCol: 'room', filterBy: { gym: 'gym' } },
        { name: 'kind', type: 'ref', table: 'kinds', valueCol: 'kind' }] }
    },
    views: [
      { name: 'counts', kind: 'stats', sources: ['classes'], mode: 'union', readonly: true, stats: { display: 'number', tiles: [{ label: 'n', agg: 'count' }] } },
      { name: 'stats', kind: 'page', filters: ['gym', 'room', 'kind'], markdown: '{{view:counts}}' }
    ],
    nav: { items: [{ view: 'stats' }] }
  };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const put = (t, data) => page.request.post('/api/putRow', { data: { tableId: t, tab: 'active', data }, headers: ADMIN });
  for (const [id, gym] of [['g1', 'North'], ['g2', 'South']]) await put('gyms', { id, gym });
  for (const [id, gym, room] of [['r1', 'North', 'Hall'], ['r2', 'North', 'Studio'], ['r3', 'South', 'Hall']]) await put('rooms', { id, gym, room });
  for (const [id, kind] of [['k1', 'Yoga'], ['k2', 'Spin'], ['k3', 'Pump']]) await put('kinds', { id, kind });
  await put('classes', { id: 'c1', gym: 'North', room: 'Studio', kind: 'Spin' });
  await put('classes', { id: 'c2', gym: 'North', room: 'Hall', kind: 'Pump' });
  await put('classes', { id: 'c3', gym: 'South', room: 'Hall', kind: 'Yoga' });
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  const options = async (col) => {
    await page.locator('[data-testid="page-filter-' + col + '"]').click();
    const items = page.locator('.v-overlay--active .v-list-item');
    await items.first().waitFor();
    const out = await items.allInnerTexts();
    await page.keyboard.press('Escape');
    await page.locator('.v-overlay--active').waitFor({ state: 'detached' }).catch(() => {});
    return out.map((t) => t.trim()).sort();
  };
  await expect.poll(() => options('kind')).toEqual(['Pump', 'Spin', 'Yoga']);
  await page.locator('[data-testid="page-filter-gym"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'South' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => options('room')).toEqual(['Hall']);
  await expect.poll(() => options('kind')).toEqual(['Yoga']);
  await page.locator('[data-testid="page-filter-gym"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'North' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="page-filter-room"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'Studio' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(() => options('kind')).toEqual(['Spin']);
  await expect.poll(() => options('gym')).toEqual(['North', 'South']);   // South stays: it is picked
});

// Comparing: the live picks saved as rows, one line of the page's tiles each, kept in this browser.
test('comparison rows: the picks saved as rows, each with its own numbers, kept and removed', async ({ page }) => {
  await setup(page);
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect(page.locator('[data-testid="compare-table"]')).toHaveCount(0);
  await page.locator('[data-testid="compare-add"]').click();                 // nothing picked: the baseline
  await page.locator('[data-testid="page-filter-coach"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'Kim' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="compare-add"]').click();
  await page.locator('[data-testid="compare-add"]').click();                 // the same question again: not added
  await page.locator('[data-testid="page-filter-coach"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'Kim' }).click();   // off
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'Lee' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="page-filter-venue"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'South' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="compare-add"]').click();
  const table = async () => (await page.locator('[data-testid="compare-row"]').allInnerTexts()).map((t) => t.split(/\s+/).join(' ').trim());
  const all = await page.evaluate(() => appInstance.t('settings.all'));
  // visits are left alone by a coach pick, and narrowed by a venue one
  await expect.poll(table).toEqual([all + ' 3 2', 'Kim 3 1', 'South · Lee 2 1']);
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect.poll(table).toEqual([all + ' 3 2', 'Kim 3 1', 'South · Lee 2 1']);   // kept with the page
  // A tile's header sorts by its number, a second click reverses; the choice survives a reload.
  await page.locator('[data-testid="compare-sort-1"]').click();
  await expect.poll(table).toEqual(['Kim 3 1', 'South · Lee 2 1', all + ' 3 2']);   // a tie keeps the added order
  await page.locator('[data-testid="compare-sort-0"]').click();
  await expect.poll(table).toEqual(['South · Lee 2 1', all + ' 3 2', 'Kim 3 1']);
  await page.locator('[data-testid="compare-sort-0"]').click();
  await expect.poll(table).toEqual([all + ' 3 2', 'Kim 3 1', 'South · Lee 2 1']);
  await expect(page.locator('[data-testid="compare-sort-0"]')).toHaveAttribute('aria-sort', 'descending');
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect(page.locator('[data-testid="compare-sort-0"]')).toHaveAttribute('aria-sort', 'descending');
  const kim = page.locator('[data-testid="compare-row"]', { hasText: 'Kim' }).locator('button');
  await kim.click(); await kim.click();                                      // two presses
  await expect.poll(table).toEqual([all + ' 3 2', 'South · Lee 2 1']);
});

test('copy events: a filtered range copied forward, once however often it runs', async ({ page }) => {
  await setup(page);
  const schema = {
    defaultLanguage: 'en',
    tables: {
      sessions: { archivable: true, columns: [{ name: 'starts_at', type: 'datetime' }, { name: 'venue', type: 'select', list: 'venues' },
        { name: 'booked', type: 'number', default: 0 }] }
    },
    views: [
      { name: 'list', kind: 'data', sources: ['sessions'], mode: 'union', columns: ['starts_at', 'venue', 'booked'], copy: { dateColumn: 'starts_at', reset: ['booked'] } },
      { name: 'sched', kind: 'page', filters: ['venue'], markdown: '{{view:list}}' }
    ],
    nav: { items: [{ view: 'sched' }] }
  };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const put = (data) => page.request.post('/api/putRow', { data: { tableId: 'sessions', tab: 'active', data }, headers: ADMIN });
  const at = (d, h) => new Date(2026, 9, d, h).toISOString();
  await put({ id: 's1', starts_at: at(12, 7), venue: 'North', booked: 5 });
  await put({ id: 's2', starts_at: at(13, 18), venue: 'North', booked: 2, _status: 'archive' });   // filed away: still copied
  await put({ id: 's3', starts_at: at(14, 9), venue: 'South', booked: 1 });
  await boot(page);
  await page.evaluate(() => { appInstance.selectTab('sched'); appInstance.setPagePick('venue', ['North']); });
  const open = async () => {
    await page.locator('[data-testid="copy-events"]').click();
    await page.locator('[data-testid="copy-from"] input').fill('2026-10-12');
    await page.locator('[data-testid="copy-to"] input').fill('2026-10-18');
    await page.locator('[data-testid="copy-target"] input').fill('2026-10-26');
  };
  await open();
  await expect(page.locator('[data-testid="copy-count"]')).toHaveText('2');
  // The end follows a start moved past it, and its picker starts there.
  await page.locator('[data-testid="copy-from"] input').fill('2026-10-20');
  await expect(page.locator('[data-testid="copy-to"] input')).toHaveValue('2026-10-20');
  await expect(page.locator('[data-testid="copy-to"] input')).toHaveAttribute('min', '2026-10-20');
  await page.locator('[data-testid="copy-from"] input').fill('2026-10-12');
  await expect(page.locator('[data-testid="copy-to"] input')).toHaveValue('2026-10-20');   // an earlier start leaves it
  await page.locator('[data-testid="copy-to"] input').fill('2026-10-18');
  await page.locator('[data-testid="count-stepper-plus"]').click();               // twice: 26 Oct and 2 Nov
  await expect(page.locator('[data-testid="copy-count"]')).toHaveText('4');
  await page.locator('[data-testid="copy-run"]').click();
  const rows = async () => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'sessions', tab: 'active' }, headers: ADMIN })).json()).rows || []);
  await expect.poll(async () => (await rows()).length).toBe(7);
  const copies = (await rows()).filter((r) => !['s1', 's2', 's3'].includes(r.id));
  expect(copies.every((r) => r.venue === 'North' && Number(r.booked || 0) === 0 && !r._status)).toBe(true);
  expect(copies.map((r) => new Date(r.starts_at).getHours()).sort()).toEqual([18, 18, 7, 7].sort());
  await open();                                                                      // again (the dialog keeps times: 2): all there already
  await expect(page.locator('[data-testid="copy-count"]')).toHaveText('0');
  await expect(page.locator('[data-testid="copy-skipped"]')).toHaveText('4');
  await expect(page.locator('[data-testid="copy-run"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.evaluate(() => appInstance.undoLast());
  await expect.poll(async () => (await rows()).length).toBe(3);                      // one undo, the whole copy
});

test('a page search narrows its lists, by email or by the name on screen', async ({ page }) => {
  await setup(page);
  const schema = {
    defaultLanguage: 'en',
    tables: { members: { columns: [{ name: 'owner', type: 'owner' }, { name: 'status', type: 'select', list: 'venues' }] } },
    views: [
      { name: 'mlist', kind: 'data', sources: ['members'], mode: 'union', columns: ['owner', 'status'] },
      { name: 'mcount', kind: 'stats', sources: ['members'], mode: 'union', readonly: true, stats: { display: 'number', tiles: [{ label: 'n', agg: 'count' }] } },
      { name: 'mdesk', kind: 'page', filters: ['status'], search: ['owner'], markdown: '{{view:mcount}}\n\n{{view:mlist}}' }
    ],
    nav: { items: [{ view: 'mdesk' }] }
  };
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  const put = (data) => page.request.post('/api/putRow', { data: { tableId: 'members', tab: 'active', data }, headers: ADMIN });
  await put({ id: 'm1', owner: 'ann@x', status: 'North' });
  await put({ id: 'm2', owner: 'bob@x', status: 'South' });
  await put({ id: 'm3', owner: 'cid@x', status: 'North' });
  await page.request.post('/api/setMyProfile', { data: { name: 'Bobby Tables', shared: true }, headers: { 'X-User': 'bob@x' } });
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('mdesk'));
  const shown = () => page.evaluate(() => appInstance.pageSearched(appInstance.embedRows('view', 'mlist'), 'mlist').map((r) => r.owner).sort());
  await expect.poll(shown).toEqual(['ann@x', 'bob@x', 'cid@x']);
  await page.locator('[data-testid="view-search"] input').fill('cid');
  await expect.poll(shown).toEqual(['cid@x']);
  await page.locator('[data-testid="view-search"] input').fill('bobby');                    // the profile name, not the email
  await expect.poll(shown).toEqual(['bob@x']);
  await expect(page.locator('[data-testid="stat-value"]')).toHaveText('3');                  // tiles read every row
  await page.locator('[data-testid="view-search"] input').fill('');
  await page.evaluate(() => appInstance.setPagePick('status', ['North']));
  await expect.poll(shown).toEqual(['ann@x', 'cid@x']);
});

test('comparison rows an editor adds are the page\'s; a viewer sees them and keeps their own', async ({ page }) => {
  await setup(page);
  await page.request.post('/api/setUserRole', { data: { uid: 'v@x', role: 'viewer', user: 'v@x', tables: ['visits', 'sessions'] }, headers: ADMIN });
  await boot(page);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await page.locator('[data-testid="compare-add"]').click();
  const rows = page.locator('[data-testid="compare-row"]');
  await expect(rows).toHaveCount(1);
  // Stored on the page's own doc, beside (not instead of) its body.
  await expect.poll(async () => {
    const d = await (await page.request.post('/api/getTableData', { data: { tableId: '_pages', tab: 'active' }, headers: ADMIN })).json();
    return ((d.rows || []).find((r) => r.id === 'stats') || {}).compare?.length;
  }).toBe(1);

  await page.addInitScript(() => localStorage.setItem('test_user', 'v@x'));   // runs after boot's, so it wins
  await page.reload();
  await page.waitForFunction(() => window.appInstance && !appInstance.loading);
  await page.evaluate(() => appInstance.selectTab('stats'));
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('button')).toHaveCount(0);              // the page's row: not theirs to remove
  await page.locator('[data-testid="page-filter-coach"]').click();
  await page.locator('.v-overlay--active .v-list-item', { hasText: 'Kim' }).click();
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="compare-add"]').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('button')).toHaveCount(1);               // their own, in this browser
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('page_compare:stats')).length)).toBe(1);
});
