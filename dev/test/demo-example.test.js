const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Guards the DEMO example (examples/demo-data.json + its demo-lang-<code>.json packs) against schema
// drift: every table/list it targets must exist in demo-schema.json, rows must be well-formed, and the
// data file must stay data-only (no schema).
//
// The three concerns are three files, as they are for every other bundle in examples/ — so the packs
// are folded back together here, the same way seed-import.js and the example picker fold them.
const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const bundle = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'demo-data.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'demo-schema.json'), 'utf8'));
const tableNames = Object.keys(schema.tables || {});

const packs = fs.readdirSync(EXAMPLES).filter(n => /^demo-lang-.*[.]json$/.test(n))
  .map(n => JSON.parse(fs.readFileSync(path.join(EXAMPLES, n), 'utf8')));
const languages = packs.flatMap(p => p.languages || []);
const translations = Object.assign({}, ...packs.map(p => p.translations || {}));

describe('the demo example bundle', () => {
  it('demo-data.json is data-only (no schema, no labels; carries tables/lists/config)', () => {
    assert.equal(bundle.schema, undefined);                 // structure lives in demo-schema.json
    assert.equal(bundle.translations, undefined);           // labels live in the demo-lang-* packs
    for (const k of ['tables', 'lists', 'config']) assert.ok(bundle[k], 'missing ' + k);
  });

  it('ships one language pack per declared language, each carrying only its own', () => {
    assert.ok(packs.length >= 2, 'the demo should ship more than one language');
    for (const pack of packs) {
      assert.equal((pack.languages || []).length, 1, 'a pack declares exactly the language it carries');
      assert.deepEqual(Object.keys(pack.translations || {}), [pack.languages[0].code]);
    }
  });

  it('targets only tables that exist in the schema; rows have ids', () => {
    for (const key of Object.keys(bundle.tables)) {
      const base = key.split('__')[0];
      assert.ok(tableNames.includes(base), 'unknown table in bundle: ' + base);
      for (const row of bundle.tables[key]) assert.ok(row.id, 'row missing id in ' + key);
    }
  });

  it('date columns are stored as YYYY-MM-DD', () => {
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
    for (const r of bundle.tables.chore_log) assert.ok(isDate(r.done_on), 'bad done_on: ' + r.done_on);
    for (const r of bundle.tables.tasks) assert.ok(isDate(r.date), 'bad date: ' + r.date);
    assert.ok(isDate(bundle.config.rotationRanges.crewrota.from));
  });

  it('list names resolve to lists used by the schema', () => {
    const schemaLists = new Set();
    for (const t of tableNames) {
      const cols = schema.tables[t].columns || [];
      const arr = Array.isArray(cols) ? cols : Object.values(cols);
      for (const c of arr) { if (c && c.list) schemaLists.add(c.list); if (c && c.listSwitch && c.listSwitch.list) schemaLists.add(c.listSwitch.list); }
    }
    // listSources-backed lists (e.g. `members`) are legitimately seeded even if only referenced dynamically.
    const allowed = new Set([...schemaLists, ...Object.keys(schema.listSources || {})]);
    for (const ln of Object.keys(bundle.lists)) assert.ok(allowed.has(ln), 'bundle seeds an unused list: ' + ln);
  });

  it('translation keys are non-empty strings mapped to strings', () => {
    for (const [code, map] of Object.entries(translations)) {
      assert.ok(code && typeof map === 'object');
      for (const [k, v] of Object.entries(map)) { assert.ok(k.length, 'empty key'); assert.equal(typeof v, 'string'); }
    }
  });

  it('every declared language has a translation map with the same key set', () => {
    const codes = languages.map(l => l.code);
    assert.ok(codes.length >= 2, 'demo should ship more than one language');
    const enKeys = Object.keys(translations.en).sort().join(',');
    for (const code of codes) {
      assert.ok(translations[code], 'no translations for declared language ' + code);
      assert.equal(Object.keys(translations[code]).sort().join(','), enKeys, code + ' key set differs from en');
    }
  });

  it('RSVP data links responses to events by id (rsvps.practice -> a practices.id)', () => {
    const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
    const eventIds = new Set(bundle.tables.practices.map(p => p.id));
    for (const p of bundle.tables.practices) assert.ok(isDate(p.date), 'bad practice date: ' + p.date);
    const statuses = new Set(['coming', 'maybe', 'out']);
    for (const r of bundle.tables.rsvps) {
      assert.ok(eventIds.has(r.practice), 'rsvp links to a non-existent practice id: ' + r.practice); // link by id, not date
      assert.ok(r.owner, 'rsvp missing owner');
      assert.ok(statuses.has(r.response), 'unexpected rsvp response: ' + r.response);
    }
    // the demo's current user (local@dev) has at least one response so "my status" is populated
    assert.ok(bundle.tables.rsvps.some(r => r.owner === 'local@dev'), 'no response for the demo current user');
  });
});
