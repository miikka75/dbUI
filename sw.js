// sw.js — the published site's cache; in development it does nothing.
//
// scripts/build-site.js writes the two revisions and the boot shell into the copy it publishes. The app
// files live in a cache named by the app revision and vendor/ in one named by the vendor revision, so a
// deploy that changes neither re-downloads nothing, and one that changes the app keeps the 17 MB PGlite
// dist. Same-origin GETs are served cache-first and stored on first use; /api, /uploads and every other
// origin go to the network untouched.
var APP_REV = '__APP_REV__', VENDOR_REV = '__VENDOR_REV__', SHELL = '__SHELL__';
var LIVE = APP_REV.indexOf('__') !== 0;
var APP_CACHE = 'dbui-app-' + APP_REV, VENDOR_CACHE = 'dbui-vendor-' + VENDOR_REV;
var SCOPE = self.registration.scope;

self.addEventListener('install', function(e) {
  self.skipWaiting();
  // `no-cache` revalidates each file: an HTTP-cached copy from the previous deploy must not be stored
  // under the new revision.
  if (LIVE) e.waitUntil(Promise.all([APP_CACHE, VENDOR_CACHE].map(function(name) {
    var paths = SHELL.filter(function(p) { return (p.indexOf('vendor/') === 0) === (name === VENDOR_CACHE); });
    return caches.open(name).then(function(c) {
      return c.addAll(paths.map(function(p) { return new Request(new URL(p, SCOPE), { cache: 'no-cache' }); }));
    });
  })));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k.indexOf('dbui-') === 0 && k !== APP_CACHE && k !== VENDOR_CACHE; })
      .map(function(k) { return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  if (!LIVE || req.method !== 'GET' || req.url.indexOf(SCOPE) !== 0) return;
  var path = req.url.slice(SCOPE.length).split(/[?#]/)[0];
  if (/^(api|uploads)\//.test(path) || path === 'sw.js') return;
  // Keyed without the query: within one revision `mdi.css`'s `?v=` and the app's `?db=` name the same file.
  var navigate = req.mode === 'navigate';
  var key = SCOPE + (navigate ? 'index.html' : path);
  var name = path.indexOf('vendor/') === 0 ? VENDOR_CACHE : APP_CACHE;
  e.respondWith(caches.open(name).then(function(c) {
    return c.match(key).then(function(hit) {
      return hit || fetch(navigate ? key : req).then(function(res) {
        if (res.ok && res.type === 'basic') c.put(key, res.clone());
        return res;
      });
    });
  }));
});
