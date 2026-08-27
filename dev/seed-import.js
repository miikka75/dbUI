#!/usr/bin/env node
// Seed the local dev server from the DEMO example — rows and lists (examples/demo-data.json) plus its
// language packs (examples/demo-lang-<code>.json), layered on top of its schema
// (examples/demo-schema.json). Each file is the shape the app's Settings -> Import consumes, so the
// same three concerns are equally installable in-browser from the example picker.
//
//   npm run seed:import            apply the committed demo files to the running dev server
//
// This script used to CONTAIN the demo -- every row, list and translation, as constants, rebuilt on
// `--regen` with dates relative to today. That made the dataset exist twice, and the two drifted: the
// board demo (tickets/ticket_stages) was added to the JSON and never to the generator, so regenerating
// silently deleted it. The files are the only copy now, and this only applies them.
//
// The cost of that is dates: they are fixed at whatever the files say, so the leaderboard's "this
// week" and the RSVP demo's "upcoming" drift out of the current period as the files age. Edit the
// dates in examples/demo-data.json when it matters (and re-run scripts/examples-manifest.js after).
//
// Users + profiles are seeded here too but are DELIBERATELY NOT in the bundle: access grants and identity
// are per-deployment security data, not portable content you would import.
'use strict';
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const BASE = 'http://127.0.0.1:' + PORT + '/api/';
// examples/ rather than dev/: dev/ is pruned from both publish paths, so a schema kept there can
// never be fetched by the running app -- which is what the example picker does. See examples/README.md.
const EXAMPLES = path.join(__dirname, '..', 'examples');
const DATA = path.join(EXAMPLES, 'demo-data.json');

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
  const bundle = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'demo-schema.json'), 'utf8'));
  // The language packs are separate files now, one per language, so fold them back into the bundle
  // shape the loop below (and Settings -> Import) reads.
  bundle.languages = [];
  bundle.translations = {};
  for (const f of fs.readdirSync(EXAMPLES).filter(n => /^demo-lang-.*[.]json$/.test(n))) {
    const pack = JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));
    bundle.languages.push(...(pack.languages || []));
    Object.assign(bundle.translations, pack.translations || {});
  }

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
    await post('createLanguage', { code, name: lang ? lang.name : code, keys: Object.keys(map) });
    await post('updateTranslations', { langCode: code, updates: map });
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
  console.log('Imported the demo example: ' + rowCount + ' rows, ' + listCount + ' list options, ' + tCount + ' translations, '
    + USERS.length + ' users, ' + PROFILES.length + ' profiles.');
  console.log('  Switch user in the URL: ?user=cara@dev (chores only) | ?user=dan@dev (tasks/notes) | ?user=new@dev (unregistered).');
})().catch(e => {
  console.error('Import failed (is the dev server running on :' + PORT + ' with a local DB created?):', e.message);
  process.exit(1);
});
