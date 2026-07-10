#!/usr/bin/env node
// Seed the local dev server from a portable DATA bundle (dev/demo-bundle.json) layered on top of the
// schema (dev/schema.json). The bundle is the same shape the app's Settings -> Import consumes
// (tables rows + lists + translations + config), so it is also importable in-browser on top of schema.json.
//
//   npm run seed:import            apply the committed demo-bundle.json to the running dev server
//   node seed-import.js --regen    rebuild demo-bundle.json with dates relative to *today*, then exit
//                                  (the leaderboard/calendar demos are date-relative; --regen keeps them fresh)
//
// Users + profiles are seeded here too but are DELIBERATELY NOT in the bundle: access grants and identity
// are per-deployment security data, not portable content you would import.
'use strict';
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const BASE = 'http://127.0.0.1:' + PORT + '/api/';
const BUNDLE = path.join(__dirname, 'demo-bundle.json');

// --- demo dataset — used only by --regen to (re)build the bundle with dates relative to "today" -------
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function buildBundle() {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)); // Mon of this week
  const rangeFrom = new Date(monday); rangeFrom.setDate(monday.getDate() - 14);
  const D = {
    today:          iso(now),
    yesterday:      iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
    thisMonthEarly: iso(new Date(now.getFullYear(), now.getMonth(), 2)),
    lastMonthA:     iso(new Date(now.getFullYear(), now.getMonth() - 1, 10)),
    lastMonthB:     iso(new Date(now.getFullYear(), now.getMonth() - 1, 20))
  };
  const LISTS = { members: ['Ann', 'Bob', 'Cara'], crew: ['Ann', 'Bob', 'Cara', 'Dan'], status: ['open', 'in_progress', 'done'], assigned_to: ['Ann', 'Bob', 'Cara'] };
  const T = {
    'view.combined.header': '# Tasks & Notes',
    'view.combined.footer': '_Tasks are synced from notes._',
    'view.progress_report.header': '# Progress Report',
    'embed.open.title': 'Open',
    'embed.ip.title': 'In Progress',
    'embed.ip.attention': '_Items above need attention._',
    'view.progress_report.footer': '_End of report._'
  };
  const ROWS = {
    cities: [ { state: 'IL', city: 'Springfield' }, { state: 'IL', city: 'Chicago' }, { state: 'CA', city: 'Fresno' } ],
    chores: [ { chore: 'Dishes', points: 2 }, { chore: 'Vacuum', points: 3 }, { chore: 'Mow lawn', points: 5 }, { chore: 'Trash', points: 1 }, { chore: 'Laundry', points: 4 } ],
    chore_log: [
      { chore: 'Dishes',   person: 'Ann',  done_on: D.today },
      { chore: 'Mow lawn', person: 'Cara', done_on: D.today },
      { chore: 'Vacuum',   person: 'Bob',  done_on: D.yesterday },
      { chore: 'Mow lawn', person: 'Ann',  done_on: D.thisMonthEarly },
      { chore: 'Trash',    person: 'Bob',  done_on: D.thisMonthEarly },
      { chore: 'Laundry',  person: 'Ann',  done_on: D.lastMonthA },
      { chore: 'Dishes',   person: 'Ann',  done_on: D.lastMonthB },
      { chore: 'Dishes',   person: 'Bob',  done_on: D.lastMonthA },
      { chore: 'Vacuum',   person: 'Cara', done_on: D.lastMonthB }
    ],
    crew_rotation: [ { position: 0, people: ['Ann', 'Bob'] }, { position: 1, people: ['Cara', 'Dan'] } ],
    tasks: [
      { date: D.today,     title: 'Fix roof',    status: 'open',        assigned_to: 'Ann', city: 'Springfield' },
      { date: D.yesterday, title: 'Paint fence', status: 'in_progress', assigned_to: 'Bob', city: 'Chicago' }
    ],
    notes: [ { date: D.today, title: 'Weekly sync', content: 'Discussed the roster and open tasks.', author: 'Cara', link: 'https://example.com/weekly-sync' } ]
  };
  const ARCHIVED = {
    tasks:     [ { date: D.lastMonthA, title: 'Old audit', status: 'done', assigned_to: 'Cara', city: 'Fresno' } ],
    chore_log: [ { chore: 'Trash', person: 'Cara', done_on: D.lastMonthA } ]
  };
  const withIds = (map, arch) => {
    const out = {};
    for (const [t, rows] of Object.entries(map)) out[arch ? t + '__archive' : t] = rows.map((r, i) => Object.assign({ id: 'seed-' + t + (arch ? '-arch-' : '-') + (i + 1) }, r));
    return out;
  };
  return {
    tables: Object.assign({}, withIds(ROWS, false), withIds(ARCHIVED, true)),
    lists: LISTS,
    languages: [{ code: 'en', name: 'English' }],
    translations: { en: T },
    config: { rotationAnchors: { crewrota: iso(monday) }, rotationRanges: { crewrota: { from: iso(rangeFrom), periods: 8 } } },
    generatedAt: new Date().toISOString()
  };
}

// --- users + access grants + opt-in profiles: NOT bundle content (security/identity, seeded via the API).
// local@dev MUST stay admin (default current user) or the app shows the unregistered banner.
const USERS = [
  { email: 'local@dev', role: 'admin',  tables: 'all' },
  { email: 'bob@dev',   role: 'editor', tables: 'all' },
  { email: 'cara@dev',  role: 'editor', tables: ['chore_log', 'chores'] },
  { email: 'dan@dev',   role: 'viewer', tables: ['tasks', 'notes'] }
];
const PROFILES = [
  { email: 'local@dev', name: 'Ann',  shared: true },
  { email: 'bob@dev',   name: 'Bob',  shared: true },
  { email: 'cara@dev',  name: 'Cara', shared: true },
  { email: 'dan@dev',   name: 'Dan',  shared: false }
];

const post = (action, body) => fetch(BASE + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const postAs = (email, action, body) => fetch(BASE + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': email }, body: JSON.stringify(body || {}) }).then(r => r.json());

(async () => {
  if (process.argv.includes('--regen')) {
    fs.writeFileSync(BUNDLE, JSON.stringify(buildBundle(), null, 2) + '\n');
    console.log('Regenerated demo-bundle.json (dates relative to today). Run `npm run seed:import` to apply it.');
    return;
  }

  const bundle = JSON.parse(fs.readFileSync(BUNDLE, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));

  // 1) Ensure tables exist (idempotent), then apply the bundle's DATA on top of the schema.
  await post('initSchema', { schema: schema.tables });

  let listCount = 0;
  for (const [listName, values] of Object.entries(bundle.lists || {})) for (const value of values) { await post('putListItem', { listName, value }); listCount++; }

  let rowCount = 0;
  for (const [key, rows] of Object.entries(bundle.tables || {})) {
    const table = key.split('__')[0];
    const tab = key.indexOf('__') >= 0 ? 'archive' : 'active';
    for (const row of rows) { await post('putRow', { tableId: table, data: row, tab }); rowCount++; }
  }

  for (const [code, map] of Object.entries(bundle.translations || {})) {
    const lang = (bundle.languages || []).find(l => l.code === code);
    await post('createLanguage', { folderId: 'local', code, name: lang ? lang.name : code, keys: Object.keys(map) });
    await post('updateTranslations', { folderId: 'local', langCode: code, updates: map });
  }

  if (bundle.config) {
    const fc = (await post('getFolderConfig')) || {};
    fc.rotationAnchors = Object.assign({}, fc.rotationAnchors, bundle.config.rotationAnchors);
    fc.rotationRanges = Object.assign({}, fc.rotationRanges, bundle.config.rotationRanges);
    await post('setFolderConfig', { config: fc });
  }

  // 2) Users + profiles (not in the bundle).
  for (const u of USERS) await post('setUserRole', { uid: u.email, user: u.email, role: u.role, tables: u.tables });
  for (const p of PROFILES) await postAs(p.email, 'setMyProfile', { name: p.name, shared: p.shared });

  const tCount = Object.keys((bundle.translations && bundle.translations.en) || {}).length;
  console.log('Imported demo-bundle.json: ' + rowCount + ' rows, ' + listCount + ' list options, ' + tCount + ' translations, '
    + USERS.length + ' users, ' + PROFILES.length + ' profiles.');
  console.log('  Switch user in the URL: ?user=cara@dev (chores only) | ?user=dan@dev (tasks/notes) | ?user=new@dev (unregistered).');
})().catch(e => {
  console.error('Import failed (is the dev server running on :' + PORT + ' with a local DB created?):', e.message);
  process.exit(1);
});
