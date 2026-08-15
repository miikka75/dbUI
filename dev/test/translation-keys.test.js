// translation-keys.test.js — drift guards for the translatable-key surface.
//
// Two ways this rots silently, both invisible until someone opens the Languages editor:
//   (1) a new t('...') call whose key nobody adds to staticTranslationKeys() — the editor never offers
//       it, so NO language can translate it and it renders as a raw key forever. That is exactly how
//       settings.theme / theme_palette / theme_reset went untranslatable.
//   (2) a column that never reaches the screen still being offered for translation, padding the editor
//       with keys nobody can see (a reorderable table's numeric `position` being the usual case).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const appCore = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');

const STATIC = new Set(eval(
  appCore.match(/staticTranslationKeys: function\(\) \{\s*return (\[[\s\S]*?\])\.sort\(\);/)[1]));

// Keys derived from whatever schema is loaded, so they are never in the static list.
const SCHEMA_DERIVED = /^(tab|field|view|board\.group|text|embed)\.|^list\.[^.]+\./;

describe('translation keys', () => {
  it('every literal t()/tOr() key the app asks for is offered by staticTranslationKeys()', () => {
    const asked = new Set();
    for (const m of (appCore + ui).matchAll(/\bt(?:Or)?\(\s*'([a-z][a-z0-9_]*\.[a-z0-9_.]+)'/gi)) asked.add(m[1]);
    assert.ok(asked.size > 50, 'sanity: found ' + asked.size + ' literal keys');

    const missing = [...asked].filter(k => !STATIC.has(k) && !SCHEMA_DERIVED.test(k)).sort();
    assert.deepEqual(missing, [],
      'these keys are used but not listed in staticTranslationKeys(), so the Languages editor cannot ' +
      'offer them and they stay raw in every language: ' + missing.join(', '));
  });

  // tOr()'s fallback exists for keys whose default is the DATA being labelled (a column or list value,
  // which reads better raw than as `field.chore_name`) — so every legitimate call builds its key by
  // concatenation. A tOr() on a FULLY LITERAL key is always static UI prose with a hardcoded English
  // default, which renders English on an untranslated deployment instead of showing the key. That hides
  // the gap: the string looks finished, so nobody ever translates it. Those must use t().
  it('tOr() is never called with a fully literal key — static prose belongs to t()', () => {
    const literal = [];
    for (const [src, file] of [[appCore, 'app-core.js'], [ui, 'ui.html']]) {
      for (const m of src.matchAll(/\btOr\(\s*\\?'([a-z][a-z0-9_.]*)\\?'\s*,/gi)) literal.push(file + ': ' + m[1]);
    }
    assert.deepEqual(literal, [],
      'these tOr() calls hardcode an English default for a static key, so an untranslated deployment ' +
      'silently shows English instead of the key: ' + literal.join(', '));
  });

  // The shipped example packs are the only complete app-UI translation anyone starts from. A key added
  // to staticTranslationKeys() but not to them imports as a raw key on a fresh deployment, and nobody
  // notices until they open the Languages editor and find a blank row.
  it('the example app-lang packs cover every static key, in every language they ship', () => {
    // app.title names the deployment, so it belongs to the schema bundle, not the app-UI pack.
    const expected = [...STATIC].filter(k => k !== 'app.title').sort();
    for (const file of ['app-lang-en.json', 'app-lang-fi.json']) {
      const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', file), 'utf8'));
      for (const code of Object.keys(pack.translations)) {
        const have = pack.translations[code];
        assert.deepEqual(expected.filter(k => !(k in have)), [],
          file + ' [' + code + '] is missing app-UI keys the app asks for');
        assert.deepEqual(Object.keys(have).filter(k => !STATIC.has(k)).sort(), [],
          file + ' [' + code + '] carries keys the app never asks for');
        assert.deepEqual(Object.keys(have).filter(k => !String(have[k]).trim()), [],
          file + ' [' + code + '] has empty translations');
      }
    }
  });

  // _untranslatableCol is a pure helper; pull it out of the source rather than booting the whole app.
  const untranslatable = (() => {
    const src = appCore.match(/function _untranslatableCol\(cols, name\) \{[\s\S]*?\n\}/);
    assert.ok(src, '_untranslatableCol not found in app-core.js');
    return eval('(' + src[0].replace('function _untranslatableCol', 'function') + ')');
  })();

  it('storage columns and hidden columns have nothing to translate', () => {
    const cols = {
      title: 'text',
      position: { type: 'number', hidden: true },   // reorderable ordinal — never rendered
      status: { type: 'text' }
    };
    for (const sys of ['id', 'created_at', 'updated_at']) {
      assert.equal(untranslatable(cols, sys), true, sys + ' is a storage column');
    }
    assert.equal(untranslatable(cols, 'position'), true, 'hidden columns never reach the screen');
    assert.equal(untranslatable(cols, 'title'), false, 'a plain column is translatable');
    assert.equal(untranslatable(cols, 'status'), false, 'an object-defined visible column is translatable');
    assert.equal(untranslatable({}, 'whatever'), false, 'unknown columns default to translatable');
  });

  it('both key-derivation sites go through the helper', () => {
    // field.* labels and list.<refTable>.<value> values must apply the SAME rule, or a hidden column
    // disappears from one and lingers in the other.
    const derivation = appCore.slice(appCore.indexOf('schemaTranslationKeys: function'),
                                     appCore.indexOf('var views = schema.views'));
    const calls = derivation.match(/_untranslatableCol\(/g) || [];
    assert.equal(calls.length, 2, 'expected both the field.* and list.* derivations to use _untranslatableCol');
    assert.ok(!/\{ id: 1, created_at: 1, updated_at: 1 \}/.test(derivation),
      'the hand-rolled system-column map should be gone — it skipped the hidden check');
  });
});
