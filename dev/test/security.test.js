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

  it('writeFile rejects ../ escape', () => {
    assert.throws(() => b.writeFile('local', '../escape.json', { x: 1 }), /Invalid path/);
  });
  it('writeFile rejects absolute path escape', () => {
    assert.throws(() => b.writeFile('local', '../../tmp/evil.json', { x: 1 }), /Invalid path/);
  });
  it('readFile on traversal returns null (no throw leak of outside files)', () => {
    // readFile swallows errors -> null; the safePath throw is caught internally
    assert.equal(b.readFile('local', '../../etc/hostname'), null);
  });
  it('saveChangesets rejects traversal in siteId', () => {
    assert.throws(() => b.saveChangesets('local', '../../evil', '{}'), /Invalid path/);
  });
  it('normal filenames still work', () => {
    b.writeFile('local', 'schema.json', { ok: true });
    assert.deepEqual(b.readFile('local', 'schema.json'), { ok: true });
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

  it('non-ASCII table/column names work (Finnish)', () => {
    b.initSchema('local', { 'tehtävät': { columns: ['id', 'aihe'], partition: 'tulevat' } });
    b.putRow('tehtävät', { id: 't1', aihe: 'Testi' }, 'tulevat');
    const r = b.getTableData('tehtävät', 'tulevat');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].aihe, 'Testi');
  });
});
