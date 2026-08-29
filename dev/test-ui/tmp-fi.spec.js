// TEMPORARY — deleted after the check.
const { test, expect } = require('./server-fixture');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/chores-schema.json'), 'utf8'));
const FI = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/chores-lang-fi.json'), 'utf8'));
const iso = (b) => { const d = new Date(); d.setDate(d.getDate() - b); return d.toISOString().slice(0, 10); };

test('the Finnish pack covers the scoreboard, tiers included', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1000, height: 1400 });
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  const map = FI.translations.fi;
  await page.request.post('/api/createLanguage', { data: { code: 'fi', name: 'Suomi', keys: Object.keys(map) } });
  await page.request.post('/api/updateTranslations', { data: { langCode: 'fi', updates: map } });

  const put = (t, d) => page.request.post('/api/putRow', { data: { tableId: t, data: d, tab: 'active' } });
  for (const [c, p] of [['Mow the lawn', 5], ['Hoover', 3], ['Wash up', 2]]) await put('ref_chores', { id: 'rc' + p, chore: c, points: p });
  const log = [['Ann','Mow the lawn'],['Ann','Mow the lawn'],['Ann','Hoover'],['Ann','Hoover'],['Ann','Wash up'],
               ['Bob','Mow the lawn'],['Bob','Hoover'],['Bob','Wash up'],['Cara','Hoover'],['Cara','Hoover']];
  let i = 0;
  for (const [person, chore] of log) await put('chore_log', { id: 'f' + (i++), owner: 'x@y.test', person, chore, done_on: iso(1), status: 'approved', note: '' });
  await put('chore_log', { id: 'fx', owner: 'x@y.test', person: 'Dan', chore: 'Hoover', done_on: iso(0), status: 'logged', note: '' });

  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); localStorage.setItem('app_lang', 'fi'); });
  const errs = []; page.on('pageerror', e => errs.push(String(e)));
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 20000 });
  await page.evaluate(() => window.appInstance.selectTab('doc_scoreboard'));
  await page.waitForSelector('[data-testid="stat-tile"]', { timeout: 15000 });
  await page.waitForTimeout(900);

  console.log('lang:', await page.evaluate(() => window.appInstance.currentLang));
  console.log('nav:', JSON.stringify(await page.locator('.v-navigation-drawer .v-list-item').allInnerTexts()));
  console.log('tiles:', JSON.stringify(await page.locator('[data-testid="stat-tile"]').allInnerTexts()));
  console.log('headings:', JSON.stringify(await page.locator('h2').allInnerTexts()));
  // Anything still showing a raw key is an untranslated string.
  const body = await page.locator('body').innerText();
  const raw = [...new Set(body.match(/\b(?:text|view|tab|field|list|nav|btn|stats|pivot|msg)\.[a-z_.]+/gi) || [])];
  console.log('RAW KEYS STILL VISIBLE:', JSON.stringify(raw));
  await page.screenshot({ path: 'fi-check.png', fullPage: true });
  expect(errs).toEqual([]);
});
