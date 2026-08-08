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

// --- Permission "features" model: extracted to /access-features.js (AccessFeatures.*), a pure module
//     over (schema, views) shared with the unit tests. These thin wrappers bind the app's global
//     SCHEMA/VIEWS so every existing call site (grantFeatureChips, selectedFeatures, canAccess, ...)
//     stays unchanged. See access-features.js for the full rationale. ---
function viewRosters(v) { return AccessFeatures.viewRosters(v); }
function viewComputedHelpers(v) { return AccessFeatures.viewComputedHelpers(v); }
function viewHelperTables(v) { return AccessFeatures.viewHelperTables(v); }
function viewTables(v) { return AccessFeatures.viewTables(v); }
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
      themes: {
        light: { colors: { primary: '#4285f4', secondary: '#5cbbf6', surface: '#ffffff', background: '#f5f5f5' } },
        dark: {
          dark: true,
          // Explicit bright text colors + higher emphasis so column text stands out from the dark
          // surface/background (Vuetify's derived defaults rendered too dim against #2a2a2a/#1a1a1a).
          colors: { primary: '#8ab4f8', secondary: '#5cbbf6', surface: '#2a2a2a', background: '#1a1a1a', 'on-surface': '#f1f3f4', 'on-background': '#f1f3f4' },
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
      setupFolderId: '',
      setupMode: 'sheets',
      folderValid: false,
      oauthReady: false,
      currentUserEmail: null,
      serverStorage: '',
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
      firestoreRules: '',
      firebaseConfigInput: localStorage.getItem('firebase_config') || '',
      supabaseUrlInput: '',
      supabaseKeyInput: '',
      oauthClientId: localStorage.getItem('oauth_client_id') || '',
      needsReauth: false,
      setupStep: (function() { var m = localStorage.getItem('app_mode'); return (m === 'sheets' || m === 'crdt' || m === 'firebase' || m === 'supabase') ? m : null; })(),
      mode: 'sheets',
      folderId: '',
      tableMap: {},
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
      settings: { preload_archive: getSetting('preload_archive', true), preload_translations: getSetting('preload_translations', true), _collapseApp: false, _collapseSchema: false, _collapseLists: false },
      appConfig: null,
      saveTimers: {},
      pendingDelete: null,
      pendingDeleteTimer: null,
      currentRefTable: null,
      themeEdit: {},   // admin palette editor: pending {mode: {token: hex}} overrides (applied live, saved to schema.theme)
      schemaData: null,
      pageEditing: false,
      pageEditText: '',
      pageCache: {},
      expandedCard: null,
      listSwitchOverrides: {}, // {itemId_col: true} — tracks which cells are toggled to alt list
    }; },

    computed: {
      appTitle: function() { return this.t('app.title'); },
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
            if (!(v.sources || []).every(function(s) { return allowedTables.indexOf(s) >= 0 || self.canSelfServe(s); })) return false;
            // sourceless rotation views are unlocked by ANY of their rosters — a roster you lack
            // simply renders blank (per-roster access, e.g. team_b coordinator sees team_a empty).
            if (!(v.sources && v.sources.length)) {
              var rosters = viewRosters(v);
              if (rosters.length) return rosters.some(function(t) { return allowedTables.indexOf(t) >= 0; });
            }
            return true;
          }
          if (SCHEMA[id]) return allowedTables.indexOf(id) >= 0 || self.canSelfServe(id);
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
      isDataView: function() {
        var v = VIEWS[this.currentTable];
        return this.currentTable && this.currentTable[0] !== '_' && !(v && (typeof v.markdown === 'string' || v.rotation || v.calendar || v.pivot || v.rsvp || v.board)) && (v || SCHEMA[this.currentTable]);
      },
      isRotationView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.rotation); },
      isCalendarView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.calendar); },
      isPivotView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.pivot); },
      isRsvpView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.rsvp); },
      isBoardView: function() { var v = VIEWS[this.currentTable]; return !!(v && v.board); },
      // Curated palette tokens exposed in the admin theme editor (Vuetify color names + friendly labels).
      themeTokens: function() {
        return [
          { key: 'primary', label: 'Primary' }, { key: 'secondary', label: 'Secondary' },
          { key: 'surface', label: 'Surface' }, { key: 'background', label: 'Background' },
          { key: 'on-surface', label: 'Text' }, { key: 'error', label: 'Error' }, { key: 'success', label: 'Success' }
        ];
      },
      // Single classifier for the current view's kind + the top-level component registry dispatch.
      // Every kind maps to a component in VIEW_KINDS; an unclassified view returns null (nothing renders).
      viewKind: function() {
        var ct = this.currentTable;
        if (ct === '__languages') return 'languages';
        if (ct === '__lookup') return 'lookup';
        if (ct === '__settings') return 'settings';
        if (this.isCalendarView) return 'calendar';
        if (this.isRotationView) return 'rotation';
        if (this.isPivotView) return 'pivot';
        if (this.isRsvpView) return 'rsvp';
        if (this.isBoardView) return 'board';
        if (this.currentPage) return 'page';
        if (this.isDataView) return 'data';
        return null;
      },
      viewComponent: function() { return (window.VIEW_KINDS || {})[this.viewKind] || null; },
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
      isReorderable: function() { var t = this.currentTable; return !!(SCHEMA[t] && SCHEMA[t].reorderable && this.isDataView && !this.viewingArchive && this.canMutateRows); },
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
        return AccessFeatures.readableTables(u.tables) || [];
      },
      // Tables I may WRITE — the 'rw' subset. A read-only grant appears here as absent, which is what
      // turns its views read-only and (on an owner-column table) hands the row back to self-service.
      userWritableTables: function() {
        if (this.selfUnregistered) return [];
        if (this.isAdmin) return null;
        var u = this.currentUserEntry;
        if (!u) return [];
        return AccessFeatures.writableTables(u.tables) || [];
      },
      visibleLists: function() {
        if (this.isAdmin) return this.listsCache;
        // Find tables this user can access
        var u = this.currentUserEntry;
        if (!u) return {};
        var userTables = u.tables === 'all' ? Object.keys(SCHEMA) : (u.tables || []);
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
      hasFirebaseConfig: function() {
        if (window.FIREBASE_CONFIG) return true;
        var s = localStorage.getItem('firebase_config');
        if (!s) return false;
        try { var c = JSON.parse(s); return !!(c && c.apiKey); } catch(e) { return false; }
      },
      shareLink: function() {
        var base = location.origin + location.pathname;
        var mode = localStorage.getItem('app_mode');
        if (mode === 'firebase') {
          var cfg = localStorage.getItem('firebase_config');
          if (!cfg) return base;
          try { var c = JSON.parse(cfg);
            // Only emit d= when authDomain is NOT the default <projectId>.firebaseapp.com (derived on load).
            var d = (c.authDomain && c.authDomain !== c.projectId + '.firebaseapp.com') ? '&d=' + encodeURIComponent(c.authDomain) : '';
            return base + '?mode=firebase&k=' + encodeURIComponent(c.apiKey) + d + '&p=' + encodeURIComponent(c.projectId); }
          catch(e) { return base + '?mode=firebase&config=' + btoa(cfg); } // fallback to full encoding
        }
        if (mode === 'supabase') {
          var sc = localStorage.getItem('supabase_config');
          if (!sc) return base;
          try { var s = JSON.parse(sc);
            return base + '?mode=supabase&url=' + encodeURIComponent(s.url) + '&key=' + encodeURIComponent(s.anonKey); }
          catch (e) { return base; }
        }
        var folder = localStorage.getItem('app_folder');
        var clientId = localStorage.getItem('oauth_client_id');
        var params = '?mode=' + (mode || 'sheets');
        if (folder) params += '&folder=' + folder;
        if (clientId) params += '&clientId=' + clientId;
        return base + params;
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
        var needed = this.visibleCols.length * 130 + 100;
        return needed > (this.windowWidth - 72);
      },
      useListLayout: function() { return this.currentConfig.layout === 'list'; },
      // Add is offered wherever rows may be mutated, INCLUDING the read-only `list` layout: a table can
      // declare layout:'list' as its only presentation, so gating Add on an editable layout would leave
      // such a table with no way to create a row at all. The row lands and saves; it is just not
      // editable from a list (see the `layout` note in SCHEMA.md — use table/card for data entry).
      canAddRows: function() { return this.canMutateRows; },
      isReadonlyView: function() { return !this.currentSelfService && this.viewReadonly(this.currentTable); },
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
        // Filter out embeds whose sources include inaccessible tables
        var allowed = self.userAllowedTables;
        if (allowed) {
          embeds = embeds.filter(function(e) {
            var sources = e.sources || [];
            return sources.every(function(s) { return allowed.indexOf(s) >= 0; });
          });
        }
        return embeds;
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
        var base = view ? (view.sources || []) : [this.currentTable];
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
      canEditLists: function() { return this.isAdmin || this.currentUserRole === 'editor'; },
      // Doc-view bodies are writable by admins/editors (mirrors the _pages__active rule / dev-server
      // gate); viewers get a read-only page with no Edit button instead of a save that would 403.
      canEditPages: function() { return this.isAdmin || this.currentUserRole === 'editor'; },
      visibleCols: function() {
        var self = this;
        if (!this.currentTable) return [];
        var view = VIEWS[this.currentTable];
        var cols;
        if (view) { cols = (view.columns || []).filter(function(c) { return !isEmbed(c) && !isViewEmbed(c); }).map(function(c) { return colName(c); }); }
        else {
          cols = getColumns(this.currentTable).filter(function(c) {
            if (c === 'id') return false;
            var def = SCHEMA[self.currentTable].columns[c];
            return !(def && typeof def === 'object' && def.hidden);
          });
        }
        // hideEmpty (table mode): drop a column when empty across all rows -- view default, overridable per-column via {name, hideEmpty}
        if (!this.useCardLayout && this.sortedData.length) {
          var data = this.sortedData;
          cols = cols.filter(function(c) { return !self.colHideEmpty(c) || data.some(function(r) { return r[c]; }); });
        }
        return cols;
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
      sortedData: function() {
        if (!this.sortCol) return this.currentData.slice();
        var _dep = this.listsCache;   // list-backed order is read through the runtime-bound cache
        return sortByCol(this.currentData, this.sortCol, VIEWS[this.currentTable], this.sortAsc);
      },
      staticTranslationKeys: function() {
        return ['app.title', 'btn.add', 'btn.show_active', 'btn.show_archived', 'btn.more',
         'btn.edit', 'btn.preview', 'btn.save', 'col.switch_list',
         'img.replace', 'img.upload', 'img.remove', 'img.url',
         'msg.saved', 'msg.save_failed', 'msg.upload_failed', 'msg.choose_image', 'msg.image_too_large', 'msg.image_read_failed', 'msg.image_invalid', 'msg.image_process_failed',
         'msg.row_added', 'msg.deleted', 'msg.restored', 'msg.renamed', 'msg.archived', 'msg.copied', 'msg.exported', 'msg.synced', 'msg.sync_failed',
         'msg.load_failed', 'msg.request_failed', 'msg.approve_failed', 'msg.import_complete',
         'msg.group_added', 'msg.item_added', 'msg.translation_saved', 'msg.language_added', 'msg.language_renamed', 'msg.language_exists',
         'msg.sign_in_respond', 'msg.registered_admin', 'msg.invalid_json', 'msg.invalid_color', 'msg.invalid_config', 'msg.paste_hex', 'msg.schema_error',
         'msg.server_error', 'msg.import_blocked', 'msg.import_error', 'msg.palette_applied', 'msg.error', 'msg.locked',
         'pivot.total', 'pivot.empty',
         'board.move_to', 'board.unassigned', 'board.add_in_lane', 'board.edit', 'board.archive', 'board.delete', 'board.confirm_delete',
         'tab.languages', 'tab.lookup', 'tab.settings', 'tab.ref_data', 'tab.lists',
         'field.source', 'field.key', 'field.translation',
         'settings.import_export', 'settings.share', 'settings.export', 'settings.import',
         'settings.reset', 'settings.confirm_reset', 'settings.tabs_nav', 'settings.user_access', 'settings.user_access_title',
         'settings.theme', 'settings.theme_palette', 'settings.theme_reset',   // ui.html calls t() for these; leaving them out hid the Theme labels from the Languages editor, so no language could translate them
         'settings.user_id', 'settings.name', 'settings.role', 'settings.tables', 'settings.tables_view', 'settings.add_user', 'settings.all',
         'role.admin', 'role.editor', 'role.viewer',
         'settings.rotation_anchor', 'settings.rotation_from', 'settings.rotation_periods', 'settings.rotation_every', 'settings.rotation_cycle', 'btn.today', 'btn.reset',
         'cal.today', 'cal.month', 'cal.week', 'cal.list', 'cal.undated', 'cal.no_events', 'cal.items', 'cal.add_on_day',
         'rsvp.date', 'rsvp.title', 'rsvp.your_response', 'rsvp.responses', 'rsvp.who', 'rsvp.none',
         'access.request_access', 'access.request_sent', 'access.your_name', 'access.pending_requests', 'access.approve', 'access.deny', 'access.name_required',
         'profile.title', 'profile.email', 'profile.your_name', 'profile.share_name', 'profile.picture',
         'period.this_week', 'period.weeks_ago', 'period.current',
         'list.link_user', 'list.unlink_user',
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
          if (lists[name]) { lists[name].forEach(function(val) { keys.push('list.' + name + '.' + val); }); return; }
          // A lookup/ref TABLE name is also accepted: expose the distinct values across its non-system columns
          // so a 2-D ref lane (its group + value dimensions) is fully translatable via the same list.<name>.<value> keys.
          if (SCHEMA[name]) {
            var rcols = SCHEMA[name].columns || {}, seenv = {};
            (dc[name] || []).forEach(function(r) { for (var c in r) { if (_untranslatableCol(rcols, c)) continue; var v = r[c]; if (v && !seenv[v]) { seenv[v] = 1; keys.push('list.' + name + '.' + v); } } });
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
      tOr: function(key, fallback) { return this.strings[key] || fallback; }, // translated label or a built-in English default

      toggleTheme: function() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        this.$vuetify.theme.global.name = this.theme;
        localStorage.setItem('app_theme', this.theme);
        this._updateManifest();
      },

      notify: function(text) { this.snackText = text; this.snackbar = true; },
      setNavLayout: function(v) { this.navLayoutOverride = v; localStorage.setItem('app_nav_layout', v); },

      // Setup
      validateFolder: function() {
        var self = this;
        if (this.setupFolderId.length > 10) {
          backend.validateFolder(this.setupFolderId).then(function() { self.folderValid = true; }).catch(function() { self.folderValid = false; });
        }
      },
      completeLocalSetup: function() {
        localStorage.setItem('app_folder', 'local');
        localStorage.setItem('app_mode', 'local');
        this.folderId = 'local'; this.mode = 'local';
        this.showSetup = false;
        this.startApp();
      },
      openCrdtLocalSetup: function() {
        var self = this;
        this.setupStep = 'crdt-local';
        fetch(_u('/api/serverInfo')).then(function(r) { return r.json(); }).then(function(d) { self.serverStorage = d.storage; }).catch(function() {});
      },
      backToSetup: function() {
        this.setupStep = null;
        try { localStorage.removeItem('app_mode'); } catch (e) {}
      },
      completeCrdtLocalSetup: function() {
        localStorage.setItem('app_folder', 'local');
        localStorage.setItem('app_mode', 'crdt-local');
        this.folderId = 'local'; this.mode = 'crdt-local';
        this.showSetup = false;
        this.startApp();
      },
      completeSetup: function() {
        var self = this;
        localStorage.setItem('app_folder', this.setupFolderId);
        localStorage.setItem('app_mode', this.setupMode);
        this.folderId = this.setupFolderId; this.mode = this.setupMode;
        backend.setFolderConfig(this.folderId, Object.assign({}, self.appConfig || {}, { mode: this.mode })).then(function() {
          self.showSetup = false; self.startApp();
        });
      },

      // Boot
      startApp: function() {
        var self = this;
        self.loading = true;

        // Load schema from backend, fall back to default
        var schemaPromise;
        if (backend.getSchema && !backend.bootData) {
          schemaPromise = backend.getSchema(self.folderId).then(function(s) {
            if (s) {
              var parsed = typeof s === 'string' ? JSON.parse(s) : s;
              _normalizeSchema(parsed);
              self.schemaData = Object.freeze(parsed);
              self._tableOrder = Object.keys(parsed.tables || {});
              var schemaErrors = validateSchema();
              if (schemaErrors.length) { console.warn('Schema errors:', schemaErrors); self.notify(self.t('msg.schema_error') + ' ' + schemaErrors[0]); }
            } else {
              // First time: save default schema to Drive
              if (backend.saveSchema) backend.saveSchema(self.folderId, defaultSchema);
              self.schemaData = Object.freeze(defaultSchema);
            }
          });
        } else {
          schemaPromise = Promise.resolve().then(function() { self.schemaData = Object.freeze(defaultSchema); });
        }

        // Load app-wide folder config (holds the global rotationAnchor) before rendering rotations.
        schemaPromise = schemaPromise.then(function() {
          if (!backend.getFolderConfig) return;
          return Promise.resolve(backend.getFolderConfig(self.folderId)).then(function(cfg) {
            self.appConfig = cfg || {};
          }).catch(function() {});
        });

        schemaPromise.then(function() {
        // Fast path: single batch call (Apps Script)
        if (backend.bootData) {
          backend.bootData(self.folderId).then(function(result) {
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
              // First boot: save bundled default schema to Drive
              self.schemaData = Object.freeze(defaultSchema);
              backend.saveSchema(self.folderId, defaultSchema);
            }
            self.tableMap = result.tableMap || {};
            self.languages = result.languages || [];
            self.listsCache = result.lists || {}; window._listsCache = self.listsCache;
            self.loadListAvatars(); self.loadListUserLinks(); self.loadMyListValues();   // avatars + admin editor links + my own @me identity
            // Auto-seed lists (create missing list names + seed mandatory filter values): admin-only
            // maintenance. A restricted user's listsCache is already scoped to their own tables
            // server-side; seeding+saving here would add entries for tables they don't own, and
            // saveLists's batch write would then be denied wholesale (Firestore batches are atomic --
            // one disallowed doc fails the lot). result.unrestricted is only ever explicitly false
            // for a scoped Firebase user; other backends don't set it, so they keep seeding as before.
            if (result.unrestricted !== false && self._seedSchemaLists()) backend.saveLists(self.folderId, self.listsCache);
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
            return backend.getTranslations(self.folderId, defCode).then(function(baseTrans) {
              self.strings = baseTrans || {};
              // A remembered code can outlive its language too (a rename, or a different database on the
              // same origin), so validate it against the list rather than trusting localStorage.
              var saved = localStorage.getItem('app_lang');
              if (!self.languages.some(function(l) { return l.code === saved; })) saved = defCode;
              self.currentLang = saved;
              if (saved !== defCode) {
                return backend.getTranslations(self.folderId, saved).then(function(trans) {
                  if (trans) self.strings = Object.assign({}, self.strings, trans);
                });
              }
            });
          }).then(function() {
            self.loadUsers();
          }).catch(function(err) {
            self.loading = false;
            self.notify(err && err.message ? err.message : self.t('msg.load_failed'));
          });
          return;
        }

        // Sequential path (local server / OAuth)
        backend.initSchema(self.folderId, SCHEMA).then(function(schemaResult) {
          self.tableMap = {};
          if (schemaResult) { Object.keys(schemaResult).forEach(function(n) { self.tableMap[n] = schemaResult[n]; }); }
          else { Object.keys(SCHEMA).forEach(function(n) { self.tableMap[n] = n; }); }

          return backend.getAvailableLanguages(self.folderId);
        }).then(function(langs) {
          self.languages = langs || [];
          if (self.languages.length === 0) {
            return Promise.resolve();
          }
          // Load default language as base strings
          var defCode = self.defaultLanguage;
          return backend.getTranslations(self.folderId, defCode).then(function(baseTrans) {
            self.strings = baseTrans || {};
            // Same validation as the bootData path above: a stale app_lang must not select a language
            // that no longer exists.
            var saved = localStorage.getItem('app_lang');
            if (!self.languages.some(function(l) { return l.code === saved; })) saved = defCode;
            self.currentLang = saved;
            if (saved !== defCode) {
              return backend.getTranslations(self.folderId, saved).then(function(trans) {
                if (trans) self.strings = Object.assign({}, self.strings, trans);
              });
            }
          });
        }).then(function() {
          // Preload lists + auto-seed (shared with the bootData path via _seedSchemaLists)
          return backend.getLists(self.folderId).then(function(lists) {
            self.listsCache = lists || {}; window._listsCache = self.listsCache;
            if (self._seedSchemaLists()) backend.saveLists(self.folderId, self.listsCache);
            self.loadListAvatars(); self.loadListUserLinks(); self.loadMyListValues();   // avatars + admin editor links + my own @me identity
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
          // Preload data -- only tables user can access
          var tables = Object.keys(self.tableMap);
          var allowed = self.userAllowedTables;
          if (allowed) tables = tables.filter(function(t) { return allowed.indexOf(t) >= 0; });
          var chain = Promise.resolve();
          tables.forEach(function(name) {
            chain = chain.then(function() {
              return backend.getTableData(self.tableMap[name], 'active').then(function(result) {
                self.dataCache[name] = parseTableResult(result).rows;
              }).catch(function() { self.dataCache[name] = []; });
            });
            if (self.settings.preload_archive && SCHEMA[name] && SCHEMA[name].archivable) {
              chain = chain.then(function() {
                return backend.getTableData(self.tableMap[name], 'archive').then(function(result) {
                  self.dataCache[aKey(name)] = parseTableResult(result).rows;
                }).catch(function() { self.dataCache[aKey(name)] = []; });
              });
            }
          });
          return chain;
        }).then(function() {
          self.loading = false;
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
        if (this.mobile) this.drawerOpen = false;
        this.editingLang = null;
        this.currentRefTable = null;
        this.viewingArchive = false;
        this.pageEditing = false;
        var cfg = VIEWS[id] || SCHEMA[id] || {};
        this.sortCol = cfg.defaultSort || null;
        this.sortAsc = true;
        if (this.isCalendarView || this.isPivotView || this.isRsvpView) { this.loadTableData(); }
        else if (this.isDataView || this.isRotationView || this.isBoardView) { this.periodOffset = 0; this.loadTableData(); }
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
      hashColor: function(key) { return Calendar.hashColor(key); },
      // Resolve a calendar view's source specs / rotation overlays (pure over VIEWS -> calendar.js).
      calSources: function(name) { return Calendar.sources(VIEWS, name); },
      // Day-add is only offered when the calendar has exactly ONE source carrying a date column: a
      // multi-source calendar has no unambiguous table to add the row to. Write access is checked
      // across the whole mirror cluster, as addRow writes to all of it.
      canCalendarAdd: function(name) {
        var srcs = this.calSources(name);
        if (srcs.length !== 1) return false;
        var s = srcs[0];
        if (!s || !s.table || !s.dateColumn || !SCHEMA[s.table]) return false;
        if (this.viewReadonly(name)) return false;
        var allowed = this.userWritableTables;   // adding an event is a WRITE to the source table
        if (!allowed) return true;
        return withMirrors([s.table]).every(function(t) { return allowed.indexOf(t) >= 0; });
      },
      // Create a row on `date` in that single source, then land on the source table. The calendar's
      // day panel is read-only (cal-event-row renders, never edits), so adding in place would strand
      // a blank row the user cannot fill in; the table is where it becomes editable.
      calendarAddOnDay: function(name, date) {
        if (!date || !this.canCalendarAdd(name)) return;
        var s = this.calSources(name)[0], prefill = {};
        prefill[s.dateColumn] = date;                   // the point: prefill the clicked day
        this._createBlankRow(s.table, { prefill: prefill });
        this.selectTab(s.table);
        this.notify(this.t('msg.row_added'));
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
      // Periods to generate from `fromStr` (the rotation view's OWN start) to reach `toExclusive`. We
      // start from the rotation's own `from` — not the grid start — so the numeric slot-swap phase
      // (floor(i/n)) matches the rotation view exactly (single source of truth); events are then
      // clipped to the window. 0 when the window ends before the rotation begins.
      _periodsToCover: function(fromStr, toExclusive, interval) {
        var n = wholeIntervalsBetween(fromStr, toExclusive, interval);
        return n < 0 ? 0 : n + 2;
      },
      // Build the { 'YYYY-MM-DD': [events] } map for a calendar view. Undated rows -> '__undated__'.
      // Fail-closed per source: a table the user cannot read contributes nothing. When `window` is
      // given, rotationSources' generated duties are added (bounded to that window).
      calEventsFor: function(name, window) {
        var self = this, out = {}, allowed = this.userAllowedTables;
        this.calSources(name).forEach(function(s) {
          if (!s || !s.table || !s.dateColumn) return;
          if (allowed && allowed.indexOf(s.table) < 0) return;
          var rows = filterRows(self.dataCache[s.table] || [], self.resolveMeTokens(s.filter));
          var tag = s.label || self.t('tab.' + s.table);
          rows.forEach(function(r) {
            var title = (s.titleColumns || []).map(function(c) { return self.displayValue(c, r[c]); }).filter(Boolean).join(' — ');
            var ev = { id: s.table + ':' + s.dateColumn + ':' + r.id, title: title || tag, label: tag, color: self.hashColor(s.label || s.table), table: s.table, dateCol: s.dateColumn, row: r };
            var d = toDateStr(r[s.dateColumn]);
            var key = d || '__undated__';
            (out[key] = out[key] || []).push(ev);
          });
        });
        // Rotation sources -> generated read-only duty events, bounded to the visible window.
        if (window) this.calRotationSources(name).forEach(function(rs) {
          var v = VIEWS[rs.view]; if (!v || !v.rotation) return;
          var rv = v.rotation, rosters = rv.rosters || [];
          if (allowed && rosters.length && !rosters.some(function(t) { return allowed.indexOf(t) >= 0; })) return; // per-roster access (fail-closed)
          var range = self.rangeForView(rs.view);
          var fromStr = (!range.from || range.from === 'today') ? self._calToday() : range.from;
          var interval = rv.interval || 'weekly';
          var periods = self._periodsToCover(fromStr, window.toExclusive, interval);
          if (!periods) return;
          var rows = buildRotationViewRows(v, self.dataCache, self._calToday(), self.anchorForView(rs.view), { from: fromStr, periods: Math.min(periods, 520) }, self.rotateEveryForView(rs.view));
          var slots = rv.slots || [], tag = rs.label || self.tOr('tab.' + rs.view, rs.view);
          rows.forEach(function(r) {
            if (r._period < window.from || r._period >= window.toExclusive) return; // clip to visible grid
            slots.forEach(function(slot) {
              var ppl = r[slot]; if (!(ppl && ppl.length)) return;
              var title = self.tOr('field.' + slot, slot) + ': ' + self.displayValue(slot, ppl);
              (out[r._period] = out[r._period] || []).push({ id: 'rot:' + rs.view + ':' + slot + ':' + r._period, title: title, label: tag, color: self.hashColor(rs.label || rs.view), table: null, readOnly: true, row: r });
            });
          });
        });
        Object.keys(out).forEach(function(k) { out[k].sort(function(a, b) { return (a.label + a.title).localeCompare(b.label + b.title); }); });
        return out;
      },
      isCalendarName: function(name) { return !!(VIEWS[name] && VIEWS[name].calendar); },
      isRotationName: function(name) { return !!(VIEWS[name] && VIEWS[name].rotation); },
      isPivotName: function(name) { return !!(VIEWS[name] && VIEWS[name].pivot); },
      // Build a pivot view's grid: resolve its source (a table or view) through the embed row pipeline
      // (so filters/aggregates/computed columns apply), then Pivot.build cross-tabs it. Pure module +
      // thin root wrapper, like calEventsFor / rotationRowsFor.
      pivotFor: function(name) {
        var v = VIEWS[name]; if (!v || !v.pivot) return { columns: [], rows: [] };
        var p = v.pivot, src = p.source;
        var rows = VIEWS[src] ? this.embedRows('view', src) : (this.dataCache[src] || []);
        return Pivot.build(rows, p);
      },
      isRsvpName: function(name) { return !!(VIEWS[name] && VIEWS[name].rsvp); },
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
          if (mine) { var mi = rows.indexOf(mine); if (mi >= 0) rows.splice(mi, 1); backend.deleteRow(this.tableMap[table], mine.id, 'active'); }
          return;
        }
        if (mine) {
          mine[cfg.statusColumn] = status; mine.rosterPublic = pub; mine.updated_at = new Date().toISOString();
          backend.putRow(this.tableMap[table], mine, 'active');
        } else {
          var row = { id: this.generateId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          getColumns(table).forEach(function(c) { if (!(c in row)) row[c] = ''; });
          row[ownerCol] = me; row[linkColumn] = eventKey; row[cfg.statusColumn] = status; row.rosterPublic = pub;
          rows.push(row);
          backend.putRow(this.tableMap[table], row, 'active');
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
      loadPage: function(name) {
        var self = this;
        var seed = function() { return (VIEWS[name] && VIEWS[name].markdown) || ''; };
        // Prefer a single-page read (backend.getPage) so per-page access can restrict it -- a
        // whole-collection read is denied wholesale once any page is restricted (rules aren't filters).
        // Backends without getPage (Sheets/CRDT/local) fall back to the collection read.
        if (backend.getPage) {
          Promise.resolve(backend.getPage(name)).then(function(p) {
            self.pageCache[name] = (p && p.markdown != null) ? p.markdown : seed();
          }).catch(function() { self.pageCache[name] = seed(); });
          return;
        }
        Promise.resolve(backend.getTableData('_pages', 'active')).then(function(d) {
          var row = (d && d.rows || []).find(function(r) { return r.id === name; });
          self.pageCache[name] = row ? row.markdown : seed();
        }).catch(function() {});
      },
      // Embed resolution lives in /embeds.js (pure over this ctx). The root keeps same-named thin
      // wrappers so components/templates/tests are unchanged; only root-state reads cross this seam.
      _embedCtx: function() {
        var self = this;
        return {
          views: VIEWS, schema: SCHEMA, getColumns: getColumns,
          dataCache: this.dataCache, currentTable: this.currentTable,
          t: function(k) { return self.t(k); },
          viewWithMe: function(v) { return self._viewWithMe(v); },
          anchorForView: function(n) { return self.anchorForView(n); },
          rotationRowsFor: function(n, rv) { return self.rotationRowsFor(n, rv); }
        };
      },
      buildEmbedBlock: function(type, name, part) { return Embeds.buildEmbedBlock(type, name, part, this._embedCtx()); },
      mdBlocks: function(markdown, selfName) { return Embeds.mdBlocks(markdown, selfName, this._embedCtx()); },
      docHasData: function(markdown, selfName) { return Embeds.docHasData(markdown, selfName, this._embedCtx()); },
      resolveEmbed: function(cfg) { return Embeds.resolveEmbed(cfg, this._embedCtx()); },
      embedCols: function(type, name) { return Embeds.embedCols(type, name, this._embedCtx()); },
      embedRows: function(type, name, part) { return Embeds.embedRows(type, name, part, this._embedCtx()); },
      embedHideEmpty: function(type, name) { var c = type === 'view' ? VIEWS[name] : SCHEMA[name]; return !!(c && c.hideEmpty); },
      embedViewLayout: function(type, name) { var c = type === 'view' ? VIEWS[name] : SCHEMA[name]; return (c && c.layout) || 'table'; },
      embedRowsForItem: function(ei, item) { return Embeds.embedRowsForItem(ei, item); },
      embedWhenOk: function(ei, item) { return Embeds.embedWhenOk(ei, item); },
      embedVisible: function(ei, item) { return Embeds.embedVisible(ei, item); },
      // Embed row controls — operate on the active partition across the mirror cluster (dataCache is reactive)
      embedSources: function(type, name) { return type === 'view' && VIEWS[name] ? (VIEWS[name].sources || []) : [name]; },
      canMutateEmbed: function(type, name) {
        if (this.viewReadonly(name)) return false;
        var allowed = this.userWritableTables;   // embed row controls mutate the embedded tables
        if (!allowed) return true;
        return withMirrors(this.embedSources(type, name)).every(function(t) { return allowed.indexOf(t) >= 0; });
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
        if (backend.putRow) backend.putRow('_pages', { id: name, markdown: this.pageEditText }, 'active');
        this.pageEditing = false;
        this.notify(this.t('msg.saved'));
      },

      // Ensure every schema-referenced list exists (both `list` and `listSwitch.list`), then seed
      // mandatory filter values. Returns true when a filter VALUE was seeded (callers persist via
      // saveLists then). One implementation for the bootData and sequential boot paths — they had
      // drifted into two hand-copied blocks (one with a leftover implicit global).
      _seedSchemaLists: function() {
        var lists = this.listsCache;
        Object.keys(SCHEMA).forEach(function(t) {
          Object.keys(SCHEMA[t].columns).forEach(function(c) {
            var def = SCHEMA[t].columns[c];
            if (def && typeof def === 'object' && def.list && !lists[def.list]) lists[def.list] = [];
            if (def && typeof def === 'object' && def.listSwitch && def.listSwitch.list && !lists[def.listSwitch.list]) lists[def.listSwitch.list] = [];
          });
        });
        return _seedListValues(lists);
      },

      // Load each table's active partition into dataCache unless already cached or outside the user's
      // grants (fail-closed: a denied/failed read contributes an empty cache entry, never an error).
      // `onLoad` (optional) runs after each table lands — used by views that must re-derive rows.
      // One implementation for the calendar/rotation/pivot/rsvp preload blocks in loadTableData.
      _ensureCached: function(tables, onLoad) {
        var self = this, allowed = this.userAllowedTables;
        (tables || []).forEach(function(tbl) {
          // Reachable = granted OR self-serviceable (owner-column table: the backend returns only the
          // member's own rows) — same reachability the sidebar's canAccess uses, so an rsvp view's
          // responses table loads for a no-grant member instead of silently staying empty.
          if (!tbl || self.dataCache[tbl] || (allowed && allowed.indexOf(tbl) < 0 && !self.canSelfServe(tbl))) return;
          backend.getTableData(self.tableMap[tbl], 'active').then(function(result) {
            self.dataCache[tbl] = parseTableResult(result).rows;
            if (onLoad) onLoad(tbl);
          }).catch(function() { self.dataCache[tbl] = self.dataCache[tbl] || []; });
        });
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
              var rvv = VIEWS[rs.view] && VIEWS[rs.view].rotation;
              ((rvv && rvv.rosters) || []).forEach(function(tbl) { if (tbl && calTables.indexOf(tbl) < 0) calTables.push(tbl); });
            });
            self._ensureCached(calTables);
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
            self._ensureCached(rvDef.rosters ? rvDef.rosters.slice() : (rvDef.columns || []).map(function(c) { return c.rotationTable; }), regen);
            return;
          }
          // Pivot view: cross-tab of a source table/view. Load the source's table(s) into the reactive
          // dataCache; pivotFor() (read by the component) then builds the grid and re-derives on load.
          if (view.pivot) {
            self._ensureCached(VIEWS[view.pivot.source] ? (VIEWS[view.pivot.source].sources || []) : [view.pivot.source]);
            return;
          }
          // RSVP view: load the events + responses tables; rsvpFor() builds the list, re-derives on load.
          if (view.rsvp) {
            var rsTables = (VIEWS[view.rsvp.events] ? (VIEWS[view.rsvp.events].sources || []) : [view.rsvp.events]).slice();
            if (view.rsvp.responses) rsTables.push(view.rsvp.responses);
            self._ensureCached(rsTables);
            return;
          }
          // Union or join view
          var cache = self.dataCache;
          if (self.viewingArchive) {
            cache = {};
            view.sources.forEach(function(src) { cache[src] = self.dataCache[aKey(src)] || []; });
          }
          var vMe = self._viewWithMe(view);
          // Interactive ‹ › period navigation: inject the current back-offset into bare @period tokens.
          if (view.period && self.periodOffset) {
            vMe = Object.assign({}, vMe);
            if (vMe.filter) vMe.filter = self.resolvePeriodTokens(vMe.filter, self.periodOffset);
            if (vMe.groupBy) { vMe.groupBy = Object.assign({}, vMe.groupBy); if (vMe.groupBy.filter) vMe.groupBy.filter = self.resolvePeriodTokens(vMe.groupBy.filter, self.periodOffset); }
          }
          var srcRows = buildRows(vMe, cache);
          // Resolve source-row computeds (e.g. a per-row lookup) BEFORE grouping so an aggregate can sum them.
          if (view.compute) srcRows = resolveComputed(srcRows, view.compute, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          var rows = resolveComputed(aggregateRows(vMe, srcRows), view.columns, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          self.currentData = rows;
          // Load embed table data if not cached
          var allowed = self.userAllowedTables;
          (view.columns || []).forEach(function(c) {
            var embedSources = [];
            if (isEmbed(c)) { embedSources = c.sources || []; }
            else if (isViewEmbed(c) && VIEWS[c.view]) {
              embedSources = VIEWS[c.view].sources || [];
              // rotationView embed: its rosters aren't in `sources` — preload them so the embed resolves
              var erv = VIEWS[c.view].rotation;
              if (erv) embedSources = embedSources.concat(erv.rosters || (erv.columns || []).map(function(rc) { return rc.rotationTable; }));
            }
            embedSources.forEach(function(tbl) {
              if (allowed && allowed.indexOf(tbl) < 0) return;
              if (tbl && !self.dataCache[tbl]) {
                var embedTab = 'active';
                backend.getTableData(self.tableMap[tbl], embedTab).then(function(result) {
                  self.dataCache[tbl] = parseTableResult(result).rows;
                });
              }
            });
          });
          // Preload rotation-column dependencies (rotationTable + occurrenceSource), then recompute.
          // The occurrenceSource ARCHIVE partition is also loaded so the occurrence rank stays absolute
          // (archived turns still count) even when preload_archive is off — see resolveComputed.
          var recomputeRotation = function() {
            var vMe2 = self._viewWithMe(view);
            var src2 = buildRows(vMe2, self.dataCache);
            if (view.compute) src2 = resolveComputed(src2, view.compute, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
            self.currentData = resolveComputed(aggregateRows(vMe2, src2), view.columns, { dataCache: self.dataCache, rotationAnchor: self.anchorForView(self.currentTable) });
          };
          (view.columns || []).forEach(function(c) {
            if (!c || typeof c !== 'object' || !c.computed || !c.computed.rotationTable) return;
            var comp = c.computed;
            var deps = [{ table: comp.rotationTable, part: 'active', key: comp.rotationTable }, { table: comp.occurrenceSource, part: 'active', key: comp.occurrenceSource }];
            if (comp.occurrenceSource) deps.push({ table: comp.occurrenceSource, part: 'archive', key: aKey(comp.occurrenceSource) });
            deps.forEach(function(dep) {
              if (!dep.table || (allowed && allowed.indexOf(dep.table) < 0) || self.dataCache[dep.key]) return;
              backend.getTableData(self.tableMap[dep.table], dep.part).then(function(result) {
                self.dataCache[dep.key] = parseTableResult(result).rows;
                recomputeRotation();
              }).catch(function() { self.dataCache[dep.key] = self.dataCache[dep.key] || []; });
            });
          });
        } else {
          var key = self.viewingArchive ? aKey(self.currentTable) : self.currentTable;
          var tableDef = SCHEMA[self.currentTable];
          if (!tableDef) return;
          if (!self.dataCache[key]) {
            var tab = self.viewingArchive ? 'archive' : 'active';
            backend.getTableData(self.tableMap[self.currentTable], tab).then(function(result) {
              self.dataCache[key] = parseTableResult(result).rows;
              var rows = self.dataCache[key];
              if (tableDef.filter) rows = filterRows(rows, tableDef.filter);
              self.currentData = rows;
            });
          } else {
            var rows = self.dataCache[key];
            if (tableDef.filter) rows = filterRows(rows, tableDef.filter);
            self.currentData = rows;
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
        if (cached) {
          var cr = cached.find(function(r) { return r.id === item.id; });
          if (cr) { cr[col] = value; cr.updated_at = item.updated_at; }
          else {
            // Row doesn't exist in this table's cache — create it
            var newRow = { id: item.id, created_at: item.created_at || new Date().toISOString(), updated_at: item.updated_at };
            getColumns(source).forEach(function(c) { newRow[c] = (c === col) ? value : (item[c] || ''); });
            cached.push(newRow);
          }
        }
        // Save — only send columns owned by the target table
        var timerKey = source + ':' + item.id + ':' + col;
        clearTimeout((self.saveTimers || {})[timerKey]);
        if (!self.saveTimers) self.saveTimers = {};
        self.saveTimers[timerKey] = setTimeout(function() {
          var row = {};
          getColumns(source).forEach(function(c) { row[c] = item[c] || ''; });
          row.id = item.id;
          row[col] = value;
          row.updated_at = new Date().toISOString();
          if (!row.created_at) row.created_at = new Date().toISOString();
          backend.putRow(self.tableMap[source], row, tab);
          // Propagate to mirror tables if this column is mirrored
          self.propagateMirror(item.id, source, row);
          self.notify(self.t('msg.saved'));
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
          // `defaultFrom` columns seed themselves on create and stay editable after (unlike owner).
          getDefaultCols(src).forEach(function(dc) {
            if (cols.indexOf(dc.name) >= 0) row[dc.name] = self.defaultFromValue(dc.from, dc.name);
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
          backend.putRow(self.tableMap[src], row, tab);
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
          var cached = self.dataCache[aKey(source)] || [];
          var srcRow = cached.find(function(r) { return r.id === item.id; });
          if (!srcRow) return;
          self.dataCache[aKey(source)] = cached.filter(function(r) { return r.id !== item.id; });
          if (!self.dataCache[source]) self.dataCache[source] = [];
          self.dataCache[source].push(srcRow);
          backend.moveRow(self.tableMap[source], srcRow, 'archive', 'active');
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
      getListOptions: function(col, altList) {
        var self = this;
        var listName = altList || this.colIsList(col);
        var items = listName && this.listsCache[listName] ? this.listsCache[listName] : [];
        var result = items.map(function(v) {
          var translated = self.t('list.' + listName + '.' + v);
          return { title: translated !== ('list.' + listName + '.' + v) ? translated : v, value: v };
        });
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
      displayValue: function(col, val) {
        if (Array.isArray(val)) { var self = this; return val.map(function(x) { return self.displayValue(col, x); }).filter(Boolean).join(', '); }
        if (!val) return '';
        var out = val;
        // Translation namespace: a list column uses its list name; a `ref` column uses its lookup TABLE name,
        // so ref-backed values (e.g. a board's 2-D ref lane and its group dimension) localize through the same
        // `list.<ns>.<value>` keys as list values do. Either way it falls back to the raw value.
        var ns = this.listNameForCol(col);
        if (!ns && this.colIsRef(col)) { var rf = this.colRef(col); ns = rf && rf.table; }
        if (ns) {
          var key = 'list.' + ns + '.' + val;
          var translated = this.t(key);
          out = translated !== key ? translated : val;
        }
        return this.shouldObscure(col) ? obscureName(out) : out;
      },
      // Whether the CURRENT view obscures person names in `col`. obscureNames: true = all list/multiselect
      // columns (or all area columns for a rotationView); an array = exactly those columns. Display-only.
      shouldObscure: function(col) {
        var v = VIEWS[this.currentTable];
        if (!v || !v.obscureNames) return false;
        if (Array.isArray(v.obscureNames)) return v.obscureNames.indexOf(col) >= 0;
        if (v.rotation) { var rv = v.rotation; var areas = rv.slots || (rv.columns || []).map(function(c) { return c.name; }); return areas.indexOf(col) >= 0; }
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
      isReadonlyRefCell: function(item, col) { return this.isLockedRefValue(item && item[col]); },
      // Whether a plain list is opted into `translatableLists` (its values have list.<list>.<value> labels).
      // Used only to show the translate badge in the Lists editor — values stay editable unless filter-pinned.
      isTranslatableList: function(name) { return (((this.schemaData && this.schemaData.translatableLists) || []).indexOf(name) >= 0); },
      colAllowNew: function(col) { return Columns.colAllowNew(SCHEMA, col); },
      colIsSorted: function(col) { return Columns.colIsSorted(SCHEMA, col); },
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
        var self = this, vals = Array.isArray(value) ? value : [value];
        vals.forEach(function(v) {
          if (v && self.listsCache[listName].indexOf(v) === -1) {
            self.listsCache[listName].push(v);
            backend.putListItem(self.folderId, listName, v);
          }
        });
      },

      colIsRef: function(col) { return Columns.colIsRef(SCHEMA, col); },
      // The `ref` config for a column, found across whichever table declares it (columns aren't view-scoped).
      // Shared by displayValue's ref-translation namespace and the board's 2-D ref lane grouping.
      colRef: function(col) { for (var t in SCHEMA) { var r = getColumnRef(t, col); if (r) return r; } return null; },
      colIsMirrorForTable: function(col) {
        var table = this.currentTable;
        if (VIEWS[table]) return false;
        return colIsMirror(SCHEMA, col, table);
      },
      isReadonlyCell: function(item, col, ownerId) {
        ownerId = ownerId || this.currentTable;
        var view = VIEWS && VIEWS[ownerId];
        // Resolve the underlying table for this row/column (union rows carry _source)
        var table = (view && view.mode === 'union' && item._source) ? item._source : ownerId;
        // syncFrom (mirror) columns are synced from a master -> read-only in the detail table
        if (table && SCHEMA[table] && colIsMirror(SCHEMA, col, table)) return true;
        // owner columns are auto-stamped with the current user's email and immutable
        if (table && getColumnType(table, col) === 'owner') return true;
        // In union views, grey out columns that don't belong to the row's source table
        if (!view || view.mode !== 'union' || !item._source) return false;
        return !(SCHEMA[item._source] && SCHEMA[item._source].columns && SCHEMA[item._source].columns[col]);
      },
      // Is a view/table read-only as a whole (config flag, viewer role, aggregate, or a read-only grant)
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
        var v = VIEWS[id];
        var base = v ? (v.sources || []) : (SCHEMA[id] ? [id] : []);
        if (!base.length) return true;                    // sourceless (rotation/calendar): nothing to write
        return withMirrors(base).every(function(t) { return writable.indexOf(t) >= 0; });
      },
      // Shared gate for whether a data cell renders read-only (ownerId defaults to currentTable).
      // On a self-service table the viewer-role blanket-readonly yields to per-row ownership: I may edit
      // MY rows, others stay read-only (owner/mirror/union-foreign columns are always read-only).
      cellReadonly: function(item, col, ownerId) {
        if (this.isReadonlyCell(item, col, ownerId)) return true;
        if (this.currentSelfService && (!ownerId || ownerId === this.currentTable)) return !this.rowOwnedByMe(item, this.selfServeTable);
        return this.viewReadonly(ownerId || this.currentTable);
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
      // Resolve a column's `defaultFrom` token to the value stamped on a new row. Unknown tokens stamp
      // blank rather than writing the token text, so a typo can't end up looking like data.
      defaultFromValue: function(token, col) { return token === '@me' ? this.meValueFor(col) : ''; },
      // Row belongs to the current user (its owner column equals my email, case-insensitive).
      rowOwnedByMe: function(item, table) {
        var oc = getOwnerCol(table);
        return !!oc && String((item && item[oc]) || '').toLowerCase() === this.myEmailLc;
      },
      // Per-row mutate gate for the row-control column: normal tables defer to canMutateRows (table-level);
      // a self-service table restricts delete/archive to my own rows.
      canMutateRow: function(item) { return !this.currentSelfService || this.rowOwnedByMe(item, this.selfServeTable); },
      getRefOptions: function(col, item) {
        var ref = null;
        for (var t in SCHEMA) { ref = getColumnRef(t, col); if (ref) break; }
        if (!ref) return [];
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
            var title = counts[v] > 1 ? v + ' (' + r[parentCol] + ')' : v;
            items.push({ title: title, value: v });
          });
          return items;
        }
        var seen = {};
        var opts = [];
        rows.forEach(function(r) {
          var v = r[valueCol];
          if (v && !seen[v]) { seen[v] = true; opts.push({ title: v, value: v }); }
        });
        return opts;
      },

      // Reference table editing (hierarchical)
      renameRefParent: function(oldParent, newParent) {
        newParent = (newParent || '').trim();
        if (newParent === oldParent) return;
        if (this.isLockedRefValue(oldParent)) { this.notify(this.tOr('msg.locked', 'Used by a filter — cannot rename')); return; }  // a filter-pinned group value can't be renamed
        var self = this;
        var table = self.currentRefTable;
        var parentCol = self.refParentCol;
        (self.dataCache[table] || []).forEach(function(row) {
          if (row[parentCol] === oldParent) {
            row[parentCol] = newParent;
            row.updated_at = new Date().toISOString();
            backend.putRow(self.tableMap[table], row, 'active');
          }
        });
        self.migrateListTranslation(table, oldParent, newParent);   // carry the group's own label
        self.notify(self.t('msg.renamed'));
      },
      deleteRefParent: function(parent) {
        if (this.refParentLocked(parent)) { this.notify(this.tOr('msg.locked', 'Used by a filter — cannot delete')); return; }
        var key = 'refp:' + parent;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        var self = this;
        var table = self.currentRefTable;
        var parentCol = self.refParentCol;
        var toDelete = (self.dataCache[table] || []).filter(function(r) { return r[parentCol] === parent; });
        self.dataCache[table] = (self.dataCache[table] || []).filter(function(r) { return r[parentCol] !== parent; });
        toDelete.forEach(function(row) { backend.deleteRow(self.tableMap[table], row.id, 'active'); });
        self.pendingDelete = null;
        self.notify(self.t('msg.deleted'));
      },
      addRefParent: function() {
        var self = this;
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
        if (!this.refReorderable) return;
        var self = this, table = this.currentRefTable, group = this._refGroupRows(item[this.refParentCol]);
        var i = group.findIndex(function(r) { return r.id === item.id; }), j = i + dir;
        if (i < 0 || j < 0 || j >= group.length) return;
        var b = group[j], pa = item.position, pb = b.position, now = new Date().toISOString();
        item.position = pb; b.position = pa; item.updated_at = b.updated_at = now;
        backend.putRow(self.tableMap[table], item, 'active');
        backend.putRow(self.tableMap[table], b, 'active');
      },
      // Move a whole group up/down (swap it with the adjacent group), then renumber every row sequentially.
      moveRefGroup: function(parentVal, dir) {
        if (!this.refReorderable) return;
        var self = this, table = this.currentRefTable, grouped = this.refGroupedData;
        var order = Object.keys(grouped), i = order.indexOf(parentVal), j = i + dir;
        if (i < 0 || j < 0 || j >= order.length) return;
        var t = order[i]; order[i] = order[j]; order[j] = t;
        var pos = 1, now = new Date().toISOString();
        order.forEach(function(g) { (grouped[g] || []).forEach(function(r) {
          if (Number(r.position) !== pos) { r.position = String(pos); r.updated_at = now; backend.putRow(self.tableMap[table], r, 'active'); }
          pos++;
        }); });
      },
      refChildAtEdge: function(item, dir) { var g = this._refGroupRows(item[this.refParentCol]), i = g.findIndex(function(r) { return r.id === item.id; }); return dir < 0 ? i <= 0 : i >= g.length - 1; },
      refGroupAtEdge: function(parentVal, dir) { var o = Object.keys(this.refGroupedData), i = o.indexOf(parentVal); return dir < 0 ? i <= 0 : i >= o.length - 1; },
      saveRefField: function(item, col, value) {
        if (item[col] === value) return;
        var lv = this.lockedListValues[this.currentRefTable];
        if (lv && lv[item[col]]) { this.notify(this.tOr('msg.locked', 'Used by a filter — cannot rename')); return; }  // renaming a pinned value breaks the filter
        var oldVal = item[col];
        item[col] = value;
        item.updated_at = new Date().toISOString();
        var self = this;
        var refTable = self.currentRefTable;
        // Rename side-effects (mirror list renames): carry the value across every table that refs it + its
        // translations, so an existing lookup value can be renamed without orphaning rows or its label.
        if (oldVal && value) { self.propagateRefChange(refTable, oldVal, value); self.migrateListTranslation(refTable, oldVal, value); }
        var timerKey = refTable + ':' + item.id;
        clearTimeout(self.saveTimers[timerKey]);
        self.saveTimers[timerKey] = setTimeout(function() {
          backend.putRow(self.tableMap[refTable], item, 'active');
          self.notify(self.t('msg.saved'));
        }, 500);
      },
      addRefRow: function() {
        var self = this;
        self._createBlankRow(self.currentRefTable);
        self.notify(self.t('msg.row_added'));
        self.focusLastEditable('.v-main .v-card .v-table tbody tr:last-child .editable-cell');
      },
      deleteRefRow: function(item) {
        if (this.isLockedRefRow(item)) { this.notify(this.tOr('msg.locked', 'Used by a filter — cannot delete')); return; }
        var key = 'ref:' + item.id;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }
        var table = this.currentRefTable;
        this.dataCache[table] = (this.dataCache[table] || []).filter(function(r) { return r.id !== item.id; });
        backend.deleteRow(this.tableMap[table], item.id, 'active');
        this.notify(this.t('msg.deleted'));
      },

      // Languages
      switchLanguage: function(code) {
        var self = this;
        localStorage.setItem('app_lang', code);
        var defCode = self.defaultLanguage;
        backend.getTranslations(self.folderId, defCode).then(function(baseTrans) {
          self.strings = baseTrans || {};
          if (code !== defCode) {
            return backend.getTranslations(self.folderId, code).then(function(trans) {
              if (trans) self.strings = Object.assign({}, self.strings, trans);
            });
          }
        });
      },
      openLangEditor: function(lang) {
        var self = this;
        this.editingLang = lang;
        backend.getTranslations(self.folderId, lang.code).then(function(trans) {
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
          backend.updateTranslations(self.folderId, self.editingLang.code, self.currentTranslations);
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
        backend.createLanguage(this.folderId, code, name, this.translationKeys).then(function() {
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
        if (backend.renameLanguage) backend.renameLanguage(self.folderId, lang.code, newName);
        lang.name = newName;
        self.notify(self.t('msg.language_renamed'));
      },
      deleteLang: function(lang) {
        var key = 'lang:' + lang.code;
        if (this.pendingDelete !== key) { this.armDelete(key); return; }  // arm-then-confirm (double click)
        var self = this;
        backend.deleteLanguage(self.folderId, lang.code).then(function() {
          self.languages = self.languages.filter(function(l) { return l.code !== lang.code; });
          if (self.editingLang && self.editingLang.code === lang.code) self.editingLang = null;
          // Deleting the (explicit) default is allowed: repoint it to a remaining language, or clear
          // it when none remain. schemaData is frozen, so replace it with an updated copy + persist.
          if (self.schemaData && self.schemaData.defaultLanguage === lang.code) {
            var newDef = self.languages.length ? self.languages[0].code : null;
            var newSchema = Object.assign({}, self.schemaData, { defaultLanguage: newDef });
            self.schemaData = Object.freeze(newSchema);
            if (backend.saveSchema) backend.saveSchema(self.folderId, newSchema);
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
        var oldVal = this.listsCache[name][i];
        if (this.isLockedValue(name, oldVal)) { this.notify(this.tOr('msg.locked', 'Used by a filter — cannot rename')); return; }  // filter-pinned value can't be renamed
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
          Promise.resolve(backend.getTranslations(self.folderId, lang.code)).then(function(t) {
            if (!t || t[oldKey] == null || t[oldKey] === '') return;
            var updates = {}; updates[newKey] = t[oldKey]; updates[oldKey] = '';   // '' clears the old key (getTranslations drops empty)
            backend.updateTranslations(self.folderId, lang.code, updates);
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
        var arr = this.listsCache[name]; var j = i + dir;
        var tmp = arr[i]; arr.splice(i, 1, arr[j]); arr.splice(j, 1, tmp);
        this.saveLists();
      },
      saveLists: function() { backend.saveLists(this.folderId, this.listsCache); },

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
              out.push({ table: t, col: c, multi: getColumnType(t, c) === 'multiselect', altList: alt });
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
              if (rowChanged) { row.updated_at = new Date().toISOString(); backend.putRow(self.tableMap[table], row, partition); changed++; }
            });
            return changed;
          };
          [['active', table], ['archive', aKey(table)]].forEach(function(p) {
            var partition = p[0], cacheKey = p[1];
            if (self.dataCache[cacheKey]) {
              jobs.push(Promise.resolve(apply(self.dataCache[cacheKey], partition)));
            } else {
              jobs.push(Promise.resolve(backend.getTableData(self.tableMap[table], partition)).then(function(result) {
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
          Promise.resolve(backend.setFolderConfig(this.folderId, cfg))
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
      // Slot columns for a named rotationView (['_period', ...slots]); drops all-empty slots when hideEmpty.
      rotationColsFor: function(name, rows) {
        var v = VIEWS[name];
        if (!v || !v.rotation) return [];
        var rv = v.rotation;
        var names = rv.slots ? rv.slots.slice() : (rv.columns || []).map(function(c) { return c.name; });
        if (v.hideEmpty) {
          var rs = rows || [];
          names = names.filter(function(n) { return rs.some(function(r) { var val = r[n]; return Array.isArray(val) ? val.length : !!val; }); });
        }
        return ['_period'].concat(names);
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
            backend.putRow(self.tableMap[table], r, 'active');
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
            var mch = false;
            synced.forEach(function(c) { if (mr[c] !== rowData[c]) { mr[c] = rowData[c] || ''; mch = true; } });
            if (mch) { mr.updated_at = new Date().toISOString(); backend.putRow(self.tableMap[mt], mr, mTab); }
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
            var ch = false;
            upTargets[st].forEach(function(c) { if (stRow[c] !== rowData[c]) { stRow[c] = rowData[c] || ''; ch = true; } });
            if (ch) { stRow.updated_at = new Date().toISOString(); backend.putRow(self.tableMap[st], stRow, stTab); }
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
        var done = function() { self.usersLoaded = true; self.loading = false; self.loadMyProfile(); self.loadSharedProfiles(); self._overlayUserLists(); self._autoSelectTab(); };
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
        }).catch(function() { self.selfUnregistered = true; self.userList = []; done(); });
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
      // Downscale an image File to a data-URL whose longest side is <= max, preserving aspect ratio.
      _resizeImageFile: function(file, max) {
        var self = this;
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
                canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
              } catch (err) { reject(new Error(self.t('msg.image_process_failed'))); }
            };
            img.src = String(reader.result || '');
          };
          reader.readAsDataURL(file);
        });
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
      listValuePicture: function(col, value) {
        if (!value || typeof value !== 'string' || !window.ListUsers) return '';
        var list = this.listNameForCol(col);   // resolves aggregate group columns too (e.g. piispakunta)
        if (!list) return '';
        return window.ListUsers.pictureFor(this.listAvatars, list, value);
      },
      // Lists opted in to user linking (Lookup-editor picker): `listSources[name] === 'userlink'`. Distinct
      // from 'users' (auto-populated shared names) -- these keep curated values and just map value -> account.
      isUserLinkList: function(name) { return (((this.schemaData || {}).listSources) || {})[name] === 'userlink'; },
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
        var list = col ? getColumnList(null, col) : null;
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
        if (u.tables === 'all') return;   // full access already sees everything; nothing to add
        this._saveGrants(u, AccessFeatures.buildGrants(this.userFeatures(u), selected, SCHEMA, VIEWS));
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
          localStorage.setItem('firebase_config', JSON.stringify(config));
          localStorage.setItem('app_mode', 'firebase');
          // Try saving server-side for other users
          fetch(_u('/api/saveConfig'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({filename:'firebase-config.json', data:config}) }).catch(function(){});
          location.reload();
        } catch(e) { this.notify(this.t('msg.invalid_json')); }
      },
      saveClientId: function() {
        if (this.oauthClientId) localStorage.setItem('oauth_client_id', this.oauthClientId);
      },
      saveSupabaseConfig: function() {
        var url = (this.supabaseUrlInput || '').trim().replace(/\/+$/, '');
        var key = (this.supabaseKeyInput || '').trim();
        if (!url || !key) return;
        localStorage.setItem('supabase_config', JSON.stringify({ url: url, anonKey: key }));
        localStorage.setItem('app_mode', 'supabase');
        localStorage.setItem('app_folder', 'supabase');
        // Try saving server-side for other users (dev server only; harmless 404 on static hosting).
        fetch(_u('/api/saveConfig'), { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({filename:'supabase-config.json', data:{url:url, anonKey:key}}) }).catch(function(){});
        location.reload();   // reload so index.html loads the SDK + backend for mode=supabase
      },
      exportData: function() {
        var self = this;
        var data = {};
        Object.keys(SCHEMA).forEach(function(table) {
          data[table] = self.dataCache[table] || [];
          var archiveKey = aKey(table);
          if (self.dataCache[archiveKey]) data[archiveKey] = self.dataCache[archiveKey];
        });
        // Gather translations
        var translations = {};
        var chain = Promise.resolve();
        self.languages.forEach(function(lang) {
          chain = chain.then(function() {
            return backend.getTranslations(self.folderId, lang.code).then(function(t) { translations[lang.code] = t; });
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
          return Promise.resolve(backend.getTableData('_pages', 'active')).then(function(d) {
            var pages = (d && d.rows || []).filter(function(r) { return r.id && r.markdown; });
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
            download(schema, pages.length ? { pages: pages } : {});
          }).catch(function() {
            var schema = JSON.parse(JSON.stringify(self.schemaData));
            if (schema.tables) Object.keys(schema.tables).forEach(function(t) { var c = schema.tables[t].columns; if (c) { delete c.id; } delete schema.tables[t].partition; delete schema.tables[t].archivePartition; });
            download(schema, {});
          });
        });
      },
      importData: function(event) {
        var self = this;
        var file = event.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(e) {
          try {
            var imported = JSON.parse(e.target.result);
            // Detect if file is a raw schema.json (has tables with column definitions, not row arrays)
            var isRawSchema = imported.tables && !imported.schema && Object.values(imported.tables).some(function(t) { return t && t.columns; });
            if (isRawSchema) { imported = { schema: imported, tables: {} }; }
            // Structural check: block import if the schema has dangling view/table references
            if (imported.schema) {
              var refErrs = validateRefs(imported.schema);
              if (refErrs.length) { self.notify(self.t('msg.import_blocked') + ' ' + refErrs[0] + (refErrs.length > 1 ? ' (+' + (refErrs.length - 1) + ' more)' : '')); return; }
            }

            // Flatten the row work up front: it dominates the run (two round-trips per row) and so defines
            // both the ordering and the progress total.
            var tables = imported.tables || {};
            var rowJobs = [];
            Object.keys(tables).forEach(function(key) {
              var rows = Array.isArray(tables[key]) ? tables[key] : (tables[key].rows || []);
              var parts = key.split('__');
              // bare key = active partition; any suffixed key = the (single) archive partition
              var tab = parts.length > 1 ? 'archive' : 'active';
              rows.forEach(function(row) { rowJobs.push({ table: parts[0], tab: tab, row: row }); });
            });
            var langCodes = imported.translations ? Object.keys(imported.translations) : [];
            var pages = (imported.pages && Array.isArray(imported.pages))
              ? imported.pages.filter(function(p) { return p.id && p.markdown; }) : [];

            // Progress + failure state. Two things were wrong before: the run gave no sign of life for the
            // ~minute it takes on a real database, and — worse — the whole thing was ONE serial promise
            // chain with no .catch(), so a single rejected write silently abandoned every step after it.
            // That is how an import could land schema + rows and then no translations at all, with no
            // error shown. (The old try/catch only ever caught synchronous errors while BUILDING the chain.)
            var prog = {
              active: true, done: 0, icon: 'mdi-timer-sand', detail: '', errors: [], finished: false,
              total: (imported.schema ? 1 : 0) + rowJobs.length + (imported.lists ? 1 : 0)
                   + langCodes.length + pages.length + (imported.config ? 1 : 0) + 1
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
                  VIEWS = {}; _flattenViews(_viewsNav);
                }
                return backend.saveSchema(self.folderId, imported.schema).then(function() {
                  _normalizeSchema(imported.schema);
                  self.schemaData = Object.freeze(imported.schema); // mirror boot: refresh the reactive schema (invalidates lockedListValues et al.)
                  return backend.initSchema(self.folderId, SCHEMA);
                }).then(function(tableMap) {
                  if (tableMap) self.tableMap = tableMap;
                });
              }));
            }
            rowJobs.forEach(function(job, i) {
              chain = chain.then(step('mdi-table-row', (i + 1) + '/' + rowJobs.length + ' · ' + job.table, function() {
                var target = self.tableMap[job.table] || job.table;
                // Delete first to force CRDT change detection on re-import
                return backend.deleteRow(target, job.row.id, job.tab).catch(function() {})
                  .then(function() { return backend.putRow(target, job.row, job.tab); });
              }));
            });
            if (imported.lists) {
              chain = chain.then(step('mdi-format-list-bulleted', '', function() {
                self.listsCache = imported.lists;
                return backend.saveLists(self.folderId, imported.lists);
              }));
            }
            langCodes.forEach(function(code) {
              chain = chain.then(step('mdi-translate', code, function() {
                // Ensure language exists before writing translations
                var langName = (imported.languages || []).find(function(l) { return l.code === code; });
                return backend.createLanguage(self.folderId, code, langName ? langName.name : code, Object.keys(imported.translations[code]))
                  .catch(function() {})   // already present is fine; the merge below still writes the strings
                  .then(function() { return backend.updateTranslations(self.folderId, code, imported.translations[code]); });
              }));
            });
            pages.forEach(function(page) {
              chain = chain.then(step('mdi-file-document-outline', page.id, function() {
                return backend.putRow('_pages', { id: page.id, markdown: page.markdown }, 'active');
              }));
            });
            // Restore portable folder config (rotationAnchors, rotationRanges, any future portable key),
            // preserving this environment's `mode`. Excluded keys never cross the import boundary.
            if (imported.config && backend.setFolderConfig) {
              chain = chain.then(step('mdi-cog', '', function() {
                var merged = mergeImportedConfig(self.appConfig, imported.config, self.mode);
                self.appConfig = merged;
                return backend.setFolderConfig(self.folderId, merged);
              }));
            }
            chain = chain.then(step('mdi-format-list-checks', '', function() {
              var locked = self.lockedListValues;
              var needSave = false;
              for (var ln in locked) {
                if (!self.listsCache[ln]) { self.listsCache[ln] = []; needSave = true; }
                for (var lv in locked[ln]) {
                  if (self.listsCache[ln].indexOf(lv) < 0) { self.listsCache[ln].push(lv); needSave = true; }
                }
              }
              return needSave ? backend.saveLists(self.folderId, self.listsCache) : Promise.resolve();
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
        };
        reader.readAsText(file);
        event.target.value = '';
      },
      // Reload so the freshly imported data is picked up. Extracted from importData so the progress
      // dialog's "Reload" button can trigger it after a partial import the user has read.
      finishImportReload: function() {
        this.importProgress = null;
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
        if (mode === 'sheets' || mode === 'crdt') {
          if (typeof google !== 'undefined' && google.script) { return; }
          if (typeof _oauthClient === 'undefined' || !_oauthClient) { location.reload(); return; }
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
            return backend.getTableData(self.tableMap[src], 'active').then(function(r) {
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

      getSource: function(item, ownerId) { ownerId = ownerId || this.currentTable; if (item._source) return item._source; var v = VIEWS[ownerId]; return v ? v.sources[0] : ownerId; },

      getTab: function(source) {
        return this.viewingArchive ? 'archive' : 'active';
      },

      _deleteFromSources: function(sources, itemId, fromArchive) {
        var self = this;
        sources.forEach(function(src) {
          var tab = fromArchive ? 'archive' : 'active';
          var key = fromArchive ? aKey(src) : src;
          self.dataCache[key] = (self.dataCache[key] || []).filter(function(r) { return r.id !== itemId; });
          backend.deleteRow(self.tableMap[src], itemId, tab);
        });
        this.currentData = this.currentData.filter(function(r) { return r.id !== itemId; });
        this.notify(this.t('msg.deleted'));
      },
      _archiveInSources: function(sources, itemId) {
        var self = this;
        sources.forEach(function(source) {
          var schema = SCHEMA[source];
          if (!schema || !schema.archivable) return;
          var cached = self.dataCache[source] || [];
          var srcRow = cached.find(function(r) { return r.id === itemId; });
          if (!srcRow) return;
          self.dataCache[source] = cached.filter(function(r) { return r.id !== itemId; });
          if (!self.dataCache[aKey(source)]) self.dataCache[aKey(source)] = [];
          self.dataCache[aKey(source)].push(srcRow);
          backend.moveRow(self.tableMap[source], srcRow, 'active', 'archive');
        });
        this.notify(this.t('msg.archived'));
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
        if (backend.saveSchema) backend.saveSchema(this.folderId, newSchema);
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
        if (backend.saveSchema) backend.saveSchema(this.folderId, newSchema);
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
          var manifest = {
            name: title, short_name: title, start_url: base, scope: base,
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
          toDateStr: function(v) { return self.toDateStr(v); },
          displayValue: function(c, v) { return self.displayValue(c, v); },
          isColumnHidden: function(c, item) { return self.isColumnHidden(c, item); },
          colHideEmpty: function(c) { return self.colHideEmpty(c); },
          embedItems: self.embedItems,
          embedWhenOk: function(ei, item) { return self.embedWhenOk(ei, item); },
          embedRowsForItem: function(ei, item) { return self.embedRowsForItem(ei, item); },
          embedCols: function(t, n) { return self.embedCols(t, n); },
          embedRows: function(t, n, p) { return self.embedRows(t, n, p); }
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
      // actually be present. On a committed cloud backend (firebase/sheets/crdt) there is no /api
      // endpoint, so the probe would just log a spurious 404 to the console on every load.
      var appMode = (function() { try { return localStorage.getItem('app_mode'); } catch (e) { return null; } })();
      if (appMode !== 'firebase' && appMode !== 'sheets' && appMode !== 'crdt' && _mayLocal()) {
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
    displayValue: function(c, v) { return appInstance ? appInstance.displayValue(c, v) : v; },
    colIsDate: function(c) { return appInstance ? appInstance.colIsDate(c) : false; },
    colIsImage: function(c) { return appInstance ? appInstance.colIsImage(c) : false; },
    colIsUrl: function(c) { return appInstance ? appInstance.colIsUrl(c) : false; },
    // Sanitize a user-supplied url/image cell before it goes into an attribute. safeHref (for <a href>)
    // is http(s)-only, so a stored `javascript:`/`data:` string can't execute on click. safeImg (for
    // <img src>) also allows a raster data:image. Both share embeds.js so mdToHtml and the cells agree.
    safeHref: function(u) { return (typeof safeUrl === 'function') ? safeUrl(u) : ''; },
    safeImg: function(u) { return (typeof safeImgSrc === 'function') ? safeImgSrc(u) : ''; },
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
      spec: { type: Object, default: null }, row: { type: Object, default: null },
      fontSize: { type: String, default: '0.75rem' }, cellPad: { type: String, default: '2px 6px' }, header: { type: Boolean, default: false },
      depth: { type: Number, default: 0 } // recursion guard for doc-view-in-doc-view embeds
    },
    // Per-embed inline-edit state for doc-view embeds (each embed edits its own page independently).
    data: function() { return { editing: false, docDraft: '' }; },
    created: function() {
      // A doc-view embed renders the ACCESS-GATED server body, not the world-readable schema seed. Kick
      // off the single-page read (server-filtered) once, but only if the viewer may see it -- a restricted
      // user's block is hidden anyway (docBlocks), and skipping the read avoids a pointless denied fetch.
      if (this.isDoc && appInstance && appInstance.canAccessPage(VIEWS[this.name]) && appInstance.pageCache[this.name] === undefined) {
        appInstance.loadPage(this.name);
      }
    },
    computed: {
      isCal: function() { return this.type === 'view' && !!(appInstance && appInstance.isCalendarName(this.name)); },
      isRot: function() { return this.type === 'view' && !!(appInstance && appInstance.isRotationName(this.name)); },
      isPiv: function() { return this.type === 'view' && !!(appInstance && appInstance.isPivotName(this.name)); },
      isRsvp: function() { return this.type === 'view' && !!(appInstance && appInstance.isRsvpName(this.name)); },
      // A doc-view embedded inside another page (only via the no-spec page path; the spec path pre-tags kind='doc').
      isDoc: function() { return !this.spec && this.type === 'view' && !!(appInstance && appInstance.isDocViewName(this.name)); },
      kind: function() { return this.spec ? this.spec.kind : (this.isCal ? 'calendar' : this.isRot ? 'rotation' : this.isPiv ? 'pivot' : this.isRsvp ? 'rsvp' : this.isDoc ? 'doc' : 'data'); },
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
      rows: function() {
        if (this.spec) return (this.spec.config.filterBy && this.row) ? appInstance.embedRowsForItem(this.spec, this.row) : this.spec.rows;
        return appInstance ? appInstance.embedRows(this.type, this.name, this.part) : [];
      },
      canMutate: function() { return !this.part && appInstance && appInstance.canMutateEmbed(this.type, this.name); },
      hasArchive: function() { return !this.part && appInstance && appInstance.embedHasArchive(this.type, this.name); },
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
      addRow: function() { return appInstance.embedAddRow(this.type, this.name); },
      delRow: function(item) { return appInstance.embedDeleteRow(this.type, this.name, item); },
      archRow: function(item) { return appInstance.embedArchiveRow(this.type, this.name, item); },
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
        if (backend.putRow) backend.putRow('_pages', { id: this.name, markdown: this.docDraft }, 'active');
        this.editing = false;
        appInstance.notify(appInstance.t('msg.saved'));
      }
    }),
    template: ''
      + '<calendar-view v-if="kind===\'calendar\'" :name="calName" :embed="true"></calendar-view>'
      + '<rotation-view v-else-if="kind===\'rotation\'" :name="calName" :embed="true"></rotation-view>'
      + '<pivot-view v-else-if="kind===\'pivot\'" :name="calName" :embed="true"></pivot-view>'
      + '<rsvp-view v-else-if="kind===\'rsvp\'" :name="calName" :embed="true"></rsvp-view>'
      + '<template v-else-if="kind===\'doc\'">'
      + '<div v-if="canEditDoc" class="d-flex align-center"><v-spacer></v-spacer>'
      + '<v-btn size="x-small" variant="text" :prepend-icon="editing ? \'mdi-eye\' : \'mdi-pencil\'" @click="toggleDocEdit()">{{ editing ? t(\'btn.preview\') : t(\'btn.edit\') }}</v-btn>'
      + '<v-btn v-if="editing" size="x-small" color="primary" variant="text" prepend-icon="mdi-content-save" @click="saveDoc()">{{ t(\'btn.save\') }}</v-btn>'
      + '</div>'
      + '<v-textarea v-if="editing" :model-value="docDraft" @update:model-value="docDraft = $event" auto-grow variant="outlined" density="compact" hide-details placeholder="# Markdown"></v-textarea>'
      + '<template v-else v-for="(blk, bi) in blocks" :key="bi">'
      + '<div v-if="blk.html" v-html="blk.html" style="font-size:0.8rem"></div>'
      + '<embed-view v-else :type="blk.embedType" :name="blk.embedName" :part="blk.embedPart" :depth="depth + 1"></embed-view>'
      + '</template>'
      + '</template>'
      // --- read-only data (data-view spec path): inline {{self}} blocks, or table/card/chip + header ---
      + '<template v-else-if="spec">'
      + '<template v-if="spec.inlineBlocks" v-for="(blk, bi) in spec.inlineBlocks" :key="\'ib\'+bi">'
      + '<div v-if="blk.html" v-html="blk.html" style="font-size:0.8rem"></div>'
      + '<table v-else-if="blk.self" :style="tblStyle"><thead><tr><th v-for="ec in cols" :key="ec" :style="thStyle">{{ t(\'field.\' + ec) || ec }}</th></tr></thead>'
      + '<tbody><tr v-for="er in rows" :key="er.id"><td v-for="ec in cols" :key="ec" :style="tdStyle"><list-value v-if="!colHidden(ec, er)" :col="ec" :value="er[ec]"></list-value></td></tr></tbody></table>'
      + '</template>'
      + '<template v-else>'
      + '<div v-if="header" style="font-size:0.8rem; opacity:0.6; margin-bottom:8px">{{ t(\'tab.\' + spec.config.table) || spec.config.table }} ({{ rows.length }})</div>'
      + '<table v-if="roLayout===\'table\'" :style="tblStyle"><thead><tr><th v-for="ec in cols" :key="ec" :style="thStyle">{{ t(\'field.\' + ec) || ec }}</th></tr></thead>'
      + '<tbody><tr v-for="er in rows" :key="er.id"><td v-for="ec in cols" :key="ec" :style="tdStyle"><list-value v-if="!colHidden(ec, er)" :col="ec" :value="er[ec]"></list-value></td></tr></tbody></table>'
      + '<div v-else-if="roLayout===\'card\'" style="display:grid; gap:6px"><div v-for="er in rows" :key="er.id" style="font-size:0.75rem; padding:4px 6px; border:1px solid rgb(var(--v-theme-outline),0.15); border-radius:4px"><span v-for="ec in colsFor(er)" :key="ec" style="display:inline-block; margin-right:12px"><span style="opacity:0.6">{{ t(\'field.\' + ec) || ec }}: </span><list-value :col="ec" :value="er[ec]"></list-value></span></div></div>'
      + '<div v-else class="d-flex align-center flex-wrap ga-1"><v-chip v-for="er in rows" :key="er.id" size="small" variant="tonal" color="secondary" label><span v-for="(ec, i) in colsFor(er)" :key="ec">{{ er[ec] }}<span v-if="i < colsFor(er).length - 1" style="opacity:0.4"> · </span></span></v-chip></div>'
      + '</template>'
      + '</template>'
      // --- editable data (page / doc-leaf self path): list/card/table with data-cell + row controls ---
      + '<div v-else>'
      + '<v-list v-if="layout===\'list\'" density="compact" class="my-2">'
      + '<v-list-item v-for="(item, ri) in rows" :key="item.id || ri" class="px-2">'
      + '<template v-slot:default><span v-for="(col, i) in colsFor(item)" :key="col" style="font-size:0.85rem"><list-value :col="col" :value="item[col]"></list-value><span v-if="i < colsFor(item).length - 1" style="opacity:0.3;margin:0 6px">·</span></span></template>'
      + '<template v-slot:append><template v-if="canMutate"><v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn><v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn></template></template>'
      + '</v-list-item></v-list>'
      + '<div v-else-if="layout===\'card\'" class="my-2">'
      + '<v-card v-for="(item, ri) in rows" :key="item.id || ri" variant="flat" class="ma-2 pa-2" style="border-bottom:1px solid rgb(var(--v-theme-outline),0.2)">'
      + '<div v-for="col in colsFor(item)" :key="col" class="d-flex align-center mb-1"><span style="min-width:120px;flex-shrink:0;font-size:0.75rem;opacity:0.6;padding-right:8px">{{ t(\'field.\' + col) || col }}</span><span style="opacity:0.8"><list-value :col="col" :value="item[col]"></list-value></span></div>'
      + '<div v-if="canMutate" style="text-align:right"><v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn><v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn></div>'
      + '</v-card></div>'
      + '<v-table v-else density="compact" class="my-2"><template v-slot:default>'
      + '<thead><tr><th v-for="c in cols" :key="c">{{ t(\'field.\' + c) || c }}</th><th v-if="canMutate"></th></tr></thead>'
      + '<tbody><tr v-for="(item, ri) in rows" :key="item.id || ri"><td v-for="col in cols" :key="col">'
      + '<data-cell v-if="!colHidden(col, item)" :item="item" :col="col" :owner="name" :readonly="!!part" :embed="true"></data-cell>'
      + '</td><td v-if="canMutate" style="white-space:nowrap">'
      + '<v-btn v-if="hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" @click="archRow(item)"></v-btn>'
      + '<v-btn :icon="isArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" :color="isArmed(item) ? \'error\' : \'\'" @click="delRow(item)"></v-btn>'
      + '</td></tr></tbody>'
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
      isAltList: function(col, item) { return appInstance.isAltList(col, item); },
      toggleListSwitch: function(col, item) { return appInstance.toggleListSwitch(col, item); },
      save: function(item, col, val) { return appInstance.saveField(item, col, val, this.owner); },
      addToListOnBlur: function(item, col) { return appInstance.addToListOnBlur(item, col); },
      // image column: upload the picked file to the backend blob store (Firebase Storage), then save the
      // returned URL onto the row (the row holds the URL, never the bytes). Transient per-cell status.
      uploadImage: function(item, col, ev) {
        var self = this, file = ev.target.files && ev.target.files[0];
        ev.target.value = '';                 // reset so re-picking the same file fires change again
        if (!file) return;
        this.uploadErr = ''; this.uploading = true;
        appInstance.uploadFile(file, { table: this.owner || appInstance.currentTable, col: col, rowId: item.id }).then(function(url) {
          self.uploading = false; self.save(item, col, url);
        }).catch(function(e) {
          self.uploading = false; self.uploadErr = (e && e.message) || self.t('msg.upload_failed');
        });
      }
    }),
    data: function() { return { uploading: false, uploadErr: '' }; },
    computed: { canUpload: function() { return appInstance.canUploadFiles(); } },
    template: ''
      + '<span v-if="cellRO(item, col)" :style="{ opacity: embed ? 0.4 : 0.75 }">'
      +   '<a v-if="colIsImage(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="safeImg(item[col])" class="cell-thumb" alt=""></a>'
      +   '<a v-else-if="colIsUrl(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop>{{ item[col] }}</a>'
      +   '<template v-else><list-value :col="col" :value="item[col]"></list-value></template>'
      + '</span>'
      + '<span v-else-if="!embed && colIsMirrorForTable(col)" style="opacity:0.82"><list-value :col="col" :value="item[col]"></list-value></span>'
      + '<v-combobox v-else-if="colIsMultiselect(col) && colAllowNew(col)" :name="col" multiple chips closable-chips :model-value="item[col] || []" :items="getListOptions(col)" item-title="title" item-value="value" density="compact" variant="plain" hide-details style="flex:1" @update:model-value="save(item, col, $event)" @blur="addToListOnBlur(item, col)" @keydown.home.stop @keydown.end.stop><template v-slot:chip="{ props }"><v-chip v-bind="props" size="small" color="secondary"></v-chip></template></v-combobox>'
      + '<v-autocomplete v-else-if="colIsMultiselect(col)" :name="col" multiple chips closable-chips :model-value="item[col] || []" :items="getListOptions(col)" item-title="title" item-value="value" density="compact" variant="plain" hide-details style="flex:1" @update:model-value="save(item, col, $event)" @keydown.home.stop @keydown.end.stop><template v-slot:chip="{ props }"><v-chip v-bind="props" size="small" color="secondary"></v-chip></template></v-autocomplete>'
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
      +   '<a v-if="item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="safeImg(item[col])" class="cell-thumb" alt=""></a>'
      +   '<template v-if="canUpload">'
      +     '<input type="file" accept="image/*" ref="imgInput" style="display:none" @change="uploadImage(item, col, $event)">'
      +     '<v-btn size="x-small" variant="text" :loading="uploading" :icon="item[col] ? \'mdi-image-edit\' : \'mdi-camera-plus\'" :title="item[col] ? t(\'img.replace\') : t(\'img.upload\')" @click="$refs.imgInput.click()"></v-btn>'
      +     '<v-btn v-if="item[col]" size="x-small" variant="text" icon="mdi-close" :title="t(\'img.remove\')" @click="save(item, col, \'\')"></v-btn>'
      +   '</template>'
      +   '<input v-else type="url" :value="item[col] || \'\'" @change="save(item, col, $event.target.value)" :placeholder="t(\'img.url\')" spellcheck="false" style="border:none;background:transparent;color:inherit;font:inherit;flex:1;min-width:60px">'
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
    calendar: 'calendar-view', rotation: 'rotation-view', pivot: 'pivot-view', rsvp: 'rsvp-view', board: 'board-view', page: 'page-view', data: 'data-view',
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
  var ROT_BODY_PROPS = { cols: Array, slotCols: Array, rows: Array };

  app.component('rotation-table', {
    props: ROT_BODY_PROPS,
    methods: Object.assign({ head: function(col) { return col === '_period' ? this.t('field.period') : (this.t('field.' + col) || col); } }, ROOT_PROXY),
    template: ''
      + '<v-table density="compact"><template v-slot:default>'
      + '<thead><tr><th v-for="col in cols" :key="col">{{ head(col) }}</th></tr></thead>'
      + '<tbody><tr v-for="row in rows" :key="row.id"><td v-for="col in cols" :key="col" style="padding:3px 8px"><list-value :col="col" :value="row[col]"></list-value></td></tr></tbody>'
      + '</template></v-table>'
  });

  app.component('rotation-cards', {
    props: ROT_BODY_PROPS, methods: ROOT_PROXY,
    template: ''
      + '<div style="display:grid; gap:8px; padding:8px">'
      + '<div v-for="row in rows" :key="row.id" style="padding:8px 12px; border:1px solid rgb(var(--v-theme-outline),0.15); border-radius:8px">'
      + '<div style="font-weight:600; margin-bottom:4px">{{ toDateStr(row._period) }}</div>'
      + '<div v-for="col in slotCols" :key="col" style="font-size:0.9rem"><span style="opacity:0.6">{{ t(\'field.\'+col) || col }}: </span><list-value :col="col" :value="row[col]"></list-value></div>'
      + '</div></div>'
  });

  app.component('rotation-list', {
    props: ROT_BODY_PROPS, methods: ROOT_PROXY,
    template: ''
      + '<div style="padding:4px 0">'
      + '<div v-for="row in rows" :key="row.id" style="padding:4px 12px; border-bottom:1px solid rgb(var(--v-theme-outline),0.08); font-size:0.9rem">'
      + '<span style="font-weight:600; margin-right:8px">{{ toDateStr(row._period) }}</span>'
      + '<span v-for="(col, i) in slotCols" :key="col"><span style="opacity:0.6">{{ t(\'field.\'+col) || col }}: </span><list-value :col="col" :value="row[col]"></list-value><span v-if="i < slotCols.length - 1" style="opacity:0.3"> · </span></span>'
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
      +   '<a v-if="colIsImage(col) && item[col]" :href="safeHref(item[col])" target="_blank" @click.stop><img :src="safeImg(item[col])" class="cell-thumb" alt=""></a>'
      +   '<list-value v-else :col="col" :value="item[col]"></list-value>'
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
      + '<v-btn value="list" size="small">{{ t(\'cal.list\') }}</v-btn></v-btn-toggle></div>'
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
      + '<component :is="bodyComponent" :cols="cols" :slot-cols="slotCols" :rows="rows"></component>'
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
      colLabel: function(k) { return appInstance.displayValue(this.cfg.column, k); },
      rowLabel: function(k) { return appInstance.displayValue(this.cfg.row, k); },
      cellFmt: function(v) { return (v === '' || v == null) ? '' : (this.cfg.cell ? appInstance.displayValue(this.cfg.cell, v) : v); }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="pivot-view">'
      + '<v-table density="compact" class="my-1"><template v-slot:default>'
      + '<thead><tr>'
      + '<th style="position:sticky;left:0;z-index:1;background:rgb(var(--v-theme-surface));cursor:pointer" @click="toggleSort(\'__row__\')" data-testid="pivot-sort-row">{{ head(cfg.row) }}{{ sortIcon(\'__row__\') }}</th>'
      + '<th v-for="(c, ci) in grid.columns" :key="c" style="text-align:center;cursor:pointer" @click="toggleSort(ci)"><list-value :col="cfg.column" :value="c"></list-value>{{ sortIcon(ci) }}</th>'
      + '<th v-if="hasTotals" style="text-align:center;font-weight:700;cursor:pointer" @click="toggleSort(\'__total__\')">{{ a.t(\'pivot.total\') }}{{ sortIcon(\'__total__\') }}</th>'
      + '</tr></thead>'
      + '<tbody>'
      + '<tr v-for="r in rows" :key="r.key">'
      + '<th style="position:sticky;left:0;z-index:1;background:rgb(var(--v-theme-surface));font-weight:600"><list-value :col="cfg.row" :value="r.key"></list-value></th>'
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

  // ONE list VALUE (or a multiselect array of them), rendered as its display text with the linked user's
  // avatar in front when there is one. This is THE single place a list value + optional avatar is drawn, so
  // avatars appear consistently wherever a value is printed — read-only cells, embeds, the compact list
  // layout, rotation slots, the pivot axes, and group-card titles. Non-list columns just render their text;
  // dates (and the synthetic _period) pass through toDateStr. Drop-in for `{{ displayValue(col, val) }}`.
  app.component('list-value', {
    props: { col: { type: String, required: true }, value: {}, size: { type: [Number, String], default: 18 } },
    computed: {
      items: function() {
        var col = this.col, v = this.value, a = appInstance;
        if (col === '_period' || a.colIsDate(col)) return (v == null || v === '') ? [] : [{ text: a.toDateStr(v), pic: '' }];
        var arr = Array.isArray(v) ? v : ((v == null || v === '') ? [] : [v]);
        return arr.filter(function(x) { return x != null && x !== ''; }).map(function(x) {
          return { text: a.displayValue(col, x), pic: a.listValuePicture(col, x) };
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
      laneCol: function() { return this.cfg.lane; },
      canEdit: function() { return !this.embed && appInstance.canMutateRows; },
      hasArchive: function() { return appInstance.hasArchive; },
      rows: function() { return this.embed ? (appInstance.boardRowsFor ? appInstance.boardRowsFor(this.viewName) : []) : (appInstance.currentData || []); },
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
      laneLabel: function(k) { return k === '' ? appInstance.tOr('board.unassigned', '—') : appInstance.displayValue(this.laneCol, k); },
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
      cardColor: function(item) { return this.cfg.color ? Calendar.hashColor(String(item[this.cfg.color] || '')) : null; },
      toggleGroup: function(key) { this.collapsed[key] = !this.collapsed[key]; },
      // --- drag/drop (desktop) ---
      onDragStart: function(item) { if (this.canEdit) this.dragId = item.id; },
      onDragEnd: function() { this.dragId = null; this.overLane = null; },
      onDrop: function(laneKey) {
        if (!this.canEdit || this.dragId == null) return;
        var id = this.dragId, self = this;
        var item = (appInstance.currentData || []).find(function(r) { return r.id === id; });
        if (item && String(item[self.laneCol] || '') !== laneKey) appInstance.saveField(item, self.laneCol, laneKey, self.viewName);
        this.onDragEnd();
      },
      // --- mobile / a11y fallback: move via menu ---
      moveTo: function(item, laneKey) { if (this.canEdit && String(item[this.laneCol] || '') !== laneKey) appInstance.saveField(item, this.laneCol, laneKey, this.viewName); },
      laneMenuItems: function() { var self = this; return this.laneOrder.map(function(k) { return { value: k, title: self.laneLabel(k) }; }); },
      addInLane: function(laneKey) { appInstance.boardAddInLane(this.viewName, laneKey); },
      // Per-card row controls (mirror the grid's row-append buttons): archive files the card to the archive
      // partition (reversible via restore); delete uses the app's armed-confirm (keyed row:<id>) — first click
      // arms for 3s and swaps the icon, the second removes the row.
      archItem: function(item) { if (this.canEdit) appInstance.archiveRow(item); },
      isDelArmed: function(item) { return appInstance.isArmed('row:' + item.id); },
      delItem: function(item) { if (this.canEdit) appInstance.deleteRow(item); },
      // Inline card editing: a pencil flips one card into edit mode, where every field except the lane
      // column (that stays a drag/move-menu action, so it honors archiveOn) becomes a shared `data-cell`
      // editor writing back through saveField — the same widgets and persistence as the table grid.
      editCols: function() { var self = this; return (this.view.columns || []).map(colName).filter(function(c) { return typeof c === 'string' && c && c !== self.laneCol; }); },
      toggleEdit: function(item) { this.editing[item.id] = !this.editing[item.id]; }
    }),
    template: ''
      + '<component :is="embed ? \'div\' : \'v-card\'" :variant="embed ? undefined : \'outlined\'" :class="embed ? \'my-2\' : \'\'" data-testid="board-view">'
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
      + '        <template v-if="canEdit && cfg.addInLane"><v-spacer></v-spacer>'
      + '        <v-btn icon="mdi-plus" size="x-small" variant="text" density="comfortable" :title="tOr(\'board.add_in_lane\',\'Add\')" @click="addInLane(lane.key)" :data-testid="\'board-add-\'+lane.key"></v-btn></template>'
      + '      </div>'
      + '      <div v-for="item in lane.items" :key="item.id"'
      + '           :draggable="canEdit && !editing[item.id] ? \'true\' : \'false\'" @dragstart="onDragStart(item)" @dragend="onDragEnd"'
      + '           :style="\'background:rgb(var(--v-theme-surface));border:1px solid rgb(var(--v-theme-outline),0.15);border-radius:6px;padding:6px 8px;margin-bottom:6px;cursor:\'+(canEdit && !editing[item.id] ?\'grab\':\'default\')+(cardColor(item)?\';border-left:3px solid \'+cardColor(item):\'\')"'
      + '           :data-testid="\'board-card-\'+item.id">'
      + '        <div style="display:flex;align-items:flex-start;gap:4px">'
      + '          <div style="font-weight:600;font-size:0.85rem;flex:1">{{ cardTitle(item) }}</div>'
      + '          <v-btn v-if="canEdit" :icon="editing[item.id] ? \'mdi-check\' : \'mdi-pencil-outline\'" size="x-small" variant="text" density="comfortable" :color="editing[item.id] ? \'primary\' : undefined" :title="tOr(\'board.edit\',\'Edit\')" @click="toggleEdit(item)" :data-testid="\'board-edit-\'+item.id"></v-btn>'
      + '          <v-btn v-if="canEdit && hasArchive" icon="mdi-archive-outline" size="x-small" variant="text" density="comfortable" :title="tOr(\'board.archive\',\'Archive\')" @click="archItem(item)" :data-testid="\'board-arch-\'+item.id"></v-btn>'
      + '          <v-btn v-if="canEdit" :icon="isDelArmed(item) ? \'mdi-check-circle\' : \'mdi-close\'" size="x-small" variant="text" density="comfortable" :color="isDelArmed(item) ? \'error\' : undefined" :title="isDelArmed(item) ? tOr(\'board.confirm_delete\',\'Confirm delete?\') : tOr(\'board.delete\',\'Delete\')" @click="delItem(item)" :data-testid="\'board-del-\'+item.id"></v-btn>'
      + '          <v-menu v-if="canEdit" v-model="menuOf[item.id]"><template v-slot:activator="{ props }">'
      + '            <v-btn v-bind="props" icon="mdi-dots-vertical" size="x-small" variant="text" density="comfortable" :title="tOr(\'board.move_to\',\'Move to\')" :data-testid="\'board-move-\'+item.id"></v-btn></template>'
      + '            <v-list density="compact"><v-list-subheader>{{ tOr(\'board.move_to\',\'Move to\') }}</v-list-subheader>'
      + '            <v-list-item v-for="opt in laneMenuItems()" :key="opt.value" @click="moveTo(item, opt.value)" :active="String(item[laneCol]||\'\')===opt.value">'
      + '              <v-list-item-title>{{ opt.title }}</v-list-item-title></v-list-item></v-list></v-menu>'
      + '        </div>'
      + '        <template v-if="editing[item.id]"><div v-for="col in editCols()" :key="col" style="display:flex;align-items:center;gap:6px;margin-top:4px"><span style="font-size:0.72rem;opacity:0.6;min-width:82px;flex-shrink:0">{{ t(\'field.\'+col) || col }}</span><data-cell :item="item" :col="col" :owner="viewName"></data-cell></div></template>'
      + '        <template v-else><div v-for="col in cardCols(item)" :key="col" style="font-size:0.78rem;opacity:0.85"><span style="opacity:0.6">{{ t(\'field.\'+col) || col }}: </span>{{ displayValue(col, item[col]) }}</div></template>'
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
      + '<v-btn size="small" variant="text" :prepend-icon="a.pageEditing ? \'mdi-eye\' : \'mdi-pencil\'" @click="a.togglePageEdit()">{{ a.pageEditing ? a.t(\'btn.preview\') : a.t(\'btn.edit\') }}</v-btn>'
      + '<v-btn v-if="a.pageEditing" size="small" color="primary" prepend-icon="mdi-content-save" @click="a.savePage()" class="ml-2">{{ a.t(\'btn.save\') }}</v-btn></div>'
      + '<v-textarea v-if="a.pageEditing" :model-value="a.pageEditText" @update:model-value="a.pageEditText = $event" auto-grow variant="outlined" density="compact" placeholder="# Markdown — embed views with {{view:name}} or {{table:name}}"></v-textarea>'
      + '<template v-else v-for="(blk, bi) in a.pageBlocks" :key="bi">'
      + '<div v-if="blk.html" v-html="blk.html"></div>'
      + '<embed-view v-else :type="blk.embedType" :name="blk.embedName" :part="blk.embedPart"></embed-view>'
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
  if (savedMode === 'sheets' || savedMode === 'crdt' || savedMode === 'oauth') instance.oauthReady = true;

  if (savedMode === 'firebase') {
    instance.mode = 'firebase';
    instance.loading = true;
    instance.startApp();
    return;
  }

  if (!folder) {
    // On Apps Script, skip local server probe
    if (typeof google !== 'undefined' && google.script) {
      instance.showSetup = true; instance.loading = false;
    } else if (savedMode === 'sheets' || savedMode === 'oauth' || savedMode === 'crdt') {
      instance.mode = savedMode; instance.showSetup = true; instance.loading = false;
    } else if (!_mayLocal()) {
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
    instance.folderId = folder;
    instance.mode = savedMode || 'sheets';
    instance.startApp();
  }
}

// createVueApp() and init() called by index.html after all scripts loaded
