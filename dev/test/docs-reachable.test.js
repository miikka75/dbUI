// docs-reachable.test.js — a document nobody links to is a document nobody reads.
//
// `SUPABASE.md` was current, complete, and referenced from nowhere: the README never mentioned
// Supabase in its backends table either, so the only way to find the guide was to already know it
// existed. Nothing fails when that happens — the file is still right, it is just invisible — which is
// why it survived a whole backend's worth of work.
//
// Two checks, in both directions: every user-facing document is reachable from the README, and every
// relative link the README makes actually resolves. The second is the ordinary rot guard; the first is
// the one that would have caught SUPABASE.md.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// The documents a person is expected to find. Named rather than globbed: `CODE_REVIEW-*.md` is a
// worklist for whoever is working on the code, not a guide, and linking it from the README would be
// telling users to read our to-do list.
const USER_DOCS = ['SUPABASE.md', 'dev/SCHEMA.md', 'examples/README.md'];

describe('docs are reachable from the README', () => {
  for (const doc of USER_DOCS) {
    it('README links ' + doc, () => {
      assert.ok(fs.existsSync(path.join(ROOT, doc)), doc + ' does not exist');
      assert.ok(README.includes('(' + doc + ')'),
        doc + ' is not linked from README.md — it is complete and invisible, which is how SUPABASE.md ' +
        'went a whole backend without a reader');
    });
  }

  it('every relative link in the README resolves', () => {
    // Skips anchors and absolute URLs; what is left is a path into this repo.
    const links = [...README.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1])
      .filter((l) => !/^([a-z]+:)?\/\//i.test(l) && !l.startsWith('#') && !l.startsWith('mailto:'));
    // A sanity floor on the MATCHER, not on the docs: if this ever reads zero the regex broke and the
    // check below would pass vacuously. Deliberately not tied to the current count — that would fail
    // whenever someone legitimately removes a link, which is not what this is watching for.
    assert.ok(links.length > 0, 'no relative links found in README.md — the matcher is broken');
    const missing = links
      .map((l) => l.split('#')[0])
      .filter((l) => l && !fs.existsSync(path.join(ROOT, l)));
    assert.deepEqual([...new Set(missing)], [], 'README links to files that are not there');
  });
});

describe('.firebaserc stays out of the repo', () => {
  it('is ignored, so `firebase use --add` cannot be committed by accident', () => {
    // It names ONE developer's project. Committed, every fork's `firebase deploy` would aim at
    // whoever wrote it — and the README now tells people to create one, so it will exist locally.
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    assert.ok(gi.split(/\r?\n/).some((l) => l.trim() === '.firebaserc'), '.gitignore does not ignore .firebaserc');
  });

  it('is not actually committed', () => {
    // Present on disk is fine — every developer will have one, and the README now tells them to make
    // it. Present in git is not. `git ls-files` is the only thing that can tell those apart; its
    // absence (no git, a tarball) means there is nothing to check, not a failure.
    const { spawnSync } = require('node:child_process');
    const git = spawnSync('git', ['ls-files', '--error-unmatch', '.firebaserc'], { cwd: ROOT });
    if (git.error) return;
    assert.notEqual(git.status, 0, '.firebaserc is tracked — it names one developer’s project');
  });
});
