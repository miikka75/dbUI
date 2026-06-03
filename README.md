# Drive Sync App

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Six backends**: Google Sheets (Apps Script), OAuth REST API, Browser + CRDT Sync (Google Drive), Browser + CRDT Sync (Local Server), Firebase (Firestore), Dev Server (SQLite)
- **Unified CRDT**: one offline-first engine; Drive and local server differ only in the transport
- **i18n**: multi-language with auto-generated translation keys from schema
- **Views**: flat union, join, and aggregate views with configurable layout
- **Pages**: editable markdown documents with interactive embedded views (`{{view:x}}`, `{{view:x?}}` hides when empty) — bodies stored on the server, not in the schema
- **Nav**: explicit sidebar tree with drawer/tabs layout and nested groups
- **Print**: layout-aware printing (table or card mode), per-card print, embeds included
- **Responsive**: auto-switches between table and card layout based on column count
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
Optionally run `npm run seed` (with the server running) to populate the demo's page prose translations.

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

Firebase config is stored in browser localStorage. Share a pre-configured URL to onboard users without manual setup.

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

## Project Structure

```
index.html                     ← unified entry point (auto-detects backend)
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
  migrate-schema.js            ← schema migration/normalization tool (handles export bundles)
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

The schema has these top-level sections:

```json
{
  "defaultLanguage": "en",
  "tables": { ... },
  "views": [ ... ],
  "pages": { ... },
  "nav": { "layout": "drawer", "items": [ ... ] }
}
```

> `nav` defines the sidebar and is **required**. `views` are flat — grouping and nesting live
> in `nav`, not in the views. `pages` are optional markdown documents that embed views.
> `defaultLanguage` is optional (defaults to the first defined language).

### Tables

Tables define data structure. Each table has columns and storage configuration.

| Field | Type | Description |
|-------|------|-------------|
| `columns` | array | Column definitions (array of objects) |
| `archivable` | boolean | Enable archive/restore (rows move between the fixed `active` and `archive` partitions) |
| `isLookup` | boolean | Reference/lookup table (managed in Lookup tab, not sidebar) |

```json
"tasks": {
  "columns": [
    { "name": "date", "type": "date", "syncFrom": "notes" },
    { "name": "title", "type": "text", "syncFrom": "notes" },
    { "name": "status", "type": "select", "list": "status" },
    { "name": "assigned_to", "type": "select", "list": "assigned_to", "allowNew": true, "sorted": true },
    { "name": "city", "type": "ref", "table": "cities", "valueCol": "city", "filterBy": {"state": "state"} }
  ],
  "archivable": true
}
```

> **`id` is implicit** — every table gets an `id` column auto-injected (storage primary key + join/archive match key). Do not declare it in `columns`.

#### Column types

| Type | Description |
|------|-------------|
| `text` | Plain text (default) |
| `date` | Date picker, stored as `YYYY-MM-DD` |
| `select` | Dropdown from a named list |
| `ref` | Reference to a lookup table column |

#### Column properties

| Property | Description |
|----------|-------------|
| `name` | Column identifier (required) |
| `type` | Column type (default: `"text"`) |
| `hidden` | Don't display in UI (e.g., `created_at`, `updated_at`) |
| `list` | List name for `select` type |
| `allowNew` | Allow adding new values to the list (combobox) |
| `sorted` | Sort dropdown items alphabetically (for `select`/`list` columns) |
| `syncFrom` | Mirror this column's value from another table |
| `table` | Reference table name (for `ref` type) |
| `valueCol` | Column to use as value (for `ref` type) |
| `filterBy` | Filter reference options by another column (for `ref` type) |

### Views

Views define presentation and data transformations. They are **flat, reusable data
components** — the sidebar structure (order, grouping, nesting) lives in `nav`, not here.

Each entry is either a **view definition** (has `name` + `sources`) or a **table reference** (has `table`):

```json
"views": [
  { "name": "dashboard", "sources": ["tasks", "notes"], "mode": "union", ... },
  { "name": "report", "sources": ["tasks"], "mode": "union", ... },
  { "table": "tasks" }
]
```

#### View properties

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | View identifier |
| `sources` | string[] | Table names to pull data from |
| `mode` | string | `"union"` (stack rows) or `"join"` (merge rows by `id`) |
| `columns` | array | Mix of column names, inline embeds, and conditional columns |
| `filter` | object | Static row filter (e.g., `{"status": "in_progress"}`) |
| `readonly` | boolean | Disable editing (report views) |
| `layout` | string | `"table"`, `"card"`, or `"list"` |
| `collapsed` | boolean | Cards start collapsed (accordion) |
| `defaultSort` | string | Default sort column |
| `hideEmpty` | boolean | Hide columns where all rows are empty |
| `icon` | string | MDI icon for sidebar |

#### Aggregate views

Add `groupBy` + `collect` to group rows and collect values into fixed columns:

| Field | Type | Description |
|-------|------|-------------|
| `groupBy` | `{ column, from }` or `string[]` | Group key: `column` = output name, `from` = source columns |
| `collect` | string | Source column to collect per group (sorted descending) |

```json
{
  "name": "attendance",
  "sources": ["tasks", "notes"],
  "mode": "union",
  "groupBy": { "column": "person", "from": ["assigned_to", "author"] },
  "collect": "date",
  "columns": ["person", "latest", "previous", "3rd"]
}
```

Output: one row per person with their N most recent dates. Read-only, sortable.

### Pages (markdown + embedded views)

A page is a markdown document that embeds live views/tables. Pages are the **content layer**
on top of views and are editable in-app (Edit toggle → Save).

```json
"pages": {
  "home": { "markdown": "# Welcome\n\nOpen items:\n\n{{view:report}}\n\n{{t:page.home.note}}" }
}
```

- `{{view:<name>}}` / `{{table:<name>}}` — render live data inline. Embeds are **interactive**:
  inline cell editing plus add/delete/archive row controls (gated by the same permission/
  read-only rules as the main grid). A view with a `filter` embeds only its matching rows, so
  composing several filtered views in a page replaces in-view sectioning.
- `{{view:<name>?}}` / `{{table:<name>?}}` — append `?` to hide the embed when it has 0 rows.
- `{{t:<key>}}` — translatable text token (collected into the Languages tab).
- Markdown supports headings, bold/italic, lists, links, paragraphs.
- Page bodies are stored on the server in a `_pages` collection (one `{id, markdown}` row per
  page), not in `schema.json`. Edit via the toggle in the page corner → textarea → Save.

### Nav (sidebar structure + layout)

`nav` defines the sidebar (required). It references pages/views/tables by name and sets layout.

```json
"nav": {
  "layout": "drawer",
  "items": [
    { "page": "home", "icon": "mdi-home" },
    { "view": "report", "items": [ { "view": "sub_report" } ] },
    { "group": "Data", "icon": "mdi-database", "items": [ { "table": "tasks" } ] }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `layout` | string | `"drawer"` (default, side) or `"tabs"` (top, desktop) |
| `items` | array | Nav entries: `{page}`, `{view}`, `{table}`, or `{group, items}` |
| item `items` | array | Child entries (one level) — a clickable parent with nested children |
| item `icon` / `title` | string | Optional per-item icon / label override |

System tabs (Lookup / Languages / Settings) are appended automatically. Access filtering is unchanged: a view/page is visible only if the user can access all its source tables.

### Columns array

The `columns` array in views can contain:

#### 1. Column names (strings)
```json
"date", "title", "status"
```

#### 2. Conditional columns (show field only when condition met)
```json
{ "content": { "status": "in_progress" } }
```
Shows `content` column only for rows where `status === "in_progress"`.

#### 3. Inline embeds (filtered table data)
```json
{ "sources": ["tasks"], "filter": {"status": "open"}, "columns": ["date", "title"], "layout": "table" }
```
Renders a filtered subset of another table. Hidden when filter produces 0 rows.

Embed properties:

| Property | Description |
|----------|-------------|
| `sources` | Source table(s) (array) |
| `mode` | `"union"` or `"join"` (for multi-source embeds) |
| `filter` | Row filter |
| `columns` | Columns to display |
| `layout` | `"table"`, `"card"`, or `"chip"` (default) |
| `defaultSort` | Sort column for embed rows |
| `hideEmpty` | Hide columns where all embed rows are empty |

#### Full example

```json
{
  "name": "combined",
  "sources": ["tasks", "notes"],
  "mode": "join",
  "defaultSort": "date",
  "columns": [
    "date", "title",
    { "sources": ["tasks"], "filter": {"status": "open"}, "columns": ["date", "title", "assigned_to"], "defaultSort": "date" },
    { "sources": ["tasks"], "filter": {"status": "in_progress"}, "columns": ["date", "title", "assigned_to"], "layout": "table", "hideEmpty": true },
    "status", "assigned_to", "city", "content", "author"
  ]
}
```

### Lists and translations

- **List values** are stored as stable keys (e.g., `"in_progress"`, not "In Progress")
- **Display** uses translations: `list.status.in_progress` → "Käynnissä" / "In Progress"
- **Locked values**: list values referenced in schema filters are auto-seeded and non-deletable
- **Translation keys** auto-generated: `tab.*`, `view.*`, `field.*`, `list.*.*`, `page.*`, and page `{{t:}}` tokens

### Schema migration

`migrate-schema.js` normalizes/converts a schema (or an exported bundle) to the current
format. Run it against a schema file or export JSON to upgrade older layouts.

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
