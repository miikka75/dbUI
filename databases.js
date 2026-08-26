// databases.js — WHICH database this browser is looking at, and which others it knows about.
//
// One deployment serves many databases: the code is static, and a Firebase project id or a Supabase
// project URL is what makes it somebody's app. That was stored in ONE localStorage key per backend
// (`firebase_config`, `supabase_config`), which had two consequences nobody chose:
//
//   1. A browser profile could hold exactly ONE database. Connecting to a second overwrote the first,
//      and the only way back was to still have the shared link.
//   2. Every install was the SAME PWA. A web app's identity is its manifest `id` (and, in browsers too
//      old for `id`, its `start_url`); both were the origin root for every database alike. So two
//      databases installed as one app, wearing whichever icon was active when it was installed, and
//      launching it opened whichever database localStorage happened to hold.
//
// The fix for both is the same object: a database has a KEY, its config is stored under that key, and
// the key goes in the manifest. `app_db` names the active one.
//
// The key is derived from the connection rather than generated, because it has to survive a browser
// profile being wiped and rebuilt from the same shared link — a random id would install as a second
// app. `firebase:<projectId>` / `supabase:<project-ref>` / `pglite` / `local` are already the names of
// the things they identify.
//
// Browser: <script src="/databases.js"> defines the global Databases.
// Node   : require('./databases') -> the same object (pass a storage in `_bind` for tests).
(function (root) {
  var ACTIVE = 'app_db';
  var PREFIX = 'db.';
  // The single-key layout this replaces. Still READ, so an existing install keeps working and folds
  // itself into the new one on first boot; never written back.
  var LEGACY = { firebase: 'firebase_config', supabase: 'supabase_config' };

  // Injectable so the unit suite can drive a plain object instead of a real localStorage, and so a
  // Node require() of this file does not throw where there is no DOM.
  var store = (typeof localStorage !== 'undefined') ? localStorage : null;
  function get(k) { try { return store ? store.getItem(k) : null; } catch (e) { return null; } }
  function set(k, v) { try { if (store) store.setItem(k, v); } catch (e) {} }
  function del(k) { try { if (store) store.removeItem(k); } catch (e) {} }
  function parse(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  // What identifies a database, per backend. Returns null when the config does not identify one --
  // a half-filled setup form must NOT mint a key, or it would install as its own app.
  function keyFor(mode, config) {
    if (mode === 'firebase') return (config && config.projectId) ? 'firebase:' + config.projectId : null;
    if (mode === 'supabase') {
      // On a hosted project the identity is the project ref, the first label of
      // <ref>.supabase.co. Anywhere else the first label means nothing (`db.example.org` and
      // `db.other.org` would collide into one app), so a self-hosted Supabase is identified by its
      // whole host instead.
      var url = (config && config.url) || '';
      if (!url) return null;
      var host = url.replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '');
      var hosted = host.match(/^([^.]+)\.supabase\.(co|in)$/);
      return 'supabase:' + (hosted ? hosted[1] : host);
    }
    // The two local backends are singular per origin: one browser database, one dev server. They get a
    // key so they take part in the same identity and switching story, not because they can multiply.
    if (mode === 'pglite') return 'pglite';
    if (mode === 'local') return 'local';
    return null;
  }

  // A name for a human — the picker and the installed app's title fall back to this before the schema
  // has loaded (the schema is IN the database, so it cannot name the database you have not opened).
  function labelFor(key) {
    if (!key) return '';
    if (key === 'pglite') return 'In this browser';
    if (key === 'local') return 'Dev server';
    return key.slice(key.indexOf(':') + 1);
  }

  function record(key) { return key ? parse(get(PREFIX + key)) : null; }

  function list() {
    var out = [];
    if (!store) return out;
    for (var i = 0; i < store.length; i++) {
      var k = store.key(i);
      if (!k || k.indexOf(PREFIX) !== 0) continue;
      var r = parse(get(k));
      if (r && r.mode) out.push({ key: k.slice(PREFIX.length), mode: r.mode, config: r.config || null, label: r.label || labelFor(k.slice(PREFIX.length)) });
    }
    out.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return out;
  }

  function activeKey() { return get(ACTIVE) || null; }

  // Make `key` the active database. Also restores its MODE, because the mode and the config have to
  // move together -- switching to a Firebase database while `app_mode` still says supabase loads the
  // wrong backend and then fails to find a config for it.
  function setActive(key) {
    var r = record(key);
    if (!r) return false;
    set(ACTIVE, key);
    set('app_mode', r.mode);
    return true;
  }

  // Store a config and make it active. Returns the key, or null when the config identifies nothing.
  function remember(mode, config, label) {
    var key = keyFor(mode, config);
    if (!key) return null;
    var prev = record(key) || {};
    set(PREFIX + key, JSON.stringify({
      mode: mode,
      config: config || null,
      label: label || prev.label || labelFor(key)
    }));
    set(ACTIVE, key);
    set('app_mode', mode);
    return key;
  }

  function forget(key) {
    del(PREFIX + key);
    if (activeKey() === key) del(ACTIVE);
  }

  // The ACTIVE database's config for `mode`. Every reader that used to call
  // `JSON.parse(localStorage.getItem('firebase_config'))` asks this instead, so "which database" is
  // decided in one place rather than thirteen.
  //
  // The legacy fallback is what makes an existing install keep working: its config is under the old
  // single key and no `db.` record exists yet. `migrate()` folds it in on the next boot; until then,
  // and for anything that reads before migration runs, this still answers.
  function config(mode) {
    var r = record(activeKey());
    if (r && r.mode === mode && r.config) return r.config;
    // No active record for this mode: fall back to the legacy key rather than to nothing.
    return LEGACY[mode] ? parse(get(LEGACY[mode])) : null;
  }

  // Fold a pre-`db.` install into the new layout, once. Idempotent: after it has run there is a record
  // and the legacy key is left alone (NOT deleted -- a downgrade, or a tab still running the old code,
  // would otherwise find nothing and show the setup screen for a database the user still has).
  function migrate() {
    var moved = [];
    Object.keys(LEGACY).forEach(function (mode) {
      var cfg = parse(get(LEGACY[mode]));
      var key = keyFor(mode, cfg);
      if (!key || record(key)) return;
      set(PREFIX + key, JSON.stringify({ mode: mode, config: cfg, label: labelFor(key) }));
      moved.push(key);
    });
    // Whatever mode the profile was already in decides which of them is active -- migrating must not
    // change which database the user is looking at.
    if (!activeKey()) {
      var mode = get('app_mode');
      var mine = keyFor(mode, parse(get(LEGACY[mode] || ''))) || ((mode === 'pglite' || mode === 'local') ? mode : null);
      if (mine && (record(mine) || mode === 'pglite' || mode === 'local')) {
        if (!record(mine)) set(PREFIX + mine, JSON.stringify({ mode: mode, config: null, label: labelFor(mine) }));
        set(ACTIVE, mine);
      }
    }
    return moved;
  }

  // The manifest identity for a database. `id` is what a modern browser compares; `start_url` is what
  // an older one falls back to, so the key goes in BOTH -- otherwise the two databases stay one app in
  // exactly the browsers that cannot say why.
  //
  // `id` need not be a navigable URL (the spec resolves it and keeps the string), but making it the
  // same URL as start_url means there is one thing to reason about instead of two.
  function manifestIdentity(base, key) {
    var q = key ? (base + '?db=' + encodeURIComponent(key)) : base;
    return { id: q, start_url: q, scope: base };
  }

  var D = {
    ACTIVE_KEY: ACTIVE, PREFIX: PREFIX, LEGACY: LEGACY,
    keyFor: keyFor, labelFor: labelFor, list: list, record: record,
    activeKey: activeKey, setActive: setActive, remember: remember, forget: forget,
    config: config, migrate: migrate, manifestIdentity: manifestIdentity,
    // Tests only: point the module at a fake storage.
    _bind: function (s) { store = s; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
  else root.Databases = D;
})(typeof self !== 'undefined' ? self : this);
