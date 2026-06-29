const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLocalBackend } = require('../backend-local');
const { createFsBackend } = require('../storage-fs');

// The unified CRDT backend stores all metadata via generic readFile/writeFile/deleteFile.
// Both server backends must implement them identically.
function runFileStoreTests(name, makeBackend, teardown) {
  describe('Generic file store - ' + name, () => {
    let b;
    beforeEach(() => { b = makeBackend(); });
    afterEach(() => { teardown(b); });

    it('writeFile + readFile round-trips an object', () => {
      b.writeFile('local', 'schema.json', { tables: { t1: {} }, defaultLanguage: 'fi' });
      assert.deepEqual(b.readFile('local', 'schema.json'), { tables: { t1: {} }, defaultLanguage: 'fi' });
    });

    it('readFile returns null for missing file', () => {
      assert.equal(b.readFile('local', 'nope.json'), null);
    });

    it('writeFile overwrites', () => {
      b.writeFile('local', 'lists.json', { a: [1] });
      b.writeFile('local', 'lists.json', { a: [2] });
      assert.deepEqual(b.readFile('local', 'lists.json'), { a: [2] });
    });

    it('deleteFile removes the file', () => {
      b.writeFile('local', 'lang_fi.json', { hello: 'Hello' });
      b.deleteFile('local', 'lang_fi.json');
      assert.equal(b.readFile('local', 'lang_fi.json'), null);
    });

    it('resetData clears generic files', () => {
      b.writeFile('local', 'schema.json', { tables: {} });
      b.resetData();
      assert.equal(b.readFile('local', 'schema.json'), null);
    });
  });
}

runFileStoreTests('SQLite', () => createLocalBackend(), (b) => b.close());

const FS_DIR = path.join(__dirname, '.test-fstore-' + process.pid);
runFileStoreTests('FS',
  () => createFsBackend(FS_DIR),
  (b) => { b.close(); fs.rmSync(FS_DIR, { recursive: true, force: true }); });
