// migration-renames.test.js — translation keys move with the schema, or they are lost.
//
// Translation keys are generated per column as `field.<col>`. A migration that changes a column's
// identity therefore orphans every string filed under the old key — in every language at once, with no
// error anywhere: the schema is correct and the app simply renders raw keys, to the people least able
// to work out why. So a step that changes identity RECORDS the move, and applying those moves is a
// step OF migrating rather than a follow-up somebody has to remember.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const Migrations = require('../../migrations');

const R = [['field.old', 'field.new']];

describe('migrations — renameKeys', () => {
  it('moves a string to its new key and does not leave the old one behind', () => {
    assert.deepEqual(Migrations.renameKeys({ 'field.old': 'Topic', other: 'x' }, R),
      { other: 'x', 'field.new': 'Topic' });
  });

  it('replays a chain in order — renamed twice across two steps, it lands on the last name', () => {
    // Order is load-bearing ACROSS steps: v2->v3 renames a->b and v3->v4 renames b->c. Any other order
    // strands the string on b.
    const chain = [['field.a', 'field.b'], ['field.b', 'field.c']];
    assert.deepEqual(Migrations.renameKeys({ 'field.a': 'A' }, chain), { 'field.c': 'A' });
  });

  it('is idempotent — the chain re-runs every load until an admin writes the result back', () => {
    const once = Migrations.renameKeys({ 'field.old': 'Topic' }, R);
    assert.deepEqual(Migrations.renameKeys(once, R), once);
  });

  it('keeps the TARGET when both keys are translated', () => {
    // Somebody has already translated the new name; theirs is the current wording, and the string under
    // the old key is by definition the older one.
    assert.deepEqual(Migrations.renameKeys({ 'field.old': 'stale', 'field.new': 'current' }, R),
      { 'field.new': 'current' });
  });

  it('takes the old value when the new key exists but is blank', () => {
    assert.deepEqual(Migrations.renameKeys({ 'field.old': 'Topic', 'field.new': '' }, R),
      { 'field.new': 'Topic' });
  });

  it('does not mutate the map it is given', () => {
    const before = { 'field.old': 'Topic' };
    Migrations.renameKeys(before, R);
    assert.deepEqual(before, { 'field.old': 'Topic' });
  });

  it('survives empty and missing input', () => {
    assert.deepEqual(Migrations.renameKeys(null, R), {});
    assert.deepEqual(Migrations.renameKeys({ a: '1' }, null), { a: '1' });
    assert.deepEqual(Migrations.renameKeys({ a: '1' }, []), { a: '1' });
  });

  it('ignores a no-op or malformed rename', () => {
    assert.deepEqual(Migrations.renameKeys({ a: '1' }, [['a', 'a'], [null, 'b'], ['a', null]]), { a: '1' });
  });
});

describe('migrations — renamePatch, because updateTranslations can only merge', () => {
  it('carries the new key and blanks the old one', () => {
    // The merge API cannot delete. Leaving the old key with its old VALUE would be worse than cruft: a
    // column that later reappears under that name would silently inherit stale wording.
    assert.deepEqual(Migrations.renamePatch({ 'field.old': 'Topic', keep: 'k' }, R),
      { 'field.new': 'Topic', 'field.old': '' });
  });

  it('sends nothing at all on a second pass', () => {
    // Otherwise every boot that re-runs the chain issues a write per language, forever.
    assert.deepEqual(Migrations.renamePatch({ 'field.new': 'Topic', keep: 'k', 'field.old': '' }, R), {});
  });

  it('sends nothing when there is nothing to move', () => {
    assert.deepEqual(Migrations.renamePatch({ keep: 'k' }, R), {});
    assert.deepEqual(Migrations.renamePatch({ keep: 'k' }, []), {});
  });

  it('applying the patch to the stored map reproduces renameKeys exactly', () => {
    // The patch is what actually reaches storage, so it is the patch — not renameKeys — that has to be
    // right. Merging it onto the stored map must land in the same place.
    const stored = { 'field.old': 'Topic', keep: 'k' };
    const merged = Object.assign({}, stored, Migrations.renamePatch(stored, R));
    const direct = Migrations.renameKeys(stored, R);
    for (const k of Object.keys(direct)) assert.equal(merged[k], direct[k], k);
    for (const k of Object.keys(merged)) {
      if (!(k in direct)) assert.equal(merged[k], '', k + ' survived the patch still carrying a value');
    }
  });
});

describe('migrations — renameAll covers every language in one pass', () => {
  it('applies the same moves to each language independently', () => {
    const out = Migrations.renameAll({
      en: { 'field.old': 'Topic' },
      fi: { 'field.old': 'Aihe', extra: 'x' }
    }, R);
    assert.deepEqual(out.en, { 'field.new': 'Topic' });
    assert.deepEqual(out.fi, { 'field.new': 'Aihe', extra: 'x' });
  });

  it('survives an empty map', () => {
    assert.deepEqual(Migrations.renameAll(null, R), {});
  });
});

describe('migrations — no shipped language loses a string', () => {
  // The gate the plan names: migrate a schema plus its translations and assert zero keys lost, across
  // every language actually shipped. The chain carries no renames yet, so this drives the real packs
  // through a synthetic rename of every field.* key — the shape a column-vocabulary migration would
  // take, and the case where silent loss would hurt most.
  //
  // Reads the COMMITTED packs. It first read dev/data/lang_*.json, which exists on a developer machine
  // and not in a clean checkout — dev/data/ is gitignored, being the dev server's working directory.
  // The "would pass vacuously" guard below is what caught that, on CI, having passed locally.
  const packs = [];
  const addTranslations = (label, obj) => {
    Object.keys(obj || {}).forEach((code) => {
      if (obj[code] && typeof obj[code] === 'object') packs.push([label + ':' + code, obj[code]]);
    });
  };
  const exDir = path.join(ROOT, 'examples');
  if (fs.existsSync(exDir)) {
    for (const f of fs.readdirSync(exDir)) {
      if (f.indexOf('-lang-') < 0 || !f.endsWith('.json')) continue;
      const d = JSON.parse(fs.readFileSync(path.join(exDir, f), 'utf8'));
      addTranslations(f, d.translations);
    }
  }
  const bundle = path.join(ROOT, 'dev', 'demo-bundle.json');
  if (fs.existsSync(bundle)) addTranslations('demo-bundle.json', JSON.parse(fs.readFileSync(bundle, 'utf8')).translations);

  it('found language packs to check', () => {
    assert.ok(packs.length > 0, 'no committed translation packs — this suite would pass vacuously');
  });

  for (const [label, before] of packs) {
    it(label + ' keeps every translated string across a full field.* rename', () => {
      const fieldKeys = Object.keys(before).filter((k) => k.indexOf('field.') === 0);
      if (!fieldKeys.length) return;                 // an app-only pack may carry none
      const renames = fieldKeys.map((k) => [k, 'col.' + k.slice('field.'.length)]);

      const after = Migrations.renameKeys(before, renames);

      // Nothing vanished: every translated value present before is still present after, under one name
      // or another. Compared as a multiset of VALUES, because the keys are exactly what changed.
      const vals = (m) => Object.keys(m).filter((k) => m[k] !== '').map((k) => m[k]).sort();
      assert.deepEqual(vals(after), vals(before), label + ': a translated string was lost in the rename');

      // And every moved key landed where it was sent.
      for (const [from, to] of renames) {
        assert.ok(!(from in after), label + ': ' + from + ' was left behind');
        assert.equal(after[to], before[from], label + ': ' + to + ' did not receive the string');
      }
    });
  }

  it('at least one pack actually carries field.* keys, or the rename is never exercised', () => {
    const withFields = packs.filter(([, m]) => Object.keys(m).some((k) => k.indexOf('field.') === 0));
    assert.ok(withFields.length > 0, 'no pack has a field.* key — the gate would prove nothing');
  });
});

describe('migrations — the write-back applies renames rather than trusting anyone to remember', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');

  it('a translation step exists and the write-back calls it', () => {
    // Asserted against the SOURCE, like the other write-back guards: the failure here is not a crash,
    // it is a schema that migrated while its translations did not.
    assert.match(src, /_migrateTranslations: function/, 'no translation step exists');
    const wb = src.slice(src.indexOf('_writeBackMigratedSchema: function'), src.indexOf('_migrateTranslations: function'));
    assert.match(wb, /_migrateTranslations\(m\.renames\)/, 'the write-back does not apply the renames');
  });

  it('moves translations only AFTER the schema is saved', () => {
    // A refused save leaves nothing for the strings to belong to, and the flag is cleared either way —
    // so moving them first would strand them against a schema that never landed.
    const wb = src.slice(src.indexOf('_writeBackMigratedSchema: function'), src.indexOf('_migrateTranslations: function'));
    assert.ok(wb.indexOf('saveSchema') < wb.indexOf('_migrateTranslations'),
      'translations must move after the schema write, not before it');
  });

  it('one language failing does not abandon the rest', () => {
    const fn = src.slice(src.indexOf('_migrateTranslations: function'));
    assert.match(fn.slice(0, fn.indexOf('\n      },')), /\.catch\(/,
      'a per-language failure must be swallowed, or one unwritable language strands the others');
  });

  it('migrate() always reports a renames list, so a caller cannot silently skip it', () => {
    const r = Migrations.migrate({ views: [{ name: 'v', calendar: {} }] });
    assert.ok(Array.isArray(r.renames), 'migrate must always report renames');
  });
});
