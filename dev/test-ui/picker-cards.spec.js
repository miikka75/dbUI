// `picker: "cards"` -- a ref column's catalogue rows as cards, used in place of the dropdown -- in the
// shape the gym uses it: a member's `once: false` form, embedded in a page. That shape also pins two form
// bugs it surfaced: the form must find the record it just started, and its submit must write the FORM's
// table rather than whatever screen is open.
const { test, expect } = require('./server-fixture');

const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    ref_rewards: { isLookup: true, hierarchy: false, columns: [{ name: 'reward', type: 'text' }, { name: 'cost', type: 'number' }] },
    claims: {
      ownerWritable: ['reward', 'sent'],
      columns: [{ name: 'owner', type: 'owner' }, { name: 'reward', type: 'ref', table: 'ref_rewards', valueCol: 'reward', picker: 'cards' },
                { name: 'sent', type: 'text', hidden: true }]
    }
  },
  views: [
    { name: 'claim_form', kind: 'form', form: { table: 'claims', columns: ['reward'], required: ['reward'], once: false,
      submitColumn: 'sent', submitValue: 'yes', startLabel: 'Claim a reward', submitLabel: 'Claim' } },
    { name: 'shop', kind: 'page', markdown: '# Shop\n\n{{view:claim_form}}' }
  ],
  nav: { items: [{ view: 'shop' }] }
};
const ADMIN = { 'X-User': 'org@x' };

async function setup(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/setUserRole', { data: { uid: 'org@x', role: 'admin', user: 'org@x', tables: 'all' } });
  await page.request.post('/api/setUserRole', { data: { uid: 'ann@x', role: 'viewer', user: 'ann@x', tables: { ref_rewards: 'r' } }, headers: ADMIN });
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA }, headers: ADMIN });
  for (const [id, reward, cost] of [['r1', 'Bottle', 1700], ['r2', 'Day pass', 300]]) {
    await page.request.post('/api/putRow', { data: { tableId: 'ref_rewards', tab: 'active', data: { id, reward, cost } }, headers: ADMIN });
  }
}
async function boot(page, user) {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.addInitScript((u) => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('test_user', u); }, user);
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 30000 });
}
const claims = async (page) => ((await (await page.request.post('/api/getTableData', { data: { tableId: 'claims', tab: 'active' }, headers: ADMIN })).json()).rows || [])
  .map((r) => [r.reward || '', r.sent || '']);

test('a member chooses a card and submits; the next claim starts fresh', async ({ page }) => {
  test.setTimeout(30000);
  await setup(page);
  await boot(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('shop'));

  await page.locator('[data-testid="form-start"]').click();
  const cards = page.locator('[data-testid="pick-card"]');
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: 'Day pass' })).toContainText('300');   // the catalogue's other columns

  await cards.filter({ hasText: 'Day pass' }).click();
  await expect(cards.filter({ hasText: 'Day pass' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-testid="form-submit"]').click();
  await expect.poll(() => claims(page)).toEqual([['Day pass', 'yes']]);

  // Sent: the form is back at its start, and the next claim is a new row, not the old one reopened.
  await expect(page.locator('[data-testid="form-start"]')).toBeVisible();
  await page.locator('[data-testid="form-start"]').click();
  await cards.filter({ hasText: 'Bottle' }).click();
  // Pressing the chosen card again clears it, as a deselected chip does.
  await cards.filter({ hasText: 'Bottle' }).click();
  await expect(cards.filter({ hasText: 'Bottle' })).toHaveAttribute('aria-checked', 'false');
  await cards.filter({ hasText: 'Bottle' }).click();
  await page.locator('[data-testid="form-submit"]').click();
  await expect.poll(async () => (await claims(page)).sort()).toEqual([['Bottle', 'yes'], ['Day pass', 'yes']]);
});

test('validateSchema: a fresh-record form needs a submitColumn to find its draft', async ({ page }) => {
  await setup(page);
  await boot(page, 'org@x');
  const err = await page.evaluate(() => { delete VIEWS.claim_form.form.submitColumn; return validateSchema().join(' | '); });
  expect(err).toContain('`once: false` needs `submitColumn`');
});

test('chips and toggle on a REF column offer the catalogue, like the dropdown would', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.claims.columns[1].picker = 'chips';
  schema.views.push({ name: 'mine', sources: ['claims'], columns: ['reward'] });
  schema.nav.items.push({ view: 'mine' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'claims', tab: 'active', data: { id: 'c1', owner: 'ann@x', reward: '', sent: '' } }, headers: ADMIN });
  await boot(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('mine'));
  const chip = page.locator('.v-chip', { hasText: 'Day pass' }).first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect.poll(() => claims(page)).toEqual([['Day pass', '']]);
});

test('affordability: unaffordable cards are greyed for the member, and the front desk cannot hand over what is not covered', async ({ page }) => {
  test.setTimeout(30000);
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.tables.earnings = { columns: [{ name: 'owner', type: 'owner' }, { name: 'coins', type: 'number' }] };
  schema.tables.claims.columns.push({ name: 'status', type: 'select', list: 'claim_status', default: 'requested' });
  schema.tables.claims.columns[1].enabledWhen = { cost: { lte: { view: 'spendable', field: 'coins' } } };
  const delta = [
    { name: 'delta', source: 'earnings', computed: { lookup: { table: 'earnings', match: 'id', on: 'id', field: 'coins', default: 0 } } },
    { name: 'delta', source: 'claims', scale: -1, computed: { lookup: { table: 'ref_rewards', match: 'reward', on: 'reward', field: 'cost', default: 0 } } }
  ];
  const bal = (name, spent) => ({ name, sources: ['earnings', 'claims'], mode: 'union', groupBy: { column: 'owner', from: ['owner'] }, compute: delta,
    aggregate: { sum: 'delta', into: 'coins' }, columns: ['owner', 'coins'], filter: { $or: [{ coins: { notEmpty: true } }, spent] }, readonly: true });
  schema.views.push(bal('spendable', { sent: 'yes' }), bal('handed', { status: 'granted' }));
  schema.views.push({ name: 'desk', kind: 'board', sources: ['claims'], mode: 'join', columns: ['owner',
      { name: 'cost', computed: { lookup: { table: 'ref_rewards', match: 'reward', on: 'reward', field: 'cost', default: 0 } } },
      { name: 'balance', computed: { lookup: { view: 'handed', match: 'owner', on: 'owner', field: 'coins', default: 0 } } }],
    board: { lane: 'status', lanes: ['requested', 'granted'], title: 'reward', laneWhen: { granted: { balance: { gte: { col: 'cost' } } } } } });
  schema.nav.items.push({ view: 'desk' });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await page.request.post('/api/saveLists', { data: { lists: { claim_status: ['requested', 'granted'] } }, headers: ADMIN });
  await page.request.post('/api/putRow', { data: { tableId: 'earnings', tab: 'active', data: { id: 'e1', owner: 'ann@x', coins: 500 } }, headers: ADMIN });

  // Ann has 500: the 300 day pass may be chosen, the 1700 bottle may not.
  await boot(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('shop'));
  await page.locator('[data-testid="form-start"]').click();
  const card = (t) => page.locator('[data-testid="pick-card"]', { hasText: t });
  await expect(card('Bottle')).toHaveAttribute('aria-disabled', 'true');
  await expect(card('Day pass')).toHaveAttribute('aria-disabled', 'false');
  await card('Bottle').click({ force: true });   // pressed anyway: nothing is chosen
  await expect(card('Bottle')).toHaveAttribute('aria-checked', 'false');

  // Two claims arrive at the desk: one covered, one not (written as staff, past the member's screen).
  for (const [id, reward] of [['ok', 'Day pass'], ['big', 'Bottle']]) {
    await page.request.post('/api/putRow', { data: { tableId: 'claims', tab: 'active', data: { id, owner: 'ann@x', reward, sent: 'yes', status: 'requested' } }, headers: ADMIN });
  }
  await boot(page, 'org@x');
  await page.evaluate(() => appInstance.selectTab('desk'));
  const move = async (id) => { await page.locator('[data-testid="board-move-' + id + '"]').click(); return page.locator('.v-overlay--active .v-list-item', { hasText: 'granted' }).last(); };
  const big = await move('big');
  await expect(big).toHaveClass(/v-list-item--disabled/);
  await page.keyboard.press('Escape');
  const ok = await move('ok');
  await ok.click();
  const status = async () => Object.fromEntries(((await (await page.request.post('/api/getTableData', { data: { tableId: 'claims', tab: 'active' }, headers: ADMIN })).json()).rows || []).filter((r) => r.id === 'ok' || r.id === 'big').map((r) => [r.id, r.status]));
  await expect.poll(status).toEqual({ ok: 'granted', big: 'requested' });
});

test('form rules: a computed value shows in the form, and submit waits until every rule holds', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  Object.assign(schema.views[0].form, {
    columns: ['reward', 'price'],
    compute: [{ name: 'price', computed: { lookup: { table: 'ref_rewards', match: 'reward', on: 'reward', field: 'cost' } } }],
    rules: [{ require: { price: { lt: 1000 } }, message: 'Too dear' }]
  });
  await setup(page);
  await page.request.post('/api/saveSchema', { data: { schema }, headers: ADMIN });
  await boot(page, 'ann@x');
  await page.evaluate(() => appInstance.selectTab('shop'));
  await page.locator('[data-testid="form-start"]').click();
  await page.locator('[data-testid="pick-card"]', { hasText: 'Bottle' }).click();
  await expect(page.locator('[data-testid="form-computed"][data-col="price"]')).toContainText('1700');
  await expect(page.locator('[data-testid="form-rule"]')).toHaveText('Too dear');
  await expect(page.locator('[data-testid="form-submit"]')).toBeDisabled();
  await page.locator('[data-testid="pick-card"]', { hasText: 'Day pass' }).click();
  await expect(page.locator('[data-testid="form-rule"]')).toHaveCount(0);
  await page.locator('[data-testid="form-submit"]').click();
  await expect.poll(() => claims(page)).toEqual([['Day pass', 'yes']]);
});
