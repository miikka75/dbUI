// save-config-allowlist.test.js — the write end and the read end of a config file must agree.
//
// `saveConfig` is how the setup screen offers "save it server-side so other users don't have to paste
// this too". It writes into STATIC_DIR, which is served, so the filename is checked against an
// allowlist — correctly.
//
// The allowlist named `firebase-config.json` and `config.json`. `saveSupabaseConfig` posts
// `supabase-config.json`, so that offer had always 403'd on the Supabase path, silently: the client
// fires the request with `.catch(function(){})` because on static hosting there is no /api at all and
// a failure there is expected. Meanwhile `backend-supabase.js` fetches `/supabase-config.json` at boot
// to find the project — so the one file the Supabase boot depends on was the one the server refused to
// write.
//
// Nothing could have noticed, because the two ends live in different files and neither names the other.
// This is what names them: every filename the app POSTS must be writable, and every filename the server
// ALLOWS must be one something actually asks for, so the list cannot grow dead entries either.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

// The server's list, read from source: dev/server.js starts listening on require, so a test cannot
// import it. Matching the declaration is what keeps this honest — a renamed const fails loudly here
// rather than quietly asserting nothing.
function allowlist() {
  const m = read('dev/server.js').match(/const CONFIG_FILES = \[([^\]]*)\]/);
  assert.ok(m, 'CONFIG_FILES is not declared in dev/server.js — did it move or get renamed?');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// Every filename app-core hands to /api/saveConfig.
function posted() {
  const src = read('app-core.js');
  const calls = src.match(/\/api\/saveConfig[\s\S]{0,300}?filename\s*:\s*'([^']+)'/g) || [];
  const names = calls.map((c) => c.match(/filename\s*:\s*'([^']+)'/)[1]);
  assert.ok(names.length >= 2, 'expected app-core to post at least the Firebase and Supabase configs');
  return [...new Set(names)];
}

describe('saveConfig — the allowlist covers what the app posts', () => {
  it('every filename app-core posts is writable', () => {
    const allowed = allowlist();
    for (const name of posted()) {
      assert.ok(allowed.includes(name),
        'app-core posts "' + name + '" to /api/saveConfig but dev/server.js refuses it with 403 — ' +
        'the client swallows that failure, so the offer just silently does nothing');
    }
  });

  it('carries supabase-config.json, which the Supabase boot reads back', () => {
    // Named explicitly, not just covered by the loop above: this is the file the regression was about,
    // and the round trip (server writes it, backend-supabase fetches it) is the thing worth pinning.
    assert.ok(allowlist().includes('supabase-config.json'));
    assert.match(read('backend-supabase.js'), /\/supabase-config\.json/,
      'nothing fetches supabase-config.json any more — then it should leave the allowlist too');
  });

  it('allows nothing nobody asks for', () => {
    // The allowlist is a security boundary on a directory that gets served, so it should hold exactly
    // what is needed. `config.json` is the generic fallback saveConfig defaults to when no filename is
    // given, so it is expected here without a poster naming it.
    const extra = allowlist().filter((f) => f !== 'config.json' && !posted().includes(f));
    assert.deepEqual(extra, [], 'allowlisted but never posted: ' + extra.join(', '));
  });

  it('stays an explicit list of basenames, not a pattern', () => {
    // A pattern here would be the difference between "these three files" and "anything ending .json in
    // the hosting root", which is a write primitive aimed at a served directory.
    for (const f of allowlist()) {
      assert.equal(f, path.basename(f), f + ' is not a bare filename');
      assert.ok(/^[\w.-]+\.json$/.test(f), f + ' is not a plain .json basename');
    }
    assert.match(read('dev/server.js'), /case 'saveConfig':[\s\S]{0,200}path\.basename\(/,
      'saveConfig no longer normalizes with path.basename before the check');
  });
});
