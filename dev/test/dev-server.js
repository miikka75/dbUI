// dev-server.js — start a dev server for a test, and know when it is ready.
//
// Seven suites spawn `dev/server.js`, and they had two different ways of waiting for it. One polls a
// port derived from `process.pid % 200` every 50ms until a deadline, with `stdio: 'ignore'`; the other
// asks the OS for a free port (`PORT=0`), pipes the output, and resolves on the server's own "Local dev
// server: <url>" line. Only the second one can say what went wrong, and only the second one is right
// about WHEN the server is ready rather than when a poll happened to land.
//
// The difference stopped being cosmetic in CI. The dev server's default backend is PGlite, so every one
// of those spawns boots a WebAssembly Postgres and applies supabase-schema.sql before it answers —
// seconds each, and `node --test` runs the files concurrently. On a two-core runner the pollers ran out
// of deadline, the `before` hook threw, and every test in the suite was reported as
// "cancelled by parent": a red build that names seven tests, none of which is the problem.
//
// So this is the banner version, shared:
//   - PORT=0, so no arithmetic and no collision between concurrent suites;
//   - resolves the instant the server says it is listening, however long that took;
//   - rejects with the child's OWN output when it dies or never reports, so a crash reads as a crash;
//   - one ceiling, generous on purpose: it costs nothing when the server is up sooner, and the thing it
//     guards against is a hang, not a slow boot.
const { spawn } = require('node:child_process');
const path = require('node:path');

const DEV_DIR = path.join(__dirname, '..');
const READY = /Local dev server: (http:\/\/\S+)/;

// `db` is the APP_DB path the server should use, relative to dev/ (a per-test file keeps suites apart).
// Extra `env` entries are merged, for the few suites that need one.
function startDevServer(db, env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DEV_DIR,
    env: Object.assign({}, process.env, { PORT: '0', APP_DB: db }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buf = '';
  return new Promise((resolve, reject) => {
    const fail = (why) => reject(new Error(why + '\n--- server output ---\n' + (buf || '(nothing)')));
    const timer = setTimeout(() => fail('dev server never reported a port within 120s'), 120000);
    const done = (fn) => (arg) => { clearTimeout(timer); fn(arg); };
    const settleOut = done((base) => resolve({ child, base }));

    child.stdout.on('data', (b) => {
      buf += b.toString();
      const m = buf.match(READY);
      if (m) settleOut(m[1]);
    });
    child.stderr.on('data', (b) => { buf += b.toString(); });
    // A server that exits before it is ready is a failure NOW, not in two minutes: a port already taken
    // or a schema that will not apply both land here.
    child.once('exit', (code) => { if (!READY.test(buf)) done(() => fail('dev server exited (code ' + code + ') before it was ready'))(); });
    child.once('error', (e) => done(() => fail('dev server could not be spawned: ' + e.message))());
  });
}

// Stop it and WAIT for the exit, because the caller usually deletes the database next: SQLite writes its
// -wal/-shm companions as it closes, and sweeping while the process is still dying leaves them behind.
function stopDevServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  const exited = new Promise((r) => child.once('exit', r));
  child.kill();
  return exited;
}

module.exports = { startDevServer, stopDevServer };
