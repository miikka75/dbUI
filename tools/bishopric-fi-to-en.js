#!/usr/bin/env node
// bishopric-fi-to-en.js — convert a Finnish bishopric database export to the vocabulary of
// examples/bishopric-schema.json.
//
//   node bishopric-fi-to-en.js drive-sync-export-2026-08-27.json
//   node bishopric-fi-to-en.js <export.json> -o converted.json
//
// The shipped example IS this schema, renamed to English so it can be a general example rather than
// one ward's deployment. Everything about the structure matches column for column, which is what
// makes a mechanical conversion possible at all — and what makes it worth doing, because a database
// speaking the example's vocabulary can be kept up to date FROM the example.
//
// WHAT COMES OUT IS DATA ONLY — tables, lists, pages and config. Deliberately not:
//
//   the schema        install examples/bishopric-schema.json instead (Settings -> Examples). A
//                     converted copy of your own schema would be *nearly* the example and would
//                     silently stop matching it; the whole point is to adopt the shipped one.
//   the translations  examples/bishopric-lang-fi.json already IS this ward's Finnish, re-keyed. The
//                     only strings it does not carry are the ones that name a particular ward
//                     (`app.title`, `text.welcome`), which are reported at the end so you can paste
//                     them back in the Languages tab.
//
// It refuses to write anything it could not map. A silently dropped column is a column of data lost,
// so an unknown table, column, list or status is a hard error listing exactly what it did not know.
'use strict';
const fs = require('fs');
const path = require('path');

// --- The mapping. Derived by pairing the two schemas: same 12 tables, same columns in the same
// --- order, same 11 lists. Values are renamed only where the SCHEMA depends on them (the bishopric
// --- roles a view filters on, the statuses the meeting program filters on). Everything else --- member
// --- names, organisation names, hymn titles, calling names --- is the ward's own data and is left alone.
const TABLES = {
  kokoukset: 'meeting_agenda',
  musiikki: 'meeting_music',
  tulkit: 'duty_interpreters',
  tehtävät: 'admin_callings',
  keskustelut: 'admin_interviews',
  muistettavat: 'admin_reminders',
  vastuut: 'admin_responsibilities',
  tilat: 'ref_statuses',
  ovimiehet_vuorot: 'duty_usher_dates',
  ovimiehet_lista: 'duty_ushers',
  siivous_a: 'duty_cleaning_a',
  siivous_b: 'duty_cleaning_b'
};

// One global column map: no Finnish column name means two different things in two tables, so this
// needs no per-table scoping. `id`, `position`, `people`, `created_at`, `updated_at` and the
// `_status` partition stamp pass through untouched.
const COLUMNS = {
  pvm: 'date', teema: 'theme',
  johtaja: 'presiding', vastuussa: 'responsible',
  alkurukous: 'opening_prayer', loppurukous: 'closing_prayer',
  todistus1: 'testimony1', todistus2: 'testimony2',
  puhe1: 'talk1', puhe2: 'talk2', puhe3: 'talk3',
  alkulaulu: 'opening_hymn', sakramenttilaulu: 'sacrament_hymn', musiikkiesitys: 'musical_number',
  välilaulu: 'intermediate_hymn', loppulaulu: 'closing_hymn',
  säestäjä: 'accompanist', laulunjohtaja: 'chorister',
  tulkki: 'interpreter',
  henkilö: 'person', organisaatio: 'organization', tehtävä: 'calling', tila: 'status',
  huomioitavaa: 'notes',
  tapaaminen: 'meeting', aihe: 'topic', päättyy: 'expires',
  asia: 'item',
  vaihe: 'phase'
};
const COLUMNS_KEPT = ['id', 'position', 'people', 'created_at', 'updated_at', '_status', 'rosterPublic'];

const LISTS = {
  seurakuntalaiset: 'members',
  piispakunta: 'bishopric',
  organisaatio: 'organizations',
  tehtävät: 'callings',
  tilat: 'ref_statuses',
  laulut: 'hymns',
  säestäjät: 'accompanists',
  laulunjohtajat: 'choristers',
  tulkit: 'interpreters',
  siivoajat: 'cleaners',
  vieraat: 'visitors',
  keskustelu: 'interview_topics'
};

// The bishopric roles. A view filters on these ($or over responsible), so they are schema, not data.
const BISHOPRIC = { piispa: 'bishop', '1na': 'counselor1', '2na': 'counselor2' };

// The calling workflow. Paired by PHASE and POSITION, which is the order the board's lanes run in --
// and confirmed by the two the meeting program filters on: `vastaanotettu` -> accepted (sustainings)
// and `kiitetään` -> released (releases).
//
// `id` and `position` are the shipped example's, so an imported row OVERWRITES the example's rather
// than landing beside it as a duplicate lane -- and the board's lane ORDER ends up the example's
// order, which this ward's numbering already agreed with.
const STATUSES = {
  'Tarvitsee tehtävän':        { status: 'needs_calling',           phase: 'consideration',  id: 'st-15', position: '1' },
  'Keskustellaan':             { status: 'under_discussion',        phase: 'consideration',  id: 'st-1',  position: '2' },
  'Rukoillaan':                { status: 'praying_about_it',        phase: 'consideration',  id: 'st-2',  position: '3' },
  'Hyväksytty piispakunnassa': { status: 'approved_by_bishopric',   phase: 'consideration',  id: 'st-3',  position: '4' },
  'kutsutaan':                 { status: 'called',                  phase: 'call',           id: 'st-4',  position: '5' },
  'vastaanotettu':             { status: 'accepted',                phase: 'call',           id: 'st-5',  position: '6' },
  'Hyväksytty seurakunnassa':  { status: 'sustained',               phase: 'call',           id: 'st-6',  position: '7' },
  'Hyväksyminen kirjattu':     { status: 'sustaining_recorded',     phase: 'call',           id: 'st-7',  position: '8' },
  'Erotettu tehtävään':        { status: 'set_apart',               phase: 'setting_apart',  id: 'st-8',  position: '9' },
  'Erotus tehtävään kirjattu': { status: 'setting_apart_recorded',  phase: 'setting_apart',  id: 'st-9',  position: '10' },
  'Tarvitsee vapauttaa':       { status: 'needs_release',           phase: 'release',        id: 'st-10', position: '11' },
  'kiitetään':                 { status: 'released',                phase: 'release',        id: 'st-11', position: '12' },
  'Vapautettu':                { status: 'release_done',            phase: 'release',        id: 'st-12', position: '13' },
  'Vapautus kirjattu':         { status: 'release_recorded',        phase: 'release',        id: 'st-13', position: '14' },
  'Kieltäytynyt':              { status: 'declined',                phase: 'declined',       id: 'st-14', position: '15' }
};

const PAGES = { tietoja: 'doc_about', sisainen: 'doc_internal' };
const ROTATIONS = { siivous: 'duty_cleaning' };

// Which converted column carries a value that is itself renamed -- and whether anything ELSE is
// allowed there.
//
//   responsible  is bishopric-only, and a view FILTERS on it ($or over the three roles), so a value
//                outside the map is a mistake worth stopping for.
//   presiding    carries `listSwitch: { list: visitors }`: a visiting authority presides under their
//                own name ("Michael Koivisto (VJ)"). Those are data, not vocabulary -- map the three
//                roles, pass everything else through untouched.
const VALUE_MAPS = {
  responsible: { map: BISHOPRIC, strict: true },
  presiding: { map: BISHOPRIC, strict: false }
};

// --- Conversion -----------------------------------------------------------------------------------
function convert(src) {
  const problems = [];
  const notes = [];
  const out = {};

  const col = (name, where) => {
    if (COLUMNS_KEPT.includes(name)) return name;
    if (COLUMNS[name]) return COLUMNS[name];
    problems.push('unknown column `' + name + '` in ' + where);
    return name;
  };

  // --- tables + rows
  if (src.tables) {
    out.tables = {};
    for (const [key, rows] of Object.entries(src.tables)) {
      // `tasks__archive` is the pre-`_status` archive partition; the base name is what is renamed.
      const [base, part] = key.split('__');
      if (!TABLES[base]) { problems.push('unknown table `' + base + '`'); continue; }
      const target = TABLES[base] + (part ? '__' + part : '');
      out.tables[target] = (Array.isArray(rows) ? rows : (rows && rows.rows) || []).map((row) => {
        const converted = {};
        for (const [k, v] of Object.entries(row)) {
          const nk = col(k, base);
          converted[nk] = mapValue(nk, v, base, problems);
        }
        // The lookup table's rows ARE the example's rows: adopt its ids so an import overwrites them
        // instead of doubling every lane on the board. Phase and position come from the same entry,
        // so the board's lane ORDER survives even though this ward numbered them differently.
        if (base === 'tilat') {
          const known = STATUSES[row.tila];
          if (known) { converted.id = known.id; converted.position = known.position; converted.phase = known.phase; }
        }
        return converted;
      });
    }
  }

  // --- lists (a full replacement on import, so every list has to survive the rename)
  if (src.lists) {
    out.lists = {};
    for (const [name, values] of Object.entries(src.lists)) {
      if (!LISTS[name]) { problems.push('unknown list `' + name + '`'); continue; }
      const target = LISTS[name];
      out.lists[target] = values.map((v) => (target === 'bishopric' ? (BISHOPRIC[v] || v) : v));
      if (target === 'bishopric') {
        for (const v of values) if (!BISHOPRIC[v]) problems.push('unknown bishopric role `' + v + '`');
      }
    }
  }

  // --- doc-view bodies. The id IS the view name, and one body embeds the other by name.
  if (Array.isArray(src.pages)) {
    out.pages = [];
    for (const page of src.pages) {
      if (!PAGES[page.id]) { problems.push('unknown page `' + page.id + '`'); continue; }
      let markdown = String(page.markdown || '');
      for (const [fi, en] of Object.entries(PAGES)) {
        markdown = markdown.split('{{view:' + fi + '}}').join('{{view:' + en + '}}');
      }
      out.pages.push({ id: PAGES[page.id], markdown: markdown });
    }
  }

  // --- portable config: the rotation anchor and window are keyed by VIEW name.
  if (src.config) {
    out.config = {};
    for (const [section, byView] of Object.entries(src.config)) {
      if (!/^rotation/.test(section) || !byView || typeof byView !== 'object') { out.config[section] = byView; continue; }
      out.config[section] = {};
      for (const [view, value] of Object.entries(byView)) {
        if (!ROTATIONS[view]) { problems.push('unknown rotation view `' + view + '` in config.' + section); continue; }
        out.config[section][ROTATIONS[view]] = value;
      }
    }
  }

  // --- what the shipped language pack cannot carry: the strings that name THIS ward.
  const fi = (src.translations && (src.translations.Suomi || src.translations.fi)) || {};
  for (const [oldKey, newKey] of [['app.title', 'app.title'], ['tervetuloa', 'text.welcome']]) {
    if (fi[oldKey]) notes.push(newKey + ' = ' + JSON.stringify(fi[oldKey]));
  }

  return { bundle: out, problems, notes };
}

function mapValue(column, value, table, problems) {
  const spec = VALUE_MAPS[column];
  if (spec && typeof value === 'string' && value !== '') {
    if (spec.map[value]) return spec.map[value];
    if (spec.strict) problems.push('unknown value `' + value + '` in ' + table + '.' + column);
    return value;
  }
  // `status` is the workflow value, on the callings rows AND as the lookup table's own column.
  if (column === 'status' && typeof value === 'string' && value !== '') {
    if (!STATUSES[value]) { problems.push('unknown status `' + value + '` in ' + table); return value; }
    return STATUSES[value].status;
  }
  return value;
}

// --- CLI ------------------------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const input = args.find((a) => a[0] !== '-');
  const outAt = args.indexOf('-o');
  if (!input) {
    console.error('usage: node bishopric-fi-to-en.js <export.json> [-o converted.json]');
    process.exit(2);
  }
  const src = JSON.parse(fs.readFileSync(input, 'utf8'));

  // Refuse a file that is not what this maps. Converting the wrong export would produce a bundle that
  // imports cleanly and means nothing.
  const looksRight = src.tables && ['kokoukset', 'tehtävät', 'tilat'].every((t) => t in src.tables);
  if (!looksRight) {
    console.error(input + ' does not look like a Finnish bishopric export (expects kokoukset/tehtävät/tilat).');
    process.exit(1);
  }

  const { bundle, problems, notes } = convert(src);

  if (problems.length) {
    console.error('Refusing to write: ' + problems.length + ' thing(s) this script does not know.\n');
    for (const p of [...new Set(problems)]) console.error('  - ' + p);
    console.error('\nAdd them to the maps at the top of this file, then run it again.');
    process.exit(1);
  }

  const dest = outAt >= 0 ? args[outAt + 1]
    : path.join(path.dirname(input), path.basename(input, '.json') + '.en.json');
  fs.writeFileSync(dest, JSON.stringify(bundle, null, 2) + '\n');

  const rows = Object.values(bundle.tables || {}).reduce((n, r) => n + r.length, 0);
  console.log('Wrote ' + dest);
  console.log('  ' + Object.keys(bundle.tables || {}).length + ' stores, ' + rows + ' rows, '
    + Object.keys(bundle.lists || {}).length + ' lists, ' + (bundle.pages || []).length + ' pages.');
  console.log('  No schema and no translations: install examples/bishopric-schema.json and'
    + ' examples/bishopric-lang-fi.json from Settings -> Examples first.');
  if (notes.length) {
    console.log('\nStrings the shipped pack cannot carry (paste into Settings -> Languages):');
    for (const n of notes) console.log('  ' + n);
  }
}

module.exports = { convert, TABLES, COLUMNS, LISTS, STATUSES, BISHOPRIC, PAGES, ROTATIONS };
