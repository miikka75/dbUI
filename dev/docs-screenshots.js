#!/usr/bin/env node
// Regenerates docs/screenshots/*.png from the shipped examples: one throwaway dev server per bundle,
// seeded by seed-import.js, then each shot opens a view as a given user.
//
//   npm run docs:screenshots            every shot
//   npm run docs:screenshots -- board   only shots whose file name contains "board"
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { startServer } = require('./test-ui/server-fixture');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const ONLY = process.argv[2] || '';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 780 };

// The bundles that are not shipped as examples: view kinds no example uses yet.
const EXTRA = require('./docs-screenshots-schema.json');

// file: docs/screenshots/<file>.png. view: a nav id (a view, or __settings/__lookup/__languages). user:
// the dev identity ('' = a signed-out visitor). setup(origin) runs before the page opens, before(page) after.
const SHOTS = {
  demo: [
    { file: 'nav-tiles', view: null },
    { file: 'data-view-table', view: 'all_items' },
    { file: 'data-view-cards', view: 'summary_cards' },
    { file: 'data-view-gallery', view: 'notes_gallery' },
    { file: 'join-view', view: 'combined' },
    { file: 'aggregate-leaderboard', view: 'leaderboard' },
    { file: 'board', view: 'tickets_board' },
    { file: 'pivot', view: 'chore_heatmap' },
    { file: 'document', view: 'showcase' },
    { file: 'rotation-view', view: 'crewrota' },
    { file: 'settings-users', view: '__settings', before: openSection('Users', 'users') },
    { file: 'lookup-lists', view: '__lookup' },
    { file: 'languages', view: '__languages' },
    { file: 'print', view: 'all_items', before: printPreview },
    { file: 'archive', view: 'tasks', before: (p) => p.getByRole('tab', { name: 'Past' }).click() }
  ],
  chores: [
    { file: 'calendar-month', view: 'home_calendar' },
    { file: 'stats-leaderboard', view: 'doc_scoreboard' },
    { file: 'stats-cadence', view: 'chore_cadence' },
    { file: 'scan', view: 'chore_scan', user: 'ann@dev' },
    { file: 'rotation-columns', view: 'duty_matrix' },
    { file: 'self-service-mine', view: 'doc_mine', user: 'ann@dev' },
    { file: 'nav-drawer', view: 'doc_home' },
    { file: 'calendar-feeds', view: '__settings', before: openSection('Calendars', 'calendars') }
  ],
  gym: [
    { file: 'rsvp', view: 'class_booking', user: 'aino@dev' },
    { file: 'calendar-week', view: 'class_calendar', user: 'aino@dev' },
    { file: 'search', view: 'coach', user: 'aino@dev' },
    { file: 'form', view: 'membership_buy', user: 'aino@dev', before: (p) => p.locator('main .v-btn').first().click() },
    { file: 'stats-goal', view: 'my_level', user: 'aino@dev' },
    { file: 'stats-series', view: 'my_minutes_weeks', user: 'aino@dev' },
    { file: 'theme', view: 'doc_home', user: 'aino@dev' },
    { file: 'bottom-nav', view: 'doc_home', user: 'aino@dev', viewport: PHONE },
    { file: 'public-visitor', view: 'class_schedule', user: '' },
    { file: 'open-signup', view: null, user: 'new@dev' },
    { file: 'profile', view: '__settings', user: 'aino@dev' },
    { file: 'settings-theme', view: '__settings', before: openSection('Appearance', 'appearance') },
    // Last: it turns open sign-up off, so a new account sees the request form instead of joining.
    { file: 'membership-request', view: null, user: 'new2@dev', setup: closeSignup }
  ],
  empty: [
    { file: 'setup', view: null, fresh: true },
    { file: 'examples-picker', view: null, before: (p) => p.locator('[data-testid="empty-db-examples"]').click() }
  ],
  extra: [
    { file: 'timeline', view: 'timeline' }
  ]
};

// Unfolds a Settings section (settings._collapse<key>) and scrolls it to the top.
function openSection(key, testid) {
  return async (p) => {
    await p.evaluate((k) => { appInstance.settings['_collapse' + k] = false; }, key);
    await p.locator('[data-testid="' + testid + '-section-toggle"]').evaluate((e) => { e.scrollIntoView({ block: 'start' }); window.scrollBy(0, -72); });
  };
}

async function closeSignup(origin) {
  const post = (a, b) => fetch(origin + '/api/' + a, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const schema = await post('getSchema', {});
  schema.newUser.open = false;
  await post('saveSchema', { schema });
}

// Swaps the page for what the print button would open in a new window.
async function printPreview(p) {
  const html = await p.evaluate(() => {
    let out = '';
    window.open = () => ({ document: { write: (h) => { out += h; }, close() {} }, print() {} });
    VIEWS[appInstance.currentTable].printable = 'view';
    appInstance.printView();
    return out;
  });
  await p.setContent(html);
}

function seed(bundle, origin) {
  const port = new URL(origin).port;
  if (bundle === 'empty') return;
  if (bundle === 'extra') return seedExtra(origin);
  const r = spawnSync(process.execPath, ['seed-import.js', bundle], { cwd: __dirname, env: { ...process.env, PORT: port }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('seed ' + bundle + ' failed:\n' + r.stdout + r.stderr);
}

async function seedExtra(origin) {
  const post = (action, body) => fetch(origin + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => { if (!r.ok) throw new Error(action + ' ' + r.status); return r.json(); });
  await post('setUserRole', { uid: 'local@dev', user: 'local@dev', role: 'admin', tables: 'all' });
  await post('saveSchema', { schema: EXTRA.schema });
  for (const [table, rows] of Object.entries(EXTRA.rows)) for (const data of rows) await post('putRow', { tableId: table, data, tab: 'active' });
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'app-lang-en.json'), 'utf8')).translations.en;
  await post('createLanguage', { code: 'en', name: 'English', keys: Object.keys(en) });
  await post('updateTranslations', { langCode: 'en', updates: Object.assign({}, en, EXTRA.translations) });
}

async function shoot(browser, origin, shot) {
  if (shot.setup) await shot.setup(origin);
  const ctx = await browser.newContext({ viewport: shot.viewport || DESKTOP, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  if (!shot.fresh) await page.addInitScript((u) => {
    localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
    if (u !== null) localStorage.setItem('test_user', u);
  }, shot.user === undefined ? null : shot.user);
  await page.goto(origin + '/');
  if (!shot.fresh) await page.waitForFunction(() => window.appInstance && !appInstance.loading, null, { timeout: 30000 });
  if (shot.view) await page.evaluate((v) => appInstance.selectTab(v), shot.view);
  await page.waitForLoadState('networkidle');
  if (shot.before) await shot.before(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, shot.file + '.png') });
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const [bundle, shots] of Object.entries(SHOTS)) {
      const todo = shots.filter((s) => s.file.includes(ONLY));
      if (!todo.length) continue;
      const { child, url } = startServer({ CSP: '' });
      try {
        const origin = await url;
        child.stdout.resume();
        await seed(bundle, origin);
        for (const shot of todo) { await shoot(browser, origin, shot); console.log('  ' + shot.file + '.png'); }
      } finally { child.kill(); }
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
