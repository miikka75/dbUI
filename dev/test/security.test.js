const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createFsBackend } = require('../storage-fs');
const { createLocalBackend } = require('../backend-local');

describe('Security - storage-fs path traversal', () => {
  const DIR = path.join(__dirname, '.test-sec-' + process.pid);
  let b;
  beforeEach(() => { b = createFsBackend(DIR); });
  afterEach(() => { b.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

  // safePath() still guards every read/write, but the generic file store that used to exercise it
  // went with the CRDT backend. The row + language APIs reach it through filePath(), so the guard is
  // pinned through those instead -- a table id is caller-supplied and lands in a filename.
  it('putRow rejects ../ escape in the table id', () => {
    assert.throws(() => b.putRow('../escape', { id: 'r1' }, 'active'), /Invalid path/);
  });
  it('putRow rejects a deep traversal in the table id', () => {
    assert.throws(() => b.putRow('../../tmp/evil', { id: 'r1' }, 'active'), /Invalid path/);
  });
  it('deleteRow rejects traversal in the table id', () => {
    assert.throws(() => b.deleteRow('../../tmp/evil', 'r1', 'active'), /Invalid path/);
  });
  it('getTableData on traversal reads nothing (error swallowed, no outside file leaked)', () => {
    assert.deepEqual(b.getTableData('../../etc/hostname', 'active').rows, []);
  });
  // The 'lang_' filename prefix absorbs one level on its own ('lang_../../evil' normalises back to
  // a file inside the data dir), so depth 3 is the shallowest that actually escapes -- and safePath,
  // not the prefix, is what stops it.
  it('createLanguage rejects traversal in the language code', () => {
    assert.throws(() => b.createLanguage('local', '../../../evil', 'Evil', ['k']), /Invalid path/);
  });
  it('normal table names still work', () => {
    b.putRow('tasks', { id: 'r1', title: 'ok' }, 'active');
    assert.deepEqual(b.getTableData('tasks', 'active').rows, [{ id: 'r1', title: 'ok' }]);
  });
});

describe('Security - SQLite identifier injection', () => {
  let b;
  beforeEach(() => { b = createLocalBackend(); });
  afterEach(() => { b.close(); });

  it('malicious table name with quote does not break out / drop tables', () => {
    b.initSchema('local', { real: { columns: ['id', 'v'], partition: 'active' } });
    // Attempt injection via tableId containing a double-quote
    const evil = 'x" ; DROP TABLE _tables; --';
    // Should not throw a syntax error nor drop _tables; treated as a (weird) identifier
    assert.doesNotThrow(() => b.getTableData(evil, 'active'));
    // _tables must still exist -> real table still registered
    assert.deepEqual(b.getAvailableTables('local').map(t => t.id), ['real']);
  });

  it('non-ASCII table/column names work', () => {
    b.initSchema('local', { 'café': { columns: ['id', 'résumé'], partition: 'upcoming' } });
    b.putRow('café', { id: 't1', 'résumé': 'Test' }, 'upcoming');
    const r = b.getTableData('café', 'upcoming');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]['résumé'], 'Test');
  });
});
