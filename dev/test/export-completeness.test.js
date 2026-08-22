// export-completeness.test.js — a backup may not invent an empty table.
//
// Asserted against the SOURCE, like the write-funnel and migration guards, because the wrong behaviour
// here is not a crash and not a failing assertion anywhere else: it is a downloaded file that looks
// complete and is not. Nobody discovers that until they try to restore from it.
//
// The original read `self.dataCache[table] || []`, which was safe only by accident — boot happens to
// load every granted table. It stopped being safe the moment a read failed, because both the boot path
// and _ensureCached cache [] on failure (fail-closed, right for a grid, catastrophic for a backup).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');
const fn = src.slice(src.indexOf('exportData: function'), src.indexOf('importData: function'));

describe('exportData — completeness', () => {
  it('exists and was found in the source', () => {
    assert.ok(fn.length > 200, 'exportData not found — this suite would pass vacuously');
  });

  it('never substitutes an empty array for a table it does not hold', () => {
    assert.ok(!/data\[table\]\s*=\s*self\.dataCache\[table\]\s*\|\|\s*\[\]/.test(fn),
      'the `|| []` fallback is back: a failed read would be exported as an empty table');
  });

  it('fetches what the cache is missing', () => {
    assert.match(fn, /backend\.getTableData\(/, 'a table not in the cache must be read, not assumed empty');
  });

  it('records failures instead of swallowing them', () => {
    assert.match(fn, /failed\.push\(/, 'a rejected read must be recorded');
  });

  it('produces no file at all when a read failed', () => {
    // The important half. Downloading a partial backup is worse than downloading nothing, because the
    // partial one is the one that gets trusted and kept.
    assert.match(fn, /if \(failed\.length\)/, 'nothing checks whether a read failed');
    // The return must be INSIDE the guard's own block. Checking only that some `return` precedes
    // the download is no check at all -- the very next statement is `return Promise.all([...])`,
    // so a guard that merely notified and fell through would satisfy it. Verified by mutation.
    const open = fn.indexOf('if (failed.length)');
    const bare = fn.indexOf('return;', open);          // the guard's own early return
    const next = fn.indexOf('return Promise', open);   // the statement it must come before
    assert.ok(bare > 0 && next > 0 && bare < next,
      'the failure guard must return, not merely notify and fall through to the download');
  });

  it('omits unreadable tables rather than asserting they are empty', () => {
    assert.match(fn, /canReachTable\(table\)/,
      'a table this user cannot read must be left out of the bundle, not written as []');
  });

  it('still covers the archive partition of archivable tables', () => {
    assert.match(fn, /archivable/, 'archived rows are part of the backup');
  });

  it('the message key it reports with is registered for translation', () => {
    // t() falls back to the raw key, so an unregistered key ships as `msg.export_incomplete` on screen.
    // translation-keys.test.js enforces this generally; named here because THIS is the string a user
    // sees at the exact moment their backup did not happen.
    assert.match(fn, /msg\.export_incomplete/);
    assert.match(src, /'msg\.export_incomplete'/, 'not listed in staticTranslationKeys()');
  });
});
