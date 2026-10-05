// images.js — Pure decisions for turning a picked image into a data URL that fits where it is stored.
// Framework-agnostic + Node-tested, mirroring reorder.js / profiles.js.
//   Browser: <script src="/images.js">, then Images.fit(resize, cap, steps). Node: const Images = require('../images').
//
// Three callers fit a picture: the profile avatar (capped by the profile rules), a stored asset such as a
// view background or an image cell without a blob store (ASSET_CAP), and an image cell's upload to a blob
// store (UPLOAD_CAP). They share one ladder walk and differ only in the steps and cap they pass in.
//
// WHAT IS NOT HERE: the canvas. Decoding and re-encoding need the DOM, so app-core's _resizeImageFile does
// them and is handed in as `resize`; this module decides which attempt to make next and when to stop.
(function(root) {
  // A view background: as large as the cap allows, trading resolution and then quality. 900px at q0.6 is
  // tens of KB for any real photo, so running off the end means a pathological source.
  var ASSET_STEPS = [{ max: 1600, q: 0.8 }, { max: 1600, q: 0.65 }, { max: 1200, q: 0.65 }, { max: 900, q: 0.6 }];
  // An avatar: small and square-ish. One step, which is the size it has always been drawn at.
  var AVATAR_STEPS = [{ max: 256, q: 0.85 }];
  // A picture going to a blob store: room for a large screen's lightbox, stepping down to fit the upload cap.
  var STORE_STEPS = [{ max: 2560, q: 0.85 }, { max: 2560, q: 0.75 }, { max: 2048, q: 0.75 }, { max: 1600, q: 0.7 }];
  // A picture's thumbnail: what a gallery tile or a cell draws. 480px covers a large tile on a dense screen.
  var THUMB_STEPS = [{ max: 480, q: 0.75 }, { max: 360, q: 0.7 }];

  // An image cell's value is the picture's reference -- a URL or `asset:<id>` -- optionally followed by
  // its thumbnail's: `<full>#thumb=<thumb, URI-encoded>`. A fragment, so an <img> or a link given the whole
  // value still loads the full picture (fragments never reach the server). Everything that READS an image
  // value splits it here; a value with no thumbnail is just its full reference, as before.
  var THUMB_MARK = '#thumb=';
  function joinRef(full, thumb) { return thumb ? String(full) + THUMB_MARK + encodeURIComponent(thumb) : String(full || ''); }
  function splitRef(v) {
    var s = String(v || ''), i = s.indexOf(THUMB_MARK);
    if (i < 0) return { full: s, thumb: '' };
    var t = '';
    try { t = decodeURIComponent(s.slice(i + THUMB_MARK.length)); } catch (e) { t = ''; }
    return { full: s.slice(0, i), thumb: t };
  }

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

  // A data URL as the bytes and type it holds, for an upload: a blob store wants a file, not text. Decoded
  // by hand because the CSP's connect-src has no data:, so fetch(dataUrl) is refused.
  function dataUrlBytes(url) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(String(url || ''));
    if (!m || !m[2]) return null;
    var bin = atob(m[3]), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { type: m[1], bytes: bytes };
  }

  // A byte cap as the data-URL length that holds it: base64 spends four characters per three bytes.
  function capChars(bytes) { return Math.floor(bytes * 4 / 3); }

  // The encoder FOLLOWS THE SOURCE. JPEG has no alpha, and a canvas starts transparent BLACK, so a
  // transparent PNG re-encoded as JPEG turned every clear pixel black -- a logo watermark became a black
  // slab. WebP keeps alpha (a browser that cannot encode it returns PNG, which keeps it too).
  function encoderFor(alpha) { return alpha ? 'image/webp' : 'image/jpeg'; }

  var M = { ASSET_STEPS: ASSET_STEPS, AVATAR_STEPS: AVATAR_STEPS, STORE_STEPS: STORE_STEPS, THUMB_STEPS: THUMB_STEPS,
            fit: fit, hasAlpha: hasAlpha, encoderFor: encoderFor, dataUrlBytes: dataUrlBytes, capChars: capChars,
            joinRef: joinRef, splitRef: splitRef };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Images = M;
})(typeof self !== 'undefined' ? self : this);
