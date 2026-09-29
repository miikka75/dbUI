// dev-feed-upload.test.js — the dev file store keeps a calendar feed at ONE path.
//
// A published feed's path is its subscription, and revoking it is overwriting that path with an empty
// calendar. The dev store used to ignore the requested path and write a fresh timestamped file per
// upload — fine for an image, wrong for a feed: every republish handed out a new link, and blanking
// "the old path" blanked a file that was never written while the real one kept serving.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { startDevServer, stopDevServer } = require('./dev-server');

const DEV_DIR = path.join(__dirname, '..');
const DB_REL = path.join('test', '.feedup-' + process.pid + '.db');
const ID = 'test' + process.pid;
const FEED = path.join(DEV_DIR, 'uploads', 'feeds', ID + '.ics');
let child, BASE;
const made = [];

function upload(body) {
  return fetch(BASE + '/api/uploadFile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': 'boss@x.com' },
    body: JSON.stringify(body)
  });
}
const b64 = (s) => Buffer.from(s).toString('base64');

describe('dev server — a feed upload lands at its own path', () => {
  before(async () => {
    const started = await startDevServer(DB_REL);
    child = started.child; BASE = started.base;
  });
  after(async () => {
    await stopDevServer(child);
    for (const f of [FEED].concat(made)) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    for (const f of fs.readdirSync(path.join(DEV_DIR, 'test'))) {
      if (f.startsWith('.feedup-' + process.pid)) { try { fs.rmSync(path.join(DEV_DIR, 'test', f), { recursive: true, force: true }); } catch (e) {} }
    }
  });

  it('two uploads to one feed path give one URL, serving the latest file as text/calendar', async () => {
    const one = await (await upload({ path: 'feeds/' + ID + '.ics', base64: b64('BEGIN:VCALENDAR\r\nX-FIRST\r\nEND:VCALENDAR\r\n') })).json();
    const two = await (await upload({ path: 'feeds/' + ID + '.ics', base64: b64('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n') })).json();
    assert.equal(one.url, two.url);
    assert.match(two.url, new RegExp('/uploads/feeds/' + ID + '\\.ics$'));
    const res = await fetch(two.url);
    assert.match(res.headers.get('content-type'), /^text\/calendar/);
    const text = await res.text();
    assert.ok(text.startsWith('BEGIN:VCALENDAR'));
    assert.ok(!text.includes('X-FIRST'), 'the second upload replaced the first');
  });

  it('refuses any other caller-chosen path', async () => {
    for (const p of ['../server.js', 'feeds/../../x.ics', 'feeds/a.html', 'other/a.ics', 'feeds/a/b.ics']) {
      assert.equal((await upload({ path: p, base64: b64('x') })).status, 400, p);
    }
  });

  it('an upload naming no path still gets a fresh file, as an image does', async () => {
    const a = await (await upload({ name: 'pic.png', base64: b64('a') })).json();
    const b = await (await upload({ name: 'pic.png', base64: b64('b') })).json();
    assert.notEqual(a.url, b.url);
    made.push(...[a, b].map((r) => path.join(DEV_DIR, 'uploads', decodeURIComponent(r.url.split('/uploads/')[1]))));
  });
});
