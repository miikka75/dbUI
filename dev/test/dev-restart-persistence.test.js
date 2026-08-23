// dev-restart-persistence.test.js — `APP_DB=<file>` has to survive a restart.
//
// Two things made the dev server lose everything between runs, and together they are why a link an
// admin had already made kept coming back as "you are not linked to a person in this app":
//
//   1. With no APP_DB set, PGlite is handed `{}` — an IN-MEMORY database. The default dev server
//      therefore starts empty every time, while the JSON sidecars (users, profiles, requests) are
//      restored from disk. Grants come back; everything else does not.
//   2. Setting APP_DB to get a persisted dataDir did not help, because the bootstrap ran an unguarded
//      `create role authenticated` on every boot. The second start failed outright, so the persistent
//      option worked exactly once.
//
// This pins (2), which is what makes the persistent option usable at all.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEV_DIR = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbui-persist-'));
const DB = path.join(tmp, 'persist.db');
const started = [];

function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR, env: Object.assign({}, process.env, { PORT: '0', APP_DB: DB }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  started.push(child);
  let buf = '';
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('server never reported a port:\n' + buf)), 60000);
    child.stdout.on('data', (b) => {
      buf += b.toString();
      const m = buf.match(/Local dev server: (http:\/\/\S+)/);
      if (m) { clearTimeout(timer); res({ child, base: m[1] }); }
    });
    child.stderr.on('data', (b) => { buf += b.toString(); });
    child.on('exit', (code) => { clearTimeout(timer); rej(new Error('server exited (' + code + '):\n' + buf)); });
  });
}
const api = (base, route, body = {}, user = 'admin@dev') =>
  fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: JSON.stringify(body) }).then((r) => r.json().catch(() => null));

const SCHEMA = { defaultLanguage: 'en', tables: { notes: { columns: [{ name: 'title', type: 'text' }] } },
  views: [{ table: 'notes' }], nav: { items: [{ table: 'notes' }] } };

after(() => {
  for (const c of started) { try { c.kill(); } catch (e) { /* already gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});

describe('dev server — a file-backed database survives a restart', () => {
  it('boots a second time on the same dataDir, with the rows still in it', async () => {
    const first = await startServer();
    await api(first.base, 'setUserRole', { uid: 'admin@dev', role: 'admin', user: 'admin@dev', tables: 'all' });
    await api(first.base, 'saveSchema', { schema: SCHEMA });
    await api(first.base, 'initSchema', { schema: SCHEMA.tables });
    await api(first.base, 'putRow', { tableId: 'notes', tab: 'active', data: { id: 'n1', title: 'survives' } });
    const before = await api(first.base, 'getTableData', { tableId: 'notes', tab: 'active' });
    assert.equal((before.rows || []).length, 1, 'the row should be there before we restart');
    first.child.kill();
    await new Promise((r) => setTimeout(r, 400));

    // The whole point: this used to throw `role "authenticated" already exists` and never serve.
    const second = await startServer();
    const after2 = await api(second.base, 'getTableData', { tableId: 'notes', tab: 'active' });
    assert.equal((after2.rows || []).length, 1, 'the row did not survive the restart');
    assert.equal(after2.rows[0].title, 'survives');
    // getSchema returns the schema itself, not a wrapper.
    const schema = await api(second.base, 'getSchema');
    assert.ok(schema && schema.tables && schema.tables.notes,
      'the schema did not survive the restart either: ' + JSON.stringify(schema).slice(0, 120));
    second.child.kill();
  });
});
