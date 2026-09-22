// brand.js — Pure colour logic for the admin brand-palette editor (Settings → Theme).
// Framework-agnostic + Node-tested, mirroring board.js / pivot.js / rsvp.js.
//   Browser: <script src="/brand.js">, then Brand.rolesFor(...). Node: const Brand = require('../brand').
//
// WHAT IS HERE AND WHAT IS NOT: this module decides what a colour IS — parse it, measure it, and map a
// pasted palette onto theme roles. It knows nothing about Vuetify, the schema, the DOM or saving. The
// root keeps everything effectful: setThemeColor (which live-previews through a dynamic <style>),
// _persistTheme (frozen-replace + saveSchema) and the notify calls.
//
// WHY IT WAS EXTRACTED: the role mapping is the only real algorithm in the theme editor and it had no
// unit test at all. One E2E case covered it — five colours, light mode — which left dark mode's
// inversion, the two- and three-colour palettes, and every _normHex input shape resting on nothing. It
// is also pure, which makes it the cheapest seam in app-core.js to cut, and a smaller one than the
// feed publishing the roadmap had guessed would go first (that turned out to be orchestration: it
// leans on backend uploads, row patches and view data, so it needs a ctx bag rather than a pure move).
(function(root) {

  // '#abc' / 'ABCDEF' / ' #a1b2c3 ' -> '#a1b2c3'. Null for anything else, which is how the caller
  // tells an unusable paste from a colour: commitTheme refuses rather than storing a broken value.
  function normHex(v) {
    var m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h.toLowerCase();
  }

  // Pull every #hex out of arbitrary text, in order. The input is whatever the user pasted — a coolors
  // export is a JSON array literal, but a CSS block or a bare space-separated list works the same,
  // because nothing here parses the surrounding syntax.
  //
  // The match is deliberately UNANCHORED at its end: an 8-digit CSS colour (#rrggbbaa) contributes its
  // RGB half rather than being skipped, which is what the caller wants -- a dropped entry can push a
  // palette below the two-colour minimum and make the whole paste fail silently. An earlier draft of
  // this module put a word boundary here, which read like a tightening and was really a regression.
  function parsePalette(str) {
    var out = [], re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/g, m;
    while ((m = re.exec(str || ''))) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      out.push('#' + h.toLowerCase());
    }
    return out;
  }

  function rgb(hex) {
    var h = String(hex).replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  // Rec.709 luma, unnormalised (0..255). Relative ORDER is all this is used for, so the weights matter
  // and the scale does not.
  function luminance(hex) { var c = rgb(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

  // Saturation, the cheap way: max channel minus min. Grey is 0, a pure hue is 255. Used only to rank
  // "which of these is the most colourful", where the cheap measure and a real one agree.
  function chroma(hex) { var c = rgb(hex); return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }

  // Map a pasted palette onto theme roles.
  //
  //   lightest      -> background      (inverted in dark mode: darkest)
  //   2nd lightest  -> surface         (inverted: 2nd darkest)
  //   darkest       -> on-surface      (the text colour; inverted: lightest)
  //   most chromatic-> primary
  //   2nd most      -> secondary
  //
  // Returns null below two colours: one colour cannot fill five roles without inventing four, and a
  // silent guess is worse than refusing.
  //
  // The roles deliberately OVERLAP for small palettes rather than failing. With three colours the
  // darkest is both `on-surface` and (usually) `primary`, and the index clamps below keep `surface`
  // and `secondary` on a real entry instead of running off the end of the array. A three-colour paste
  // is a legitimate thing to do and it produces a usable, if flat, theme.
  function rolesFor(hexes, mode) {
    var list = (hexes || []).map(normHex).filter(Boolean);
    if (list.length < 2) return null;

    var arr = list.map(function(h) { return { h: h, l: luminance(h), c: chroma(h) }; });
    var byL = arr.slice().sort(function(a, b) { return a.l - b.l; });   // dark -> light
    var byC = arr.slice().sort(function(a, b) { return b.c - a.c; });   // vivid -> dull
    var n = byL.length;

    var lightest = byL[n - 1].h;
    var darkest = byL[0].h;
    var secondL = byL[n - 2 >= 0 ? n - 2 : n - 1].h;
    var secondD = byL[1 < n ? 1 : 0].h;
    var primary = byC[0].h;
    var secondary = byC[1 < byC.length ? 1 : 0].h;

    return (mode === 'dark')
      ? { background: darkest, surface: secondD, 'on-surface': lightest, primary: primary, secondary: secondary }
      : { background: lightest, surface: secondL, 'on-surface': darkest, primary: primary, secondary: secondary };
  }

  var M = { normHex: normHex, parsePalette: parsePalette, rgb: rgb, luminance: luminance, chroma: chroma, rolesFor: rolesFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Brand = M;
})(typeof self !== 'undefined' ? self : this);
