const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../backend-helpers');

describe('backend-helpers - storeName', () => {
  it('joins table + tab', () => assert.equal(H.storeName('tasks', 'active'), 'tasks__active'));
  it('defaults tab to active', () => assert.equal(H.storeName('tasks'), 'tasks__active'));
  it('supports custom partitions', () => assert.equal(H.storeName('music', 'upcoming'), 'music__upcoming'));
});

describe('backend-helpers - deriveHeaders', () => {
  it('keys of first row', () => assert.deepEqual(H.deriveHeaders([{ id: 'a', name: 'x' }]), ['id', 'name']));
  it('empty array -> []', () => assert.deepEqual(H.deriveHeaders([]), []));
  it('null -> []', () => assert.deepEqual(H.deriveHeaders(null), []));
});

describe('backend-helpers - unwrapSchemaDoc', () => {
  it('legacy {_json} -> parsed object', () => {
    assert.deepEqual(H.unwrapSchemaDoc({ _json: '{"tables":{"t":{}}}' }), { tables: { t: {} } });
  });
  it('{tables} -> as-is', () => {
    const d = { tables: { t: {} }, defaultLanguage: 'xx' };
    assert.equal(H.unwrapSchemaDoc(d), d);
  });
  it('null/empty -> null', () => {
    assert.equal(H.unwrapSchemaDoc(null), null);
    assert.equal(H.unwrapSchemaDoc(undefined), null);
    assert.equal(H.unwrapSchemaDoc({}), null);
  });
  it('malformed _json -> null (no throw)', () => {
    assert.equal(H.unwrapSchemaDoc({ _json: '{bad' }), null);
  });
});

describe('backend-helpers - addLanguage / removeLanguage', () => {
  it('addLanguage appends a new code without mutating', () => {
    const list = [{ code: 'xx', name: 'TestLang' }];
    const out = H.addLanguage(list, 'en', 'English');
    assert.deepEqual(out, [{ code: 'xx', name: 'TestLang' }, { code: 'en', name: 'English' }]);
    assert.equal(list.length, 1); // original untouched
  });
  it('addLanguage handles null list', () => {
    assert.deepEqual(H.addLanguage(null, 'xx', 'TestLang'), [{ code: 'xx', name: 'TestLang' }]);
  });
  it('addLanguage upserts by code -- re-adding never duplicates (re-importing a bundle calls it per language)', () => {
    const list = [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }];
    let out = H.addLanguage(list, 'en', 'English');
    assert.deepEqual(out, list);                       // same set, no second 'en'
    out = H.addLanguage(H.addLanguage(out, 'en', 'English'), 'en', 'English');
    assert.equal(out.filter(l => l.code === 'en').length, 1);
    assert.equal(list.length, 2);                      // original untouched
  });
  it('addLanguage heals a list already corrupted by the old append behaviour', () => {
    const dupes = [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' },
                   { code: 'en', name: 'English' }, { code: 'es', name: 'Español' }];
    const out = H.addLanguage(dupes, 'en', 'English');
    assert.deepEqual(out, [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }]);
  });
  it('addLanguage refreshes the display name of an existing code, in place', () => {
    const out = H.addLanguage([{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }], 'en', 'English (US)');
    assert.deepEqual(out, [{ code: 'en', name: 'English (US)' }, { code: 'es', name: 'Español' }]);
  });
  it('removeLanguage filters by code without mutating', () => {
    const list = [{ code: 'xx', name: 'TestLang' }, { code: 'en', name: 'English' }];
    const out = H.removeLanguage(list, 'xx');
    assert.deepEqual(out, [{ code: 'en', name: 'English' }]);
    assert.equal(list.length, 2);
  });
  it('removeLanguage handles null list', () => {
    assert.deepEqual(H.removeLanguage(null, 'xx'), []);
  });
});

describe('backend-helpers - emptyTranslations', () => {
  it('builds empty-string map from keys', () => {
    assert.deepEqual(H.emptyTranslations(['hello', 'bye']), { hello: '', bye: '' });
  });
  it('no keys -> {}', () => {
    assert.deepEqual(H.emptyTranslations(), {});
    assert.deepEqual(H.emptyTranslations(null), {});
  });
});
