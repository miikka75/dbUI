// app-core-fn.js — lift a member out of the SHIPPED app-core.js and run it.
//
// Not a test file (the runner globs *.test.js): a helper two suites share. It started inside
// access.test.js, and moved here the moment a second suite needed the same trick — a second copy of
// the lifting rules is exactly the mirrored re-implementation the comments below warn about.
//
// `deps` are the free bindings the lifted body needs. app-core members read file-scope globals
// (SCHEMA, aKey, Writes, VIEWS, ...) that do not exist in a test, so pass whatever the member you are
// lifting actually touches; AccessFeatures, Rows and Undo are supplied by default because most do.
// Undo is the real module rather than a stub: it is pure, and a lift that RECORDS an op should be
// recording through the same code the app does. Nothing here replays, so no write funnel is needed.
const assert = require('node:assert');

// Lifts a member out of app-core.js and runs it, so these assertions bind to the SHIPPED code rather
// than a copy of it — a mirrored re-implementation is what let the `|| []` drift through last time.
// Members sit at a fixed 6-space indent as `name: function(<args>) { ... },`, and the search is
// ANCHORED to the line start — a bare substring match also hits a deeper-indented line that merely
// mentions the name, and the root is full of those: a ctx bag hands a pure module its own
// `canReachTable: function(tbl) { ... }` at 10 spaces, which contains the 6-space form inside it. That
// match lands earlier in the file than the real member, so the slice runs off into unrelated code and
// surfaces as a bare SyntaxError rather than as anything pointing here.
function appCoreFn(name, deps) {
  deps = Object.assign({ AccessFeatures: require('../../access-features'), Rows: require('../../rows'), Undo: require('../../undo') }, deps || {});
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');
  const head = '\n      ' + name + ': function(';
  const start = src.indexOf(head);
  assert.ok(start >= 0, 'could not find ' + name + ' at the root member indent in app-core.js');
  const argsEnd = src.indexOf(')', start);
  const open = src.indexOf('{', argsEnd);

  // The END is derived TWICE, and the two must agree.
  //
  // By indent: the first line that is exactly `      },`. Cheap, and it matches the file's real style
  // — but a body containing a nested object literal that happens to close at six spaces would end the
  // slice early, and the result of THAT is the bad kind: a syntactically valid but truncated function
  // that still runs and quietly answers a security question wrong.
  //
  // By braces: depth-count from the opening brace. Independent of layout, but deliberately naive — it
  // does not know about strings, comments or regex literals, so a brace inside one would throw it off.
  //
  // Neither is trustworthy alone; together they are, because the ways they fail have nothing to do
  // with each other. When they disagree, that is the signal to come and look, so it fails loudly here
  // instead of lifting the wrong code.
  const byIndent = src.indexOf('\n      },', start);
  let depth = 0, byBraces = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { byBraces = i; break; } }
  }
  assert.ok(byBraces > open, 'could not find the end of ' + name + ' by brace matching');

  // SINGLE-LINE members (`name: function(x) { return y; },`) have no `      },` line to find at all, so
  // the indent derivation cannot speak for them: it silently returns the NEXT multi-line member's
  // closing line, thousands of characters away, and the cross-check below then fails on a member that
  // is perfectly well-formed. The root is full of one-liners — every `is<Kind>Name` classifier is one —
  // and before this branch existed none of them could be lifted, which is a large part of why the
  // classifiers had no tests.
  //
  // They get their own check instead of an exemption. A one-liner's body cannot contain a newline, and
  // the member must close with `},` exactly as the multi-line form does — so if brace matching ran past
  // the end of the line, or landed anywhere but a real member close, this fails just as loudly.
  const singleLine = src.slice(open, byBraces).indexOf('\n') === -1;
  if (singleLine) {
    assert.match(src.slice(byBraces, byBraces + 2), /^\},/,
      'brace matching for the single-line member ' + name + ' did not land on a `},` — a brace inside a ' +
      'string or comment in the body would do that, and the lift would be silently truncated.');
  } else {
    // Multi-line: the two independent derivations must agree. Neither is trustworthy alone; together
    // they are, because the ways they fail have nothing to do with each other.
    assert.ok(byIndent > start, 'could not find the end of ' + name + ' by indent');
    assert.equal(byIndent + 1, byBraces - 6,
      'the two ways of finding the end of ' + name + ' disagree — brace matching says the member closes ' +
      'somewhere other than the first `      },` line. Either a nested object literal closes at the root ' +
      'member indent, or a brace appears inside a string/comment/regex in the body. Read the slice before ' +
      'trusting this test again: a truncated lift still RUNS, and these assertions are the access model.');
  }

  // The trailing newline matters: a body whose last line ends in a // comment would otherwise swallow
  // the closing brace.
  const bodyEnd = singleLine ? byBraces : byIndent;
  const names = Object.keys(deps);
  return new Function(...names,
    'return function(' + src.slice(start + head.length, argsEnd) + ') {' + src.slice(open + 1, bodyEnd) + '\n};'
  )(...names.map((n) => deps[n]));
}
function runAppCore(name, ctx, ...args) { return appCoreFn(name).apply(ctx, args); }

module.exports = { appCoreFn, runAppCore };
