// backend-supabase.js — Supabase (Postgres) backend with Google Auth.
//
// This file is the PLATFORM half of a key-value backend: who the caller is (Google OAuth), how other
// clients hear about a write (realtime), where an uploaded image goes (Storage), and the authoritative
// answer to "is the member registry empty" (an RPC). The CONTRACT half — which store each row lives in,
// what shape it has, which schema-derived facts the schema-blind RLS needs mirrored — is backend-kv.js,
// shared verbatim with the browser's local PGlite mode (backend-local-pglite.js). Both run against the
// same supabase-schema.sql, so there is one mapping and one policy, hosted two ways.
//
// A drop-in sibling of backend-firebase.js (classic script, same globals: backend / backend_users /
// triggerOAuth). Firestore's document model is reproduced on a single Postgres key-value table (`kv`,
// one row per doc), so each per-doc Firestore rule becomes a per-row RLS policy (see supabase-schema.sql).
// Requires: backend-kv.js and storage-supabase.js loaded before this, and the supabase-js UMD global
// window.supabase.
// _u(): resolve same-origin paths against the app's own directory (see appUrl in index.html) so the
// app works when hosted under a subpath, e.g. a GitHub Pages project site at /<repo>/.
function _u(p) { return (typeof window !== 'undefined' && window.appUrl) ? window.appUrl(p) : p; }

var _sb = null;                 // supabase client
var _sbUser = null;             // current auth user ({ email, ... }) or null
var _sbAuthInited = false;      // guard: boot the app once, not on every auth event
var StorageSupabase = null;     // built from _sb in _startSupabase (mirrors StorageFirestore)
var backend_users = null;       // built alongside `backend` in _startSupabase, from backend-kv.js
var SUPABASE_BUCKET = 'uploads';

// --- Realtime (see the platform's subscribeTable) ----------------------------------------------------
var _sbChannel = null;          // the ONE postgres_changes channel over `kv`
var _sbHandlers = {};           // store name -> [onChange, ...]

// Fan a kv row change out to whoever subscribed to that store. `value` is the whole row document, which
// is exactly the shape getTableData returns, so subscribers need no second read.
function _sbDispatch(payload) {
  var rec = payload && (payload.new && payload.new.store ? payload.new : payload.old);
  if (!rec || !rec.store || !rec.key) return;
  var handlers = _sbHandlers[rec.store];
  if (!handlers || !handlers.length) return;
  var isDelete = payload.eventType === 'DELETE';
  var change = { type: isDelete ? 'delete' : 'put', id: rec.key, row: isDelete ? null : (rec.value || null) };
  if (!isDelete && !change.row) return;
  handlers.slice().forEach(function(fn) { try { fn(change); } catch (e) {} });
}

function _ensureRealtime() {
  if (_sbChannel || !_sb) return;
  _sbChannel = _sb.channel('kv-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kv' }, _sbDispatch)
    .subscribe();
}

// Live updates (the optional platform capability — see live-sync.js and app-core's _liveWatch). Every
// store is a slice of the SAME `kv` table, so this is one channel with a store -> handlers dispatch map
// rather than a channel (and a WebSocket subscription) per table.
//
// No filter is applied: RLS filters postgres_changes per subscriber, so a member receives exactly
// the INSERT/UPDATE events they could have read themselves — the same gate as the initial fetch,
// enforced in the same place. DELETE events are the documented exception (see supabase-schema.sql):
// they are broadcast unfiltered and carry only the primary key, (store, key). A delete for a row the
// client never cached is a no-op in the reconciler, so this leaks the fact that some row id under
// some store was removed, and nothing about its contents.
function _sbSubscribe(store, onChange) {
  if (!_sbHandlers[store]) _sbHandlers[store] = [];
  _sbHandlers[store].push(onChange);
  _ensureRealtime();
  return function() {
    var arr = _sbHandlers[store] || [];
    var i = arr.indexOf(onChange);
    if (i >= 0) arr.splice(i, 1);
  };
}

// The signed-in user's lowercased email ('' when signed out) — auth first, app state as fallback.
function _myEmail() {
  return (((_sbUser && _sbUser.email)
    || (typeof appInstance !== 'undefined' && appInstance && appInstance.currentUserEmail)) || '').toLowerCase();
}

// Bootstrap detection via a SECURITY DEFINER RPC: an unregistered user can't read /_meta/users (RLS), and
// — unlike Firestore, where a denied read THROWS and is distinguishable — a forbidden Supabase SELECT just
// returns zero rows. This RPC bypasses RLS to answer "are there zero users?" authoritatively, so we never
// mistake a permission denial for first-boot. Fail-closed (false) on error.
function _noUsers() {
  return _sb.rpc('app_no_users').then(function(r) { return r && !r.error ? !!r.data : false; })
    .catch(function() { return false; });
}

// Upload to the public Supabase Storage bucket `uploads` under <email>/<ts>_<name>, resolving to the
// public URL (stored in the row by the image column). Presence of this method enables the image uploader.
function _sbUpload(file) {
  if (!_sb) return Promise.reject(new Error('Supabase not initialized'));
  var email = _myEmail() || 'anon';
  var safe = String((file && file.name) || 'file').replace(/[^\w.\-]+/g, '_');
  var path = email + '/' + Date.now() + '_' + safe;
  return _sb.storage.from(SUPABASE_BUCKET).upload(path, file, { upsert: false }).then(function(res) {
    if (res && res.error) throw res.error;
    return _sb.storage.from(SUPABASE_BUCKET).getPublicUrl(path).data.publicUrl;
  });
}

function initSupabase() {
  // The ACTIVE database's config — see the same note in backend-firebase.js.
  var config = Databases.config('supabase') || window.SUPABASE_CONFIG || {};
  if (config.url && config.anonKey) { _startSupabase(config); return; }
  fetch(_u('/supabase-config.json')).then(function(r) { return r.ok ? r.json() : null; }).then(function(c) {
    if (c && c.url && c.anonKey) { Databases.remember('supabase', c); _startSupabase(c); }
    else { appInstance.showSetup = true; appInstance.setupStep = 'supabase'; appInstance.loading = false; }
  }).catch(function() { appInstance.showSetup = true; appInstance.setupStep = 'supabase'; appInstance.loading = false; });
}

function _startSupabase(config) {
  _sb = window.supabase.createClient(config.url, config.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  StorageSupabase = createSupabaseStorage(_sb);

  // The contract, over this project's kv table. Built HERE rather than at script load because the
  // storage adapter needs the client, which needs the config — and init() (which is what first touches
  // `backend`) runs later still, from onUser below.
  var kv = createKvBackend(StorageSupabase, {
    name: 'Supabase',
    myEmail: _myEmail,
    noUsers: _noUsers,
    subscribeTable: _sbSubscribe,
    uploadFile: _sbUpload
  });
  backend = kv.backend;
  backend_users = kv.users;

  function onUser(user) {
    if (typeof window !== 'undefined' && window.bootMark) window.bootMark('authReady');
    _sbUser = user || null;
    if (user) {
      appInstance.currentUserEmail = user.email;
      appInstance.needsReauth = false;   // clear any transient prompt raised before the redirect resolved
      if (!_sbAuthInited) { _sbAuthInited = true; init(); }   // boot once
    } else {
      appInstance.needsReauth = true; appInstance.loading = false;
    }
  }
  // Resolve the initial session (handles the OAuth redirect return), then keep in sync.
  _sb.auth.getSession().then(function(res) {
    onUser(res && res.data && res.data.session ? res.data.session.user : null);
  }).catch(function() { onUser(null); });
  _sb.auth.onAuthStateChange(function(_event, session) {
    var user = session ? session.user : null;
    if (user && _sbAuthInited) { _sbUser = user; return; }   // ignore token-refresh churn once booted
    onUser(user);
  });
}

function triggerOAuth() {
  if (!_sb) return;
  _sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } })
    .catch(function(e) { console.error('Supabase auth error:', e); });
}

initSupabase();
