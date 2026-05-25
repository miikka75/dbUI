const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalBackend } = require('../backend-local');

let backend;

beforeEach(() => { backend = createLocalBackend(); });
afterEach(() => { backend.close(); });

describe('Lists (dropdown options)', () => {
  it('getLists returns empty when no lists exist', () => {
    assert.deepEqual(backend.getLists('local'), {});
  });

  it('saveLists stores and retrieves lists', () => {
    backend.saveLists('local', { status: ['Open', 'Done'], people: ['Alice', 'Bob'] });
    const lists = backend.getLists('local');
    assert.deepEqual(lists.status, ['Open', 'Done']);
    assert.deepEqual(lists.people, ['Alice', 'Bob']);
  });

  it('saveLists overwrites existing lists', () => {
    backend.saveLists('local', { status: ['Open'] });
    backend.saveLists('local', { status: ['Open', 'Closed'] });
    assert.deepEqual(backend.getLists('local').status, ['Open', 'Closed']);
  });

  it('saveLists removes deleted lists', () => {
    backend.saveLists('local', { status: ['Open'], priority: ['High'] });
    backend.saveLists('local', { status: ['Open'] });
    const lists = backend.getLists('local');
    assert.ok(!lists.priority);
  });

  it('saveLists handles empty list', () => {
    backend.saveLists('local', { status: [] });
    const lists = backend.getLists('local');
    // Empty lists have no rows, so they don't appear in getLists
    assert.ok(!lists.status || lists.status.length === 0);
  });
});

describe('putListItem', () => {
  it('adds item to existing list', () => {
    backend.saveLists('local', { colors: ['red', 'blue'] });
    backend.putListItem('local', 'colors', 'green');
    const lists = backend.getLists('local');
    assert.deepEqual(lists.colors, ['red', 'blue', 'green']);
  });

  it('adds item to new list', () => {
    backend.saveLists('local', {});
    backend.putListItem('local', 'sizes', 'large');
    const lists = backend.getLists('local');
    assert.deepEqual(lists.sizes, ['large']);
  });

  it('allows duplicate items', () => {
    backend.saveLists('local', { colors: ['red'] });
    backend.putListItem('local', 'colors', 'red');
    const lists = backend.getLists('local');
    assert.ok(lists.colors.includes('red'));
  });
});
