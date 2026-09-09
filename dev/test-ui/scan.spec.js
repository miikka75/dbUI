// `test` comes from the fixture, not from Playwright directly: it spawns this worker's own dev
// server and points baseURL at it. See test-ui/server-fixture.js.
const { test, expect } = require('./server-fixture');

// The `scan` view end to end: a code typed into the box becomes a row, and every refusal is visible.
// This is the shape phase 1 ships in — no camera anywhere, because a handheld barcode scanner is a
// keyboard and this is what it types into. A patrol route rather than the chores bundle, since that is
// the arrangement `once` exists for.
const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    ref_controls: {
      isLookup: true, hierarchy: false,
      columns: [{ name: 'control', type: 'text' }, { name: 'code', type: 'text' }]
    },
    visits: {
      ownerWritable: ['control', 'seen_on'],
      columns: [
        { name: 'owner', type: 'owner' },
        { name: 'control', type: 'ref', table: 'ref_controls', valueCol: 'control' },
        { name: 'seen_on', type: 'date' },
        { name: 'created_at', type: 'text', hidden: true },
        { name: 'updated_at', type: 'text', hidden: true }
      ]
    }
  },
  views: [{
    name: 'walk', sources: ['visits'], mode: 'union', kind: 'scan',
    columns: ['seen_on', 'control'],
    scan: { column: 'control', codeCol: 'code', set: { seen_on: '@today' }, once: 'day' }
  }, {
    // The same route, on a deployment that has decided a deep-linked code may log itself.
    name: 'walk_auto', sources: ['visits'], mode: 'union', kind: 'scan',
    columns: ['seen_on', 'control'],
    scan: { column: 'control', codeCol: 'code', set: { seen_on: '@today' }, link: 'submit' }
  }, {
    // The box on the page it writes into, rather than a tab of its own — which is what the chores
    // bundle does, and the reason `walk_auto` below is deliberately NOT in the nav.
    name: 'walk_page', kind: 'page',
    markdown: ['## Round', '', '{{view:walk}}'].join('\n')
  }],
  nav: { items: [{ view: 'walk' }, { view: 'walk_page' }] }
};

async function boot(page, user) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/?user=' + encodeURIComponent(user));
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}

// Open the view and wait for every table it needs — which for a scan view is the log AND the catalogue
// its codes resolve against. If _viewTables did not pull the lookup in, this wait would pass with an
// empty catalogue and every scan below would report an unknown code.
const open = async (page, name) => {
  await page.evaluate((n) => window.appInstance.selectTab(n), name);
  await page.waitForFunction((n) => {
    const a = window.appInstance;
    return a && !a.loading && (a._viewTables(n) || []).every((t) => Array.isArray(a.dataCache[t]));
  }, name, { timeout: 10000 });
};

// Type a code and press Enter, exactly as a wedge scanner does.
async function scan(page, code) {
  await page.locator('[data-testid="scan-code"] input').fill(code);
  await page.locator('[data-testid="scan-code"] input').press('Enter');
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
}
// Open the Lookup editor and EXPAND one catalogue. The rows live inside a collapsed v-list-group, so
// selecting the table is not enough — a person clicks the group open, and so does this.
async function openLookup(page, table) {
  await page.evaluate(() => window.appInstance.selectTab('__lookup'));
  await page.locator('.v-list-item:has([data-testid="ref-print-' + table + '"])').first().click();
  await expect(page.locator('[data-testid^="ref-print-row-"]').first()).toBeVisible();
}
const outcome = (page) => page.locator('[data-testid="scan-outcome"]').getAttribute('data-outcome');
const visits = (page) => page.evaluate(() => (appInstance.dataCache.visits || []).length);

async function setup(page, extraControls = []) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  const controls = [
    { id: 'c1', control: 'Back door', code: 'CP-01' },
    { id: 'c2', control: 'Roof hatch', code: 'CP-02' }
  ].concat(extraControls);
  for (const data of controls) {
    await page.request.post('/api/putRow', { data: { tableId: 'ref_controls', tab: 'active', data } });
  }
  await boot(page, 'guard@dev');
  await open(page, 'walk');
}

test('a typed code appends an owned row, and the box clears for the next one', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  expect(await visits(page)).toBe(0);

  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('created');

  const row = await page.evaluate(() => appInstance.dataCache.visits[0]);
  expect(row.control).toBe('Back door');          // the stored value, not the code
  expect(row.owner).toBe('guard@dev');            // stamped by the ordinary create path
  expect(row.seen_on).toBe(appInstanceToday());   // @today, resolved at scan time
  expect(await page.inputValue('[data-testid="scan-code"] input')).toBe('');

  // The scan is listed back, so the row is visibly recorded rather than only claimed.
  await expect(page.locator('[data-testid="scan-view"] .v-list-item')).toHaveCount(1);
});

// Evaluated in Node, not the page: the date the app stamps is the machine's local date, and the test
// runs on the same machine.
function appInstanceToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

test('a code nobody printed is refused, and writes nothing', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await scan(page, 'CP-99');
  expect(await outcome(page)).toBe('unknown');
  expect(await visits(page)).toBe(0);
});

test('case and a scanner trailing whitespace are not part of a code', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await scan(page, '  cp-02  ');
  expect(await outcome(page)).toBe('created');
  expect(await page.evaluate(() => appInstance.dataCache.visits[0].control)).toBe('Roof hatch');
});

test('`once: day` refuses the second scan of a door and says so', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('created');

  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('already');
  expect(await visits(page)).toBe(1);              // refused, not appended
  // The first time is on screen: "already, at 02:14" is actionable where "that did not work" is not.
  await expect(page.locator('[data-testid="scan-outcome"]')).toContainText(/\d{1,2}[:.]\d{2}/);

  // A different door on the same round still records.
  await scan(page, 'CP-02');
  expect(await outcome(page)).toBe('created');
  expect(await visits(page)).toBe(2);
});

test('two catalogue rows sharing a code refuse rather than guess a door', async ({ page }) => {
  test.setTimeout(90000);
  // A catalogue where two controls carry one code — a label reprinted onto the wrong post.
  await setup(page, [{ id: 'c3', control: 'Cellar', code: 'CP-01' }]);

  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('ambiguous');
  expect(await visits(page)).toBe(0);
});

test('the catalogue prints as a sheet of scannable labels', async ({ page }) => {
  test.setTimeout(90000);
  // A third control whose code Code 39 cannot carry — `#` is outside its 43 characters. A QR carries a
  // URL, so this one gets a code too; before the encoder was vendored it got a "cannot be printed" note.
  await setup(page, [{ id: 'c3', control: 'Loading bay', code: 'BAY #1' }]);

  // Capture what would be printed instead of opening a print window.
  await page.evaluate(() => {
    window.__printed = null;
    appInstance._printOpen = (title, body) => { window.__printed = { title, body }; };
  });
  // The sheet is printed from the LOOKUP editor, where the catalogue rows live — a label belongs to the
  // row it names, not to the view that happens to read it.
  await page.evaluate(() => appInstance.selectTab('__lookup'));
  await page.locator('[data-testid="ref-print-ref_controls"]').click();
  // The window opens only after the QR encoder resolves, so the sheet is never printed half-drawn.
  await expect.poll(() => page.evaluate(() => !!window.__printed)).toBe(true);
  const printed = await page.evaluate(() => window.__printed);

  expect(printed).not.toBeNull();
  expect((printed.body.match(/class="label"/g) || []).length).toBe(3);
  // The barcode carries the CODE, and the name people read is printed above it.
  expect(printed.body).toContain('<b>Back door</b>');
  expect(printed.body).toContain('<code>CP-01</code>');
  // QR, not Code 39, on all three — a QR is the one a phone camera can act on, because it carries the
  // deep link. Squareness is what tells them apart: a QR's viewBox is N x N, Code 39's is always W x 46.
  const svgs = [...printed.body.matchAll(/viewBox="0 0 (\d+) (\d+)"/g)];
  expect(svgs).toHaveLength(3);
  for (const [, w, h] of svgs) expect(w).toBe(h);
  expect(printed.body).not.toContain('scan.no_barcode');

  // The QR ENCODES the link rather than printing it, so what the sheet carries is checked at its
  // source: the URL the phone's camera will open.
  const link = await page.evaluate(() => appInstance.scanDeepLink('walk', 'BAY #1'));
  expect(link).toContain('view=walk');
  expect(link).toContain('scan=BAY%20%231');
});

test('the encoder is fetched only when something needs to draw a code, never at boot', async ({ page }) => {
  test.setTimeout(90000);
  // Observed rather than intercepted: this asserts WHEN the file is fetched, and a route that rewrote
  // the response would be testing something else.
  const asked = [];
  page.on('request', (r) => { if (/\/vendor\/qrcode\.js$/.test(r.url())) asked.push(r.url()); });
  await setup(page);
  // 56 KB of vendored third party that a deployment which never prints a sheet must not pay for.
  expect(asked).toHaveLength(0);

  await page.evaluate(() => { window.__p = null; appInstance._printOpen = (t, b) => { window.__p = b; }; });
  await page.evaluate(() => appInstance.selectTab('__lookup'));
  await page.locator('[data-testid="ref-print-ref_controls"]').click();
  await expect.poll(() => page.evaluate(() => !!window.__p)).toBe(true);
  expect(asked).toHaveLength(1);

  // ...and only once, however many sheets are printed.
  await page.locator('[data-testid="ref-print-ref_controls"]').click();
  await page.waitForTimeout(300);
  expect(asked).toHaveLength(1);
});

test('a printed label scans back to the row it names', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  // What Code 39 puts on the paper is uppercase — the symbology has no lowercase. Typing exactly that
  // has to resolve the catalogue row, or every printed sheet is unusable.
  const onPaper = await page.evaluate(() => window.Scan.code39('cp-02').text);
  expect(onPaper).toBe('CP-02');

  await scan(page, onPaper);
  expect(await outcome(page)).toBe('created');
  expect(await page.evaluate(() => appInstance.dataCache.visits[0].control)).toBe('Roof hatch');
});

test('a ?scan= deep link arms the box with the code, on the view it names', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'ref_controls', tab: 'active', data: { id: 'c1', control: 'Back door', code: 'CP-01' } } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });

  // What a QR on the door carries. The phone's own camera decodes it and opens this URL.
  await page.goto('/?user=guard%40dev&view=walk&scan=CP-01');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });

  // The link chose the view, and the code is sitting in the box.
  await expect(page.locator('[data-testid="scan-view"]')).toBeVisible();
  expect(await page.evaluate(() => appInstance.currentTable)).toBe('walk');
  expect(await page.inputValue('[data-testid="scan-code"] input')).toBe('CP-01');

  // ARMED, NOT WRITTEN. A link is something anyone can send you; a GET that logs a visit as you is a
  // row somebody else caused, which for a patrol round is the one property the log exists to have.
  expect(await visits(page)).toBe(0);
  await expect(page.locator('[data-testid="scan-outcome"]')).toHaveCount(0);

  // The code is consumed from the address bar, so a reload does not re-arm and the link does not stay
  // in history carrying a code.
  expect(await page.evaluate(() => location.search)).not.toContain('scan=');

  // One deliberate press records it.
  await page.locator('[data-testid="scan-submit"]').click();
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
  expect(await outcome(page)).toBe('created');
  expect(await visits(page)).toBe(1);
});

test('a deep link naming something that is not a scan view is ignored', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  // `view` is honoured only alongside `scan` and only for a scan view — this is a scan contract, not a
  // general routing parameter that a crafted link may point anywhere.
  await page.goto('/?user=guard%40dev&view=ref_controls&scan=CP-01');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
  expect(await page.evaluate(() => appInstance.pendingScan)).toBeNull();
});

// The camera half. `BarcodeDetector` is native where it exists and absent on iOS Safari, Firefox and
// desktop Chrome on Windows — including the browser this suite runs in — so the DECODER itself cannot be
// exercised here. What can be, and is what would actually break, is everything around it: whether the
// button appears at all, what a photograph does to the row, and what each refusal says. The stub stands
// in for exactly one call.
const withDetector = (page, result) => page.addInitScript((r) => {
  window.BarcodeDetector = class {
    constructor(opts) { window.__formats = opts && opts.formats; }
    detect() { return Promise.resolve(r); }
  };
  // createImageBitmap on a text blob would throw in a real browser; the decode never sees the frame.
  window.createImageBitmap = () => Promise.resolve({});
}, result);

const photograph = async (page) => {
  await page.locator('[data-testid="scan-photo"]').setInputFiles({
    name: 'label.png', mimeType: 'image/png', buffer: Buffer.from('not really a png')
  });
};

test('no BarcodeDetector, no camera button — the typed box is the interface everywhere', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  expect(await page.evaluate(() => typeof BarcodeDetector)).toBe('undefined');
  await expect(page.locator('[data-testid="scan-camera"]')).toHaveCount(0);
  // ...and the box still works, which is the point of the camera being an enhancement.
  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('created');
});

test('photographing a printed label logs it, without leaving the page', async ({ page }) => {
  test.setTimeout(90000);
  await withDetector(page, [{ rawValue: 'CP-01' }]);
  await setup(page);

  await expect(page.locator('[data-testid="scan-camera"]')).toBeVisible();
  // A sentinel that a navigation or reload would wipe. Staying on one page is the structural reason
  // this form works with no network -- the app is already loaded and the decode is local -- where the
  // `?scan=` link is a fresh navigation and needs the network to load the app at all. (The queue-and-
  // flush half of that is the backend's offline cache, which the local dev server does not have, so it
  // is not asserted here.)
  await page.evaluate(() => { window.__stillHere = true; });
  await photograph(page);
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
  expect(await page.evaluate(() => window.__stillHere)).toBe(true);

  // Pointing a camera at a label IS the intent, so this submits rather than arming — unlike a link.
  expect(await outcome(page)).toBe('created');
  expect(await page.evaluate(() => appInstance.dataCache.visits[0].control)).toBe('Back door');
  // Both symbologies the app itself produces are asked for.
  expect(await page.evaluate(() => window.__formats)).toEqual(['code_39', 'qr_code']);
});

test('photographing a QR that carries the deep link does the write here, not in a second copy of the app', async ({ page }) => {
  test.setTimeout(90000);
  await withDetector(page, [{ rawValue: 'https://app.example/?view=walk&scan=CP-02' }]);
  await setup(page);
  await photograph(page);
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
  expect(await outcome(page)).toBe('created');
  expect(await page.evaluate(() => appInstance.dataCache.visits[0].control)).toBe('Roof hatch');
  expect(await page.evaluate(() => location.href)).not.toContain('app.example');
});

test('a picture with no code, and one with several, each say which', async ({ page }) => {
  test.setTimeout(90000);
  await withDetector(page, []);
  await setup(page);
  await photograph(page);
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
  expect(await outcome(page)).toBe('no_code_found');
  expect(await visits(page)).toBe(0);

  // Choosing one of several would log a door nobody aimed at.
  await page.evaluate(() => { window.BarcodeDetector = class { detect() { return Promise.resolve([{ rawValue: 'CP-01' }, { rawValue: 'CP-02' }]); } }; });
  await photograph(page);
  await expect(page.locator('[data-testid="scan-outcome"][data-outcome="several_codes"]')).toBeVisible();
  expect(await visits(page)).toBe(0);
});

test('`link: "submit"` logs a deep-linked code with no press', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'ref_controls', tab: 'active', data: { id: 'c1', control: 'Back door', code: 'CP-01' } } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });

  await page.goto('/?user=guard%40dev&view=walk_auto&scan=CP-01');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });

  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible();
  expect(await outcome(page)).toBe('created');
  expect(await visits(page)).toBe(1);
  expect(await page.evaluate(() => appInstance.dataCache.visits[0].owner)).toBe('guard@dev');
});

test('an auto-submitting link waits for every table the view reads, instead of racing them', async ({ page }) => {
  test.setTimeout(90000);
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  await page.request.post('/api/putRow', { data: { tableId: 'ref_controls', tab: 'active', data: { id: 'c1', control: 'Back door', code: 'CP-01' } } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });

  // Hold BOTH tables back so the view mounts with neither. Submitting into that gap breaks two ways,
  // and the second is the one that bites: the catalogue missing reports a perfectly good code as
  // unknown, and the LOG missing means `once` cannot see an earlier scan AND the in-flight fetch
  // replaces dataCache on arrival — so the row vanishes from the screen while still reaching the
  // backend, leaving the two disagreeing. A person pressing the button has already waited; this is the
  // failure only an automatic submit can have.
  await page.route('**/api/getRows', async (route) => {
    const body = route.request().postData() || '';
    if (body.includes('ref_controls') || body.includes('visits')) await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  await page.goto('/?user=guard%40dev&view=walk_auto&scan=CP-01');
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible({ timeout: 20000 });
  expect(await outcome(page)).toBe('created');
  // The row survives in the cache rather than being overwritten by the fetch that was still running.
  expect(await visits(page)).toBe(1);
  await expect(page.locator('[data-testid="scan-view"] .v-list-item')).toHaveCount(1);
});

test('embedded in a page, the box writes the row and leaves the listing to the page', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await page.evaluate(() => appInstance.selectTab('walk_page'));
  await page.waitForFunction(() => {
    const a = window.appInstance;
    return a && !a.loading && (a._viewTables('walk_page') || []).every((t) => Array.isArray(a.dataCache[t]));
  }, null, { timeout: 10000 });

  await expect(page.locator('[data-testid="scan-view"]')).toBeVisible();
  // No rows of its own: the page composes what goes around the box, and the outcome alert already
  // says the scan registered. Same reason the print action is top-level only.
  await expect(page.locator('[data-testid="scan-view"] .v-list-item')).toHaveCount(0);

  await scan(page, 'CP-01');
  expect(await outcome(page)).toBe('created');
  expect(await visits(page)).toBe(1);
});

test('a view with no nav tab still answers a deep link — the link names the VIEW, not the tab', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  const tabs = await page.evaluate(() => appInstance.sidebarTabs.filter((t) => !t.divider).map((t) => t.id));
  expect(tabs).not.toContain('walk_auto');          // it is defined, but nowhere in the sidebar

  await page.goto('/?user=guard%40dev&view=walk_auto&scan=CP-01');
  await expect(page.locator('[data-testid="scan-outcome"]')).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => appInstance.currentTable)).toBe('walk_auto');
  expect(await outcome(page)).toBe('created');
});

test('one catalogue row prints one label, from the row itself', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await page.evaluate(() => { window.__p = null; appInstance._printOpen = (t, b) => { window.__p = { t, b }; }; });
  await openLookup(page, 'ref_controls');
  await page.locator('[data-testid="ref-print-row-c1"]').click();
  await expect.poll(() => page.evaluate(() => !!window.__p)).toBe(true);
  const printed = await page.evaluate(() => window.__p);

  // One label, for that row only — the catalogue has two.
  expect((printed.b.match(/class="label"/g) || []).length).toBe(1);
  expect(printed.b).toContain('<b>Back door</b>');
  expect(printed.b).not.toContain('Roof hatch');
  // Printed under the name of the thing it labels, and with no heading: an <h2> repeating the one word
  // already on the label is noise on a sticker.
  expect(printed.t).toBe('Back door');
  expect(printed.b).not.toContain('<h2>');
});

test('a lookup nothing scans offers no per-row printer', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await openLookup(page, 'ref_controls');
  await expect(page.locator('[data-testid="ref-print-row-c1"]')).toBeVisible();
  // `visits` is not a lookup and nothing resolves codes against it; the button is offered per CATALOGUE.
  expect(await page.evaluate(() => appInstance.scanViewForCatalog('visits'))).toBe('');
});
