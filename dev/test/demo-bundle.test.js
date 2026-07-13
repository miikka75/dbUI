const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Guards dev/demo-bundle.json (the importable demo data) against schema drift: every table/list it
// targets must exist in schema.json, rows must be well-formed, and it must stay data-only (no schema).
const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'demo-bundle.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schema.json'), 'utf8'));
const tableNames = Object.keys(schema.tables || {});

describe('demo-bundle.json', () => {
  it('is a data-only bundle (no schema; carries tables/lists/translations/config)', () => {
    assert.equal(bundle.schema, undefined);                 // schema lives in schema.json; this layers on top
    for (const k of ['tables', 'lists', 'translations', 'config']) assert.ok(bundle[k], 'missing ' + k);
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
    for (const [code, map] of Object.entries(bundle.translations)) {
      assert.ok(code && typeof map === 'object');
      for (const [k, v] of Object.entries(map)) { assert.ok(k.length, 'empty key'); assert.equal(typeof v, 'string'); }
    }
  });

  it('every declared language has a translation map with the same key set', () => {
    const codes = bundle.languages.map(l => l.code);
    assert.ok(codes.length >= 2, 'demo should ship more than one language');
    const enKeys = Object.keys(bundle.translations.en).sort().join(',');
    for (const code of codes) {
      assert.ok(bundle.translations[code], 'no translations for declared language ' + code);
      assert.equal(Object.keys(bundle.translations[code]).sort().join(','), enKeys, code + ' key set differs from en');
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
