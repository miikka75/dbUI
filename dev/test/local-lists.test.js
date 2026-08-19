const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createLocalBackend } = require('../backend-local');

// Verifies the local backend stores lists per-list (one row {name,items,tables}) and migrates the
// legacy one-row-per-item (name,value) table in place, preserving every item.
describe('Local per-list storage + legacy migration', () => {
  const schema = {
    tables: {
      team_a: { columns: [{ name: 'people', type: 'multiselect', list: 'staff' }] },
      team_b: { columns: [{ name: 'people', type: 'multiselect', list: 'cleaners' }] },
      meetings: { columns: [{ name: 'speaker1', type: 'select', list: 'staff', listSwitch: { list: 'guests' } }] }
    }
  };

  function freshBackend() {
    const b = createLocalBackend(':memory:');
    b.saveSchema(schema);
    return b;
  }

  it('saveLists writes one row per list with items + owning tables', () => {
    const b = freshBackend();
    b.saveLists({ staff: ['A', 'B'], cleaners: ['C'], guests: ['G'] });
    assert.deepEqual(b.getLists(), { staff: ['A', 'B'], cleaners: ['C'], guests: ['G'] });
    assert.deepEqual(b.getLists().cleaners, ['C']);
  });

  it('putListItem upserts into the per-list row (dedupes)', () => {
    const b = freshBackend();
    b.putListItem('cleaners', 'X');
    b.putListItem('cleaners', 'Y');
    b.putListItem('cleaners', 'X'); // dup ignored
    assert.deepEqual(b.getLists().cleaners, ['X', 'Y']);
  });

  it('migrates a legacy (name,value) _lists table in place, preserving all items', () => {
    // Build a DB file with the OLD shape, then open it via the backend (triggers migration on getLists).
    const path = require('os').tmpdir() + '/listmig-' + Date.now() + '.db';
    const raw = new Database(path);
    raw.exec('CREATE TABLE _schema (key TEXT PRIMARY KEY, value TEXT)');
    raw.prepare('INSERT INTO _schema (key,value) VALUES (?,?)').run('schema', JSON.stringify(schema));
    raw.exec('CREATE TABLE _lists (name TEXT, value TEXT)');
    const ins = raw.prepare('INSERT INTO _lists (name,value) VALUES (?,?)');
    ['A', 'B', 'C'].forEach(v => ins.run('staff', v));
    ins.run('cleaners', 'Z');
    raw.close();

    const b = createLocalBackend(path);
    const lists = b.getLists(); // triggers _ensureLists migration
    assert.deepEqual(lists.staff, ['A', 'B', 'C']);
    assert.deepEqual(lists.cleaners, ['Z']);
    b.close();   // release the file handle -- Windows can't unlink an open db (and reopens it readonly next)

    // table is now the new shape (has items + tables columns, no value rows duplicated)
    const check = new Database(path, { readonly: true });
    const cols = check.pragma('table_info(_lists)').map(c => c.name).sort();
    assert.deepEqual(cols, ['items', 'name', 'tables']);
    const rowCount = check.prepare('SELECT COUNT(*) c FROM _lists').get().c;
    assert.equal(rowCount, 2); // one row per list, not per item
    const seur = check.prepare('SELECT items, tables FROM _lists WHERE name=?').get('staff');
    assert.deepEqual(JSON.parse(seur.items), ['A', 'B', 'C']);
    assert.deepEqual(JSON.parse(seur.tables).sort(), ['meetings', 'team_a']);
    check.close();
    require('fs').unlinkSync(path);
  });
});
