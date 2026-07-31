const { test, expect } = require('@playwright/test');
const SCHEMA = require('./fixture-schema.json');

// Fail any test on an uncaught page/console error (mirrors app.spec.js) — this also guards the
// board-view component template from silently throwing at render time.
let _consoleErrors = [];
test.beforeEach(({ page }) => {
  _consoleErrors = [];
  page.on('pageerror', e => _consoleErrors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource|\b404\b|net::ERR|ERR_/.test(m.text())) _consoleErrors.push('console: ' + m.text()); });
});
test.afterEach(() => { expect(_consoleErrors, 'console/page errors during test').toEqual([]); });

async function seedBoard(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  // Seed three tickets across two lanes so grouping + re-homing are observable (tickets is a
  // standalone table, so the board is mutable — unlike a mirror-detail table).
  const rows = [
    { id: 'tk1', title: 'Alpha', status: 'open', assignee: 'Sam' },
    { id: 'tk2', title: 'Beta', status: 'in_progress', assignee: 'Ada' },
    { id: 'tk3', title: 'Gamma', status: 'open', assignee: 'Sam' }
  ];
  for (const r of rows) await page.request.post('/api/putRow', { data: { tableId: 'tickets', data: r, tab: 'active' } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  await page.locator('.v-navigation-drawer .v-list-item', { hasText: 'tickets_board' }).first().click();
  await page.waitForSelector('[data-testid="board-view"]', { timeout: 6000 });
}

test.describe('Board (kanban) view', () => {
  test('renders lanes with cards grouped by the lane column', async ({ page }) => {
    await seedBoard(page);
    // All three declared lanes render (done is empty but declared via board.lanes).
    await expect(page.locator('[data-testid="board-lane-open"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-lane-in_progress"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-lane-done"]')).toBeVisible();
    // Cards land in the right lane.
    await expect(page.locator('[data-testid="board-lane-open"] [data-testid="board-card-tk1"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-lane-open"] [data-testid="board-card-tk3"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-lane-in_progress"] [data-testid="board-card-tk2"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-card-tk1"]')).toContainText('Alpha');
  });

  test('move-menu re-homes a card and persists the lane column', async ({ page }) => {
    await seedBoard(page);
    // Move Alpha (tk1) from "open" to "done" via the card menu (the touch/a11y path; drag is the same write).
    await page.locator('[data-testid="board-card-tk1"] [data-testid="board-move-tk1"]').click();
    await page.locator('.v-overlay .v-list-item', { hasText: 'done' }).first().click();
    // Card re-homes to the done lane in the UI.
    await expect(page.locator('[data-testid="board-lane-done"] [data-testid="board-card-tk1"]')).toBeVisible();
    await expect(page.locator('[data-testid="board-lane-open"] [data-testid="board-card-tk1"]')).toHaveCount(0);
    // And persists to the tasks table (saveField debounces; poll the server).
    await expect.poll(async () => {
      const s = await (await page.request.post('/api/getTableData', { data: { tableId: 'tickets', tab: 'active' } })).json();
      const rows = (s.rows || s.data || s || []);
      const r = (Array.isArray(rows) ? rows : []).find(x => x.id === 'tk1');
      return r && r.status;
    }, { timeout: 5000 }).toBe('done');
  });
});
