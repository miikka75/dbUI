// computed-cycles.test.js — drift guard against a mutually-recursive pair of Vue computeds.
//
// THE BUG THIS EXISTS FOR. `useCardLayout` chose card-vs-table automatically from how many columns the
// screen has, and `visibleCols` dropped empty columns (hideEmpty) only in TABLE mode — so each computed
// read the other. Vue tolerates that re-entrance in isolation (it hands the inner read a stale value),
// which is exactly why it survived unnoticed: the template happens to touch useCardLayout first and cache
// it. But when something ELSE reads visibleCols while a grid is rendering — the two evaluated from two
// directions at once — they recurse until "Maximum call stack size exceeded" and every view on the screen
// dies. It was found by adding one `this.visibleCols` read to a `watch: { currentData }` handler.
//
// WHY THIS IS A SOURCE-TEXT TEST rather than a behavioural one. Reproducing the crash needs the app's own
// code to make the early read; once that read is gone the trigger is gone with it, so a runtime test would
// pass whether or not the cycle is present (verified — it does). The durable statement is therefore the
// structural invariant: the layout decision must not depend on the layout-dependent column list. Same
// approach as rules-parity.test.js and translation-keys.test.js, which also read the real sources.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appCore = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');

// Body of a computed/method declared as `name: function() { … }`, up to the closing brace at its own
// indentation. Good enough for this file's flat, consistently-indented computed block.
function body(name) {
  const start = appCore.indexOf('\n      ' + name + ': function(');
  assert.ok(start >= 0, name + ' not found in app-core.js — did it move or get renamed?');
  const end = appCore.indexOf('\n      },', start);
  assert.ok(end > start, 'could not find the end of ' + name);
  return appCore.slice(start, end);
}

describe('computed cycles — the card/table layout decision', () => {
  it('useCardLayout does NOT read visibleCols', () => {
    assert.equal(
      /\bthis\.visibleCols\b/.test(body('useCardLayout')), false,
      'useCardLayout reads visibleCols, which reads useCardLayout back: that pair recursed until the ' +
      'stack blew whenever anything read visibleCols while a grid was rendering. Count columns with ' +
      '`this.declaredCols` (schema-declared, layout-independent) instead.'
    );
  });

  it('useCardLayout counts declaredCols (the layout-independent list)', () => {
    assert.ok(/\bthis\.declaredCols\b/.test(body('useCardLayout')),
      'the auto card/table threshold should size itself from declaredCols');
  });

  it('declaredCols reads neither visibleCols nor useCardLayout (it is the shared base)', () => {
    const b = body('declaredCols');
    assert.equal(/\bthis\.visibleCols\b/.test(b), false, 'declaredCols must not read visibleCols');
    assert.equal(/\bthis\.useCardLayout\b/.test(b), false, 'declaredCols must not read useCardLayout');
  });

  it('visibleCols still applies hideEmpty in table mode (the behaviour the split had to preserve)', () => {
    const b = body('visibleCols');
    assert.ok(/\bthis\.declaredCols\b/.test(b), 'visibleCols should start from declaredCols');
    assert.ok(/!this\.useCardLayout/.test(b), 'visibleCols should still gate hideEmpty on table mode');
  });

  // The watcher that originally exposed the cycle. It asks a SCHEMA question (which columns hold images),
  // so it belongs on declaredCols; pointing it back at visibleCols would re-arm the exact trigger.
  it('the row-asset watcher reads declaredCols, not visibleCols', () => {
    assert.equal(/\bthis\.visibleCols\b/.test(body('_refreshRowAssets')), false,
      '_refreshRowAssets should resolve image columns from declaredCols');
  });
});
