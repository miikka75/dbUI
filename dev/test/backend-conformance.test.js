const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createLocalBackend } = require('../backend-local');
const { createFsBackend } = require('../storage-fs');

// The app + dev server call `backend.<method>()` uniformly across five interchangeable backends
// (SQLite, FS, Firebase, OAuth/Sheets, CRDT). Nothing else enforces that they stay in parity, so a
// method added to one and forgotten in another silently breaks that backend. This is a drift guard:
// the COMMON CONTRACT below is the floor every backend must implement (individual backends add extras
// — bootData, renameLanguage, getFileModifiedTime, the Firebase user/profile RPCs — which are fine).
const CONTRACT = [
  'getSchema', 'saveSchema', 'initSchema', 'validateFolder',
  'getFolderConfig', 'setFolderConfig',
  'getAvailableTables', 'getAvailableLanguages',
  'getTableData', 'putRow', 'deleteRow', 'moveRow',
  'getLists', 'saveLists', 'putListItem',
  'getTranslations', 'updateTranslations', 'createLanguage', 'deleteLanguage',
  'saveChangesets', 'loadChangesets'
];

describe('backend contract — Node backends (runtime)', () => {
  const FS_DIR = path.join(__dirname, '.test-conformance-' + process.pid);
  const sqlite = createLocalBackend();          // in-memory
  const fsb = createFsBackend(FS_DIR);
  after(() => { try { sqlite.close(); } catch (e) {} try { fsb.close(); } catch (e) {} fs.rmSync(FS_DIR, { recursive: true, force: true }); });

  for (const [name, backend] of [['SQLite', sqlite], ['FS', fsb]]) {
    it(name + ' implements every contract method', () => {
      const missing = CONTRACT.filter(m => typeof backend[m] !== 'function');
      assert.deepEqual(missing, [], name + ' is missing: ' + missing.join(', '));
    });
  }
});

describe('backend contract — browser backends (source scan)', () => {
  // Browser backends are HTML fragments (not requireable); scan the <script> for each contract method,
  // defined as `name: function` or `async name(`.
  function definedMethods(file) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    const set = new Set();
    let m;
    const re = /(?:async\s+)?([a-zA-Z_]\w*)\s*(?::\s*function|\()/g;
    while ((m = re.exec(src))) set.add(m[1]);
    return set;
  }

  for (const file of ['backend-firebase.html', 'backend-oauth.html', 'crdt-backend.html']) {
    it(file + ' defines every contract method', () => {
      const defined = definedMethods(file);
      const missing = CONTRACT.filter(m => !defined.has(m));
      assert.deepEqual(missing, [], file + ' is missing: ' + missing.join(', '));
    });
  }
});
