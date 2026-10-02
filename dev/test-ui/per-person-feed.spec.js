// per-person-feed.spec.js — the chores example's "My calendar", end to end on the dev server.
//
// Everything else about per-person feeds is tested against stubs (feeds.test.js, app.spec.js). This is
// the one run where the file really goes through the dev store and comes back over HTTP, which is what
// a local install shows: subscribe in the menu, a publisher's pass mints the link, the link serves a
// calendar, republishing keeps the SAME link, and unsubscribing empties it.
const { test, expect } = require('./server-fixture');

test('chores: subscribe to My calendar, fetch the link, unsubscribe and watch it empty', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.request.post('/api/resetData');
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading, { timeout: 20000 });

  // Install the chores bundle with its sample rows, the way a person would.
  await page.locator('[data-testid="empty-db-examples"]').click();
  await page.locator('[data-testid="example-chores"]').click();
  await page.evaluate(() => { window.__beforeInstall = true; });
  await page.locator('[data-testid="example-install"]').click();
  await page.waitForFunction(() => !window.__beforeInstall && window.appInstance && !appInstance.loading, { timeout: 60000 });

  // This session is the first user, so it is the admin — the one client that publishes. It is also
  // somebody in the household: link it to "Ann", which is what @me resolves through when the pass
  // renders its file.
  // Through the Lists editor's own call, so the link is stored server-side like a real one.
  await page.evaluate(async () => {
    const app = window.appInstance;
    await app.setListUserLink('members', 'Ann', app.currentUserEmail);
    await app.loadListUserLinks();
    app.selectTab('my_calendar');
  });
  const cal = page.locator('[data-testid="cal-view"]');
  await expect(cal).toBeVisible();
  await cal.locator('[data-testid="cal-subscribe-btn"]').click();
  const menu = page.locator('[data-testid="cal-subscribe"]');
  // Off until the admin publishes it: Subscribe is greyed out. The toolbar's RSS button switches it on.
  await expect(menu.locator('[data-testid="cal-subscribe-go"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await cal.locator('[data-testid="cal-publish-feed"]').click();
  await expect.poll(() => page.evaluate(() => window.appInstance.feedPublishing('my_calendar'))).toBe(true);
  await cal.locator('[data-testid="cal-subscribe-btn"]').click();
  await menu.locator('[data-testid="cal-subscribe-go"]').click();

  // The admin's own write to the subscriber table re-arms the publish pass (2s debounce), which mints
  // the id and writes the link back into the row.
  const urlInput = menu.locator('[data-testid="cal-sub-url"] input');
  await expect(urlInput).toHaveValue(/\/uploads\/feeds\/[0-9a-f]{32}\.ics$/, { timeout: 20000 });
  const link = await urlInput.inputValue();

  const first = await page.request.get(link);
  expect(first.status()).toBe(200);
  expect(first.headers()['content-type']).toMatch(/^text\/calendar/);
  const body = await first.text();
  expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
  expect(body).toContain('BEGIN:VEVENT');

  // Republishing keeps the link: the path is the subscription.
  await page.evaluate(() => window.appInstance.publishFeed('my_calendar'));
  expect(await urlInput.inputValue()).toBe(link);

  // Unsubscribe (two presses). The next pass blanks the file at the same URL and clears the row.
  await menu.locator('[data-testid="cal-unsubscribe"]').click();
  await menu.locator('[data-testid="cal-unsubscribe"]').click();
  await expect(menu.locator('[data-testid="cal-subscribe-go"]')).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await page.request.get(link)).text(), { timeout: 20000 }).not.toContain('BEGIN:VEVENT');
  expect(await (await page.request.get(link)).text()).toContain('BEGIN:VCALENDAR');
});
