# dbUI App

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Six backends**: Google Sheets (Apps Script), OAuth REST API, Browser + CRDT Sync (Google Drive), Browser + CRDT Sync (Local Server), Firebase (Firestore), Dev Server (SQLite)
- **Unified CRDT**: one offline-first engine; Drive and local server differ only in the transport
- **i18n**: multi-language with auto-generated translation keys from schema
- **Views**: flat union, join, and aggregate views, plus **rotationView** (generated rotating roster), **calendar** (month/week/list), **pivot** (cross-tab grid), and **rsvp** (self-service signup sheet); columns can embed named views/inline tables
- **Rotating rosters**: `multiselect` columns hold a group of people; rotation tables cycle a group per occurrence (tied to another table's rows) or per calendar interval (`daily/weekly/monthly/yearly` or `<n><unit>` like `3w`), with the anchor stored as editable data
- **Self-service RSVP**: an `rsvp` view is a read-write signup sheet where each member toggles their own attendance; backed by the `owner` column type (auto-stamped current-user email, read-only) + per-row Firestore rules, so a participant writes only their own row without a table grant
- **Documents**: a view with `markdown` is an editable document with interactive embeds (`{{view:x}}`, `{{self}}` for its own grid, `{{view:x?}}` hides when empty) — bodies stored on the server, not in the schema
- **Theming**: an optional `schema.theme` sets a brand palette (light/dark colors); an admin **Settings → Theme** editor tweaks it live (per-role pickers + paste-a-palette) and auto-saves, driving all Vuetify accents + the PWA/splash colors
- **Nav**: explicit sidebar tree with drawer/tabs layout and nested groups
- **Print**: layout-aware printing (table or card mode), per-card print, embeds included
- **Responsive**: auto-switches between table and card layout based on column count; mobile gets a bottom navigation bar (`nav.bottomNav`) + floating add button
- **Installable (PWA)**: web manifest + service worker → install to home screen / desktop and run in a standalone window (no address bar). Name, icon, and theme color follow the schema and the live light/dark theme
- **Validation**: schema validated at boot time with error reporting

## Backends

| Backend | Storage | Auth | Offline | Real-time | Setup |
|---------|---------|------|---------|-----------|-------|
| **Apps Script** | Google Sheets | Built-in | ❌ | ❌ | Web editor |
| **OAuth** | Google Sheets | OAuth consent | ❌ | ❌ | Cloud Console |
| **Browser + CRDT Sync (Google Drive)** | IndexedDB + Drive | OAuth consent | ✅ | 30s sync | Cloud Console |
| **Browser + CRDT Sync (Local Server)** | IndexedDB + dev server (SQLite or `--fs` JSON) | None | ✅ | 30s sync | `npm start` |
| **Firebase** | Firestore | Firebase Auth | ✅ | ✅ Instant | Firebase Console |
| **Dev Server (SQLite)** | SQLite | None | N/A | N/A | `npm start` |

## Quick Start (Local Development)

```bash
cd dev
npm install
npm start        # http://127.0.0.1:3000
npm test         # run backend unit tests
npx playwright test  # run E2E tests
```

Browser: click "Create Local Database" → app loads with schema from `schema.json`.
Optionally run `npm run seed:import` (with the server running) to layer the demo data — rows, lists,
translations, rotation config, plus example users/profiles — on top of the schema. The importable data
lives in `dev/demo-bundle.json` (the same bundle shape as Settings → Import); regenerate its
date-relative rows with `node seed-import.js --regen`.

**Reset**: delete `dev/local.db` + browser `localStorage.clear(); location.reload()`

## Quick Start (Apps Script)

See `apps-script/DEPLOY.md` for deployment guide.

## Quick Start (Firebase)

1. Create project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Firestore Database + Google Auth provider
3. Add your domain to Authentication → Authorized domains (e.g. `127.0.0.1`)
4. Register Web app → copy config JSON
5. Firestore → Rules → paste contents of `firestore.rules` → Publish
6. Run the app, select Firebase mode, paste config → Sign in with Google
7. Settings → Import from JSON to load schema + data

First user is auto-registered as admin (bootstrap mode). After that, only registered users can access. Per-table permissions configurable per user.

> ⚠️ **Sign in yourself immediately after publishing the rules.** The first Google account to sign
> in becomes the admin — so never share the app URL or a pre-configured link before you have signed
> in once. Anyone holding the link during the bootstrap window could claim the admin role.

Firebase config is stored in browser localStorage. Share a pre-configured URL to onboard users without manual setup.

### Firefox: "Sign in with Google" fails (third-party cookies)

Google sign-in (`signInWithPopup`) loads Firebase's auth handler from `<projectId>.firebaseapp.com`.
When the app is hosted on a **different origin** (e.g. GitHub Pages) that handler runs as a
*third party*, and Firefox's **Enhanced Tracking Protection** + **Total Cookie Protection** (default
since FF 103) block its cookies/storage — so sign-in silently fails. Same applies to Safari ITP.

User-side fixes (easiest first):

1. **Per-site (recommended):** click the **shield icon** left of the address bar → turn
   **Enhanced Tracking Protection OFF** for this site → reload.
2. **Cookie exception:** Settings → Privacy & Security → Cookies and Site Data →
   **Manage Exceptions** → add `https://<projectId>.firebaseapp.com` → **Allow**.
3. **Global:** set ETP to **Standard** (not Strict) — least reliable, since Standard still
   partitions third-party storage; prefer the exception in (2).

Robust fix (no per-user setting): serve the auth handler **same-origin** with the app — host on
**Firebase Hosting** (or a custom domain whose `authDomain` matches the app's origin). Then the auth
popup is first-party and no third-party cookies are involved.

## Sharing & Access

### Shareable Links (URL params)

Share a pre-configured link so new users connect instantly without manual setup:

```
# Firebase
https://your-app.github.io/?mode=firebase&config=BASE64_ENCODED_CONFIG

# Sheets/CRDT
https://your-app.github.io/?mode=sheets&folder=DRIVE_FOLDER_ID
```

The app reads URL params on load, stores them in localStorage, then cleans the URL. One click = connected.

> Firebase links also accept the config as discrete params instead of base64:
> `?mode=firebase&k=<apiKey>&p=<projectId>` (with optional `&d=<authDomain>`). `d=` is
> **optional** — it defaults to `<projectId>.firebaseapp.com` (the standard Firebase auth
> domain), so it's only needed for a custom/non-default `authDomain`. Sheets links also accept
> `&clientId=<oauthClientId>`.

Generate the link from Settings tab (shown under "Share link" for Firebase mode).

### User Access by Backend

| Backend | How to add users | Admin UI? |
|---------|-----------------|:---:|
| **Firebase** | Settings → User Access panel | ✅ Yes |
| **Dev Server (SQLite)** | Settings → User Access panel (test with `?user=`) | ✅ Yes |
| **Sheets** | Share Drive folder via Google Drive | ❌ |
| **Browser (CRDT)** | Share Drive subfolder per table | ❌ |
| **Apps Script** | Share folder + add to OAuth test users | ❌ |

### User Registry

Any backend defining `backend_users` gets built-in user access control (Settings → User Access):

1. **Bootstrap mode**: first user auto-registered as admin
2. **Add users** inline (click +, edit email/role/tables in-place)
3. **Roles**: admin (manage schema/users/translations + all tables), editor (read+write allowed tables + edit allowed lists), viewer (read-only)
4. **Per-table access**: select which tables each user can access (or "All")
5. **View filtering**: views are only visible if user has access to ALL source tables
6. **List filtering**: editors see only lists used by their allowed tables
7. **Security Rules** (`firestore.rules`): enforces roles + per-table access server-side. Deploy once.

Local dev: test access control with `http://localhost:3000/?user=editor1` (user must exist in registry).

Firestore document structure (`_meta/users`):
```json
{
  "user@gmail.com": { "role": "admin", "user": "user@gmail.com", "tables": "all" },
  "other@gmail.com": { "role": "editor", "user": "other@gmail.com", "tables": ["tasks", "notes"] }
}
```

### Multi-Database (Single Deployment)

One hosted instance serves multiple independent databases:
- Each user enters their own connection details during setup
- Details stored in browser localStorage (per-origin)
- Different users on the same URL can connect to different Firebase projects or Drive folders
- Share a pre-configured URL to onboard users to a specific database

## Installable (PWA)

The app is a Progressive Web App — installable to a phone home screen or desktop, running in a
standalone window with no browser address bar.

- **Static manifest** (`manifest.json`) + `<link rel="manifest">` in `index.html` provide the
  baseline name/icons/`display: standalone` before the app boots.
- **Runtime manifest**: once the schema loads, `_updateManifest()` rebuilds the manifest with the
  live **app title** (per-database name) + theme colors and swaps in a Blob URL.
  `start_url`/`scope`/icon `src` are written as **absolute** URLs (a Blob-URL manifest can't
  resolve relative paths). `background_color`/`theme_color` follow the current Vuetify theme; a
  dynamic `theme-color` meta tracks the in-app light/dark toggle. The runtime manifest's install
  icons come from **`schema.icons` when set, else the bundled static files** (below).
- **Service worker** (`sw.js`): minimal pass-through `fetch` (no offline caching) — its purpose
  is to satisfy the browser installability check so the install prompt appears reliably.
- **Per-database icons via `schema.icons` (optional).** All three icon surfaces can be driven
  from the database schema using **absolute URLs** to PNG/SVG files hosted **anywhere** (a CDN,
  Firebase Storage, S3, GitHub raw, …). This works with the *Firebase-for-database-only, no app
  server* model because the icon files are just static objects on some HTTPS host — no runtime
  rasterization or app server is required. Schema shape (every field optional):

  ```json
  "icons": {
    "favicon":     "https://cdn.example.com/db/icon-512.png",
    "appleTouch":  "https://cdn.example.com/db/icon-512.png",
    "png512":      "https://cdn.example.com/db/icon-512.png",
    "png512Sizes": "512x512"
  }
  ```

  The **manifest install icon is a single 512×512 PNG** (`png512`) — Chromium only needs one square
  PNG ≥144px and 512 also covers the splash/maskable role, so no separate small icon is required.
  `png512Sizes` (optional, default `"512x512"`) lets a differently-sized source be declared
  accurately (e.g. a 256×256 PNG → `"256x256"`) to avoid a DevTools size-mismatch warning.
  `_applyIconLinks()` sets `<link rel="icon">` / `<link rel="apple-touch-icon">` and
  `_updateManifest()` emits the manifest install icons from these URLs. **Any missing field falls
  back to the bundled static file**, so a deployment can mix (e.g. per-database favicon, shared
  bundled install icon) or omit `icons` entirely for the all-static default.

  Hard rules that still apply (why `data:`/`blob:` don't work):
  - The manifest **install** icon must be a **square raster PNG** (`png192`/`png512`); SVG /
    `sizes:"any"` is skipped for install (fine as a `favicon`).
  - URLs must be **absolute `http(s)`** and reachable. Chromium's manifest icon downloader runs
    outside the document and **cannot fetch renderer-minted `data:`/`blob:` URLs** (both log
    *"Icon … failed to load"*) — but it **can** fetch a real network URL, including cross-origin
    (icons are exempt from the same-origin rule that binds `start_url`/`scope`).
  - Production must be **HTTPS→HTTPS** (a cross-origin `http:` icon on an HTTPS page is
    mixed-content blocked).

  > Note: automated headless tests verify the manifest/links carry the URLs and that the browser
  > fetches+decodes the cross-origin PNG (no-CORS image path — the same mode the install-icon
  > downloader uses), but headless Chromium does **not** run the desktop install-icon download.
  > Confirm the actual install icon once in real Chrome → DevTools → Application → Manifest.

### Bundled static icon files (default / fallback)
When `schema.icons` is absent (or a field is omitted), the app uses these files shipped **at the
deploy root** (next to `index.html`); the host must serve them with correct image MIME types:

| File | Size | Purpose |
|------|------|---------|
| `favicon.svg` | any | browser-tab favicon (`<link rel="icon">`) |
| `icon-512.png` | 512×512 | apple-touch-icon + manifest install / splash / maskable icon |

To customize the app's icon for a deployment, **replace these two files** (the repo ships
defaults rasterized from `favicon.svg`, e.g. via `convert -background white -density 512
favicon.svg -resize 512x512 icon-512.png`).

- **Requirements**: install needs HTTPS (Firebase Hosting provides it) and a valid manifest;
  the icon files must be reachable and served as `image/*`.

## Project Structure

```
index.html                     ← unified entry point (auto-detects backend)
manifest.json                  ← static PWA manifest (baseline name/icons, display: standalone)
sw.js                          ← minimal service worker (enables install prompt; no caching)
favicon.svg                    ← static favicon (replace to rebrand)
icon-512.png                   ← static apple-touch + manifest install/splash/maskable icon (512×512)
app-core.html                  ← Vue app logic + computeds + helpers
ui.html                        ← Vue template (data views, forms, setup)
style.html                     ← CSS styles
auth-oauth.html                ← shared OAuth (GSI) for Sheets + CRDT(Drive)
backend-oauth.html             ← adapter: REST API + OAuth
backend-firebase.html          ← adapter: Firestore + Firebase Auth
storage-firestore.html         ← Firestore storage adapter
── Unified CRDT (shared by Drive + local) ──
crdt-backend.html              ← shared CRDT backend (data via engine, files via transport)
crdt-engine.html               ← storage-agnostic LWW CRDT engine
storage-idb.html               ← IndexedDB storage adapter
transport-drive.html           ← Drive transport (files + changesets via Drive API)
backend-crdt.html              ← Drive CRDT initializer (Transport = TransportDrive)
────────────────────────────────────────────
firebase.json                  ← Firebase Hosting config
firestore.rules                ← Firestore Security Rules
apps-script/                   ← Apps Script deployment files (GAS-only)
  index.html, Code.gs, DEPLOY.md
  sheets-helpers.js            ← pure transforms shared with unit tests
  backend-appscript.html       ← adapter: google.script.run (GAS-only)
dev/                           ← Local development (dev-server-only files live here)
  schema.json                  ← schema definition (tables, views, settings)
  schema.js                    ← test helper (parses schema.json)
  demo-bundle.json             ← portable demo DATA (rows/lists/translations), imported over schema.json
  seed-import.js               ← applies demo-bundle.json to the dev server (--regen rebuilds it)
  package.json                 ← dependencies + scripts (npm start/test)
  server.js                    ← HTTP server (port 3000; --fs for JSON-file storage)
  backend-local.js             ← SQLite backend (better-sqlite3)
  storage-fs.js                ← JSON-file backend (node server.js --fs)
  backend-local-client.html    ← client adapter for local server (direct SQLite)
  backend-crdt-local.html      ← local CRDT initializer (Transport = TransportLocal)
  transport-local.html         ← local transport (files + changesets via dev server)
  test/                        ← node:test backend tests
  test-ui/                     ← Playwright E2E tests
```

---

## Schema Reference (`schema.json`)

The complete schema reference is maintained in **[`dev/SCHEMA.md`](dev/SCHEMA.md)** — the single
source of truth. It covers: `icon`/title, `theme` (brand palette), tables (column types incl.
`multiselect`, `owner` & properties), views (data, document, rotationView, calendar, pivot & rsvp),
embeds (inline / named-view / `filterBy`), filters (`$or`/`$and`/`matchList`), aggregate views
(`groupBy`/`collect`/`collectWith`), computed columns (incl. rotation columns — occurrence/calendar),
markdown documents and their `{{view:}}`/`{{table:}}`/`{{self}}`/`{{t:}}` tokens, `nav` (layout, groups,
`bottomNav`), and lists & translations.

```json
{
  "icon":  "data: URI | path | URL (favicon + PWA icon)",
  "theme": { "light": { "primary": "#..." }, "dark": { "primary": "#..." } },
  "tables": { "...": { "columns": [ ... ], "archivable": true } },
  "views":  [ { "name": "...", "sources": [ ... ], "columns": [ ... ] } ],
  "nav":    { "layout": "drawer", "items": [ ... ], "bottomNav": [ ... ] }
}
```

> `nav` is **required**; `views` are flat (hierarchy lives in `nav`). Each view is one **kind**, chosen
> by which field it carries: a **data view** (`sources`/`columns`), a **document** (`markdown`), a
> **rotationView** (`rotation`), a **calendar** (`calendar`), a **pivot** (`pivot`), or an **rsvp**
> (`rsvp`).

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  index.html                      │  ← auto-detects backend
├────────────────┬─────────────────────────────────┤
│  app-core.html │         ui.html                 │  ← Vue 3 app + template
├────────────────┼─────────────────────────────────┤
│ backend-*.html │   schema.json / firebase-config │  ← adapter + config
├────────────────┴─────────────────────────────────┤
│ Sheets │ OAuth │ CRDT (Drive / Local) │ Firestore │ SQLite │
└──────────────────────────────────────────────────┘
```

**Schema flow:**
1. Server loads `schema.json` from disk/Drive
2. Client receives schema via `bootData()` or `getSchema()`
3. `validateSchema()` checks for errors
4. Tables auto-created if missing (`initSchema`)
5. UI renders based on schema definitions

**Key design decisions:**
- Schema is pure JSON (user-editable in Drive without code access)
- `defaultSchema` in app-core.html is minimal empty fallback only
- Column order in Google Sheets preserved via JSON string serialization (avoids RPC key reordering)
- All backends implement the same 16-function interface

### Unified CRDT (Drive + Local)

Both CRDT modes share **one backend** (`crdt-backend.html`) built on a storage-agnostic engine. They differ **only in the transport**:

```
            crdt-backend.html  (one shared backend)
        data ─► CrdtEngine + StorageIDB  (IndexedDB, LWW per field)
       files ─► Transport.readJson / writeJson / deleteFile
                        │
            ┌───────────┴────────────┐
      TransportDrive            TransportLocal
      (Google Drive API)        (HTTP → dev server)
```

- **Data** (table rows) lives in IndexedDB and syncs as compacted LWW changesets (`pushChangesets`/`pullChangesets`, 30s interval). The server/Drive is *not* the read path — it only stores changesets for cross-device sync.
- **Metadata** (schema, lists, languages, translations, config) are plain JSON files read/written through the transport: `schema.json`, `lists.json`, `languages.json`, `lang_{code}.json`, `.app-config.json`.
- Both transports produce an **identical file layout**, so a local `--fs` data folder is a drop-in Google Drive folder — copy it across and switch modes.
- A **new user/device** bootstraps by reading the metadata files + pulling every device's `_sync/` changesets into a fresh IndexedDB.
- The local dev server (`server.js`, optionally `--fs`) acts as a dumb file store via generic `readFile`/`writeFile`/`deleteFile` routes plus `saveChangesets`/`loadChangesets`.

Firebase is intentionally **not** on the CRDT engine — Firestore provides its own real-time sync, offline cache, and conflict resolution.
