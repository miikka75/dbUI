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
