// brand.test.js — the colour logic behind Settings → Theme.
//
// Extracted from app-core.js because it is the only real algorithm in the theme editor and it had no
// unit test at all. One E2E case covered it (app.spec.js: five colours, light mode), which is a good
// integration proof and a thin one: it left dark mode's inversion, the small palettes, and every
// _normHex input shape resting on nothing.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Brand = require('../../brand');

// Named so the role assertions read as intent rather than as hex soup.
const WHITE = '#ffffff';
const NEARWHITE = '#fefae0';
const CREAM = '#faedcd';
const SAGE = '#ccd5ae';
const TAN = '#d4a373';
const BLACK = '#000000';

describe('normHex', () => {
  it('accepts the shapes a person actually types', () => {
    assert.equal(Brand.normHex('#A1B2C3'), '#a1b2c3');
    assert.equal(Brand.normHex('a1b2c3'), '#a1b2c3', 'a missing # is still a colour');
    assert.equal(Brand.normHex('  #A1B2C3  '), '#a1b2c3', 'pasted values carry whitespace');
    assert.equal(Brand.normHex('#abc'), '#aabbcc', 'three-digit shorthand expands');
    assert.equal(Brand.normHex('ABC'), '#aabbcc');
  });

  it('returns null for anything that is not a colour, rather than a broken value', () => {
    // commitTheme refuses on null and notifies. Returning a half-parsed string instead would store a
    // value that renders as nothing and looks like a rendering bug.
    for (const bad of ['', '   ', null, undefined, '#ab', '#abcd', '#abcdefa', 'rebeccapurple',
      '#ggghhh', 'rgb(1,2,3)', '#abc def']) {
      assert.equal(Brand.normHex(bad), null, JSON.stringify(bad) + ' is not a hex colour');
    }
  });

  // Digits are hex digits: '123' is shorthand exactly as 'abc' is, so it expands rather than being
  // rejected. Worth pinning because it looks like a bug on first reading and is not — and because the
  // version this replaced would THROW on a non-string (it called .trim() on whatever it was handed),
  // where this coerces. No caller passes a number today; it simply must not crash the theme editor if
  // one ever does.
  it('treats an all-digit value as hex shorthand, and does not throw on a non-string', () => {
    assert.equal(Brand.normHex('123'), '#112233');
    assert.equal(Brand.normHex(123), '#112233');
    assert.equal(Brand.normHex({}), null);
    assert.equal(Brand.normHex([]), null);
  });
});

describe('parsePalette', () => {
  it('extracts hexes from a coolors array literal, in order', () => {
    assert.deepEqual(Brand.parsePalette('["#ccd5ae","#e9edc9","#fefae0"]'), ['#ccd5ae', '#e9edc9', '#fefae0']);
  });

  it('does not care what the surrounding syntax is', () => {
    // Nothing here parses JSON or CSS — it scans for colours, so a CSS block or a bare list works.
    assert.deepEqual(Brand.parsePalette('--a: #FFF; --b:#001122;'), ['#ffffff', '#001122']);
    assert.deepEqual(Brand.parsePalette('#111111 #eeeeee #888888'), ['#111111', '#eeeeee', '#888888']);
  });

  it('normalises shorthand and case, and keeps duplicates', () => {
    // Duplicates are kept deliberately: they are what the user pasted, and rolesFor decides what a
    // repeated colour means rather than this deciding for it.
    assert.deepEqual(Brand.parsePalette('#ABC #aabbcc'), ['#aabbcc', '#aabbcc']);
  });

  it('is empty for text with no colours in it', () => {
    for (const s of ['', null, undefined, 'no colours here', '#12']) {
      assert.deepEqual(Brand.parsePalette(s), []);
    }
  });

  // Pinned because the first draft of brand.js "tightened" this with a word boundary, which read like
  // a correctness fix and was a regression: an 8-digit CSS colour stopped contributing anything, and a
  // dropped entry can push a palette under the two-colour minimum and make the whole paste fail with
  // no visible reason. Taking the RGB half of #rrggbbaa is the useful answer, so it is the tested one.
  it('takes the RGB half of an 8-digit CSS colour rather than skipping it', () => {
    assert.deepEqual(Brand.parsePalette('#ff0000ff'), ['#ff0000']);
    assert.deepEqual(Brand.parsePalette('#1a2b3c4d #ffffff'), ['#1a2b3c', '#ffffff']);
    // Two usable colours out of two alpha-bearing ones is still a usable palette.
    assert.ok(Brand.rolesFor(Brand.parsePalette('#000000ff #ffffffff'), 'light'));
  });
});

describe('luminance / chroma — used only for ordering', () => {
  it('orders dark to light', () => {
    assert.ok(Brand.luminance(BLACK) < Brand.luminance(TAN));
    assert.ok(Brand.luminance(TAN) < Brand.luminance(WHITE));
  });

  it('rates grey as colourless and a pure hue as fully chromatic', () => {
    assert.equal(Brand.chroma('#808080'), 0);
    assert.equal(Brand.chroma(WHITE), 0);
    assert.equal(Brand.chroma(BLACK), 0);
    assert.equal(Brand.chroma('#ff0000'), 255);
  });

  it('weights green over red over blue (Rec.709), not equally', () => {
    // A flat average would make these three equal, and the role mapping would then order a palette by
    // something that does not match what the eye calls "lightest".
    assert.ok(Brand.luminance('#00ff00') > Brand.luminance('#ff0000'));
    assert.ok(Brand.luminance('#ff0000') > Brand.luminance('#0000ff'));
  });
});

describe('rolesFor', () => {
  // The exact palette app.spec.js pastes, so the unit and E2E answers are checked against each other.
  const COOLORS = [SAGE, '#e9edc9', NEARWHITE, CREAM, TAN];

  it('maps light mode by luminance and chroma', () => {
    assert.deepEqual(Brand.rolesFor(COOLORS, 'light'), {
      background: NEARWHITE,      // lightest
      surface: CREAM,             // 2nd lightest
      'on-surface': TAN,          // darkest -> text
      primary: TAN,               // most chromatic
      secondary: CREAM,           // next most chromatic
    });
  });

  // The half no test covered. Dark mode is not a different algorithm, it is the same ordering with
  // background and text swapped -- so a regression here would invert every dark deployment's text
  // against its background and be invisible to a light-mode test.
  it('inverts background and text for dark mode, keeping the accents', () => {
    const light = Brand.rolesFor(COOLORS, 'light');
    const dark = Brand.rolesFor(COOLORS, 'dark');
    assert.equal(dark.background, light['on-surface'], 'dark background is the light text colour');
    assert.equal(dark['on-surface'], light.background, 'dark text is the light background');
    assert.equal(dark.primary, light.primary, 'accents do not flip');
    assert.equal(dark.secondary, light.secondary);
  });

  it('treats any mode but "dark" as light', () => {
    assert.deepEqual(Brand.rolesFor(COOLORS, 'light'), Brand.rolesFor(COOLORS, undefined));
  });

  // Small palettes are a legitimate paste, and the roles overlap rather than the call failing. What
  // must NOT happen is an undefined role: the index clamps exist for exactly this, and without them a
  // two-colour paste runs off the end of the sorted array and stores `undefined` as a colour.
  it('fills every role from only two colours, overlapping them', () => {
    const r = Brand.rolesFor([BLACK, WHITE], 'light');
    for (const role of ['background', 'surface', 'on-surface', 'primary', 'secondary']) {
      assert.ok(r[role], role + ' is defined');
      assert.match(r[role], /^#[0-9a-f]{6}$/, role + ' is a real colour, not undefined');
    }
    assert.equal(r.background, WHITE);
    assert.equal(r['on-surface'], BLACK);
  });

  it('fills every role from three', () => {
    const r = Brand.rolesFor([BLACK, TAN, WHITE], 'light');
    assert.equal(r.background, WHITE);
    assert.equal(r.surface, TAN);
    assert.equal(r['on-surface'], BLACK);
    assert.equal(r.primary, TAN, 'the only chromatic colour of the three');
  });

  it('refuses below two colours rather than inventing four roles', () => {
    assert.equal(Brand.rolesFor([WHITE], 'light'), null);
    assert.equal(Brand.rolesFor([], 'light'), null);
    assert.equal(Brand.rolesFor(null, 'light'), null);
  });

  it('drops unparseable entries before counting, so junk cannot pad a palette to two', () => {
    assert.equal(Brand.rolesFor([WHITE, 'nonsense'], 'light'), null);
    assert.ok(Brand.rolesFor([WHITE, 'nonsense', BLACK], 'light'));
  });

  it('normalises what it is given, so shorthand and bare hexes map the same', () => {
    assert.deepEqual(Brand.rolesFor(['#000', 'FFFFFF'], 'light'), Brand.rolesFor([BLACK, WHITE], 'light'));
  });

  it('always answers with a real colour for every role, for any palette size', () => {
    // A property rather than a case: whatever the size, no role may come back undefined.
    const pool = [BLACK, TAN, CREAM, SAGE, NEARWHITE, WHITE, '#ff0000', '#0000ff'];
    for (let n = 2; n <= pool.length; n++) {
      for (const mode of ['light', 'dark']) {
        const r = Brand.rolesFor(pool.slice(0, n), mode);
        for (const role of ['background', 'surface', 'on-surface', 'primary', 'secondary']) {
          assert.match(r[role], /^#[0-9a-f]{6}$/, 'n=' + n + ' ' + mode + ' ' + role);
        }
      }
    }
  });

  it('does not mutate the array it is given', () => {
    const input = [WHITE, BLACK, TAN];
    const copy = input.slice();
    Brand.rolesFor(input, 'light');
    assert.deepEqual(input, copy, 'sorting must happen on a copy: the caller still holds this array');
  });
});
