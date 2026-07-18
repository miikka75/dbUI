// csp-report.test.js — The CSP report collector: shape normalization (report-uri AND report-to
// bodies), aggregation, and a real HTTP round-trip (browser-style POST -> token-gated GET summary).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { normalize, aggregate } = require('../csp-report-collector');

describe('csp report collector — pure transforms', () => {
  it('normalizes the classic report-uri body', () => {
    const rows = normalize(JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'http://evil.example/x.png', 'document-uri': 'https://app/' } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].directive, 'img-src');
    assert.equal(rows[0].blockedURI, 'http://evil.example/x.png');
  });

  it('normalizes the report-to array body', () => {
    const rows = normalize(JSON.stringify([{ body: { effectiveDirective: 'script-src-elem', blockedURL: 'inline', documentURL: 'https://app/' } }]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].directive, 'script-src-elem');
  });

  it('junk bodies normalize to nothing', () => {
    assert.deepEqual(normalize('not json'), []);
    assert.deepEqual(normalize('{}'), []);
  });

  it('aggregates by (directive, blockedURI), most frequent first', () => {
    const mk = (d, b, ts) => JSON.stringify({ ts, directive: d, blockedURI: b, document: 'https://app/' });
    const out = aggregate([mk('img-src', 'a', '2026-01-01'), mk('img-src', 'a', '2026-01-03'), mk('script-src', 'b', '2026-01-02'), 'garbage']);
    assert.equal(out.total, 3);
    assert.equal(out.violations[0].directive, 'img-src');
    assert.equal(out.violations[0].count, 2);
    assert.equal(out.violations[0].lastSeen, '2026-01-01' < '2026-01-03' ? '2026-01-03' : '2026-01-01');
  });
});

describe('csp report collector — HTTP round-trip', () => {
  const LOG = path.join(__dirname, '.test-csp-reports-' + process.pid + '.ndjson');
  const PORT = 3901;
  let child;
  after(() => { try { child.kill(); } catch (e) {} fs.rmSync(LOG, { force: true }); });

  function req(method, urlPath, body) {
    return new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath }, (res) => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      r.on('error', reject);
      if (body) r.write(body);
      r.end();
    });
  }

  it('accepts a browser POST, refuses an untokened GET, serves the tokened summary', async () => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'csp-report-collector.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), REPORT_TOKEN: 'testtoken', REPORT_LOG: LOG })
    });
    await new Promise((resolve, reject) => {
      child.stdout.on('data', () => resolve());
      child.on('exit', () => reject(new Error('collector exited')));
      setTimeout(() => reject(new Error('collector did not start')), 5000);
    });

    const post = await req('POST', '/csp-report', JSON.stringify({ 'csp-report': { 'violated-directive': 'connect-src', 'blocked-uri': 'https://elsewhere.example', 'document-uri': 'https://app/' } }));
    assert.equal(post.status, 204);

    assert.equal((await req('GET', '/csp-report')).status, 403);
    assert.equal((await req('GET', '/csp-report?token=wrong')).status, 403);

    const ok = await req('GET', '/csp-report?token=testtoken');
    assert.equal(ok.status, 200);
    const summary = JSON.parse(ok.body);
    assert.equal(summary.total, 1);
    assert.equal(summary.violations[0].directive, 'connect-src');
  });
});
