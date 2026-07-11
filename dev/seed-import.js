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
  const plus = n => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n)); // n days from today
  const P = { p1: plus(3), p2: plus(7), p3: plus(12) };                                   // upcoming practices
  const LISTS = { members: ['Ann', 'Bob', 'Cara'], crew: ['Ann', 'Bob', 'Cara', 'Dan'], status: ['open', 'in_progress', 'done'], assigned_to: ['Ann', 'Bob', 'Cara'] };
  // Translations: en + two more languages, with UI keys (tab.*/view.*/field.*/list.*) and the demo's
  // {{t:}} page-prose. `en` is the default/base; switching language in the Languages tab shows es/sv.
  const TR = {
    'app.title':                    ['Team Demo', 'Demo de Equipo', 'Team-demo'],
    'view.combined.header':         ['# Tasks & Notes', '# Tareas y Notas', '# Uppgifter & Anteckningar'],
    'view.combined.footer':         ['_Tasks are synced from notes._', '_Las tareas se sincronizan desde las notas._', '_Uppgifter synkas från anteckningar._'],
    'view.progress_report.header':  ['# Progress Report', '# Informe de Progreso', '# Lägesrapport'],
    'view.progress_report.footer':  ['_End of report._', '_Fin del informe._', '_Slut på rapport._'],
    'embed.open.title':             ['Open', 'Abierto', 'Öppen'],
    'embed.ip.title':               ['In Progress', 'En Progreso', 'Pågår'],
    'embed.ip.attention':           ['_Items above need attention._', '_Los elementos anteriores necesitan atención._', '_Objekten ovan behöver uppmärksamhet._'],
    'tab.tasks':      ['Tasks', 'Tareas', 'Uppgifter'],
    'tab.notes':      ['Notes', 'Notas', 'Anteckningar'],
    'tab.practices':  ['Practices', 'Entrenamientos', 'Träningar'],
    'tab.chore_log':  ['Chore Log', 'Registro de Tareas', 'Sysslologg'],
    'tab.chores':     ['Chores', 'Tareas Domésticas', 'Sysslor'],
    'tab.cities':     ['Cities', 'Ciudades', 'Städer'],
    'view.combined':          ['Tasks & Notes', 'Tareas y Notas', 'Uppgifter & Anteckningar'],
    'view.attendance':        ['Attendance', 'Asistencia', 'Närvaro'],
    'view.my_rsvp':           ['My RSVP', 'Mi Confirmación', 'Min Anmälan'],
    'view.my_chores':         ['My Chores', 'Mis Tareas', 'Mina Sysslor'],
    'view.leaderboard':       ['Leaderboard (Month)', 'Clasificación (Mes)', 'Topplista (Månad)'],
    'view.leaderboard_week':  ['Leaderboard (Week)', 'Clasificación (Semana)', 'Topplista (Vecka)'],
    'view.chores_last_month': ['Last Month', 'Mes Pasado', 'Förra Månaden'],
    'view.chore_calendar':    ['Chore Calendar', 'Calendario de Tareas', 'Sysslokalender'],
    'view.chore_heatmap':     ['Chore Heatmap', 'Mapa de Calor', 'Värmekarta'],
    'field.date':        ['Date', 'Fecha', 'Datum'],
    'field.title':       ['Title', 'Título', 'Titel'],
    'field.status':      ['Status', 'Estado', 'Status'],
    'field.assigned_to': ['Assigned To', 'Asignado A', 'Tilldelad'],
    'field.city':        ['City', 'Ciudad', 'Stad'],
    'field.content':     ['Content', 'Contenido', 'Innehåll'],
    'field.author':      ['Author', 'Autor', 'Författare'],
    'field.chore':       ['Chore', 'Tarea', 'Syssla'],
    'field.person':      ['Person', 'Persona', 'Person'],
    'field.done_on':     ['Done On', 'Hecho El', 'Utförd'],
    'field.points':      ['Points', 'Puntos', 'Poäng'],
    'field.opponent':    ['Opponent', 'Oponente', 'Motståndare'],
    'field.people':      ['People', 'Personas', 'Personer'],
    'field.note':        ['Note', 'Nota', 'Anteckning'],
    'field.total':       ['Total', 'Total', 'Totalt'],
    'list.status.open':        ['Open', 'Abierto', 'Öppen'],
    'list.status.in_progress': ['In Progress', 'En Progreso', 'Pågår'],
    'list.status.done':        ['Done', 'Hecho', 'Klar'],
    // Calendar chrome + period navigation (translation keys; untranslated languages show the key).
    'cal.today':     ['Today', 'Hoy', 'Idag'],
    'cal.month':     ['Month', 'Mes', 'Månad'],
    'cal.week':      ['Week', 'Semana', 'Vecka'],
    'cal.list':      ['List', 'Lista', 'Lista'],
    'cal.undated':   ['Undated', 'Sin fecha', 'Utan datum'],
    'cal.no_events': ['No events', 'Sin eventos', 'Inga händelser'],
    'cal.items':     ['items', 'elementos', 'poster'],
    'period.this_week': ['This week', 'Esta semana', 'Denna vecka'],
    'period.weeks_ago': ['weeks ago', 'semanas atrás', 'veckor sedan'],
    'period.current':   ['Current', 'Actual', 'Nuvarande']
  };
  const LANGS = [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }, { code: 'sv', name: 'Svenska' }];
  const translations = {};
  LANGS.forEach((l, i) => { translations[l.code] = {}; for (const k in TR) translations[l.code][k] = TR[k][i]; });
  const ROWS = {
    cities: [ { state: 'IL', city: 'Springfield' }, { state: 'IL', city: 'Chicago' }, { state: 'CA', city: 'Fresno' } ],
    chores: [ { chore: 'Dishes', points: 2 }, { chore: 'Vacuum', points: 3 }, { chore: 'Mow lawn', points: 5 }, { chore: 'Trash', points: 1 }, { chore: 'Laundry', points: 4 } ],
    chore_log: [
      { chore: 'Dishes',   person: 'Ann',  done_on: D.today },
      { chore: 'Vacuum',   person: 'Ann',  done_on: D.today },          // Ann, this week -> richer "My chores"
      { chore: 'Mow lawn', person: 'Cara', done_on: D.today },
      { chore: 'Trash',    person: 'Ann',  done_on: D.yesterday },      // Ann, this week
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
    notes: [ { date: D.today, title: 'Weekly sync', content: 'Discussed the roster and open tasks.', author: 'Cara', link: 'https://example.com/weekly-sync' } ],
    // RSVP demo: upcoming events (practices) + everyone's owner-stamped responses (rsvps). The current
    // user (local@dev) has responded to p1/p2 but not p3 -> the my_rsvp view offers to set a status there.
    // rosterPublic marks each response readable by all (the roster:"all" gate; ignored by the dev server).
    practices: [
      { date: P.p1, title: 'League match', opponent: 'Riverside' },
      { date: P.p2, title: 'Home game',    opponent: 'Lakeside' },
      { date: P.p3, title: 'Cup fixture',  opponent: 'Hillcrest' }
    ],
    rsvps: [
      { owner: 'local@dev', practice: P.p1, status: 'coming', note: 'Bringing water', rosterPublic: true },
      { owner: 'bob@dev',   practice: P.p1, status: 'coming', note: '', rosterPublic: true },
      { owner: 'cara@dev',  practice: P.p1, status: 'maybe',  note: 'Depends on work', rosterPublic: true },
      { owner: 'local@dev', practice: P.p2, status: 'maybe',  note: '', rosterPublic: true },
      { owner: 'dan@dev',   practice: P.p2, status: 'out',    note: 'Away', rosterPublic: true },
      { owner: 'bob@dev',   practice: P.p3, status: 'coming', note: '', rosterPublic: true }
    ]
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
    languages: LANGS,
    translations: translations,
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
