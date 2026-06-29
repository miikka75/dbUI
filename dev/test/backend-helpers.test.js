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
    const d = { tables: { t: {} }, defaultLanguage: 'fi' };
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
  it('addLanguage appends without mutating', () => {
    const list = [{ code: 'fi', name: 'Suomi' }];
    const out = H.addLanguage(list, 'en', 'English');
    assert.deepEqual(out, [{ code: 'fi', name: 'Suomi' }, { code: 'en', name: 'English' }]);
    assert.equal(list.length, 1); // original untouched
  });
  it('addLanguage handles null list', () => {
    assert.deepEqual(H.addLanguage(null, 'fi', 'Suomi'), [{ code: 'fi', name: 'Suomi' }]);
  });
  it('removeLanguage filters by code without mutating', () => {
    const list = [{ code: 'fi', name: 'Suomi' }, { code: 'en', name: 'English' }];
    const out = H.removeLanguage(list, 'fi');
    assert.deepEqual(out, [{ code: 'en', name: 'English' }]);
    assert.equal(list.length, 2);
  });
  it('removeLanguage handles null list', () => {
    assert.deepEqual(H.removeLanguage(null, 'fi'), []);
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
