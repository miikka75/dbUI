// typecheck-scope.test.js — a new module is typechecked unless it is named here as outside the scope.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
// The root component, the backend adapters (they run over SDK and Node globals), the schema globals and the service worker.
const OUTSIDE = ['app-core.js', 'backend-firebase.js', 'backend-local-pglite.js', 'backend-supabase.js',
  'schema-loader.js', 'storage-firestore.js', 'storage-pglite.js', 'sw.js'];

describe('typecheck scope', () => {
  it('every top-level module is in tsconfig.json, or named as outside it', () => {
    const include = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8')).include;
    const missing = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && !OUTSIDE.includes(f) && !include.includes(f));
    assert.deepEqual(missing, [], 'add these to tsconfig.json include (or to OUTSIDE, with the reason): ' + missing.join(', '));
  });
});
