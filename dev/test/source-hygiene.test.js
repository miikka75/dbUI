// source-hygiene.test.js — every tracked source file stays READABLE to the tools that review it.
//
// This exists because of a specific silent failure, not as a style rule. `rows.js` built a memo key
// with literal NUL and SOH bytes rather than escapes. Behaviourally that is fine — they are just
// delimiters no column name can contain — but a single NUL makes `git` call the file binary, `file`
// report "data", and `grep` refuse to search it. The file quietly stopped appearing in scans, which is
// how it went unreviewed for as long as it did. `pivot.js` and the CSP report collector had picked up
// the same idiom.
//
// A file the tooling declines to read is a file that stops being reviewed, and nothing else in the
// suite would have noticed. So the invariant is pinned here: the bytes below never appear RAW in a
// tracked text source; write them as escapes (which is what the three sites do now).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// Extensions that are TEXT by contract. Binary assets (.png, .wasm, .pgdata, fonts) are excluded
// because control bytes are their content, not a defect.
const TEXT_EXT = new Set(['.js', '.mjs', '.json', '.md', '.html', '.css', '.svg', '.sql', '.sh',
  '.yml', '.yaml', '.rules', '.ts']);

// Tracked files only: the working tree also holds generated vendor dists and local .pgdata scratch,
// and neither is source anybody reviews.
function trackedTextFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => TEXT_EXT.has(path.extname(f).toLowerCase()))
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
}

// C0 controls except the three that legitimately occur in text: \t (9), \n (10), \r (13). Plus DEL.
// \f and \v are included in the ban — neither has a reason to be in this repo's sources, and both
// confuse the same tools.
const isBanned = (c) => c < 9 || (c > 13 && c < 32) || c === 127 || (c > 10 && c < 13);

describe('source hygiene — no raw control bytes in tracked text files', () => {
  const files = trackedTextFiles();

  it('finds files to check (guards against an empty glob passing vacuously)', () => {
    assert.ok(files.length > 50, 'expected the repo to have many tracked text files, got ' + files.length);
    for (const expected of ['rows.js', 'pivot.js', 'app-core.js', 'csp.js']) {
      assert.ok(files.includes(expected), 'the scan covers ' + expected);
    }
  });

  it('every tracked text file is free of raw control bytes', () => {
    const offenders = [];
    for (const f of files) {
      const buf = fs.readFileSync(path.join(ROOT, f));
      const hits = [];
      for (let i = 0; i < buf.length && hits.length < 3; i++) {
        if (isBanned(buf[i])) {
          // Report a LINE, not a byte offset: the point is to send the reader to the right place.
          const line = buf.slice(0, i).toString('utf8').split('\n').length;
          hits.push(f + ':' + line + ' (byte 0x' + buf[i].toString(16).padStart(2, '0') + ')');
        }
      }
      if (hits.length) offenders.push(hits.join(', '));
    }
    assert.deepEqual(offenders, [],
      'raw control byte(s) in a tracked text file. git treats such a file as BINARY: it stops being ' +
      'diffable, greppable and reviewable, which is exactly how the rows.js memo key went unexamined. ' +
      'Write the byte as an escape sequence instead:\n  ' + offenders.join('\n  '));
  });

  // The three sites that motivated this still need the delimiter, so assert the ESCAPED form is what
  // they carry — otherwise a well-meaning "simplification" back to a literal byte would pass the scan
  // above only by deleting the feature.
  it('the composite-key delimiters are still written as escapes', () => {
    const esc = String.fromCharCode(92) + 'u0000';
    for (const f of ['rows.js', 'pivot.js', 'dev/csp-report-collector.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      assert.ok(src.includes(esc), f + ' still builds its composite key with an escaped U+0000');
    }
  });
});
