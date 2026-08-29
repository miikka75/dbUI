#!/usr/bin/env node
// Seed the local dev server from a shipped example — rows and lists (examples/<id>-data.json) plus its
// language packs (examples/<id>-lang-<code>.json), layered on top of its schema
// (examples/<id>-schema.json). Each file is the shape the app's Settings -> Import consumes, so the
// same three concerns are equally installable in-browser from the example picker.
//
//   npm run seed:import              apply the committed demo files to the running dev server
//   npm run seed:import -- chores    the chores household instead
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
// Users, profiles and user-linked-list links are seeded here too but are DELIBERATELY NOT in the bundle:
// access grants and identity are per-deployment security data, not portable content you would import.
// The importer has no branch for them at all, so putting them in a bundle would be inert -- and if it did
// read them, importing an example would become a way to hand somebody a grant. This script talks to the
// admin API of a LOCAL dev server instead, which is the one place that trade is safe to make.
'use strict';
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const BASE = 'http://127.0.0.1:' + PORT + '/api/';
// examples/ rather than dev/: dev/ is pruned from both publish paths, so a schema kept there can
// never be fetched by the running app -- which is what the example picker does. See examples/README.md.
const EXAMPLES = path.join(__dirname, '..', 'examples');

// Which bundle to seed. Defaults to demo, so `npm run seed:import` keeps meaning what it meant.
const BUNDLE = (process.argv[2] || 'demo').replace(/[^\w-]/g, '');
const DATA = path.join(EXAMPLES, BUNDLE + '-data.json');

// --- users + access grants + opt-in profiles: NOT bundle content (security/identity, seeded via the API).
// local@dev MUST stay admin (default current user) or the app shows the unregistered banner.
//
// `links` maps a value of a userlink list to an account. That is what makes `@me` resolve to a curated
// name, and what `mineOnly` narrows by -- the chores duty matrix demonstrates nothing without it, since
// every member would otherwise see every column.
//
// The member grants below are deliberately RESTRICTED: `mineOnly` hands the whole matrix to anyone
// unrestricted (an admin, or `tables: "all"`), so seeding the family as admins would demonstrate the
// opposite of the feature.
const CHORES_MEMBER = { chore_log: 'rw', reward_claim: 'rw', home_shopping: 'rw',
                        ref_duties: 'r', ref_chores: 'r', ref_rewards: 'r' };
const SEED = {
  demo: {
    users: [
      { email: 'local@dev', role: 'admin',  tables: 'all' },
      { email: 'bob@dev',   role: 'editor', tables: 'all' },
      { email: 'cara@dev',  role: 'editor', tables: ['chore_log', 'chores'] },
      { email: 'dan@dev',   role: 'viewer', tables: ['tasks', 'notes'] }
    ],
    profiles: [
      { email: 'local@dev', name: 'Ann',  shared: true },
      { email: 'bob@dev',   name: 'Bob',  shared: true },
      { email: 'cara@dev',  name: 'Cara', shared: true },
      { email: 'dan@dev',   name: 'Dan',  shared: false }
    ],
    links: [],
    hint: '?user=cara@dev (chores only) | ?user=dan@dev (tasks/notes) | ?user=new@dev (unregistered)'
  },
  chores: {
    users: [
      { email: 'local@dev', role: 'admin',  tables: 'all' },   // the parent: approves, sees everyone
      { email: 'ann@dev',   role: 'editor', tables: CHORES_MEMBER },
      { email: 'bob@dev',   role: 'editor', tables: CHORES_MEMBER },
      { email: 'cara@dev',  role: 'editor', tables: CHORES_MEMBER },
      { email: 'dan@dev',   role: 'editor', tables: CHORES_MEMBER }
    ],
    profiles: [
      { email: 'local@dev', name: 'Parent', shared: true },
      { email: 'ann@dev',   name: 'Ann',    shared: true },
      { email: 'bob@dev',   name: 'Bob',    shared: true },
      { email: 'cara@dev',  name: 'Cara',   shared: true },
      { email: 'dan@dev',   name: 'Dan',    shared: true }
    ],
    links: [
      { list: 'members', value: 'Ann',  email: 'ann@dev' },
      { list: 'members', value: 'Bob',  email: 'bob@dev' },
      { list: 'members', value: 'Cara', email: 'cara@dev' },
      { list: 'members', value: 'Dan',  email: 'dan@dev' }
    ],
    hint: '?user=ann@dev (one duty column, logs her own chores) | ?user=local@dev (the parent, approves)'
  }
};

const seed = SEED[BUNDLE] || { users: [], profiles: [], links: [], hint: '' };
const USERS = seed.users, PROFILES = seed.profiles, LINKS = seed.links;

const post = (action, body) => fetch(BASE + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const postAs = (email, action, body) => fetch(BASE + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user': email }, body: JSON.stringify(body || {}) }).then(r => r.json());

(async () => {
  const bundle = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(path.join(EXAMPLES, BUNDLE + '-schema.json'), 'utf8'));
  // The whole schema, not just its tables: views, nav and list config are what make the example an APP.
  await post('saveSchema', { schema });
  // The language packs are separate files now, one per language, so fold them back into the bundle
  // shape the loop below (and Settings -> Import) reads.
  bundle.languages = [];
  bundle.translations = {};
  const langRe = new RegExp('^' + BUNDLE + '-lang-.*[.]json$');
  for (const f of fs.readdirSync(EXAMPLES).filter(n => langRe.test(n))) {
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

  // 2) Users + profiles + identity links (not in the bundle).
  for (const u of USERS) await post('setUserRole', { uid: u.email, user: u.email, role: u.role, tables: u.tables });
  for (const p of PROFILES) await postAs(p.email, 'setMyProfile', { name: p.name, shared: p.shared });
  // Last: a link is keyed by a LIST VALUE and an ACCOUNT, so both have to exist before it can be made.
  for (const l of LINKS) await post('setListUser', { listName: l.list, value: l.value, email: l.email });

  const tCount = Object.keys((bundle.translations && bundle.translations.en) || {}).length;
  console.log('Imported the ' + BUNDLE + ' example: ' + rowCount + ' rows, ' + listCount + ' list options, ' + tCount + ' translations, '
    + USERS.length + ' users, ' + PROFILES.length + ' profiles, ' + LINKS.length + ' identity links.');
  if (seed.hint) console.log('  Switch user in the URL: ' + seed.hint + '.');
})().catch(e => {
  console.error('Import failed (is the dev server running on :' + PORT + ' with a local DB created?):', e.message);
  process.exit(1);
});
