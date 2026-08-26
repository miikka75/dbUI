// The boot READ BUDGET — a count, not a clock.
//
// Boot cost IS the Firestore bill: every document read while the app starts is billed, on the free
// plan's scarcest quota. Several phases of work went into making boot lazy — `bootData` returns
// `data: {}` on all three backends, and a view loads its own tables when it OPENS, through
// `_ensureCached`. None of that was pinned by anything: `boot-time.spec.js` asserted elapsed
// milliseconds, and a regression that reintroduced "fetch every granted table at boot" would pass it
// (a fixture database is small — reading all of it is fast) and show up as a bigger invoice.
//
// So this spec counts reads instead. It counts them at the TRANSPORT — a `fetch` wrapper installed
// before any app code runs — rather than by spying on `backend.getTableData`, so it still counts if
// the adapter is refactored, and it can record whether each call happened before or after boot
// finished by reading `window.__bootMs` synchronously at call time.
//
// Not the only guard, and deliberately a different one. app.spec.js's `lazy boot` describe already
// asserts that nothing outside the landing view is CACHED after boot — read off `dataCache`, which is
// the effect. This asserts the reads themselves, which the cache cannot show: a table fetched twice and
// cached once passes there and fails here, and so does a navigation that re-reads what it already
// holds. Cache state answers "what did we end up with"; a read count answers "what did we pay for", and
// on Firestore only the second one is the bill.
//
// The fixture schema has six tables. The landing view reaches three of them. That gap is the whole
// assertion: the three untouched tables are what lazy boot buys, and the day someone re-adds a boot
// preload they will be read here.
const { test, expect } = require('./server-fixture');
const SCHEMA = require('./fixture-schema.json');

// The first nav leaf is the `attendance` view (nav: combined > attendance), whose sources are `tasks`
// and `notes`; `cities` comes with them because `tasks.city` is a ref into it (_ensureDeps). Named
// individually rather than counted so a change of landing view fails with the reason, not a number.
const LANDING_TABLES = ['tasks', 'notes', 'cities'];
const UNREACHED_TABLES = ['crew_rotation', 'signups', 'tickets'];

// Record every /api/ POST at the transport. The boot/afterwards split is deliberately NOT taken from
// a timestamp: `window.__bootMs` is written by a Vue watcher on `loading`, which flushes a tick after
// `loading` is set, and `_autoSelectTab()` runs its fetches synchronously in between. The landing
// view's reads therefore land "before" the marker while being caused by the view, not by boot. What
// boot itself fetched is read from the boot PAYLOAD instead (see the first test).
async function countReads(page) {
  await page.addInitScript(() => {
    window.__apiCalls = [];
    const realFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/') !== -1) {
          let body = null;
          try { body = JSON.parse((init && init.body) || 'null'); } catch (e) {}
          window.__apiCalls.push({
            op: url.slice(url.indexOf('/api/') + 5),
            table: (body && body.tableId) || '',
            tab: (body && body.tab) || '',
          });
        }
      } catch (e) {}
      return realFetch.apply(this, arguments);
    };
  });
}

async function bootLocalApp(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'tasks', tab: 'active', data: { id: 't1', date: '2026-01-05', title: 'Task one', status: 'open', assigned_to: 'ann' } } });
  await page.request.post('/api/putRow', { data: { tableId: 'notes', tab: 'active', data: { id: 'n1', date: '2026-01-06', title: 'Note one', author: 'bob' } } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await countReads(page);
  await page.goto('/');
  // Boot is finished when the app says so, and settled when the landing view has painted rows — a
  // view that rendered nothing would also have read nothing, so waiting for content is what makes
  // "only three tables were read" mean "only three tables were NEEDED".
  await page.waitForFunction(() => window.__bootMs != null, null, { timeout: 20000 });
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  await expect(page.locator('.v-table tbody tr').first()).toBeVisible();
}

const tableReads = (calls) => calls.filter((c) => c.op === 'getTableData' && c.table && c.table[0] !== '_');

test('boot itself carries NO table data', async ({ page }) => {
  test.setTimeout(60000);
  const payloads = [];
  page.on('response', async (r) => {
    if (r.url().indexOf('/api/bootData') === -1) return;
    try { payloads.push(await r.json()); } catch (e) {}
  });
  await bootLocalApp(page);

  // One boot, one payload, and its `data` is empty. All three backends return `data: {}` from
  // bootData for the same reason (see the note in backend-firebase.js): the alternative read the
  // active partition of every granted table before a single view opened. This is the assertion that
  // fails the day a preload is put back — and unlike a clock, it fails on a fast machine too.
  expect(payloads.length, 'expected exactly one bootData round-trip').toBe(1);
  expect(Object.keys(payloads[0].data || {}), 'bootData returned table rows — boot is preloading again').toEqual([]);
});

test('the landing view reads its own tables, once each, and no others', async ({ page }) => {
  test.setTimeout(60000);
  await bootLocalApp(page);
  const reads = tableReads(await page.evaluate(() => window.__apiCalls));
  const readTables = reads.map((c) => c.table);

  // Exactly the landing view's tables — no more (a preload) and no fewer (a table the view needed but
  // never asked for renders blank).
  expect([...new Set(readTables)].sort()).toEqual([...LANDING_TABLES].sort());
  for (const t of UNREACHED_TABLES) {
    expect(readTables, t + ' was read although no open view names it').not.toContain(t);
  }

  // Once each. A table read twice is the double-read this codebase already paid for once, when a
  // table was fetched AND subscribed (see firebase-emulator.spec.js).
  const seen = reads.map((c) => c.table + '|' + c.tab);
  expect(seen.length, 'a table partition was read more than once: ' + seen.join(', ')).toBe(new Set(seen).size);
});

test('opening a second view reads only what it adds', async ({ page }) => {
  test.setTimeout(60000);
  await bootLocalApp(page);
  await page.evaluate(() => { window.__apiCalls.length = 0; });

  // `tickets_board` is the only nav item over a table the landing view does not reach.
  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'view.tickets_board' }).first().click();
  await expect.poll(async () => page.evaluate(
    () => (window.__apiCalls || []).some((c) => c.op === 'getTableData' && c.table === 'tickets')
  ), { timeout: 6000 }).toBe(true);

  const after = tableReads(await page.evaluate(() => window.__apiCalls)).map((c) => c.table);
  // The tables already in dataCache are not read again — _ensureCached skips what is cached, which is
  // what makes navigation cheap after the first visit.
  for (const t of LANDING_TABLES) {
    expect(after, t + ' was re-read on navigation although it was already cached').not.toContain(t);
  }
});
