// Resolve a same-origin path against the app's own directory rather than the domain root, so the app
// works when hosted under a subpath (e.g. a GitHub Pages project site at /<repo>/). Delegates to the
// appUrl() defined in index.html's boot; the fallback keeps this file loadable on its own.
function _u(p) { return (typeof window !== 'undefined' && window.appUrl) ? window.appUrl(p) : p; }

// Columns with nothing to translate: the storage/bookkeeping ones, plus any the schema marks `hidden`.
// A hidden column is filtered out of visibleCols, the lookup editor, the ref-lane column list and the
// board's edit row, so it never reaches the screen — offering its header or its values for translation
// only pads the Languages editor with keys nobody can ever see. A reorderable table's numeric `position`
// is the usual case: it is rewritten on reorder, so its values are ordinals, not words.
function _untranslatableCol(cols, name) {
  if (name === 'id' || name === 'created_at' || name === 'updated_at') return true;
  var def = cols && cols[name];
  return !!(def && typeof def === 'object' && def.hidden);
}

// Column types whose VALUES are never translatable text. A `field.<col>` HEADER is still wanted for all
// of them -- "Points" needs a Finnish label like every other column heading -- so this is deliberately a
// second, narrower predicate rather than a widening of the one above.
//
// It exists because opting a lookup TABLE into `translatableLists` sweeps the distinct values of its
// columns, and ref_chores carries `points` beside `chore`: without this, the Languages editor offered
// `list.ref_chores.2` and `list.ref_chores.5` for translation. That is the padding-the-editor failure
// translation-keys.test.js already names, and worse than noise -- a number has no translation, so the
// entries can only ever sit there empty, hiding the values that do need one.
var _UNTRANSLATABLE_VALUE_TYPES = { number: 1, date: 1, owner: 1, url: 1, image: 1 };
function _untranslatableValueCol(cols, name) {
  if (_untranslatableCol(cols, name)) return true;
  var def = cols && cols[name];
  var type = (typeof def === 'string') ? def : (def && def.type);
  return !!_UNTRANSLATABLE_VALUE_TYPES[type];
}

// Guard for the /api probes below: skip them on origins where no dev server can exist (see
// mayHaveLocalServer in index.html), so a static host doesn't log a 405 on every load. Defaults to
// true if the boot didn't define it, preserving the old always-probe behaviour.
function _mayLocal() { return (typeof window !== 'undefined' && window.mayHaveLocalServer) ? window.mayHaveLocalServer() : true; }

// BCP-47 languages offered by the "add language" picker (Languages tab). The `code` doubles as the Intl
// locale (see calLocale), so every entry is a valid BCP-47 tag; `name` is the endonym (renamable after).
var BCP47_LANGS = [
  { code: 'en', name: 'English' }, { code: 'es', name: 'Español' }, { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' }, { code: 'it', name: 'Italiano' }, { code: 'pt', name: 'Português' },
  { code: 'pt-BR', name: 'Português (Brasil)' }, { code: 'nl', name: 'Nederlands' }, { code: 'sv', name: 'Svenska' },
  { code: 'nb', name: 'Norsk bokmål' }, { code: 'da', name: 'Dansk' }, { code: 'fi', name: 'Suomi' },
  { code: 'is', name: 'Íslenska' }, { code: 'pl', name: 'Polski' }, { code: 'cs', name: 'Čeština' },
  { code: 'sk', name: 'Slovenčina' }, { code: 'sl', name: 'Slovenščina' }, { code: 'hu', name: 'Magyar' },
  { code: 'ro', name: 'Română' }, { code: 'hr', name: 'Hrvatski' }, { code: 'sr', name: 'Српски' },
  { code: 'bg', name: 'Български' }, { code: 'el', name: 'Ελληνικά' }, { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' }, { code: 'tr', name: 'Türkçe' }, { code: 'et', name: 'Eesti' },
  { code: 'lv', name: 'Latviešu' }, { code: 'lt', name: 'Lietuvių' }, { code: 'ca', name: 'Català' },
  { code: 'eu', name: 'Euskara' }, { code: 'gl', name: 'Galego' }, { code: 'ar', name: 'العربية' },
  { code: 'he', name: 'עברית' }, { code: 'fa', name: 'فارسی' }, { code: 'hi', name: 'हिन्दी' },
  { code: 'bn', name: 'বাংলা' }, { code: 'th', name: 'ไทย' }, { code: 'vi', name: 'Tiếng Việt' },
  { code: 'id', name: 'Bahasa Indonesia' }, { code: 'ms', name: 'Bahasa Melayu' }, { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' }, { code: 'zh', name: '中文 (简体)' }, { code: 'zh-Hant', name: '中文 (繁體)' }
];

// Column typing primitives — extracted to /columns.js (Columns.*), pure over the schema map and
// shared with dev/schema.js + unit tests. These thin globals bind the app's SCHEMA and preserve the
// existing signatures (incl. getColumnList(null, col) scanning every table) so all call sites stand.
function getColumnType(table, col) { return Columns.columnType(SCHEMA, table, col); }
function getColumnList(table, col) { return Columns.columnList(SCHEMA, table, col); }
function getColumnRef(table, col) { return Columns.columnRef(SCHEMA, table, col); }
function colIsMirror(tables, col, tableName) { return Columns.isMirror(tables, tableName, col); }
function getTableMirrorSource(tables, tableName) { return Columns.tableMirrorSource(tables, tableName); }
function getOwnerCol(table) { return Columns.tableOwnerCol(SCHEMA, table); } // table's type:'owner' column name, or null
function getDefaultCols(table) { return Columns.tableDefaultCols(SCHEMA, table); } // [{name, from}] for `defaultFrom` columns
// Owner-write bounds for one table, from the SAME generator the two rules layers read (so the UI can
// never offer an edit the write layers will refuse). Memoized on SCHEMA's identity: _normalizeSchema
// rebinds SCHEMA to a fresh object on every load, so a new schema invalidates this by construction —
// the same self-invalidating trick columns.js's WeakMap uses.
var _ownerBoundsKey = null, _ownerBoundsAll = null;
function ownerBoundsFor(table) {
  if (_ownerBoundsKey !== SCHEMA) { _ownerBoundsKey = SCHEMA; _ownerBoundsAll = BackendHelpers.ownerWritableOf({ tables: SCHEMA }); }
  return _ownerBoundsAll[table] || null;
}

// Which column a table STAMPS, memoized the same self-invalidating way. Unlike the owner bounds above
// this is consulted for every caller, not just the self-service branch: a table grant does not lift a
// stamped column, which is the whole reason the key exists.
var _stampedKey = null, _stampedAll = null;
function stampedBoundsFor(table) {
  if (_stampedKey !== SCHEMA) { _stampedKey = SCHEMA; _stampedAll = BackendHelpers.stampedOf({ tables: SCHEMA }); }
  return _stampedAll[table] || null;
}

// --- Permission "features" model: extracted to /access-features.js (AccessFeatures.*), a pure module
//     over (schema, views) shared with the unit tests. These thin wrappers bind the app's global
//     SCHEMA/VIEWS so every existing call site (grantFeatureChips, selectedFeatures, canAccess, ...)
//     stays unchanged. See access-features.js for the full rationale. ---
function viewRosters(v) { return AccessFeatures.viewRosters(v); }
function rotationTables(v) { return AccessFeatures.rotationTables(v); }  // every table a rotation READS (all three shapes)
function viewComputedHelpers(v) { return AccessFeatures.viewComputedHelpers(v); }
function viewHelperTables(v) { return AccessFeatures.viewHelperTables(v); }
function viewTables(v) { return AccessFeatures.viewTables(v); }
function viewImplicitTables(v) { return AccessFeatures.viewImplicitTables(v, VIEWS); }
function isPureMirror(t) { return AccessFeatures.isPureMirror(t, SCHEMA); }
function satelliteTables() { return AccessFeatures.satelliteTables(SCHEMA, VIEWS); }
function grantFeatures() { return AccessFeatures.grantFeatures(SCHEMA, VIEWS); }
function featureClosure(featureId) { return AccessFeatures.featureClosure(featureId, SCHEMA, VIEWS); }
function expandFeatureGrants(featureIds) { return AccessFeatures.expandFeatureGrants(featureIds, SCHEMA, VIEWS); }
function selectedFeatures(tableList) { return AccessFeatures.selectedFeatures(tableList, SCHEMA, VIEWS); }

// --- Folder-config (appConfig) export/import round-trip ---
// Folder config is exported/imported generically: EVERYTHING is round-tripped EXCEPT the keys in
// this denylist (environment-specific values that must not cross an export boundary). This means a
// NEW appConfig parameter is round-tripped automatically with no export/import code change — add a
// key here only if it must stay machine-local. (See access.test.js round-trip guard test.)
var FOLDER_CONFIG_EXPORT_EXCLUDE = { mode: true };
function exportableConfig(appConfig) {
  var out = {};
  Object.keys(appConfig || {}).forEach(function(k) { if (!FOLDER_CONFIG_EXPORT_EXCLUDE[k]) out[k] = appConfig[k]; });
  // A database installed before the fingerprints were dropped still carries them; they are inert, and
  // on a real bundle they are ~18 kB of hashes nobody reads. Strip them on the way out rather than
  // copying them into every export and into whatever database that export is imported to.
  if (out.example && out.example.units) {
    out.example = Object.assign({}, out.example);
    delete out.example.units;
  }
  return out;
}
// Merge imported portable config over the current config, preserving this environment's excluded
// keys (e.g. `mode`) — an import never changes which backend this folder uses.
function mergeImportedConfig(currentConfig, importedConfig, mode) {
  var merged = Object.assign({}, currentConfig || {});
  Object.keys(importedConfig || {}).forEach(function(k) { if (!FOLDER_CONFIG_EXPORT_EXCLUDE[k]) merged[k] = importedConfig[k]; });
  if (mode !== undefined && mode !== null && mode !== '') merged.mode = mode; else delete merged.mode;
  return merged;
}

// --- Stored assets (the bucket-free image tier) ---
// Max length of an _assets row's `src` data-URI string. Firestore rejects a document over 1048576
// bytes outright, so the cap sits below that with room for the rest of the doc; Supabase's jsonb
// would take far more, but both rule layers declare the SAME number (rules-parity.test.js compares
// the multiset of size caps across firestore.rules and supabase-schema.sql, so a value raised on one
// side only fails there rather than in production on one backend). _fitImageToCap re-encodes until an
// image fits, so this bound is what decides achievable background quality (~1600px JPEG).
var ASSET_CAP = 900000;

// --- View background rendering modes ---
// `fit` names an intent instead of exposing raw CSS: an enum keeps validateSchema able to reject a
// typo, keeps the Settings picker a fixed list, and keeps arbitrary strings out of the style object.
//   cover   fill the card, cropping overflow      (hero / backdrop photo — the default)
//   contain fit entirely inside, may letterbox    (a diagram or logo shown whole)
//   tile    natural size, repeated                (small texture / pattern)
//   width   `<n>% auto` — scales to a percentage of the card's WIDTH with the image's own aspect
//           ratio preserved, height following from it (centered watermark). `width` supplies n.
var BG_FITS = {
  cover:   { size: 'cover',   repeat: 'no-repeat' },
  contain: { size: 'contain', repeat: 'no-repeat' },
  tile:    { size: 'auto',    repeat: 'repeat' },
  width:   { size: null,      repeat: 'no-repeat' }   // size computed from `width`
};
// background-position allowlist. With `cover` this is what decides which part of the image survives
// the crop, so a short card can still show a photo's subject rather than its middle.
var BG_POSITIONS = ['center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'];

var app; // Vue app instance
var appInstance; // Mounted root component proxy
var backend; // Set by backend adapter loaded after this file

function getSetting(key, def) {
  try { var s = JSON.parse(localStorage.getItem('app_settings') || '{}'); return s[key] !== undefined ? s[key] : def; } catch(e) { return def; }
}

// Privacy: keep the first word, reduce every later word to an initial. "Name Surname" -> "Name S.";
function obscureName(s) {
  if (s == null) return s;
  var str = String(s).trim();
  if (!str) return str;
  var parts = str.split(/\s+/);
  if (parts.length < 2) return str;
  return parts[0] + ' ' + parts.slice(1).map(function(p) { return p.charAt(0).toUpperCase() + '.'; }).join(' ');
}

var PRINT_CSS = 'body{font-family:system-ui;margin:20px;font-size:13px}.card{border:1px solid #ddd;padding:12px;margin-bottom:12px;border-radius:6px;page-break-inside:avoid}dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0}dt{font-weight:bold;font-size:13px;opacity:0.7}dd{margin:0;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left;font-size:13px}th{background:#f5f5f5}.embed{margin:8px 0;padding:8px;background:#f9f9f9;border-radius:4px}.embed h4{margin:0 0 4px;font-size:13px;opacity:0.7}h1,h2,h3,h4,h5,h6{font-size:13px;margin:6px 0}@media print{button{display:none}}';
// Click-to-sort header behaviour, shared by every surface that sorts: the root (the data grid, via
// its own sortCol/sortAsc) and the components that keep their own sort state because they render
// their own lists rather than currentData (rsvp, pivot). Mix into `methods` with Object.assign, like
// ROOT_PROXY. The contract lives here once: first click ascending, clicking the same column flips.
// `this` supplies sortCol/sortAsc, so it works for the root instance and a component alike.
var SORT_UI = {
  toggleSort: function(col) {
    if (this.sortCol === col) this.sortAsc = !this.sortAsc;
    else { this.sortCol = col; this.sortAsc = true; }
  },
  sortIcon: function(col) { return this.sortCol !== col ? '' : (this.sortAsc ? ' ▲' : ' ▼'); }
};

function createVueApp() {
  var vuetify = Vuetify.createVuetify({
    theme: {
      defaultTheme: localStorage.getItem('app_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      // `outline` is NOT one of Vuetify's own theme colors (it carries `--v-border-color` instead), but the
      // app's styles and templates ask for `rgb(var(--v-theme-outline), a)` in ~15 places — separators,
      // card frames, the editable-cell box. An undefined var makes each of those declarations invalid, and
      // an invalid declaration is dropped, so every one of those borders silently never painted. Defining
      // the color here is what makes them render; it is load-bearing, not decoration.
      themes: {
        light: { colors: { primary: '#4285f4', secondary: '#5cbbf6', surface: '#ffffff', background: '#f5f5f5', outline: '#79747e' } },
        dark: {
          dark: true,
          // Explicit bright text colors + higher emphasis so column text stands out from the dark
          // surface/background (Vuetify's derived defaults rendered too dim against #2a2a2a/#1a1a1a).
          // The outline lightens to stay visible against those same dark surfaces.
          colors: { primary: '#8ab4f8', secondary: '#5cbbf6', surface: '#2a2a2a', background: '#1a1a1a', 'on-surface': '#f1f3f4', 'on-background': '#f1f3f4', outline: '#938f99' },
          variables: { 'high-emphasis-opacity': 0.96, 'medium-emphasis-opacity': 0.78 }
        }
      }
    }
  });

  app = Vue.createApp({
    data: function() { return {
      loading: true,
      showSetup: false,
      hasLocalServer: false,
      currentUserEmail: null,
      userList: [],
      usersLoaded: false,
      // True when users exist but the signed-in user is not one of them (self-scoped getMyAccess said
      // registered:false). Distinguishes "unregistered" from "bootstrap" (both have an empty userList
      // for a non-admin who can't read the whole roster).
      selfUnregistered: false,
      accessRequests: [],       // admin: pending membership requests
      accessRequested: false,   // unregistered user: have I already submitted a request this session
      accessRequestName: '',    // optional display name entered on the request banner
      myProfile: { name: '', shared: false, picture: '' },   // this user's opt-in display-name profile (+ optional avatar)
      profileSaved: null,       // last-persisted {name, shared, picture} snapshot -> skip redundant blur saves
      profilesByEmail: {},      // admin: all users' {name, shared} profiles, keyed by email (Users table)
      listAvatars: {},          // user-linked lists: viewer-safe { listName: { value: picture } } projection
      listUserLinks: {},        // admin only: raw { listName: { value: email } } links, for the Lookup editor
      myListValues: {},         // self-scoped { listName: myValue } — what `@me` means on a userlink list
      periodOffset: 0,          // leaderboard ‹ › navigation: periods back from now (0 = current)
      importProgress: null,     // {done,total,icon,detail,errors,finished} while an import runs; null otherwise
      // The example picker (Settings -> Examples, and the first-boot prompt on an empty database).
      // `manifest` is examples/index.json once fetched -- one same-origin GET per session, never at
      // boot. `update` is what Examples.compare() found, or null.
      examples: { open: false, manifest: null, busy: false, error: '', pick: null, langs: [], withData: true },
      exampleUpdate: null,
      exampleUpdateChecked: false,
      firestoreRules: '',
      firebaseConfigInput: (function() { var c = Databases.config('firebase'); return c ? JSON.stringify(c) : ''; })(),
      supabaseUrlInput: '',
      supabaseKeyInput: '',
      // Browser-local Postgres: the self-asserted identity the RLS policies will judge (see the note at
      // the top of backend-local-pglite.js), and whatever stopped the WASM database from starting.
      pgliteUserInput: localStorage.getItem('pglite_user') || 'you@local',
      pgliteError: '',
      // Browser-local Postgres: how much of the origin's storage the database occupies, and whether the
      // browser has agreed not to evict it. `persisted: null` = unknown/unsupported, false = best-effort
      // (the browser may delete it on its own), true = only the user can.
      localStore: { persisted: null, usage: 0, quota: 0 },
      needsReauth: false,
      setupStep: (function() { var m = localStorage.getItem('app_mode'); return (m === 'firebase' || m === 'supabase') ? m : null; })(),
      mode: '',
      currentTable: '',
      currentData: [],
      dataCache: {},
      sortCol: null,
      sortAsc: true,
      strings: {},
      languages: [],
      currentLang: '',
      editingLang: null,
      currentTranslations: {},
      listsCache: {},
      // The runtime search term for the open view. Cleared on navigation (see selectTab): a term is
      // about the list in front of you, and carrying it to the next view hides rows for a reason
      // that is no longer on screen.
      searchTerm: '',
      viewingArchive: false,
      drawer: true,
      rail: false,
      drawerOpen: false,
      openedGroups: [],
      navLayoutOverride: localStorage.getItem('app_nav_layout') || null,
      mobile: window.innerWidth < 768,
      windowWidth: window.innerWidth,
      theme: localStorage.getItem('app_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      syncing: false,
      snackbar: false,
      snackText: '',
      // _collapseBackgrounds starts COLLAPSED (unlike the others): the section is one row per navigable
      // screen, so expanded by default it pushes everything below it off-screen — which also stops
      // Vuetify's v-img from ever rendering the profile avatar, since v-img loads on intersection.
      settings: { preload_archive: getSetting('preload_archive', true), preload_translations: getSetting('preload_translations', true), _collapseApp: false, _collapseSchema: false, _collapseLists: false, _collapseBackgrounds: true },
      appConfig: null,
      saveTimers: {},
      // Live sync (see the _live* methods). _liveSubs maps a store name -> its unsubscribe function, so
      // a table is subscribed at most once per session; _liveState is LiveSync's pending-change queue.
      // Both are plain bookkeeping — nothing renders them — but they sit here rather than on the raw
      // instance so a reset/reload path can find and tear them down.
      // cacheKey -> the in-flight fetch for it. Every load site tests dataCache, which is only
      // populated when a fetch RESOLVES -- so two loads in the same tick each issued their own request
      // for the same rows. Billed twice on Firestore, for one copy of the data.
      _inflight: {},
      _liveSubs: {},
      _liveState: null,
      _liveRebuildTimer: null,
      pendingDelete: null,
      pendingDeleteTimer: null,
      currentRefTable: null,
      themeEdit: {},   // admin palette editor: pending {mode: {token: hex}} overrides (applied live, saved to schema.theme)
      schemaData: null,
      pageEditing: false,
      pageEditText: '',
      pageCache: {},
      assetCache: {},   // { '<assetId>': dataUri | '' } — '' is a cached MISS (missing/denied), so render never re-requests
      _assetPending: {},// in-flight asset reads, so a repeated render can't queue the same fetch twice
      bgBusy: '',       // view name whose background upload is in flight (Settings spinner)
      expandedCard: null,
      listSwitchOverrides: {}, // {itemId_col: true} — tracks which cells are toggled to alt list
    }; },

    computed: {
      appTitle: function() { return this.t('app.title'); },
      // Does this database have a structure yet? An empty one is what a freshly created database looks
      // like -- setup writes the empty defaultSchema and reloads -- and it is the moment the example
      // picker is worth offering unprompted.
      hasAnyTables: function() { return !!(this.schemaData && Object.keys(this.schemaData.tables || {}).length); },
      // Offer the examples to an admin looking at an empty database. Not a modal at boot: it renders in
      // the empty main area, so it can be ignored by anyone who came here to import their own file.
      offerExamples: function() { return !this.loading && this.isAdmin && !this.hasAnyTables && !this.isUnregisteredUser; },
      langItems: function() { return this.languages.map(function(l) { return { title: l.name, value: l.code }; }); },
      // All sidebar group ids (parents with children) — used to expand all on the mobile "More" drawer.
      allGroupIds: function() { return this.sidebarTabs.filter(function(t) { return t.children; }).map(function(t) { return t.id; }); },
      sidebarTabs: function() {
        var self = this;
        var allowedTables = self.userAllowedTables;
        function canAccess(id) {
          if (!allowedTables) return true;
          if (VIEWS[id]) {
            var v = VIEWS[id];
            // Restricted doc-view: a markdown page with `access:[tables]` is hidden unless the user is
            // granted one of them (the firestore _pages rule enforces the matching read server-side).
            if (typeof v.markdown === 'string' && !self.canAccessPage(v)) return false;
            // A source is reachable if granted OR self-serviceable (owner-column table): a member sees a
            // self-service table/view in nav without a table grant, scoped to their own rows by the rules.
            if (!(v.sources || []).every(function(s) { return self.canReachTable(s); })) return false;
            // A sourceless view (rotation/calendar/pivot/rsvp) is unlocked by ANY of the tables it reads
            // — one you lack simply renders blank (per-roster access, e.g. team_b coordinator sees
            // team_a empty). Those inputs are declared per-kind (rosters, calendar.sources,
            // pivot.source, rsvp.events/responses), not in `sources`, so ask viewImplicitTables for the
            // whole set: consulting rosters alone let a calendar or a pivot through to a user with no
            // grant on anything it reads, handing them a tab that could only ever render empty.
            // Self-service counts, exactly as it does for a declared source above — it is what keeps a
            // grantless member's own calendar (where `addTo` lets them log a row) in their nav.
            if (!(v.sources && v.sources.length)) {
              var inputs = viewImplicitTables(v);
              if (inputs.length) return inputs.some(function(t) { return self.canReachTable(t); });
            }
            return true;
          }
          if (SCHEMA[id]) return self.canReachTable(id);
          return true;
        }
        var navCfg = self.navConfig;
        var navItems = (navCfg && Array.isArray(navCfg.items)) ? navCfg.items : [];
        return buildNavTabs(navItems, self.t.bind(self), canAccess, { isAdmin: self.isAdmin, hasLookup: self.refTables.length || Object.keys(self.visibleLists).length });
      },
      bottomNavTabs: function() {
        // Schema can define explicit bottom nav items: nav.bottomNav = ["view1", "view2", ...]
        var navCfg = this.navConfig;
        if (navCfg && Array.isArray(navCfg.bottomNav)) {
          var all = this.sidebarTabs; var flat = []; all.forEach(function(t) { if (t.divider) return; flat.push(t); if (t.children) t.children.forEach(function(c) { flat.push(c); }); });
          return navCfg.bottomNav.map(function(id) { return flat.find(function(t) { return t.id === id; }); }).filter(Boolean);
        }
        // Fallback: first 5 flattened items
        var tabs = []; this.sidebarTabs.forEach(function(t) { if (t.divider) return; tabs.push(t); if (t.children) t.children.forEach(function(c) { tabs.push(c); }); });
        return tabs.slice(0, 5);
      },
      bottomNavVisible: function() { return this.bottomNavTabs.length > 5 ? this.bottomNavTabs.slice(0, 4) : this.bottomNavTabs; },
      // The view-kind computeds, all off ONE discriminator (SchemaNormalize.viewKind, which reads the
      // `kind` the schema carries). They used to be seven independent probes for seven fields, plus an
      // eighth in schema-normalize and a ninth in migrations -- an implicit discriminator cannot be kept
      // in sync, because there is nothing to sync.
      //
      // `currentKind` is null for a bare TABLE, which is not a view and has no kind. isDataView keeps
      // its own shape for that reason: a table renders through the data view, so "no kind" counts.
      currentKind: function() { return SchemaNormalize.viewKind(VIEWS[this.currentTable]); },
      isDataView: function() {
        if (!this.currentTable || this.currentTable[0] === '_') return false;
        var k = this.currentKind;
        return k ? k === 'data' : !!SCHEMA[this.currentTable];
      },
      isRotationView: function() { return this.currentKind === 'rotation'; },
      isCalendarView: function() { return this.currentKind === 'calendar'; },
      isPivotView: function() { return this.currentKind === 'pivot'; },
      isRsvpView: function() { return this.currentKind === 'rsvp'; },
      isBoardView: function() { return this.currentKind === 'board'; },
      isFormView: function() { return this.currentKind === 'form'; },
      isStatsView: function() { return this.currentKind === 'stats'; },
      // Curated palette tokens exposed in the admin theme editor (Vuetify color names + friendly labels).
      themeTokens: function() {
        return [
          { key: 'primary', label: 'Primary' }, { key: 'secondary', label: 'Secondary' },
          { key: 'surface', label: 'Surface' }, { key: 'background', label: 'Background' },
          { key: 'on-surface', label: 'Text' }, { key: 'error', label: 'Error' }, { key: 'success', label: 'Success' }
        ];
      },
      // Screens a background can be set on: the navigable tabs, flattened (groups contribute their
      // children, not themselves), minus the system screens. Titles come from sidebarTabs already
      // translated, so the Settings list needs no key of its own per view.
      backgroundTargets: function() {
        var out = [];
        (this.sidebarTabs || []).forEach(function(t) {
          if (!t || t.divider) return;
          if (t.children) { t.children.forEach(function(c) { if (c && c.id) out.push({ id: c.id, title: c.title }); }); return; }
          if (String(t.id).slice(0, 4) === 'grp:' || String(t.id).slice(0, 2) === '__') return;
          out.push({ id: t.id, title: t.title });
        });
        return out;
      },
      // `fit` options for the Settings picker (see BG_FITS for what each maps to). Keys are spelled out
      // rather than built as 'bg.fit_' + k: the translation-keys drift guard scans for literal t('…')
      // arguments, and a concatenation would register the useless partial key 'bg.fit_' instead.
      bgFitItems: function() {
        return [
          { value: 'cover',   title: this.t('bg.fit_cover') },
          { value: 'contain', title: this.t('bg.fit_contain') },
          { value: 'tile',    title: this.t('bg.fit_tile') },
          { value: 'width',   title: this.t('bg.fit_width') }
        ];
      },
      // background-position as a 3x3 grid of cells, so the picker is visual and needs no label per value.
      bgPositionGrid: function() {
        return [['top left', 'top', 'top right'], ['left', 'center', 'right'], ['bottom left', 'bottom', 'bottom right']];
      },
      // Single classifier for the current view's kind + the top-level component registry dispatch.
      // Every kind maps to a component in VIEW_KINDS; an unclassified view returns null (nothing renders).
      viewKind: function() {
        var ct = this.currentTable;
        if (ct === '__languages') return 'languages';
        if (ct === '__lookup') return 'lookup';
        if (ct === '__settings') return 'settings';
        // A migrated schema SAYS what each view is (migrations.js v1->v2), so ask rather than sniff.
        // The chain below is the fallback for a schema that has not been through the migration -- a
        // fixture built by hand in a test, say. It is also what the migration derives from, so the two
        // cannot disagree.
        var declared = (VIEWS[ct] || {}).kind;
        if (declared) return declared;
        if (this.isCalendarView) return 'calendar';
        if (this.isRotationView) return 'rotation';
        if (this.isPivotView) return 'pivot';
        if (this.isRsvpView) return 'rsvp';
        if (this.isBoardView) return 'board';
        if (this.isFormView) return 'form';
        if (this.currentPage) return 'page';
        if (this.isDataView) return 'data';
        return null;
      },
      viewComponent: function() { return (window.VIEW_KINDS || {})[this.viewKind] || null; },
      // Background for the open view, bound onto the dispatched component in ui.html. Every view kind's
      // template has a single root element, so Vue's attribute fallthrough merges this onto that card —
      // one binding covers all eight kinds instead of a per-template change.
      viewBackground: function() { return this.backgroundStyleFor(this.currentTable); },
      // Calendar rendering state (mode/anchor/selection + derived cells) lives in the calendar-view
      // component now; the root keeps only the pure model helpers (calEventsFor, _calCells*, _calWindowFor).
      rotationViewCols: function() { return this.rotationColsFor(this.currentTable, this.currentData || []); },
      rotationSlotCols: function() { return this.rotationViewCols.filter(function(c) { return c !== '_period'; }); },
      // Registry-selected body element for the rotation view (unknown/`list` layout -> the list part).
      rotationBodyComponent: function() { return (window.viewPartFor && window.viewPartFor('rotation', this.rotationDisplayLayout)) || 'rotation-list'; },
      rotationLayout: function() { var v = VIEWS[this.currentTable]; return (v && (v.layout || (v.rotation && v.rotation.layout))) || 'table'; },
      // On phones a wide multi-column table overflows horizontally; fall back to the stacked card layout.
      rotationDisplayLayout: function() { return (this.mobile && this.rotationLayout === 'table') ? 'card' : this.rotationLayout; },
      rotationViewRows: function() { return this.isRotationView ? this.currentData : []; },
      rotationAnchorForView: function() { return this.anchorForView(this.currentTable); },
      rotationRangeForView: function() { return this.rangeForView(this.currentTable); },
      // rotateEvery UI decomposition: numeric "every n periods" part + the "alternate each cycle" flag.
      rotationEveryForView: function() {
        var arr = this.rotateEveryForView(this.currentTable);
        for (var i = 0; i < arr.length; i++) { if (typeof arr[i] === 'number' && arr[i] > 0) return arr[i]; }
        return 0;
      },
      rotationCycleForView: function() { return this.rotateEveryForView(this.currentTable).indexOf('cycle') >= 0; },
      rotationRotateEveryOverridden: function() { return !!((this.appConfig && this.appConfig.rotationRotateEvery) || {})[this.currentTable]; },
      // Not while a search is active. Reorder moves a row relative to its NEIGHBOURS in the rendered
      // list, and with rows hidden that list is not the real order -- the arrows would silently
      // renumber around rows the person cannot see.
      isReorderable: function() { var t = this.currentTable; return !!(SCHEMA[t] && SCHEMA[t].reorderable && this.isDataView && !this.viewingArchive && this.canMutateRows && !this.searchTerm); },
      navConfig: function() { return (this.schemaData && this.schemaData.nav) || null; },
      navLayout: function() { return this.navLayoutOverride || (this.navConfig && this.navConfig.layout) || 'drawer'; },
      currentPage: function() {
        var v = VIEWS[this.currentTable];
        if (!v || typeof v.markdown !== 'string') return null;
        var body = this.pageCache[this.currentTable];
        return { markdown: body != null ? body : v.markdown };
      },
      pageBlocks: function() {
        var p = this.currentPage;
        return p ? this.mdBlocks(p.markdown, this.currentTable) : [];
      },
      // Identify the signed-in user in the user list. Firestore rules key _meta/users by the
      // login email (the map KEY), so we match on `key` first (case-insensitive), falling back to
      // the legacy `addr`/user field for older records. Returns null when not found.
      currentUserEntry: function() {
        var email = (this.currentUserEmail || '').toLowerCase();
        if (!email) return null;
        return this.userList.find(function(x) {
          return (x.key || '').toLowerCase() === email || (x.addr || '').toLowerCase() === email;
        }) || null;
      },
      currentUserRole: function() {
        if (!this.usersLoaded) return null;
        if (this.selfUnregistered) return null;    // users exist but not us -> no role (fail closed)
        if (!this.userList.length) return 'admin'; // bootstrap
        var u = this.currentUserEntry;
        return u ? u.role : null;
      },
      isAdmin: function() {
        if (!this.usersLoaded) return true; // default until loaded
        if (this.selfUnregistered) return false;   // not a registered user
        if (!this.userList.length) return true; // no users = bootstrap
        return this.currentUserRole === 'admin';
      },
      // True once users exist and are loaded but the signed-in user matches no record -> Firestore
      // will deny every read. Surface a clear notice instead of a misleading empty-but-full nav.
      isUnregisteredUser: function() {
        if (this.selfUnregistered) return true;
        return this.usersLoaded && this.userList.length > 0 && !this.currentUserEntry;
      },
      // Stable display order for the Settings user table. userList is rebuilt from Firestore map-key
      // iteration order on every loadUsers(), which is unstable — sorting by key here keeps rows put
      // across role/tables edits (the key is unchanged) instead of jumping around.
      sortedUserList: function() {
        return this.userList.slice().sort(function(a, b) {
          return (a.key || '').toLowerCase().localeCompare((b.key || '').toLowerCase());
        });
      },
      // Tables I may SEE (grant mode 'r' or 'rw'). This is the visibility set every nav/load/list gate
      // uses; the write gates use userWritableTables below. null = unrestricted, [] = none.
      userAllowedTables: function() {
        if (this.selfUnregistered) return [];   // FAIL CLOSED: users exist but we're not one
        if (this.isAdmin) return null; // null = unrestricted
        var u = this.currentUserEntry;
        if (!u) return [];             // FAIL CLOSED: registered users exist but we're not one -> no access
        // Pass the reader's null (= tables:'all', unrestricted) THROUGH. A `|| []` here would collapse
        // that sentinel into "no tables" and fail an unrestricted non-admin closed -- the no-grant
        // shapes already come back as [] from the reader, so there is nothing for a fallback to catch.
        return AccessFeatures.readableTables(u.tables);
      },
      // Tables I may WRITE — the 'rw' subset. A read-only grant appears here as absent, which is what
      // turns its views read-only and (on an owner-column table) hands the row back to self-service.
      userWritableTables: function() {
        if (this.selfUnregistered) return [];
        if (this.isAdmin) return null;
        var u = this.currentUserEntry;
        if (!u) return [];
        return AccessFeatures.writableTables(u.tables);   // null = unrestricted; see userAllowedTables
      },
      visibleLists: function() {
        if (this.isAdmin) return this.listsCache;
        // Find tables this user can access
        var u = this.currentUserEntry;
        if (!u) return {};
        // Through the shared reader, not the raw value: a grant may be 'all', a legacy array or a
        // { table: mode } MAP, and only readableTables() normalizes all three. Reading `.tables` here
        // directly meant a map-shaped grant reached .forEach and threw.
        var userTables = AccessFeatures.readableTables(u.tables) || Object.keys(SCHEMA);
        // Find which lists are used by accessible tables
        var allowedLists = {};
        userTables.forEach(function(t) {
          if (!SCHEMA[t]) return;
          var cols = SCHEMA[t].columns || {};
          Object.keys(cols).forEach(function(c) {
            var def = cols[c];
            var listName = (typeof def === 'object' && def.list) ? def.list : null;
            if (listName) allowedLists[listName] = true;
          });
        });
        var result = {};
        var cache = this.listsCache;
        Object.keys(cache).forEach(function(name) { if (allowedLists[name]) result[name] = cache[name]; });
        return result;
      },
      grantFeatureChips: function() {
        // Permission chips: each as { id, label }. Tables use the `tab.<id>` translation key, views
        // use `view.<id>` (matching nav); fall back to the bare id when no translation exists (t()
        // returns the key on a miss, so we compare against it).
        var self = this, sd = this.schemaData, str = this.strings; // touch schema + strings for reactivity
        void sd; void str;
        var chips = [{ id: 'all', label: this.t('settings.all') }];
        grantFeatures().forEach(function(f) {
          var key = (f.view ? 'view.' : 'tab.') + f.id;
          var s = self.t(key);
          chips.push({ id: f.id, label: (s && s !== key) ? s : f.id });
        });
        return chips;
      },
      // Same chips for the view-only column, minus the 'all' sentinel — "view everything" is what a full
      // access grant in the edit column already means, so offering it here would just be a second way to
      // say it (and an ambiguous one, since it can't downgrade an existing rw grant to r).
      viewGrantChips: function() { return this.grantFeatureChips.filter(function(c) { return c.id !== 'all'; }); },
      // Role dropdown options for the Users table: translatable label (role.<id>, shows the raw key
      // when untranslated) + the stored role VALUE (unchanged, so setUserRole keeps writing
      // 'admin'/'editor'/'viewer').
      roleItems: function() {
        var self = this, str = this.strings; void str; // touch strings for reactivity
        return ['admin', 'editor', 'viewer'].map(function(r) {
          return { value: r, title: self.t('role.' + r) };
        });
      },
      // Every database this browser profile holds, active one flagged. Storage that nothing can list
      // is storage nobody can reach: before the per-database layout there was only ever one, so there
      // was nothing to show — now there can be several and the only other way back to one is to still
      // have its shared link.
      knownDatabases: function() {
        var active = Databases.activeKey();
        return Databases.list().map(function(d) {
          return { key: d.key, label: d.label, mode: d.mode, active: d.key === active };
        });
      },
      hasFirebaseConfig: function() {
        if (window.FIREBASE_CONFIG) return true;
        var c = Databases.config('firebase');
        return !!(c && c.apiKey);
      },
      shareLink: function() {
        var base = location.origin + location.pathname;
        var mode = localStorage.getItem('app_mode');
        if (mode === 'firebase') {
          var c = Databases.config('firebase');
          if (!c) return base;
          // Only emit d= when authDomain is NOT the default <projectId>.firebaseapp.com (derived on load).
          var d = (c.authDomain && c.authDomain !== c.projectId + '.firebaseapp.com') ? '&d=' + encodeURIComponent(c.authDomain) : '';
          return base + '?mode=firebase&k=' + encodeURIComponent(c.apiKey) + d + '&p=' + encodeURIComponent(c.projectId);
        }
        if (mode === 'supabase') {
          var sc = Databases.config('supabase');
          if (!sc) return base;
          return base + '?mode=supabase&url=' + encodeURIComponent(sc.url) + '&key=' + encodeURIComponent(sc.anonKey);
        }
        // Dev-server mode is loopback-only: there is nothing shareable about the link.
        return base;
      },
      currentConfig: function() { return VIEWS[this.currentTable] || SCHEMA[this.currentTable] || {}; },
      // Printing is opt-in via "printable": "view" (toolbar), "cards" (per-card), or ["view","cards"] (both). Off by default.
      canPrintView: function() { var p = this.currentConfig.printable; return (this.isDataView || this.isRotationView) && (p === 'view' || (Array.isArray(p) && p.indexOf('view') >= 0)); },
      canPrintCard: function() { var p = this.currentConfig.printable; return this.isDataView && (p === 'cards' || (Array.isArray(p) && p.indexOf('cards') >= 0)); },
      isUnionView: function() { return false; },
      useCardLayout: function() {
        var layout = this.currentConfig.layout;
        if (layout === 'card' || layout === 'list') return true;
        if (layout === 'table') return false;
        if (this.windowWidth < 600) return true;
        // declaredCols, NOT visibleCols: visibleCols applies hideEmpty only in table mode and so reads
        // this computed back — see declaredCols for the cycle that split fixes.
        var needed = this.declaredCols.length * 130 + 100;
        return needed > (this.windowWidth - 72);
      },
      useListLayout: function() { return this.currentConfig.layout === 'list'; },
      // Add is offered wherever rows may be mutated, INCLUDING the read-only `list` layout: a table can
      // declare layout:'list' as its only presentation, so gating Add on an editable layout would leave
      // such a table with no way to create a row at all. The row lands and saves; it is just not
      // editable from a list (see the `layout` note in SCHEMA.md — use table/card for data entry).
      identityMissing: function() { return this.viewIdentityMissing(this.currentTable); },
      canAddRows: function() { return this.canMutateRows && !this.identityMissing; },
      isReadonlyView: function() { return this.viewAddBlocked(this.currentTable) || (!this.currentSelfService && this.viewReadonly(this.currentTable)); },
      embedConfigs: function() {
        var self = this;
        var cfg = this.currentConfig;
        // Extract inline embeds from columns array (dead `text` entries are stripped at load)
        var embeds = [];
        var lastCol = null;
        var cols = cfg.columns;
        if (Array.isArray(cols)) {
          cols.forEach(function(c) {
            if (isViewEmbed(c)) { embeds.push(Object.assign({ afterColumn: lastCol }, VIEWS[c.view] || {}, c)); } // named-view embed (its sources/columns + entry overrides)
            else if (isEmbed(c)) { embeds.push(Object.assign({ afterColumn: lastCol }, c)); }
            else { lastCol = colName(c); }
          });
        }
        // Drop embeds whose sources aren't reachable. Self-service counts, as it does for the nav gate
        // and the preload: without it a grantless member opened a view they were entitled to and its
        // inline embeds silently vanished, even though the rows behind them were theirs to read.
        return embeds.filter(function(e) {
          return (e.sources || []).every(function(s) { return self.canReachTable(s); });
        });
      },
      embedItems: function() { var self = this; return this.embedConfigs.map(function(cfg) { return self.resolveEmbed(cfg); }); },
      hasMaster: function() {
        var table = this.currentTable;
        var v = VIEWS[table];
        if (v) {
          // A view whose every source table is a mirror DETAIL (syncFrom a master) inherits that master:
          // its rows are cloned/archived/deleted with the master (musiikki/tulkit ride kokoukset), so it
          // must NOT offer independent add/archive/delete — only the master (the meeting) mutates the
          // cluster. A view mixing in a master source (e.g. ohjelma over kokoukset) stays master-less.
          var srcs = v.sources || [];
          return srcs.length > 0 && srcs.every(function(s) { return !!getTableMirrorSource(SCHEMA, s); });
        }
        return !!getTableMirrorSource(SCHEMA, table);
      },
      hasArchive: function() {
        if (VIEWS[this.currentTable] && VIEWS[this.currentTable].hideArchive) return false;
        if (VIEWS[this.currentTable]) return (VIEWS[this.currentTable].sources || []).some(function(s) { return SCHEMA[s] && SCHEMA[s].archivable; });
        return SCHEMA[this.currentTable] && SCHEMA[this.currentTable].archivable;
      },
      // Add/delete/archive/restore fan out across the whole mirror cluster; only allow if the user can WRITE
      // every table in it (a read-only grant on any member of the cluster closes the whole control).
      canMutateCurrent: function() {
        var allowed = this.userWritableTables;
        if (!allowed) return true; // admin / unrestricted
        var view = VIEWS[this.currentTable];
        // Views go through writeBaseFor (which answers with a rotation's rosters); a bare table is itself,
        // unconditionally — keeping the old fallback so a non-schema id can't slip through as "nothing to write".
        var base = view ? this.writeBaseFor(this.currentTable) : [this.currentTable];
        var cluster = withMirrors(base); // full mirror cluster (both directions)
        return cluster.every(function(t) { return allowed.indexOf(t) >= 0; });
      },
      // Shared gate for all row-level mutation controls (add/delete/archive/restore). A self-service
      // table (owner column, no grant) is add-enabled for a member; per-row edit/delete is then gated on
      // ownership by canMutateRow / cellReadonly (this only opens the ADD button + row-control column).
      canMutateRows: function() { return !this.hasMaster && !this.isReadonlyView && (this.canMutateCurrent || this.currentSelfService); },
      // --- Self-service (owner-column tables): a registered member without a table grant may add their
      // own rows and edit/delete ONLY those. Mirrors the RSVP permission model into the plain data grid;
      // Firestore rules are the real enforcement (see _meta/ownerTables), this is the matching UI. ---
      myEmailLc: function() { return (this.currentUserEmail || '').toLowerCase(); },
      // My profile display name — the identity `@me` filters resolve to and `defaultFrom: "@me"` stamps.
      // '' when I haven't set one; each caller decides what that means (a filter matches nothing, a
      // stamp writes blank).
      myDisplayName: function() { return ((this.myProfile && this.myProfile.name) || '').trim(); },
      // The underlying owner table for the current view/table (a self-service view has one source).
      selfServeTable: function() { var v = VIEWS[this.currentTable]; return v ? (v.sources || [])[0] : this.currentTable; },
      // Is the current table/view self-serviceable by me right now?
      currentSelfService: function() {
        var v = VIEWS[this.currentTable];
        if (v) { var s = v.sources || []; return s.length === 1 && this.canSelfServe(s[0]); }
        return this.canSelfServe(this.currentTable);
      },
      // List values are editable only by recognized writable roles (admin/editor); visibleLists already scopes WHICH lists
      // Editing a list is editing SHARED VOCABULARY — member names, the status words every view resolves
      // through list.<list>.<value>, a board's lane labels — so it is ADMIN-ONLY, and a rename there
      // rewrites every stored row that used the old value. Individual lists opt out via the schema's
      // `userWritableLists`: those are free-form vocabularies an ordinary user maintains as they work
      // (a shopping list), and for them any REGISTERED user may add, rename and reorder values.
      userWritableLists: function() {
        return BackendHelpers.userWritableListsOf(this.schemaData || {}).lists;
      },
      // True when at least one list is editable — the Lists editor's own affordances are per list
      // (canEditList), this only answers "is any of this editable at all".
      canEditLists: function() { return this.isAdmin || this.userWritableLists.length > 0; },
      // Doc-view bodies are writable by admins/editors (mirrors the _pages__active rule / dev-server
      // gate); viewers get a read-only page with no Edit button instead of a save that would 403.
      canEditPages: function() { return this.isAdmin || this.currentUserRole === 'editor'; },
      // The columns the SCHEMA declares for this screen, before any data-dependent filtering. Split out of
      // visibleCols to break a genuine dependency cycle: the auto card/table decision is made from how
      // many columns there are, while hideEmpty drops columns only in table mode — so useCardLayout wanted
      // visibleCols and visibleCols wanted useCardLayout. Reading either one first re-entered the other
      // mid-evaluation; whichever way Vue resolved that, one of them saw a bogus value, and entering
      // through visibleCols recursed until the stack blew. Deciding layout from the DECLARED count is also
      // the more stable rule: the layout no longer flips as rows are added or emptied.
      declaredCols: function() {
        var self = this;
        if (!this.currentTable) return [];
        var view = VIEWS[this.currentTable];
        if (view) return (view.columns || []).filter(function(c) { return !isEmbed(c) && !isViewEmbed(c); }).map(function(c) { return colName(c); });
        return getColumns(this.currentTable).filter(function(c) {
          if (c === 'id') return false;
          var def = SCHEMA[self.currentTable].columns[c];
          return !(def && typeof def === 'object' && def.hidden);
        });
      },
      visibleCols: function() {
        var self = this;
        var cols = this.declaredCols;
        // hideEmpty (table mode): drop a column when empty across all rows -- view default, overridable per-column via {name, hideEmpty}
        if (!this.useCardLayout && this.sortedData.length) {
          var data = this.sortedData;
          cols = cols.filter(function(c) { return !self.colHideEmpty(c) || data.some(function(r) { return r[c]; }); });
        }
        return cols;
      },
      // Table mode: the visible columns that hold no value in any row, by the same emptiness test
      // hideEmpty uses above. These are NOT dropped — an empty column is exactly where the first value
      // gets typed, and hideEmpty is the opt-in for removing one outright. They are only marked, so the
      // stylesheet can stop them claiming a proportional share of the table's spare width (.col-empty).
      emptyCols: function() {
        var out = {}, data = this.sortedData;
        if (this.useCardLayout || !data.length) return out;
        this.visibleCols.forEach(function(c) {
          if (!data.some(function(r) { return r[c]; })) out[c] = true;
        });
        return out;
      },
      tableHeaders: function() {
        var self = this;
        var hdrs = this.visibleCols.map(function(c) { return { title: self.t('field.' + c) || c, key: c, sortable: true }; });
        if (this.isUnionView) hdrs.push({ title: self.t('field.source'), key: '_source', sortable: true });
        hdrs.push({ title: '', key: '_actions', sortable: false, width: '100px' });
        return hdrs;
      },
      // Delegates to Rows.sortByCol -> Rows.compareValues, the one comparator shared with embed
      // defaultSort and the rsvp/pivot views, so every sortable surface orders identically.
      // null when the view does not ask for a search box; [] means "every column the row carries".
      searchCols: function() { return Rows.searchColumns(this.currentConfig || {}); },
      searchable: function() { return this.searchCols !== null; },
      // Rows the term hides. Shown beside the box, because a filtered list with no count looks like a
      // list that has lost rows.
      // "3 / 12" -- how many rows the term is showing, out of how many the view holds. This used to be
      // the bare count of rows HIDDEN, which is a number with no unit: looking at a "7" beside a search
      // box, nobody can tell whether seven rows matched or seven were hidden. Two numbers and a slash
      // say which is which, and need no translating.
      searchCount: function() {
        if (!this.searchable || !this.searchTerm) return '';
        var shown = Rows.searchRows(this.currentData, this.searchTerm, this.searchCols).length;
        return shown + ' / ' + this.currentData.length;
      },
      sortedData: function() {
        // Search narrows what the grid renders; it does not touch currentData, so nothing that WRITES
        // (add, archive, the mirror cascade) sees a filtered list.
        var rows = this.searchable && this.searchTerm
          ? Rows.searchRows(this.currentData, this.searchTerm, this.searchCols)
          : this.currentData;
        if (!this.sortCol) return rows.slice();
        var _dep = this.listsCache;   // list-backed order is read through the runtime-bound cache
        return sortByCol(rows, this.sortCol, VIEWS[this.currentTable], this.sortAsc);
      },
      staticTranslationKeys: function() {
        return ['app.title', 'btn.add', 'btn.show_active', 'btn.show_archived', 'btn.more',
         'btn.edit', 'btn.preview', 'btn.save', 'btn.search', 'btn.export_ics', 'timeline.empty', 'col.switch_list',
         'img.replace', 'img.upload', 'img.remove', 'img.url',
         // View background images (Settings -> Backgrounds); bg.fit_* label the `fit` modes in bgFitItems.
         'bg.upload', 'bg.replace', 'bg.remove', 'bg.restore', 'bg.opacity', 'bg.position', 'bg.width', 'bg.fixed',
         'bg.fit', 'bg.fit_cover', 'bg.fit_contain', 'bg.fit_tile', 'bg.fit_width',
         'msg.saved', 'msg.save_failed', 'msg.upload_failed', 'msg.choose_image', 'msg.image_too_large', 'msg.image_read_failed', 'msg.image_invalid', 'msg.image_process_failed',
         'msg.row_added', 'msg.no_identity', 'msg.deleted', 'msg.restored', 'msg.renamed', 'msg.archived', 'msg.copied', 'msg.exported', 'msg.export_incomplete', 'msg.form_submitted', 'msg.form_incomplete', 'msg.form_required', 'msg.synced', 'msg.sync_failed',
         'msg.load_failed', 'msg.request_failed', 'msg.approve_failed', 'msg.import_complete',
         'msg.group_added', 'msg.item_added', 'msg.translation_saved', 'msg.language_added', 'msg.language_renamed', 'msg.language_exists',
         'msg.sign_in_respond', 'msg.registered_admin', 'msg.invalid_json', 'msg.invalid_color', 'msg.invalid_config', 'msg.paste_hex', 'msg.schema_error',
         'msg.server_error', 'msg.import_blocked', 'msg.import_error', 'msg.palette_applied', 'msg.error', 'msg.locked',
         'pivot.total', 'pivot.empty',
         'stats.empty',
         'board.move_to', 'board.unassigned', 'board.add_in_lane', 'board.edit', 'board.archive', 'board.delete', 'board.confirm_delete',
         'tab.languages', 'tab.lookup', 'tab.settings', 'tab.ref_data', 'tab.lists',
         'field.source', 'field.key', 'field.translation',
         'settings.import_export', 'settings.share', 'settings.export', 'settings.import',
         'settings.examples', 'settings.examples_update', 'settings.examples_reinstall',
         'settings.reset', 'settings.confirm_reset', 'settings.tabs_nav', 'settings.user_access', 'settings.user_access_title',
         'settings.theme', 'settings.theme_palette', 'settings.theme_reset',   // ui.html calls t() for these; leaving them out hid the Theme labels from the Languages editor, so no language could translate them
         'settings.backgrounds',
         'settings.databases', 'settings.databases_hint', 'settings.switch', 'settings.forget',
         'settings.user_id', 'settings.name', 'settings.role', 'settings.tables', 'settings.tables_view', 'settings.add_user', 'settings.all',
         'role.admin', 'role.editor', 'role.viewer',
         'settings.rotation_anchor', 'settings.rotation_from', 'settings.rotation_periods', 'settings.rotation_every', 'settings.rotation_cycle', 'btn.today', 'btn.reset',
         'cal.today', 'cal.month', 'cal.week', 'cal.list', 'cal.undated', 'cal.no_events', 'cal.items', 'cal.add_on_day',
         'rsvp.date', 'rsvp.title', 'rsvp.your_response', 'rsvp.responses', 'rsvp.who', 'rsvp.none',
         'access.request_access', 'access.request_sent', 'access.your_name', 'access.pending_requests', 'access.approve', 'access.deny', 'access.name_required',
         'profile.title', 'profile.email', 'profile.your_name', 'profile.share_name', 'profile.picture',
         'period.this_week', 'period.weeks_ago', 'period.current',
         'list.link_user', 'list.unlink_user', 'list.locked_value', 'list.locked_group',
         'lang.app', 'lang.schema', 'lang.lists'].sort();
      },
      schemaTranslationKeys: function() {
        var keys = [];
        var schema = this.schemaData || {};
        var tables = schema.tables || {};
        for (var tbl in tables) {
          keys.push('tab.' + tbl);
          var cols = tables[tbl].columns || {};
          for (var c in cols) {
            if (_untranslatableCol(cols, c)) continue;
            keys.push('field.' + c);
          }
        }
        // List-value translation keys come from two places:
        //  (1) filter/conditional-pinned values (lockedListValues) — always translatable; schema logic keys on
        //      them, so their labels must be stable/localizable regardless of opt-in.
        //  (2) lists explicitly opted in via top-level `schema.translatableLists: [name,...]` — expose ALL of
        //      each named list's current values. This is how a controlled vocabulary (status/organisation/…)
        //      is made fully translatable while open-data lists (member names, etc.) are left out. See SCHEMA.md.
        var lists = this.listsCache || {};
        var lockedVals = this.lockedListValues;
        for (var ln in lockedVals) {
          for (var lv in lockedVals[ln]) { keys.push('list.' + ln + '.' + lv); }
        }
        var dc = this.dataCache || {};
        (schema.translatableLists || []).forEach(function(name) {
          // A name can be BOTH a list and a lookup TABLE, and then both are offered -- the keys are
          // deduped below. This used to `return` after the list, so a one-value leftover hid a
          // hundred-row catalogue: a list survives the schema that replaced it (nothing prunes one),
          // and a filter-pinned ref value seeds a list under the TABLE's own name, so the collision is
          // not exotic. getListOptions resolves the same clash the other way round (a lookup table wins
          // over a same-named list), which is how the Languages editor came to disagree with the picker
          // it fills in: the dropdown offered the catalogue, the editor offered one stray value.
          (lists[name] || []).forEach(function(val) { keys.push('list.' + name + '.' + val); });
          // A lookup/ref TABLE name is also accepted: expose the distinct values across its non-system columns
          // so a 2-D ref lane (its group + value dimensions) is fully translatable via the same list.<name>.<value> keys.
          if (SCHEMA[name]) {
            var rcols = SCHEMA[name].columns || {}, seenv = {};
            (dc[name] || []).forEach(function(r) { for (var c in r) { if (_untranslatableValueCol(rcols, c)) continue; var v = r[c]; if (v && !seenv[v]) { seenv[v] = 1; keys.push('list.' + name + '.' + v); } } });
          }
        });
        var views = schema.views || {};
        function addViewKeys(arr) {
          (arr || []).forEach(function(v) {
            if (v.name) {
              keys.push('view.' + v.name);
              if (v.rotation) {                                                      // rotation: cols live under rotationView.slots/columns, not v.columns
                keys.push('field.period');
                (v.rotation.slots || []).forEach(function(a) { keys.push('field.' + a); });
                (v.rotation.columns || []).forEach(function(c) { keys.push('field.' + colName(c)); });
              }
              if (v.board && v.board.lane) keys.push('field.' + v.board.lane);       // board: lane header comes from the lane column
              if (v.board) (v.board.laneGroups || []).forEach(function(g) { if (g && g.label) keys.push('board.group.' + g.label); });  // board: phase-header labels are translatable

              if (v.pivot) {                                                         // pivot: axis headers come from row/column, not v.columns
                if (v.pivot.row) keys.push('field.' + v.pivot.row);
                if (v.pivot.column) keys.push('field.' + v.pivot.column);
              }
              if (v.groupBy && v.groupBy.column) keys.push('field.' + v.groupBy.column);  // aggregate/leaderboard group column
              if (v.stats) {                                                         // stats: tile captions are authored, not column-derived
                // An explicit tile's `label` is the ONLY user-visible string in this kind, and it is
                // resolved with tOr -- so a key works and prose works. Collect it either way: an author
                // who wrote prose still sees it offered in the Languages editor (which is how they
                // discover it can be translated at all), and one who wrote a key must see it or the key
                // renders raw with nothing on screen saying where to fix it. A perRow tile's caption
                // comes from a COLUMN, so it is already covered by field.<col> below.
                // A goal LADDER names its levels ("Bronze"/"Silver"/"Gold"), and those render on the
                // tile as a badge -- so they are user-visible text and belong here too. A ladder can be
                // set view-wide, per tile, or on perRow, so all three are swept.
                var stTier = function(goal) {
                  if (Array.isArray(goal)) goal.forEach(function(e) { if (e && typeof e === 'object' && e.label) keys.push(e.label); });
                };
                stTier(v.stats.goal);
                (v.stats.tiles || []).forEach(function(t) { if (t && t.label) keys.push(t.label); if (t) stTier(t.goal); });
                if (v.stats.perRow) {
                  if (v.stats.perRow.label) keys.push('field.' + v.stats.perRow.label);
                  if (v.stats.perRow.value) keys.push('field.' + v.stats.perRow.value);
                  stTier(v.stats.perRow.goal);
                }
              }
              (v.columns || []).forEach(function(c) {
                if (typeof c !== 'object') { keys.push('field.' + c); return; }          // plain column name
                if (c.sources && c.columns) {                                            // inline embed
                  c.columns.forEach(function(ec) { keys.push('field.' + colName(ec)); });
                  return;
                }
                keys.push('field.' + colName(c));                                        // conditional ({name,when}) / computed column
              });
              if (v.views) addViewKeys(v.views);
            }
          });
        }
        addViewKeys(Array.isArray(views) ? views : Object.values(views));
        // Doc-view markdown {{t:key}} tokens are translatable too
        var docs = [];
        for (var vn in VIEWS) {
          if (typeof VIEWS[vn].markdown === 'string') docs.push(VIEWS[vn].markdown);
          // Also scan inline embed markdowns in columns
          (VIEWS[vn].columns || []).forEach(function(c) { if (c && typeof c === 'object' && typeof c.markdown === 'string') docs.push(c.markdown); });
        }
        for (var dn in this.pageCache) { docs.push(this.pageCache[dn] || ''); }
        docs.forEach(function(md) { var m, re = /\{\{\s*t\s*:\s*([^\s{}:]+)\s*\}\}/g; while ((m = re.exec(String(md || '')))) keys.push(m[1]); });
        var seen = {};
        return keys.filter(function(k) { if (seen[k]) return false; seen[k] = true; return true; }).sort();
      },
      // The Languages editor splits schema keys into two collapsible sections so the `list.<list>.<value>`
      // value keys (e.g. status/calling-state labels) don't get buried among the field/view/tab keys:
      // "Schema" shows everything except list values, "Lists" shows only them. Both derive from
      // schemaTranslationKeys, which stays the full set used to seed a new language (translationKeys).
      schemaTranslationKeysNonList: function() { return this.schemaTranslationKeys.filter(function(k) { return k.indexOf('list.') !== 0; }); },
      listTranslationKeys: function() { return this.schemaTranslationKeys.filter(function(k) { return k.indexOf('list.') === 0; }); },
      translationKeys: function() {
        var seen = {};
        return this.staticTranslationKeys.concat(this.schemaTranslationKeys).filter(function(k) { if (seen[k]) return false; seen[k] = true; return true; });
      },
      EN: function() { return this.strings; },
      // The configured default is only honoured if that language still EXISTS. A schema can outlive the
      // language it names — rename a language's code (or import a schema whose default names a code this
      // database doesn't have) and the old value strands the whole UI on raw keys, because the base
      // strings load from a translations doc that isn't there. Falling back to a real language keeps the
      // app readable; the stale name is a schema edit to make, not a reason to show nothing.
      defaultLanguage: function() {
        var codes = (this.languages || []).map(function(l) { return l.code; });
        var configured = this.schemaData && this.schemaData.defaultLanguage;
        if (configured && codes.indexOf(configured) >= 0) return configured;
        return codes.length ? codes[0] : null;
      },
      refTables: function() {
        var all = Object.keys(SCHEMA).filter(function(k) { return SCHEMA[k].isLookup; });
        var allowed = this.userAllowedTables;
        if (!allowed) return all; // admin / unrestricted
        var used = {};
        allowed.forEach(function(t) {
          var cols = (SCHEMA[t] && SCHEMA[t].columns) || {};
          for (var c in cols) { var d = cols[c]; if (d && typeof d === 'object' && d.type === 'ref' && d.table) used[d.table] = true; }
        });
        return all.filter(function(k) { return used[k]; });
      },
      // The Lookup editor had NO permission gate: any user who could SEE a ref table got an editable
      // grid, so a member holding `ref_rewards: 'r'` was offered the reward catalogue to edit and the
      // write was then refused by the server with nothing said. Reference data is exactly what an 'r'
      // grant is for — see it, don't change it — so the editor follows the same viewReadonly gate the
      // data grid does (config `readonly`, viewer role, or no rw grant on the table).
      canEditCurrentRef: function() { return !!this.currentRefTable && !this.viewReadonly(this.currentRefTable); },
      refTableCols: function() {
        if (!this.currentRefTable) return [];
        var cols = (SCHEMA[this.currentRefTable] && SCHEMA[this.currentRefTable].columns) || {};
        // Exclude hidden columns (e.g. a reorderable table's `position`) so they don't show as editable cells
        // OR count toward isHierarchicalRef's 2-column test.
        return getColumns(this.currentRefTable).filter(function(c) {
          if (c === 'id' || c === 'created_at' || c === 'updated_at') return false;
          var d = cols[c]; return !(d && typeof d === 'object' && d.hidden);
        });
      },
      // A ref/lookup table opted into `reorderable` orders its rows by a `position` column — the same
      // convention as a reorderable data table — so the lookup editor's arrows and the board's ref-lane order
      // are stable across edits (instead of drifting with SQLite insertion order).
      refReorderable: function() { return !!(this.currentRefTable && SCHEMA[this.currentRefTable] && SCHEMA[this.currentRefTable].reorderable); },
      refTableData: function() {
        if (!this.currentRefTable) return [];
        var rows = this.dataCache[this.currentRefTable] || [];
        if (this.refReorderable) rows = rows.slice().sort(function(a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0); });
        return rows;
      },
      isHierarchicalRef: function() {
        return this.refTableCols.length === 2;
      },
      refParentCol: function() { return this.refTableCols[0]; },
      refChildCol: function() { return this.refTableCols[1]; },
      // Values a schema filter/conditional depends on — locked (can't be deleted/renamed) in the Lookup
      // editor. A CACHED computed (was a method): isLockedValue is called ~3x per list item, and this
      // rebuild is O(views x columns x tables) — recomputing it per call made the Lookup view crawl on
      // large schemas. Recomputes only when schemaData changes (the reactive dep + VIEWS rebuild).
      // Values a schema filter pins: non-deletable in the Lists UI, and each gets a list.<list>.<value>
      // translation key. Shares forEachFilterListValue (schema-loader) with _seedListValues, so the
      // set that gets seeded is exactly the set that gets locked -- SCHEMA.md pairs the two.
      lockedListValues: function() {
        var locked = {};
        var _dep = this.schemaData; // reactive dependency trigger
        forEachFilterListValue(function(ln, val) { (locked[ln] || (locked[ln] = {}))[val] = true; });
        return locked;
      },
      refGroupedData: function() {
        if (!this.isHierarchicalRef) return {};
        var parentCol = this.refParentCol;
        var data = this.refTableData;
        var groups = {};
        data.forEach(function(row) {
          var key = row[parentCol] || '';
          if (!groups[key]) groups[key] = [];
          groups[key].push(row);
        });
        return groups;
      }
    },

    methods: {
      t: function(key) { return this.strings[key] || key; },
      // Only for keys whose fallback is the DATA the key labels — a column/view/list value, which reads
      // far better raw ("chore_name") than as a key ("field.chore_name"). Static UI prose must use t(),
      // so an untranslated string shows as its key and is visibly a gap rather than silently English.
      tOr: function(key, fallback) { return this.strings[key] || fallback; },

      toggleTheme: function() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        this.$vuetify.theme.global.name = this.theme;
        localStorage.setItem('app_theme', this.theme);
        this._updateManifest();
      },

      notify: function(text) { this.snackText = text; this.snackbar = true; },
      setNavLayout: function(v) { this.navLayoutOverride = v; localStorage.setItem('app_nav_layout', v); },

      // A schema that was upgraded on load is saved back ONCE, so the chain stops re-running and the
      // next migration starts from a known version. Deliberately narrow:
      //   - only if something was actually applied, so a current schema is never rewritten;
      //   - only for an admin, because every write layer restricts the schema document to admins. The
      //     alternative is a refused write on every member's boot, which is how the shared-list seeding
      //     bug arrived as an unhandled rejection;
      //   - failure is not fatal. The schema in memory is already migrated, so the app runs correctly
      //     either way; the only cost of not persisting is that the chain runs again next time.
      _writeBackMigratedSchema: function() {
        var m = (typeof window !== 'undefined') && window._schemaMigration;
        if (!m || !this.isAdmin || !backend.saveSchema || !this.schemaData) return Promise.resolve();
        window._schemaMigration = null;                 // once per session, even if the save fails
        var self = this;
        return Promise.resolve(backend.saveSchema(this.schemaData))
          .then(function() { return self._migrateTranslations(m.renames); })
          .then(function() { console.info('schema migrated to v' + m.to + ': ' + m.applied.join('; ')); })
          .catch(function() { self.notify(self.t('msg.save_failed')); });
      },

      // Move stored translations with the schema. Translation keys are generated per column as
      // `field.<col>`, so a migration that changes a column's identity orphans every string filed under
      // the old key -- in every language at once, showing raw keys to exactly the people least able to
      // work out why. This runs as a step OF the write-back rather than as a follow-up somebody has to
      // remember, which is the only version of it that stays true.
      //
      // After the schema, deliberately: if the save is refused there is nothing to move to.
      // Per-language failures are swallowed -- one language that cannot be written must not abandon the
      // rest, and the chain re-runs next session because the schema write-back is what clears the flag.
      _migrateTranslations: function(renames) {
        if (!renames || !renames.length || typeof Migrations === 'undefined') return Promise.resolve();
        var self = this;
        return (self.languages || []).reduce(function(chain, lang) {
          var code = lang && lang.code;
          if (!code) return chain;
          return chain.then(function() {
            return Promise.resolve(backend.getTranslations(code)).then(function(t) {
              var patch = Migrations.renamePatch(t, renames);
              if (!Object.keys(patch).length) return null;
              return backend.updateTranslations(code, patch);
            }).catch(function() {});
          });
        }, Promise.resolve());
      },

      // Setup
      completeLocalSetup: function() {
        localStorage.setItem('app_folder', 'local');
        localStorage.setItem('app_mode', 'local');
        this.mode = 'local';
        this.showSetup = false;
        this.startApp();
      },
      // Browser-local Postgres. Nothing to validate and nothing to reach: the identity is stored, the
      // mode is stored, and the reload boots index.html straight into backend-local-pglite.js, which
      // brings up the WASM database. `app_folder` is set for the same reason the other modes set it —
      // init() reads it as "this app has been configured".
      completeLocalPgliteSetup: function() {
        var email = String(this.pgliteUserInput || '').trim().toLowerCase() || 'you@local';
        localStorage.setItem('pglite_user', email);
        localStorage.setItem('app_folder', 'pglite');
        localStorage.setItem('app_mode', 'pglite');
        location.reload();   // reload so index.html loads storage-pglite + backend-kv for mode=pglite
      },
      backToSetup: function() {
        this.setupStep = null;
        try { localStorage.removeItem('app_mode'); } catch (e) {}
      },

      // --- Browser-local database: size, and whether the browser may evict it -------------------------
      // Only meaningful in `pglite` mode; harmless elsewhere (every other backend keeps its data on a
      // server, where none of this applies).
      refreshLocalStore: function() {
        var self = this;
        if (!navigator.storage) return Promise.resolve();
        return Promise.all([
          navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(null),
          navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve({})
        ]).then(function(r) {
          self.localStore = { persisted: r[0], usage: (r[1] && r[1].usage) || 0, quota: (r[1] && r[1].quota) || 0 };
        }).catch(function() {});
      },
      // Ask again after a refusal. Chrome/WebKit re-evaluate their heuristics (installing the app as a
      // PWA is the usual thing that flips it); Firefox re-prompts.
      requestLocalPersistence: function() {
        var self = this;
        if (!navigator.storage || !navigator.storage.persist) return Promise.resolve();
        return navigator.storage.persist()
          .then(function() { return self.refreshLocalStore(); })
          .catch(function() { return self.refreshLocalStore(); });
      },
      fmtBytes: function(n) {
        n = Number(n) || 0;
        var u = ['B', 'kB', 'MB', 'GB', 'TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
      },

      // Boot
      startApp: function() {
        var self = this;
        self.loading = true;

        // Load schema from backend, fall back to default
        var schemaPromise;
        if (backend.getSchema && !backend.bootData) {
          schemaPromise = backend.getSchema().then(function(s) {
            if (s) {
              var parsed = typeof s === 'string' ? JSON.parse(s) : s;
              _normalizeSchema(parsed);
              self.schemaData = Object.freeze(parsed);
              self._tableOrder = Object.keys(parsed.tables || {});
              var schemaErrors = validateSchema();
              if (schemaErrors.length) { console.warn('Schema errors:', schemaErrors); self.notify(self.t('msg.schema_error') + ' ' + schemaErrors[0]); }
            } else {
              // Same as the bootData path below: "no schema" may mean an empty database or a read that
              // failed, and a refused write must not reject into the console.
              if (backend.saveSchema) Promise.resolve(backend.saveSchema(defaultSchema)).catch(function() {});
              self.schemaData = Object.freeze(defaultSchema);
            }
          });
        } else {
          schemaPromise = Promise.resolve().then(function() { self.schemaData = Object.freeze(defaultSchema); });
        }

        // Load app-wide folder config (holds the global rotationAnchor) before rendering rotations.
        schemaPromise = schemaPromise.then(function() {
          if (!backend.getFolderConfig) return;
          return Promise.resolve(backend.getFolderConfig()).then(function(cfg) {
            self.appConfig = cfg || {};
          }).catch(function() {});
        });

        schemaPromise.then(function() {
        // Fast path: single batch call (Apps Script)
        if (backend.bootData) {
          backend.bootData().then(function(result) {
            if (!result) { self.notify(self.t('msg.server_error') + ' bootData returned null'); self.loading = false; return; }
            if (result.error) { self.notify(self.t('msg.server_error') + ' ' + result.error); self.loading = false; return; }
            // Not registered yet: skip schema/data entirely and fall through to loadUsers() below,
            // which will detect this via the self-scoped access check and show the request-access banner.
            if (result.denied) return;
            // bootData may return schema too
            if (result.schema) {
              var parsedSchema = typeof result.schema === 'string' ? JSON.parse(result.schema) : result.schema;
              _normalizeSchema(parsedSchema);
              if (result.tableOrder) self._tableOrder = result.tableOrder;
              if (result.columnOrders) window._columnOrders = result.columnOrders;
              ensureImplicitId(SCHEMA, window._columnOrders); // re-run with overridden orders
              self.schemaData = Object.freeze(parsedSchema);
              var schemaErrors = validateSchema();
              if (schemaErrors.length) { console.warn('Schema errors:', schemaErrors); self.notify(self.t('msg.schema_error') + ' ' + schemaErrors[0]); }
            } else {
              // No schema came back. That is USUALLY a first boot -- but it is also what a read that
              // failed looks like, and the two are indistinguishable from here: `schema: null` carries
              // no reason. Firebase says `denied: true` when it knows (handled above); nothing else can.
              //
              // So the write is best-effort. It used to be a bare call, and a refusal became an
              // unhandled rejection -- `pageerror: Object` in the console of anyone who is not allowed
              // to save the schema, which is every non-admin. Being refused here is the CORRECT outcome
              // for them, and the rules refusing it is what stops a failed read from overwriting a real
              // schema with the bundled default.
              self.schemaData = Object.freeze(defaultSchema);
              Promise.resolve(backend.saveSchema(defaultSchema)).catch(function() {});
            }
            self.languages = result.languages || [];
            self.listsCache = result.lists || {}; window._listsCache = self.listsCache;
            self.loadListAvatars(); self.loadMyListValues();   // avatars + my own @me identity (the admin-only editor links wait for the user list — see the usersLoaded watcher)
            // Auto-seed lists (create missing list names + seed mandatory filter values): admin-only
            // maintenance. A restricted user's listsCache is already scoped to their own tables
            // server-side; seeding+saving here would add entries for tables they don't own, and
            // saveLists's batch write would then be denied wholesale (Firestore batches are atomic --
            // one disallowed doc fails the lot). result.unrestricted is only ever explicitly false
            // for a scoped Firebase user; other backends don't set it, so they keep seeding as before.
                    if (result.unrestricted !== false && self._seedSchemaLists()) backend.saveLists(self.listsCache);
            // Populate data cache
            for (var key in result.data) {
              var d = result.data[key];
              self.dataCache[key] = parseTableResult(d).rows;
            }
            // Load active language
            if (self.languages.length === 0) {
              // No languages configured -- skip translation loading
              return Promise.resolve();
            }
            // Load default language translations as base
            var defCode = self.defaultLanguage;
            return backend.getTranslations(defCode).then(function(baseTrans) {
              self.strings = baseTrans || {};
              // A remembered code can outlive its language too (a rename, or a different database on the
              // same origin), so validate it against the list rather than trusting localStorage.
              var saved = localStorage.getItem('app_lang');
              if (!self.languages.some(function(l) { return l.code === saved; })) saved = defCode;
              self.currentLang = saved;
              if (saved !== defCode) {
                return backend.getTranslations(saved).then(function(trans) {
                  if (trans) self.strings = Object.assign({}, self.strings, trans);
                });
              }
            });
          }).then(function() {
            self._autoArchive();
            self.loadUsers();
          }).catch(function(err) {
            self.loading = false;
            self.notify(err && err.message ? err.message : self.t('msg.load_failed'));
          });
          return;
        }

        // Sequential path (local server / OAuth)
        backend.initSchema(SCHEMA).then(function(schemaResult) {

          return backend.getAvailableLanguages();
        }).then(function(langs) {
          self.languages = langs || [];
          if (self.languages.length === 0) {
            return Promise.resolve();
          }
          // Load default language as base strings
          var defCode = self.defaultLanguage;
          return backend.getTranslations(defCode).then(function(baseTrans) {
            self.strings = baseTrans || {};
            // Same validation as the bootData path above: a stale app_lang must not select a language
            // that no longer exists.
            var saved = localStorage.getItem('app_lang');
            if (!self.languages.some(function(l) { return l.code === saved; })) saved = defCode;
            self.currentLang = saved;
            if (saved !== defCode) {
              return backend.getTranslations(saved).then(function(trans) {
                if (trans) self.strings = Object.assign({}, self.strings, trans);
              });
            }
          });
        }).then(function() {
          // Preload lists + auto-seed (shared with the bootData path via _seedSchemaLists)
          return backend.getLists().then(function(lists) {
            self.listsCache = lists || {}; window._listsCache = self.listsCache;
            if (self._seedSchemaLists()) backend.saveLists(self.listsCache);
            self.loadListAvatars(); self.loadMyListValues();   // avatars + my own @me identity (the admin-only editor links wait for the user list — see the usersLoaded watcher)
          });
        }).then(function() {
          // Load users FIRST to know access restrictions
          return new Promise(function(resolve) {
            if (typeof backend_users === 'undefined') { resolve(); return; }
            if (!self.currentUserEmail) {
              var p = new URLSearchParams(location.search);
              self.currentUserEmail = p.get('user') || localStorage.getItem('test_user') || 'local@dev';
            }
            backend_users.getUsers().then(function(u) {
              var list = [];
              Object.keys(u || {}).forEach(function(k) { var v = u[k]; if (v && typeof v === 'object' && v.role) list.push({key: k, addr: v.user || '', role: v.role, tables: v.tables || 'all'}); });
              if (!list.length && self.currentUserEmail) {
                var adminEmail = self.currentUserEmail.toLowerCase();  // normalize key to match auth email
                backend_users.setUserRole(adminEmail, 'admin', adminEmail, 'all').then(function() {
                  self.userList = [{key: adminEmail, addr: adminEmail, role: 'admin', tables: 'all'}];
                  self.usersLoaded = true;
                  resolve();
                });
                return;
              }
              self.userList = list;
              self.usersLoaded = true;
              resolve();
            }).catch(function() { self.usersLoaded = true; resolve(); });
          });
        }).then(function() {
          return self._writeBackMigratedSchema();
        }).then(function() {
          // No table preload here any more. This walked every reachable table and read it before a view
          // opened -- the non-batched twin of what bootData used to do, and the same read bill. A view
          // loads its own tables when it opens (loadTableData / loadPage -> _ensureCached), the path
          // navigation already used, so the tables of a view nobody visits are simply never read.
          //
          // The archive partitions this used to pull under `preload_archive` moved with them:
          // _ensureCached honours that same setting for each table it loads.
          self.loading = false;
          self._autoArchive();
          self._autoSelectTab();
        }).catch(function(err) {
          self.loading = false;
          self.notify(err && err.message ? err.message : self.t('msg.load_failed'));
        });
        }); // end schemaPromise.then
      },

      // Navigation
      // Mobile bottom-nav "More": open the drawer AND expand every group so all sub-items are visible at once.
      openMoreDrawer: function() { this.openedGroups = this.allGroupIds.slice(); this.drawerOpen = true; },
      selectTab: function(id) {
        this.currentTable = id;
        if (id === '__settings') this.checkExampleUpdates();
        if (id === '__languages') this._ensureTranslatableLookups();
        if (this.mobile) this.drawerOpen = false;
        this.editingLang = null;
        this.currentRefTable = null;
        this.viewingArchive = false;
        this.searchTerm = '';          // a term belongs to the list it was typed over
        this.pageEditing = false;
        var cfg = VIEWS[id] || SCHEMA[id] || {};
        this.sortCol = cfg.defaultSort || null;
        this.sortAsc = true;
        if (this.isCalendarView || this.isPivotView || this.isRsvpView || this.isFormView) { this.loadTableData(); }
        else if (this.isDataView || this.isRotationView || this.isBoardView || this.isStatsView) { this.periodOffset = 0; this.loadTableData(); }
        else if (VIEWS[id] && typeof VIEWS[id].markdown === 'string') this.loadPage(id);
      },
      // --- Calendar helpers (used by the calendar view + calendar embeds) ---
      _calToday: function() { return fmtDate(new Date()); },
      _calCellsMonth: function(anchor, weekStart) { return Calendar.cellsMonth(anchor, weekStart, this._calToday()); },
      _calCellsWeek: function(anchor, weekStart) { return Calendar.cellsWeek(anchor, weekStart, this._calToday()); },
      // BCP-47 locale for Intl date names: an explicit `language.locale`, else the language CODE itself
      // (a standard code like `en`/`es`/`sv` IS a valid BCP-47 tag — so the calendar follows the SELECTED
      // app language, not the browser). The browser locale is only a last resort when the code is unusable.
      calLocale: function() {
        var code = this.currentLang, lang = (this.languages || []).find(function(l) { return l.code === code; });
        var loc = (lang && lang.locale) || code;
        try { if (loc) { Intl.DateTimeFormat(loc); return loc; } } catch (e) {}   // fall through if `loc` isn't a usable locale
        return (typeof navigator !== 'undefined' && navigator.language) || 'en';
      },
      // `this.theme` is 'light' | 'dark' — the categorical palette is stepped per surface, so the
      // mode has to reach it. Callers keep asking for a color and nothing else.
      hashColor: function(key) { return Calendar.hashColor(key, this.theme); },
      // Resolve a calendar view's source specs / rotation overlays (pure over VIEWS -> calendar.js).
      calSources: function(name) { return Calendar.sources(VIEWS, name); },
      // The source a day-add creates in. One source -> that one. Several -> ambiguous, so the calendar
      // must say which with `calendar.addTo: "<table>"`; without it day-add stays off rather than
      // guessing which of several tables the click meant.
      calAddSource: function(name) {
        var srcs = this.calSources(name), cfg = (VIEWS[name] && VIEWS[name].calendar) || {};
        if (cfg.addTo) return srcs.find(function(s) { return s && s.table === cfg.addTo; }) || null;
        return srcs.length === 1 ? srcs[0] : null;
      },
      canCalendarAdd: function(name) {
        var s = this.calAddSource(name);
        if (!s || !s.table || !s.dateColumn || !SCHEMA[s.table]) return false;
        if (this.viewReadonly(name)) return false;
        // Adding writes the whole mirror cluster, so a grant must cover all of it — but a member with no
        // grant at all may still own rows on a self-service table, and refusing them here was the only
        // place that forgot it (the grid's Add button has allowed it all along via canMutateRows).
        var allowed = this.userWritableTables;
        if (!allowed) return true;
        if (withMirrors([s.table]).every(function(t) { return allowed.indexOf(t) >= 0; })) return true;
        return this.canSelfServe(s.table);
      },
      // Create a row on `date` in that single source, then land on the source table. The calendar's
      // day panel is read-only (cal-event-row renders, never edits), so adding in place would strand
      // a blank row the user cannot fill in; the table is where it becomes editable.
      calendarAddOnDay: function(name, date) {
        if (!date || !this.canCalendarAdd(name)) return;
        var s = this.calAddSource(name), prefill = {};
        prefill[s.dateColumn] = date;                   // the point: prefill the clicked day
        this._createBlankRow(s.table, { prefill: prefill });
        this.selectTab(this._gridFor(s.table));
        this.notify(this.t('msg.row_added'));
      },
      // Where to land after creating a row: the new row is blank but for its date, so the user needs a
      // grid to fill in. Prefer somewhere they can actually navigate back to — a nav entry over this
      // table — and fall back to the table itself, which may not be in the menu at all.
      _gridFor: function(table) {
        var hit = null;
        (this.sidebarTabs || []).forEach(function(t) {
          (t.children || [t]).forEach(function(e) {
            if (hit || !e || e.divider || !e.id) return;
            var v = VIEWS[e.id];
            if (e.id === table) { hit = e.id; return; }
            if (v && !v.markdown && !v.board && (v.sources || []).length === 1 && v.sources[0] === table && !v.readonly) hit = e.id;
          });
        });
        return hit || table;
      },
      // Board: add a blank card pre-stamped with a lane value (like addRow, but prefilling board.lane so
      // the card lands in the clicked lane). Pushes into currentData so the board re-renders immediately.
      boardAddInLane: function(name, laneKey) {
        var v = VIEWS[name]; if (!v || !v.board || !this.canMutateRows) return;
        var primary = v.sources[0], prefill = {}; prefill[v.board.lane] = laneKey;
        var primaryRow = this._createBlankRow(primary, { tab: this.viewingArchive ? 'archive' : 'active', prefill: prefill });
        var viewRow = Object.assign({}, primaryRow);
        if (v.mode === 'union') viewRow._source = primary;
        this.currentData.push(viewRow);
        this.notify(this.t('msg.row_added'));
      },
      calRotationSources: function(name) { return Calendar.rotationSources(VIEWS, name); },
      // Visible grid window {from, toExclusive} for a calendar's anchor+mode (month/list -> month grid,
      // week -> week strip). Bounds rotation generation to what's actually on screen.
      _calWindowFor: function(anchor, mode, weekStart) { return Calendar.windowFor(anchor, mode, weekStart, this._calToday()); },
      // The event model lives in /events.js (pure over this ctx), like print.js and embeds.js before it.
      // The root keeps the same-named thin wrapper below so components/templates/tests are unchanged;
      // only root-state reads cross this seam.
      //
      // The `rotation` half is grouped rather than flattened because those seven are ONE question — how
      // is this rotation view configured for this viewer — and the root is the only layer that can
      // answer it: they read appConfig (per-user anchor/range/rotateEvery overrides), the signed-in
      // identity (mineOnly), and dataCache (a rosterRef's slots are values of a lookup, not columns).
      // The overlay asking those through anything but the matrix's own resolvers is exactly the bug
      // that shipped untranslated chore names beside translated ones.
      _eventsCtx: function() {
        var self = this;
        return {
          views: VIEWS, dataCache: this.dataCache,
          today: function() { return self._calToday(); },
          t: function(k) { return self.t(k); },
          tOr: function(k, fb) { return self.tOr(k, fb); },
          displayValue: function(c, v, ns, cfg) { return self.displayValue(c, v, ns, cfg); },
          canReachTable: function(tbl) { return self.canReachTable(tbl); },
          hashColor: function(k) { return self.hashColor(k); },
          resolveMeTokens: function(f) { return self.resolveMeTokens(f); },
          rotation: {
            rangeFor: function(n) { return self.rangeForView(n); },
            anchorFor: function(n) { return self.anchorForView(n); },
            rotateEveryFor: function(n) { return self.rotateEveryForView(n); },
            mineOnlySlot: function(v) { return self.mineOnlySlot(v); },
            slotsFor: function(rv) { return self.rotationSlotsFor(rv); },
            slotLabel: function(n, slot) { return self.rotationSlotLabel(n, slot); },
            valueColFor: function(n, slot) { return self.rotationValueColFor(n, slot); }
          }
        };
      },
      // Build the { 'YYYY-MM-DD': [events] } map for a calendar view. Undated rows -> '__undated__'.
      // Fail-closed per source: a table the user cannot read contributes nothing. When `window` is
      // given, rotationSources' generated duties are added (bounded to that window).
      calEventsFor: function(name, window) { return Events.build(name, window, this._eventsCtx()); },
      // Download a calendar view as an .ics file. Serialization is Ics.build (pure, Node-tested); this
      // is only the window choice and the browser save, mirroring exportData's Blob/anchor dance.
      //
      // The window is a YEAR FROM TODAY, deliberately not the visible grid. Source rows ignore the
      // window entirely (every loaded row is placed on its own date), but generated rotation duties are
      // clipped to it -- so passing what is on screen would export the duties of whichever month the
      // user happened to be looking at, and no others, with nothing to indicate that is what happened.
      // A year is the horizon a subscription is useful over, and re-exporting is how it is extended.
      //
      // UIDs are qualified with the database key so two databases exported into one calendar client
      // cannot collide; it is a stable local identifier, not an address, and nothing is sent anywhere.
      downloadIcs: function(name) {
        var view = name || this.currentTable;
        var from = this._calToday();
        var p = from.split('-');
        var to = fmtDate(new Date(Number(p[0]) + 1, Number(p[1]) - 1, Number(p[2])));
        var title = this.tOr('view.' + view, this.tOr('tab.' + view, view));
        var text = Ics.build(this.calEventsFor(view, { from: from, toExclusive: to }), {
          name: title,
          domain: (typeof Databases !== 'undefined' && Databases.activeKey()) || 'dbui.local'
        });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
        a.download = view + '-' + from + '.ics';
        a.click();
        this.notify(this.t('msg.exported'));
      },
      // Build a timeline view's bars. Pure module + thin root wrapper, like pivotFor / calEventsFor.
      // Rows come through the same embed row pipeline every other read-only kind uses, so `filter`,
      // computed columns and access gating apply exactly as they do in a data view -- a timeline is a
      // data view with a different geometry, not a second way to reach rows.
      //
      // `from` defaults to TODAY rather than to the earliest row: a plan is read forward from now, and
      // defaulting to the data's own start means adding one old row silently rescales the whole chart.
      timelineFor: function(name) {
        var v = VIEWS[name]; if (!v || !v.timeline) return { periods: [], bars: [] };
        var tl = v.timeline;
        var from = (!tl.from || tl.from === 'today') ? this._calToday() : tl.from;
        return Timeline.build(this.embedRows('view', name), {
          start: tl.start, end: tl.end, from: from,
          periods: tl.periods || 12, interval: tl.interval || 'weekly'
        });
      },
      isCalendarName: function(name) { return !!(VIEWS[name] && VIEWS[name].calendar); },
      isRotationName: function(name) { return !!(VIEWS[name] && VIEWS[name].rotation); },
      isPivotName: function(name) { return SchemaNormalize.viewKind(VIEWS[name]) === 'pivot'; },
      // Build a pivot view's grid: resolve its source (a table or view) through the embed row pipeline
      // (so filters/aggregates/computed columns apply), then Pivot.build cross-tabs it. Pure module +
      // thin root wrapper, like calEventsFor / rotationRowsFor.
      pivotFor: function(name) {
        var v = VIEWS[name]; if (!v || !v.pivot) return { columns: [], rows: [] };
        var p = v.pivot, src = p.source;
        var rows = VIEWS[src] ? this.embedRows('view', src) : (this.dataCache[src] || []);
        // Same reasoning as buildRows: a cross-tab counting history must see the archived rows too.
        if (v.includeArchive && !VIEWS[src]) rows = rows.concat(this.dataCache[src + '__archive'] || []);
        return Pivot.build(rows, p);
      },
      isRsvpName: function(name) { return SchemaNormalize.viewKind(VIEWS[name]) === 'rsvp'; },
      isStatsName: function(name) { return SchemaNormalize.viewKind(VIEWS[name]) === 'stats'; },
      // KPI tiles for a stats view. Unlike pivot/rsvp there is no separate source config to resolve: a
      // stats view IS a data view -- same sources/filter/groupBy/aggregate/compute -- with a different
      // renderer, so the rows come from the pipeline that already ran.
      //
      // Which pipeline depends on WHERE it is rendered, and both readings are the right one:
      //   top-level  -> currentData, the rows loadTableData just built. That is what carries the `period`
      //                 back-offset, so the ‹ › navigation the header already shows (hasPeriodNav only
      //                 tests `view.period`) actually moves the tiles.
      //   embedded   -> embedRows, the same path every other {{view:x}} embed takes. currentData belongs
      //                 to the page being viewed, which for an embed is somebody else entirely.
      statsFor: function(name) {
        var v = VIEWS[name]; if (!v || !v.stats) return { tiles: [] };
        var rows = (name === this.currentTable && !this.viewingArchive) ? (this.currentData || []) : this.embedRows('view', name);
        return Stats.build(rows, v.stats);
      },
      // A doc-view (markdown page). Embedding one inside another page (`{{view:x}}`) renders its
      // ACCESS-GATED server body -- see embed-view's doc branch: it hides the block via canAccessPage
      // and pulls pageCache (loadPage, server-filtered) rather than the world-readable schema seed.
      // A PURE doc-view (markdown page, no own grid). A view that also has `sources` is a data-view whose
      // markdown is a self-embedding layout wrapper -- its {{self}} -> {{view:self}} must render the GRID,
      // not recurse into the markdown as a doc. So exclude sourced views here (they embed as `data`).
      isDocViewName: function(name) { var v = VIEWS[name]; return !!(v && typeof v.markdown === 'string' && !(v.sources && v.sources.length)); },
      // Build the self-service RSVP list (upcoming events + the current user's own response per event +
      // tallies), via the pure Rsvp module. Owner identity = the auth email (matches the firestore rules).
      // The response<->event link is derived (not configured): the responses table's `ref` column pointing
      // at the events table IS the link — its name is the linkColumn, its valueCol the eventKey. Point the
      // ref at the events' `id` (unique) so distinct events on the same date don't collide; `id` is also the
      // fallback. `dateColumn` is only for the upcoming filter + sort, not the link. No linkColumn/eventKey.
      rsvpLink: function(cfg) {
        var r = Columns.tableRefCol(SCHEMA, cfg.responses, cfg.events);
        return { linkColumn: r && r.name, eventKey: (r && r.valueCol) || 'id' };
      },
      rsvpFor: function(name) {
        var v = VIEWS[name]; if (!v || !v.rsvp) return { events: [], statuses: [] };
        var cfg = v.rsvp;
        var events = VIEWS[cfg.events] ? this.embedRows('view', cfg.events) : (this.dataCache[cfg.events] || []);
        var responses = this.dataCache[cfg.responses] || [];
        return Rsvp.build(events, responses, Object.assign({
          me: this.currentUserEmail || '', ownerCol: getOwnerCol(cfg.responses) || 'owner', today: fmtDate(new Date())
        }, cfg, this.rsvpLink(cfg)));
      },
      // The `form` view: one focused record the member fills in properly, rather than a cell edited in
      // a grid. Everything underneath is the self-service machinery rsvp already uses -- an owner-stamped
      // row, gated by ownerWritable/ownerWritableWhile in both rule layers -- so a form record needs no
      // new access rules at all. What is new is the SHAPE: several fields, grouped, some required,
      // submitted once instead of toggled.
      formFor: function(name) {
        var v = VIEWS[name];
        if (!v || !v.form) return Form.build([], {});
        var cfg = v.form, table = cfg.table;
        var bounds = (typeof BackendHelpers !== 'undefined' && BackendHelpers.ownerWritableOf)
          ? (BackendHelpers.ownerWritableOf({ tables: SCHEMA })[table] || {}) : {};
        return Form.build(this.dataCache[table] || [], Object.assign({}, cfg, {
          me: this.currentUserEmail || '',
          ownerCol: getOwnerCol(table) || 'owner',
          // The state gate the rules will apply anyway. Reading it here is what lets the form say "this
          // has been submitted and can no longer be changed" instead of offering an edit the write layer
          // is about to refuse.
          whileCol: bounds.whileCol || '',
          whileVals: bounds.whileVals || []
        }));
      },

      // Create the caller's record if they have none. Returns it either way, so the component can edit
      // through the ordinary data-cell path -- a form field is the same editor as a grid cell, which is
      // how every column type and widget works here for free.
      formRecord: function(name) {
        var v = VIEWS[name];
        if (!v || !v.form || !v.form.table) return null;
        var me = this.currentUserEmail || '';
        if (!me) { this.notify(this.t('msg.sign_in_respond')); return null; }
        var built = this.formFor(name);
        if (built.record) return built.record;
        // _createBlankRow stamps the owner column and any `default`/`defaultFrom`, and pushes the row
        // into the cache -- the same path the grid's Add uses, so a form record is an ordinary row.
        return this._createBlankRow(v.form.table, { tab: 'active' });
      },

      // Upsert the current user's response for one event: update my existing owned row, else create one
      // stamped with owner = my email. Self-service — not gated by role (firestore rules enforce ownership).
      setRsvp: function(name, eventKey, status) {
        var v = VIEWS[name]; if (!v || !v.rsvp) return;
        var cfg = v.rsvp, table = cfg.responses, ownerCol = getOwnerCol(table) || 'owner';
        var linkColumn = this.rsvpLink(cfg).linkColumn;
        var me = this.currentUserEmail || '';
        if (!me) { this.notify(this.t('msg.sign_in_respond')); return; }
        // Denormalize the table's roster policy onto the row so the (schema-blind) firestore read rule can
        // enforce it: public tables -> readable by all; privateRoster tables -> only owner + organizers.
        var pub = !(SCHEMA[table] && SCHEMA[table].privateRoster);
        if (!this.dataCache[table]) this.dataCache[table] = [];
        var rows = this.dataCache[table];
        var mine = rows.find(function(r) { return r[linkColumn] === eventKey && r[ownerCol] === me; });
        // Removing the vote (toggled off -> empty status): delete my response row rather than leave an
        // empty-status orphan that would show as a blank line in the roster.
        if (!status) {
          if (mine) { var mi = rows.indexOf(mine); if (mi >= 0) rows.splice(mi, 1); Writes.deleteRow(table, mine.id, 'active'); }
          return;
        }
        if (mine) {
          mine[cfg.statusColumn] = status; mine.rosterPublic = pub; mine.updated_at = new Date().toISOString();
          // Update = the status (plus the roster policy the read rule needs), never the whole response
          // row: an RSVP table is exactly where concurrent edits happen, and the owner/link columns are
          // already correct on the stored row.
          var patch = { id: mine.id, rosterPublic: pub, updated_at: mine.updated_at };
          patch[cfg.statusColumn] = status;
          Writes.putRow(table, patch, 'active');
        } else {
          var row = { id: this.generateId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          getColumns(table).forEach(function(c) { if (!(c in row)) row[c] = ''; });
          row[ownerCol] = me; row[linkColumn] = eventKey; row[cfg.statusColumn] = status; row.rosterPublic = pub;
          rows.push(row);
          Writes.putRow(table, row, 'active');
        }
      },
      // Doc-view bodies live in a server-side "_pages" collection (not in schema.json).
      // Falls back to the view's schema-defined `markdown` (seed), then caches it.
      // A markdown doc-view with `access:[tables]` is visible only to users granted one of those tables
      // (or admins/unrestricted). No `access` -> visible to all registered users (the default). Pure
      // over userAllowedTables; the firestore _pages rule enforces the matching body read server-side.
      canAccessPage: function(view) {
        if (!view || typeof view.markdown !== 'string') return true;   // not a doc-view
        var acc = view.access;
        if (!Array.isArray(acc) || !acc.length) return true;           // untagged -> all registered
        var allowed = this.userAllowedTables;
        if (!allowed) return true;                                     // admin / unrestricted
        return acc.some(function(t) { return allowed.indexOf(t) >= 0; });
      },
      // The tables a named view needs LOADED. Composed from the ACCESS gate's answer to the same
      // question rather than re-derived: AccessFeatures.viewTables covers sources + rosters + computed
      // helpers, and viewImplicitTables covers the per-kind inputs of a sourceless calendar/pivot/rsvp.
      // Keeping one derivation is what stops "what may I see" and "what do I load" from drifting apart
      // -- a view that renders blank because its inputs were never fetched is indistinguishable from
      // one blank because access was denied.
      //
      // What neither of those knows about is a DOC-VIEW: its markdown embeds render straight out of
      // dataCache with no fetch of their own. That gap is the reason this exists.
      //
      // Names are expanded through VIEWS, because pivot.source and rsvp.events may each name a view
      // rather than a table -- passing a view name to a loader would fetch nothing, silently. `seen`
      // terminates the recursion: pages may embed each other, and two calendars may overlay each other.
      _viewTables: function(name, seen) {
        var self = this, out = [];
        seen = seen || {};
        if (!name || seen[name]) return out;
        seen[name] = 1;
        var push = function(t) { if (t && out.indexOf(t) < 0) out.push(t); };
        // A name that is a TABLE is a table, even when a view shares its name -- which is common, since
        // the natural name for the view over `meeting_agenda` is `meeting_agenda`. Without the table
        // winning, `sources: ["meeting_agenda"]` was expanded as a view name, recursed into the view
        // already being resolved, hit the `seen` guard and contributed NOTHING. The view then loaded no
        // tables at all and rendered empty -- silently, and only once boot stopped loading everything.
        // Expansion still applies to pivot.source and rsvp.events, which genuinely may name a view.
        var expand = function(n) {
          if (!n) return;
          if (SCHEMA[n]) { push(n); return; }
          if (VIEWS[n]) { self._viewTables(n, seen).forEach(push); return; }
          push(n);
        };

        var v = VIEWS[name];
        if (!v) { if (SCHEMA[name]) push(name); return out; }        // a bare table

        // A form writes ONE table, named per-kind rather than in `sources` -- so nothing else
        // derives it, and without this the view would load nothing and show an empty record.
        if (v.form && v.form.table) push(v.form.table);
        AccessFeatures.viewTables(v).forEach(expand);
        viewImplicitTables(v).forEach(expand);

        // A doc-view's embeds. Read the LOADED body when there is one: an admin may have edited the
        // page since the schema seed was written, and the edit is what actually renders.
        if (typeof v.markdown === 'string') {
          var body = (self.pageCache && self.pageCache[name] != null) ? self.pageCache[name] : v.markdown;
          Embeds.blockRefs(body, name).forEach(function(ref) {
            if (ref.kind === 'table') push(ref.name); else expand(ref.name);
          });
        }
        // Embeds declared as COLUMN entries rather than in the markdown.
        (v.columns || []).forEach(function(c) {
          if (isEmbed(c)) (c.sources || []).forEach(expand);
          else if (isViewEmbed(c)) expand(c.view);
        });
        return out;
      },

      // Does rendering this view read the ARCHIVE partition at all?
      //
      // It used to be safe to assume yes for every archivable table, because the archive was a separate
      // store and anything wanting history had to fetch it. Now an archived row lives in the ACTIVE
      // store carrying `_status`, so the archive store holds only rows filed away under the old model --
      // and fetching it for every archivable table a view touches is a whole second read of data almost
      // nothing looks at. On Firestore that is billed per document.
      //
      // The features that genuinely read it: a view's `includeArchive`, an `@archive` or `@both` embed,
      // and a rotation column's occurrence source (resolveComputed deliberately ranks across both
      // partitions so an archived turn still counts). Same traversal as _viewTables, so the two cannot
      // disagree about what a view is made of.
      _viewNeedsArchive: function(name, seen) {
        var self = this;
        seen = seen || {};
        if (!name || seen[name]) return false;
        seen[name] = 1;
        var v = VIEWS[name];
        if (!v) return false;
        if (v.includeArchive) return true;

        // pivot.source and rsvp.events may each name a VIEW whose own config wants history -- the same
        // indirection _viewTables expands, and missing it here would fetch nothing while that view
        // silently rendered a short total.
        if (v.pivot && self._viewNeedsArchive(v.pivot.source, seen)) return true;
        if (v.rsvp && self._viewNeedsArchive(v.rsvp.events, seen)) return true;

        // A rotation column ranks across both partitions on purpose -- see resolveComputed.
        var cols = v.columns || [];
        if (cols.some(function(c) { return c && typeof c === 'object' && c.computed && c.computed.occurrenceSource; })) return true;
        if ((v.compute || []).some(function(c) { return c && c.computed && c.computed.occurrenceSource; })) return true;

        // A doc-view's markdown embeds: `@archive` names the partition, `@both` shows the toggle.
        if (typeof v.markdown === 'string' && typeof Embeds !== 'undefined' && Embeds.blockRefs) {
          var body = (self.pageCache && self.pageCache[name] != null) ? self.pageCache[name] : v.markdown;
          var refs = Embeds.blockRefs(body, name);
          if (refs.some(function(r) { return r.part === 'archive' || r.part === 'both'; })) return true;
          if (refs.some(function(r) { return r.kind === 'view' && self._viewNeedsArchive(r.name, seen); })) return true;
        }
        // Embeds declared as column entries.
        return cols.some(function(c) {
          if (!c || typeof c !== 'object') return false;
          if (c.includeArchive) return true;
          return isViewEmbed(c) && self._viewNeedsArchive(c.view, seen);
        });
      },

      loadPage: function(name) {
        var self = this;
        var seed = function() { return (VIEWS[name] && VIEWS[name].markdown) || ''; };
        // The page's embeds render out of dataCache and have no fetch of their own. Load what they need
        // once the body is known -- which is AFTER the read below, because an admin's edit can embed
        // something the schema seed does not. _ensureCached skips whatever is already cached, so on a
        // boot that preloaded everything this costs nothing.
        var needed = function() { self._ensureCached(self._viewTables(name), null, self._viewNeedsArchive(name)); };
        // Prefer a single-page read (backend.getPage) so per-page access can restrict it -- a
        // whole-collection read is denied wholesale once any page is restricted (rules aren't filters).
        // Backends without getPage (Sheets/CRDT/local) fall back to the collection read.
        if (backend.getPage) {
          Promise.resolve(backend.getPage(name)).then(function(p) {
            self.pageCache[name] = (p && p.markdown != null) ? p.markdown : seed();
          }).catch(function() { self.pageCache[name] = seed(); }).then(needed);
          return;
        }
        Promise.resolve(backend.getTableData('_pages', 'active')).then(function(d) {
          var row = (d && d.rows || []).find(function(r) { return r.id === name; });
          self.pageCache[name] = row ? row.markdown : seed();
        }).catch(function() {}).then(needed);
      },
      // Embed resolution lives in /embeds.js (pure over this ctx). The root keeps same-named thin
      // wrappers so components/templates/tests are unchanged; only root-state reads cross this seam.
      // A ctx is SINGLE-USE: it carries `rowsMemo`, which embeds.js fills with resolved row lists, and
      // that is only safe for as long as the dataCache it was built from cannot change. Building one
      // per wrapper call (rather than caching one on the instance) is what makes that true. The memo
      // is what stops a doc embed running the row pipeline twice per token -- see embedRows.
      _embedCtx: function() {
        var self = this;
        return {
          views: VIEWS, schema: SCHEMA, getColumns: getColumns, rowsMemo: new Map(),
          dataCache: this.dataCache, currentTable: this.currentTable,
          t: function(k) { return self.t(k); },
          viewWithMe: function(v) { return self._viewWithMe(v); },
          anchorForView: function(n) { return self.anchorForView(n); },
          rotationRowsFor: function(n, rv) { return self.rotationRowsFor(n, rv); },
          rotationColsFor: function(n, rows, cfg) { return self.rotationColsFor(n, rows, cfg); }
        };
      },
      buildEmbedBlock: function(type, name, part) { return Embeds.buildEmbedBlock(type, name, part, this._embedCtx()); },
      mdBlocks: function(markdown, selfName) { return Embeds.mdBlocks(markdown, selfName, this._embedCtx()); },
      docHasData: function(markdown, selfName) { return Embeds.docHasData(markdown, selfName, this._embedCtx()); },
      resolveEmbed: function(cfg) { return Embeds.resolveEmbed(cfg, this._embedCtx()); },
      embedCols: function(type, name) { return Embeds.embedCols(type, name, this._embedCtx()); },
      embedRows: function(type, name, part) { return Embeds.embedRows(type, name, part, this._embedCtx()); },
      embedHideEmpty: function(type, name) { var c = type === 'view' ? VIEWS[name] : SCHEMA[name]; return !!(c && c.hideEmpty); },
      // Tab labels for a `{{view:x@both}}` embed's Upcoming/Past toggle. Default to the keys the
      // top-level archive tabs already use (so a database that translated those gets the toggle
      // translated for free); a view/table may name its own keys instead — `partitionLabels:
      // { "active": "text.mine_log", "archive": "text.mine_past" }` — because the section headings a
      // page had before the toggle ("What I've logged" / "Approved earlier") are usually the better
      // labels. Resolution goes through t(), so an untranslated key shows as the key: static UI prose,
      // visibly a gap, exactly as the top-level archive tabs behave.
      embedPartLabel: function(type, name, part) {
        var c = type === 'view' ? VIEWS[name] : SCHEMA[name];
        var own = c && c.partitionLabels && c.partitionLabels[part];
        return this.t(own || (part === 'archive' ? 'btn.show_archived' : 'btn.show_active'));
      },
      embedViewLayout: function(type, name) { var c = type === 'view' ? VIEWS[name] : SCHEMA[name]; return (c && c.layout) || 'table'; },
      embedRowsForItem: function(ei, item) { return Embeds.embedRowsForItem(ei, item); },
      embedWhenOk: function(ei, item) { return Embeds.embedWhenOk(ei, item); },
      embedVisible: function(ei, item) { return Embeds.embedVisible(ei, item); },
      // Embed row controls — operate on the active partition across the mirror cluster (dataCache is reactive)
      embedSources: function(type, name) { return type === 'view' && VIEWS[name] ? (VIEWS[name].sources || []) : [name]; },
      // The embed's self-service table, mirroring `selfServeTable` for the top-level grid: a single
      // source with an owner column the viewer holds no WRITE grant on. Without this an embed asked only
      // "may I write the source table?", so a member whose read-only grant makes the table self-service
      // saw the embed lose its Add button — while the very same view, opened top-level, kept it.
      embedSelfServeTable: function(type, name) {
        var srcs = this.embedSources(type, name);
        return (srcs.length === 1 && this.canSelfServe(srcs[0])) ? srcs[0] : null;
      },
      canMutateEmbed: function(type, name) {
        // Same trap as the top-level grid: an embed of a `@me` view the viewer has no identity for would
        // offer Add, write an orphan, and drop it from the list again.
        if (type === 'view' && this.viewIdentityMissing(name)) return false;
        if (type === 'view' && this.viewAddBlocked(name)) return false;   // declared/synthetic: no row behind the button
        var selfServe = this.embedSelfServeTable(type, name);
        if (this.viewReadonly(name) && !selfServe) return false;
        if (selfServe) return true;              // add opens; per-row/per-column bounds gate the rest
        var allowed = this.userWritableTables;   // embed row controls mutate the embedded tables
        if (!allowed) return true;
        return withMirrors(this.embedSources(type, name)).every(function(t) { return allowed.indexOf(t) >= 0; });
      },
      // Per-ROW gate inside an embed (the grid's canMutateRow, resolved against the EMBED's own source
      // rather than currentTable): my row, still in an owner-writable state. Non-self-service embeds are
      // unaffected — every row answers true, exactly as before.
      canMutateEmbedRow: function(type, name, item) {
        var t = this.embedSelfServeTable(type, name);
        if (!t) return true;
        return this.rowOwnedByMe(item, t) && this.ownerRowWritable(item, t);
      },
      embedHasArchive: function(type, name) { return this.embedSources(type, name).some(function(s) { return SCHEMA[s] && SCHEMA[s].archivable; }); },
      embedAddRow: function(type, name) {
        this._createBlankRow(this.embedSources(type, name)[0]);
        this.notify(this.t('msg.row_added'));
      },
      embedDeleteRow: function(type, name, item) {
        var key = 'erow:' + item.id;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        this._deleteFromSources(withMirrors(this.embedSources(type, name)), item.id, false);
      },
      embedArchiveRow: function(type, name, item) {
        this._archiveInSources(withMirrors(this.embedSources(type, name)), item.id);
      },
      togglePageEdit: function() { this.pageEditing = !this.pageEditing; if (this.pageEditing) this.pageEditText = (this.currentPage && this.currentPage.markdown) || ''; },
      savePage: function() {
        var name = this.currentTable;
        this.pageCache[name] = this.pageEditText;
        if (backend.putRow) Writes.putRow('_pages', { id: name, markdown: this.pageEditText }, 'active');
        this.pageEditing = false;
        this.notify(this.t('msg.saved'));
      },

      // Ensure every schema-referenced list exists (both `list` and `listSwitch.list`), then seed
      // mandatory filter values. Returns true when a filter VALUE was seeded (callers persist via
      // saveLists then). One implementation for the bootData and sequential boot paths — they had
      // drifted into two hand-copied blocks (one with a leftover implicit global).
      //   A `list:` naming a LOOKUP TABLE is skipped: its options are the table's rows, so minting an
      // empty list under the same name would shadow nothing but would surface the catalogue in the Lists
      // tab as a second, always-empty copy of itself.
      _seedSchemaLists: function() {
        var lists = this.listsCache;
        var isLookupName = function(n) { return !!(SCHEMA[n] && SCHEMA[n].isLookup); };
        Object.keys(SCHEMA).forEach(function(t) {
          Object.keys(SCHEMA[t].columns).forEach(function(c) {
            var def = SCHEMA[t].columns[c];
            if (def && typeof def === 'object' && def.list && !lists[def.list] && !isLookupName(def.list)) lists[def.list] = [];
            if (def && typeof def === 'object' && def.listSwitch && def.listSwitch.list && !lists[def.listSwitch.list] && !isLookupName(def.listSwitch.list)) lists[def.listSwitch.list] = [];
          });
        });
        return _seedListValues(lists);
      },

      // Load each table's active partition into dataCache unless already cached or outside the user's
      // grants (fail-closed: a denied/failed read contributes an empty cache entry, never an error).
      // `onLoad` (optional) runs after each table lands — used by views that must re-derive rows.
      // One implementation for the calendar/rotation/pivot/rsvp preload blocks in loadTableData.
      // `wantArchive` -- the caller says whether the archive partition will actually be read. It used
      // to be assumed for every archivable table, which is now a second full read of rows almost
      // nothing looks at: an archived row lives in the ACTIVE store, so the archive store holds only
      // what was filed away under the old model. See _viewNeedsArchive for who genuinely needs it.
      // Fetch a partition into the cache, at most once at a time. Callers still check dataCache first
      // for the already-loaded case; this covers the window between asking and arriving, which nothing
      // else could see. Resolves with the rows either way -- a failed read caches [] (fail-closed, the
      // same as before) rather than rejecting, because every caller here treats "denied" as "empty".
      _fetchTable: function(table, tab, key) {
        var self = this;
        if (self._inflight[key]) return self._inflight[key];
        var p = Promise.resolve(backend.getTableData(table, tab)).then(function(result) {
          self.dataCache[key] = parseTableResult(result).rows;
        }).catch(function() {
          self.dataCache[key] = self.dataCache[key] || [];
        }).then(function() {
          delete self._inflight[key];
          return self.dataCache[key];
        });
        self._inflight[key] = p;
        return p;
      },

      _ensureCached: function(tables, onLoad, wantArchive) {
        var self = this;
        // Whatever this view needs cached is also what it needs kept LIVE. Watching here (rather than
        // per branch of loadTableData) means every derived kind — calendar, rotation, pivot, rsvp,
        // union/join — subscribes through the same list it already preloads, and cannot drift from it.
        // Note this runs before the skip-if-cached test below on purpose: an already-cached table still
        // needs a subscription.
        self._liveWatch(tables, 'active');
        (tables || []).forEach(function(tbl) {
          // Reachable = granted OR self-serviceable (owner-column table: the backend returns only the
          // member's own rows) — the same canReachTable the sidebar's canAccess uses, so an rsvp view's
          // responses table loads for a no-grant member instead of silently staying empty.
          if (!tbl || !self.canReachTable(tbl)) return;
          if (!self.dataCache[tbl] && !self._liveLoads(tbl)) {
            self._fetchTable(tbl, 'active', tbl).then(function() {
              // A table can only be swept once it is HERE. _autoArchive walks whatever is cached and a
              // repeat run finds nothing left to move, so this is what keeps the sweep working when boot
              // no longer loads everything -- otherwise rows in a table nobody had opened would simply
              // never age out, silently.
              self._autoArchive();
              if (onLoad) onLoad(tbl);
            });
          }
          // The ARCHIVE partition, only when the caller says something will read it, and still behind
          // `preload_archive` -- a user who turned that off asked not to load archives, and the
          // documented consequence (a history view comes up short) is unchanged.
          if (wantArchive && self.settings.preload_archive && SCHEMA[tbl] && SCHEMA[tbl].archivable && !self.dataCache[aKey(tbl)]) {
            self._fetchTable(tbl, 'archive', aKey(tbl)).then(function() { if (onLoad) onLoad(tbl); });
          }
        });
        self._ensureDeps(tables, onLoad);
      },

      // The tables a view's COLUMNS resolve out of, as opposed to the tables its rows come from: a ref
      // dropdown's options, a lookup computed's source, a rotation column's roster, a mirror's master.
      // Every one of those reads dataCache directly and resolves to []/undefined when the entry is
      // missing -- an empty dropdown and a blank cell, which look like data rather than like a missing
      // fetch. Today boot loads every granted table so this never fires; it exists so that stops being
      // the thing holding those columns up. See Columns.tableDeps for the five shapes.
      //
      // Two deliberate limits:
      //   - LOAD ONLY, never _liveWatch. A listener bills a read per document in its first snapshot, so
      //     watching every ref table would cost more than the lazy load saves, and a dropdown of options
      //     does not need to be live the way a row grid does.
      //   - DEPTH 1. A dependency's own dependencies are what you need once you OPEN that table, and
      //     opening it goes through _ensureCached again. Recursing here would drag in the transitive
      //     closure of the schema on the first view load, which is the cost this is meant to avoid.
      _ensureDeps: function(tables, onLoad) {
        var self = this;
        if (typeof Columns === 'undefined' || !Columns.tableDeps) return;
        var seen = {};
        (tables || []).forEach(function(tbl) {
          if (!tbl) return;
          Columns.tableDeps(SCHEMA, tbl).forEach(function(dep) {
            if (seen[dep] || self.dataCache[dep] || !self.canReachTable(dep)) return;
            seen[dep] = 1;
            self._fetchTable(dep, 'active', dep).then(function() { if (onLoad) onLoad(dep); });
          });
        });
      },

      // --- Live sync ------------------------------------------------------------------------------
      // A backend that can push (Firebase onSnapshot, Supabase realtime, the dev server's SSE stream)
      // exposes the OPTIONAL subscribeTable(tableId, tab, onChange) -> unsubscribe. Backends without it
      // (OAuth/Sheets, CRDT/Drive, Apps Script) simply never get here and keep the manual refresh
      // button, which is why every entry point below is guarded rather than assumed.
      //
      // Scope: the tables of whatever view is open, subscribed on first sight and kept for the rest of
      // the session. On Firestore a listener bills a read per document in its FIRST snapshot, so
      // re-subscribing on every navigation would quietly multiply the bill; keeping them costs one
      // extra full read per table per session and nothing for a table the user never opens.
      // True when the live subscription will DELIVER the initial rows, so fetching them separately would
      // pay for the same documents twice -- which is exactly what happened: Firestore bills a read per
      // document in a listener's first snapshot, and every table a view opened was fetched and then
      // subscribed. Backends whose realtime channel carries only subsequent CHANGES (Supabase, the dev
      // server's SSE) do not set `subscribeLoads`, and keep fetching.
      //
      // Mirrors _liveWatch's own guards on purpose: if the conditions for subscribing are not met the
      // subscription never happens, and skipping the fetch on top of that would leave the table empty
      // for good.
      _liveLoads: function(tbl) {
        return !!(typeof LiveSync !== 'undefined' && typeof backend !== 'undefined' && backend
                  && backend.subscribeLoads && typeof backend.subscribeTable === 'function'
                  && tbl && this.canReachTable(tbl));
      },

      _liveWatch: function(tables, tab) {
        var self = this;
        // `backend` is an implicit global assigned by whichever adapter loaded, and app-core is created
        // BEFORE that script runs — so this is a typeof test, not a truthiness one (matching canUpload's
        // guard further down). LiveSync is absent in the Apps Script deployment, which ships no
        // live-sync.js and no push-capable backend either.
        if (typeof LiveSync === 'undefined' || typeof backend === 'undefined' || !backend
            || typeof backend.subscribeTable !== 'function') return;
        (tables || []).forEach(function(tbl) {
          if (!tbl || !self.canReachTable(tbl)) return;
          var store = BackendHelpers.storeName(tbl, tab || 'active');
          if (self._liveSubs[store]) return;                 // already watched — subscribe once per session
          self._liveSubs[store] = backend.subscribeTable(tbl, tab || 'active', function(change) {
            self._liveApply(store, change);
          }) || function() {};
        });
      },

      // A subscription that will never deliver rows -- denied, or no identity to scope it by. Fetch the
      // partition directly, the way every backend without `subscribeLoads` is fetched anyway. Guarded on
      // the cache still being empty so it cannot fire twice or overwrite a load that already landed.
      _liveLoadFallback: function(store) {
        var self = this;
        var key = LiveSync.cacheKeyFor(store);
        if (self.dataCache[key] !== undefined) return;
        var parts = String(store).split('__');
        var tbl = parts[0], tab = parts.length > 1 ? 'archive' : 'active';
        if (!self.canReachTable(tbl)) { self.dataCache[key] = []; return; }
        backend.getTableData(tbl, tab).then(function(result) {
          if (self.dataCache[key] !== undefined) return;
          self.dataCache[key] = parseTableResult(result).rows;
          self._autoArchive();
          self.loadTableData();
        }).catch(function() { self.dataCache[key] = self.dataCache[key] || []; });
      },

      // Drop every subscription. Called by the two paths that discard the whole dataset before the
      // page reloads — import and reset — where the reload can be up to a second away and every wiped
      // or re-imported row would otherwise arrive as a live change against a doomed dataCache. The
      // other reload paths are immediate, so the page is gone before a listener could fire.
      _liveUnwatchAll: function() {
        var self = this;
        Object.keys(self._liveSubs || {}).forEach(function(store) {
          try { self._liveSubs[store](); } catch (e) {}
        });
        self._liveSubs = {};
        self._liveState = null;
        clearTimeout(self._liveRebuildTimer);
      },

      // True while a local edit is in flight, in which case remote changes are queued instead of
      // applied. Two conditions, both deliberately COARSE — they hold back every row, not just the one
      // being edited:
      //   (a) focus is in an editable element. The inline cell has no draft buffer: the contenteditable
      //       span renders {{ item[col] }} straight off the cached row object, so assigning to that row
      //       mid-keystroke repaints the text under the caret.
      //   (b) a saveField debounce is still pending. Its payload is built when the timer fires, from
      //       the live row — applying a remote change first would send someone else's value back as if
      //       the user had typed it.
      // The cost of being coarse is that updates pause while a cell has focus, which is seconds, and
      // the benefit is that no per-row or per-cell plumbing has to exist in any template.
      _liveHeld: function() {
        var el = document.activeElement;
        if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return true;
        return Object.keys(this.saveTimers || {}).length > 0;
      },

      _liveApply: function(store, change) {
        var self = this;
        // 'sync' is the listener's FIRST snapshot -- the whole partition, which Firestore billed a read
        // per document for whether or not anyone used it. Treated as a LOAD, not as a remote edit: it
        // is not queued behind an in-flight local edit (there is nothing local yet) and it never
        // overwrites rows already in the cache, so a fallback fetch that won the race keeps its result
        // and a late snapshot cannot clobber what the user has since typed.
        if (change && change.type === 'sync') {
          var key = LiveSync.cacheKeyFor(store);
          // Applied unless the cache already holds ROWS -- not merely unless it exists. Other code
          // seeds an empty array as a placeholder (app-core:1349 does it so a ref dropdown has
          // something to read; _archiveInSources does it before moving a row), and treating that
          // placeholder as "already loaded" threw the snapshot away and left the table permanently
          // empty. A cache that already has rows got them from a fetch of the same partition, so the
          // snapshot is redundant there, and skipping it is what protects a local optimistic insert.
          if (!(self.dataCache[key] && self.dataCache[key].length)) {
            self.dataCache[key] = change.rows || [];
            self._autoArchive();
            self.loadTableData();
          }
          return;
        }
        // No live subscription is coming (denied, or no identity). The rows have to arrive some other
        // way or the view stays blank with nothing to explain it.
        if (change && change.type === 'sync-failed') { self._liveLoadFallback(store); return; }
        if (!self._liveState) self._liveState = LiveSync.createState();
        var rowsFor = function(cacheKey) { return self.dataCache[cacheKey]; };
        var r = LiveSync.queueOrApply(self._liveState, store, change, self._liveHeld(), rowsFor);
        if (r.applied) self._liveRebuild();
      },

      // Drain whatever was held back. Called on focusout and after each save timer fires — i.e. at
      // exactly the two moments _liveHeld can go false.
      _liveFlush: function() {
        var self = this;
        if (!self._liveState || !self._liveState.order.length || self._liveHeld()) return;
        var rowsFor = function(cacheKey) { return self.dataCache[cacheKey]; };
        if (LiveSync.flush(self._liveState, rowsFor).length) self._liveRebuild();
      },

      // dataCache is mutated in place, but currentData and every derived view (calendar cells, rotation
      // turns, pivot grid, rsvp roster) are DERIVED — they only exist after loadTableData runs. Debounce
      // it: a remote client saving five columns arrives as five changes, and recomputing a rotation five
      // times to show one edit is the difference between live sync and a stuttering page.
      _liveRebuild: function() {
        var self = this;
        clearTimeout(self._liveRebuildTimer);
        self._liveRebuildTimer = setTimeout(function() { self.loadTableData(); }, 150);
      },

      loadTableData: function() {
        var self = this;
        var view = VIEWS[this.currentTable];
        if (view) {
          // Calendar view: load each distinct source table (deduped); the grid/panel read from
          // dataCache via calEventsFor. No stored calendar rows — pure presentation of source rows.
          if (view.calendar) {
            var calTables = [];
            self.calSources(self.currentTable).forEach(function(s) { if (s && s.table && calTables.indexOf(s.table) < 0) calTables.push(s.table); });
            // Also preload each rotationSource's rosters so generated duty events can resolve.
            self.calRotationSources(self.currentTable).forEach(function(rs) {
              rotationTables(VIEWS[rs.view]).forEach(function(tbl) { if (calTables.indexOf(tbl) < 0) calTables.push(tbl); });
            });
            self._ensureCached(calTables, null, self._viewNeedsArchive(self.currentTable));
            return;
          }
          // rotationView (third view kind): generate rows from range; no sources to read.
          if (view.rotation) {
            var todayStr = fmtDate(new Date());
            var regen = function() {
              var rows = buildRotationViewRows(view, self.dataCache, todayStr, self.anchorForView(self.currentTable), self.rangeForView(self.currentTable), self.rotateEveryForView(self.currentTable));
              if (view.filter) rows = filterRows(rows, self.resolveMeTokens(view.filter)); // filter generated period rows
              self.currentData = rows;
            };
            regen();
            var rvDef = view.rotation;
            self._ensureCached(rotationTables(view), regen);
            return;
          }
          // Pivot view: cross-tab of a source table/view. Load the source's table(s) into the reactive
          // dataCache; pivotFor() (read by the component) then builds the grid and re-derives on load.
          if (view.pivot) {
            self._ensureCached(VIEWS[view.pivot.source] ? (VIEWS[view.pivot.source].sources || []) : [view.pivot.source],
                               null, self._viewNeedsArchive(self.currentTable));
            return;
          }
          // RSVP view: load the events + responses tables; rsvpFor() builds the list, re-derives on load.
          if (view.rsvp) {
            var rsTables = (VIEWS[view.rsvp.events] ? (VIEWS[view.rsvp.events].sources || []) : [view.rsvp.events]).slice();
            if (view.rsvp.responses) rsTables.push(view.rsvp.responses);
            self._ensureCached(rsTables, null, self._viewNeedsArchive(self.currentTable));
            return;
          }
          // Union or join view
          // The archived tab is a PARTITION, not a store: an archived row now stays in the active store
          // carrying `_status`, so this used to rebuild the cache from dataCache[src__archive] and would
          // show only the rows filed away under the old model. buildRows takes the partition instead.
          var cache = self.dataCache;
          var part = self.viewingArchive ? 'archive' : 'active';
          var vMe = self._viewWithMe(view);
          // Interactive ‹ › period navigation: inject the current back-offset into bare @period tokens.
          if (view.period && self.periodOffset) {
            vMe = Object.assign({}, vMe);
            if (vMe.filter) vMe.filter = self.resolvePeriodTokens(vMe.filter, self.periodOffset);
            if (vMe.groupBy) { vMe.groupBy = Object.assign({}, vMe.groupBy); if (vMe.groupBy.filter) vMe.groupBy.filter = self.resolvePeriodTokens(vMe.groupBy.filter, self.periodOffset); }
          }
          var srcRows = buildRows(vMe, cache, part);
          // Resolve source-row computeds (e.g. a per-row lookup) BEFORE grouping so an aggregate can sum them.
          if (view.compute) srcRows = resolveComputed(srcRows, view.compute, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          var rows = resolveComputed(aggregateRows(vMe, srcRows), view.columns, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          self.currentData = rows;
          // Rebuild currentData once a late-arriving table lands in dataCache. Declared here (rather
          // than beside the rotation preload below) because the source preload needs it too.
          var recomputeRotation = function() {
            var vMe2 = self._viewWithMe(view);
            var src2 = buildRows(vMe2, self.dataCache, part);
            if (view.compute) src2 = resolveComputed(src2, view.compute, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
            self.currentData = resolveComputed(aggregateRows(vMe2, src2), view.columns, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          };
          // Preload the view's OWN sources. Every other branch of loadTableData does this (calendar,
          // rotation, pivot, rsvp via _ensureCached; a bare table lazily below), but the union/join
          // branch rendered straight out of dataCache and assumed boot had filled it — so any table
          // boot skipped left this view permanently empty rather than one frame late. That is precisely
          // the self-service case: an owner-column table a member reaches without a grant.
          // Archive mode reads the __archive partitions, which _ensureCached doesn't fetch — leave that
          // path alone rather than have it load the wrong partition.
          // Everything this view reads: its own sources, and whatever its column embeds resolve to.
          // That second half used to be an inline loop over `columns` that asked each embedded view for
          // its `sources` -- which is empty for a DOC-view, so a page embedded as a column never got its
          // own embeds' tables. The doc-view then found no rows, and hide-when-empty hid the whole block
          // including its prose. _viewTables answers this for every kind, recursively, and is the same
          // derivation loadPage uses.
          // Archive mode reads the __archive partitions, which _ensureCached doesn't fetch -- leave that
          // path alone rather than have it load the wrong partition.
          if (!self.viewingArchive) self._ensureCached(self._viewTables(self.currentTable), recomputeRotation,
                                                     self._viewNeedsArchive(self.currentTable));
          // Preload rotation-column dependencies (rotationTable + occurrenceSource), then recompute via
          // recomputeRotation (declared above, shared with the source preload).
          // The occurrenceSource ARCHIVE partition is also loaded so the occurrence rank stays absolute
          // (archived turns still count) even when preload_archive is off — see resolveComputed.
          (view.columns || []).forEach(function(c) {
            if (!c || typeof c !== 'object' || !c.computed || !c.computed.rotationTable) return;
            var comp = c.computed;
            var deps = [{ table: comp.rotationTable, part: 'active', key: comp.rotationTable }, { table: comp.occurrenceSource, part: 'active', key: comp.occurrenceSource }];
            if (comp.occurrenceSource) deps.push({ table: comp.occurrenceSource, part: 'archive', key: aKey(comp.occurrenceSource) });
            deps.forEach(function(dep) {
              if (!dep.table) return;
              self._liveWatch([dep.table], dep.part);   // a computed column is only as live as its inputs
              if (!self.canReachTable(dep.table) || self.dataCache[dep.key]) return;
              self._fetchTable(dep.table, dep.part, dep.key).then(recomputeRotation);
            });
          });
        } else {
          var key = self.viewingArchive ? aKey(self.currentTable) : self.currentTable;
          var tableDef = SCHEMA[self.currentTable];
          if (!tableDef) return;
          // Bare table: the one branch that doesn't route through _ensureCached, so it watches its own
          // partition here — and it is the only place `archive` is ever watched, since that is the only
          // partition a user can have open.
          self._liveWatch([self.currentTable], self.viewingArchive ? 'archive' : 'active');
          self._ensureDeps([self.currentTable]);   // ref/lookup sources: this branch skips _ensureCached
          // Through partitionRows, not dataCache[key]: `_status` on the row now decides its partition,
          // so the active store can hold a row that is filed away and the archive store one that has
          // been restored. Indexing by store name would show each in the wrong tab. It also always
          // returns an array, which the subscribeLoads path needs -- there the fetch below is skipped
          // and the cache stays undefined until the listener's first snapshot lands, so this runs once
          // with nothing in it and currentData must still be a list for the grid to render.
          var showRows = function() {
            var rows = Rows.partitionRows(self.dataCache, self.currentTable,
                                          self.viewingArchive ? 'archive' : 'active');
            if (tableDef.filter) rows = filterRows(rows, tableDef.filter);
            self.currentData = rows;
          };
          if (!self.dataCache[key] && !self._liveLoads(self.currentTable)) {
            var tab = self.viewingArchive ? 'archive' : 'active';
            self._fetchTable(self.currentTable, tab, key).then(function() {
              self._autoArchive();                    // same reason as in _ensureCached
              showRows();
            });
          } else {
            showRows();
          }
        }
      },

      // Column visibility is a question about a CONFIG, not about whatever is on screen: an embed has to
      // ask about the view it embeds. Both helpers take an optional config and default to the current
      // one, so the primary grid's call sites are unchanged while embed-view can pass its own — without
      // it, a `when`/`hideEmpty` column entry was silently ignored inside {{view:x}}, because the lookup
      // ran against the hosting doc-view's columns, which never contain the embedded view's entries.
      colHideEmpty: function(col, cfg) {
        cfg = cfg || this.currentConfig;
        var arr = Array.isArray(cfg.columns) ? cfg.columns : [];
        var entry = arr.find(function(c) { return colName(c) === col; });
        if (entry && typeof entry === 'object' && typeof entry.hideEmpty === 'boolean') return entry.hideEmpty;
        return !!cfg.hideEmpty;
      },
      isColumnHidden: function(col, item, cfg) {
        cfg = cfg || this.currentConfig;
        if (this.colHideEmpty(col, cfg) && !item[col]) return true;
        var cols = cfg.columns;
        if (!cols || !Array.isArray(cols)) return false;
        // `when` clause on a column entry: { "name": col, "computed"?: {...}, "when": { <condition> } }
        // — the canonical conditional form; gates the column per-row (legacy shorthand
        // { "<col>": {cond} } is rewritten to this at load by convertViewFilters).
        var named = cols.find(function(c) { return c && typeof c === 'object' && c.name === col && c.when; });
        if (named && !condMatches(item, named.when)) return true;
        return false;
      },

      // The grid's header click — same contract as rsvp/pivot, so it comes from the same place (SORT_UI).
      toggleSort: SORT_UI.toggleSort,

      // Cell editing
      saveField: function(item, col, value, ownerId) {
        // Coerce Vuetify {value,title} option objects to scalars, but preserve arrays (multiselect cells).
        if (typeof value === "object" && value !== null && !Array.isArray(value)) value = value.value || value.title || String(value);
        if (Array.isArray(value)) value = value.map(function(x) { return (x && typeof x === 'object') ? (x.value || x.title || String(x)) : x; });
        if (item[col] === value) return; // reference compare; arrays always differ -> always saved (intended)
        item[col] = value;
        item.updated_at = new Date().toISOString();
        var self = this;
        ownerId = ownerId || this.currentTable;
        var source = this.getSource(item, ownerId);
        // For join views, find which source table owns this column
        var view = VIEWS && VIEWS[ownerId];
        if (view && view.mode === 'join') {
          for (var i = 0; i < view.sources.length; i++) {
            var s = view.sources[i];
            if (SCHEMA[s] && SCHEMA[s].columns && SCHEMA[s].columns[col]) { source = s; break; }
          }
        }
        var tab = this.getTab(source);
        // Update cache
        var cacheKey = this.viewingArchive ? aKey(source) : source;
        var cached = this.dataCache[cacheKey];
        // Does this table already hold the row? Unknown (table not cached) counts as yes — the user is
        // editing it, so it exists somewhere. This decides partial-vs-whole below.
        var isNewRow = false;
        if (cached) {
          var cr = cached.find(function(r) { return r.id === item.id; });
          if (cr) { cr[col] = value; cr.updated_at = item.updated_at; }
          else {
            // Row doesn't exist in this table's cache — create it
            isNewRow = true;
            var newRow = { id: item.id, created_at: item.created_at || new Date().toISOString(), updated_at: item.updated_at };
            getColumns(source).forEach(function(c) { newRow[c] = (c === col) ? value : (item[c] || ''); });
            cached.push(newRow);
          }
        }
        // Save. A cell edit writes ONLY the column it changed (plus updated_at). Every backend merges a
        // partial putRow onto the stored row — Firestore set(…, {merge:true}), Supabase _merge, and the
        // SQLite/FS backends pinned by the "putRow merge semantics" suite in backend-conformance.test.js
        // — so this is the contract, not a shortcut. Sending the whole row (what this used to do) meant
        // two people editing different columns of the same row clobbered each other: each write carried
        // its author's stale copy of every column they hadn't touched. Invisible while nothing synced;
        // routine once it does.
        // The exception is a row THIS table has never seen (the cache-miss branch above — e.g. a mirror
        // with no counterpart row yet). That is a create, and a create has to carry every column.
        var timerKey = source + ':' + item.id + ':' + col;
        clearTimeout((self.saveTimers || {})[timerKey]);
        if (!self.saveTimers) self.saveTimers = {};
        self.saveTimers[timerKey] = setTimeout(function() {
          // Drop the key before anything else: _liveHeld treats a lingering timer entry as "an edit is
          // still in flight" and would hold remote changes back forever.
          delete self.saveTimers[timerKey];
          var row;
          if (isNewRow) {
            row = {};
            getColumns(source).forEach(function(c) { row[c] = item[c] || ''; });
            row.id = item.id;
            row[col] = value;
            if (!row.created_at) row.created_at = new Date().toISOString();
          } else {
            row = { id: item.id };
            row[col] = value;
          }
          row.updated_at = new Date().toISOString();
          Writes.putRow(source, row, tab);
          // Propagate to mirror tables if this column is mirrored. This takes the LIVE row, not the
          // payload: `row` is now a partial, and propagateMirror reads every synced column off it —
          // given the partial it would blank each one it couldn't find.
          self.propagateMirror(item.id, source, item);
          self.notify(self.t('msg.saved'));
          self._liveFlush();      // the write is out; let anything held during the edit land
        }, 300);
      },

      // THE blank-row factory: every add path (the grid's addRow, embedAddRow, the calendar's
      // add-on-day) goes through here. Creates the row across the whole mirror cluster under one id
      // (consistent with archive/delete), stamps the owner, seeds `position` on a reorderable table,
      // writes through to the backend, and returns the PRIMARY row.
      // Previously each caller hand-rolled this, and they drifted: only addRow seeded `position`, so a
      // row added to a reorderable table from an embed or the calendar sorted after every placed row.
      // opts: { tab: 'active'|'archive' (default active), prefill: { col: value } }
      _createBlankRow: function(primary, opts) {
        var self = this, o = opts || {}, tab = o.tab || 'active', prefill = o.prefill || {};
        var id = this.generateId(), primaryRow = null;
        withMirrors([primary]).forEach(function(src) {
          var row = { id: id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          var cols = getColumns(src);
          cols.forEach(function(c) { if (!row[c]) row[c] = ''; });
          // Stamp owner on create, and with it the table's roster policy. rosterPublic has to ride on the
          // ROW because both rules layers are schema-blind (firestore.rules `resource.data.rosterPublic`,
          // supabase app_can_read) — without it an owner-stamped row is readable only by its owner, so a
          // shared leaderboard over a self-service table would show each member only themselves. This is
          // the same policy the rsvp writer applies (saveRsvp); it belongs on every owner table, not just
          // the one view kind that happened to implement it first.
          var oc = getOwnerCol(src);
          if (oc) {
            row[oc] = self.currentUserEmail || '';
            row.rosterPublic = !(SCHEMA[src] && SCHEMA[src].privateRoster);
          }
          // Seeded-on-create columns: a `defaultFrom` token resolved per user, or a literal `default`.
          // Both stay editable afterwards (unlike owner), and an explicit prefill below overrides them.
          getDefaultCols(src).forEach(function(dc) {
            if (cols.indexOf(dc.name) < 0) return;
            row[dc.name] = dc.from ? self.defaultFromValue(dc.from, dc.name) : dc.value;
          });
          for (var pc in prefill) { if (cols.indexOf(pc) >= 0) row[pc] = prefill[pc]; }  // only columns the mirror actually has
          var cacheKey = tab === 'archive' ? aKey(src) : src;
          if (!self.dataCache[cacheKey]) self.dataCache[cacheKey] = [];
          // Reorderable tables order by `position`; seed the next number so new rows append in order
          // (otherwise they get an empty position and the hardened sort floats them after positioned rows).
          if (SCHEMA[src] && SCHEMA[src].reorderable) {
            var mp = 0;
            self.dataCache[cacheKey].forEach(function(r) { var n = Number(r.position); if (!isNaN(n) && n > mp) mp = n; });
            row.position = String(mp + 1);
          }
          self.dataCache[cacheKey].push(row);
          Writes.putRow(src, row, tab);
          if (src === primary) primaryRow = row;
        });
        return primaryRow;
      },

      // Add row
      addRow: function() {
        var self = this;
        var view = VIEWS[this.currentTable];
        var primary = view ? view.sources[0] : this.currentTable;
        var primaryRow = this._createBlankRow(primary, { tab: this.viewingArchive ? 'archive' : 'active' });
        if (view) {
          var viewRow = Object.assign({}, primaryRow);
          if (view.mode === 'union') viewRow._source = primary;
          self.currentData.push(viewRow);
        } else if (primaryRow) {
          // A bare table used to need nothing here: currentData WAS dataCache[table] -- the same array
          // object -- so the push inside _createBlankRow showed up on screen by aliasing. currentData is
          // now derived (partitionRows returns a fresh list, because a partition is no longer one
          // store), and a derived list does not gain rows by accident. Pushing explicitly is what that
          // aliasing was silently doing, and it says so now.
          self.currentData.push(primaryRow);
        }
        self.notify(self.t('msg.row_added'));
        self.focusLastEditable('.v-table tbody tr:last-child .editable-cell');
      },

      deleteRow: function(item) {
        var key = 'row:' + item.id;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        var view = VIEWS[this.currentTable];
        var sources = withMirrors(view ? view.sources : [this.getSource(item)]);
        this._deleteFromSources(sources, item.id, this.viewingArchive);
      },

      // Archive / Restore
      archiveRow: function(item) {
        var view = VIEWS[this.currentTable];
        var sources = withMirrors(view ? view.sources : [this.getSource(item)]);
        this._archiveInSources(sources, item.id);
        this.currentData = this.currentData.filter(function(r) { return r.id !== item.id; });
      },

      restoreRow: function(item) {
        var self = this;
        var view = VIEWS[this.currentTable];
        var sources = withMirrors(view ? view.sources : [this.getSource(item)]);
        sources.forEach(function(source) {
          var schema = SCHEMA[source];
          if (!schema) return;
          var stamp = new Date().toISOString();
          // A row archived under the FIELD model never left the active store, so restoring it is the
          // same field write in reverse.
          var live = (self.dataCache[source] || []).find(function(r) { return r.id === item.id; });
          if (live && Rows.partitionOf(live, 'active') === 'archive') {
            live._status = 'active';
            live.updated_at = stamp;
            Writes.putRow(source, { id: item.id, _status: 'active', updated_at: stamp }, 'active');
            return;
          }
          // A row archived under the STORE model is still sitting in the archive collection, and every
          // deployment has some. Those still move -- writing `_status: 'active'` onto a row in the
          // archive store would be honoured by partitionRows, but only for a session that had loaded
          // that store, and boot does not load it unless `preload_archive` is on. The row would appear
          // to vanish from both tabs. Moving it is what keeps it visible; the stamp makes it
          // unambiguous once it lands.
          var cached = self.dataCache[aKey(source)] || [];
          var srcRow = cached.find(function(r) { return r.id === item.id; });
          if (!srcRow) return;
          srcRow._status = 'active';
          self.dataCache[aKey(source)] = cached.filter(function(r) { return r.id !== item.id; });
          if (!self.dataCache[source]) self.dataCache[source] = [];
          self.dataCache[source].push(srcRow);
          Writes.moveRow(source, srcRow, 'archive', 'active');
        });
        self.currentData = self.currentData.filter(function(r) { return r.id !== item.id; });
        self.notify(self.t('msg.restored'));
      },

      // Column helpers
      colIsDate: function(col) { return Columns.colIsDate(SCHEMA, col); },
      colIsNumber: function(col) { return Columns.colIsNumber(SCHEMA, col); },
      colIsImage: function(col) { return Columns.colIsImage(SCHEMA, col); },
      colIsUrl: function(col) { return Columns.colIsUrl(SCHEMA, col); },
      colPicker: function(col) { return Columns.colPicker(SCHEMA, col); },
      toDateStr: function(v) { return toDateStr(v); },
      // Whether the active backend can store an uploaded file (Firebase Storage). Other backends lack it,
      // so an `image` column degrades to a paste-a-URL text input. See uploadFile.
      canUploadFiles: function() { return !!(typeof backend !== 'undefined' && backend && backend.uploadFile); },
      // Upload a File/Blob to the backend's blob store; resolves to a stored URL (kept in the row, not the
      // bytes — see the image/url column type). Rejects on backends without file storage.
      uploadFile: function(file, opts) {
        if (!this.canUploadFiles()) return Promise.reject(new Error('This backend has no file storage'));
        return backend.uploadFile(file, opts || {});
      },
      colIsList: function(col) { return Columns.colIsList(SCHEMA, col); },
      colIsMultiselect: function(col) { return Columns.colIsMultiselect(SCHEMA, col); },
      // A `list:` may name a LOOKUP TABLE instead of a list, and then its options are that table's rows.
      // One catalogue can then back both a `ref` column (which carries the row's other fields — a chore's
      // points) and a plain select/multiselect that only needs the name, instead of maintaining a second
      // free-string list beside it that nothing can score. `translatableLists` already accepts a lookup
      // table name for the same reason. The option VALUE is the lookup's first visible column (its name
      // column, the same one `ref.valueCol` defaults to); the rest of the row is reference data.
      lookupListValues: function(name) {
        if (!name || !SCHEMA[name] || !SCHEMA[name].isLookup) return null;
        var scols = SCHEMA[name].columns || {};
        var valueCol = getColumns(name).filter(function(c) {
          if (c === 'id' || c === 'created_at' || c === 'updated_at') return false;
          var d = scols[c];
          return !(d && typeof d === 'object' && d.hidden);
        })[0];
        if (!valueCol) return [];
        var seen = {}, out = [];
        (this.dataCache[name] || []).forEach(function(r) {
          var v = r[valueCol];
          if (v == null || v === '' || seen[v]) return;
          seen[v] = 1; out.push(v);
        });
        return out;
      },
      getListOptions: function(col, altList) {
        var self = this;
        var listName = altList || this.colIsList(col);
        var fromLookup = this.lookupListValues(listName);
        var items = fromLookup || (listName && this.listsCache[listName] ? this.listsCache[listName] : []);
        var result = items.map(function(v) { return { title: self.listLabel(listName, v), value: v }; });
        if (this.colIsSorted(col)) result.sort(function(a, b) { return a.title.localeCompare(b.title); });
        return result;
      },
      colListSwitch: function(col) { return Columns.colListSwitch(SCHEMA, col); },
      isAltList: function(col, item) {
        var key = item && item.id ? item.id + '_' + col : '';
        if (this.listSwitchOverrides[key] !== undefined) return this.listSwitchOverrides[key];
        var sw = this.colListSwitch(col);
        if (!sw || !item || !item[col]) return false;
        var altItems = this.listsCache[sw.list] || [];
        return altItems.indexOf(item[col]) >= 0;
      },
      toggleListSwitch: function(col, item) {
        var key = item.id + '_' + col;
        this.listSwitchOverrides[key] = !this.isAltList(col, item);
      },
      // The list a column's values come from: its own `list`, or — for an aggregate GROUP column (e.g.
      // piispakunta grouped from vastuussa) — the list of the source column(s) it groups from. Shared by
      // label translation and linked-user avatars, so both resolve the synthetic group column identically.
      listNameForCol: function(col) {
        var listName = this.colIsList(col);
        if (!listName) { var v = VIEWS[this.currentTable]; if (v && v.groupBy && typeof v.groupBy === 'object' && v.groupBy.column === col && v.groupBy.from) { for (var i = 0; i < v.groupBy.from.length && !listName; i++) listName = this.colIsList(v.groupBy.from[i]); } }
        return listName;
      },
      // `nsCol` resolves the translation NAMESPACE from a different column than the one being rendered.
      // A rotation cell is the case that needs it: the column is a SLOT ('Ann'), which is not a schema
      // column at all, while the values come from the roster's `valueCol` and carry its list. Without
      // the split the matrix showed raw values -- the one surface where a translated vocabulary did not
      // reach. Obscuring deliberately still keys on `col`, because `obscureNames` on a rotation asks
      // "does this COLUMN hold names?", which is a question about the slot, not about the value's origin.
      // `viewCfg` is the view whose `obscureNames` governs this rendering. It defaults to the CURRENT
      // view, which is right for the top-level grid and wrong everywhere else: an embedded view and a
      // calendar's rotation overlay both render one view's rows inside another view's screen, and
      // `currentTable` names the host. So a view that asked for abbreviated names printed them in full
      // the moment it was embedded, and the host's own obscureNames array reached across into columns
      // it was never written for.
      displayValue: function(col, val, nsCol, viewCfg) {
        if (Array.isArray(val)) { var self = this; return val.map(function(x) { return self.displayValue(col, x, nsCol, viewCfg); }).filter(Boolean).join(', '); }
        if (!val) return '';
        var out = val;
        // Translation namespace: a list column uses its list name; a `ref` column uses its lookup TABLE name,
        // so ref-backed values (e.g. a board's 2-D ref lane and its group dimension) localize through the same
        // `list.<ns>.<value>` keys as list values do. Either way it falls back to the raw value.
        var nsSrc = nsCol || col;
        var ns = this.listNameForCol(nsSrc);
        if (!ns && this.colIsRef(nsSrc)) { var rf = this.colRef(nsSrc); ns = rf && rf.table; }
        if (ns) out = this.listLabel(ns, val);
        return this.shouldObscure(col, viewCfg) ? obscureName(out) : out;
      },
      // THE label for a list value in namespace `ns`, in precedence order:
      //
      //   1. the linked account's profile name -- only for a `userlink-name` list, which exists to ask
      //      exactly this question ("who is the bishop?") of a value that names a role, not a person.
      //   2. the `list.<ns>.<value>` translation.
      //   3. the raw value.
      //
      // Steps 2 and 3 used to be written twice: once here (for the rendered cell) and once in
      // getListOptions (for the dropdown that edits it). Two copies of a label rule is two answers the
      // moment one of them grows a case -- which is precisely what happened when the linked name was
      // added and the cell started disagreeing with its own editor.
      listLabel: function(ns, val) {
        if (!ns) return val;
        var linked = (this.isUserNameList(ns) && window.ListUsers)
          ? window.ListUsers.nameFor(this.listAvatars, ns, val) : '';
        if (linked) return linked;
        var key = 'list.' + ns + '.' + val;
        var translated = this.t(key);
        return translated !== key ? translated : val;
      },
      // Whether a view obscures person names in `col`. obscureNames: true = all list/multiselect
      // columns (or all area columns for a rotationView); an array = exactly those columns. Display-only.
      //
      // Takes the view CONFIG rather than looking one up, because the caller is the only one who knows
      // which view is being rendered: an inline embed carries its own config and has no name at all.
      // Falls back to the current view for the top-level screens, which is every caller that has no
      // other view in play.
      shouldObscure: function(col, viewCfg) {
        var v = viewCfg || VIEWS[this.currentTable];
        if (!v || !v.obscureNames) return false;
        if (Array.isArray(v.obscureNames)) return v.obscureNames.indexOf(col) >= 0;
        // A membership test, not the ordered slot list: this runs once per rendered CELL, and for a
        // rosterRef rotation the list costs a copy, a sort and a bucketing of the whole roster --
        // each of which also makes every cell a reactive reader of the entire roster table.
        if (v.rotation) { return Rotation.isSlot(v.rotation, this.dataCache, col); }
        return !!this.colIsList(col) || this.colIsMultiselect(col);
      },
      isLockedValue: function(listName, val) {
        var lv = this.lockedListValues;
        return !!(lv[listName] && lv[listName][val]);
      },
      // A ref/lookup row is "locked" when any of its cell values is a filter-pinned value for that table
      // (lockedListValues keys ref tables by name too — see forEachFilterListValue). Filter-referenced lookup
      // rows must not be renamed/deleted or the filter keying on them silently breaks; the ref editor honors
      // this the same way the Lists editor does for list values.
      isLockedRefRow: function(item) {
        var t = this.currentRefTable, lv = t && this.lockedListValues[t];
        if (!lv || !item) return false;
        return this.refTableCols.some(function(c) { return !!lv[item[c]]; });
      },
      refParentLocked: function(parent) {
        var self = this;
        return (this.refGroupedData[parent] || []).some(function(it) { return self.isLockedRefRow(it); });
      },
      // Translated label for a lookup value, keyed by its table's namespace (list.<table>.<value>) — the same
      // key the board/grid resolve through. The ref editor shows this for locked (filter-pinned) rows so their
      // link to `list.<table>.<value>` translations is visible, mirroring how the Lists editor labels values.
      // Opening a lookup in the editor is what LOADS it. Boot fetches no table data, and a lookup is
      // otherwise cached only as a side effect of some view that happens to reference it -- so the
      // editor rendered an empty catalogue until you had visited a view using that table and come
      // back, which reads as "this lookup has no rows" rather than as "this screen has not fetched
      // them". Exactly the hole _ensureTranslatableLookups closes for the Languages screen, and the
      // same answer: asking to edit a table IS the declaration that it must be there. _ensureCached is
      // a no-op for one already loaded, so switching between lookups costs nothing after the first.
      selectRefTable: function(rt) {
        this.currentRefTable = rt;
        if (rt) this._ensureCached([rt]);
      },
      refValueLabel: function(val) { var t = this.currentRefTable; return t ? this.tOr('list.' + t + '.' + val, val) : val; },
      // A lookup opted into `translatableLists` is a translatable controlled vocabulary: its values ARE the
      // `list.<table>.<value>` translation keys, so an EXISTING value can't be renamed in the ref editor (that
      // would orphan its translation + every row storing it) — labels are set in Languages → Lists. A blank
      // new cell stays editable so you can type its initial key; filter-pinned rows are always read-only.
      isTranslatableRefTable: function() { return (((this.schemaData && this.schemaData.translatableLists) || []).indexOf(this.currentRefTable) >= 0); },
      // A lookup value is READ-ONLY only when a schema filter/conditional pins it (renaming would break that
      // filter) — being merely translatable no longer locks it, so existing values stay renamable. A locked
      // value shows its translated label; everything else is editable (raw). The translate icon is a separate,
      // purely informational badge (see the editor templates).
      isLockedRefValue: function(val) { var lv = this.lockedListValues[this.currentRefTable]; return !!(lv && val != null && lv[val]); },
      isReadonlyRefCell: function(item, col) { return !this.canEditCurrentRef || this.isLockedRefValue(item && item[col]); },
      // Whether a plain list is opted into `translatableLists` (its values have list.<list>.<value> labels).
      // Used only to show the translate badge in the Lists editor — values stay editable unless filter-pinned.
      isTranslatableList: function(name) { return (((this.schemaData && this.schemaData.translatableLists) || []).indexOf(name) >= 0); },
      colAllowNew: function(col) { return Columns.colAllowNew(SCHEMA, col); },
      colIsSorted: function(col) { return Columns.colIsSorted(SCHEMA, col); },
      // May I change this list — add, rename, reorder, remove a value? Admin: any list. Everyone else:
      // only the lists the schema opens, and a TABLE GRANT IS NOT PART OF THE QUESTION. It deliberately
      // is not: a list belongs to every table whose columns reference it, so keying on the grant meant
      // one rw table (home_shopping) handed over every list its columns touched — `members` included.
      // The allowlist says what it means, and the same predicate runs in the dev server and both rules
      // layers, so the editor never offers a write the server will refuse.
      canEditList: function(listName) {
        // A lookup-backed "list" is a TABLE — it is maintained in the Lookup editor (which has its own
        // r/rw gate), never through the list write path, so no list rule applies to it.
        if (SCHEMA[listName] && SCHEMA[listName].isLookup) return false;
        return this.isAdmin || this.userWritableLists.indexOf(listName) >= 0;
      },
      canAddToList: function(listName) { return this.canEditList(listName); },
      addToListOnBlur: function(item, col) {
        var value = item[col];
        if (!value) return;
        var listName = this.colIsList(col);
        // When the cell is switched to the alt list (the swap arrow), a newly typed name must be added to
        // that alt list — not the primary one. Mirrors listItems()/isAltList() so the dropdown and the
        // append target stay in sync.
        var sw = this.colListSwitch(col);
        if (sw && sw.list && this.isAltList(col, item)) listName = sw.list;
        if (!listName || !this.listsCache[listName]) return;
        // Adding a value is a list WRITE. Admin-only unless the schema opens this list to members —
        // otherwise the value went into listsCache, the server refused the putListItem, and the option
        // vanished on the next reload with nothing said.
        if (!this.canAddToList(listName)) return;
        var self = this, vals = Array.isArray(value) ? value : [value];
        vals.forEach(function(v) {
          if (v && self.listsCache[listName].indexOf(v) === -1) {
            self.listsCache[listName].push(v);
            backend.putListItem(listName, v);
          }
        });
      },

      colIsRef: function(col) { return Columns.colIsRef(SCHEMA, col); },
      // The `ref` config for a column, found across whichever table declares it (columns aren't view-scoped).
      // Shared by displayValue's ref-translation namespace and the board's 2-D ref lane grouping.
      // The any-table ref def for a column. `null` table = the memoized scan in columns.js, the same
      // one colIsList/colIsRef/colIsDate use — this was the last hand-written O(tables) loop of that
      // family, and it sits on the per-cell path (displayValue, right after the O(1) colIsRef).
      colRef: function(col) { return getColumnRef(null, col); },
      colIsMirrorForTable: function(col) {
        var table = this.currentTable;
        if (VIEWS[table]) return false;
        return colIsMirror(SCHEMA, col, table);
      },
      // Which TABLE a view's column actually belongs to. A union row carries `_source`; otherwise ask the
      // view's own sources which one declares the column (a join view spans several). Falls back to the
      // id itself, so a bare table is unchanged.
      //   This used to resolve any NON-UNION view to the view's own name — which is not a table, so every
      // schema lookup keyed on it silently missed. An `owner` column listed in a view therefore rendered
      // EDITABLE (chore_board lists it as "Logged by"), letting a member re-stamp who logged a row and,
      // by handing it to someone else, lock themselves out of their own card. Mirror (`syncFrom`) columns
      // were missing their read-only treatment the same way.
      tableForCol: function(ownerId, item, col) {
        var view = VIEWS && VIEWS[ownerId];
        if (!view) return ownerId;
        if (item && item._source && SCHEMA[item._source]) return item._source;
        var srcs = (view.sources || []).filter(function(t) { return SCHEMA[t] && SCHEMA[t].columns && SCHEMA[t].columns[col]; });
        if (!srcs.length) return ownerId;      // no source owns it -> resolve nothing, as before
        // Prefer a source where the column is NOT mirrored. A join spanning a master and its mirror
        // declares the column on both sides, and it is editable through the MASTER (the write syncs
        // outward); resolving to the mirror would freeze a column the view exists to edit.
        for (var i = 0; i < srcs.length; i++) { if (!colIsMirror(SCHEMA, col, srcs[i])) return srcs[i]; }
        return srcs[0];
      },
      isReadonlyCell: function(item, col, ownerId) {
        ownerId = ownerId || this.currentTable;
        var view = VIEWS && VIEWS[ownerId];
        var table = this.tableForCol(ownerId, item, col);
        // syncFrom (mirror) columns are synced from a master -> read-only in the detail table
        if (table && SCHEMA[table] && colIsMirror(SCHEMA, col, table)) return true;
        // owner columns are auto-stamped with the current user's email and immutable
        if (table && getColumnType(table, col) === 'owner') return true;
        // In union views, grey out columns that don't belong to the row's source table
        if (!view || view.mode !== 'union' || !item._source) return false;
        return !(SCHEMA[item._source] && SCHEMA[item._source].columns && SCHEMA[item._source].columns[col]);
      },
      // Is a view/table read-only as a whole (config flag, viewer role, aggregate, or a read-only grant)
      // Rows a view SHOWS but does not own: an explicit `readonly: true`, or rows that are SYNTHETIC —
      // aggregate/groupBy lines and pivot cells, which stand for many source rows rather than one. There
      // is nothing to add to either. Deliberately separate from viewReadonly's GRANT-derived answer,
      // which self-service is designed to override (an owner-column table is exactly where a member
      // holding only `r` may still add their own row). Self-service must not override THIS: the row an
      // Add writes lands in the source table and cannot satisfy the view that offered the button — the
      // leaderboard's `status: approved` filter, say — so the button reads as "Add does nothing", while
      // the blank row it wrote shows up in whatever view DOES list that table.
      viewAddBlocked: function(id) {
        var v = VIEWS[id];
        return !!(v && (v.readonly || v.groupBy || v.aggregate || v.pivot));
      },
      viewReadonly: function(id) {
        var v = VIEWS[id], cfg = VIEWS[id] || SCHEMA[id] || {};
        if (!!cfg.readonly || this.currentUserRole === 'viewer' || !!(v && v.groupBy && v.collect)) return true;
        return !this.grantAllowsWrite(id);
      },
      // Does my grant permit writing everything behind this view/table? Before per-table modes this was
      // implied — a table you couldn't write was a table you couldn't see — so cell editing never had to
      // ask. A read-only grant breaks that implication: the table is visible and must stay uneditable.
      grantAllowsWrite: function(id) {
        var writable = this.userWritableTables;
        if (!writable) return true;                       // admin / unrestricted: skip the work entirely
        var base = this.writeBaseFor(id);
        if (!base.length) return true;                    // sourceless (calendar/pivot/doc): nothing to write
        return withMirrors(base).every(function(t) { return writable.indexOf(t) >= 0; });
      },
      // The tables whose WRITE access governs a view or table. A data view answers with its `sources`,
      // a bare table with itself — and a rotationView with its ROSTERS. A rotation generates its rows,
      // so it used to answer with an empty `sources` and every write gate concluded "nothing to write
      // here, allow it" — which handed a read-only member the toolbar that rewrites the shared rotation
      // config (anchor / window / rotateEvery) for the whole deployment. The rosters ARE the rotation,
      // so the honest question is whether the viewer may write them.
      writeBaseFor: function(id) {
        var v = VIEWS[id];
        if (v && v.rotation) return rotationTables(v);
        return v ? (v.sources || []) : (SCHEMA[id] ? [id] : []);
      },
      // Shared gate for whether a data cell renders read-only (ownerId defaults to currentTable).
      // On a self-service table the viewer-role blanket-readonly yields to per-row ownership: I may edit
      // MY rows, others stay read-only (owner/mirror/union-foreign columns are always read-only).
      cellReadonly: function(item, col, ownerId) {
        if (this.isReadonlyCell(item, col, ownerId)) return true;
        // A STAMPED column is filled in by the app and rewritten by nobody. Every write layer refuses a
        // change to it from anyone but an admin, so offering an editor here would only produce a refused
        // write -- or, worse, an optimistic value that never lands. Deliberately checked BEFORE the
        // self-service branch below and outside it: a table grant does not lift a stamped column, which
        // is exactly what distinguishes it from the identity column.
        var sbTable = item ? this.getSource(item, ownerId) : null;
        var sb = sbTable ? stampedBoundsFor(sbTable) : null;
        if (sb && sb.col === col && !this.isAdmin) return true;
        // Which self-service table governs this cell: the open grid's own, or — when `ownerId` names an
        // EMBEDDED view/table — that embed's source. Without the second case an embedded self-service
        // view rendered every cell read-only while the same view opened top-level stayed editable.
        var st = (!ownerId || ownerId === this.currentTable)
          ? (this.currentSelfService ? this.selfServeTable : null)
          : this.embedSelfServeTable(VIEWS[ownerId] ? 'view' : 'table', ownerId);
        if (st) {
          // The IDENTITY column is read-only for its owner even though it is owner-writable: the write
          // layers require it to carry the caller's own value, so offering an editor here would only
          // produce a refused write (or, worse, an optimistic value that never lands).
          var bounds = ownerBoundsFor(st);
          if (bounds && bounds.identityCol === col && bounds.identityList) return true;
          return !this.rowOwnedByMe(item, st)
            || !this.ownerRowWritable(item, st)     // out of its editable state -> frozen
            || !this.ownerCanWrite(st, col);
        }
        return this.cellGrantReadonly(ownerId || this.currentTable, item, col);
      },
      // The view-level reasons a cell cannot be edited, MINUS the mirror-cluster grant rule.
      //
      // viewReadonly() answers for the ROW CONTROLS (add/delete/archive). Those fan out across the whole
      // mirror cluster — deleting a meeting deletes its music row — so demanding write on every table in
      // the cluster is right for them. A cell edit does not fan out: propagateMirror writes a mirror
      // table only when a MIRRORED column's value actually changes, and the mirrored columns are already
      // read-only in a detail (isReadonlyCell). Editing `accompanist` on a detail therefore writes that
      // detail and nothing else — exactly what firestore.rules permits, since hasTableWrite() asks about
      // one table.
      //
      // Applying the cluster rule here refused writes the server allows. Because withMirrors() is a
      // transitive closure in both directions, a grant on one detail pulled in the master AND every
      // sibling detail, and `.every()` meant one missing table greyed out the entire grid — so "may edit
      // the music" was not grantable without also handing over write on the meetings table.
      cellGrantReadonly: function(id, item, col) {
        var v = VIEWS[id], cfg = v || SCHEMA[id] || {};
        if (!!cfg.readonly || this.currentUserRole === 'viewer' || !!(v && v.groupBy && v.collect)) return true;
        var writable = this.userWritableTables;
        if (!writable) return false;                        // admin / unrestricted
        // Which table this particular cell belongs to — a view can draw columns from several, and a
        // grant on one of them should not open the others.
        var table = this.tableForCol(id, item, col) || this.getSource(item, id);
        // Nothing to attribute the cell to: keep the view-wide answer rather than guess in the open
        // direction. This is the branch a sourceless view (calendar/pivot/doc) lands in.
        if (!table || !SCHEMA[table]) return this.viewReadonly(id);
        return writable.indexOf(table) < 0;
      },
      // A table a restricted member may self-serve: it has an owner column, they have no grant on it, and
      // it isn't part of a mirror cluster (adds fan out across the cluster -> keep self-service to simple
      // single-table owned rows). Admin/unrestricted (allowed == null) use full access, not self-service.
      canSelfServe: function(table) {
        // Keyed on the WRITABLE set: a read-only grant on an owner-column table still routes writes
        // through self-service, giving "see every row, change only my own" — the shared-log policy.
        var allowed = this.userWritableTables;
        // Must be a REGISTERED member with an identity. userWritableTables is [] for both "registered, no
        // grants" and "not a member (fail closed)" -- isUnregisteredUser separates them so self-service
        // never opens a table to a non-member.
        if (!allowed || !this.currentUserEmail || this.isUnregisteredUser) return false;
        if (!table || !getOwnerCol(table) || allowed.indexOf(table) >= 0) return false;
        return withMirrors([table]).length === 1;
      },
      // The single reachability test every READ gate asks: unrestricted, granted ('r' or 'rw'), or
      // self-serviceable (an owner-column table whose rows the rules scope to me). Nav, embeds, the boot
      // preload and _ensureCached all have to answer this the same way -- when they drifted, a view
      // appeared in the menu with nothing behind it, or its data loaded for a view the menu had hidden.
      canReachTable: function(table) {
        var allowed = this.userAllowedTables;
        if (!allowed) return true;                 // admin / unrestricted
        return allowed.indexOf(table) >= 0 || this.canSelfServe(table);
      },
      // Resolve a column's `defaultFrom` token to the value stamped on a new row. Unknown tokens stamp
      // blank rather than writing the token text, so a typo can't end up looking like data.
      defaultFromValue: function(token, col) { return token === '@me' ? this.meValueFor(col) : ''; },
      // Columns an OWNER-scoped write may touch on a self-service table, per the table's `ownerWritable`
      // (mirrored to _meta/ownerWritable for the rules — see BackendHelpers.ownerWritableOf). null = the
      // table sets no bound, so the owner may write the whole row, which is the historical behaviour.
      ownerWritableCols: function(table) {
        var list = SCHEMA[table] && SCHEMA[table].ownerWritable;
        return Array.isArray(list) ? list : null;
      },
      // Offer only what the server will accept: without this the UI shows an editor / a draggable card,
      // the write is denied, and the value silently snaps back with no explanation.
      ownerCanWrite: function(table, col) {
        var list = this.ownerWritableCols(table);
        return !list || list.indexOf(col) >= 0 || ['id', 'owner', 'created_at', 'updated_at', 'rosterPublic'].indexOf(col) >= 0;
      },
      // `ownerWritableWhile: { <col>: <value|[values]> }` — an owner-scoped write reaches a row only
      // while it is still in one of those states. `ownerWritable` says WHICH fields; this says UNTIL
      // WHEN. Without it a member could keep editing (or delete) their entry after it was approved,
      // because ownership never expires. The predicate is BackendHelpers.ownerRowInState, the same one
      // the dev server runs, so the UI offers exactly what the write layers will accept.
      ownerRowWritable: function(item, table) {
        return BackendHelpers.ownerRowInState(ownerBoundsFor(table || this.currentTable), item);
      },
      // Row belongs to the current user (its owner column equals my email, case-insensitive).
      rowOwnedByMe: function(item, table) {
        var oc = getOwnerCol(table);
        return !!oc && String((item && item[oc]) || '').toLowerCase() === this.myEmailLc;
      },
      // Per-row mutate gate for the row-control column: normal tables defer to canMutateRows (table-level);
      // a self-service table restricts delete/archive to my own rows.
      // Delete / archive / (board) card controls. Self-service adds two conditions to "may I write here":
      // the row is mine, AND it is still in a state my owner-grant reaches — approving a row takes it out
      // of my hands entirely, which is the point of an approval.
      canMutateRow: function(item) {
        if (!this.currentSelfService) return true;
        return this.rowOwnedByMe(item, this.selfServeTable) && this.ownerRowWritable(item, this.selfServeTable);
      },
      // What a cell's options are, whichever side they come from. The multiselect branches used to call
      // getListOptions unconditionally, which returns [] for a `ref` -- its values live in a lookup
      // TABLE, not a list -- so a multi-valued ref would have rendered an empty picker.
      cellOptions: function(col, item) {
        return this.colIsRef(col) ? this.getRefOptions(col, item) : this.getListOptions(col);
      },
      // Options for a `ref` cell: the lookup's rows, labelled the way every other surface labels them.
      //
      // The label rule is listLabel's -- `list.<ns>.<value>`, falling back to the raw value -- and the
      // namespace for a ref is its lookup TABLE, exactly as displayValue resolves it. This used to emit
      // the raw value as the title, which made the picker the one place a translated vocabulary did not
      // reach: in the bishopric schema `organization` (a select whose `list:` names ref_callings) came
      // out "Primary" while `calling` (a ref into the same table, sharing the same
      // list.ref_callings.<value> keys) came out "president" -- two dimensions of ONE catalogue,
      // disagreeing inside one row. The cell already read "President" via displayValue, so clicking into
      // it swapped the label for its key.
      //
      // Values are unaffected: `value` stays the raw key, and so do the `counts`/`seen` maps below --
      // what a row IS is its stored value, and only the title is a display concern.
      getRefOptions: function(col, item) {
        var ref = getColumnRef(null, col);   // memoized any-table scan (see colRef); was the same loop
        if (!ref) return [];
        var self = this, ns = ref.table;
        var rows = this.dataCache[ref.table] || [];
        if (ref.filterBy) {
          var filterBy = ref.filterBy;
          var hasFilter = false;
          for (var k in filterBy) { if (item[filterBy[k]]) { hasFilter = true; break; } }
          if (hasFilter) {
            rows = rows.filter(function(r) {
              for (var refCol in filterBy) {
                var val = item[filterBy[refCol]];
                if (val && r[refCol] !== val) return false;
              }
              return true;
            });
          }
        }
        var valueCol = ref.valueCol;
        // When filterBy exists but no filter applied, show all with disambiguation for duplicates
        if (ref.filterBy && !hasFilter) {
          var parentCol = Object.keys(ref.filterBy)[0];
          // Count occurrences of each value
          var counts = {};
          rows.forEach(function(r) { var v = r[valueCol]; if (v) counts[v] = (counts[v] || 0) + 1; });
          var seen = {};
          var items = [];
          rows.forEach(function(r) {
            var v = r[valueCol];
            if (!v || seen[v + '|' + r[parentCol]]) return;
            seen[v + '|' + r[parentCol]] = true;
            // Both halves: the parent is a value of this same catalogue (ref_callings holds the
            // organizations too), so leaving it raw would print "President (aaronic_priesthood)".
            var title = counts[v] > 1
              ? self.listLabel(ns, v) + ' (' + self.listLabel(ns, r[parentCol]) + ')'
              : self.listLabel(ns, v);
            items.push({ title: title, value: v });
          });
          return items;
        }
        var seen = {};
        var opts = [];
        rows.forEach(function(r) {
          var v = r[valueCol];
          if (v && !seen[v]) { seen[v] = true; opts.push({ title: self.listLabel(ns, v), value: v }); }
        });
        return opts;
      },

      // Reference table editing (hierarchical)
      renameRefParent: function(oldParent, newParent) {
        if (!this.canEditCurrentRef) return;
        newParent = (newParent || '').trim();
        if (newParent === oldParent) return;
        if (this.isLockedRefValue(oldParent)) { this.notify(this.t('msg.locked')); return; }  // a filter-pinned group value can't be renamed
        var self = this;
        var table = self.currentRefTable;
        var parentCol = self.refParentCol;
        (self.dataCache[table] || []).forEach(function(row) {
          if (row[parentCol] === oldParent) {
            row[parentCol] = newParent;
            row.updated_at = new Date().toISOString();
            Writes.putRow(table, row, 'active');
          }
        });
        // The parent value is stored by every column that reads this lookup as a LIST -- a `select` whose
        // `list:` names the table, which is how the group dimension of a 2-D lookup is referenced (the
        // child dimension is the `ref` column beside it). Renaming the group without carrying those left
        // every such row naming an organization the lookup no longer has: not visible here, and not
        // visible there either until someone opens the picker and finds their value missing from it.
        // The child branch of this editor has always propagated; this one never did.
        self.propagateListChange(table, oldParent, newParent);
        self.migrateListTranslation(table, oldParent, newParent);   // carry the group's own label
        self.notify(self.t('msg.renamed'));
      },
      deleteRefParent: function(parent) {
        if (!this.canEditCurrentRef) return;
        if (this.refParentLocked(parent)) { this.notify(this.t('msg.locked')); return; }
        var key = 'refp:' + parent;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        var self = this;
        var table = self.currentRefTable;
        var parentCol = self.refParentCol;
        var toDelete = (self.dataCache[table] || []).filter(function(r) { return r[parentCol] === parent; });
        self.dataCache[table] = (self.dataCache[table] || []).filter(function(r) { return r[parentCol] !== parent; });
        toDelete.forEach(function(row) { Writes.deleteRow(table, row.id, 'active'); });
        self.pendingDelete = null;
        self.notify(self.t('msg.deleted'));
      },
      addRefParent: function() {
        var self = this;
        if (!self.canEditCurrentRef) return;
        // All three ref-table add paths ride the shared blank-row factory (_createBlankRow) — they
        // used to hand-roll row creation, the exact drift its comment warns about.
        self._createBlankRow(self.currentRefTable);
        self.notify(self.t('msg.group_added'));
        self.$nextTick(function() {
          var els = document.querySelectorAll('.ref-hierarchy .v-list-group');
          if (els.length) {
            var last = els[els.length - 1];
            var cell = last.querySelector('.editable-cell');
            if (cell) cell.focus();
          }
        });
      },
      addRefChild: function(parentValue) {
        var self = this;
        if (!self.canEditCurrentRef) return;
        var prefill = {}; prefill[self.refParentCol] = parentValue;
        self._createBlankRow(self.currentRefTable, { prefill: prefill });
        self.notify(self.t('msg.item_added'));
        self.$nextTick(function() {
          var cells = document.querySelectorAll('.ref-hierarchy .editable-cell.ref-child');
          if (cells.length) cells[cells.length - 1].focus();
        });
      },
      // --- Reorder a reorderable lookup (arrows in the ref editor). Mirrors moveListItem/moveRowPosition:
      // renumber the affected rows' `position` so the lookup editor AND the board's ref-lane order follow it.
      _refGroupRows: function(parentVal) { var pc = this.refParentCol; return this.refTableData.filter(function(r) { return r[pc] === parentVal; }); },
      // Move a child value up/down WITHIN its group (swap position with the adjacent same-group sibling).
      moveRefChild: function(item, dir) {
        if (!this.refReorderable || !this.canEditCurrentRef) return;
        var self = this, table = this.currentRefTable, group = this._refGroupRows(item[this.refParentCol]);
        var i = group.findIndex(function(r) { return r.id === item.id; }), j = i + dir;
        if (i < 0 || j < 0 || j >= group.length) return;
        var b = group[j], pa = item.position, pb = b.position, now = new Date().toISOString();
        item.position = pb; b.position = pa; item.updated_at = b.updated_at = now;
        Writes.putRow(table, { id: item.id, position: item.position, updated_at: now }, 'active');
        Writes.putRow(table, { id: b.id, position: b.position, updated_at: now }, 'active');
      },
      // Move a whole group up/down (swap it with the adjacent group), then renumber every row sequentially.
      moveRefGroup: function(parentVal, dir) {
        if (!this.refReorderable || !this.canEditCurrentRef) return;
        var self = this, table = this.currentRefTable, grouped = this.refGroupedData;
        var order = Object.keys(grouped), i = order.indexOf(parentVal), j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return;
        var t = order[i]; order[i] = order[j]; order[j] = t;
        var pos = 1, now = new Date().toISOString();
        order.forEach(function(g) { (grouped[g] || []).forEach(function(r) {
          if (Number(r.position) !== pos) { r.position = String(pos); r.updated_at = now; Writes.putRow(table, { id: r.id, position: r.position, updated_at: now }, 'active'); }
          pos++;
        }); });
      },
      refChildAtEdge: function(item, dir) { var g = this._refGroupRows(item[this.refParentCol]), i = g.findIndex(function(r) { return r.id === item.id; }); return dir < 0 ? i <= 0 : i >= g.length - 1; },
      refGroupAtEdge: function(parentVal, dir) { var o = Object.keys(this.refGroupedData), i = o.indexOf(parentVal); return dir < 0 ? i <= 0 : i >= o.length - 1; },
      saveRefField: function(item, col, value) {
        if (!this.canEditCurrentRef) return;   // 'r' grant: the cell renders read-only, this guards the path
        if (item[col] === value) return;
        var lv = this.lockedListValues[this.currentRefTable];
        if (lv && lv[item[col]]) { this.notify(this.t('msg.locked')); return; }  // renaming a pinned value breaks the filter
        var oldVal = item[col];
        item[col] = value;
        item.updated_at = new Date().toISOString();
        var self = this;
        var refTable = self.currentRefTable;
        // Rename side-effects (mirror list renames): carry the value across every table that refs it + its
        // translations, so an existing lookup value can be renamed without orphaning rows or its label.
        //
        // ...but ONLY when this edit retires the old value from the lookup. In a two-column lookup a value
        // is unique within its PARENT, not across the table: "president" is a calling of nine
        // organizations, so changing the one under Music is not a rename of the value at all -- it is this
        // row naming a different calling. Treating it as a rename rewrote every other organization's rows
        // too (three people's callings silently changed under them) and moved `list.<table>.president` onto
        // the new name, leaving the nine organizations that still use it with no label and a raw code on
        // screen. Both are invisible from the row being edited, which is what made it costly.
        //
        // The test is the same one a flat lookup answers trivially -- there a value appears once, so an
        // edit always retires it and this behaves exactly as it always did.
        var retired = !(self.dataCache[refTable] || []).some(function(r) { return r.id !== item.id && r[col] === oldVal; });
        if (oldVal && value && retired) { self.propagateRefChange(refTable, oldVal, value); self.migrateListTranslation(refTable, oldVal, value); }
        var timerKey = refTable + ':' + item.id;
        clearTimeout(self.saveTimers[timerKey]);
        self.saveTimers[timerKey] = setTimeout(function() {
          // Drop the key (as saveField does): a leftover entry reads as "an edit is still in flight" to
          // _liveHeld, which would hold every remote change back for the rest of the session.
          delete self.saveTimers[timerKey];
          // Whole row on purpose, unlike saveField: a lookup rename cascades through propagateRefChange
          // above, so the row this writes is the one the editor just rebuilt in full.
          Writes.putRow(refTable, item, 'active');
          self.notify(self.t('msg.saved'));
          self._liveFlush();
        }, 500);
      },
      addRefRow: function() {
        var self = this;
        if (!self.canEditCurrentRef) return;
        self._createBlankRow(self.currentRefTable);
        self.notify(self.t('msg.row_added'));
        self.focusLastEditable('.v-main .v-card .v-table tbody tr:last-child .editable-cell');
      },
      deleteRefRow: function(item) {
        if (!this.canEditCurrentRef) return;
        if (this.isLockedRefRow(item)) { this.notify(this.t('msg.locked')); return; }
        var key = 'ref:' + item.id;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        var table = this.currentRefTable;
        this.dataCache[table] = (this.dataCache[table] || []).filter(function(r) { return r.id !== item.id; });
        Writes.deleteRow(table, item.id, 'active');
        this.notify(this.t('msg.deleted'));
      },

      // Languages
      switchLanguage: function(code) {
        var self = this;
        localStorage.setItem('app_lang', code);
        var defCode = self.defaultLanguage;
        backend.getTranslations(defCode).then(function(baseTrans) {
          self.strings = baseTrans || {};
          if (code !== defCode) {
            return backend.getTranslations(code).then(function(trans) {
              if (trans) self.strings = Object.assign({}, self.strings, trans);
            });
          }
        });
      },
      openLangEditor: function(lang) {
        var self = this;
        this.editingLang = lang;
        backend.getTranslations(lang.code).then(function(trans) {
          self.currentTranslations = trans || {};
        });
      },
      saveTranslation: function(key, value) {
        var self = this;
        this.currentTranslations[key] = value;
        this.strings[key] = value;
        clearTimeout(this._langTimer);
        this._langTimer = setTimeout(function() {
          if (!self.editingLang) return;
          backend.updateTranslations(self.editingLang.code, self.currentTranslations);
          self.notify(self.t('msg.translation_saved'));
        }, 500);
      },
      // BCP-47 language options for the add-language picker, minus those already added. The `code` IS the
      // Intl locale (see calLocale) — picking from a fixed BCP-47 list guarantees a valid, usable code, so
      // no separate `locale` field is needed. The `name` (endonym) becomes the display name (renamable).
      bcp47Options: function() {
        var have = {}; (this.languages || []).forEach(function(l) { have[l.code] = 1; });
        return BCP47_LANGS.filter(function(x) { return !have[x.code]; })
          .map(function(x) { return { title: x.name + ' — ' + x.code, code: x.code, name: x.name }; });
      },
      addLanguage: function(code, name) {
        var self = this;
        code = (code || '').trim();
        if (!code) return;
        if ((this.languages || []).some(function(l) { return l.code === code; })) { this.notify(this.t('msg.language_exists')); return; }
        name = (name || code).trim();
        backend.createLanguage(code, name, this.translationKeys).then(function() {
          var newLang = { code: code, name: name };
          self.languages.push(newLang);
          self.openLangEditor(newLang);
          self.notify(self.t('msg.language_added'));
          self.$nextTick(function() { var el = document.querySelector('[data-lang-code="' + code + '"] input'); if (el) el.focus(); });
        });
      },
      renameLang: function(lang, newName) {
        newName = (newName || '').trim();
        if (!newName || newName === lang.name) return;
        var self = this;
        // Rename the DISPLAY NAME only. The language `code` stays stable, so translations
        // (keyed by code) and the default-language reference are preserved — this makes even
        // the default language safely renamable. Backends without renameLanguage (e.g. Sheets,
        // where the name IS the code) just skip persistence via the guard.
        if (backend.renameLanguage) backend.renameLanguage(lang.code, newName);
        lang.name = newName;
        self.notify(self.t('msg.language_renamed'));
      },
      deleteLang: function(lang) {
        var key = 'lang:' + lang.code;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }  // arm-then-confirm (double click)
        var self = this;
        backend.deleteLanguage(lang.code).then(function() {
          self.languages = self.languages.filter(function(l) { return l.code !== lang.code; });
          if (self.editingLang && self.editingLang.code === lang.code) self.editingLang = null;
          // Deleting the (explicit) default is allowed: repoint it to a remaining language, or clear
          // it when none remain. schemaData is frozen, so replace it with an updated copy + persist.
          if (self.schemaData && self.schemaData.defaultLanguage === lang.code) {
            var newDef = self.languages.length ? self.languages[0].code : null;
            var newSchema = Object.assign({}, self.schemaData, { defaultLanguage: newDef });
            self.schemaData = Object.freeze(newSchema);
            if (backend.saveSchema) backend.saveSchema(newSchema);
          }
          if (self.languages.length === 0) {
            self.strings = {};            // no languages -> UI shows the translation keys themselves
            self.currentLang = null;
            localStorage.removeItem('app_lang');
          } else {
            if (self.currentLang === lang.code) self.currentLang = self.languages[0].code;
            self.switchLanguage(self.currentLang);  // rebuild base(default)+current with the new default
          }
          self.notify(self.t('msg.deleted'));
        });
      },

      // Lists
      addListItem2: function(name) {
        if (!this.canEditList(name)) return;
        this.listsCache[name].push('');
        this.saveLists();
        this.$nextTick(function() {
          var groups = document.querySelectorAll('.v-list-group__items');
          for (var i = 0; i < groups.length; i++) {
            var cells = groups[i].querySelectorAll('.editable-cell');
            if (cells.length && cells[cells.length - 1]) {
              var lastCell = cells[cells.length - 1];
              if (!lastCell.textContent.trim()) { lastCell.focus(); return; }
            }
          }
        });
      },
      updateListItem2: function(name, i, value) {
        if (!this.canEditList(name)) return;
        var oldVal = this.listsCache[name][i];
        if (this.isLockedValue(name, oldVal)) { this.notify(this.t('msg.locked')); return; }  // filter-pinned value can't be renamed
        this.listsCache[name][i] = value;
        this.saveLists();
        // Rename propagation: text is stored in rows, so rewrite the old value -> new value across
        // every table column backed by this list (both partitions). Skip no-ops / blank endpoints.
        if (oldVal && value && oldVal !== value) { this.propagateListChange(name, oldVal, value); this.migrateListUserLink(name, oldVal, value); this.migrateListTranslation(name, oldVal, value); }
      },
      // Carry a value's translations when it's renamed: list.<ns>.<old> -> list.<ns>.<new> across every
      // language (and clear the old key), so a rename in the Lists/ref editor doesn't orphan its label — the
      // i18n counterpart of propagateListChange/propagateRefChange. `ns` is the list name or ref-table name.
      migrateListTranslation: function(ns, oldVal, newVal) {
        if (!ns || !oldVal || !newVal || oldVal === newVal) return;
        var self = this, oldKey = 'list.' + ns + '.' + oldVal, newKey = 'list.' + ns + '.' + newVal;
        if (self.strings && self.strings[oldKey] != null) { self.strings[newKey] = self.strings[oldKey]; delete self.strings[oldKey]; }  // active language, immediate
        (self.languages || []).forEach(function(lang) {
          Promise.resolve(backend.getTranslations(lang.code)).then(function(t) {
            if (!t || t[oldKey] == null || t[oldKey] === '') return;
            var updates = {}; updates[newKey] = t[oldKey]; updates[oldKey] = '';   // '' clears the old key (getTranslations drops empty)
            backend.updateTranslations(lang.code, updates);
          }).catch(function() {});
        });
      },
      // Carry a user-linked-list link when its value is renamed (or drop it on delete): the link is keyed by
      // the value string, so a rename would otherwise orphan it (like the row rewrite above). No-op unless a
      // link exists for the old value (so non-admins, whose listUserLinks is empty, never call setListUser).
      migrateListUserLink: function(list, oldVal, newVal) {
        var email = (this.listUserLinks[list] || {})[oldVal];
        if (!email) return;
        this.setListUserLink(list, oldVal, '');                 // drop the stale-keyed link
        if (newVal) this.setListUserLink(list, newVal, email);  // re-link under the new value (delete => none)
      },
      focusNextListItem: function(e) {
        var el = e.target;
        el.blur();
        var li = el.closest('.v-list-item');
        var next = li && li.nextElementSibling;
        if (next) { var s = next.querySelector('[contenteditable]'); if (s) s.focus(); }
      },
      removeListItem2: function(name, i) {
        if (!this.canEditList(name)) return;
        var key = 'list_' + name + '_' + i;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        this.pendingDelete = null;
        var oldVal = this.listsCache[name][i];
        this.listsCache[name].splice(i, 1);
        this.saveLists();
        // Delete cascade: scrub the removed value from stored rows (text storage) so no orphans
        // remain — blank the cell for select columns, drop the element for multiselect columns.
        if (oldVal) { this.propagateListChange(name, oldVal, null); this.migrateListUserLink(name, oldVal, null); }
      },
      moveListItem: function(name, i, dir) {
        if (!this.canEditList(name)) return;
        var arr = this.listsCache[name]; var j = i + dir;
        var tmp = arr[i]; arr.splice(i, 1, arr[j]); arr.splice(j, 1, tmp);
        this.saveLists();
      },
      saveLists: function() { backend.saveLists(this.listsCache); },

      // All [table,col] pairs whose column is backed by `listName` (select or multiselect).
      // altList = the column's listSwitch alt list (if any) — a value still present in the alt list
      // is NOT an orphan of `listName`, so the cascade must leave it alone (enables move-between-lists).
      listBackedColumns: function(listName) {
        var out = [];
        for (var t in SCHEMA) {
          var cols = (SCHEMA[t] && SCHEMA[t].columns) || {};
          for (var c in cols) {
            if (getColumnList(t, c) === listName) {
              var def = cols[c];
              var alt = (def && typeof def === 'object' && def.listSwitch && def.listSwitch.list) || null;
              // Through colIsMultiselect, not the type string: `multiple: true` makes a select hold an
              // array too, and reading the type directly would scrub it as a scalar -- blanking the
              // whole cell where it should drop one element.
              out.push({ table: t, col: c, multi: Columns.colIsMultiselect(SCHEMA, c), altList: alt });
            }
          }
        }
        return out;
      },
      // Propagate a list-item rename (newVal truthy) or deletion (newVal falsy) into stored table
      // data. Text storage is kept, so the literal value lives in rows; this rewrites it everywhere:
      //   rename  -> oldVal replaced by newVal (select: cell value; multiselect: array element)
      //   delete  -> oldVal removed (select: cell blanked; multiselect: element dropped)
      // Covers BOTH the active and archive partitions (archive rows are fetched if not cached) and
      // persists only the rows that actually changed. Returns a promise of the changed-row count.
      propagateListChange: function(listName, oldVal, newVal) {
        if (!oldVal || oldVal === newVal) return Promise.resolve(0);
        var targets = this.listBackedColumns(listName);
        return targets.length ? this._rewriteValueInColumns(targets, oldVal, newVal) : Promise.resolve(0);
      },
      // Columns that `ref` a given lookup table (the ref counterpart of listBackedColumns). Lets a renamed or
      // removed lookup value be scrubbed out of every table that stores it, the same way list renames propagate.
      refBackedColumns: function(refTable) {
        var out = [];
        for (var t in SCHEMA) { var cols = (SCHEMA[t] && SCHEMA[t].columns) || {}; for (var c in cols) { var r = getColumnRef(t, c); if (r && r.table === refTable) out.push({ table: t, col: c, multi: false, altList: null }); } }
        return out;
      },
      propagateRefChange: function(refTable, oldVal, newVal) {
        if (!oldVal || oldVal === newVal) return Promise.resolve(0);
        var targets = this.refBackedColumns(refTable);
        return targets.length ? this._rewriteValueInColumns(targets, oldVal, newVal) : Promise.resolve(0);
      },
      // Shared engine: rewrite oldVal -> newVal (or delete when newVal is falsy) across the given target
      // columns in both partitions, persisting each changed row. Returns the total count changed.
      _rewriteValueInColumns: function(targets, oldVal, newVal) {
        var self = this, del = !newVal;
        var byTable = {};
        targets.forEach(function(t) { (byTable[t.table] = byTable[t.table] || []).push(t); });
        var jobs = [];
        Object.keys(byTable).forEach(function(table) {
          var tcs = byTable[table];
          var apply = function(rows, partition) {
            var changed = 0;
            (rows || []).forEach(function(row) {
              var rowChanged = false;
              tcs.forEach(function(tc) {
                var v = row[tc.col];
                // listSwitch guard: if oldVal is still a valid option via this column's alt list,
                // it isn't an orphan of `listName` (e.g. the name was added to `guests` before being
                // removed from `members`) — leave the row untouched so the move is lossless.
                if (tc.altList && self.listsCache[tc.altList] && self.listsCache[tc.altList].indexOf(oldVal) >= 0) return;
                if (tc.multi) {
                  if (Array.isArray(v) && v.indexOf(oldVal) >= 0) {
                    row[tc.col] = del ? v.filter(function(x) { return x !== oldVal; })
                                      : v.map(function(x) { return x === oldVal ? newVal : x; });
                    rowChanged = true;
                  }
                } else if (v === oldVal) {
                  row[tc.col] = del ? '' : newVal;
                  rowChanged = true;
                }
              });
              if (rowChanged) { row.updated_at = new Date().toISOString(); Writes.putRow(table, row, partition); changed++; }
            });
            return changed;
          };
          [['active', table], ['archive', aKey(table)]].forEach(function(p) {
            var partition = p[0], cacheKey = p[1];
            if (self.dataCache[cacheKey]) {
              jobs.push(Promise.resolve(apply(self.dataCache[cacheKey], partition)));
            } else {
              jobs.push(Promise.resolve(backend.getTableData(table, partition)).then(function(result) {
                var rows = parseTableResult(result).rows;
                var n = apply(rows, partition);
                if (n) self.dataCache[cacheKey] = rows; // cache so app state stays consistent after scrub
                return n;
              }).catch(function() { return 0; }));
            }
          });
        });
        return Promise.all(jobs).then(function(counts) { return counts.reduce(function(a, b) { return a + b; }, 0); });
      },

      // Per-view rotation anchor (date of period 0 for THIS view's calendar rotations), stored in
      // synced folder config under rotationAnchors[viewName] — per-view & editable on the view, not a
      // schema literal. Different rotation views can have different anchors.
      anchorForView: function(name) {
        return ((this.appConfig && this.appConfig.rotationAnchors) || {})[name] || '';
      },
      // Rotation controls (anchor/range/rotateEvery) persist to the synced folder config. Everyone with
      // access to the view may change them LOCALLY (optimistic appConfig update + re-render); only an
      // admin writes them through to the database. A failed/denied DB write is surfaced with a notice
      // (rules allow only admins to write _meta/config), instead of silently reverting on next reload.
      _saveFolderConfig: function(cfg, viewName) {
        var self = this;
        this.appConfig = cfg;                       // local override for everyone with view access
        if (this.isAdmin && backend.setFolderConfig) {
          Promise.resolve(backend.setFolderConfig(cfg))
            .catch(function() { self.notify(self.t('msg.save_failed')); });
        }
        if (this.currentTable === viewName) this.loadTableData();
      },
      saveRotationAnchor: function(viewName, val) {
        var cfg = Object.assign({}, this.appConfig || {});
        cfg.rotationAnchors = Object.assign({}, cfg.rotationAnchors || {});
        cfg.rotationAnchors[viewName] = val || '';
        cfg.mode = this.mode;
        this._saveFolderConfig(cfg, viewName);
      },
      // --- Per-view background image -------------------------------------------------------------------
      // Two layers, like rangeForView: the schema declares a default (`views[x].background`, shipped with
      // the deployment) and the synced folder config overrides it per view (`appConfig.backgrounds[x]`,
      // editable in Settings without rewriting the schema doc). `image` is one string: an http(s) URL or
      // an `asset:<id>` reference resolved through _assets.
      backgroundForView: function(name) {
        var v = VIEWS[name];
        var base = (v && v.background) || {};
        var ov = ((this.appConfig && this.appConfig.backgrounds) || {})[name] || {};
        return Object.assign({}, base, ov);
      },
      // The style object bound onto the view card.
      //
      // `opacity` is faked, because it has to be: CSS has no background-image-opacity, and element
      // `opacity` would fade the view's CONTENT along with the image. So a scrim — a flat translucent
      // layer — is stacked over the image inside the same background-image list. Using the theme's own
      // `surface` color for it means the fade follows the light/dark toggle and body text keeps its
      // contrast for free. Scrim alpha is 1 - opacity, so opacity 1 = untouched image, 0 = invisible.
      //
      // `fit` is a small enum rather than raw CSS: four named intents cover what people actually want,
      // stay checkable in validateSchema, and keep arbitrary strings out of the style object. `width`
      // is the aspect-preserving one — `<n>% auto` scales to a fraction of the container's WIDTH and
      // lets height follow the image's own ratio (a centered watermark/logo).
      //
      // Object form is required, not cosmetic: Vue applies it via el.style.setProperty, which parses
      // exactly one declaration, so a hostile URL cannot append further CSS (see safeCssUrl).
      backgroundStyleFor: function(name) {
        var bg = this.backgroundForView(name);
        var url = bg && bg.image ? safeCssUrl(this.assetSrc(bg.image)) : '';
        if (!url) return null;
        var op = (bg.opacity == null) ? 0.5 : Math.max(0, Math.min(1, Number(bg.opacity)));
        var scrim = 'rgba(var(--v-theme-surface),' + (1 - op) + ')';
        var fit = BG_FITS[bg.fit] ? bg.fit : 'cover';
        var size = fit === 'width'
          ? (Math.max(1, Math.min(100, Number(bg.width) || 50)) + '% auto')
          : BG_FITS[fit].size;
        return {
          backgroundImage: 'linear-gradient(' + scrim + ',' + scrim + '),' + url,
          backgroundSize: size,
          backgroundPosition: BG_POSITIONS.indexOf(bg.position) >= 0 ? bg.position : 'center',
          backgroundRepeat: BG_FITS[fit].repeat,
          // `fixed` pins the image to the viewport (a parallax "window" effect). Known to be unreliable
          // on iOS Safari — it degrades to scroll or jumps — so it stays opt-in rather than the default.
          backgroundAttachment: bg.fixed ? 'fixed' : 'scroll'
        };
      },
      // Admin: set/clear a view's background in the synced folder config (NOT the schema — no full schema
      // rewrite to swap a picture). Same write path as the rotation controls: optimistic locally for
      // everyone, written through to the DB only by an admin, with a notice if the rule denies it.
      // Clearing needs care because the config OVERRIDES the schema rather than replacing it: simply
      // dropping the entry restores whatever `views[x].background` declares, so on a view with a
      // schema-declared background the remove button looked like it had failed. So an empty image is kept
      // as an explicit `{ image: '' }` TOMBSTONE — the override that means "none" — and the entry is only
      // deleted when there is no schema default for it to override (which keeps the config free of
      // tombstones that say nothing). restoreViewBackground deletes it to bring the default back.
      saveViewBackground: function(viewName, patch) {
        var cfg = Object.assign({}, this.appConfig || {});
        cfg.backgrounds = Object.assign({}, cfg.backgrounds || {});
        var next = Object.assign({}, cfg.backgrounds[viewName], patch);
        if (!next.image && !this.schemaBackground(viewName)) delete cfg.backgrounds[viewName];
        else if (!next.image) cfg.backgrounds[viewName] = { image: '' };   // tombstone: hide the schema default
        else cfg.backgrounds[viewName] = next;
        cfg.mode = this.mode;
        this._saveFolderConfig(cfg, viewName);
      },
      // The schema's declared background for a view, if any (what a tombstone hides / restore brings back).
      schemaBackground: function(viewName) {
        var v = VIEWS[viewName];
        return (v && v.background && v.background.image) ? v.background : null;
      },
      // Is this view's background currently a tombstone hiding a schema default?
      backgroundHidden: function(viewName) {
        var ov = ((this.appConfig && this.appConfig.backgrounds) || {})[viewName];
        return !!(ov && !ov.image && this.schemaBackground(viewName));
      },
      // Drop the override entirely, so the schema-declared background applies again.
      restoreViewBackground: function(viewName) {
        var cfg = Object.assign({}, this.appConfig || {});
        cfg.backgrounds = Object.assign({}, cfg.backgrounds || {});
        delete cfg.backgrounds[viewName];
        cfg.mode = this.mode;
        this._saveFolderConfig(cfg, viewName);
      },
      // Settings: pick a file for a view's background -> store it as the asset `bg_<view>` and point at it.
      uploadViewBackground: function(viewName, ev) {
        var self = this, input = ev && ev.target, file = input && input.files && input.files[0];
        if (input) input.value = '';            // reset so re-picking the same file fires @change again
        if (!file) return;
        this.bgBusy = viewName;
        this.saveAsset('bg_' + viewName, file).then(function(ref) {
          self.bgBusy = '';
          self.saveViewBackground(viewName, { image: ref });
        }).catch(function(e) {
          self.bgBusy = '';
          self.notify((e && e.message) || self.t('msg.upload_failed'));
        });
      },
      // Per-view range override (periods + optional fixed start) in synced folder config
      // rotationRanges[viewName], merged over the schema rotation.range default — mirrors the per-view
      // anchor. A blank/removed `from` rolls from "today"; clearing `periods` falls back to the schema default.
      rangeForView: function(name) {
        var v = VIEWS[name];
        var base = (v && v.rotation && v.rotation.range) || {};
        var ov = ((this.appConfig && this.appConfig.rotationRanges) || {})[name] || {};
        return Object.assign({}, base, ov);
      },
      saveRotationRange: function(viewName, patch) {
        var cfg = Object.assign({}, this.appConfig || {});
        cfg.rotationRanges = Object.assign({}, cfg.rotationRanges || {});
        var cur = Object.assign({}, cfg.rotationRanges[viewName] || {});
        Object.keys(patch).forEach(function(k) {
          var val = patch[k];
          if (val === '' || val === null || val === undefined) delete cur[k]; // reset that field to schema default
          else cur[k] = val;
        });
        if (Object.keys(cur).length) cfg.rotationRanges[viewName] = cur; else delete cfg.rotationRanges[viewName];
        cfg.mode = this.mode;
        this._saveFolderConfig(cfg, viewName);
      },

      // Per-view rotateEvery override (synced folder config). Like the anchor/range overrides, a
      // present value (incl. []) FULLY REPLACES the schema rotateEvery; absent = schema default.
      // Always returns an array so callers/buildRotationViewRows can treat it uniformly.
      rotateEveryForView: function(name) {
        var ov = ((this.appConfig && this.appConfig.rotationRotateEvery) || {})[name];
        var raw = (ov !== undefined) ? ov : ((VIEWS[name] && VIEWS[name].rotation && VIEWS[name].rotation.rotateEvery));
        if (raw == null) return [];
        return Array.isArray(raw) ? raw.slice() : [raw];
      },
      // Name-parameterized rotation model helper (mirrors calEventsFor): generates the period rows for a
      // named rotationView from the current config/dataCache. Shared by the embed path (embedItems) and
      // rotation-view's embed mode, so a rotation renders identically inline and top-level.
      rotationRowsFor: function(name, rotationDef) {
        var rv = rotationDef || (VIEWS[name] && VIEWS[name].rotation);
        if (!rv) return [];
        return buildRotationViewRows({ rotation: rv }, this.dataCache, this._calToday(),
          this.anchorForView(name), this.rangeForView(name), this.rotateEveryForView(name));
      },
      // Slot columns for a rotationView (['_period', ...slots]); narrowed to my own slot when mineOnly,
      // then all-empty slots dropped when hideEmpty. `cfg` overrides the named view for an inline embed
      // config (which carries its own rotation/hideEmpty/mineOnly), mirroring rotationRowsFor's rotationDef.
      // THE slot-name resolver. A `slots`/`rosters` rotation names them in the schema; a `rosterRef`
      // one does not -- they are whatever distinct values the lookup holds, so they come from the data
      // via the same pure resolver the row builder uses (never a second copy of the grouping rule).
      rotationSlotsFor: function(rv) {
        if (!rv) return [];
        if (rv.rosterRef) return Rotation.rosterGroups(rv, this.dataCache).slots;
        return rv.slots ? rv.slots.slice() : (rv.columns || []).map(function(c) { return c.name; });
      },
      // The header a slot column renders under. A rosterRef slot is a VALUE of the lookup, so its label
      // lives in that table's own `list.<table>.<value>` namespace -- the same keys `translatableLists`
      // exposes for a 2-D ref lane, and the same ones its task values use. A schema-named slot keeps
      // `field.<slot>`. Falls back to the raw name either way.
      rotationSlotLabel: function(name, col) {
        var rv = (VIEWS[name] || {}).rotation;
        if (rv && rv.rosterRef) return this.tOr('list.' + rv.rosterRef + '.' + col, col);
        return this.tOr('field.' + col, col);
      },
      // Which column a rotation's cells are read from, and therefore which column's list labels them.
      // The `columns` form gives each slot its own roster and its own valueCol, so this is per-slot.
      // `people` is the documented default for both shapes.
      rotationValueColFor: function(name, slotCol) {
        var rv = (VIEWS[name] || {}).rotation;
        if (!rv) return null;
        if (rv.columns) {
          for (var i = 0; i < rv.columns.length; i++) {
            if (rv.columns[i] && rv.columns[i].name === slotCol) return rv.columns[i].valueCol || 'people';
          }
          return null;
        }
        return rv.valueCol || 'people';
      },
      rotationColsFor: function(name, rows, cfg) {
        var v = cfg || VIEWS[name];
        var rv = v && v.rotation;
        if (!rv) return [];
        var names = this.rotationSlotsFor(rv);
        var mine = this.mineOnlySlot(v);
        if (mine !== null) names = names.filter(function(n) { return String(n).toLowerCase() === mine; });
        if (v.hideEmpty) {
          var rs = rows || [];
          names = names.filter(function(n) { return rs.some(function(r) { var val = r[n]; return Array.isArray(val) ? val.length : !!val; }); });
        }
        return ['_period'].concat(names);
      },
      // A view's `mineOnly` narrows a rotation to the signed-in user's OWN slot, so everyone opens the
      // same shared matrix and sees only their column of it. `mineOnly: "<list>"` resolves my identity
      // through that list (a userlink list maps my account to the household's own name for me);
      // `true` falls back to the profile display name. Slots match case-insensitively, since a slot
      // name is a schema identifier and the list value is human-entered.
      //   Admin / unrestricted viewers are exempt -> the full matrix, which is the admin view.
      //   An identity we cannot resolve yields '' -> matches no slot -> fails CLOSED.
      // Returns null when the filter does not apply (no mineOnly, or an exempt viewer).
      // Display-only, exactly like the `@me` filter token: the roster rows are still fetched and the
      // periods still generated client-side. Real secrecy is a per-roster-table grant (canReachTable).
      mineOnlySlot: function(view) {
        var mo = view && view.mineOnly;
        if (!mo) return null;
        if (!this.userAllowedTables) return null;   // admin / unrestricted -> whole matrix
        // `true` resolves identity through the profile display name; `{ list: "<name>" }` through that
        // list's userlink mapping. The list form is an OBJECT, not a bare string, so it cannot be read
        // as the column array `obscureNames` takes right beside it in the same view config.
        var list = (mo && typeof mo === 'object') ? mo.list : null;
        return String(this.meValueForList(list) || '').toLowerCase();
      },
      // Save the rotateEvery override. opts = { every: n, cycle: bool } -> composed into a summed
      // array (n>0 contributes a per-period swap, cycle contributes the per-cycle swap). opts === null
      // clears the override -> schema default. Mirrors saveRotationAnchor/Range persistence.
      saveRotationRotateEvery: function(viewName, opts) {
        var cfg = Object.assign({}, this.appConfig || {});
        cfg.rotationRotateEvery = Object.assign({}, cfg.rotationRotateEvery || {});
        if (opts === null || opts === undefined) {
          delete cfg.rotationRotateEvery[viewName];
        } else {
          var arr = [];
          var n = Number(opts.every);
          if (!isNaN(n) && n > 0) arr.push(n);
          if (opts.cycle) arr.push('cycle');
          cfg.rotationRotateEvery[viewName] = arr;
        }
        cfg.mode = this.mode;
        this._saveFolderConfig(cfg, viewName);
      },
      moveRowPosition: function(item, dir) {
        if (!this.isReorderable) return;
        var self = this, table = this.currentTable;
        var ordered = this.sortedData.slice();
        var i = ordered.findIndex(function(r) { return r.id === item.id; });
        var j = i + dir;
        if (i < 0 || j < 0 || j >= ordered.length) return;
        ordered.splice(j, 0, ordered.splice(i, 1)[0]); // move item to its new slot
        ordered.forEach(function(r, k) {
          var np = k + 1;
          if (Number(r.position) !== np) {
            r.position = String(np); // keep as string — sortedData sorts via localeCompare (number would throw)
            r.updated_at = new Date().toISOString();
            // position-only write: reordering says nothing about the row's other columns, so it must not
            // carry (and overwrite with) our copy of them.
            Writes.putRow(table, { id: r.id, position: r.position, updated_at: r.updated_at }, 'active');
          }
        });
      },

      // Propagate edited syncFrom column values to mirror-linked tables (downstream details + upstream masters)
      propagateMirror: function(id, sourceTable, rowData) {
        var self = this;
        // Downstream: detail tables whose columns syncFrom sourceTable
        for (var mt in SCHEMA) {
          var synced = [];
          for (var mc in SCHEMA[mt].columns) { var md = SCHEMA[mt].columns[mc]; if (md && typeof md === 'object' && md.syncFrom === sourceTable) synced.push(mc); }
          if (!synced.length) continue;
          var mKey = self.viewingArchive ? aKey(mt) : mt;
          var mTab = self.viewingArchive ? 'archive' : 'active';
          var mr = (self.dataCache[mKey] || []).find(function(r) { return r.id === id; });
          if (mr) {
            // Write only the mirrored columns, not the whole mirror row — a mirror carries columns of
            // its own that this edit has nothing to say about, and shipping our cached copy of them is
            // exactly the cross-client clobber saveField now avoids.
            var patch = { id: id };
            synced.forEach(function(c) { if (mr[c] !== rowData[c]) { mr[c] = rowData[c] || ''; patch[c] = mr[c]; } });
            if (Object.keys(patch).length > 1) {
              mr.updated_at = patch.updated_at = new Date().toISOString();
              Writes.putRow(mt, patch, mTab);
            }
          }
        }
        // Upstream: master table(s) this sourceTable mirrors from
        var srcCols = SCHEMA[sourceTable] && SCHEMA[sourceTable].columns;
        var upTargets = {};
        for (var rc in (srcCols || {})) { var rdef = srcCols[rc]; if (rdef && typeof rdef === 'object' && rdef.syncFrom) { (upTargets[rdef.syncFrom] = upTargets[rdef.syncFrom] || []).push(rc); } }
        Object.keys(upTargets).forEach(function(st) {
          var stKey = self.viewingArchive ? aKey(st) : st;
          var stTab = self.viewingArchive ? 'archive' : 'active';
          var stRow = (self.dataCache[stKey] || []).find(function(r) { return r.id === id; });
          if (stRow) {
            var upPatch = { id: id };   // mirrored columns only — same reasoning as the downstream branch
            upTargets[st].forEach(function(c) { if (stRow[c] !== rowData[c]) { stRow[c] = rowData[c] || ''; upPatch[c] = stRow[c]; } });
            if (Object.keys(upPatch).length > 1) {
              stRow.updated_at = upPatch.updated_at = new Date().toISOString();
              Writes.putRow(st, upPatch, stTab);
            }
          }
        });
      },

      // Settings
      saveSetting: function(key, val) {
        var s = JSON.parse(localStorage.getItem('app_settings') || '{}');
        s[key] = val; localStorage.setItem('app_settings', JSON.stringify(s));
      },
      resetApp: function() {
        localStorage.clear();
        this._liveUnwatchAll();   // same reason as finishImportReload: the data is about to be wiped

        function done() {
          // Clear server-side data if a local server is available, then reload
          fetch(_u('/api/resetData'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })
            .catch(function() {}).finally(function() { location.reload(); });
        }
        var req = indexedDB.deleteDatabase('dbui');
        req.onsuccess = req.onerror = req.onblocked = done;
      },
      copyText: function(text) {
        if (navigator.clipboard) { navigator.clipboard.writeText(text); }
        else { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); document.body.removeChild(t); }
        this.notify(this.t('msg.copied'));
      },
      _autoSelectTab: function() {
        if (!this.currentTable) { var ft = this.sidebarTabs.find(function(t) { return !t.divider; }); if (ft) this.selectTab(ft.id); }
      },
      loadUsers: function() {
        var self = this;
        if (typeof backend_users === 'undefined') {
          self.usersLoaded = true; self.loading = false;
          if (!self.currentTable) { var ft0 = self.sidebarTabs.find(function(t) { return !t.divider; }); if (ft0) self.selectTab(ft0.id); }
          return;
        }
        if (!self.currentUserEmail) {
          var p = new URLSearchParams(location.search);
          self.currentUserEmail = p.get('user') || localStorage.getItem('test_user') || 'local@dev';
        }
        var done = function() { self.usersLoaded = true; self.loading = false; self.loadMyProfile(); self.loadSharedProfiles(); self._overlayUserLists(); self._autoArchive(); self._autoSelectTab(); };
        // Legacy backends without getMyAccess: keep the full-map path (rules-free local/Drive).
        if (typeof backend_users.getMyAccess !== 'function') {
          backend_users.getUsers().then(function(u) {
            var list = self._buildUserList(u);
            if (!list.length && self.currentUserEmail) return self._bootstrapAdmin(done);
            self.userList = list; done();
          }).catch(function() { done(); });
          return;
        }
        // Preferred: learn OUR OWN access via a self-scoped read so non-admins never read the whole
        // users roster (which holds every user's email/role/grants).
        backend_users.getMyAccess().then(function(a) {
          a = a || { registered: false };
          self.selfUnregistered = false;
          if (a.bootstrap) return self._bootstrapAdmin(done);
          if (a.registered === false) { self.selfUnregistered = true; self.userList = []; return done(); }
          var email = (self.currentUserEmail || '').toLowerCase();
          if (a.role === 'admin' || a.tables === 'all') {
            backend_users.getUsers().then(function(u) { self.userList = self._buildUserList(u); self.loadAccessRequests(); self.loadAllProfiles(); done(); })
              .catch(function() { self.userList = [{ key: email, addr: email, role: a.role, tables: a.tables || 'all' }]; done(); });
          } else {
            self.userList = [{ key: email, addr: email, role: a.role, tables: a.tables }]; done();
          }
        }).catch(function(e) {
          // A denied/failed access read means "not one of us" — but this also catches anything thrown by
          // the success path above, which would then present as an unexplained "you are not registered".
          // Say what actually happened rather than leaving a security-shaped symptom with no cause.
          console.error('[loadUsers] access check failed:', (e && e.stack) || e);
          self.selfUnregistered = true; self.userList = []; done();
        });
      },
      _buildUserList: function(u) {
        var list = [];
        Object.keys(u || {}).forEach(function(k) { var v = u[k]; if (v && typeof v === 'object' && v.role) list.push({ key: k, addr: v.user || '', role: v.role, tables: v.tables || 'all' }); });
        return list;
      },
      _bootstrapAdmin: function(done) {
        var self = this, adminEmail = (self.currentUserEmail || '').toLowerCase();
        return backend_users.setUserRole(adminEmail, 'admin', adminEmail, 'all').then(function() {
          self.selfUnregistered = false;
          self.userList = [{ key: adminEmail, addr: adminEmail, role: 'admin', tables: 'all' }];
          done(); self.notify(self.t('msg.registered_admin'));
        }).catch(function() { done(); });
      },
      setUserRole: function(uid, role, user, tables) {
        var self = this;
        backend_users.setUserRole(uid, role, user, tables).then(function() { self.loadUsers(); });
      },
      // --- Membership requests ---
      // Unregistered user submits a request; only they can write their own request doc (rules-enforced).
      requestAccess: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.requestAccess) return;
        var name = (this.accessRequestName || '').trim();
        if (!name) { self.notify(self.t('access.name_required')); return; }
        backend_users.requestAccess(name, '').then(function() {
          self.accessRequested = true; self.notify(self.t('access.request_sent'));
        }).catch(function(e) { self.notify((e && e.message) || self.t('msg.request_failed')); });
      },
      loadAccessRequests: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.getAccessRequests) { self.accessRequests = []; return; }
        backend_users.getAccessRequests().then(function(m) {
          self.accessRequests = Object.keys(m || {}).map(function(k) { var v = m[k] || {}; return { email: v.email || k, name: v.name || '', note: v.note || '', ts: v.ts || 0 }; })
            .sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
        }).catch(function() { self.accessRequests = []; });
      },
      // Approve: register the user (editor, no tables yet -> admin grants access via the chip UI), seed
      // their profile display name from the request (so @me identity works right away), then clear it.
      approveRequest: function(req) {
        var self = this, email = (req.email || '').toLowerCase(), name = (req.name || '').trim();
        return backend_users.setUserRole(email, 'editor', email, []).then(function() {
          return (name && backend_users.setProfileName) ? backend_users.setProfileName(email, name) : null;
        }).then(function() {
          return backend_users.removeAccessRequest(email);
        }).then(function() { self.loadUsers(); }).catch(function(e) { self.notify((e && e.message) || self.t('msg.approve_failed')); });
      },
      denyRequest: function(req) {
        var self = this;
        backend_users.removeAccessRequest((req.email || '').toLowerCase()).then(function() { self.loadAccessRequests(); }).catch(function() {});
      },
      // --- Opt-in display-name profiles + user-backed lists ---
      // A schema list marked `listSources[name] === "users"` is populated from opted-in display names.
      userBackedLists: function() {
        var ls = (this.schemaData && this.schemaData.listSources) || {};
        return Object.keys(ls).filter(function(n) { return ls[n] === 'users'; });
      },
      // Does anything in this schema depend on people opting in to share their display name?
      //
      // Every account-linked list does, and not only the `users` kind that takes its VALUES from
      // shared names: both userlink kinds resolve a LINKED profile, and a non-admin may read that
      // profile only when its owner shared it. So a member's avatar -- and, on a `userlink-name`
      // list, the name shown in place of the value -- exists for other members only if they opted in.
      //
      // The profile switch used to key off userBackedLists(), i.e. `users` alone. A deployment whose
      // linked lists are all `userlink` (the bishopric example is exactly that) therefore never
      // rendered the switch: nobody could opt in, so nobody but an admin ever saw a linked name or
      // face, with nothing on screen to explain why.
      sharingMatters: function() {
        var ls = (this.schemaData && this.schemaData.listSources) || {};
        return Object.keys(ls).some(function(n) {
          return ls[n] === 'users' || ls[n] === 'userlink' || ls[n] === 'userlink-name';
        });
      },
      // Merge the opted-in shared names ON TOP of the list's curated values rather than replacing them:
      // replacing meant a list emptied itself whenever nobody had opted in yet (a fresh deployment, or
      // a getSharedNames failure), leaving the column unusable with no hint why.
      // `_injectedUserNames` records what THIS overlay added last time, so a re-run (see the profile
      // save below, which exists to reflect a *removed* shared name) strips them before re-merging —
      // merging blindly into the previous result would make an un-shared name impossible to remove.
      _overlayUserLists: function() {
        var self = this, names = this.userBackedLists();
        if (!names.length || typeof backend_users === 'undefined' || !backend_users.getSharedNames) return Promise.resolve();
        return backend_users.getSharedNames().then(function(shared) {
          var injected = self._injectedUserNames || (self._injectedUserNames = {}), patch = {};
          names.forEach(function(n) {
            var prev = injected[n] || [];
            var curated = (self.listsCache[n] || []).filter(function(v) { return prev.indexOf(v) < 0; });
            var out = curated.slice();
            (shared || []).forEach(function(nm) { if (out.indexOf(nm) < 0) out.push(nm); });
            injected[n] = (shared || []).filter(function(nm) { return curated.indexOf(nm) < 0; });
            patch[n] = out;
          });
          self.listsCache = Object.assign({}, self.listsCache, patch);
          window._listsCache = self.listsCache;
        }).catch(function() {});   // a rejection leaves the curated list intact -- see backend-firebase getSharedNames
      },
      loadMyProfile: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.getMyProfile) return;
        backend_users.getMyProfile().then(function(p) {
          self.myProfile = { name: (p && p.name) || '', shared: !!(p && p.shared), picture: (p && p.picture) || '' };
          self.profileSaved = { name: self.myProfile.name, shared: self.myProfile.shared, picture: self.myProfile.picture };
        }).catch(function() {});
      },
      // Auto-saves on blur (name) / toggle (shared) / picture change -- no explicit Save button. Skips the
      // write when nothing changed since the last save so a plain focus-out doesn't churn the backend + lists.
      saveMyProfile: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.setMyProfile) return;
        var name = (this.myProfile.name || '').trim(), picture = this.myProfile.picture || '';
        // Sharing requires a name: an unnamed profile can't be shared (it would surface as a nameless entry
        // in member lists / the roster). Enforce here so clearing the name also drops the opt-in, and mirror
        // it back into the model so the toggle reflects the real state.
        var shared = !!this.myProfile.shared && !!name;
        this.myProfile.shared = shared;
        if (this.profileSaved && this.profileSaved.name === name && this.profileSaved.shared === shared && this.profileSaved.picture === picture) return;
        backend_users.setMyProfile(name, shared, picture).then(function() {
          self.profileSaved = { name: name, shared: shared, picture: picture };
          self._overlayUserLists();   // reflect the added/removed shared name in user-backed lists immediately
        }).catch(function(e) { self.notify((e && e.message) || self.t('msg.save_failed')); });
      },
      // Profile picture upload: read the chosen file, downscale it to a small square-ish avatar (max 256px,
      // JPEG) via a canvas so the stored data-URL stays small (well under the backend's ~350KB cap), then
      // save. Keeping it a data-URL means no separate storage bucket / URL lifecycle to manage.
      onProfilePictureFile: function(e) {
        var self = this, input = e && e.target, file = input && input.files && input.files[0];
        if (input) input.value = '';   // reset so re-picking the same file still fires @change
        if (!file) return;
        if (!/^image\//.test(file.type || '')) { this.notify(this.t('msg.choose_image')); return; }
        this._resizeImageFile(file, 256).then(function(dataUrl) {
          if (dataUrl.length > 350000) { self.notify(self.t('msg.image_too_large')); return; }
          self.myProfile.picture = dataUrl;
          self.saveMyProfile();
        }).catch(function(err) { self.notify((err && err.message) || self.t('msg.image_read_failed')); });
      },
      removeMyPicture: function() {
        if (!this.myProfile.picture) return;
        this.myProfile.picture = '';
        this.saveMyProfile();
      },
      // Does anything on this canvas carry partial or full transparency? Decides the encoder below.
      // Breaks on the first non-opaque pixel, so an opaque photo is the only case that scans in full.
      // If the pixels can't be read at all (a tainted canvas — not reachable from a FileReader data URL,
      // but cheap to be safe about) assume alpha: the alpha-capable encoder is the lossless choice.
      _canvasHasAlpha: function(ctx, w, h) {
        try {
          var d = ctx.getImageData(0, 0, w, h).data;
          for (var i = 3; i < d.length; i += 4) { if (d[i] < 255) return true; }
          return false;
        } catch (e) { return true; }
      },
      // Downscale an image File to a data-URL whose longest side is <= max, preserving aspect ratio.
      // `quality` is the encoder quality (default 0.85 — the avatar setting); _fitImageToCap steps it
      // down to land a larger image (a view background) under ASSET_CAP.
      //
      // The output format FOLLOWS THE SOURCE. JPEG has no alpha channel, and a canvas starts as
      // transparent BLACK — so re-encoding a transparent PNG as JPEG turned every transparent pixel
      // opaque black, which is how a logo watermark became a black slab. Transparency therefore switches
      // the encoder to WebP, which carries alpha and is typically smaller than JPEG for graphic-style
      // images; a browser that won't encode WebP returns PNG instead, which also keeps alpha. Opaque
      // photos still take JPEG, where it is the better trade. safeImgSrc already admits all three.
      _resizeImageFile: function(file, max, quality) {
        var self = this;
        var q = (typeof quality === 'number') ? quality : 0.85;
        return new Promise(function(resolve, reject) {
          var reader = new FileReader();
          reader.onerror = function() { reject(new Error(self.t('msg.image_read_failed'))); };
          reader.onload = function() {
            var img = new Image();
            img.onerror = function() { reject(new Error(self.t('msg.image_invalid'))); };
            img.onload = function() {
              var w = img.width || 1, h = img.height || 1, scale = Math.min(1, max / Math.max(w, h));
              var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
              var canvas = document.createElement('canvas');
              canvas.width = cw; canvas.height = ch;
              try {
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, cw, ch);
                var type = self._canvasHasAlpha(ctx, cw, ch) ? 'image/webp' : 'image/jpeg';
                resolve(canvas.toDataURL(type, q));
              } catch (err) { reject(new Error(self.t('msg.image_process_failed'))); }
            };
            img.src = String(reader.result || '');
          };
          reader.readAsDataURL(file);
        });
      },

      // --- Stored assets: an image kept IN THE DATABASE as a data URI, for deployments with no blob
      // store (Firebase Spark, where Storage needs the Blaze plan). Same trade the profile avatar makes.
      // Rows live in _assets__active as { id, src }; a referring value is the string 'asset:<id>'.

      // Downscale `file` until its data URI fits ASSET_CAP, trading resolution then quality. Rejects with
      // msg.image_too_large when even the smallest step is too big (a pathological source, since 900px at
      // q0.6 is tens of KB for any real photo). Note the quality steps do nothing on a browser that falls
      // back to PNG for a transparent source (PNG is lossless) — there the resolution steps do the work.
      _fitImageToCap: function(file, cap) {
        var self = this, limit = cap || ASSET_CAP;
        var steps = [{ max: 1600, q: 0.8 }, { max: 1600, q: 0.65 }, { max: 1200, q: 0.65 }, { max: 900, q: 0.6 }];
        var attempt = function(i) {
          if (i >= steps.length) return Promise.reject(new Error(self.t('msg.image_too_large')));
          return self._resizeImageFile(file, steps[i].max, steps[i].q).then(function(dataUrl) {
            return dataUrl.length <= limit ? dataUrl : attempt(i + 1);
          });
        };
        return attempt(0);
      },
      // Store a picked file as the asset `id`, resolving to the reference to save on the row / in config.
      // Deterministic ids (bg_<view>) overwrite in place, so replacing a background leaves no orphan.
      saveAsset: function(id, file) {
        var self = this;
        if (!backend.putRow) return Promise.reject(new Error(self.t('msg.save_failed')));
        if (!/^image\//.test((file && file.type) || '')) return Promise.reject(new Error(self.t('msg.choose_image')));
        return this._fitImageToCap(file, ASSET_CAP).then(function(src) {
          return Promise.resolve(Writes.putRow('_assets', { id: id, src: src }, 'active')).then(function() {
            self.assetCache[id] = src;               // show it immediately, no round-trip
            return 'asset:' + id;
          });
        });
      },
      // Resolved src for an image address. PURE cache read: render must not start a fetch, so misses come
      // back '' and ensureAssets (called from loadTableData) is what fills the cache. A plain URL passes
      // through the same <img src> gate the image cells use.
      assetSrc: function(ref) {
        if (!isAssetRef(ref)) return safeImgSrc(ref);
        var v = this.assetCache[Embeds.assetId(ref)];
        return v ? safeImgSrc(v) : '';
      },
      // Fetch any not-yet-cached asset refs. Single-doc reads where the backend offers getAsset (see
      // backend-firebase: _assets is a system store no grant names, so the collection read returns []
      // for non-admins); otherwise one collection read fills every miss at once. Misses cache as ''.
      ensureAssets: function(refs) {
        var self = this;
        var want = (refs || []).filter(isAssetRef).map(function(r) { return Embeds.assetId(r); })
          .filter(function(id) { return !(id in self.assetCache) && !self._assetPending[id]; });
        if (!want.length) return Promise.resolve();
        want.forEach(function(id) { self._assetPending[id] = true; });
        var done = function(id, src) { self.assetCache[id] = src || ''; delete self._assetPending[id]; };
        if (backend.getAsset) {
          return Promise.all(want.map(function(id) {
            return Promise.resolve(backend.getAsset(id))
              .then(function(a) { done(id, a && a.src); })
              .catch(function() { done(id, ''); });
          }));
        }
        return Promise.resolve(backend.getTableData('_assets', 'active')).then(function(d) {
          var byId = {};
          ((d && d.rows) || []).forEach(function(r) { if (r && r.id) byId[r.id] = r.src || ''; });
          want.forEach(function(id) { done(id, byId[id]); });
        }).catch(function() { want.forEach(function(id) { done(id, ''); }); });
      },
      // The open view's background asset. Driven by a watcher on currentTable (see below), NOT from
      // loadTableData: selectTab only calls that for the data-ish kinds, sending a doc view to loadPage
      // and the system screens to neither — so a background on any of those was never fetched, and one
      // set in an earlier session simply never appeared.
      _refreshBgAsset: function() {
        var self = this;
        var bg = this.backgroundForView(this.currentTable);
        if (bg && bg.image) this.ensureAssets([bg.image]);
        // Settings is the one screen that displays OTHER views' backgrounds (a thumbnail per row), so it
        // needs all of their bytes, not just its own. Without this every row for a view not yet visited
        // this session showed the "no background" placeholder even though one was set.
        if (this.currentTable === '__settings') {
          this.ensureAssets(this.backgroundTargets.map(function(t) { return self.backgroundForView(t.id).image; }).filter(Boolean));
        }
      },
      // Asset refs held by cells in the rows now on screen. Driven by a watcher on currentData rather than
      // from loadTableData, so it covers every view kind's load path without touching each.
      //
      // Resolves image columns from declaredCols, NOT visibleCols: which columns hold images is a schema
      // question, and visibleCols additionally answers a presentation one (hideEmpty in table mode) that
      // nothing here needs. It is also the read that originally exposed the computed cycle — reading
      // visibleCols from this watcher while a grid rendered blew the stack (see declaredCols).
      _refreshRowAssets: function() {
        var self = this, refs = [];
        var imgCols = (this.declaredCols || []).filter(function(c) { return self.colIsImage(c); });
        if (!imgCols.length) return;
        (this.currentData || []).forEach(function(r) { imgCols.forEach(function(c) { if (r && r[c]) refs.push(r[c]); }); });
        if (refs.length) this.ensureAssets(refs);
      },
      // Admin: every user's display name, for the Users management table (own name uses
      // myProfile/saveMyProfile above instead -- this is for viewing/editing OTHER users' names).
      loadAllProfiles: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.getProfiles) return Promise.resolve();
        // Merge (not replace): loadSharedProfiles may resolve either side of this, and both hold the same
        // data for overlapping emails, so a union is always correct and order-independent.
        return backend_users.getProfiles().then(function(m) { self.profilesByEmail = Object.assign({}, self.profilesByEmail, m || {}); }).catch(function() {});
      },
      // Every user (not just admins) loads the opted-in shared profiles so other people's names + avatars can
      // render wherever a user shows up (roster, user-backed surfaces). Shared profiles are world-readable by
      // rule; this is the non-admin counterpart to loadAllProfiles (which reads the whole collection). Merge,
      // for the same order-independence reason noted above.
      loadSharedProfiles: function() {
        var self = this;
        if (typeof backend_users === 'undefined' || !backend_users.getSharedProfiles) return Promise.resolve();
        return backend_users.getSharedProfiles().then(function(m) { self.profilesByEmail = Object.assign({}, self.profilesByEmail, m || {}); }).catch(function() {});
      },
      // Opted-in display name for an email, or '' if none. The single lookup into profilesByEmail;
      // callers pick their own fallback (the Users table wants a blank cell, the rsvp roster wants the
      // email so the row still reads as someone).
      profileName: function(email) { return (this.profilesByEmail[(email || '').toLowerCase()] || {}).name || ''; },
      // Avatar data-URL for an email, or '' if none. Own email short-circuits to myProfile.picture so your
      // face renders everywhere immediately — even before (or without) opting into sharing, and fresher than
      // any cached copy in profilesByEmail.
      profilePicture: function(email) {
        var e = (email || '').toLowerCase();
        if (e && e === (this.currentUserEmail || '').toLowerCase()) return this.myProfile.picture || '';
        return (this.profilesByEmail[e] || {}).picture || '';
      },
      // The DISPLAY label for a user identified by email, honoring the profile-privacy rule: their shared
      // name, else the raw email ONLY for an admin (sensitive), else '' — so a non-admin surface hides an
      // unshared user entirely rather than leaking their address. The single source of this rule, shared by
      // user-avatar, user-ref, and the rsvp roster.
      userLabel: function(email) { return this.profileName(email) || (this.isAdmin ? (email || '') : ''); },
      // User-linked lists (Option C): load the viewer-safe { list: { value: picture } } projection the
      // server computed for us (non-admins already stripped of unshared users + all emails). Backends
      // without the feature (legacy) just leave it empty.
      loadListAvatars: function() {
        var self = this;
        if (typeof backend === 'undefined' || !backend.getListAvatars) return Promise.resolve();
        return backend.getListAvatars().then(function(m) { self.listAvatars = m || {}; }).catch(function() {});
      },
      // The linked user's avatar for a single-select list VALUE, or '' — used to draw a face beside the
      // value while the displayed text stays the value itself. Multiselect (array) values are skipped here.
      listValuePicture: function(col, value, nsCol) {
        if (!value || typeof value !== 'string' || !window.ListUsers) return '';
        var list = this.listNameForCol(nsCol || col);   // resolves aggregate group columns too (e.g. piispakunta)
        if (!list) return '';
        return window.ListUsers.pictureFor(this.listAvatars, list, value);
      },
      // Lists opted in to user linking (Lookup-editor picker), and what the link is FOR:
      //
      //   'userlink'       map value -> account. The value is what you see; the link drives `@me` and
      //                    the avatar. A rename of the linked person's profile moves nothing.
      //   'userlink-name'  the same link, but the cell DISPLAYS the linked account's profile name.
      //                    For a list whose values are roles rather than people ("bishop"), where the
      //                    question a reader has is who currently holds it.
      //
      // Both are distinct from 'users', where the list VALUES are themselves the shared display names.
      isUserLinkList: function(name) {
        var src = (((this.schemaData || {}).listSources) || {})[name];
        return src === 'userlink' || src === 'userlink-name';
      },
      isUserNameList: function(name) { return (((this.schemaData || {}).listSources) || {})[name] === 'userlink-name'; },
      // Admin only: the raw value -> email links, for the editor's current-selection display. Denied for
      // non-admins by the server/rules -> caught into {} (they never need it; rendering uses listAvatars).
      // Self-scoped link lookup, loaded for EVERY member (unlike loadListUserLinks, which is admin-only):
      // it is the caller's own identity and `@me` needs it before any view resolves.
      loadMyListValues: function() {
        var self = this;
        if (typeof backend === 'undefined' || !backend.getMyListValues) return Promise.resolve();
        return backend.getMyListValues().then(function(m) { self.myListValues = m || {}; }).catch(function() { self.myListValues = {}; });
      },
      loadListUserLinks: function() {
        var self = this;
        if (typeof backend === 'undefined' || !backend.getListUserLinks) return Promise.resolve();
        return backend.getListUserLinks().then(function(m) { self.listUserLinks = m || {}; }).catch(function() { self.listUserLinks = {}; });
      },
      // Registered users as { email, name } options for the link picker, name-sorted (admins have userList).
      listUserOptions: function() {
        var self = this;
        return (this.userList || []).map(function(u) { return { email: u.key, name: self.profileName(u.key) || u.key }; })
          .sort(function(a, b) { return a.name.localeCompare(b.name); });
      },
      // Link (email set) or unlink (email '') a list value to a user, then refresh the raw links + the
      // rendered avatar projection so the change shows immediately in the editor and in every cell.
      setListUserLink: function(list, value, email) {
        var self = this;
        if (typeof backend === 'undefined' || !backend.setListUser) return;
        backend.setListUser(list, value, email || '').then(function() {
          self.loadListUserLinks(); self.loadListAvatars(); self.loadMyListValues();
        }).catch(function(e) { self.notify((e && (e.error || e.message)) || self.t('msg.save_failed')); });
      },
      userDisplayName: function(u) { return this.profileName(u.key); },
      renameUserProfile: function(u, name) {
        var self = this, email = (u.key || '').toLowerCase(), trimmed = (name || '').trim();
        if (typeof backend_users === 'undefined' || !backend_users.setProfileName) return;
        backend_users.setProfileName(email, trimmed).then(function() {
          var patch = {}; patch[email] = Object.assign({}, self.profilesByEmail[email], { name: trimmed });
          self.profilesByEmail = Object.assign({}, self.profilesByEmail, patch);
        }).catch(function(e) { self.notify((e && e.message) || self.t('msg.save_failed')); });
      },
      // What "@me" means for a given COLUMN. Two identity models, and the column's list decides which:
      //   userlink list -> the curated value linked to my account (the household's own name for me),
      //   otherwise     -> my profile display name (the value a `users`-backed list is populated from).
      // Without the first branch, `@me` on a userlink list compared my profile name against a curated
      // value and silently matched nothing whenever the two differed.
      meValueFor: function(col) {
        return this.meValueForList(col ? getColumnList(null, col) : null);
      },
      // The columns a view's filter compares against `@me` (walking $or/$and, which carry no column of
      // their own — the same traversal resolveMeTokens does).
      meFilterColsFor: function(name) {
        var v = VIEWS[name], out = [];
        var walk = function(node, key) {
          if (node === '@me') { if (key) out.push(key); return; }
          if (Array.isArray(node)) return node.forEach(function(x) { walk(x, key); });
          if (node && typeof node === 'object') Object.keys(node).forEach(function(k) { walk(node[k], k.charAt(0) === '$' ? key : k); });
        };
        if (v) { walk(v.filter, null); walk(v.groupBy && v.groupBy.filter, null); }
        return out;
      },
      // A view filtered on `@me` that the viewer has NO identity for. It resolves to a match-nothing
      // sentinel, so the grid renders empty — and adding there writes a row stamped with that same empty
      // identity, which the filter then removes from the view. The row is real and orphaned: it looks
      // like "Add does nothing" while rows pile up unseen. So say what is wrong and stop offering Add.
      // An admin account is the usual case: it manages the household without being a member of it.
      viewIdentityMissing: function(name) {
        var self = this, cols = this.meFilterColsFor(name);
        return cols.length > 0 && cols.every(function(c) { return !self.meValueFor(c); });
      },
      // The same identity resolution keyed by LIST rather than by column, for the callers that have no
      // column to ask about (a rotation view's slots are column NAMES, not cells). meValueFor is the
      // column-shaped wrapper.
      meValueForList: function(list) {
        if (list && this.isUserLinkList(list)) return (this.myListValues || {})[list] || '';
        return this.myDisplayName;
      },
      // Resolve the "@me" filter token. An empty identity -> a sentinel that matches nothing (the user has
      // no assigned identity yet). Display-only client filter -- it never widens server-enforced access.
      resolveMeTokens: function(filter) {
        if (filter == null) return filter;
        var self = this;
        // `key` is the column the token sits under, so a userlink list resolves through its own mapping.
        var walk = function(v, key) {
          if (v === '@me') return self.meValueFor(key) || '\u0000__no_me__';
          if (Array.isArray(v)) return v.map(function(x) { return walk(x, key); });
          if (v && typeof v === 'object') {
            var o = {};
            // $or/$and carry no column of their own -> keep the enclosing key for their branches.
            Object.keys(v).forEach(function(k) { o[k] = walk(v[k], k.charAt(0) === '$' ? key : k); });
            return o;
          }
          return v;
        };
        return walk(filter, null);
      },
      // Shallow view clone with @me resolved in view.filter + view.groupBy.filter (returns the original
      // untouched when no @me token is present, to avoid needless churn).
      _viewWithMe: function(view) {
        if (!view) return view;
        var hasMe = (JSON.stringify(view.filter || null).indexOf('"@me"') >= 0) || (JSON.stringify((view.groupBy && view.groupBy.filter) || null).indexOf('"@me"') >= 0);
        if (!hasMe) return view;
        var v = Object.assign({}, view);
        if (view.filter) v.filter = this.resolveMeTokens(view.filter);
        if (view.groupBy) { v.groupBy = Object.assign({}, view.groupBy); if (view.groupBy.filter) v.groupBy.filter = this.resolveMeTokens(view.groupBy.filter); }
        return v;
      },
      // Inject the leaderboard's ‹ › back-offset into bare @period tokens (@month -> @month-<offset>).
      // Offset 0 leaves tokens unchanged; only bare tokens (no existing -N) are rewritten.
      resolvePeriodTokens: function(filter, offset) {
        if (!offset || filter == null) return filter;
        var re = /^@(today|day|week|month|year)$/;
        var walk = function(v) {
          if (typeof v === 'string' && re.test(v)) return v + '-' + offset;
          if (Array.isArray(v)) return v.map(walk);
          if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function(k) { o[k] = walk(v[k]); }); return o; }
          return v;
        };
        return walk(filter);
      },
      hasPeriodNav: function() { var v = VIEWS[this.currentTable]; return !!(v && v.period); },
      periodUnit: function() { var v = VIEWS[this.currentTable]; return (v && v.period) || 'month'; },
      periodLabel: function() {
        var unit = this.periodUnit(), off = this.periodOffset, now = new Date(), loc = this.calLocale();
        if (unit === 'month') { return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(new Date(now.getFullYear(), now.getMonth() - off, 1)); }
        if (unit === 'year') { return String(now.getFullYear() - off); }
        if (unit === 'week') { return off === 0 ? this.t('period.this_week') : (off + ' ' + this.t('period.weeks_ago')); }
        var dd = new Date(now); dd.setDate(dd.getDate() - off); return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(dd);
      },
      periodPrev: function() { this.periodOffset++; this.loadTableData(); },                 // older
      periodNext: function() { if (this.periodOffset > 0) { this.periodOffset--; this.loadTableData(); } }, // newer (not past present)
      periodToday: function() { if (this.periodOffset !== 0) { this.periodOffset = 0; this.loadTableData(); } },
      // Grants are edited as TWO chip rows — what the user may change, and what they may only look at —
      // which merge into one stored { table: 'r' | 'rw' } map. Each handler re-reads the other row's
      // current selection so editing one never silently drops the other.
      updateUserTables: function(u, selected) {
        var prev = u.tables === 'all' ? ['all'] : this.userFeatures(u);
        var feats = this._resolveTableSelection(selected, prev);   // 'all' or array of FEATURE ids
        if (feats === 'all') return this._saveGrants(u, 'all');
        this._saveGrants(u, AccessFeatures.buildGrants(feats, this.userViewFeatures(u), SCHEMA, VIEWS));
      },
      updateUserViewTables: function(u, selected) {
        // Marking something view-only on a FULL-ACCESS user has to materialize 'all' into an explicit
        // map — the sentinel cannot say "everything except this one". Everything not picked here stays
        // editable, so the Tables column visibly fills with chips: the admin can see what 'all' became.
        // (Consequence worth knowing: an enumerated grant no longer picks up tables added to the schema
        // later, whereas 'all' does. Clearing every view chip puts the user back on the sentinel.)
        if (u.tables === 'all' && !(selected || []).length) return;   // nothing picked -> stay on 'all'
        var edit = u.tables === 'all'
          ? grantFeatures().map(function(f) { return f.id; }).filter(function(id) { return selected.indexOf(id) < 0; })
          : this.userFeatures(u);
        this._saveGrants(u, AccessFeatures.buildGrants(edit, selected, SCHEMA, VIEWS));
      },
      // Clearing every chip means "no restriction" (the long-standing behaviour of the single row) —
      // an empty grant would otherwise lock the user out of an app they were just given access to.
      _saveGrants: function(u, tables) {
        if (tables !== 'all' && !Object.keys(tables).length) tables = 'all';
        return backend_users.setUserRole(u.key, u.role, u.addr, tables).then(this.loadUsers.bind(this));
      },
      userFeatures: function(u) {
        // Stored grant -> selected feature ids for the EDIT row (features fully covered at 'rw').
        if (!u || u.tables === 'all') return ['all'];
        return selectedFeatures(AccessFeatures.writableTables(u.tables) || []);
      },
      userViewFeatures: function(u) {
        // The VIEW row shows what is readable but NOT writable — otherwise every edit grant would also
        // light up here and un-ticking it would read as revoking sight, not revoking write.
        if (!u || u.tables === 'all') return [];
        var write = selectedFeatures(AccessFeatures.writableTables(u.tables) || []);
        return selectedFeatures(AccessFeatures.readableTables(u.tables) || [])
          .filter(function(f) { return write.indexOf(f) < 0; });
      },
      _resolveTableSelection: function(selected, prev) {
        if (selected.indexOf('all') >= 0 && prev.indexOf('all') < 0) return 'all';
        if (selected.indexOf('all') >= 0 && selected.length > 1) return selected.filter(function(s) { return s !== 'all'; });
        if (selected.indexOf('all') >= 0) return 'all';
        return selected.length ? selected : 'all';
      },
      removeUser: function(uid) {
        var self = this;
        backend_users.removeUser(uid).then(function() { self.loadUsers(); });
      },
      addUser: function() {
        var self = this;
        var key = '_new_' + Date.now();
        backend_users.setUserRole(key, 'editor', '', 'all').then(function() {
          self.loadUsers();
        });
      },
      renameUser: function(u, newAddr) {
        // Normalize to lowercase so the doc key matches the (lowercased) Firebase auth email —
        // Firestore rules look up _meta/users[request.auth.token.email] with an EXACT key match.
        newAddr = (newAddr || '').trim().toLowerCase();
        if (!newAddr || newAddr === u.key) return;   // key IS the identity Firestore rules match on
        var self = this;
        backend_users.removeUser(u.key).then(function() {
          return backend_users.setUserRole(newAddr, u.role, newAddr, u.tables);  // re-key doc: key = email
        }).then(function() { self.loadUsers(); });
      },
      saveFirebaseConfig: function() {
        var input = this.firebaseConfigInput.trim();
        if (!input && this.hasFirebaseConfig) {
          localStorage.setItem('app_mode', 'firebase');
          location.reload();
          return;
        }
        try {
          // Accept both JSON and Firebase console JS snippet format
          var jsonStr = input;
          if (jsonStr.indexOf('{') > 0) jsonStr = jsonStr.substring(jsonStr.indexOf('{'));
          if (jsonStr.lastIndexOf('}') < jsonStr.length - 1) jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf('}') + 1);
          jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/^\s*(\w+)\s*:/gm, '"$1":');
          var config = JSON.parse(jsonStr);
          if (!config.apiKey || !config.projectId) { this.notify(this.t('msg.invalid_config')); return; }
          // remember() stores it UNDER ITS KEY and makes it active, so connecting to a second
          // database no longer overwrites the first — and sets app_mode, which it used to do here.
          Databases.remember('firebase', config);
          // Try saving server-side for other users
          fetch(_u('/api/saveConfig'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({filename:'firebase-config.json', data:config}) }).catch(function(){});
          location.reload();
        } catch(e) { this.notify(this.t('msg.invalid_json')); }
      },
      saveSupabaseConfig: function() {
        var url = (this.supabaseUrlInput || '').trim().replace(/\/+$/, '');
        var key = (this.supabaseKeyInput || '').trim();
        if (!url || !key) return;
        Databases.remember('supabase', { url: url, anonKey: key });
        localStorage.setItem('app_folder', 'supabase');
        // Try saving server-side for other users (dev server only; harmless 404 on static hosting).
        fetch(_u('/api/saveConfig'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({filename:'supabase-config.json', data:{url:url, anonKey:key}}) }).catch(function(){});
        location.reload();   // reload so index.html loads the SDK + backend for mode=supabase
      },
      // Switch database. A full reload rather than a re-init: the backend module, its SDK and every
      // cache in the app were chosen for the OLD database at boot, and there is no unwinding that
      // safely — a half-switched app reading one project's schema against another's rows is the kind
      // of bug that corrupts data rather than showing an error.
      switchDatabase: function(key) {
        if (!key || key === Databases.activeKey()) return;
        if (!Databases.setActive(key)) { this.notify(this.t('msg.error')); return; }
        location.reload();
      },
      // Forget a database: drops the stored config, not the data — the database itself is untouched,
      // and a shared link brings it back. Only the active one needs a reload (there is nothing left
      // for the app to be pointed at).
      forgetDatabase: function(key) {
        var wasActive = Databases.activeKey() === key;
        Databases.forget(key);
        if (wasActive) location.reload();
      },
      exportData: function() {
        var self = this;
        var data = {};
        // A backup is the one place where "not cached" must never quietly become "empty". This read the
        // cache and substituted [] -- safe only by accident, because boot happens to load every granted
        // table. It is not safe when a read FAILS: both the boot path and _ensureCached cache [] on
        // failure (fail-closed, correct for a grid), and that empty array was then written into the file
        // as though the table really were empty. A backup that silently drops a table is worse than no
        // backup, because it is the one that gets trusted.
        //
        // So: fetch what is missing, and produce no file at all if any read fails. This also stops boot
        // from being load-bearing for exports, which is what a lazier boot needs.
        var wanted = [], failed = [];
        Object.keys(SCHEMA).forEach(function(table) {
          // Omit what this user cannot read rather than asserting it is empty. Import is additive
          // (delete+put per row), so an omitted table is left untouched on restore exactly as an empty
          // one would be -- but the file no longer says something false about it.
          if (!self.canReachTable(table)) return;
          wanted.push([table, table, 'active']);
          if (SCHEMA[table].archivable) wanted.push([aKey(table), table, 'archive']);
        });
        var gather = Promise.all(wanted.map(function(w) {
          var key = w[0];
          if (self.dataCache[key]) { data[key] = self.dataCache[key]; return null; }
          return Promise.resolve(backend.getTableData(w[1], w[2])).then(function(res) {
            data[key] = parseTableResult(res).rows;
          }).catch(function() { failed.push(key); });
        }));
        // Gather translations
        var translations = {};
        var chain = gather;
        self.languages.forEach(function(lang) {
          chain = chain.then(function() {
            return backend.getTranslations(lang.code).then(function(t) { translations[lang.code] = t; });
          });
        });
        // Shared tail for both branches below: assemble the bundle around the cleaned schema + extras,
        // then download it (the stringify/Blob/anchor dance was duplicated verbatim in then/catch).
        var download = function(schema, extras) {
          var payload = Object.assign({ schema: schema, tables: data, lists: self.listsCache, languages: self.languages, translations: translations }, extras, { config: exportableConfig(self.appConfig), exportedAt: new Date().toISOString() });
          var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = 'drive-sync-export-' + new Date().toISOString().slice(0, 10) + '.json';
          a.click();
          self.notify(self.t('msg.exported'));
        };
        chain.then(function() {
          // Refuse rather than hand over a file with a hole in it. The tables are named so the user can
          // tell a permission problem from a network one.
          if (failed.length) {
            self.notify(self.t('msg.export_incomplete') + ' ' + failed.join(', '));
            return;                      // no file at all -- a partial backup is the one that gets trusted
          }
          // _pages and _assets are SYSTEM stores, so neither is in `tables` above (that map is built from
          // Object.keys(SCHEMA)) — each needs an explicit read to reach the bundle. Assets carry the actual
          // image bytes as data URIs; without them an import lands with `asset:` references resolving to
          // nothing, i.e. a blank background and broken thumbnails.
          return Promise.all([
            Promise.resolve(backend.getTableData('_pages', 'active')).catch(function() { return null; }),
            Promise.resolve(backend.getTableData('_assets', 'active')).catch(function() { return null; })
          ]).then(function(res) {
            var d = res[0], da = res[1];
            var pages = (d && d.rows || []).filter(function(r) { return r.id && r.markdown; });
            var assets = (da && da.rows || []).filter(function(r) { return r.id && r.src; }).map(function(r) { return { id: r.id, src: r.src }; });
            // Export columns as the documented array-of-objects form (strip runtime-injected id; restore order + name).
            var schema = JSON.parse(JSON.stringify(self.schemaData));
            if (schema.tables) Object.keys(schema.tables).forEach(function(t) {
              var c = schema.tables[t].columns;
              if (c && typeof c === 'object' && !Array.isArray(c)) {
                delete c.id;
                var order = (window._columnOrders && window._columnOrders[t]) || Object.keys(c);
                schema.tables[t].columns = order.filter(function(n) { return n !== 'id' && (n in c); }).map(function(n) {
                  var def = c[n];
                  return (def && typeof def === 'object') ? Object.assign({ name: n }, def) : { name: n };
                });
              }
            });
            convertViewFilters(schema.views);   // emit array-IN filters as explicit $or (forward-deprecation)
            var extras = {};
            if (pages.length) extras.pages = pages;
            if (assets.length) extras.assets = assets;
            download(schema, extras);
          }).catch(function() {
            var schema = JSON.parse(JSON.stringify(self.schemaData));
            if (schema.tables) Object.keys(schema.tables).forEach(function(t) { var c = schema.tables[t].columns; if (c) { delete c.id; } delete schema.tables[t].partition; delete schema.tables[t].archivePartition; });
            download(schema, {});
          });
        });
      },
      // --- The shipped examples ------------------------------------------------------------------
      // examples/ is served by the deployment itself (it survives both publish paths' exclusion lists),
      // so this is a same-origin GET: no CORS, no CDN, nothing to allow in the CSP, and it resolves
      // under a project-Pages subpath because _u() puts APP_BASE in front of it.
      //
      // `no-cache` revalidates rather than refetches. Both hosts serve JSON with a max-age long enough
      // to hide a fresh manifest for an hour, which is exactly the window in which someone redeploys
      // and then goes looking for the update this is meant to report.
      fetchExampleManifest: function() {
        var self = this;
        if (self.examples.manifest) return Promise.resolve(self.examples.manifest);
        return fetch(_u('/examples/index.json'), { cache: 'no-cache' })
          .then(function(r) {
            // fetch() resolves on 404, and a host's error page is not a manifest.
            if (!r.ok) throw new Error('examples/index.json: HTTP ' + r.status);
            return r.json();
          })
          .then(function(m) { self.examples.manifest = m; return m; });
      },
      // Open the picker. Deliberately does the fetch here rather than at boot: nobody but an admin
      // installing something needs it, and a boot is the one moment this app cannot afford another
      // round-trip.
      openExamples: function() {
        var self = this;
        self.examples.open = true;
        self.examples.error = '';
        if (self.examples.manifest) return;
        self.examples.busy = true;
        self.fetchExampleManifest()
          .then(function(m) { self.pickExample((m.bundles || [])[0]); })
          .catch(function(err) { self.examples.error = String((err && err.message) || err); })
          .then(function() { self.examples.busy = false; });
      },
      // Choosing a bundle preselects its languages: every one it ships, since a language pack is small
      // and a missing one shows raw keys. Sample rows default ON only for a database with nothing in
      // it -- layering demo rows onto real ones is a different, deliberate act.
      pickExample: function(bundle) {
        if (!bundle) return;
        this.examples.pick = bundle;
        this.examples.langs = (bundle.languages || []).map(function(l) { return l.code; });
        this.examples.withData = !!bundle.data && !this.hasAnyTables;
      },
      exampleLangSelected: function(code) { return this.examples.langs.indexOf(code) >= 0; },
      toggleExampleLang: function(code) {
        var at = this.examples.langs.indexOf(code);
        if (at >= 0) this.examples.langs.splice(at, 1); else this.examples.langs.push(code);
      },
      // Fetch the chosen files, fold them into one bundle, and hand it to the same import the file
      // picker uses. The ORDER is the documented one (structure, then its labels, then the app's own
      // UI text, then sample rows) because that is what mergeFiles resolves conflicts by.
      installExample: function() {
        var self = this;
        var manifest = self.examples.manifest;
        var bundle = self.examples.pick;
        if (!manifest || !bundle) return Promise.resolve();
        var codes = self.examples.langs;

        var files = [bundle.schema];
        (bundle.languages || []).forEach(function(l) { if (codes.indexOf(l.code) >= 0) files.push(l); });
        (manifest.appLanguages || []).forEach(function(l) { if (codes.indexOf(l.code) >= 0) files.push(l); });
        if (self.examples.withData && bundle.data) files.push(bundle.data);

        self.examples.busy = true;
        self.examples.error = '';
        return Promise.all(files.map(function(f) {
          return fetch(_u('/examples/' + f.file), { cache: 'no-cache' }).then(function(r) {
            if (!r.ok) throw new Error(f.file + ': HTTP ' + r.status);
            return r.json();
          });
        })).then(function(parsed) {
          var merged = Examples.mergeFiles(parsed);
          self.examples.open = false;
          self.applyBundle(merged, { provenance: {
            bundle: bundle.id,
            revision: bundle.revision || 1,
            importedAt: new Date().toISOString(),
            // Only the files actually installed: a database that skipped the sample rows must not be
            // told later that the sample rows have changed.
            files: files.reduce(function(acc, f) { acc[f.file] = f.hash; return acc; }, {})
            // NO `units:` here. Examples.fingerprint(merged) produces one hash per column, view, list
            // and translation string -- the third point a three-way merge needs, to tell "upstream
            // changed this" from "you changed this". It was written from the first install so the
            // merge could arrive without a migration, but nothing reads it yet, and on a real bundle
            // it is ~18 kB sitting in the folder config that EVERY registered user fetches at boot.
            // Paying that for a feature that does not exist is the wrong way round: re-enable it here
            // (the function and its tests are intact) when the merge is actually being built.
          } });
        }).catch(function(err) {
          self.examples.error = String((err && err.message) || err);
        }).then(function() { self.examples.busy = false; });
      },
      // A lookup TABLE named in `translatableLists` has its values enumerated straight out of dataCache
      // (schemaTranslationKeys), and nothing else guarantees that table is loaded -- a lookup is cached
      // as a side effect of some view that happens to reference it. So the Languages editor offered the
      // vocabularies whose tables the home page pulled in and silently omitted the rest: `ref_rewards`
      // appeared because doc_home embeds reward_shop, `ref_chores` did not. Which values you could
      // translate depended on where you had been, which is the worst kind of missing -- it looks like
      // the feature working.
      //
      // Declaring a table translatable IS the declaration that its values must be enumerable, so the
      // Languages screen loads them. Lookup tables are small controlled vocabularies and _ensureCached
      // is a no-op for the ones already there.
      _ensureTranslatableLookups: function() {
        var names = ((this.schemaData && this.schemaData.translatableLists) || [])
          .filter(function(n) { return SCHEMA[n] && SCHEMA[n].isLookup; });
        if (names.length) this._ensureCached(names);
      },
      // Has this deployment's examples moved on since one was installed here? Checked when Settings is
      // opened -- the place that answers "is anything out of date?" -- and once per session, by an
      // admin only. Failure is silence: an offline tab or a deployment that ships no manifest is not
      // something to interrupt anyone about.
      checkExampleUpdates: function() {
        var self = this;
        if (self.exampleUpdateChecked || !self.isAdmin) return;
        var installed = self.appConfig && self.appConfig.example;
        if (!installed || !installed.bundle) return;
        self.exampleUpdateChecked = true;
        self.fetchExampleManifest()
          .then(function(m) { self.exampleUpdate = Examples.compare(installed, m); })
          .catch(function() {});
      },
      // Reinstalling is the update path for now: the same files, imported over the top. It REPLACES
      // the schema and the labels, which is why it asks first and why the dialog says so -- the
      // fingerprints recorded at install exist so a later change can merge instead of replace.
      reinstallExample: function() {
        var self = this;
        var found = (this.examples.manifest.bundles || []).filter(function(b) { return b.id === self.exampleUpdate.bundle; })[0];
        if (!found) return;
        this.pickExample(found);
        this.examples.withData = false;      // never re-lay sample rows over a database in use
        this.examples.open = true;
      },
      // Import from a FILE the user picked. The bundle half of the work is applyBundle, which the
      // example picker drives with files it fetched instead.
      importData: function(event) {
        var self = this;
        var file = event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
          try { self.applyBundle(JSON.parse(e.target.result)); }
          catch (err) { self.importProgress = null; self.notify(self.t('msg.import_error') + ' ' + err.message); }
        };
        reader.readAsText(file);
        event.target.value = '';
      },
      // THE import: everything that turns a parsed bundle into a database. Two callers -- the file
      // input above, and installExample() with a bundle fetched from examples/ -- so the progress
      // dialog, the reference check, the row/translation/page/asset ordering and the reload are
      // written once.
      //
      // `opts.provenance`, when given, is recorded in the folder config as the last step: WHICH
      // example this database was installed from, and the per-unit fingerprints of what it looked
      // like at the time. Written inside the same chain so a half-finished install cannot claim to
      // be a finished one.
      applyBundle: function(imported, opts) {
        var self = this;
        try {
          // A file may be a bare schema document rather than an export-shaped bundle; Examples.asBundle
          // is the one place that distinction is made.
          imported = Examples.asBundle(imported);
          // Structural check: block import if the schema has dangling view/table references
          if (imported.schema) {
            var refErrs = validateRefs(imported.schema);
            if (refErrs.length) { self.notify(self.t('msg.import_blocked') + ' ' + refErrs[0] + (refErrs.length > 1 ? ' (+' + (refErrs.length - 1) + ' more)' : '')); return; }
          }

          // Flatten the row work up front: it dominates the run (two round-trips per row) and so defines
          // both the ordering and the progress total.
          var tables = imported.tables || {};
          var rowJobs = [];
          // This is also the MIGRATION route from partition-as-store to partition-as-field, which is
          // why every row now imports into the active store whatever key it arrived under. A suffixed
          // key -- `tasks__archive` -- becomes a `_status` stamp instead of a second collection, so
          // exporting a deployment and importing the bundle back is what moves it over. Deliberately
          // through the bundle rather than in place: an in-place sweep would have to rewrite live rows
          // across two backends with no transaction, which is the thing this change exists to stop
          // doing.
          //
          // `_status` on the row wins if the bundle already carries one, so re-importing an
          // already-migrated bundle changes nothing.
          Object.keys(tables).forEach(function(key) {
            var rows = Array.isArray(tables[key]) ? tables[key] : (tables[key].rows || []);
            var parts = key.split('__');
            var archived = parts.length > 1;
            rows.forEach(function(row) {
              rowJobs.push({
                table: parts[0],
                tab: 'active',
                // The old collection has to be cleared as the row lands in the new one, or the id
                // exists in both and the archive partition shows it twice.
                clearArchive: archived,
                row: archived ? Object.assign({}, row, { _status: row._status || 'archive' }) : row
              });
            });
          });
          var langCodes = imported.translations ? Object.keys(imported.translations) : [];
          var pages = (imported.pages && Array.isArray(imported.pages))
            ? imported.pages.filter(function(p) { return p.id && p.markdown; }) : [];
          // Stored image assets (view backgrounds / image-cell bytes as data URIs). Over-cap entries are
          // dropped here rather than attempted: both production rule layers reject them, so importing one
          // would only produce a failure row in the progress report.
          var assets = (imported.assets && Array.isArray(imported.assets))
            ? imported.assets.filter(function(a) { return a && a.id && typeof a.src === 'string' && a.src.length <= ASSET_CAP; }) : [];

          // Progress + failure state. Two things were wrong before: the run gave no sign of life for the
          // ~minute it takes on a real database, and — worse — the whole thing was ONE serial promise
          // chain with no .catch(), so a single rejected write silently abandoned every step after it.
          // That is how an import could land schema + rows and then no translations at all, with no
          // error shown. (The old try/catch only ever caught synchronous errors while BUILDING the chain.)
          var prog = {
            active: true, done: 0, icon: 'mdi-timer-sand', detail: '', errors: [], finished: false,
            total: (imported.schema ? 1 : 0) + rowJobs.length + (imported.lists ? 1 : 0)
                 + langCodes.length + pages.length + assets.length + (imported.config ? 1 : 0)
                 + ((opts && opts.provenance) ? 1 : 0) + 1
          };
          self.importProgress = prog;
          prog = self.importProgress;   // Vue hands back a reactive proxy; mutate THAT or the UI never updates

          // One unit of work: record a failure and CARRY ON, so one bad row can't cost you the
          // translations, pages and config that come after it.
          // An import runs BEFORE any translations are loaded — and is often the very thing installing
          // them — so it can't describe itself in words. Each step carries an mdi icon plus `detail`
          // that reads the same in any language: counts, table names, language codes.
          function step(icon, detail, fn) {
            return function() {
              prog.icon = icon; prog.detail = detail;
              return Promise.resolve().then(fn).catch(function(err) {
                prog.errors.push({ icon: icon, detail: detail, message: (err && err.message) || String(err) });
              }).then(function() { prog.done++; });
            };
          }

          var chain = Promise.resolve();
          // Import schema if present (initializes empty databases)
          if (imported.schema && backend.saveSchema) {
            chain = chain.then(step('mdi-table-cog', '', function() {
              // Rebuild VIEWS from new schema so lockedListValues works
              if (Array.isArray(imported.schema.views)) {
                _viewsNav = imported.schema.views;
                VIEWS = SchemaNormalize.flattenViews(_viewsNav);
              }
              return backend.saveSchema(imported.schema).then(function() {
                _normalizeSchema(imported.schema);
                self.schemaData = Object.freeze(imported.schema); // mirror boot: refresh the reactive schema (invalidates lockedListValues et al.)
                return backend.initSchema(SCHEMA);
              }).then(function() {
              });
            }));
          }
          rowJobs.forEach(function(job, i) {
            chain = chain.then(step('mdi-table-row', (i + 1) + '/' + rowJobs.length + ' · ' + job.table, function() {
              var target = job.table;
              // Delete first to force change detection on re-import.
              return Writes.deleteRow(target, job.row.id, job.tab).catch(function() {})
                .then(function() {
                  // A row arriving from a `__archive` key is being MOVED out of that collection, so
                  // clear it there too. Failures are swallowed like the delete above: the row not
                  // being there is the normal case on a fresh import.
                  return job.clearArchive ? Writes.deleteRow(target, job.row.id, 'archive').catch(function() {}) : null;
                })
                .then(function() { return Writes.putRow(target, job.row, job.tab); });
            }));
          });
          if (imported.lists) {
            chain = chain.then(step('mdi-format-list-bulleted', '', function() {
              // An EXAMPLE fills the vocabularies this database has not started and leaves the rest
              // alone; a hand-picked file replaces them (and prunes what it omits), because that is a
              // restore. See Examples.listsForInstall for why the difference matters.
              var next = (opts && opts.provenance)
                ? Examples.listsForInstall(self.listsCache, imported.lists) : imported.lists;
              self.listsCache = next;
              return backend.saveLists(next);
            }));
          }
          langCodes.forEach(function(code) {
            chain = chain.then(step('mdi-translate', code, function() {
              // Ensure language exists before writing translations
              var langName = (imported.languages || []).find(function(l) { return l.code === code; });
              return backend.createLanguage(code, langName ? langName.name : code, Object.keys(imported.translations[code]))
                .catch(function() {})   // already present is fine; the merge below still writes the strings
                .then(function() { return backend.updateTranslations(code, imported.translations[code]); });
            }));
          });
          pages.forEach(function(page) {
            chain = chain.then(step('mdi-file-document-outline', page.id, function() {
              return Writes.putRow('_pages', { id: page.id, markdown: page.markdown }, 'active');
            }));
          });
          assets.forEach(function(asset) {
            chain = chain.then(step('mdi-image-outline', asset.id, function() {
              return Writes.putRow('_assets', { id: asset.id, src: asset.src }, 'active');
            }));
          });
          // Restore portable folder config (rotationAnchors, rotationRanges, any future portable key),
          // preserving this environment's `mode`. Excluded keys never cross the import boundary.
          if (imported.config && backend.setFolderConfig) {
            chain = chain.then(step('mdi-cog', '', function() {
              var merged = mergeImportedConfig(self.appConfig, imported.config, self.mode);
              self.appConfig = merged;
              return backend.setFolderConfig(merged);
            }));
          }
          // Where this database came from. AFTER the config merge above, since a data file may carry a
          // config of its own and this must not be merged away; and inside the chain, so a run that
          // fell over half way does not leave the database claiming a clean install.
          //
          // It rides appConfig (the _meta/config doc): admin-writable on every backend, already read
          // at boot, and portable through export/import for free -- an exported database remembers
          // which example it was built from.
          if (opts && opts.provenance && backend.setFolderConfig) {
            chain = chain.then(step('mdi-tag-outline', opts.provenance.bundle, function() {
              var merged = Object.assign({}, self.appConfig, { example: opts.provenance });
              self.appConfig = merged;
              return backend.setFolderConfig(merged);
            }));
          }

          // A filter-pinned value must exist wherever the picker reads its options from, so the import
          // cannot leave a schema keying on a value nothing offers.
          //
          // For a LOOKUP TABLE that place is a ROW, never a list. lockedListValues is keyed by table
          // name as well as list name (forEachFilterListValue pins a `ref` filter under its table), so
          // minting a list here forged a second, three-value copy of a fifteen-row catalogue: the
          // picker went on reading the table (getListOptions prefers it), while the Lists tab offered
          // the phantom as a live vocabulary an admin could type into, and putListItem persisted what
          // they typed where nothing would ever read it. _seedSchemaLists refuses the same creation for
          // the same reason; this step had simply not been told.
          //
          // The rows themselves need no seeding: an import writes the lookup's rows, and isLockedRefRow
          // then stops the ref editor renaming or deleting the pinned ones.
          //
          // Skipping the whole name (not just its creation) is what the seed means for a lookup, and it
          // also makes the remaining branch honest: every non-lookup name reachable here is a column's
          // own `list:`, which _seedSchemaLists already created at boot, so the create below now only
          // ever covers a list this import replaced wholesale.
          chain = chain.then(step('mdi-format-list-checks', '', function() {
            var locked = self.lockedListValues;
            var needSave = false;
            for (var ln in locked) {
              if (SCHEMA[ln] && SCHEMA[ln].isLookup) continue;
              if (!self.listsCache[ln]) { self.listsCache[ln] = []; needSave = true; }
              for (var lv in locked[ln]) {
                if (self.listsCache[ln].indexOf(lv) < 0) { self.listsCache[ln].push(lv); needSave = true; }
              }
            }
            return needSave ? backend.saveLists(self.listsCache) : Promise.resolve();
          }));

          chain.then(function() {
            prog.finished = true;
            prog.icon = prog.errors.length ? 'mdi-alert' : 'mdi-check';
            prog.detail = '';
            if (prog.errors.length) {
              // Hold the dialog open: a PARTIAL import has to be seen and acted on, not flashed past.
              // The console copy stays plain text — it's for a developer, not the UI.
              console.error('[import] ' + prog.errors.length + '/' + prog.total + ' failed:\n' +
                prog.errors.map(function(e) {
                  return '  ' + e.icon.replace(/^mdi-/, '') + (e.detail ? ' ' + e.detail : '') + ' — ' + e.message;
                }).join('\n'));
              return;
            }
            self.importProgress = null;
            self.notify(self.t('msg.import_complete'));   // translated key, not an assembled English sentence
            setTimeout(function() { self.finishImportReload(); }, 1500); // delay reload so the snackbar is visible
          }).catch(function(err) {
            // Last-resort net: step() already absorbs per-step failures, so reaching here means the
            // bookkeeping itself broke. Surface it rather than leaving a spinner up forever.
            prog.finished = true;
            prog.icon = 'mdi-alert';
            prog.errors.push({ icon: 'mdi-alert-circle', detail: '', message: (err && err.message) || String(err) });
          });
        } catch(err) { self.importProgress = null; self.notify(self.t('msg.import_error') + ' ' + err.message); }
      },
      // Reload so the freshly imported data is picked up. Extracted from importData so the progress
      // dialog's "Reload" button can trigger it after a partial import the user has read.
      finishImportReload: function() {
        this.importProgress = null;
        // Drop the listeners first: an import rewrites whole tables, and the reload below can be up to a
        // second away (the CRDT push paths). Without this, every imported row arrives as a live change
        // against a dataCache that is about to be thrown away.
        this._liveUnwatchAll();
        if (typeof _pushChanges === 'function') { _pushChanges().then(function() { location.reload(); }); }
        else if (typeof CrdtEngine !== 'undefined') { CrdtEngine.pushChanges().then(function() { setTimeout(function() { location.reload(); }, 100); }); }
        else { location.reload(); }
      },
      triggerOAuth: function() { if (typeof triggerOAuth === 'function') triggerOAuth(); },
      selectSetupMode: function(mode) {
        this.setupStep = mode || null;
        if (mode) { localStorage.setItem('app_mode', mode); }
        else { localStorage.removeItem('app_mode'); location.reload(); return; }
        if (mode === 'firebase' && !this.firestoreRules) {
          var self = this;
          fetch(_u('/firestore.rules')).then(function(r) { return r.ok ? r.text() : ''; }).then(function(t) { self.firestoreRules = t; }).catch(function(){});
        }
      },

      // Sync
      refreshData: function() {
        var self = this;
        self.syncing = true;
        // Re-fetch the current view's source tables from the backend and rebuild the view.
        var view = VIEWS[self.currentTable];
        // Source tables to refresh: a data view's sources, else the current table itself.
        // Doc-views (markdown, no sources) and "no table open" yield [] — refresh is a safe no-op + rebuild.
        var sources = (view && Array.isArray(view.sources)) ? view.sources
          : (SCHEMA[self.currentTable] ? [self.currentTable] : []);
        var chain = Promise.resolve();
        sources.forEach(function(src) {
          chain = chain.then(function() {
            return backend.getTableData(src, 'active').then(function(r) {
              self.dataCache[src] = (r && r.rows) ? r.rows : [];
            });
          });
        });
        chain.then(function() { self.loadTableData(); self.syncing = false; self.notify(self.t('msg.synced')); }).catch(function(err) {
          self.syncing = false;
          self.notify(err && err.message ? err.message : self.t('msg.sync_failed'));
        });
      },

      generateId: function() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 5); },

      focusLastEditable: function(selector) {
        this.$nextTick(function() {
          var cells = document.querySelectorAll(selector);
          if (cells.length) cells[0].focus();
        });
      },

      // Which TABLE a row belongs to, for a view that may be over several. `v.sources[0]` was read
      // unguarded, which is fine for the kinds that have sources and throws for the ones that name their
      // table per-kind instead -- a `form` writes `form.table`, and saving any field on one died here
      // before the write was even attempted.
      getSource: function(item, ownerId) {
        ownerId = ownerId || this.currentTable;
        if (item && item._source) return item._source;
        var v = VIEWS[ownerId];
        if (!v) return ownerId;
        if (v.sources && v.sources.length) return v.sources[0];
        if (v.form && v.form.table) return v.form.table;
        return ownerId;
      },

      getTab: function(source) {
        return this.viewingArchive ? 'archive' : 'active';
      },

      _deleteFromSources: function(sources, itemId, fromArchive) {
        var self = this;
        sources.forEach(function(src) {
          var tab = fromArchive ? 'archive' : 'active';
          var key = fromArchive ? aKey(src) : src;
          self.dataCache[key] = (self.dataCache[key] || []).filter(function(r) { return r.id !== itemId; });
          Writes.deleteRow(src, itemId, tab);
        });
        this.currentData = this.currentData.filter(function(r) { return r.id !== itemId; });
        this.notify(this.t('msg.deleted'));
      },
      // Apply every table's `archiveAfter` policy once the cache is loaded: rows that have sat in a
      // terminal state long enough file themselves away, so a log stays the recent past without anyone
      // doing it by hand. Deliberately client-side and best-effort — there is no server-side scheduler —
      // so it runs only for someone who could archive by hand anyway, and a concurrent second run is
      // harmless: _archiveInSources skips a row already in the archive partition, and the underlying
      // write is an idempotent `_status` stamp rather than a move.
      _autoArchive: function() {
        var self = this, now = new Date();
        // Grants decide whether we may write, so wait until they are known — before that
        // userWritableTables reads as unrestricted and would sweep on a read-only user's behalf. Both
        // boot paths and loadUsers' done() call this; whichever satisfies both preconditions last does
        // the work, and a repeat run finds nothing left to move.
        if (!this.usersLoaded) return;
        Object.keys(SCHEMA).forEach(function(table) {
          var cfg = SCHEMA[table] && SCHEMA[table].archiveAfter;
          if (!cfg || !SCHEMA[table].archivable) return;
          // Never write on someone's behalf who is not allowed to: the archive fans out over the whole
          // mirror cluster, so require write access to all of it (self-service rows are the owner's own).
          var writable = self.userWritableTables;
          if (writable && !withMirrors([table]).every(function(t) { return writable.indexOf(t) >= 0; })) return;
          // The ACTIVE partition only. dataCache[table] now holds filed-away rows too, and an
          // archived row still matches an archiveAfter policy -- _archiveInSources would skip it,
          // but scanning it every sweep is work with no possible outcome.
          var ids = BackendHelpers.autoArchiveIds(Rows.partitionRows(self.dataCache, table, 'active'), cfg, now);
          ids.forEach(function(id) { self._archiveInSources(withMirrors([table]), id, true); });
        });
      },
      // Archiving is a FIELD WRITE now, not a move between collections. The row stays where it is and
      // `_status` says which partition it belongs to, which partitionRows already honours.
      //
      // What that buys, beyond one write instead of two: moveRow is delete-then-put across two
      // collections with no transaction, and the backend contract says so outright -- a failure between
      // the halves loses the row. There is no between any more.
      //
      // A PARTIAL patch, not the whole row: the contract pins that an omitted column keeps its stored
      // value on every backend, and sending our cached copy of the rest is the cross-client clobber
      // saveField already avoids.
      _archiveInSources: function(sources, itemId, quiet) {
        var self = this;
        sources.forEach(function(source) {
          var schema = SCHEMA[source];
          if (!schema || !schema.archivable) return;
          var srcRow = (self.dataCache[source] || []).find(function(r) { return r.id === itemId; });
          if (!srcRow || Rows.partitionOf(srcRow, 'active') === 'archive') return;
          srcRow._status = 'archive';
          srcRow.updated_at = new Date().toISOString();
          Writes.putRow(source, { id: itemId, _status: 'archive', updated_at: srcRow.updated_at }, 'active');
        });
        if (!quiet) this.notify(this.t('msg.archived'));   // the auto sweep files rows silently
      },
      armDelete: function(key) {
        var self = this;
        self.pendingDelete = key;
        clearTimeout(self.pendingDeleteTimer);
        self.pendingDeleteTimer = setTimeout(function() { self.pendingDelete = null; }, 3000);
      },

      isArmed: function(key) { return this.pendingDelete === key; },

      // Per-database favicon + apple-touch-icon from schema.icons (absolute URLs, may be cross-origin).
      // Missing fields keep the bundled static defaults declared in index.html, so switching databases
      // (or clearing a field) always resolves to a correct icon.
      _applyIconLinks: function() {
        var sIcons = (this.schemaData && this.schemaData.icons) || {};
        var fav = document.querySelector('link[rel="icon"]');
        if (fav) fav.setAttribute('href', sIcons.favicon || './favicon.svg');
        var apple = document.querySelector('link[rel="apple-touch-icon"]');
        if (apple) apple.setAttribute('href', sIcons.appleTouch || './icon-512.png');
      },

      // Apply per-database brand colors from schema.theme onto the live Vuetify theme — a PARTIAL override
      // of the built-in light/dark palettes, so a deployment brands itself via the schema (no code edit),
      // like icons/nav/languages. Reassigns the colors object so Vuetify regenerates its --v-theme-* CSS
      // variables reactively; the dynamic theme-color meta (in _updateManifest) then follows. Shape:
      //   "theme": { "light": { "primary": "#..", "surface": "#.." }, "dark": { "primary": "#.." } }
      _applyTheme: function(theme) {
        if (!theme || !this.$vuetify || !this.$vuetify.theme) return;
        var themes = this.$vuetify.theme.themes;
        themes = (themes && themes.value) ? themes.value : themes; // reactive ref (runtime) vs plain object
        ['light', 'dark'].forEach(function(name) {
          var overrides = theme[name];
          if (!overrides || !themes[name] || !themes[name].colors) return;
          // Mutate individual keys (NOT reassign the colors object): Vuetify's stylesheet computed holds
          // a ref to this object, so per-key mutation is what makes it regenerate --v-theme-* at runtime.
          Object.keys(overrides).forEach(function(k) { themes[name].colors[k] = overrides[k]; });
        });
      },
      // Cache the resolved brand colors (both modes) so the NEXT boot's pre-Vue splash (index.html) can
      // paint in-brand — the splash renders before Vuetify exists, so it reads this localStorage instead.
      _cacheSplashBrand: function() {
        try {
          if (!this.$vuetify || !this.$vuetify.theme) return;
          var themes = this.$vuetify.theme.themes; themes = (themes && themes.value) ? themes.value : themes;
          var pick = function(name, fp, fb) { var c = (themes[name] && themes[name].colors) || {}; return { p: c.primary || fp, bg: c.background || c.surface || fb }; };
          localStorage.setItem('brand_splash', JSON.stringify({ light: pick('light', '#1976d2', '#ffffff'), dark: pick('dark', '#90caf9', '#121212') }));
        } catch (e) {}
      },

      // --- Admin brand-palette editor (Settings). Edits schema.theme -> the deployment brand for everyone.
      // Live-previews via _applyTheme; persists by replacing the frozen schemaData + saveSchema (same
      // pattern as the default-language change). `themeColor` reads the live theme, normalized to #rrggbb
      // for <input type=color>; unspecified colors fall back to Vuetify's contrast default.
      themeColor: function(mode, token) {
        // Read REACTIVE sources first (session edits, then saved schema.theme) so the pickers/fields
        // refresh after setThemeColor/applyPalette — $vuetify.theme.themes is not reactive (Vuetify 4).
        var c = (this.themeEdit[mode] && this.themeEdit[mode][token])
          || (this.schemaData && this.schemaData.theme && this.schemaData.theme[mode] && this.schemaData.theme[mode][token]);
        if (!c) { // fall back to Vuetify's default (defaults don't change at runtime -> non-reactive is fine)
          var t = this.$vuetify && this.$vuetify.theme, themes = t && t.themes;
          themes = (themes && themes.value) ? themes.value : themes;
          c = (themes && themes[mode] && themes[mode].colors && themes[mode].colors[token]) || '';
        }
        if (/^#[0-9a-fA-F]{6}$/.test(c)) return c;
        if (/^#[0-9a-fA-F]{3}$/.test(c)) return '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
        return mode === 'dark' ? '#ffffff' : '#000000';
      },
      setThemeColor: function(mode, token, value) {
        if (!this.themeEdit[mode]) this.themeEdit[mode] = {};
        this.themeEdit[mode][token] = value;
        var o = {}; o[mode] = {}; o[mode][token] = value;
        this._applyTheme(o);          // update theme data (so current.colors + save read correctly)
        this._previewBrandVar(mode, token, value); // live preview: patch the CSS var (see below)
        this._cacheSplashBrand();     // keep the pre-Vue splash cache in step with the preview
      },
      // Live preview for runtime edits. In Vuetify 4 (options API) mutating $vuetify.theme.themes does NOT
      // regenerate the --v-theme-* CSS variables after first paint, so drive them via a small dynamic
      // <style> scoped per theme (.v-theme--light/dark), overriding Vuetify's injected vars. Transient —
      // persistence is schema.theme applied on the next load (which DOES generate them correctly).
      _previewBrandVar: function(mode, token, hex) {
        var m = /^#?([0-9a-fA-F]{6})$/.exec(hex) || /^#?([0-9a-fA-F]{3})$/.exec(hex); if (!m) return;
        var h = m[1]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        var rgb = parseInt(h.slice(0, 2), 16) + ',' + parseInt(h.slice(2, 4), 16) + ',' + parseInt(h.slice(4, 6), 16);
        if (!this._brandPreview) this._brandPreview = { light: {}, dark: {} };
        this._brandPreview[mode][token] = rgb;
        var self = this;
        var css = ['light', 'dark'].map(function(mo) {
          var v = self._brandPreview[mo], body = Object.keys(v).map(function(k) { return '--v-theme-' + k + ':' + v[k]; }).join(';');
          return body ? '.v-theme--' + mo + '{' + body + '}' : '';
        }).join('');
        var el = document.getElementById('brand-preview');
        if (!el) { el = document.createElement('style'); el.id = 'brand-preview'; document.head.appendChild(el); }
        el.textContent = css;
      },
      _normHex: function(v) {
        var m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec((v || '').trim()); if (!m) return null;
        var h = m[1]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return '#' + h.toLowerCase();
      },
      _persistTheme: function() { // merge the session's edits into schema.theme + save (frozen-replace pattern)
        var base = (this.schemaData && this.schemaData.theme) || {};
        var theme = { light: Object.assign({}, base.light, this.themeEdit.light), dark: Object.assign({}, base.dark, this.themeEdit.dark) };
        var newSchema = Object.assign({}, this.schemaData, { theme: theme });
        this.schemaData = Object.freeze(newSchema);
        if (backend.saveSchema) backend.saveSchema(newSchema);
      },
      // Commit a color (from the text field or the picker's final `change`): validate, live-preview, and
      // auto-persist to schema.theme — no Save button. Invalid input is ignored (the field re-syncs to the
      // stored value on next render).
      commitTheme: function(mode, token, value) {
        var hex = this._normHex(value);
        if (!hex) { this.notify(this.t('msg.invalid_color')); return; }
        this.setThemeColor(mode, token, hex);
        this._persistTheme();
      },
      // Bulk-apply a pasted palette (e.g. coolors: ["#ccd5ae","#e9edc9",...]) to the CURRENTLY-active mode.
      // Parses the #hex codes, sorts by luminance + chroma, and maps roles: lightest->background,
      // 2nd-lightest->surface, darkest->text(on-surface), most-saturated->primary, next->secondary.
      // (Inverted bg/text for dark mode.) One save for the whole set.
      _rgb: function(hex) { var h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; },
      _luminance: function(hex) { var c = this._rgb(hex); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; },
      _chroma: function(hex) { var c = this._rgb(hex); return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); },
      _parsePalette: function(str) {
        var out = [], re = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})/g, m;
        while ((m = re.exec(str || ''))) { var h = m[1]; if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; out.push('#' + h.toLowerCase()); }
        return out;
      },
      applyPalette: function(str) {
        var self = this, hex = this._parsePalette(str);
        if (hex.length < 2) { this.notify(this.t('msg.paste_hex')); return; }
        var mode = (this.theme === 'dark') ? 'dark' : 'light';
        var arr = hex.map(function(h) { return { h: h, l: self._luminance(h), c: self._chroma(h) }; });
        var byL = arr.slice().sort(function(a, b) { return a.l - b.l; });   // dark -> light
        var byC = arr.slice().sort(function(a, b) { return b.c - a.c; });   // vivid -> dull
        var n = byL.length, lightest = byL[n - 1].h, darkest = byL[0].h;
        var secondL = byL[n - 2 >= 0 ? n - 2 : n - 1].h, secondD = byL[1 < n ? 1 : 0].h;
        var primary = byC[0].h, secondary = byC[1 < byC.length ? 1 : 0].h;
        var map = (mode === 'dark')
          ? { background: darkest, surface: secondD, 'on-surface': lightest, primary: primary, secondary: secondary }
          : { background: lightest, surface: secondL, 'on-surface': darkest, primary: primary, secondary: secondary };
        Object.keys(map).forEach(function(t) { self.setThemeColor(mode, t, map[t]); });
        this._persistTheme();
        this.notify(this.t('msg.palette_applied') + ' (' + mode + ')');
      },
      resetTheme: function() {
        var newSchema = Object.assign({}, this.schemaData); delete newSchema.theme;
        this.schemaData = Object.freeze(newSchema);
        if (backend.saveSchema) backend.saveSchema(newSchema);
        try { localStorage.removeItem('brand_splash'); } catch (e) {}
        location.reload(); // rebuild Vuetify with the built-in defaults (cleanly drops the override)
      },

      _updateManifest: function() {
        try {
          var title = this.appTitle || 'App';
          // Follow the live Vuetify theme palette
          var colors = (this.$vuetify && this.$vuetify.theme && this.$vuetify.theme.current && this.$vuetify.theme.current.colors) || {};
          var bg = colors.background || '#ffffff';
          var tc = colors.surface || colors.primary || '#1976d2';
          // Blob-URL manifests resolve relative URLs against the (invalid) blob base, so use absolute URLs.
          var base = new URL('./', location.href).href;
          // Single install icon (512). Chromium needs one square PNG >=144px for install, and 512
          // also covers the splash/maskable role — so a separate small icon isn't required.
          // schema.icons.png512 may be an absolute (cross-origin) PNG URL hosted anywhere (works with
          // Firebase = DB only); else the bundled ./icon-512.png. png512Sizes overrides the declared
          // size so a differently-sized source is declared accurately (no DevTools size-mismatch warning).
          var sIcons = (this.schemaData && this.schemaData.icons) || {};
          var icon512 = new URL(sIcons.png512 || './icon-512.png', location.href).href;
          var icon512Sizes = sIcons.png512Sizes || '512x512';
          // PER-DATABASE IDENTITY. A web app IS its manifest `id` (its `start_url` in a browser too
          // old for `id`), and both used to be the origin root for every database this deployment
          // serves — so two databases installed as ONE app, wearing whichever icon happened to be
          // active at install time, and launching it opened whichever database localStorage held.
          // Databases.manifestIdentity puts the database key in both fields; `scope` stays the bare
          // base, because the CODE really is shared and start_url must live inside scope.
          var ident = Databases.manifestIdentity(base, Databases.activeKey());
          var manifest = {
            name: title, short_name: title,
            id: ident.id, start_url: ident.start_url, scope: ident.scope,
            display: 'standalone', background_color: bg, theme_color: tc,
            icons: [
              { src: icon512, sizes: icon512Sizes, type: 'image/png', purpose: 'any maskable' }
            ]
          };
          var blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
          var url = URL.createObjectURL(blob);
          var link = document.querySelector('link[rel="manifest"]');
          if (!link) { link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link); }
          if (link._blobUrl) URL.revokeObjectURL(link._blobUrl);
          link.href = url; link._blobUrl = url;
          // Dynamic theme-color meta tracks the in-app theme (overrides the media-query tags once the app loads)
          var meta = document.getElementById('dyn-theme-color');
          if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; meta.id = 'dyn-theme-color'; document.head.appendChild(meta); }
          meta.content = tc;
        } catch (e) {}
      },
      // (PRINT_CSS is a module-level var defined above createVueApp)
      _pe: function(s) { return Print.escape(s); },
      // `title` is escaped HERE (callers pass it raw): it comes from t()/displayValue — editor-writable
      // shared data — and document.write renders it, so an unescaped title is stored XSS in the print window.
      _printOpen: function(title, bodyHtml) { var w = window.open('', '_blank'); w.document.write('<html><head><title>' + Print.escape(title) + '</title><style>' + PRINT_CSS + '</style></head><body>' + bodyHtml + '</body></html>'); w.document.close(); w.print(); },
      // The print-HTML builders live in /print.js (pure over this ctx). Orchestration (window.open +
      // PRINT_CSS in _printOpen, and the printView/printCard entry points) stays here.
      _printCtx: function() {
        var self = this;
        return {
          t: function(k) { return self.t(k); },
          colIsDate: function(c) { return self.colIsDate(c); },
          displayValue: function(c, v) { return self.displayValue(c, v); },
          isColumnHidden: function(c, item) { return self.isColumnHidden(c, item); },
          colHideEmpty: function(c) { return self.colHideEmpty(c); },
          embedItems: self.embedItems,
          embedWhenOk: function(ei, item) { return self.embedWhenOk(ei, item); },
          embedRowsForItem: function(ei, item) { return self.embedRowsForItem(ei, item); },
          embedCols: function(t, n) { return self.embedCols(t, n); },
          embedRows: function(t, n, p) { return self.embedRows(t, n, p); },
          embedPartLabel: function(t, n, p) { return self.embedPartLabel(t, n, p); }
        };
      },
      printView: function() {
        var self = this, ctx = this._printCtx();
        var title = this.t((VIEWS[this.currentTable] ? 'view.' : 'tab.') + this.currentTable) || this.currentTable;
        if (this.isRotationView) {
          this._printOpen(title, '<h2>' + Print.escape(title) + '</h2>' + Print.table(this.rotationViewCols, this.rotationViewRows, ctx));
          return;
        }
        var cols = this.visibleCols;
        var body = '<h2>' + Print.escape(title) + '</h2>';
        if (this.useCardLayout) {
          this.sortedData.forEach(function(row) { body += Print.cardHtml(cols, row, ctx); });
        } else {
          var afterCol = null;
          this.embedItems.forEach(function(ei) { if (ei.config.afterColumn) afterCol = ei.config.afterColumn; });
          var colIdx = afterCol ? cols.indexOf(afterCol) : -1;
          var colsBefore = colIdx >= 0 ? cols.slice(0, colIdx + 1) : cols;
          var colsAfter = colIdx >= 0 ? cols.slice(colIdx + 1) : [];
          body += Print.table(colsBefore, this.sortedData, ctx);
          this.embedItems.forEach(function(ei) { if (ei.config.afterColumn && Print.printable(ei, undefined, ctx)) body += Print.embed(ei, undefined, ctx); });
          if (colsAfter.length) body += Print.table(colsAfter, this.sortedData, ctx);
          this.embedItems.forEach(function(ei) { if (!ei.config.afterColumn && Print.printable(ei, undefined, ctx)) body += Print.embed(ei, undefined, ctx); });
        }
        this._printOpen(title, body);
      },
      printCard: function(item) {
        var cols = this.visibleCols;
        var title = this.displayValue(cols[0], item[cols[0]]) || item.id; // raw — _printOpen escapes
        this._printOpen(title, Print.cardHtml(cols, item, this._printCtx()));
      }
    },

    watch: {
      // Screen changed -> fetch the bytes of its background asset, if it has one. Watching currentTable
      // (rather than hooking a load path) is what makes this work on EVERY kind: selectTab routes doc
      // views to loadPage and the system screens to nothing at all, so anything hung off loadTableData
      // covers only some of the screens a background can be set on. `immediate` covers the first paint,
      // where currentTable is already set by the time the watcher is registered.
      currentTable: { immediate: true, handler: function() { this._refreshBgAsset(); } },
      // Rows on screen changed -> fetch any stored-asset bytes their image cells point at. A watcher
      // rather than a loadTableData call because every view kind fills currentData by its own path.
      currentData: function() { this._refreshRowAssets(); },
      loading: function(v) {
        // Boot-time marker for perf measurement: record ms from navigation to first ready state.
        if (!v && typeof window !== 'undefined' && window.__bootMs == null) {
          try { window.__bootMs = (window.performance && performance.now) ? performance.now() : (Date.now() - (window.__bootStart || Date.now())); } catch (e) {}
          try { if (window.bootMark) window.bootMark('dataReady'); } catch (e) {} // mark + closing measure span for DevTools
          // Total boot span: navigation start (time origin) -> dataReady. Undefined start = navigationStart.
          try { if (performance.measure) performance.measure('boot total (navStart \u2192 dataReady)', undefined, 'boot:dataReady'); } catch (e) {}
        }
        // Remove the instant splash once the app is ready (data loaded / setup / reauth shown).
        if (!v && typeof document !== 'undefined') {
          var _sp = document.getElementById('app-splash');
          if (_sp) { _sp.style.opacity = '0'; setTimeout(function () { if (_sp && _sp.parentNode) _sp.parentNode.removeChild(_sp); }, 250); }
        }
      },
      schemaData: { immediate: true, handler: function(s) {
        this._applyTheme(s && s.theme); // per-database brand palette (before manifest so theme-color follows)
        this._cacheSplashBrand();       // stash brand colors for the next boot's pre-Vue splash
        // Per-database icons: favicon + apple-touch from schema.icons (or static defaults); the
        // runtime manifest carries the per-database name, theme color, and install icons.
        this._applyIconLinks();
        this._updateManifest();
      }},
      appTitle: { immediate: true, handler: function(t) { if (t) document.title = t; this._updateManifest(); } },
      // The raw value->email links are admin-only at every layer (dev server 403s, Firestore rules deny),
      // and only the Lookup editor's picker reads them. Boot used to fire the request for every user and
      // swallow the denial into {} — harmless, but it put a red 403 in every member's console on every
      // load. Ask only once the answer can be yes: `isAdmin` returns true until the user list lands (see
      // its default), so gating at the boot call site would have changed nothing; the wait is the fix.
      // Non-admins keep the initial {} exactly as the swallowed rejection left them.
      usersLoaded: function(v) { if (v && this.isAdmin) this.loadListUserLinks(); },
      viewingArchive: function() {
        // Active tab sorts the default column ascending (today -> future); the archive tab reverses it
        // (today -> past, most-recently-archived first). Only applies when a defaultSort is set.
        var cfg = this.currentConfig || {};
        if (cfg.defaultSort) { this.sortCol = cfg.defaultSort; this.sortAsc = !this.viewingArchive; }
        this.loadTableData();
      },
      sortedData: function(val) { if (this.currentConfig.collapsed && val.length) this.expandedCard = val[0].id; }
    },

    errorCaptured: function(err) { console.error('Vue error:', err); this.notify(this.t('msg.error') + ' ' + (err.message || err)); return false; },
    mounted: function() {
      var self = this;
      window.addEventListener('resize', function() { self.mobile = window.innerWidth < 768; self.windowWidth = window.innerWidth; });
      // Remote changes that arrived while a cell had focus are held (see _liveHeld); leaving the cell is
      // one of the two moments that can end. Deferred a tick because focusout fires BEFORE focus lands on
      // the next element — checking activeElement synchronously would see the outgoing cell (or <body>)
      // and flush straight into the cell the user just tabbed into.
      document.addEventListener('focusout', function() { setTimeout(function() { self._liveFlush(); }, 0); });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          var el = e.target;
          if (el.hasAttribute('contenteditable') || el.tagName === 'SELECT' || el.tagName === 'INPUT') {
            e.preventDefault();
            el.blur();
            // Table cells: move to next cell
            var td = el.closest('td');
            if (td) {
              var next = td.nextElementSibling;
              while (next && !next.querySelector('[contenteditable], select, input, .v-autocomplete input')) next = next.nextElementSibling;
              if (!next) {
                var tr = td.closest('tr');
                var nextRow = tr && tr.nextElementSibling;
                if (nextRow) next = nextRow.querySelector('td');
                while (next && !next.querySelector('[contenteditable], select, input, .v-autocomplete input')) next = next.nextElementSibling;
              }
              if (next) { var t = next.querySelector('[contenteditable], select, input, .v-autocomplete input'); if (t) t.focus(); }
              return;
            }
            // List items: move to next sibling or add new
            var li = el.closest('.v-list-item');
            if (li) {
              var nextLi = li.nextElementSibling;
              if (nextLi) {
                var c = nextLi.querySelector('[contenteditable]');
                if (c) { c.focus(); return; }
              }
              // At last item: find the "Add item" button in the parent group
              var group = li.closest('.v-list-group__items') || li.closest('.v-list');
              if (group) {
                var addBtn = group.querySelector('.v-btn .mdi-plus') || group.parentElement.querySelector(':scope > .v-list-item:last-child .v-btn');
                if (addBtn) { addBtn.closest('button, .v-btn').click(); return; }
              }
            }
          }
        }
      });
      // Probe local server availability for setup UI — but only when a local dev server could
      // actually be present. On a committed cloud backend (firebase/supabase) there is no /api
      // endpoint, so the probe would just log a spurious 404 to the console on every load.
      var appMode = (function() { try { return localStorage.getItem('app_mode'); } catch (e) { return null; } })();
      if (appMode !== 'firebase' && appMode !== 'supabase' && appMode !== 'pglite' && _mayLocal()) {
        fetch(_u('/api/validateFolder'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{"id":"probe"}' })
          .then(function(r) { if (r.ok) self.hasLocalServer = true; })
          .catch(function() {});
      }
    }
  });

  app.use(vuetify);

  // Shared call-throughs to the root instance. Vue resolves template refs on the component instance, so
  // leaf components must re-expose the root methods their templates call; spread this object into their
  // `methods` (Object.assign) instead of re-declaring identical proxies. Opt-in per component on purpose
  // — a global app.mixin would leak these names (e.g. `t`) into every Vuetify component.
  var ROOT_PROXY = {
    t: function(k) { return appInstance ? appInstance.t(k) : k; },
    tOr: function(k, f) { return appInstance ? appInstance.tOr(k, f) : f; },
    displayValue: function(c, v, n, vc) { return appInstance ? appInstance.displayValue(c, v, n, vc) : v; },
    colIsDate: function(c) { return appInstance ? appInstance.colIsDate(c) : false; },
    colIsImage: function(c) { return appInstance ? appInstance.colIsImage(c) : false; },
    colIsUrl: function(c) { return appInstance ? appInstance.colIsUrl(c) : false; },
    // Sanitize a user-supplied url/image cell before it goes into an attribute. safeHref (for <a href>)
    // is http(s)-only, so a stored `javascript:`/`data:` string can't execute on click. safeImg (for
    // <img src>) also allows a raster data:image. Both share embeds.js so mdToHtml and the cells agree.
    safeHref: function(u) { return (typeof safeUrl === 'function') ? safeUrl(u) : ''; },
    safeImg: function(u) { return (typeof safeImgSrc === 'function') ? safeImgSrc(u) : ''; },
    // Any image cell value -> a usable <img src>. An `asset:<id>` reference (a file stored IN the
    // database, for deployments with no bucket) resolves through the asset cache; anything else is a
    // plain URL and goes through safeImg. Use this, not safeImg, wherever a cell value is rendered.
    imgSrc: function(u) { return appInstance ? appInstance.assetSrc(u) : ''; },
    // Asset-backed values have no meaningful href (safeUrl rejects data:), so the cell drops the
    // "open in a new tab" wrapper for them rather than emitting an <a> with an empty href.
    isAsset: function(u) { return (typeof isAssetRef === 'function') ? isAssetRef(u) : false; },
    toDateStr: toDateStr
  };


  // The single embed renderer for every envelope (page-view, doc-view blocks, data-view). It dispatches
  // by kind: calendar/rotation delegate to their unified :embed components; 'doc' renders markdown blocks
  // (recursing into embed-view for nested embeds); 'data' renders a view/table's rows. Two input modes:
  //   - self-resolving (page/doc leaf): {type,name,part}, editable (data-cell + add/del/archive).
  //   - precomputed spec (data-view): a resolveEmbed() spec + optional master `row` for per-row filterBy,
  //     read-only + compact (fontSize/cellPad), with the inline-{{self}} and header variants.
  // Editability tracks the input mode (self path editable; spec path read-only) — the pre-existing
  // per-envelope behavior, now expressed as one component instead of two (embed-view + embed-block).
  app.component('embed-view', {
    props: {
      type: { type: String, default: 'view' }, name: { type: String, default: null }, part: { type: String, default: null },
      both: { type: Boolean, default: false }, // `@both`: render the Upcoming/Past toggle, own the partition
      spec: { type: Object, default: null }, row: { type: Object, default: null },
      fontSize: { type: String, default: '0.75rem' }, cellPad: { type: String, default: '2px 6px' }, header: { type: Boolean, default: false },
      depth: { type: Number, default: 0 } // recursion guard for doc-view-in-doc-view embeds
    },
    // Per-embed inline-edit state for doc-view embeds (each embed edits its own page independently), and
    // which half of a `@both` embed is showing (per embed: two toggles on one page move independently).
    data: function() { return { editing: false, docDraft: '', showArchive: false }; },
    created: function() {
      // A doc-view embed renders the ACCESS-GATED server body, not the world-readable schema seed. Kick
      // off the single-page read (server-filtered) once, but only if the viewer may see it -- a restricted
      // user's block is hidden anyway (docBlocks), and skipping the read avoids a pointless denied fetch.
      if (this.isDoc && appInstance && appInstance.canAccessPage(VIEWS[this.name]) && appInstance.pageCache[this.name] === undefined) {
        appInstance.loadPage(this.name);
      }
    },
    computed: {
      // The view whose `obscureNames` governs THIS embed's cells. An inline embed (`{sources,columns}`
      // in a column list) carries its own config and has no name to look up; a `{{view:x}}` embed is
      // governed by view x; a `{{table:x}}` embed by the table, which answers the same presentation
      // properties a view does. What it is NOT is the page the embed sits on -- which is exactly what
      // displayValue assumed before it could be told otherwise.
      obscureCfg: function() {
        if (this.spec) return this.spec.config || null;
        return (this.type === 'view' ? VIEWS[this.name] : SCHEMA[this.name]) || null;
      },
      isCal: function() { return this.type === 'view' && !!(appInstance && appInstance.isCalendarName(this.name)); },
      isRot: function() { return this.type === 'view' && !!(appInstance && appInstance.isRotationName(this.name)); },
      isPiv: function() { return this.type === 'view' && !!(appInstance && appInstance.isPivotName(this.name)); },
      isRsvp: function() { return this.type === 'view' && !!(appInstance && appInstance.isRsvpName(this.name)); },
      isStats: function() { return this.type === 'view' && !!(appInstance && appInstance.isStatsName(this.name)); },
      // A doc-view embedded inside another page (only via the no-spec page path; the spec path pre-tags kind='doc').
      isDoc: function() { return !this.spec && this.type === 'view' && !!(appInstance && appInstance.isDocViewName(this.name)); },
      kind: function() { return this.spec ? this.spec.kind : (this.isCal ? 'calendar' : this.isRot ? 'rotation' : this.isPiv ? 'pivot' : this.isRsvp ? 'rsvp' : this.isStats ? 'stats' : this.isDoc ? 'doc' : 'data'); },
      // Render blocks for a doc embed. Spec path carries its own blocks (built from the schema seed by
      // resolveEmbed); the page path builds them here from the ACCESS-GATED body: hidden entirely unless
      // canAccessPage passes, then the server-filtered pageCache body (seed only as a pre-load fallback).
      blocks: function() {
        if (this.spec) return this.spec.blocks;
        if (!appInstance || !this.isDoc || this.depth > 4) return []; // depth cap: bound doc<->doc cycles
        var v = VIEWS[this.name];
        if (!appInstance.canAccessPage(v)) return []; // access-gated: no grant -> render nothing
        var body = appInstance.pageCache[this.name];
        return appInstance.mdBlocks(body != null ? body : (v.markdown || ''), this.name);
      },
      // Inline edit is offered only for a real (page-path) doc embed the viewer can both see AND write:
      // canAccessPage gates the read (a restricted user never sees the block), canEditPages the write
      // (admin/editor) — matching the top-level page-view Edit button and the _pages write rule.
      canEditDoc: function() {
        return this.isDoc && !!appInstance && appInstance.canEditPages && appInstance.canAccessPage(VIEWS[this.name]);
      },
      calName: function() { return this.spec ? this.spec.name : this.name; },
      cols: function() {
        if (this.spec) return this.spec.columns;
        if (!appInstance) return [];
        var cols = appInstance.embedCols(this.type, this.name);
        if (appInstance.embedHideEmpty(this.type, this.name)) { var rows = this.rows; cols = cols.filter(function(c) { return rows.some(function(r) { return r[c]; }); }); }
        return cols;
      },
      // The partition actually being rendered. A fixed `@part` embed is whatever the token said; a
      // `@both` embed follows its own tab. Everything downstream keys off THIS, not the prop, so the
      // Upcoming half of a toggle behaves exactly like a partition-less embed (editable, Add, archive)
      // and the Past half exactly like `@archive` (read-only) — no new editing semantics either way.
      // (`showToggle` guards the tab going away underneath the reader — a live-sync restore that empties
      // the archive while the Past half is open would otherwise strand them on an empty read-only list
      // with no tab strip left to click back with.)
      effPart: function() { return this.both ? (this.showArchive && this.showToggle ? 'archive' : null) : this.part; },
      // The toggle appears only once something has actually aged into the archive. An embed whose
      // archive is empty renders exactly as it did before the toggle existed, no chrome — the same
      // promise `{{view:x@archive?}}` made by hiding its heading until the section had content.
      showToggle: function() {
        return !!(this.both && !this.spec && appInstance && appInstance.embedRows(this.type, this.name, 'archive').length);
      },
      rows: function() {
        if (this.spec) return (this.spec.config.filterBy && this.row) ? appInstance.embedRowsForItem(this.spec, this.row) : this.spec.rows;
        return appInstance ? appInstance.embedRows(this.type, this.name, this.effPart) : [];
      },
      canMutate: function() { return !this.effPart && appInstance && appInstance.canMutateEmbed(this.type, this.name); },
      hasArchive: function() { return !this.effPart && appInstance && appInstance.embedHasArchive(this.type, this.name); },
      layout: function() { return appInstance ? appInstance.embedViewLayout(this.type, this.name) : 'table'; },
      roLayout: function() { return (this.spec && this.spec.config.layout) || 'table'; },
      // The config whose column entries govern THIS embed's per-row visibility: an inline/named-view
      // embed carries its own spec.config, a {{view:x}}/{{table:x}} token resolves the named view/table.
      colCfg: function() { return this.spec ? this.spec.config : ((typeof VIEWS !== 'undefined' && VIEWS[this.name]) || (typeof SCHEMA !== 'undefined' && SCHEMA[this.name]) || {}); },
      tblStyle: function() { return 'width:100%; font-size:' + this.fontSize + '; border-collapse:collapse'; },
      thStyle: function() { return 'text-align:left; padding:' + this.cellPad + '; opacity:0.6; border-bottom:1px solid rgb(var(--v-theme-outline),0.2)'; },
      tdStyle: function() { return 'padding:' + this.cellPad; }
    },
    methods: Object.assign({}, ROOT_PROXY, {
      // Per-row column visibility, evaluated against the EMBEDDED view's own entries (colCfg).
      // Card/list layouts drop the field entirely; a table keeps the column and blanks the cell, which
      // is the same split the primary grid makes.
      colHidden: function(col, item) { return !!appInstance && appInstance.isColumnHidden(col, item, this.colCfg); },
      colsFor: function(item) { var self = this; return this.cols.filter(function(c) { return !self.colHidden(c, item); }); },
      isArmed: function(item) { return appInstance.isArmed('erow:' + item.id); },
      partLabel: function(archive) { return appInstance.embedPartLabel(this.type, this.name, archive ? 'archive' : 'active'); },
      // Per-row control gate. On a self-service embed `canMutate` only means "the Add button is open";
      // whether THIS row may be archived/deleted is ownership + state, exactly as in the primary grid.
      canMutateRow: function(item) { return this.canMutate && appInstance.canMutateEmbedRow(this.type, this.name, item); },
      addRow: function() { return appInstance.embedAddRow(this.type, this.name); },
      delRow: function(item) { if (this.canMutateRow(item)) return appInstance.embedDeleteRow(this.type, this.name, item); },
      archRow: function(item) { if (this.canMutateRow(item)) return appInstance.embedArchiveRow(this.type, this.name, item); },
      // Inline doc-view editing — mirrors the root togglePageEdit/savePage, but scoped to THIS embed's
      // page (this.name) and its local editing/docDraft state. Save writes the gated _pages body that
      // both this embed and the standalone page read, so the two stay in sync.
      toggleDocEdit: function() {
        this.editing = !this.editing;
        if (this.editing) {
          var body = appInstance.pageCache[this.name];
          this.docDraft = body != null ? body : ((VIEWS[this.name] && VIEWS[this.name].markdown) || '');
        }
      },
      saveDoc: function() {
        appInstance.pageCache[this.name] = this.docDraft;
        if (backend.putRow) Writes.putRow('_pages', { id: this.name, markdown: this.docDraft }, 'active');
        this.editing = false;
        appInstance.notify(appInstance.t('msg.saved'));
      }
    }),
    template: ''
      + '<calendar-view v-if="kind===\'calendar\'" :name="calName" :embed="true"></calendar-view>'
      + '<rotation-view v-else-if="kind===\'rotation\'" :name="calName" :embed="true"></rotation-view>'
      + '<pivot-view v-else-if="kind===\'pivot\'" :name="calName" :embed="true"></pivot-view>'
      + '<rsvp-view v-else-if="kind===\'rsvp\'" :name="calName" :embed="true"></rsvp-view>'
      + '<stats-view v-else-if="kind===\'stats\'" :name="calName" :embed="true"></stats-view>'
      + '<template v-else-if="kind===\'doc\'">'
      + '<div v-if="canEditDoc" class="d-flex align-center"><v-spacer></v-spacer>'
      + '<v-btn size="x-small" variant="text" density="comfortable" :icon="editing ? \'mdi-eye\' : \'mdi-pencil\'" :title="editing ? t(\'btn.preview\') : t(\'btn.edit\')" @click="toggleDocEdit()" data-testid="doc-edit"></v-btn>'
      + '<v-btn v-if="editing" size="x-small" color="primary" variant="text" prepend-icon="mdi-content-save" @click="saveDoc()">{{ t(\'btn.save\') }}</v-btn>'
      + '</div>'
      + '<v-textarea v-if="editing" :model-value="docDraft" @update:model-value="docDraft = $event" auto-grow variant="outlined" density="compact" hide-details placeholder="# Markdown"></v-textarea>'
      + '<template v-else v-for="(blk, bi) in blocks" :key="bi">'
      + '<div v-if="blk.html" v-html="blk.html" style="font-size:0.8rem"></div>'
      + '<embed-view v-else :type="blk.embedType" :name="blk.embedName" :part="blk.embedPart" :both="blk.embedBoth" :depth="depth + 1"></embed-view>'
      + '</template>'
      + '</template>'
      // --- read-only data (data-view spec path): inline {{self}} blocks, or table/card/chip + header ---
      + '<template v-else-if="spec">'
      + '<template v-if="spec.inlineBlocks" v-for="(blk, bi) in spec.inlineBlocks" :key="\'ib\'+bi">'
      + '<div v-if="blk.html" v-html="blk.html" style="font-size:0.8rem"></div>'
      + '<table v-else-if="blk.self" :style="tblStyle"><thead><tr><th v-for="ec in cols" :key="ec" :style="thStyle">{{ t(\'field.\' + ec) || ec }}</th></tr></thead>'
      + '<tbody><tr v-for="er in rows" :key="er.id"><td v-for="ec in cols" :key="ec" :style="tdStyle"><list-value v-if="!colHidden(ec, er)" :col="ec" :value="er[ec]" :view-cfg="obscureCfg"></list-value></td></tr></tbody></table>'
      + '</template>'
      + '<template v-else>'
      + '<div v-if="header" style="font-size:0.8rem; opacity:0.6; margin-bottom:8px">{{ t(\'tab.\' + spec.config.table) || spec.config.table }} ({{ rows.length }})</div>'
      + '<table v-if="roLayout===\'table\'" :style="tblStyle"><thead><tr><th v-for="ec in cols" :key="ec" :style="thStyle">{{ t(\'field.\' + ec) || ec }}</th></tr></thead>'
      + '<tbody><tr v-for="er in rows" :key="er.id"><td v-for="ec in cols" :key="ec" :style="tdStyle"><list-value v-if="!colHidden(ec, er)" :col="ec" :value="er[ec]" :view-cfg="obscureCfg"></list-value></td></tr></tbody></table>'
      + '<div v-else-if="roLayout===\'card\'" style="display:grid; gap:6px"><div v-for="er in rows" :key="er.id" style="font-size:0.75rem; padding:4px 6px; border:1px solid rgb(var(--v-theme-outline),0.15); border-radius:4px"><span v-for="ec in colsFor(er)" :key="ec" style="display:inline-block; margin-right:12px"><span style="opacity:0.6">{{ t(\'field.\' + ec) || ec }}: </span><list-value :col="ec" :value="er[ec]" :view-cfg="obscureCfg"></list-value></span></div></div>'
      + '<div v-else class="d-flex align-center flex-wrap ga-1"><v-chip v-for="er in rows" :key="er.id" size="small" variant="tonal" color="secondary" label><span v-for="(ec, i) in colsFor(er)" :key="ec">{{ er[ec] }}<span v-if="i < colsFor(er).length - 1" style="opacity:0.4"> · </span></span></v-chip></div>'
      + '</template>'
      + '</template>'
      // --- editable data (page / doc-leaf self path): list/card/table with data-cell + row controls ---
      + '<div v-else>'
      // `@both`: the top-level archive tabs (ui.html), scaled down and scoped to this embed.
      + '<v-tabs v-if="showToggle" :model-value="showArchive" @update:model-value="showArchive = $event" density="compact" class="mb-2" data-testid="embed-part-tabs">'
      + '<v-tab :value="false" size="small">{{ partLabel(false) }}</v-tab>'
      + '<v-tab :value="true" size="small">{{ partLabel(true) }}</v-tab>'
      + '</v-tabs>'
      + '<v-list v-if="layout===\'list\'" density="compact" class="my-2">'
      + '<v-list-item v-for="(item, ri) in rows" :key="item.id || ri" class="px-2">'
      + '<template v-slot:default><span v-for="(col, i) in colsFor(item)" :key="col" style="font-size:0.85rem"><list-value :col="col" :value="item[col]" :view-cfg="obscureCfg"></list-value><span v-if="i < colsFor(item).length - 1" style="opacity:0.3;margin:0 6px">·</span></span></template>'
      + '<template v-slot:append><template v-if="canMutateRow(item)"><v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn><v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn></template></template>'
      + '</v-list-item></v-list>'
      + '<div v-else-if="layout===\'card\'" class="my-2">'
      + '<v-card v-for="(item, ri) in rows" :key="item.id || ri" variant="flat" class="ma-2 pa-2" style="border-bottom:1px solid rgb(var(--v-theme-outline),0.2)">'
      + '<div v-for="col in colsFor(item)" :key="col" class="d-flex align-center mb-1"><span style="min-width:120px;flex-shrink:0;font-size:0.75rem;opacity:0.6;padding-right:8px">{{ t(\'field.\' + col) || col }}</span><span style="opacity:0.8"><list-value :col="col" :value="item[col]" :view-cfg="obscureCfg"></list-value></span></div>'
      + '<div v-if="canMutateRow(item)" style="text-align:right"><v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn><v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn></div>'
      + '</v-card></div>'
      + '<v-table v-else density="compact" class="my-2"><template v-slot:default>'
      + '<thead><tr><th v-for="c in cols" :key="c">{{ t(\'field.\' + c) || c }}</th><th v-if="canMutate"></th></tr></thead>'
      + '<tbody><tr v-for="(item, ri) in rows" :key="item.id || ri"><td v-for="col in cols" :key="col">'
      + '<data-cell v-if="!colHidden(col, item)" :item="item" :col="col" :owner="name" :readonly="!!effPart" :embed="true"></data-cell>'
      + '</td><td v-if="canMutate" style="white-space:nowrap"><template v-if="canMutateRow(item)">'
      + '<v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn>'
      + '<v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn>'
      + '</template></td></tr></tbody>'
      + '</template></v-table>'
      + '<v-btn v-if="canMutate" variant="text" size="small" prepend-icon="mdi-plus" @click="addRow">{{ t(\'btn.add\') || \'Add\' }}</v-btn>'
      + '</div>'
  });

  // --- Data view: one editable cell, shared by the primary card/table layouts AND embed-view -----
  // The ~13-branch column editor (readonly / mirror / multiselect / list w/ listSwitch / ref / date /
  // contenteditable). Typing/options/save proxy to appInstance. Props parameterize the two callers:
  //   owner    - ownerId for save + cellReadonly (undefined -> currentTable for the primary view;
  //              the embed passes its table/view name so edits route to the right table).
  //   readonly - force read-only (an embed with a `part` is non-editable).
  //   embed    - embed variant: no mirror branch (mirror-ness is relative to currentTable, not the
  //              embed's table), no listSwitch swap, dimmer read-only. flex:1 / :name / keydown guards
  //              are harmless in both, so they stay unconditional and the markup renders identically.
  app.component('data-cell', {
    props: {
      item: { type: Object, required: true },
      col: { type: String, required: true },
      owner: { type: String, default: undefined },
      readonly: { type: Boolean, default: false },
      embed: { type: Boolean, default: false }
    },
    methods: Object.assign({}, ROOT_PROXY, {
      cellRO: function(item, col) { return this.readonly || appInstance.cellReadonly(item, col, this.owner); },
      colIsMirrorForTable: function(col) { return appInstance.colIsMirrorForTable(col); },
      colIsMultiselect: function(col) { return appInstance.colIsMultiselect(col); },
      colAllowNew: function(col) { return appInstance.colAllowNew(col); },
      colIsList: function(col) { return appInstance.colIsList(col); },
      colIsRef: function(col) { return appInstance.colIsRef(col); },
      colPicker: function(col) { return appInstance.colPicker(col); },
      colListSwitch: function(col) { return appInstance.colListSwitch(col); },
      getListOptions: function(col) { return appInstance.getListOptions(col); },
      // single-select options: the primary honors the listSwitch alt list; the embed uses the plain list.
      listItems: function(col, item) {
        if (this.embed) return appInstance.getListOptions(col);
        var sw = appInstance.colListSwitch(col);
        return appInstance.getListOptions(col, (sw && appInstance.isAltList(col, item)) ? sw.list : null);
      },
      getRefOptions: function(col, item) { return appInstance.getRefOptions(col, item); },
      cellOptions: function(col, item) { return appInstance.cellOptions(col, item); },
      isAltList: function(col, item) { return appInstance.isAltList(col, item); },
      toggleListSwitch: function(col, item) { return appInstance.toggleListSwitch(col, item); },
      save: function(item, col, val) { return appInstance.saveField(item, col, val, this.owner); },
      addToListOnBlur: function(item, col) { return appInstance.addToListOnBlur(item, col); },
      // image column: store the picked file and save a REFERENCE onto the row (never the bytes inline).
      // Two sinks, tried in order:
      //   1. the backend blob store (Firebase/Supabase Storage, the dev file store) -> row holds a URL;
      //   2. the _assets table -> row holds 'asset:<id>', a data URI kept in the database.
      // The fallback fires on absence AND on rejection, and the rejection half is the load-bearing one:
      // canUploadFiles() is a CAPABILITY check, not an availability one — backend-firebase exposes
      // uploadFile whenever Storage initialized, so on a Spark project (Storage needs Blaze) the presence
      // test passes and the put() fails at runtime. Without the catch, that user could never attach a file.
      uploadImage: function(item, col, ev) {
        var self = this, file = ev.target.files && ev.target.files[0];
        ev.target.value = '';                 // reset so re-picking the same file fires change again
        if (!file) return;
        this.uploadErr = ''; this.uploading = true;
        var table = this.owner || appInstance.currentTable;
        var toAsset = function() {
          var id = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          return appInstance.saveAsset(id, file);
        };
        var stored = appInstance.canUploadFiles()
          ? appInstance.uploadFile(file, { table: table, col: col, rowId: item.id }).catch(toAsset)
          : toAsset();
        stored.then(function(ref) {
          self.uploading = false; self.save(item, col, ref);
        }).catch(function(e) {
          self.uploading = false; self.uploadErr = (e && e.message) || self.t('msg.upload_failed');
        });
      }
    }),
    data: function() { return { uploading: false, uploadErr: '' }; },
    // An upload button appears whenever the file can be stored SOMEWHERE — a blob store, or the _assets
    // table via putRow. Only a backend that can do neither falls back to the paste-a-URL field.
    computed: {
      canUpload: function() { return appInstance.canUploadFiles() || !!(typeof backend !== 'undefined' && backend && backend.putRow); },
      // `owner` already names the view or table this cell belongs to -- an embed passes its own name --
      // so the config governing obscureNames is there for the asking, rather than defaulting to
      // whatever screen is open. Same rule as currentConfig: a VIEW and a TABLE occupy one position.
      ownerCfg: function() { return this.owner ? (VIEWS[this.owner] || SCHEMA[this.owner] || null) : null; }
    },
    template: ''
      + '<span v-if="cellRO(item, col)" :style="{ opacity: embed ? 0.4 : 0.75 }">'
      +   '<img v-if="colIsImage(col) && item[col] && isAsset(item[col])" :src="imgSrc(item[col])" class="cell-thumb" alt="">'
      +   '<a v-else-if="colIsImage(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="imgSrc(item[col])" class="cell-thumb" alt=""></a>'
      +   '<a v-else-if="colIsUrl(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop>{{ item[col] }}</a>'
      +   '<template v-else><list-value :col="col" :value="item[col]" :view-cfg="ownerCfg"></list-value></template>'
      + '</span>'
      + '<span v-else-if="!embed && colIsMirrorForTable(col)" style="opacity:0.82"><list-value :col="col" :value="item[col]" :view-cfg="ownerCfg"></list-value></span>'
      + '<v-combobox v-else-if="colIsMultiselect(col) && colAllowNew(col) && !colIsRef(col)" :name="col" multiple chips closable-chips :model-value="item[col] || []" :items="getListOptions(col)" item-title="title" item-value="value" density="compact" variant="plain" hide-details style="flex:1" @update:model-value="save(item, col, $event)" @blur="addToListOnBlur(item, col)" @keydown.home.stop @keydown.end.stop><template v-slot:chip="{ props }"><v-chip v-bind="props" size="small" color="secondary"></v-chip></template></v-combobox>'
      + '<v-autocomplete v-else-if="colIsMultiselect(col)" :name="col" multiple chips closable-chips :model-value="item[col] || []" :items="cellOptions(col, item)" item-title="title" item-value="value" density="compact" variant="plain" hide-details style="flex:1" @update:model-value="save(item, col, $event)" @keydown.home.stop @keydown.end.stop><template v-slot:chip="{ props }"><v-chip v-bind="props" size="small" color="secondary"></v-chip></template></v-autocomplete>'
      + '<v-btn-toggle v-else-if="colIsList(col) && !colIsMultiselect(col) && colPicker(col)===\'toggle\'" :name="col" :model-value="item[col] || \'\'" density="compact" variant="outlined" divided @update:model-value="save(item, col, $event || \'\')">'
      + '<v-btn v-for="o in getListOptions(col)" :key="o.value" :value="o.value" size="small">{{ o.title }}</v-btn>'
      + '</v-btn-toggle>'
      + '<v-chip-group v-else-if="colIsList(col) && !colIsMultiselect(col) && colPicker(col)===\'chips\'" :name="col" :model-value="item[col] || \'\'" @update:model-value="save(item, col, $event || \'\')">'
      + '<v-chip v-for="o in getListOptions(col)" :key="o.value" :value="o.value" size="small" filter variant="outlined" color="primary">{{ o.title }}</v-chip>'
      + '</v-chip-group>'
      + '<v-combobox v-else-if="colIsList(col) && colAllowNew(col)" :name="col" :model-value="item[col] || \'\'" :items="listItems(col, item)" item-title="title" item-value="value" density="compact" variant="plain" hide-details single-line style="flex:1" @update:model-value="save(item, col, $event)" @blur="addToListOnBlur(item, col)" @keydown.home.stop @keydown.end.stop>'
      + '<template v-if="!embed && colListSwitch(col)" v-slot:prepend-inner><v-icon size="x-small" :color="isAltList(col, item) ? \'primary\' : \'\'" @click.stop="toggleListSwitch(col, item)" :title="colListSwitch(col).label || t(\'col.switch_list\')">mdi-swap-horizontal</v-icon></template>'
      + '</v-combobox>'
      + '<v-autocomplete v-else-if="colIsList(col)" :name="col" :model-value="item[col] || \'\'" :items="listItems(col, item)" item-title="title" item-value="value" density="compact" variant="plain" hide-details single-line style="flex:1" @update:model-value="save(item, col, $event)" @keydown.home.stop @keydown.end.stop>'
      + '<template v-if="!embed && colListSwitch(col)" v-slot:prepend-inner><v-icon size="x-small" :color="isAltList(col, item) ? \'primary\' : \'\'" @click.stop="toggleListSwitch(col, item)" :title="colListSwitch(col).label || t(\'col.switch_list\')">mdi-swap-horizontal</v-icon></template>'
      + '</v-autocomplete>'
      + '<v-autocomplete v-else-if="colIsRef(col)" :name="col" :model-value="item[col] || \'\'" :items="getRefOptions(col, item)" item-title="title" item-value="value" density="compact" variant="plain" hide-details single-line style="flex:1" @update:model-value="save(item, col, $event)" @keydown.home.stop @keydown.end.stop></v-autocomplete>'
      + '<div v-else-if="colIsImage(col)" class="d-flex align-center" style="gap:6px;min-width:0">'
      +   '<img v-if="item[col] && isAsset(item[col])" :src="imgSrc(item[col])" class="cell-thumb" alt="">'
      +   '<a v-else-if="item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="imgSrc(item[col])" class="cell-thumb" alt=""></a>'
      +   '<template v-if="canUpload">'
      +     '<input type="file" accept="image/*" ref="imgInput" style="display:none" @change="uploadImage(item, col, $event)">'
      +     '<v-btn size="x-small" variant="text" :loading="uploading" :icon="item[col] ? \'mdi-image-edit\' : \'mdi-camera-plus\'" :title="item[col] ? t(\'img.replace\') : t(\'img.upload\')" @click="$refs.imgInput.click()"></v-btn>'
      +     '<v-btn v-if="item[col]" size="x-small" variant="text" icon="mdi-close" :title="t(\'img.remove\')" @click="save(item, col, \'\')"></v-btn>'
      +   '</template>'
      // The paste-a-URL field stays available ALONGSIDE the upload button, not as its fallback: an external
      // URL (a CDN, a shared drive) is a legitimate third way to hold the image, and uploading is now
      // almost always possible (blob store or _assets), which would otherwise have hidden this field for
      // good. Suppressed only for an asset-backed value, where 'asset:<id>' is nothing a user can edit.
      +   '<input v-if="!isAsset(item[col])" type="url" :value="item[col] || \'\'" @change="save(item, col, $event.target.value)" :placeholder="t(\'img.url\')" spellcheck="false" style="border:none;background:transparent;color:inherit;font:inherit;flex:1;min-width:60px">'
      +   '<v-icon v-if="uploadErr" size="x-small" color="error" :title="uploadErr">mdi-alert-circle</v-icon>'
      + '</div>'
      + '<div v-else-if="colIsUrl(col)" class="d-flex align-center" style="gap:4px;min-width:0">'
      +   '<input type="url" :value="item[col] || \'\'" @change="save(item, col, $event.target.value)" placeholder="https://…" spellcheck="false" style="border:none;background:transparent;color:inherit;font:inherit;flex:1;min-width:60px">'
      +   '<a v-if="item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><v-icon size="x-small">mdi-open-in-new</v-icon></a>'
      + '</div>'
      + '<input v-else-if="colIsDate(col)" type="date" :value="toDateStr(item[col])" @change="save(item, col, $event.target.value)" style="border:none;background:transparent;color:inherit;font:inherit">'
      + '<span v-else class="editable-cell" contenteditable @blur="save(item, col, $event.target.textContent)" style="min-width:auto">{{ item[col] || \'\' }}</span>'
  });

  // --- Composable calendar elements (registry-driven parts) -------------------------------------
  // The calendar body is no longer a monolithic block: month grid / week strip / agenda are separate
  // elements sharing ONE prop contract { cells, dowNames, days, undated, selected } so they are
  // interchangeable via VIEW_PARTS. The day panel and event row are standalone elements too. Both the
  // full calendar view (ui.html) and the compact {{view:cal}} embed compose these same parts — one
  // source of truth per element. This is the element-level seam behind "views are parts that combine":
  // to place a different body, register another component under VIEW_PARTS.calendar[<mode>].
  window.VIEW_PARTS = {
    calendar: { month: 'cal-month', week: 'cal-week', list: 'cal-agenda' },
    rotation: { table: 'rotation-table', card: 'rotation-cards', list: 'rotation-list' },
    data: { list: 'data-list' }   // read-only list layout; card/table editing grids remain inline (deeper refactor)
  };
  window.viewPartFor = function(kind, mode) { return ((window.VIEW_PARTS[kind]) || {})[mode] || null; };

  // Top-level view-kind registry: kind -> the component that renders that whole view. Every kind is
  // componentized; the top-level dispatch is a single <component :is="viewComponent"> lookup in ui.html.
  window.VIEW_KINDS = {
    calendar: 'calendar-view', rotation: 'rotation-view', pivot: 'pivot-view', rsvp: 'rsvp-view', board: 'board-view', form: 'form-view', stats: 'stats-view', timeline: 'timeline-view', page: 'page-view', data: 'data-view',
    languages: 'languages-view', lookup: 'lookup-view', settings: 'settings-view'   // system screens
  };

  app.component('cal-event-row', {
    props: { ev: { type: Object, required: true }, compact: { type: Boolean, default: false } },
    template: ''
      + '<div :style="(compact ? \'padding:3px 0;font-size:0.9rem\' : \'padding:5px 12px;font-size:0.88rem;border-bottom:1px solid rgb(var(--v-theme-outline),0.06)\') + \';display:flex;align-items:center;gap:8px\'">'
      + '<span :style="{ width:\'9px\', height:\'9px\', borderRadius:\'50%\', background: ev.color, flex:\'0 0 auto\' }"></span>'
      + '<b style="opacity:0.8">{{ ev.label }}</b> <span style="opacity:0.85">{{ ev.title }}</span>'
      + '<span v-if="ev.readOnly" style="opacity:0.5;font-size:0.7rem">(read-only)</span>'
      + '</div>'
  });

  // Shared prop contract for the swappable calendar body parts.
  var CAL_BODY_PROPS = { cells: Array, dowNames: Array, days: Array, undated: Array, selected: String };

  app.component('cal-month', {
    props: CAL_BODY_PROPS, emits: ['select'],
    template: ''
      + '<div style="padding:8px">'
      + '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;font-size:0.62rem;opacity:0.55;text-transform:uppercase;margin-bottom:3px"><div v-for="d in dowNames" :key="d" style="text-align:center">{{ d }}</div></div>'
      + '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px">'
      + '<div v-for="c in cells" :key="c.date" :data-testid="\'cal-cell-\' + c.date" :style="{ position:\'relative\', height:\'34px\', display:\'flex\', alignItems:\'center\', justifyContent:\'center\', borderRadius:\'6px\', fontSize:\'0.82rem\', opacity: c.inMonth?1:0.3, cursor:\'pointer\', background: (c.date===selected?\'rgba(var(--v-theme-primary),0.22)\':(c.count?\'rgba(var(--v-theme-on-surface),0.04)\':\'transparent\')), outline: (c.date===selected?\'1px solid rgb(var(--v-theme-primary))\':\'none\') }" @click="$emit(\'select\',c.date)">'
      + '<span :style="c.isToday?\'background:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-on-primary));border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-weight:600\':\'\'">{{ c.day }}</span>'
      + '<span v-if="c.count" style="position:absolute;top:1px;right:3px;background:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-on-primary));font-size:0.6rem;font-weight:700;line-height:1;padding:1px 4px;border-radius:8px;min-width:12px;text-align:center">{{ c.count }}</span>'
      + '</div></div></div>'
  });

  app.component('cal-week', {
    props: CAL_BODY_PROPS, emits: ['select'],
    template: ''
      + '<div style="padding:8px"><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">'
      + '<div v-for="(c,wi) in cells" :key="c.date" :style="{ position:\'relative\', height:\'52px\', display:\'flex\', flexDirection:\'column\', alignItems:\'center\', justifyContent:\'center\', borderRadius:\'6px\', cursor:\'pointer\', background: (c.date===selected?\'rgba(var(--v-theme-primary),0.22)\':(c.count?\'rgba(var(--v-theme-on-surface),0.04)\':\'transparent\')), outline: (c.date===selected?\'1px solid rgb(var(--v-theme-primary))\':\'none\') }" @click="$emit(\'select\',c.date)">'
      + '<span style="font-size:0.6rem;opacity:0.55">{{ dowNames[wi] }}</span>'
      + '<span :style="c.isToday?\'background:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-on-primary));border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-weight:600\':\'font-weight:600\'">{{ c.day }}</span>'
      + '<span v-if="c.count" style="position:absolute;top:2px;right:4px;background:rgb(var(--v-theme-primary));color:rgb(var(--v-theme-on-primary));font-size:0.58rem;font-weight:700;padding:1px 4px;border-radius:8px;min-width:12px;text-align:center">{{ c.count }}</span>'
      + '</div></div></div>'
  });

  app.component('cal-agenda', {
    props: CAL_BODY_PROPS,
    methods: ROOT_PROXY,
    template: ''
      + '<div><template v-for="d in days" :key="d.date">'
      + '<div style="background:rgb(var(--v-theme-on-surface),0.06);padding:4px 12px;font-size:0.72rem;font-weight:600;opacity:0.85">{{ d.label }} · {{ d.events.length }}</div>'
      + '<cal-event-row v-for="ev in d.events" :key="ev.id" :ev="ev"></cal-event-row>'
      + '</template>'
      + '<template v-if="undated && undated.length"><div style="background:rgb(var(--v-theme-on-surface),0.06);padding:4px 12px;font-size:0.72rem;font-weight:600;opacity:0.55">{{ t(\'cal.undated\') }} · {{ undated.length }}</div>'
      + '<cal-event-row v-for="ev in undated" :key="ev.id" :ev="ev"></cal-event-row></template>'
      + '<div v-if="!days.length && !(undated && undated.length)" style="padding:12px;opacity:0.6;font-size:0.85rem">{{ t(\'cal.no_events\') }}</div>'
      + '</div>'
  });

  app.component('cal-day-panel', {
    props: { label: String, events: { type: Array, default: function() { return []; } }, canAdd: { type: Boolean, default: false } },
    emits: ['add'],
    methods: ROOT_PROXY,
    template: ''
      + '<div><v-divider></v-divider><div style="padding:10px 12px">'
      + '<div style="font-weight:600;margin-bottom:6px">{{ label }} <span style="opacity:0.5;font-weight:400">· {{ events.length }} {{ t(\'cal.items\') }}</span></div>'
      + '<div v-if="!events.length" style="opacity:0.6;font-size:0.85rem">{{ t(\'cal.no_events\') }}</div>'
      + '<cal-event-row v-for="ev in events" :key="ev.id" :ev="ev" :compact="true"></cal-event-row>'
      + '<v-btn v-if="canAdd" variant="text" size="small" prepend-icon="mdi-plus" class="mt-1" @click="$emit(\'add\')" data-testid="cal-add-on-day">{{ t(\'cal.add_on_day\') }}</v-btn>'
      + '</div></div>'
  });

  // --- Rotation view body parts (read-only generated periods) -----------------------------------
  // Same registry-selected pattern as the calendar body: table / cards / list share one prop contract
  // { cols, slotCols, rows } and are swapped via VIEW_PARTS.rotation[rotationDisplayLayout].
  var ROT_BODY_PROPS = { cols: Array, slotCols: Array, rows: Array, view: String };
  // Shared by all three bodies: `_period` is a generated column, everything else is a slot, and a slot's
  // label depends on which SHAPE the rotation is (schema-named -> field.<slot>; rosterRef -> the
  // lookup's own list.<table>.<value>, the same keys its task values use).
  var ROT_LABEL = {
    slotHead: function(col) { return appInstance.rotationSlotLabel(this.view, col); },
    // The column whose list labels THIS slot's cells (see rotationValueColFor). '' for `_period`,
    // which is a generated date and has no list behind it.
    valueNs: function(col) { return col === '_period' ? '' : (appInstance.rotationValueColFor(this.view, col) || ''); },
    // The rotation view being rendered, for obscureNames -- which is this view's own setting whether it
    // is the whole screen or one block on somebody else's page.
    viewCfg: function() { return VIEWS[this.view] || null; }
  };

  app.component('rotation-table', {
    props: ROT_BODY_PROPS,
    methods: Object.assign({ head: function(col) { return col === '_period' ? this.t('field.period') : this.slotHead(col); } }, ROT_LABEL, ROOT_PROXY),
    template: ''
      + '<v-table density="compact"><template v-slot:default>'
      + '<thead><tr><th v-for="col in cols" :key="col">{{ head(col) }}</th></tr></thead>'
      + '<tbody><tr v-for="row in rows" :key="row.id"><td v-for="col in cols" :key="col" style="padding:3px 8px"><list-value :col="col" :ns-col="valueNs(col)" :value="row[col]" :view-cfg="viewCfg()"></list-value></td></tr></tbody>'
      + '</template></v-table>'
  });

  app.component('rotation-cards', {
    props: ROT_BODY_PROPS, methods: Object.assign({}, ROT_LABEL, ROOT_PROXY),
    template: ''
      + '<div style="display:grid; gap:8px; padding:8px">'
      + '<div v-for="row in rows" :key="row.id" style="padding:8px 12px; border:1px solid rgb(var(--v-theme-outline),0.15); border-radius:8px">'
      + '<div style="font-weight:600; margin-bottom:4px">{{ toDateStr(row._period) }}</div>'
      + '<div v-for="col in slotCols" :key="col" style="font-size:0.9rem"><span style="opacity:0.6">{{ slotHead(col) }}: </span><list-value :col="col" :ns-col="valueNs(col)" :value="row[col]" :view-cfg="viewCfg()"></list-value></div>'
      + '</div></div>'
  });

  app.component('rotation-list', {
    props: ROT_BODY_PROPS, methods: Object.assign({}, ROT_LABEL, ROOT_PROXY),
    template: ''
      + '<div style="padding:4px 0">'
      + '<div v-for="row in rows" :key="row.id" style="padding:4px 12px; border-bottom:1px solid rgb(var(--v-theme-outline),0.08); font-size:0.9rem">'
      + '<span style="font-weight:600; margin-right:8px">{{ toDateStr(row._period) }}</span>'
      + '<span v-for="(col, i) in slotCols" :key="col"><span style="opacity:0.6">{{ slotHead(col) }}: </span><list-value :col="col" :ns-col="valueNs(col)" :value="row[col]" :view-cfg="viewCfg()"></list-value><span v-if="i < slotCols.length - 1" style="opacity:0.3"> · </span></span>'
      + '</div></div>'
  });

  // --- Data view: read-only list layout part ----------------------------------------------------
  // The compact single-line-per-row layout (currentConfig.layout === 'list'). Display-only, so it
  // extracts cleanly with a small surface: rows/cols as props, action buttons proxied to appInstance.
  // The card/table layouts stay inline for now — they carry full inline editing + interleaved embeds,
  // which need a shared column-helper module before they can be split out without regressions.
  app.component('data-list', {
    props: { rows: Array, cols: Array },
    computed: {
      canPrintCard: function() { return appInstance.canPrintCard; },
      canMutateRows: function() { return appInstance.canMutateRows; },
      hasArchive: function() { return appInstance.hasArchive; }
    },
    methods: Object.assign({}, ROOT_PROXY, {
      isArmed: function(k) { return appInstance.isArmed(k); },
      printCard: function(it) { return appInstance.printCard(it); },
      archiveRow: function(it) { return appInstance.archiveRow(it); },
      deleteRow: function(it) { return appInstance.deleteRow(it); }
    }),
    template: ''
      + '<v-list density="compact">'
      + '<v-list-item v-for="item in rows" :key="item.id" class="px-2">'
      + '<template v-slot:default><span v-for="(col, i) in cols" :key="col" class="d-inline-flex align-center" style="font-size:0.85rem">'
      +   '<img v-if="colIsImage(col) && item[col] && isAsset(item[col])" :src="imgSrc(item[col])" class="cell-thumb" alt="">'
      +   '<a v-else-if="colIsImage(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="imgSrc(item[col])" class="cell-thumb" alt=""></a>'
      +   '<list-value v-else :col="col" :value="item[col]" :view-cfg="ownerCfg"></list-value>'
      +   '<span v-if="i < cols.length - 1" style="opacity:0.3; margin:0 6px">·</span>'
      + '</span></template>'
      + '<template v-slot:append>'
      + '<v-btn v-if="canPrintCard" icon="mdi-printer" size="x-small" variant="text" @click="printCard(item)"></v-btn>'
      + '<template v-if="canMutateRows">'
      + '<v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archiveRow(item)"></v-btn>'
      + '<v-btn :icon="isArmed(\'row:\'+item.id) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(\'row:\'+item.id) ? \'error\' : \'\'" @click="deleteRow(item)"></v-btn>'
      + '</template>'
      + '</template>'
      + '</v-list-item></v-list>'
  });

  // Calendar view: ONE component for both the top-level screen and the {{view:cal}} embed. Holds its
  // own month/anchor/selected-day state — `name` defaults to the current view (top-level); embeds pass
  // an explicit name. Composes the shared cal-* parts + calendar model helpers (calEventsFor, cell
  // builders, i18n). The `embed` flag swaps the outlined-card chrome for a lighter bordered box.
  app.component('calendar-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    data: function() {
      var nm = this.name || (appInstance && appInstance.currentTable);
      var cfg = (window.VIEWS[nm] && window.VIEWS[nm].calendar) || {};
      var today = appInstance ? appInstance._calToday() : '';
      return { mode: cfg.defaultView || 'month', anchor: today, sel: today };
    },
    computed: {
      viewName: function() { return this.name || appInstance.currentTable; },
      weekStart: function() { var v = window.VIEWS[this.viewName]; return (v && v.calendar && v.calendar.weekStart != null) ? Number(v.calendar.weekStart) : 1; },
      events: function() { return appInstance ? appInstance.calEventsFor(this.viewName, appInstance._calWindowFor(this.anchor, this.mode, this.weekStart)) : {}; },
      displayMode: function() { return (appInstance && appInstance.mobile && this.mode === 'month') ? 'list' : (this.mode || 'month'); },
      monthCells: function() { var ev = this.events; return appInstance._calCellsMonth(this.anchor, this.weekStart).map(function(c) { c.count = (ev[c.date] || []).length; return c; }); },
      weekCells: function() { var ev = this.events; return appInstance._calCellsWeek(this.anchor, this.weekStart).map(function(c) { c.count = (ev[c.date] || []).length; return c; }); },
      dowNames: function() { var loc = appInstance.calLocale(), ws = this.weekStart, fmt = new Intl.DateTimeFormat(loc, { weekday: 'short' }), out = []; for (var i = 0; i < 7; i++) out.push(fmt.format(new Date(2023, 0, 1 + ((ws + i) % 7)))); return out; },
      title: function() { var loc = appInstance.calLocale(); if (this.mode === 'week') { var cs = appInstance._calCellsWeek(this.anchor, this.weekStart), f = cs[0].date.split('-'), l = cs[6].date.split('-'); return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' }).format(new Date(+f[0], +f[1] - 1, +f[2])) + ' – ' + new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(+l[0], +l[1] - 1, +l[2])); } var p = this.anchor.split('-'); return new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric' }).format(new Date(+p[0], +p[1] - 1, 1)); },
      selEvents: function() { return this.events[this.sel] || []; },
      selLabel: function() { if (!this.sel) return ''; var p = this.sel.split('-'); return new Intl.DateTimeFormat(appInstance.calLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(+p[0], +p[1] - 1, +p[2])); },
      listDays: function() { var ev = this.events; return Object.keys(ev).filter(function(k) { return k !== '__undated__'; }).sort().map(function(k) { var p = k.split('-'); return { date: k, label: new Intl.DateTimeFormat(appInstance.calLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(+p[0], +p[1] - 1, +p[2])), events: ev[k] }; }); },
      undated: function() { return this.events['__undated__'] || []; },
      canAdd: function() { return appInstance.canCalendarAdd(this.viewName); },
      body: function() { return window.viewPartFor('calendar', this.displayMode) || 'cal-agenda'; }
    },
    methods: Object.assign({}, ROOT_PROXY, {
      prev: function() { this.anchor = addIntervals(this.anchor, -1, this.mode === 'week' ? 'weekly' : 'monthly'); },
      next: function() { this.anchor = addIntervals(this.anchor, 1, this.mode === 'week' ? 'weekly' : 'monthly'); },
      goToday: function() { this.anchor = this.sel = appInstance._calToday(); },
      setMode: function(m) { this.mode = m; },
      addOnDay: function() { appInstance.calendarAddOnDay(this.viewName, this.sel); },
      exportIcs: function() { appInstance.downloadIcs(this.viewName); },
      selectDay: function(d) { this.sel = d; }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" :style="embed ? \'border:1px solid rgb(var(--v-theme-outline),0.2);border-radius:8px\' : \'\'" :data-testid="embed ? undefined : \'cal-view\'">'
      + '<div class="d-flex align-center flex-wrap pa-2" style="gap:8px">'
      + '<v-btn icon="mdi-chevron-left" size="small" variant="text" @click="prev()"></v-btn>'
      + '<v-btn icon="mdi-chevron-right" size="small" variant="text" @click="next()"></v-btn>'
      + '<v-btn size="small" variant="text" @click="goToday()">{{ t(\'cal.today\') }}</v-btn>'
      + '<span style="font-weight:600;min-width:150px">{{ title }}</span><v-spacer></v-spacer>'
      + '<v-btn-toggle :model-value="mode" density="compact" variant="outlined" divided mandatory @update:model-value="setMode($event)">'
      + '<v-btn value="month" size="small">{{ t(\'cal.month\') }}</v-btn>'
      + '<v-btn value="week" size="small">{{ t(\'cal.week\') }}</v-btn>'
      + '<v-btn value="list" size="small">{{ t(\'cal.list\') }}</v-btn></v-btn-toggle>'
      // Top-level only: an embedded calendar sits inside someone else's page, where a download button
      // for just this block is noise -- the same reason the embed has no mode toggle chrome of its own.
      + '<v-btn v-if="!embed" icon="mdi-calendar-export" size="small" variant="text" @click="exportIcs()" :title="t(\'btn.export_ics\')" data-testid="cal-export-ics"></v-btn></div>'
      + '<v-divider></v-divider>'
      + '<component :is="body" :cells="displayMode===\'week\'?weekCells:monthCells" :dow-names="dowNames" :days="listDays" :undated="undated" :selected="sel" @select="selectDay"></component>'
      + '<cal-day-panel v-if="displayMode!==\'list\'" :label="selLabel" :events="selEvents" :can-add="canAdd" @add="addOnDay"></cal-day-panel>'
      + '</component>'
  });

  // --- Top-level view-kind components (registry-dispatched) --------------------------------------
  // Each whole-view card as a component so the top-level render is a registry lookup (VIEW_KINDS via
  // viewComponent) instead of a v-if chain. They read the root model through one `a` (appInstance)
  // proxy — state stays on the root (tests + toolbars unchanged), the template just relocates here.
  // Rotation view — name/embed parameterized like calendar-view. Top-level (embed=false) shows the
  // anchor/range/rotateEvery config toolbar and reads the already-generated currentData; an embed
  // (embed=true, from a page/markdown) is toolbar-less and generates its rows via rotationRowsFor, so
  // a rotation renders identically inline and top-level (the old empty embed-view path is retired).
  app.component('rotation-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      rows: function() { return this.embed ? appInstance.rotationRowsFor(this.viewName) : (appInstance.isRotationView ? appInstance.currentData : []); },
      cols: function() { return appInstance.rotationColsFor(this.viewName, this.rows); },
      slotCols: function() { return this.cols.filter(function(c) { return c !== '_period'; }); },
      layout: function() { var v = VIEWS[this.viewName]; return (v && (v.layout || (v.rotation && v.rotation.layout))) || 'table'; },
      displayLayout: function() { return (appInstance.mobile && this.layout === 'table') ? 'card' : this.layout; },
      bodyComponent: function() { return (window.viewPartFor && window.viewPartFor('rotation', this.displayLayout)) || 'rotation-list'; }
    },
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'">'
      + '<template v-if="!embed">'
      + '<div class="d-flex align-center flex-wrap pa-2" style="gap:10px 12px">'
      + '<v-text-field :model-value="a.rotationAnchorForView" name="rotation-anchor" type="date" :label="a.t(\'settings.rotation_anchor\')" density="compact" variant="outlined" hide-details style="max-width:175px" :disabled="!a.canMutateCurrent" @update:model-value="a.saveRotationAnchor(a.currentTable, $event)" data-testid="rotation-anchor"></v-text-field>'
      + '<div class="d-flex align-center" style="gap:2px">'
      + '<v-text-field :model-value="(a.rotationRangeForView.from && a.rotationRangeForView.from !== \'today\') ? a.rotationRangeForView.from : \'\'" name="rotation-from" type="date" :label="a.t(\'settings.rotation_from\')" density="compact" variant="outlined" hide-details style="max-width:165px" :disabled="!a.canMutateCurrent" @update:model-value="a.saveRotationRange(a.currentTable, { from: $event || \'today\' })" data-testid="rotation-from"></v-text-field>'
      + '<v-btn icon="mdi-calendar-today" size="small" variant="text" :disabled="!a.canMutateCurrent" @click="a.saveRotationRange(a.currentTable, { from: \'today\' })" :title="a.t(\'btn.today\')"></v-btn></div>'
      + '<v-text-field :model-value="a.rotationRangeForView.periods" name="rotation-periods" type="number" :label="a.t(\'settings.rotation_periods\')" density="compact" variant="outlined" hide-details style="max-width:115px" :disabled="!a.canMutateCurrent" @update:model-value="a.saveRotationRange(a.currentTable, { periods: $event === \'\' ? \'\' : Number($event) })" data-testid="rotation-periods"></v-text-field>'
      + '<v-text-field :model-value="a.rotationEveryForView" name="rotation-every" type="number" min="0" :label="a.t(\'settings.rotation_every\')" density="compact" variant="outlined" hide-details style="max-width:130px" :disabled="!a.canMutateCurrent" @update:model-value="a.saveRotationRotateEvery(a.currentTable, { every: $event === \'\' ? 0 : Number($event), cycle: a.rotationCycleForView })" data-testid="rotation-every"></v-text-field>'
      + '<v-switch :model-value="a.rotationCycleForView" @update:model-value="v => a.saveRotationRotateEvery(a.currentTable, { every: a.rotationEveryForView, cycle: v })" color="primary" density="compact" hide-details :label="a.t(\'settings.rotation_cycle\')" :disabled="!a.canMutateCurrent" data-testid="rotation-cycle"></v-switch>'
      + '<v-btn v-if="a.rotationRotateEveryOverridden" icon="mdi-restore" size="small" variant="text" :disabled="!a.canMutateCurrent" @click="a.saveRotationRotateEvery(a.currentTable, null)" :title="a.t(\'btn.reset\')" data-testid="rotation-every-reset"></v-btn>'
      + '<v-spacer></v-spacer>'
      + '<v-btn v-if="a.canPrintView" icon="mdi-printer" size="small" variant="text" @click="a.printView()"></v-btn></div>'
      + '<v-divider></v-divider>'
      + '</template>'
      + '<component :is="bodyComponent" :cols="cols" :slot-cols="slotCols" :rows="rows" :view="viewName"></component>'
      + '</component>'
  });

  // Pivot (cross-tab) view — name/embed parameterized like calendar/rotation. Reads the pure Pivot.build
  // grid via the root pivotFor() helper; renders a sticky-header table with optional row/column/grand
  // totals. Row/column keys and value cells are formatted with displayValue (so list values -> labels).
  app.component('pivot-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    // Local sort state, like rsvp-view: a pivot renders a 2-D grid from pivotFor(), not the root's
    // currentData. sortCol is '__row__' (the row-axis label), '__total__', or a COLUMN INDEX -- a pivot
    // addresses values positionally (r.cells[i]), which is why the shared unit is compareValues rather
    // than sortByCol (that one takes a column name off a row object).
    data: function() { return { sortCol: null, sortAsc: true }; },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      cfg: function() { return (VIEWS[this.viewName] && VIEWS[this.viewName].pivot) || {}; },
      viewCfg: function() { return VIEWS[this.viewName] || null; },   // whose obscureNames applies to the axes
      grid: function() { return appInstance.pivotFor(this.viewName); },
      hasTotals: function() { return !!this.grid.columnTotals; },
      // Row order: the grid's own key order until a header is clicked. Cells are counts/sums (real
      // numbers), which compareValues orders numerically; blanks (an empty cell) sort last either way.
      rows: function() {
        var rows = this.grid.rows || [];
        if (this.sortCol === null) return rows;
        var self = this, c = this.sortCol, asc = this.sortAsc;
        var val = function(r) { return c === '__row__' ? self.rowLabel(r.key) : (c === '__total__' ? r.total : r.cells[c]); };
        return rows.slice().sort(function(a, b) { return compareValues(val(a), val(b), asc); });
      }
    },
    methods: Object.assign({}, SORT_UI, {
      head: function(col) { return appInstance.tOr('field.' + col, col); },
      colLabel: function(k) { return appInstance.displayValue(this.cfg.column, k, '', this.viewCfg); },
      rowLabel: function(k) { return appInstance.displayValue(this.cfg.row, k, '', this.viewCfg); },
      cellFmt: function(v) { return (v === '' || v == null) ? '' : (this.cfg.cell ? appInstance.displayValue(this.cfg.cell, v, '', this.viewCfg) : v); }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="pivot-view">'
      + '<v-table density="compact" class="my-1"><template v-slot:default>'
      + '<thead><tr>'
      + '<th style="position:sticky;left:0;z-index:1;background:rgb(var(--v-theme-surface));cursor:pointer" @click="toggleSort(\'__row__\')" data-testid="pivot-sort-row">{{ head(cfg.row) }}{{ sortIcon(\'__row__\') }}</th>'
      + '<th v-for="(c, ci) in grid.columns" :key="c" style="text-align:center;cursor:pointer" @click="toggleSort(ci)"><list-value :col="cfg.column" :value="c" :view-cfg="viewCfg"></list-value>{{ sortIcon(ci) }}</th>'
      + '<th v-if="hasTotals" style="text-align:center;font-weight:700;cursor:pointer" @click="toggleSort(\'__total__\')">{{ a.t(\'pivot.total\') }}{{ sortIcon(\'__total__\') }}</th>'
      + '</tr></thead>'
      + '<tbody>'
      + '<tr v-for="r in rows" :key="r.key">'
      + '<th style="position:sticky;left:0;z-index:1;background:rgb(var(--v-theme-surface));font-weight:600"><list-value :col="cfg.row" :value="r.key" :view-cfg="viewCfg"></list-value></th>'
      + '<td v-for="(v, ci) in r.cells" :key="ci" style="text-align:center">{{ cellFmt(v) }}</td>'
      + '<td v-if="hasTotals" style="text-align:center;font-weight:700">{{ r.total }}</td>'
      + '</tr>'
      + '<tr v-if="!rows.length"><td :colspan="(grid.columns.length || 1) + 1" style="opacity:0.6;padding:12px">{{ a.t(\'pivot.empty\') }}</td></tr>'
      + '</tbody>'
      + '<tfoot v-if="hasTotals"><tr>'
      + '<th style="position:sticky;left:0;z-index:1;background:rgb(var(--v-theme-surface));font-weight:700">{{ a.t(\'pivot.total\') }}</th>'
      + '<td v-for="(t, ci) in grid.columnTotals" :key="ci" style="text-align:center;font-weight:700">{{ t }}</td>'
      + '<td style="text-align:center;font-weight:800">{{ grid.grandTotal }}</td>'
      + '</tr></tfoot>'
      + '</template></v-table>'
      + '</component>'
  });

  // Timeline view: rows with a start and an end, as bars across periods — the shape a calendar cannot
  // hold, since it places a row on one day. Read-only, like pivot and stats: a bar is a picture of a
  // row that is edited in its own table.
  //
  // The bar is laid out with a CSS grid column span rather than percentage widths. The period columns
  // then decide the geometry once, so a bar cannot drift out of step with the header it is measured
  // against — which is the failure percentage math produces at exactly the sizes nobody tests at.
  app.component('timeline-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      cfg: function() { return (VIEWS[this.viewName] && VIEWS[this.viewName].timeline) || {}; },
      viewCfg: function() { return VIEWS[this.viewName] || null; },   // whose obscureNames applies to the labels
      chart: function() { return appInstance.timelineFor(this.viewName); },
      cols: function() { return 'minmax(120px,1.4fr) repeat(' + (this.chart.periods.length || 1) + ', minmax(28px,1fr))'; }
    },
    methods: {
      // The bar's caption, through displayValue so a list value renders as its label and an obscured
      // column stays obscured — the same resolver the grid uses, never String(row[col]).
      label: function(row) {
        var cols = this.cfg.label || [];
        var self = this;
        var out = (Array.isArray(cols) ? cols : [cols]).map(function(c) {
          return appInstance.displayValue(c, row[c], '', self.viewCfg);
        }).filter(Boolean).join(' — ');
        return out || appInstance.tOr('view.' + this.viewName, this.viewName);
      },
      periodLabel: function(d) {
        var p = String(d).split('-');
        return new Intl.DateTimeFormat(appInstance.calLocale(), { day: 'numeric', month: 'short' }).format(new Date(+p[0], +p[1] - 1, +p[2]));
      },
      // A clipped bar loses its rounded end on that side, so "continues past here" is visible in the
      // shape and not only in the tooltip.
      barStyle: function(b) {
        return {
          gridColumn: (b.offset + 2) + ' / span ' + b.span,
          background: appInstance.hashColor(this.label(b.row)),
          borderTopLeftRadius: b.clippedStart ? '0' : '4px', borderBottomLeftRadius: b.clippedStart ? '0' : '4px',
          borderTopRightRadius: b.clippedEnd ? '0' : '4px', borderBottomRightRadius: b.clippedEnd ? '0' : '4px'
        };
      },
      barTitle: function(b) { return this.label(b.row) + ' (' + b.start + ' – ' + b.end + ')'; }
    },
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="timeline-view">'
      + '<div style="overflow-x:auto">'
      + '<div :style="{ display:\'grid\', gridTemplateColumns: cols, alignItems:\'center\', minWidth:\'420px\', gap:\'2px 0\', padding:\'8px\' }">'
      // Header: the row-label gutter, then one cell per period.
      + '<div style="font-weight:600;font-size:0.8rem"></div>'
      + '<div v-for="p in chart.periods" :key="p" style="font-size:0.7rem;opacity:0.7;text-align:center;white-space:nowrap">{{ periodLabel(p) }}</div>'
      // One grid row per bar: the caption in the gutter, then the bar spanning its own periods.
      + '<template v-for="(b, i) in chart.bars" :key="i">'
      + '<div style="font-size:0.85rem;padding-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" :title="barTitle(b)">{{ label(b.row) }}</div>'
      + '<div :style="barStyle(b)" style="height:16px;grid-row:auto" :title="barTitle(b)" data-testid="timeline-bar"></div>'
      + '</template>'
      + '</div></div>'
      + '<div v-if="!chart.bars.length" style="opacity:0.6;padding:12px">{{ a.t(\'timeline.empty\') }}</div>'
      + '</component>'
  });

  // Stats view: the aggregate pipeline's output as headline numbers instead of a table. Same two input
  // modes every other kind has -- top-level (no props) or embedded ({{view:x}} passes :name + :embed) --
  // and no local state, because a tile has nothing to interact with. Read-only by nature: there is no
  // row to edit, only a number derived from rows that are edited somewhere else.
  app.component('stats-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      viewCfg: function() { return VIEWS[this.viewName] || null; },   // whose obscureNames applies to perRow captions
      tiles: function() { return appInstance.statsFor(this.viewName).tiles || []; },
      // perRow tiles are a leaderboard: one per row, so they stack full-width and stay readable at any
      // count. Explicit `tiles` are a scorecard: a handful of them, side by side. Same component, and
      // the difference is a single grid-template rather than two templates to keep in step.
      perRow: function() { return !!((VIEWS[this.viewName] || {}).stats || {}).perRow; },
      gridStyle: function() {
        return this.perRow
          ? 'display:grid;grid-template-columns:1fr;gap:10px'
          : 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px';
      }
    },
    methods: Object.assign({}, ROOT_PROXY, {
      // A tile's number, formatted the way the same value would render in a cell: a `latest` tile over a
      // date column should read like that date, not like an ISO string, and a list-backed column should
      // show its label. Numbers with no column behind them (count, or a perRow total) pass through.
      fmt: function(t) {
        if (t.value == null) return '—';
        if (t.column && typeof t.value !== 'number') return appInstance.displayValue(t.column, t.value, '', this.viewCfg);
        return t.value;
      },
      // A rung's name, translatable like a tile label. A ladder authored as bare numbers has no name,
      // so it shows the threshold reached — which still says which rung is held.
      tierLabel: function(tier) { return tier.label ? appInstance.tOr(tier.label, tier.label) : tier.at; }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'pa-4\'" data-testid="stats-view">'
      + '<div :style="gridStyle">'
      + '<div v-for="(t, i) in tiles" :key="i" data-testid="stat-tile" style="padding:10px 12px;border:1px solid rgb(var(--v-theme-outline),0.25);border-radius:8px">'
      // perRow labels come from a COLUMN, so they route through list-value for the same display text
      // (and linked-user avatar) the pivot axes and the grid cells give that column. An explicit tile's
      // label is authored prose and is printed as written.
      +   '<div style="font-size:0.72rem;opacity:0.7;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:4px">'
      +     '<list-value v-if="t.labelCol" :col="t.labelCol" :value="t.label" :view-cfg="viewCfg"></list-value>'
      +     '<span v-else>{{ tOr(t.label, t.label) }}</span>'
      +   '</div>'
      +   '<div style="display:flex;align-items:baseline;gap:6px">'
      +     '<span style="font-size:1.7rem;font-weight:700;line-height:1.1" data-testid="stat-value">{{ fmt(t) }}</span>'
      +     '<span v-if="t.goal !== null" style="font-size:0.8rem;opacity:0.6">/ {{ t.goal }}</span>'
      +     '<span v-if="t.tier" data-testid="stat-tier" style="font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;padding:1px 7px;border-radius:10px;background:rgba(var(--v-theme-primary),0.16);color:rgb(var(--v-theme-primary))">{{ tierLabel(t.tier) }}</span>'
      +   '</div>'
      // The bar is drawn only when there is a goal to measure against; a tile without one is a number
      // and gets no empty track suggesting a target nobody set. `over` recolours rather than overflows —
      // pct is already clamped, so a 138%-of-goal tile shows a full bar plus its real number above it.
      +   '<v-progress-linear v-if="t.display === \'bar\' && t.pct !== null" :model-value="t.pct" :color="t.over ? \'success\' : \'primary\'" height="6" rounded class="mt-2" data-testid="stat-bar"></v-progress-linear>'
      + '</div>'
      + '<div v-if="!tiles.length" style="opacity:0.6;font-size:0.85rem;padding:8px">{{ a.t(\'stats.empty\') }}</div>'
      + '</div>'
      + '</component>'
  });

  // ONE list VALUE (or a multiselect array of them), rendered as its display text with the linked user's
  // avatar in front when there is one. This is THE single place a list value + optional avatar is drawn, so
  // avatars appear consistently wherever a value is printed — read-only cells, embeds, the compact list
  // layout, rotation slots, the pivot axes, and group-card titles. Non-list columns just render their text;
  // dates (and the synthetic _period) pass through toDateStr. Drop-in for `{{ displayValue(col, val) }}`.
  app.component('list-value', {
    props: { col: { type: String, required: true }, value: {}, size: { type: [Number, String], default: 18 },
             nsCol: { type: String, default: '' },     // resolve labels/avatars from THIS column's list instead
             viewCfg: { type: Object, default: null } },  // the view whose obscureNames applies (null = the current one)
    computed: {
      items: function() {
        var col = this.col, v = this.value, a = appInstance, cfg = this.viewCfg;
        if (col === '_period' || a.colIsDate(col)) return (v == null || v === '') ? [] : [{ text: a.toDateStr(v), pic: '' }];
        var arr = Array.isArray(v) ? v : ((v == null || v === '') ? [] : [v]);
        var ns = this.nsCol || '';
        return arr.filter(function(x) { return x != null && x !== ''; }).map(function(x) {
          return { text: a.displayValue(col, x, ns, cfg), pic: a.listValuePicture(col, x, ns) };
        });
      }
    },
    template: ''
      + '<span class="list-value">'
      + '<span v-for="(it, i) in items" :key="i" class="list-value__item">'
      +   '<user-avatar v-if="it.pic" :picture="it.pic" :name="it.text" :size="size"></user-avatar>'
      +   '<span>{{ it.text }}{{ i < items.length - 1 ? \',\' : \'\' }}</span>'
      + '</span>'
      + '</span>'
  });

  // A person's avatar, resolved from their email: their uploaded picture, else their name's initial, else a
  // generic account icon. The single place a user's face renders, reused everywhere a user is shown (app bar,
  // Users table, rsvp roster). `name` is an optional override so callers that already have the display name
  // don't force a second profilesByEmail lookup. `title` falls through onto the avatar for a hover tooltip.
  app.component('user-avatar', {
    props: { email: { type: String, default: '' }, name: { type: String, default: '' }, size: { type: [Number, String], default: 28 }, picture: { type: String, default: '' } },
    computed: {
      // A directly-supplied picture (e.g. a list-value's server-projected avatar, where the caller has no
      // email to resolve) wins; otherwise resolve from the email's profile.
      pic: function() { return this.picture || appInstance.profilePicture(this.email); },
      // Given name wins; otherwise the shared email->display-name rule (admins may fall back to the raw
      // email, non-admins get '' -> the generic account icon). Named/pictured users are unaffected.
      label: function() { return this.name || appInstance.userLabel(this.email); },
      initial: function() { var s = (this.label || '').trim(); return s ? s.charAt(0).toUpperCase() : ''; },
      iconSize: function() { return Math.round(Number(this.size) * 0.6) || 16; }
    },
    template: ''
      + '<v-avatar :size="size" color="surface-variant" class="user-avatar">'
      + '<v-img v-if="pic" :src="pic" :alt="label" cover></v-img>'
      + '<span v-else-if="initial" class="user-avatar__initial" :style="{ fontSize: (Number(size) * 0.45) + \'px\' }">{{ initial }}</span>'
      + '<v-icon v-else :size="iconSize" icon="mdi-account"></v-icon>'
      + '</v-avatar>'
  });

  // A person identified by EMAIL, rendered as their avatar + display name. The shared "show a user" chip for
  // the email-keyed surfaces (rsvp roster today), pairing user-avatar with the same privacy-aware userLabel.
  // `name` overrides the resolved label when the caller already has it. Distinct from <list-value>, which
  // renders a curated list value + its LINKED avatar; here the email IS the identity.
  app.component('user-ref', {
    props: { email: { type: String, default: '' }, name: { type: String, default: '' }, size: { type: [Number, String], default: 20 } },
    computed: { label: function() { return this.name || appInstance.userLabel(this.email); } },
    template: ''
      + '<span class="user-ref">'
      + '<user-avatar :email="email" :name="label" :size="size"></user-avatar>'
      + '<span v-if="label">{{ label }}</span>'
      + '</span>'
  });

  // Admin picker in the Lookup editor: link a single list VALUE to a registered user (stores the email;
  // the value itself is unchanged). The activator shows the linked user's avatar, or a "link" icon when
  // none; the menu lists registered users (name + avatar) plus an unlink option.
  app.component('list-user-picker', {
    props: { list: { type: String, required: true }, value: { type: String, required: true } },
    computed: {
      a: function() { return appInstance; },
      email: function() { return (appInstance.listUserLinks[this.list] || {})[this.value] || ''; },
      pic: function() { return this.email ? appInstance.profilePicture(this.email) : ''; },
      name: function() { return this.email ? (appInstance.profileName(this.email) || this.email) : ''; },
      options: function() { return appInstance.listUserOptions(); }
    },
    methods: { pick: function(email) { appInstance.setListUserLink(this.list, this.value, email || ''); } },
    // Three states: unlinked (muted add-person), linked with a photo (their face), linked without a photo
    // (a primary "account linked" check — clearer than a bare name-initial). Tooltip names who is linked.
    template: ''
      + '<v-menu location="bottom end" :close-on-content-click="true">'
      + '<template v-slot:activator="{ props }">'
      + '<v-btn v-bind="props" size="x-small" variant="text" :color="email ? \'primary\' : \'\'" :title="email ? name : a.t(\'list.link_user\')" data-testid="list-user-picker">'
      + '<user-avatar v-if="pic" :email="email" :size="22"></user-avatar>'
      + '<v-icon v-else-if="email" color="primary" size="small" icon="mdi-account-check"></v-icon>'
      + '<v-icon v-else size="small" icon="mdi-account-plus-outline"></v-icon>'
      + '</v-btn>'
      + '</template>'
      + '<v-list density="compact" max-height="320" min-width="180">'
      + '<v-list-item v-if="email" @click="pick(\'\')" prepend-icon="mdi-link-off" :title="a.t(\'list.unlink_user\')"></v-list-item>'
      + '<v-divider v-if="email"></v-divider>'
      + '<v-list-item v-for="o in options" :key="o.email" @click="pick(o.email)" :active="o.email === email" :title="o.name">'
      + '<template v-slot:prepend><user-avatar :email="o.email" :name="o.name" :size="24" class="mr-2"></user-avatar></template>'
      + '</v-list-item>'
      + '</v-list>'
      + '</v-menu>'
  });

  // The current user's status control for one event — the 3 picker variants share this so the rsvp table
  // and card layouts render the same widget. Emits 'set' with the chosen value ('' when deselected).
  app.component('rsvp-picker', {
    props: { options: { type: Array, default: function() { return []; } }, picker: { type: String, default: 'dropdown' }, value: { default: '' } },
    emits: ['set'],
    template: ''
      + '<v-btn-toggle v-if="picker===\'toggle\'" :model-value="value" density="compact" variant="outlined" divided @update:model-value="$emit(\'set\', $event)" data-testid="rsvp-toggle">'
      + '<v-btn v-for="o in options" :key="o.value" :value="o.value" size="small">{{ o.title }}</v-btn>'
      + '</v-btn-toggle>'
      + '<v-chip-group v-else-if="picker===\'chips\'" :model-value="value" @update:model-value="$emit(\'set\', $event)" data-testid="rsvp-toggle">'
      + '<v-chip v-for="o in options" :key="o.value" :value="o.value" size="small" filter variant="outlined" color="primary">{{ o.title }}</v-chip>'
      + '</v-chip-group>'
      + '<v-select v-else :model-value="value" :items="options" item-title="title" item-value="value" density="compact" variant="outlined" hide-details clearable placeholder="…" style="min-width:130px;max-width:170px" @update:model-value="$emit(\'set\', $event)" data-testid="rsvp-toggle"></v-select>'
  });

  // RSVP / signup view — name/embed parameterized. Lists upcoming events (from rsvpFor) each with the
  // current user's own status toggle (setRsvp upserts their owner-stamped response row) and an optional
  // tally. Renders a one-row-per-event table on desktop and stacked cards on mobile. Self-service: works
  // for any signed-in member regardless of role; firestore rules enforce a member writes only their OWN row.
  // --- form-view: one record, filled in properly -------------------------------------------------
  // Fields render through data-cell, the same editor the grid uses, so every column type, widget, list,
  // listSwitch and translation works here without a second implementation. What this component adds is
  // the FORM shape: sections with headings, required-field validation before submit, and a submitted
  // state that says so rather than silently offering an edit the rules would refuse.
  //
  // Fields save as they are edited (data-cell -> saveField), which is what lets a half-finished form
  // survive a reload. "Submit" is therefore not what writes the answers -- it marks the record done,
  // and is the only moment `required` is enforced.
  app.component('form-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    data: function() { return { touched: false }; },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      cfg: function() { return (VIEWS[this.viewName] && VIEWS[this.viewName].form) || {}; },
      built: function() { return appInstance.formFor(this.viewName); },
      // The row being edited. Null until the person starts: a form must not create a record in the
      // database merely because somebody looked at the page.
      item: function() { return this.built.record; },
      signedIn: function() { return !!appInstance.currentUserEmail; },
      missing: function() { return this.built.missing; },
      canSubmit: function() { return this.built.complete && this.built.editable; },
      // Once the state gate has closed, say so. The rules would refuse the write anyway; a dead editor
      // that fails on save is the version that looks like a bug.
      locked: function() { return this.built.submitted && !this.built.editable; },
      intro: function() { return this.cfg.intro ? appInstance.mdBlocks(this.cfg.intro, this.viewName) : []; },
      doneText: function() { return this.cfg.done ? appInstance.mdBlocks(this.cfg.done, this.viewName) : []; }
    },
    methods: {
      label: function(col) { return appInstance.tOr("field." + col, col); },
      isMissing: function(col) { return this.touched && this.missing.indexOf(col) >= 0; },
      isRequired: function(col) { return this.built.required.indexOf(col) >= 0; },
      start: function() { appInstance.formRecord(this.viewName); },
      submit: function() {
        this.touched = true;
        if (!this.canSubmit) { appInstance.notify(appInstance.t("msg.form_incomplete")); return; }
        var col = this.cfg.submitColumn;
        if (col && this.item) {
          appInstance.saveField(this.item, col, this.cfg.submitValue === undefined ? "submitted" : this.cfg.submitValue);
        }
        appInstance.notify(appInstance.t("msg.form_submitted"));
      }
    },
    template: ''
      + '<v-card class="pa-4" style="max-width:760px">'
      +   '<div v-for="(b, i) in intro" :key="i" v-html="b.html"></div>'
      +   '<div v-if="!signedIn" class="text-medium-emphasis">{{ a.t("msg.sign_in_respond") }}</div>'
      +   '<template v-else>'
      +     '<div v-if="locked">'
      +       '<div v-for="(b, i) in doneText" :key="i" v-html="b.html"></div>'
      +       '<v-alert v-if="!doneText.length" type="success" variant="tonal" density="compact">{{ a.t("msg.form_submitted") }}</v-alert>'
      +     '</div>'
      +     '<v-btn v-else-if="!item" color="primary" @click="start">{{ a.tOr(cfg.startLabel, a.t("btn.add")) }}</v-btn>'
      +     '<div v-else>'
      +       '<div v-for="(sec, si) in built.sections" :key="si" class="mb-4">'
      +         '<div v-if="sec.title" class="text-subtitle-2 mb-2" style="opacity:0.85">{{ a.tOr(sec.title, sec.title) }}</div>'
      +         '<div v-for="col in sec.columns" :key="col" class="mb-3">'
      +           '<div class="text-caption" style="opacity:0.75">{{ label(col) }}<span v-if="isRequired(col)" style="opacity:0.6"> *</span></div>'
      +           '<data-cell :item="item" :col="col" :owner="viewName"></data-cell>'
      +           '<div v-if="isMissing(col)" class="text-caption text-error">{{ a.t("msg.form_required") }}</div>'
      +         '</div>'
      +       '</div>'
      +       '<v-btn color="primary" data-testid="form-submit" @click="submit">{{ a.tOr(cfg.submitLabel, a.t("btn.save")) }}</v-btn>'
      +     '</div>'
      +   '</template>'
      + '</v-card>'
  });

  app.component('rsvp-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    // Sort is component-local: rsvp renders its own event list (from the rsvp.js engine), not the root's
    // currentData, so the root sortCol/sortAsc the data grid uses would sort a list nobody displays.
    // null = the engine's own order (chronological, upcoming first) -- the view's natural default.
    data: function() { return { sortCol: null, sortAsc: true }; },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      cfg: function() { return (VIEWS[this.viewName] && VIEWS[this.viewName].rsvp) || {}; },
      data: function() { return appInstance.rsvpFor(this.viewName); },
      // The rendered rows: engine order until a header is clicked, then Rows.compareValues -- the same
      // comparator the data grid and embeds use, so blanks-last/numeric ordering all agree.
      events: function() {
        var evs = (this.data && this.data.events) || [];
        if (!this.sortCol) return evs;
        var col = this.sortCol, asc = this.sortAsc;
        // "Your response" is a status value: order it by the configured status order, not alphabetically
        // (the same way a list-backed column follows its list's authored order in the grid).
        var lo = null;
        if (col === 'myStatus') { lo = {}; this.options.forEach(function(o, i) { lo[o.value] = i; }); }
        return evs.slice().sort(function(a, b) { return compareValues(a[col], b[col], asc, lo); });
      },
      // Status choices as { value, title } — from the view's inline `statuses`, else the status column's
      // list. Titles are translated (see statusLabel).
      options: function() {
        var self = this;
        var vals = this.cfg.statuses || (appInstance.getListOptions(this.cfg.statusColumn) || []).map(function(o) { return o.value; });
        return vals.map(function(v) { return { value: v, title: self.statusLabel(v) }; });
      },
      // UI element for choosing a status: 'toggle' (segmented buttons, default) | 'chips' | 'dropdown'.
      picker: function() { return this.cfg.picker || 'dropdown'; },
      // Whether to show WHO registered (names), per the view's `roster` setting: 'all' -> everyone,
      // 'admins' -> only admins (pair with an owner-scoped-read table so it's actually private), else
      // just counts. Note the data is already access-filtered server-side; this is the display gate.
      showRoster: function() { return this.cfg.rosterVisibility === 'all' || (this.cfg.rosterVisibility === 'admins' && appInstance.isAdmin); }
    },
    methods: Object.assign({}, SORT_UI, {
      set: function(key, status) { appInstance.setRsvp(this.viewName, key, status || ''); },
      toDateStr: toDateStr,
      // Translated label for a status VALUE, keyed by `list.<statusList||statusColumn>.<value>` (falls back
      // to the raw value). `statusList` lets the view name a translation namespace distinct from the column
      // — whose name may resolve to another table's list under the per-column-name list resolver.
      statusLabel: function(v) { var list = this.cfg.statusList || appInstance.colIsList(this.cfg.statusColumn) || this.cfg.statusColumn; return appInstance.tOr('list.' + list + '.' + v, v); },
      tallyText: function(ev) { var self = this; return Object.keys(ev.tally).sort().map(function(s) { return self.statusLabel(s) + ': ' + ev.tally[s]; }).join('  ·  '); },
      // A participant's display label under the profile-privacy rule: a shared (named) member shows their
      // name; an admin additionally sees the raw email for members who haven't shared; a non-admin gets ''
      // for any unshared member, so rosterGroups can drop them — an unshared profile is hidden from
      // non-admins entirely, never revealed as a name OR an email.
      ownerName: function(email) { return appInstance.userLabel(email); },
      // Participants grouped by status: [{ status, label, people:[{ email, name }] }], in the configured
      // status order. Carries each person's email so the roster can render a per-person avatar, and drops
      // anyone with no resolvable label (a non-admin viewing an unshared member) so the public roster never
      // reveals or counts a hidden identity.
      rosterGroups: function(ev) {
        var self = this, order = this.options.map(function(o) { return o.value; }), groups = {};
        ev.participants.forEach(function(p) {
          var name = self.ownerName(p.owner);
          if (!name) return;   // unshared member seen by a non-admin -> hidden
          (groups[p.status] || (groups[p.status] = [])).push({ email: p.owner, name: name });
        });
        var keys = Object.keys(groups).sort(function(a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
        return keys.map(function(s) { return { status: s, label: self.statusLabel(s), people: groups[s] }; });
      }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="rsvp-view">'
      + '<v-table v-if="!a.mobile" density="compact">'
      + '<thead><tr>'
      + '<th class="text-left" style="cursor:pointer" @click="toggleSort(\'date\')" data-testid="rsvp-sort-date">{{ a.t(\'rsvp.date\') }}{{ sortIcon(\'date\') }}</th>'
      + '<th class="text-left" style="cursor:pointer" @click="toggleSort(\'title\')">{{ a.t(\'rsvp.title\') }}{{ sortIcon(\'title\') }}</th>'
      + '<th class="text-left" style="cursor:pointer" @click="toggleSort(\'myStatus\')">{{ a.t(\'rsvp.your_response\') }}{{ sortIcon(\'myStatus\') }}</th>'
      + '<th v-if="cfg.showCounts" class="text-left" style="cursor:pointer" @click="toggleSort(\'total\')">{{ a.t(\'rsvp.responses\') }}{{ sortIcon(\'total\') }}</th>'
      // "Who" is a status-grouped name roster, not a single value -- nothing coherent to order by.
      + '<th v-if="showRoster" class="text-left">{{ a.t(\'rsvp.who\') }}</th>'
      + '</tr></thead>'
      + '<tbody>'
      + '<tr v-for="ev in events" :key="ev.id">'
      + '<td style="white-space:nowrap">{{ toDateStr(ev.date) }}</td>'
      + '<td>{{ ev.title }}</td>'
      + '<td><rsvp-picker :options="options" :picker="picker" :value="ev.myStatus" @set="set(ev.key, $event)"></rsvp-picker></td>'
      + '<td v-if="cfg.showCounts" style="font-size:0.82rem;opacity:0.75;white-space:nowrap">{{ tallyText(ev) }}</td>'
      + '<td v-if="showRoster" style="font-size:0.82rem" data-testid="rsvp-roster"><div v-for="g in rosterGroups(ev)" :key="g.status" class="rsvp-roster-group"><span style="opacity:0.6">{{ g.label }}:</span> <user-ref v-for="p in g.people" :key="p.email" :email="p.email" :name="p.name" :size="20" class="rsvp-person"></user-ref></div></td>'
      + '</tr>'
      + '<tr v-if="!events.length"><td colspan="5" style="opacity:0.6">{{ a.t(\'rsvp.none\') }}</td></tr>'
      + '</tbody>'
      + '</v-table>'
      + '<div v-else class="pa-1">'
      + '<v-card v-for="ev in events" :key="ev.id" variant="tonal" class="mb-2 pa-3">'
      + '<div>{{ toDateStr(ev.date) }}</div>'
      + '<div v-if="ev.title" class="mb-2" style="font-size:0.9rem;opacity:0.7">{{ ev.title }}</div>'
      + '<rsvp-picker :options="options" :picker="picker" :value="ev.myStatus" @set="set(ev.key, $event)"></rsvp-picker>'
      + '<div v-if="cfg.showCounts && ev.total" class="mt-2" style="font-size:0.8rem;opacity:0.7">{{ tallyText(ev) }}</div>'
      + '<div v-if="showRoster && ev.participants.length" class="mt-1" style="font-size:0.82rem" data-testid="rsvp-roster"><div v-for="g in rosterGroups(ev)" :key="g.status" class="rsvp-roster-group"><span style="opacity:0.6">{{ g.label }}:</span> <user-ref v-for="p in g.people" :key="p.email" :email="p.email" :name="p.name" :size="20" class="rsvp-person"></user-ref></div></div>'
      + '</v-card>'
      + '<div v-if="!events.length" class="pa-2" style="opacity:0.6">{{ a.t(\'rsvp.none\') }}</div>'
      + '</div>'
      + '</component>'
  });

  // Board (kanban) view — single-source data view rendered as lanes grouped by `board.lane`. Reads the
  // root's currentData (the same editable rows the data grid uses), so a drag/menu-move writes straight
  // back through saveField. Cards carry native HTML5 drag (desktop) + a move-menu fallback (touch/a11y).
  // name/embed parameterized like the other kind components; the embed path preloads its own rows.
  app.component('board-view', {
    props: { name: { type: String, default: null }, embed: { type: Boolean, default: false } },
    data: function() { return { dragId: null, overLane: null, collapsed: {}, menuOf: {}, editing: {} }; },
    computed: {
      a: function() { return appInstance; },
      viewName: function() { return this.name || appInstance.currentTable; },
      view: function() { return VIEWS[this.viewName] || {}; },
      cfg: function() { return this.view.board || {}; },
      // A computed rather than t() inline: the board template is a JS string, and a nested quote
      // there is one escape away from a silent parse break.
      searchLabel: function() { return appInstance.t('btn.search'); },
      laneCol: function() { return this.cfg.lane; },
      canEdit: function() { return !this.embed && appInstance.canMutateRows; },
      // Moving a card writes the lane column. On a self-service table that is an owner-scoped write, so
      // a card is only movable if `ownerWritable` lets its owner set the lane — otherwise the drop would
      // be refused by the rules and the card would snap back unexplained.
      canMoveCards: function() {
        var a = appInstance;
        if (!a.currentSelfService) return true;
        return a.ownerCanWrite(a.selfServeTable, this.laneCol);
      },
      // The lane a member who may NOT write the lane column would land in by adding — the column's own
      // `default`. On such a board the per-lane `+` is offered there and nowhere else (see canAddInLane),
      // because adding into a lane STAMPS that lane value.
      defaultLane: function() {
        var lc = this.laneCol;
        var d = getDefaultCols((this.view.sources || [])[0]).filter(function(x) { return x.name === lc; })[0];
        return (d && d.value !== undefined) ? String(d.value) : '';
      },
      hasArchive: function() { return appInstance.hasArchive; },
      // A board reads currentData directly rather than through sortedData (it groups into lanes rather
      // than sorting a list), so the runtime search has to be applied here too -- otherwise typing a
      // name would narrow every view kind except this one.
      rows: function() {
        if (this.embed) return appInstance.boardRowsFor ? appInstance.boardRowsFor(this.viewName) : [];
        var rows = appInstance.currentData || [];
        return (appInstance.searchable && appInstance.searchTerm)
          ? Rows.searchRows(rows, appInstance.searchTerm, appInstance.searchCols)
          : rows;
      },
      // A 2-D REF lane: when `board.lane` is a `ref` to a 2-column lookup, the lookup's two dimensions are the
      // group (parent col) and the lane value (child col). Lane order, grouping, and labels then come from that
      // lookup DATA — no schema laneGroups. Null for a plain select lane, so the list/laneGroups paths run.
      refLane: function() {
        if (!appInstance.colIsRef(this.laneCol)) return null;
        var rf = appInstance.colRef(this.laneCol);
        if (!rf || !rf.table) return null;
        var scols = (SCHEMA[rf.table] && SCHEMA[rf.table].columns) || {};
        var cols = getColumns(rf.table).filter(function(c) { if (c === 'id' || c === 'created_at' || c === 'updated_at') return false; var d = scols[c]; return !(d && typeof d === 'object' && d.hidden); });
        if (cols.length < 2) return null;                       // 1-col ref -> no group dimension; treat as flat
        var childCol = rf.valueCol || cols[cols.length - 1];
        var parentCol = cols[0] === childCol ? cols[1] : cols[0];
        var rows = appInstance.dataCache[rf.table] || [];
        if (SCHEMA[rf.table] && SCHEMA[rf.table].reorderable) rows = rows.slice().sort(function(a, b) { return (Number(a.position) || 0) - (Number(b.position) || 0); });  // stable, reorderable order
        return { table: rf.table, parentCol: parentCol, childCol: childCol, rows: rows };
      },
      // Lane keys in intended order: a ref lane -> the lookup's child values in row order; else explicit
      // `lanes`, else the select column's list (authored order).
      laneOrder: function() {
        var rl = this.refLane;
        if (rl) { var cc = rl.childCol; return rl.rows.map(function(r) { return r[cc]; }).filter(function(v) { return v != null && v !== ''; }); }
        if (this.cfg.lanes) return this.cfg.lanes.slice();
        return (appInstance.getListOptions(this.laneCol) || []).map(function(o) { return o.value; });
      },
      board: function() {
        return Board.build(this.rows, { lane: this.laneCol, laneOrder: this.laneOrder, hidden: this.cfg.hiddenLanes || [] });
      },
      // Phase grouping. [{ label, key, lanes:[laneObj,...] }]. Source of the grouping:
      //   ref lane   -> the lookup's parent dimension (group order = first appearance across lookup rows);
      //   laneGroups -> schema-declared phases (legacy/select lanes);
      //   neither    -> one unlabeled group (flat board).
      groups: function() {
        var laneMap = {}; this.board.lanes.forEach(function(l) { laneMap[l.key] = l; });
        var rl = this.refLane;
        if (rl) {
          var order = [], byParent = {}, used = {};
          rl.rows.forEach(function(r) {
            var lane = laneMap[r[rl.childCol]];
            if (!lane) return;
            var p = r[rl.parentCol] == null ? '' : String(r[rl.parentCol]);
            if (!(p in byParent)) { byParent[p] = []; order.push(p); }
            byParent[p].push(lane); used[lane.key] = 1;
          });
          var out = order.map(function(p, gi) { var ls = byParent[p]; return { label: p, key: 'g' + gi, count: ls.reduce(function(s, l) { return s + l.count; }, 0), lanes: ls }; });
          var rest = this.board.lanes.filter(function(l) { return !used[l.key]; });   // data values not in the lookup (e.g. blank)
          if (rest.length) out.push({ label: null, key: '__rest__', count: rest.reduce(function(s, l) { return s + l.count; }, 0), lanes: rest });
          return out;
        }
        var cfgGroups = this.cfg.laneGroups;
        if (!cfgGroups || !cfgGroups.length) return [{ label: null, key: '__all__', lanes: this.board.lanes }];
        var used2 = {};
        var out2 = cfgGroups.map(function(g, gi) {
          var lanes = (g.lanes || []).map(function(k) { used2[k] = 1; return laneMap[k]; }).filter(Boolean);
          return { label: g.label, key: 'g' + gi, count: lanes.reduce(function(s, l) { return s + l.count; }, 0), lanes: lanes };
        });
        var rest2 = this.board.lanes.filter(function(l) { return !used2[l.key]; });
        if (rest2.length) out2.push({ label: null, key: '__rest__', count: rest2.reduce(function(s, l) { return s + l.count; }, 0), lanes: rest2 });
        return out2;
      }
    },
    created: function() {
      var self = this;
      (this.cfg.laneGroups || []).forEach(function(g, gi) { if (g.collapsed) self.collapsed['g' + gi] = true; });
    },
    methods: Object.assign({}, ROOT_PROXY, {
      // Per-CARD permission. `canEdit` is the view-level gate; on a self-service table it is true for a
      // member who owns SOME rows, which is not a licence over everyone else's. The grid has always asked
      // canMutateRow per row (see ui.html) — the board did not, so a member saw pencil/archive/delete on
      // every card in the lane, including other people's. Non-self-service boards are unaffected
      // (canMutateRow is true for every row there).
      canEditCard: function(item) { return this.canEdit && appInstance.canMutateRow(item); },
      // Adding into a lane stamps that lane value, so it asks the same question as moving a card there.
      // A member who may not write the lane column still gets the `+`, but only on the lane the column's
      // own default would put them in — the one lane value they are allowed to write.
      canAddInLane: function(laneKey) {
        if (!this.canEdit || !this.cfg.addInLane) return false;
        return this.canMoveCards || laneKey === this.defaultLane;
      },
      laneLabel: function(k) { return k === '' ? appInstance.t('board.unassigned') : appInstance.displayValue(this.laneCol, k); },
      // Phase-header label. A ref lane's group is the lookup's parent VALUE, localized through the lookup
      // table's namespace (list.<table>.<value>); a laneGroups phase uses its authored board.group.<label>.
      groupLabel: function(g) {
        if (g.label == null || g.label === '') return '';
        if (this.refLane) return appInstance.tOr('list.' + this.refLane.table + '.' + g.label, g.label);
        return appInstance.tOr('board.group.' + g.label, g.label);
      },
      titleCol: function() { return colName(this.cfg.title || (this.view.columns || [])[0] || ''); },
      cardTitle: function(item) { var c = this.titleCol(); return c ? appInstance.displayValue(c, item[c]) : (item.id || ''); },
      // Per-ROW card face: a conditional column is dropped from the cards whose rows don't match, the
      // same as a card-layout grid. Evaluated against this board's own view config, so `when`/`hideEmpty`
      // behave here exactly as they do top-level and in an embed.
      cardCols: function(item) {
        var self = this, title = this.titleCol();
        return (this.view.columns || []).map(colName).filter(function(c) {
          if (typeof c !== 'string' || !c || c === title || c === self.laneCol) return false;
          return !(item && appInstance && appInstance.isColumnHidden(c, item, self.view));
        });
      },
      // The card's left stripe, from `board.color`. A LIST-BACKED column indexes the palette by the
      // value's position in its list rather than hashing it: 10 colors and a handful of people means a
      // hash collides most of the time (5 names -> ~70%), which is how Ann, Bob, Cara and Dan all ended
      // up wearing one color on a board that claims to be colored by person. List order is stable, so
      // the first 10 values get 10 distinct colors. Anything else (a free-text or lookup-backed column)
      // still hashes — there is no ordering to borrow.
      cardColor: function(item) {
        var col = this.cfg.color;
        if (!col) return null;
        var val = String((item && item[col]) || '');
        if (!val) return null;
        var list = appInstance.colIsList(col);
        var items = list && appInstance.listsCache[list];
        var i = items ? items.indexOf(val) : -1;
        return i >= 0 ? Calendar.paletteAt(i, appInstance.theme) : Calendar.hashColor(val, appInstance.theme);
      },
      toggleGroup: function(key) { this.collapsed[key] = !this.collapsed[key]; },
      // --- drag/drop (desktop) ---
      onDragStart: function(item) { if (this.canEditCard(item) && this.canMoveCards) this.dragId = item.id; },
      onDragEnd: function() { this.dragId = null; this.overLane = null; },
      onDrop: function(laneKey) {
        if (!this.canEdit || this.dragId == null) return;
        var id = this.dragId, self = this;
        var item = (appInstance.currentData || []).find(function(r) { return r.id === id; });
        if (item && String(item[self.laneCol] || '') !== laneKey) appInstance.saveField(item, self.laneCol, laneKey, self.viewName);
        this.onDragEnd();
      },
      // --- mobile / a11y fallback: move via menu ---
      moveTo: function(item, laneKey) { if (this.canEditCard(item) && this.canMoveCards && String(item[this.laneCol] || '') !== laneKey) appInstance.saveField(item, this.laneCol, laneKey, this.viewName); },
      laneMenuItems: function() { var self = this; return this.laneOrder.map(function(k) { return { value: k, title: self.laneLabel(k) }; }); },
      addInLane: function(laneKey) { appInstance.boardAddInLane(this.viewName, laneKey); },
      // Per-card row controls (mirror the grid's row-append buttons): archive files the card to the archive
      // partition (reversible via restore); delete uses the app's armed-confirm (keyed row:<id>) — first click
      // arms for 3s and swaps the icon, the second removes the row.
      archItem: function(item) { if (this.canEditCard(item)) appInstance.archiveRow(item); },
      isDelArmed: function(item) { return appInstance.isArmed('row:' + item.id); },
      delItem: function(item) { if (this.canEditCard(item)) appInstance.deleteRow(item); },
      // Inline card editing: a pencil flips one card into edit mode, where every field except the lane
      // column (that stays a drag/move-menu action, so it honors archiveOn) becomes a shared `data-cell`
      // editor writing back through saveField — the same widgets and persistence as the table grid.
      // Edit mode must be able to set the card's TITLE. The title is deliberately absent from the card
      // FACE (it is the heading), and a schema commonly names it only in `board.title`, never in
      // `columns` — chore_board is exactly that shape. Deriving the editors from `columns` alone then
      // left the title with no editor anywhere on the board, so a card added in a lane could never be
      // given the one field that names it: you got a blank card you could not fill in. It leads, being
      // the card's primary field. The lane column stays out — that is the drag / move-menu action.
      editCols: function() {
        var self = this, title = this.titleCol();
        var cols = (this.view.columns || []).map(colName).filter(function(c) { return typeof c === 'string' && c && c !== self.laneCol; });
        if (title && title !== this.laneCol && cols.indexOf(title) < 0) cols.unshift(title);
        return cols;
      },
      toggleEdit: function(item) { this.editing[item.id] = !this.editing[item.id]; }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="board-view">'
      + '<div v-if="!embed && a.searchable" class="d-flex align-center pa-2 ga-2">'
      +   '<v-text-field v-model="a.searchTerm" data-testid="view-search" density="compact" variant="outlined" hide-details clearable prepend-inner-icon="mdi-magnify" :label="searchLabel" style="max-width:280px"></v-text-field>'
      +   '<span v-if="a.searchCount" class="text-caption text-medium-emphasis" data-testid="search-count">{{ a.searchCount }}</span>'
      + '</div>'
      + '<div v-for="g in groups" :key="g.key">'
      + '  <div v-if="g.label" class="px-3 pt-3 pb-1" style="cursor:pointer;display:flex;align-items:center;gap:6px" @click="toggleGroup(g.key)" :data-testid="\'board-group-\'+g.key">'
      + '    <v-icon size="x-small">{{ collapsed[g.key] ? \'mdi-chevron-right\' : \'mdi-chevron-down\' }}</v-icon>'
      + '    <span style="font-size:0.72rem;font-weight:700;text-transform:uppercase;opacity:0.6">{{ groupLabel(g) }}</span>'
      + '    <span style="font-size:0.72rem;opacity:0.4">{{ g.count }}</span></div>'
      + '  <div v-show="!collapsed[g.key]" class="board-lane-row">'
      + '    <div v-for="lane in g.lanes" :key="lane.key" class="board-lane"'
      + '         :style="overLane===lane.key ? \'outline:2px dashed rgb(var(--v-theme-primary))\' : \'\'"'
      + '         @dragover.prevent="canEdit && (overLane=lane.key)" @dragleave="overLane=null" @drop="onDrop(lane.key)" :data-testid="\'board-lane-\'+lane.key">'
      + '      <div style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:0.85rem;padding:2px 4px 6px">'
      + '        <span>{{ laneLabel(lane.key) }}</span><span style="opacity:0.5;font-weight:400">{{ lane.count }}</span>'
      + '        <template v-if="canAddInLane(lane.key)"><v-spacer></v-spacer>'
      + '        <v-btn icon="mdi-plus" size="x-small" variant="text" density="comfortable" :title="t(\'board.add_in_lane\')" @click="addInLane(lane.key)" :data-testid="\'board-add-\'+lane.key"></v-btn></template>'
      + '      </div>'
      + '      <div v-for="item in lane.items" :key="item.id"'
      + '           :draggable="canEditCard(item) && canMoveCards && !editing[item.id] ? \'true\' : \'false\'" @dragstart="onDragStart(item)" @dragend="onDragEnd"'
      + '           :style="\'background:rgb(var(--v-theme-surface));border:1px solid rgb(var(--v-theme-outline),0.15);border-radius:6px;padding:6px 8px;margin-bottom:6px;cursor:\'+(canEditCard(item) && canMoveCards && !editing[item.id] ?\'grab\':\'default\')+(cardColor(item)?\';border-left:3px solid \'+cardColor(item):\'\')"'
      + '           :data-testid="\'board-card-\'+item.id">'
      + '        <div style="display:flex;align-items:flex-start;gap:4px">'
      + '          <div style="font-weight:600;font-size:0.85rem;flex:1">{{ cardTitle(item) }}</div>'
      + '          <v-btn v-if="canEditCard(item)" :icon="editing[item.id] ? \'mdi-check\' : \'mdi-pencil-outline\'" size="x-small" variant="text" density="comfortable" :color="editing[item.id] ? \'primary\' : undefined" :title="t(\'board.edit\')" @click="toggleEdit(item)" :data-testid="\'board-edit-\'+item.id"></v-btn>'
      + '          <v-btn v-if="canEditCard(item) && hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" density="comfortable" :title="t(\'board.archive\')" @click="archItem(item)" :data-testid="\'board-arch-\'+item.id"></v-btn>'
      + '          <v-btn v-if="canEditCard(item)" :icon="isDelArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" density="comfortable" :color="isDelArmed(item) ? \'error\' : undefined" :title="isDelArmed(item) ? t(\'board.confirm_delete\') : t(\'board.delete\')" @click="delItem(item)" :data-testid="\'board-del-\'+item.id"></v-btn>'
      + '          <v-menu v-if="canEditCard(item) && canMoveCards" v-model="menuOf[item.id]"><template v-slot:activator="{ props }">'
      + '            <v-btn v-bind="props" icon="mdi-dots-vertical" size="x-small" variant="text" density="comfortable" :title="t(\'board.move_to\')" :data-testid="\'board-move-\'+item.id"></v-btn></template>'
      // No heading over the lane list: the menu opens from a button that already carries "move to" as its
      // tooltip, and every item in it is a lane, so the header only restated the question. `board.move_to`
      // stays in use as that tooltip.
      + '            <v-list density="compact">'
      + '            <v-list-item v-for="opt in laneMenuItems()" :key="opt.value" @click="moveTo(item, opt.value)" :active="String(item[laneCol]||\'\')===opt.value">'
      + '              <v-list-item-title>{{ opt.title }}</v-list-item-title></v-list-item></v-list></v-menu>'
      + '        </div>'
      // Field face (both modes): one <v-field> per column — the SAME component v-text-field wraps its
      // input in, so the card gets Vuetify's real notched outline with the field name floated into the
      // gap in the top-left border, identical to the profile fields in Settings. `active` keeps the label
      // floated (there is no focus/blur cycle to float it, and an empty value must still show its name).
      // Only the slot content differs between modes: an editor in edit mode, plain text in read mode.
      // The slot content IS the field's input area, so it has to carry the slot's own props — those
      // supply the `v-field__input` class the outline's height and the label's float offset are measured
      // against. Dropping them collapses the box and pushes the value out through its bottom border.
      + '        <template v-if="editing[item.id]"><v-field v-for="col in editCols()" :key="col" class="field-box" variant="outlined" active :label="t(\'field.\'+col) || col">'
      + '          <template v-slot:default="{ props: fp }"><div v-bind="fp" class="field-box-value"><data-cell :item="item" :col="col" :owner="viewName"></data-cell></div></template></v-field></template>'
      + '        <template v-else><v-field v-for="col in cardCols(item)" :key="col" class="field-box" variant="outlined" active :label="t(\'field.\'+col) || col">'
      + '          <template v-slot:default="{ props: fp }"><div v-bind="fp" class="field-box-value">{{ displayValue(col, item[col]) }}</div></template></v-field></template>'
      + '      </div>'
      + '      <div v-if="!lane.items.length" style="opacity:0.4;font-size:0.78rem;padding:4px">—</div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '</component>'
  });

  app.component('page-view', {
    computed: { a: function() { return appInstance; } },
    template: ''
      + '<v-card variant="outlined" class="pa-4">'
      + '<div v-if="a.canEditPages" class="d-flex align-center mb-2"><v-spacer></v-spacer>'
      + '<v-btn size="small" variant="text" density="comfortable" :icon="a.pageEditing ? \'mdi-eye\' : \'mdi-pencil\'" :title="a.pageEditing ? a.t(\'btn.preview\') : a.t(\'btn.edit\')" @click="a.togglePageEdit()" data-testid="page-edit"></v-btn>'
      + '<v-btn v-if="a.pageEditing" size="small" color="primary" prepend-icon="mdi-content-save" @click="a.savePage()" class="ml-2">{{ a.t(\'btn.save\') }}</v-btn></div>'
      + '<v-textarea v-if="a.pageEditing" :model-value="a.pageEditText" @update:model-value="a.pageEditText = $event" auto-grow variant="outlined" density="compact" placeholder="# Markdown — embed views with {{view:name}} or {{table:name}}"></v-textarea>'
      + '<template v-else v-for="(blk, bi) in a.pageBlocks" :key="bi">'
      + '<div v-if="blk.html" v-html="blk.html"></div>'
      + '<embed-view v-else :type="blk.embedType" :name="blk.embedName" :part="blk.embedPart" :both="blk.embedBoth"></embed-view>'
      + '</template>'
      + '</v-card>'
  });

  // Data view: the largest card (layouts + interleaved embeds + controls). Its markup stays as HTML
  // in the #data-view-tpl in-DOM template (ui.html, refs prefixed with `a.`) to avoid a giant escaped
  // string; the `a` computed returns the root instance so those refs resolve against it. Reads must go
  // through the computed (not setup-return, which can't see the root's data props via Vue's hasOwn).
  app.component('data-view', { computed: { a: function() { return appInstance; } }, template: '#data-view-tpl' });

  // System screens (languages / lists+ref-data / settings). Same registry dispatch + `a` proxy + in-DOM
  // template as data-view, so the top-level render is fully uniform (no more currentTable === '__x').
  app.component('languages-view', { computed: { a: function() { return appInstance; } }, template: '#languages-view-tpl' });
  app.component('lookup-view', { computed: { a: function() { return appInstance; } }, template: '#lookup-view-tpl' });
  app.component('settings-view', { computed: { a: function() { return appInstance; } }, template: '#settings-view-tpl' });

  appInstance = app.mount('#vue-app');
}

function init() {
  var folder = localStorage.getItem('app_folder');
  var savedMode = localStorage.getItem('app_mode');
  var instance = appInstance;
  if (savedMode === 'firebase') {
    instance.mode = 'firebase';
    instance.loading = true;
    instance.startApp();
    return;
  }

  // Browser-local Postgres: backend-local-pglite.js has already started the database and settled the
  // identity by the time it calls init(), so there is no folder to validate and no server to probe.
  if (savedMode === 'pglite') {
    instance.mode = 'pglite';
    instance.loading = true;
    instance.startApp();
    return;
  }

  if (!folder) {
    if (!_mayLocal()) {
      // No dev server can exist on this origin: same outcome as a failed probe, minus the request.
      instance.showSetup = true; instance.loading = false;
    } else {
      fetch(_u('/api/validateFolder'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"id":"local"}' })
        .then(function(r) {
          if (r.ok) { instance.mode = 'local'; instance.showSetup = true; instance.loading = false; }
          else { instance.showSetup = true; instance.loading = false; }
        })
        .catch(function() { instance.showSetup = true; instance.loading = false; });
    }
  } else {
    instance.mode = savedMode || 'local';
    instance.startApp();
  }
}

// createVueApp() and init() called by index.html after all scripts loaded
