// backend-local-pglite.js — the whole app, database included, inside one browser tab.
//
// PostgreSQL is compiled to WebAssembly (PGlite), the cluster is persisted in IndexedDB, and the real
// supabase-schema.sql — the same file a Supabase project runs — is applied to it on boot. So this is not
// a mock or a reduced local mode: every read and write below is gated by the production RLS policies,
// evaluated by an actual Postgres a few metres from the user's eyes. Nothing is installed, no account is
// created, and no request leaves the machine after the app's own assets are cached.
//
// It is the PLATFORM half only. The contract — which store a row lives in, what shape it has — is
// backend-kv.js, shared verbatim with backend-supabase.js. The two differ in exactly the things a
// platform is: identity, whether other clients exist, and where a file goes.
//
// WHAT THE IDENTITY MEANS HERE — read this before trusting the word "policy" above. On Supabase the
// caller's email comes from a signed Google token that the browser cannot forge. Here it comes from
// localStorage, typed in by the person sitting at the keyboard, who can change it to anyone's address
// at any time. The policies still run, and still answer exactly as production would — but they answer
// about a self-asserted identity, so this mode is a faithful REHEARSAL of the access model, never a
// boundary against the person using it. That is not a weakness to fix: the database is in their own
// browser, so there is nobody to keep out and nothing to keep from them. Deploy the same app against
// Supabase or Firebase the moment more than one person is involved.
//
// Loaded by index.html when app_mode is 'pglite'; requires backend-kv.js and storage-pglite.js before it.
function _u(p) { return (typeof window !== 'undefined' && window.appUrl) ? window.appUrl(p) : p; }

var PGLITE_DB_KEY = 'pglite_db';        // which IndexedDB cluster (lets one origin hold several)
var PGLITE_USER_KEY = 'pglite_user';    // the self-asserted identity, see the note above
var _pgStorage = null;                  // the storage adapter, once PGlite is up
var backend_users = null;               // built alongside `backend`, from backend-kv.js

function _pgDbName() { return localStorage.getItem(PGLITE_DB_KEY) || 'dbui'; }
function _pgEmail() { return (localStorage.getItem(PGLITE_USER_KEY) || 'you@local').toLowerCase(); }

// Two tabs, one IndexedDB cluster, two independent Postgres processes writing it: that corrupts the
// database rather than racing politely, and PGlite has no cross-tab coordination of its own (the
// upstream answer is a SharedWorker, which is a much larger change than this mode is worth). A Web Lock
// held for the lifetime of the tab makes the second tab say so instead of quietly destroying the first
// one's data. Browsers without the API (none current) simply proceed — the same exposure as before.
function _claimSingleTab(name) {
  if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
  return new Promise(function(resolve) {
    navigator.locks.request('dbui-pglite:' + name, { ifAvailable: true }, function(lock) {
      if (!lock) { resolve(false); return; }
      resolve(true);
      return new Promise(function() {});   // never settles: the lock is held until this tab goes away
    });
  }).catch(function() { return true; });
}

// The splash is a bare spinner, and the FIRST boot of this mode is not bare-spinner-shaped: it downloads
// ~17 MB of WebAssembly and then runs initdb plus the whole policy file, which is seconds of apparently
// nothing happening. Later boots reuse the IndexedDB cluster and are quick. Caption the spinner so the
// wait reads as progress instead of a hang; harmless if the splash is already gone.
function _pgSplashNote(text) {
  var splash = document.getElementById('app-splash');
  if (!splash) return;
  var el = document.getElementById('pglite-splash-note');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pglite-splash-note';
    el.style.cssText = 'position:absolute;left:0;right:0;bottom:32%;text-align:center;font:13px system-ui,sans-serif;opacity:.65;padding:0 24px';
    splash.appendChild(el);
  }
  el.textContent = text;
}

// The WASM engine, self-hosted first and from the CDN only if that is missing — the same shape
// index.html uses for Vue and Vuetify, and for the same reason: /vendor is GENERATED, not committed, so
// a fork that has not run ./update-vendor.sh would otherwise get a backend that cannot start at all.
//
// Self-hosted stays the primary, and not merely out of habit. This is the one mode that needs nothing
// external, so reaching a CDN is a degradation, not the design — and it is a degradation that cannot be
// SRI-pinned the way the Vue fallback is: the module fetches pglite.wasm and pglite.data by URL relative
// to ITSELF, so the bytes that matter most never pass through a hash we control. The version below is
// rewritten by update-vendor.sh from vendor/versions, and dev/test/deploy-config.test.js fails if the
// two drift.
function _importPglite() {
  return import(_u('/vendor/pglite/index.js')).catch(function (e) {
    console.warn('[pglite] /vendor/pglite missing, falling back to the CDN:', (e && e.message) || e);
    return import('https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.4/dist/index.js');
  });
}

// Ask the browser to stop treating this database as a cache.
//
// By default an origin's storage is "best-effort", which means exactly what it says: the browser may
// delete it without asking, and does — when the device runs low on disk (every engine evicts
// least-recently-used origins), and on WebKit when a site has gone a while without a visit. That is a
// perfectly sensible policy for a cache and a catastrophic one for the only copy of somebody's data,
// which is what this backend is. navigator.storage.persist() moves the origin to "persistent", after
// which only the user deletes it.
//
// Requested at boot rather than from a button, because the answer costs nothing and the alternative
// default is unprotected data. The engines differ in how they answer: Chrome decides silently from
// engagement signals (installed as a PWA, bookmarked, revisited), WebKit uses similar heuristics, and
// Firefox asks the user — which is the right question at the right moment, since the app has just told
// them their database lives here. A refusal is not fatal and not hidden: Settings shows the state, and
// offers to ask again.
function _pgRequestPersistence() {
  if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
  return navigator.storage.persisted()
    .then(function (already) { return already ? true : navigator.storage.persist(); })
    .catch(function () { return null; });
}

// Boot failed before there was an app to show it in: fall back to the setup dialog, which is the one
// piece of UI that exists whatever the backend did.
function _pgFail(message) {
  console.error('[pglite]', message);
  if (typeof appInstance === 'undefined' || !appInstance) return;
  appInstance.pgliteError = message;
  appInstance.setupStep = 'pglite';
  appInstance.showSetup = true;
  appInstance.loading = false;
}

async function initLocalPglite() {
  var dbName = _pgDbName();

  if (!(await _claimSingleTab(dbName))) {
    _pgFail('This database is already open in another tab. PostgreSQL-in-the-browser keeps its files in '
          + 'IndexedDB and two tabs writing them at once corrupts the database, so only one tab at a '
          + 'time may hold it. Close the other tab and reload.');
    return;
  }

  var PGlite;
  try {
    _pgSplashNote('Loading PostgreSQL (WebAssembly)…');
    PGlite = (await _importPglite()).PGlite;
  } catch (e) {
    _pgFail('Could not load the PGlite WebAssembly build, from /vendor/pglite/ or from the CDN. The '
          + 'vendored copy is a generated artifact, not committed to the repo — run ./update-vendor.sh '
          + '(or deploy through the GitHub Pages workflow, which materialises it) and reload. '
          + 'Details: ' + ((e && e.message) || e));
    return;
  }

  try {
    _pgSplashNote('Preparing the database…');
    if (window.bootMark) window.bootMark('pgliteModuleLoaded');
    // idb:// persists the cluster in IndexedDB, so the database survives a reload, a browser restart,
    // and being offline. storage-pglite.js fetches supabase-schema.sql and applies it — idempotently,
    // so this is the first-run cost only.
    _pgStorage = await createPgliteStorage({ PGlite: PGlite, dataDir: 'idb://' + dbName });
    if (window.bootMark) window.bootMark('pgliteReady');
  } catch (e) {
    _pgFail('The local database failed to start: ' + ((e && e.message) || e));
    return;
  }

  var email = _pgEmail();
  _pgStorage.setCaller(email);

  var kv = createKvBackend(_pgStorage, {
    name: 'Local (this browser)',
    myEmail: function() { return email; },
    // The bootstrap probe. app_no_users() is SECURITY DEFINER in supabase-schema.sql — the same function
    // the Supabase backend reaches through an RPC — so ask it directly, as owner, for the same
    // RLS-independent answer. Fail CLOSED, matching the Supabase platform: mistaking a failure for an
    // empty registry would hand out admin.
    noUsers: function() {
      return _pgStorage._query('select public.app_no_users() as none')
        .then(function(r) { return !!(r && r.rows && r.rows[0] && r.rows[0].none); })
        .catch(function() { return false; });
    }
    // No subscribeTable: the single-tab lock above means there is no second client to hear from.
    // No uploadFile: with no blob store, image columns fall through to the _assets data-URI path in
    // app-core (uploadImage), which needs nothing but putRow.
  });
  backend = kv.backend;
  backend_users = kv.users;

  appInstance.currentUserEmail = email;
  _pgSplashNote('');
  // Not awaited: Firefox turns this into a permission prompt, and blocking the boot behind a dialog
  // would leave the user staring at a spinner to decide something about an app they cannot see yet.
  _pgRequestPersistence().then(function () { return appInstance.refreshLocalStore(); });
  init();
}

// The reauth dialog's button. There is no sign-in here, so "authenticate" means "say who you are" —
// which is also how you rehearse the access model as somebody else (see the identity note at the top).
function triggerOAuth() {
  var next = prompt('Act as which email address?\n\nThis is the identity the access policies will judge; '
                  + 'it is not verified — the database is in this browser and belongs to you.', _pgEmail());
  if (!next) return;
  localStorage.setItem(PGLITE_USER_KEY, String(next).trim().toLowerCase());
  location.reload();
}

initLocalPglite();
