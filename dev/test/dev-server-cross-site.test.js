// dev-server-cross-site.test.js — the dev server trusts X-User, so a browser on another site must not
// reach it: not by a cross-site POST (which needs no preflight) and not by a rebound DNS name.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startDevServer, stopDevServer } = require('./dev-server');

let child, port;

// node:http rather than fetch: the test sets Host and Origin, which fetch may not.
function request(method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) },
    (res) => { let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => resolve({ status: res.statusCode, body: out })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const putNote = (headers, title) =>
  request('POST', '/api/putRow', headers, { tableId: 'notes', data: { id: 'n1', title }, tab: 'active' });
const storedTitle = async () => {
  const r = await request('POST', '/api/getTableData', {}, { tableId: 'notes', tab: 'active' });
  const row = (JSON.parse(r.body).rows || []).find((x) => x.id === 'n1');
  return row && row.title;
};

describe('dev server — cross-site requests are refused', () => {
  before(async () => {
    const started = await startDevServer(':memory:');
    child = started.child;
    port = Number(new URL(started.base).port);
    const schema = { tables: { notes: { columns: { title: { type: 'text' } } } }, views: [] };
    assert.equal((await request('POST', '/api/saveSchema', {}, { schema })).status, 200);
  });
  after(() => stopDevServer(child));

  it('a POST from another site is refused and writes nothing', async () => {
    const r = await putNote({ Origin: 'https://evil.example' }, 'from evil');
    assert.equal(r.status, 403);
    assert.notEqual(await storedTitle(), 'from evil');
  });

  it('an opaque origin (sandboxed frame, file://) is refused', async () => {
    assert.equal((await putNote({ Origin: 'null' }, 'from null')).status, 403);
  });

  it('a rebound DNS name is refused, for the API and for files', async () => {
    assert.equal((await putNote({ Host: 'evil.example:' + port }, 'rebound')).status, 403);
    assert.equal((await request('GET', '/', { Host: 'evil.example:' + port })).status, 403);
    assert.notEqual(await storedTitle(), 'rebound');
  });

  it('the app itself, curl and the tests still get through', async () => {
    assert.equal((await putNote({ Origin: 'http://127.0.0.1:' + port }, 'same origin')).status, 200);
    assert.equal(await storedTitle(), 'same origin');
    assert.equal((await putNote({ Origin: 'http://localhost:5173' }, 'loopback origin')).status, 200);
    assert.equal((await putNote({ Host: 'localhost:' + port }, 'no origin')).status, 200);
    assert.equal((await putNote({ Host: '[::1]:' + port }, 'ipv6 loopback')).status, 200);
    assert.equal(await storedTitle(), 'ipv6 loopback');
  });
});
