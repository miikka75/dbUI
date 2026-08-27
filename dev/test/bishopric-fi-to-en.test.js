// bishopric-fi-to-en.test.js — the one-way migration from the Finnish original of the bishopric
// example to the vocabulary the example ships in.
//
// The fixture is a slice of a real export, kept small but covering every class of rename: a table
// key, an archive partition, column names, the two value vocabularies the SCHEMA filters on
// (bishopric roles, calling statuses), a list rename, a lookup row that must adopt the example's id,
// a doc-view body that embeds another by name, and the rotation config keyed by view name.
//
// The property that matters most is the refusal: an unmapped anything must fail loudly rather than
// silently drop a column, because the output is imported over a live database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { convert } = require('../../scripts/bishopric-fi-to-en');
const EXAMPLE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'examples', 'bishopric-schema.json'), 'utf8'));

const FIXTURE = {
  schema: { tables: {}, views: [] },
  tables: {
    kokoukset: [{
      id: 'mq682jqfbx8kf', pvm: '2026-08-30', teema: 'Rukoile enemmän', johtaja: 'piispa',
      vastuussa: 'piispa', alkurukous: '', todistus1: '', todistus2: '', puhe1: 'Emmi Kuosmanen',
      puhe2: 'Joonas Tuppurainen', puhe3: 'Laura Hurskainen', loppurukous: '',
      created_at: '2026-06-09T05:51:43.719Z', updated_at: '2026-08-27T19:09:46.437Z'
    }],
    kokoukset__archive: [{ id: 'mpd0em1m9s7p4', pvm: '2026-05-24', teema: '', vastuussa: '1na', puhe1: 'Kaisu Metsä-Tokila' }],
    musiikki: [{ id: 'm1', pvm: '2026-08-30', säestäjä: 'Johanna Huhtamäki', laulunjohtaja: 'Ottilia Koskialho',
      alkulaulu: '78. Rakkauden Herra', sakramenttilaulu: '', musiikkiesitys: '', välilaulu: '', loppulaulu: '' }],
    tehtävät: [
      { id: 'mpfr8wadcdl0b', pvm: '2026-07-26', henkilö: 'Petteri Marjanen', organisaatio: 'Pyhäkoulu',
        tehtävä: 'Opettaja', tila: 'Erotus tehtävään kirjattu', vastuussa: '1na', huomioitavaa: '' },
      { id: 'mr3un2ef4fpld', pvm: '', henkilö: 'Matti Jouttenus', organisaatio: 'Alkeisyhdistys',
        tehtävä: 'Opettaja', tila: 'vastaanotettu', vastuussa: '1na', huomioitavaa: '', _status: 'archive' }
    ],
    keskustelut: [{ id: 'k1', tapaaminen: '', henkilö: 'Jaron Tuppurainen', aihe: 'Vuosittainen keskustelu', vastuussa: 'piispa', päättyy: '' }],
    muistettavat: [{ id: 'r1', pvm: '2026-06-11', vastuussa: '2na', asia: 'Valmistele suunnitelma', henkilö: 'Sami Rantanen' }],
    vastuut: [{ id: 'v1', organisaatio: 'Apuyhdistys', vastuussa: 'piispa' }],
    tilat: [
      { id: 'msrsip14h5wty', vaihe: 'Harkinta', tila: 'Tarvitsee tehtävän', position: '1' },
      { id: 'tr-5', vaihe: 'Kutsu', tila: 'vastaanotettu', position: '5' },
      { id: 'tr-11', vaihe: 'Vapautus', tila: 'kiitetään', position: '11' }
    ],
    ovimiehet_vuorot: [{ id: 'o1', pvm: '2026-08-30' }],
    ovimiehet_lista: [{ id: 'ol1', position: '1', people: ['Markku Partanen', 'Sami Rantanen'] }],
    tulkit: [{ id: 't1', pvm: '2026-08-30', teema: '', tulkki: 'Joonatan Kuosmanen' }],
    siivous_a: [{ id: 's1', position: '1', people: ['Miikka Tuppurainen', 'Kati Tuppurainen'] }],
    siivous_b: []
  },
  lists: {
    piispakunta: ['piispa', '1na', '2na'],
    seurakuntalaiset: ['Minna Hintikka', 'Kati Tuppurainen'],
    organisaatio: ['Apuyhdistys', 'Pyhäkoulu'],
    tehtävät: ['Johtaja', 'Opettaja'],
    laulut: ['1. Nyt aamu koittaa armainen'],
    säestäjät: ['Johanna Huhtamäki'],
    laulunjohtajat: ['Kati Tuppurainen'],
    tulkit: ['Jaana Suontausta'],
    siivoajat: [],
    vieraat: ['Michael Koivisto (VJ)'],
    keskustelu: ['Vuosittainen keskustelu']
  },
  pages: [
    { id: 'tietoja', markdown: '# Tervetuloa\n\nTästä löydät ohjelman.\n\n{{view:sisainen}}' },
    { id: 'sisainen', markdown: '# Piispakunnan työkalu' }
  ],
  config: {
    rotationRanges: { siivous: { periods: 20, from: '2026-06-08' } },
    rotationAnchors: { siivous: '2026-03-23' }
  },
  translations: { Suomi: { 'app.title': 'Piispakunnan Työkalu', tervetuloa: 'Tervetuloa Tampereen 1. seurakunnan kokoukseen' } }
};

describe('bishopric fi -> en conversion', () => {
  const { bundle, problems, notes } = convert(FIXTURE);

  it('maps a real export with nothing left unknown', () => {
    assert.deepEqual(problems, []);
  });

  it('renames every table, keeping the archive partition suffix', () => {
    assert.deepEqual(Object.keys(bundle.tables).sort(), [
      'admin_callings', 'admin_interviews', 'admin_reminders', 'admin_responsibilities',
      'duty_cleaning_a', 'duty_cleaning_b', 'duty_interpreters', 'duty_usher_dates', 'duty_ushers',
      'meeting_agenda', 'meeting_agenda__archive', 'meeting_music', 'ref_statuses'
    ]);
  });

  it('renames columns and keeps ids, timestamps and the archive stamp', () => {
    const row = bundle.tables.meeting_agenda[0];
    assert.deepEqual(Object.keys(row).sort(), [
      'closing_prayer', 'created_at', 'date', 'id', 'opening_prayer', 'presiding', 'responsible',
      'talk1', 'talk2', 'talk3', 'testimony1', 'testimony2', 'theme', 'updated_at'
    ]);
    assert.equal(row.id, 'mq682jqfbx8kf');
    assert.equal(row.talk1, 'Emmi Kuosmanen');
    assert.equal(bundle.tables.admin_callings[1]._status, 'archive');
  });

  it('translates the two value vocabularies the schema filters on', () => {
    assert.equal(bundle.tables.meeting_agenda[0].presiding, 'bishop');
    assert.equal(bundle.tables.meeting_agenda[0].responsible, 'bishop');
    assert.equal(bundle.tables.meeting_agenda__archive[0].responsible, 'counselor1');
    assert.equal(bundle.tables.admin_callings[0].status, 'setting_apart_recorded');
    assert.equal(bundle.tables.admin_callings[1].status, 'accepted');
    assert.deepEqual(bundle.lists.bishopric, ['bishop', 'counselor1', 'counselor2']);
  });

  it('leaves the ward\'s own data alone — names, organisations, hymns, callings', () => {
    assert.equal(bundle.tables.admin_callings[0].person, 'Petteri Marjanen');
    assert.equal(bundle.tables.admin_callings[0].organization, 'Pyhäkoulu');
    assert.equal(bundle.tables.admin_callings[0].calling, 'Opettaja');
    assert.deepEqual(bundle.lists.members, ['Minna Hintikka', 'Kati Tuppurainen']);
    assert.deepEqual(bundle.tables.duty_cleaning_a[0].people, ['Miikka Tuppurainen', 'Kati Tuppurainen']);
  });

  it('lands the lookup rows on the ids the example ships, so they overwrite rather than duplicate', () => {
    const shipped = new Map(EXAMPLE.tables.ref_statuses.map((r) => [r.id, r]));
    const accepted = bundle.tables.ref_statuses.find((r) => r.status === 'accepted');
    assert.equal(accepted.id, 'st-5');
    assert.equal(accepted.phase, 'call');
    assert.equal(shipped.get('st-5').status, 'accepted', 'the shipped row this overwrites says the same thing');

    const released = bundle.tables.ref_statuses.find((r) => r.status === 'released');
    assert.equal(released.id, 'st-11');
    assert.equal(shipped.get('st-11').status, 'released');
  });

  it('gives the one status the example never shipped a fresh id, and says so', () => {
    const novel = bundle.tables.ref_statuses.find((r) => r.status === 'needs_calling');
    assert.equal(novel.id, 'st-15');
    assert.ok(!EXAMPLE.tables.ref_statuses.some((r) => r.id === 'st-15'), 'st-15 is genuinely free');
    assert.ok(notes.some((n) => n.includes('list.ref_statuses.needs_calling')));
  });

  it('every status it produces is one the example schema knows about', () => {
    const shipped = new Set(EXAMPLE.tables.ref_statuses.map((r) => r.status));
    for (const row of bundle.tables.ref_statuses) {
      if (row.status === 'needs_calling') continue;              // the ward's own addition
      assert.ok(shipped.has(row.status), 'unknown status produced: ' + row.status);
    }
  });

  it('renames lists, and every name it produces is one the example schema uses', () => {
    const used = new Set(Object.keys(EXAMPLE.lists));
    for (const name of Object.keys(bundle.lists)) {
      assert.ok(used.has(name), 'list the example does not ship: ' + name);
    }
  });

  it('renames doc-view ids and the {{view:}} token inside a body', () => {
    const about = bundle.pages.find((p) => p.id === 'doc_about');
    assert.ok(about, 'tietoja -> doc_about');
    assert.match(about.markdown, /\{\{view:doc_internal\}\}/);
    assert.ok(!about.markdown.includes('sisainen'));
    assert.ok(bundle.pages.some((p) => p.id === 'doc_internal'));
  });

  it('rekeys the rotation config, which is keyed by VIEW name', () => {
    assert.deepEqual(bundle.config.rotationAnchors, { duty_cleaning: '2026-03-23' });
    assert.deepEqual(bundle.config.rotationRanges, { duty_cleaning: { periods: 20, from: '2026-06-08' } });
  });

  it('carries no schema and no translations — those come from the example', () => {
    assert.equal(bundle.schema, undefined);
    assert.equal(bundle.translations, undefined);
    // ...but reports the ward-specific strings the shipped pack cannot know.
    assert.ok(notes.some((n) => n.startsWith('app.title =')));
    assert.ok(notes.some((n) => n.startsWith('text.welcome =')));
  });

  it('refuses rather than silently dropping something it does not know', () => {
    const withJunk = JSON.parse(JSON.stringify(FIXTURE));
    withJunk.tables.kokoukset[0].uusiSarake = 'x';
    withJunk.tables.tuntematon = [{ id: 'z' }];
    withJunk.lists.tuntematonLista = [];
    withJunk.tables.tehtävät[0].tila = 'Ei tällaista tilaa';
    const r = convert(withJunk);
    assert.ok(r.problems.some((p) => p.includes('unknown column `uusiSarake`')));
    assert.ok(r.problems.some((p) => p.includes('unknown table `tuntematon`')));
    assert.ok(r.problems.some((p) => p.includes('unknown list `tuntematonLista`')));
    assert.ok(r.problems.some((p) => p.includes('unknown status `Ei tällaista tilaa`')));
  });
});
