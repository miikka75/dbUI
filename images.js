// images.js — Pure decisions for turning a picked image into a data URL that fits where it is stored.
// Framework-agnostic + Node-tested, mirroring reorder.js / profiles.js.
//   Browser: <script src="/images.js">, then Images.fit(resize, cap, steps). Node: const Images = require('../images').
//
// Two callers store a picture as a data URL: the profile avatar (capped by the profile rules) and a
// stored asset such as a view background (ASSET_CAP). Both used to run their own fitting: the asset path
// stepped down a resolution/quality ladder, while the avatar resized once and gave up. They now share
// one ladder walk and differ only in the steps they pass in.
//
// WHAT IS NOT HERE: the canvas. Decoding and re-encoding need the DOM, so app-core's _resizeImageFile does
// them and is handed in as `resize`; this module decides which attempt to make next and when to stop.
(function(root) {
  // A view background: as large as the cap allows, trading resolution and then quality. 900px at q0.6 is
  // tens of KB for any real photo, so running off the end means a pathological source.
  var ASSET_STEPS = [{ max: 1600, q: 0.8 }, { max: 1600, q: 0.65 }, { max: 1200, q: 0.65 }, { max: 900, q: 0.6 }];
  // An avatar: small and square-ish. One step, which is the size it has always been drawn at.
  var AVATAR_STEPS = [{ max: 256, q: 0.85 }];

  // Try each step in order until the result fits `cap`. `resize(max, q)` resolves to a data URL. Rejects
  // with a TooLarge error once every step has overflowed; the caller words it.
  function fit(resize, cap, steps) {
    var attempt = function(i) {
      if (i >= steps.length) { var e = new Error('too large'); e.tooLarge = true; return Promise.reject(e); }
      return Promise.resolve(resize(steps[i].max, steps[i].q)).then(function(url) {
        return String(url).length <= cap ? url : attempt(i + 1);
      });
    };
    return attempt(0);
  }

  // Does any pixel carry transparency? `data` is RGBA (ImageData.data). Stops at the first non-opaque
  // pixel, so an opaque photo is the only case that scans in full.
  function hasAlpha(data) {
    for (var i = 3; i < data.length; i += 4) { if (data[i] < 255) return true; }
    return false;
  }

  // The encoder FOLLOWS THE SOURCE. JPEG has no alpha, and a canvas starts transparent BLACK, so a
  // transparent PNG re-encoded as JPEG turned every clear pixel black -- a logo watermark became a black
  // slab. WebP keeps alpha (a browser that cannot encode it returns PNG, which keeps it too).
  function encoderFor(alpha) { return alpha ? 'image/webp' : 'image/jpeg'; }

  var M = { ASSET_STEPS: ASSET_STEPS, AVATAR_STEPS: AVATAR_STEPS, fit: fit, hasAlpha: hasAlpha, encoderFor: encoderFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Images = M;
})(typeof self !== 'undefined' ? self : this);
