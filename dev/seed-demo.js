#!/usr/bin/env node
// Seed the demo local dev server with sample data so EVERY board shows content:
//   - chores (per-chore points) + chore_log across this week / this month / last month
//       -> Leaderboard (sum), weekly Leaderboard, "Last month" (count), chore_calendar
//   - cities (ref/lookup target for tasks.city) ; crew + crew_rotation -> crewrota rotation view
//   - tasks + notes (+ status/assigned_to lists) -> combined / attendance / progress views
//   - a few ARCHIVED rows (tasks + chore_log)     -> the Archived tabs / archive embeds
//   - rotation anchor + range for crewrota        -> folder config (rotationAnchors/rotationRanges)
//   - _profiles (opt-in display names)            -> @me ("My chores") + user-backed `members` list
//   - {{t:}} page-prose translations              -> merged in (reuses seed-translations.js)
//
// NOTE: every table is partitioned into <table>__active / <table>__archive (schema.js sets
// partition:'active' for all tables), so LIVE rows are written with tab:'active' and archived
// rows with tab:'archive'. Deterministic ids ("seed-<table>-<n>") make re-runs REPLACE, not duplicate.
//
// Usage:  npm start            (one shell; creates local.db on first boot)
//         npm run seed:demo    (or: node seed-demo.js)
'use strict';
const fs = require('fs');
const path = require('path');
const { T } = require('./seed-translations');
const PORT = process.env.PORT || 3000;
const BASE = 'http://127.0.0.1:' + PORT + '/api/';

const post = (action, body) => fetch(BASE + action, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
}).then(r => r.json());
// Write a profile for a specific user: setMyProfile keys off the x-user header (defaults to local@dev).
const postAs = (email, action, body) => fetch(BASE + action, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': email }, body: JSON.stringify(body || {})
}).then(r => r.json());

// --- dates: stored as plain YYYY-MM-DD (the date-column format) --------------------------------
const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const now = new Date();
const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)); // Mon of this week
const rangeFrom = new Date(monday); rangeFrom.setDate(monday.getDate() - 14);                          // 2 weeks earlier
const D = {
  today:          iso(now),
  yesterday:      iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)),
  thisMonthEarly: iso(new Date(now.getFullYear(), now.getMonth(), 2)),
  lastMonthA:     iso(new Date(now.getFullYear(), now.getMonth() - 1, 10)),
  lastMonthB:     iso(new Date(now.getFullYear(), now.getMonth() - 1, 20))
};

// --- list options (dropdown values) ------------------------------------------------------------
// `members` is user-backed (schema listSources) -> also populated from shared profiles; seeded here
// as a fallback for exploring without profiles.
const LISTS = {
  members:     ['Ann', 'Bob', 'Cara'],
  crew:        ['Ann', 'Bob', 'Cara', 'Dan'],
  status:      ['open', 'in_progress', 'done'],
  assigned_to: ['Ann', 'Bob', 'Cara']
};

// --- opt-in display-name profiles: local@dev is the demo's current user, so @me -> "Ann" ---------
const PROFILES = [
  { email: 'local@dev', name: 'Ann',  shared: true },   // current user -> @me = "Ann" ("My chores")
  { email: 'bob@dev',   name: 'Bob',  shared: true },
  { email: 'cara@dev',  name: 'Cara', shared: true },
  { email: 'dan@dev',   name: 'Dan',  shared: false }    // opted out -> excluded from user-backed lists
];

// --- registered users + access grants (_users). Switch current user via ?user=<email> in the URL. --
// local@dev MUST stay admin (it's the default current user) or the app shows the unregistered banner.
// `tables:'all'` = every table; an array restricts server-derived access to those tables only.
const USERS = [
  { email: 'local@dev', role: 'admin',  tables: 'all' },                    // current user (full access + Users tab)
  { email: 'bob@dev',   role: 'editor', tables: 'all' },                    // full editor
  { email: 'cara@dev',  role: 'editor', tables: ['chore_log', 'chores'] },  // restricted: chores only
  { email: 'dan@dev',   role: 'viewer', tables: ['tasks', 'notes'] }        // restricted, read-oriented
];

// --- live table rows (written to tab:"active") -------------------------------------------------
const ROWS = {
  cities: [
    { state: 'IL', city: 'Springfield' },
    { state: 'IL', city: 'Chicago' },
    { state: 'CA', city: 'Fresno' }
  ],
  chores: [
    { chore: 'Dishes',   points: 2 },
    { chore: 'Vacuum',   points: 3 },
    { chore: 'Mow lawn', points: 5 },
    { chore: 'Trash',    points: 1 },
    { chore: 'Laundry',  points: 4 }
  ],
  // Spread so this week (today/yesterday), earlier this month, and last month all have entries.
  chore_log: [
    { chore: 'Dishes',   person: 'Ann',  done_on: D.today },          // this week
    { chore: 'Mow lawn', person: 'Cara', done_on: D.today },          // this week
    { chore: 'Vacuum',   person: 'Bob',  done_on: D.yesterday },      // this week
    { chore: 'Mow lawn', person: 'Ann',  done_on: D.thisMonthEarly }, // this month (not week)
    { chore: 'Trash',    person: 'Bob',  done_on: D.thisMonthEarly }, // this month (not week)
    { chore: 'Laundry',  person: 'Ann',  done_on: D.lastMonthA },     // last month
    { chore: 'Dishes',   person: 'Ann',  done_on: D.lastMonthB },     // last month
    { chore: 'Dishes',   person: 'Bob',  done_on: D.lastMonthA },     // last month
    { chore: 'Vacuum',   person: 'Cara', done_on: D.lastMonthB }      // last month
  ],
  crew_rotation: [
    { position: 0, people: ['Ann', 'Bob'] },
    { position: 1, people: ['Cara', 'Dan'] }
  ],
  tasks: [
    { date: D.today,     title: 'Fix roof',    status: 'open',        assigned_to: 'Ann', city: 'Springfield' },
    { date: D.yesterday, title: 'Paint fence', status: 'in_progress', assigned_to: 'Bob', city: 'Chicago' }
  ],
  notes: [
    { date: D.today, title: 'Weekly sync', content: 'Discussed the roster and open tasks.', author: 'Cara' }
  ]
};

// --- archived rows (written to tab:"archive") --------------------------------------------------
const ARCHIVED = {
  tasks:     [ { date: D.lastMonthA, title: 'Old audit', status: 'done', assigned_to: 'Cara', city: 'Fresno' } ],
  chore_log: [ { chore: 'Trash', person: 'Cara', done_on: D.lastMonthA } ]
};

(async () => {
  // 1) Ensure tables exist (idempotent; non-destructive).
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8'));
  await post('initSchema', { schema: schema.tables });

  // 2) List options.
  let listCount = 0;
  for (const [listName, values] of Object.entries(LISTS)) {
    for (const value of values) { await post('putListItem', { listName, value }); listCount++; }
  }

  // 3) Opt-in profiles (per-user via x-user header) -> powers @me + user-backed `members` list.
  for (const p of PROFILES) await postAs(p.email, 'setMyProfile', { name: p.name, shared: p.shared });

  // 3b) Registered users + access grants (admin write; switch current user via ?user=<email>).
  for (const u of USERS) await post('setUserRole', { uid: u.email, user: u.email, role: u.role, tables: u.tables });

  // 4) Live rows (tab:"active").
  let rowCount = 0;
  for (const [tableId, rows] of Object.entries(ROWS)) {
    let n = 0;
    for (const row of rows) {
      n++;
      await post('putRow', { tableId, data: Object.assign({ id: 'seed-' + tableId + '-' + n }, row), tab: 'active' });
      rowCount++;
    }
  }

  // 5) Archived rows (tab:"archive").
  let archCount = 0;
  for (const [tableId, rows] of Object.entries(ARCHIVED)) {
    let n = 0;
    for (const row of rows) {
      n++;
      await post('putRow', { tableId, data: Object.assign({ id: 'seed-' + tableId + '-arch-' + n }, row), tab: 'archive' });
      archCount++;
    }
  }

  // 6) Rotation anchor + range for the crewrota view (merge into existing folder config).
  const fc = (await post('getFolderConfig')) || {};
  fc.rotationAnchors = Object.assign({}, fc.rotationAnchors, { crewrota: iso(monday) });
  fc.rotationRanges = Object.assign({}, fc.rotationRanges, { crewrota: { from: iso(rangeFrom), periods: 8 } });
  await post('setFolderConfig', { config: fc });

  // 7) Page-prose translations (merged from seed-translations.js).
  await post('createLanguage', { folderId: 'local', code: 'en', name: 'English', keys: Object.keys(T) });
  await post('updateTranslations', { folderId: 'local', langCode: 'en', updates: T });

  console.log('Seeded: ' + rowCount + ' live rows + ' + archCount + ' archived across '
    + (Object.keys(ROWS).length) + ' tables, ' + listCount + ' list options, '
    + USERS.length + ' users, ' + PROFILES.length + ' profiles, ' + Object.keys(T).length + ' translations, + rotation config.');
  console.log('  Leaderboard(this month, sum): Ann 7, Cara 5, Bob 4  |  Weekly: Cara 5, Bob 3, Ann 2');
  console.log('  Last month (count): Ann 2, Bob 1, Cara 1  |  @me="Ann" -> "My chores" shows Ann\'s rows');
  console.log('  Switch user in the URL: ?user=cara@dev (chores only) | ?user=dan@dev (tasks/notes) | ?user=new@dev (unregistered -> Request access)');
})().catch(e => {
  console.error('Seed failed (is the server running on :' + PORT + ' with a local DB created?):', e.message);
  process.exit(1);
});
