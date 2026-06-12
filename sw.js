// sw.js — minimal service worker.
// Exists only to satisfy PWA installability so the install prompt fires.
// Pass-through fetch (no caching): the app still requires network.
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) { e.respondWith(fetch(e.request)); });
