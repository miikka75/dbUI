const { test, expect } = require('@playwright/test');

// Reset DB before each test for isolation
test.beforeEach(async ({ request }) => {
  await request.post('/api/resetData');
});

// Helper: complete setup if needed and wait for app to be fully ready
async function ensureAppReady(page) {
  await page.goto('/');
  // Wait for Vue to mount (nav drawer appears)
  await page.waitForSelector('.v-navigation-drawer', { timeout: 15000 });
  // If setup dialog appears, complete it
  const setupBtn = page.locator('button:has-text("Create Local Database")');
  try {
    await setupBtn.waitFor({ state: 'visible', timeout: 3000 });
    await setupBtn.click();
  } catch(e) { /* already set up */ }
  // Wait for data table or card to appear (startApp completed)
  await page.waitForSelector('.v-table, .v-main .v-card', { timeout: 20000 });
}

test.describe('App boot', () => {
  test('loads and shows first view tab', async ({ page }) => {
    await ensureAppReady(page);
    await expect(page.locator('.v-app-bar-title')).toContainText('Drive Sync App');
    const items = page.locator('.v-navigation-drawer .v-list-item');
    await expect(items.first()).toBeVisible();
  });

  test('shows sidebar tabs for views and system tabs', async ({ page }) => {
    await ensureAppReady(page);
    const items = page.locator('.v-navigation-drawer .v-list-item');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(5);
  });
});

test.describe('Data table', () => {
  test('add row creates a new row', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(300);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(1);
  });

  test('edit cell saves value', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(500);
    const cell = page.locator('.v-table .editable-cell').first();
    await cell.click();
    await page.keyboard.type('TestValue');
    await cell.blur();
    await page.waitForTimeout(800);
    await page.reload();
    await ensureAppReady(page);
    await expect(page.locator('.v-table')).toContainText('TestValue');
  });

  test('delete row removes it', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(300);
    page.on('dialog', d => d.accept());
    await page.locator('button:has(.mdi-delete-outline)').first().click();
    await page.waitForTimeout(300);
    const rows = page.locator('.v-table tbody tr');
    await expect(rows).toHaveCount(0);
  });
});

test.describe('Archive / Restore', () => {
  test('archive moves row to archived view', async ({ page }) => {
    await ensureAppReady(page);
    const rowsBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(rowsBefore + 1);
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(rowsBefore);
    // Switch to archived view
    await page.locator('.v-btn-toggle button:has-text("Archived")').click();
    await page.waitForTimeout(1000);
    const archivedRows = await page.locator('.v-table tbody tr').count();
    expect(archivedRows).toBeGreaterThanOrEqual(1);
  });

  test('restore moves row back to active', async ({ page }) => {
    await ensureAppReady(page);
    // Add and archive a row
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(500);
    const activeBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-outline)').first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(activeBefore - 1);
    // Go to archived, restore
    await page.locator('.v-btn-toggle button:has-text("Archived")').click();
    await page.waitForTimeout(1000);
    const archivedBefore = await page.locator('.v-table tbody tr').count();
    await page.locator('button:has(.mdi-archive-arrow-up-outline)').first().click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-table tbody tr')).toHaveCount(archivedBefore - 1);
  });
});

test.describe('Navigation', () => {
  test('clicking sidebar tabs switches content', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has-text("Languages")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-main .v-card-title')).toContainText('Languages');
    await page.locator('.v-navigation-drawer .v-list-item:has-text("Lists")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-card-title:has-text("Lists")')).toBeVisible();
    await page.locator('.v-navigation-drawer .v-list-item:has-text("Settings")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('.v-card-title:has-text("Settings")')).toBeVisible();
  });
});

test.describe('Lists management', () => {
  test('add and edit a list', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('.v-navigation-drawer .v-list-item:has-text("Lists")').click();
    await page.waitForTimeout(500);
    page.on('dialog', d => d.accept('status'));
    await page.locator('button:has-text("Add list")').click();
    await page.waitForTimeout(500);
    await expect(page.locator('text=status')).toBeVisible();
  });
});

test.describe('Theme toggle', () => {
  test('toggles between light and dark', async ({ page }) => {
    await ensureAppReady(page);
    const app = page.locator('.v-theme--light, .v-theme--dark');
    const initialClass = await app.first().getAttribute('class');
    await page.locator('.v-app-bar button:has(.mdi-weather-night), .v-app-bar button:has(.mdi-weather-sunny)').click();
    await page.waitForTimeout(300);
    const newClass = await page.locator('.v-theme--light, .v-theme--dark').first().getAttribute('class');
    expect(newClass).not.toEqual(initialClass);
  });
});

test.describe('Select dropdowns', () => {
  test('select column renders as dropdown in table', async ({ page }) => {
    await ensureAppReady(page);
    await page.locator('button:has-text("Add row")').click();
    await page.waitForTimeout(300);
    const selects = page.locator('.v-table select');
    const count = await selects.count();
    expect(count).toBeGreaterThan(0);
  });
});
