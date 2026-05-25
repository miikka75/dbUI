const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');
const { SCHEMA, DEFAULT_LANGUAGE } = require('../schema');

let backend, strings, folderId;

function t(key) { return strings[key] || key; }

async function loadLanguage(code, defaultCode) {
  var baseTrans = backend.getTranslations(folderId, defaultCode);
  strings = baseTrans || {};
  if (code !== defaultCode) {
    var trans = backend.getTranslations(folderId, code);
    if (trans) strings = Object.assign({}, strings, trans);
  }
}

// Create default language with some test translations
const TEST_KEYS = ['app.title', 'btn.save'];
const DEFAULT_TRANSLATIONS = { 'app.title': 'My App', 'btn.save': 'Save' };
const TEST_TRANSLATIONS = {};
TEST_KEYS.forEach(k => { TEST_TRANSLATIONS[k] = 'translated-' + k; });

beforeEach(() => {
  backend = createLocalBackend();
  strings = {};
  folderId = 'local';
  // Create default language with translations (simulates first boot)
  backend.createLanguage(folderId, DEFAULT_LANGUAGE, DEFAULT_LANGUAGE, TEST_KEYS);
  backend.updateTranslations(folderId, DEFAULT_LANGUAGE, DEFAULT_TRANSLATIONS);
});
afterEach(() => { backend.close(); });

describe('Language switching flow', () => {
  it('translated keys return translated values after switch', async () => {
    backend.createLanguage(folderId, 'xx', 'TestLang', TEST_KEYS);
    backend.updateTranslations(folderId, 'xx', TEST_TRANSLATIONS);

    await loadLanguage('xx', DEFAULT_LANGUAGE);

    TEST_KEYS.forEach(key => {
      assert.equal(t(key), TEST_TRANSLATIONS[key]);
    });
  });

  it('untranslated keys fall back to default language', async () => {
    backend.createLanguage(folderId, 'xx', 'TestLang', TEST_KEYS);
    // Only translate first key
    backend.updateTranslations(folderId, 'xx', { [TEST_KEYS[0]]: 'only-this' });

    await loadLanguage('xx', DEFAULT_LANGUAGE);

    assert.equal(t(TEST_KEYS[0]), 'only-this');
    assert.equal(t(TEST_KEYS[1]), DEFAULT_TRANSLATIONS[TEST_KEYS[1]], 'untranslated key falls back to default language');
  });

  it('switching back to default language restores all keys', async () => {
    backend.createLanguage(folderId, 'xx', 'TestLang', []);
    backend.updateTranslations(folderId, 'xx', TEST_TRANSLATIONS);

    await loadLanguage('xx', DEFAULT_LANGUAGE);
    assert.equal(t(TEST_KEYS[0]), TEST_TRANSLATIONS[TEST_KEYS[0]]);

    await loadLanguage(DEFAULT_LANGUAGE, DEFAULT_LANGUAGE);
    assert.equal(t(TEST_KEYS[0]), DEFAULT_TRANSLATIONS[TEST_KEYS[0]]);
  });

  it('getAvailableLanguages returns code for added language', () => {
    backend.createLanguage(folderId, 'xx', 'TestLang', []);
    const langs = backend.getAvailableLanguages(folderId);
    const xx = langs.find(l => l.code === 'xx');
    assert.ok(xx, 'test language should be in list');
    assert.equal(xx.code, 'xx');
  });

  it('language with no translations returns default language values', async () => {
    backend.createLanguage(folderId, 'xx', 'TestLang', TEST_KEYS);
    // No updateTranslations call for xx

    await loadLanguage('xx', DEFAULT_LANGUAGE);

    TEST_KEYS.forEach(key => {
      assert.equal(t(key), DEFAULT_TRANSLATIONS[key], key + ' should be default language value when no translation');
    });
  });

  it('t() returns key itself when no translation exists anywhere', async () => {
    await loadLanguage(DEFAULT_LANGUAGE, DEFAULT_LANGUAGE);
    assert.equal(t('nonexistent.key'), 'nonexistent.key');
  });
});
