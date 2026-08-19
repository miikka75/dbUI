const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

let backend;

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('Lists (dropdown options)', () => {
  it('getLists returns empty when no lists exist', () => {
    assert.deepEqual(backend.getLists(), {});
  });

  it('saveLists stores and retrieves lists', () => {
    backend.saveLists({ status: ['Open', 'Done'], people: ['Alice', 'Bob'] });
    const lists = backend.getLists();
    assert.deepEqual(lists.status, ['Open', 'Done']);
    assert.deepEqual(lists.people, ['Alice', 'Bob']);
  });

  it('saveLists overwrites existing lists', () => {
    backend.saveLists({ status: ['Open'] });
    backend.saveLists({ status: ['Open', 'Closed'] });
    assert.deepEqual(backend.getLists().status, ['Open', 'Closed']);
  });

  it('saveLists removes deleted lists', () => {
    backend.saveLists({ status: ['Open'], priority: ['High'] });
    backend.saveLists({ status: ['Open'] });
    const lists = backend.getLists();
    assert.ok(!lists.priority);
  });

  it('saveLists handles empty list', () => {
    backend.saveLists({ status: [] });
    const lists = backend.getLists();
    // Empty lists have no rows, so they don't appear in getLists
    assert.ok(!lists.status || lists.status.length === 0);
  });
});

describe('putListItem', () => {
  it('adds item to existing list', () => {
    backend.saveLists({ colors: ['red', 'blue'] });
    backend.putListItem('colors', 'green');
    const lists = backend.getLists();
    assert.deepEqual(lists.colors, ['red', 'blue', 'green']);
  });

  it('adds item to new list', () => {
    backend.saveLists({});
    backend.putListItem('sizes', 'large');
    const lists = backend.getLists();
    assert.deepEqual(lists.sizes, ['large']);
  });

  it('allows duplicate items', () => {
    backend.saveLists({ colors: ['red'] });
    backend.putListItem('colors', 'red');
    const lists = backend.getLists();
    assert.ok(lists.colors.includes('red'));
  });
});

describe('saveLists robustness (malformed filter seeding)', () => {
  it('skips non-string list values instead of throwing', () => {
    assert.doesNotThrow(() => backend.saveLists({
      tilat: ['open', { $or: ['a', 'b'] }, undefined, 'done', 123]
    }));
    assert.deepEqual(backend.getLists().tilat, ['open', 'done']); // only strings persisted
  });

  it('putListItem ignores non-string values', () => {
    assert.doesNotThrow(() => backend.putListItem('tilat', { bad: 1 }));
    backend.putListItem('tilat', 'ok');
    assert.deepEqual(backend.getLists().tilat, ['ok']);
  });
});
