# Drive Sync App

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Five backends**: Google Sheets (Apps Script), OAuth REST API, CRDT (IndexedDB + Drive sync), Firebase (Firestore), local SQLite
- **i18n**: multi-language with auto-generated translation keys from schema
- **Views**: union, join, embedded views with configurable layout
- **Header/footer**: translatable static text on tables, views, and embed entries
- **Print**: layout-aware printing (table or card mode), per-card print, embeds included
- **Responsive**: auto-switches between table and card layout based on column count
- **Validation**: schema validated at boot time with error reporting

## Backends

| Backend | Storage | Auth | Offline | Real-time | Setup |
|---------|---------|------|---------|-----------|-------|
| **Apps Script** | Google Sheets | Built-in | ❌ | ❌ | Web editor |
| **OAuth** | Google Sheets | OAuth consent | ❌ | ❌ | Cloud Console |
| **CRDT** | IndexedDB + Drive | OAuth consent | ✅ | 30s sync | Cloud Console |
| **Firebase** | Firestore | Firebase Auth | ✅ | ✅ Instant | Firebase Console |
| **Local** | SQLite | None | N/A | N/A | `npm start` |

## Quick Start (Local Development)

```bash
cd dev
npm install
npm start        # http://127.0.0.1:3000
npm test         # run backend tests (84 tests)
```

Browser: click "Create Local Database" → app loads with schema from `schema.json`.

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
8. Settings → User Access → add yourself as admin

First user has full access (bootstrap mode). After adding yourself as admin, only registered users can access. Per-table permissions configurable per user.

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
| **Sheets** | Share Drive folder via Google Drive | ❌ |
| **CRDT** | Share Drive subfolder per table | ❌ |
| **Apps Script** | Share folder + add to OAuth test users | ❌ |

### Firebase User Registry

Firebase mode includes a built-in user admin panel (Settings → User Access):

1. **Bootstrap mode**: first authenticated user has full access (no `_meta/users` document yet)
2. **Add yourself as admin** via Settings → User Access
3. **Add users** by email or UID with role + per-table access
4. **Roles**: admin (manage schema/users + all tables), editor (read+write allowed tables), viewer (read-only)
5. **Per-table access**: select which tables each user can access (or "All")
6. **Security Rules** (`firestore.rules`): enforces roles + per-table access server-side. Deploy once — no updates needed when adding users.

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
schema.json                    ← schema definition (tables, views, settings)
index.html                     ← unified entry point (auto-detects backend)
app-core.html                  ← Vue app logic + computeds + helpers
ui.html                        ← Vue template (data views, forms, setup)
style.html                     ← CSS styles
auth-oauth.html                ← shared OAuth (GSI) for Sheets + CRDT
backend-appscript.html         ← adapter: google.script.run
backend-oauth.html             ← adapter: REST API + OAuth
backend-crdt.html              ← adapter: IndexedDB + Drive sync (LWW)
backend-firebase.html          ← adapter: Firestore + Firebase Auth
firebase.json                  ← Firebase Hosting config
firestore.rules                ← Firestore Security Rules
apps-script/                   ← Apps Script deployment files
  index.html, Code.gs, DEPLOY.md
dev/                           ← Local development
  package.json                 ← dependencies + scripts (npm start/test)
  server.js                    ← HTTP server (port 3000)
  backend-local.js             ← SQLite backend (better-sqlite3)
  backend-local-client.html    ← client adapter for local server
  schema.js                    ← test helper (parses schema.json)
  test/                        ← node:test backend tests (84 tests)
```

---

## Schema Reference (`schema.json`)

The schema defines the entire app structure. It's a JSON file stored in the Drive folder (or read from disk in local dev).

### Top-Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `defaultLanguage` | string | Language code for fallback (e.g. `"en"`) |
| `tables` | object | Table definitions (key = table name) |
| `views` | object | View definitions (key = view name) |

```json
{
  "defaultLanguage": "en",
  "tables": { ... },
  "views": { ... }
}
```

---

### Common Properties (Tables & Views)

These properties work identically on tables, views, and embed entries:

| Field | Type | Description |
|-------|------|-------------|
| `icon` | string | MDI icon for sidebar (e.g. `"mdi-table"`) |
| `filter` | object | Filter displayed rows (`{field: value}`) |
| `hideEmpty` | boolean | Hide empty fields per-row in card, hide column if ALL rows empty in table |
| `readonly` | boolean | Disable editing (cells render as text, no add/delete buttons) |
| `layout` | string | Render layout (see below) |
| `defaultSort` | string | Column to sort by on load |
| `header` | string | Static text displayed above the data area |
| `footer` | string | Static text displayed below the data area |
| `embed` | object\|array | Embed filtered data from another table/view (see Embed section) |

#### Layout

The `layout` property controls how rows are rendered. Works on tables, views, and embeds.

| Value | Renders as |
|-------|-----------|
| `"auto"` (default) | Responsive: table when enough screen width, list when narrow. Embeds: table if ≥3 columns, list otherwise |
| `"table"` | Horizontal table with column headers |
| `"card"` | Vertical label:value cards (one card per row) |
| `"list"` | Compact single-line items (values separated by `·`) |

---

### Tables (unique properties)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `columns` | object | ✅ | Column definitions (key = column name) |
| `primaryKey` | string | ✅ | Primary key column (usually `"id"`) |
| `tab` | string | | Sheet tab name for active data |
| `archiveTab` | string | | Sheet tab name for archived rows |
| `hidden` | boolean | | Hide from sidebar (reference tables) |
| `ref` | boolean | | Marks as a reference/lookup table |

```json
"tasks": {
  "columns": { ... },
  "primaryKey": "id",
  "tab": "active",
  "archiveTab": "archive",
  "defaultSort": "due_date",
  "filter": { "status": "open" },
  "icon": "mdi-checkbox-marked-outline"
}
```

---

### Column Definitions

Each column is either a **type string** or a **column object**:

#### Simple (type string)
```json
"title": "text",
"due_date": "date"
```

#### Object (with options)

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"text"`, `"date"`, `"select"`, `"ref"` |
| `hidden` | boolean | Hide from table/card view (still stored in data) |
| `list` | string | List name for `select` type (dropdown options from Lookup Data) |
| `allowNew` | boolean | Allow typing new values that auto-add to the list (`select` type only) |
| `mirror` | string | Source table name — value copied from master table (read-only) |
| `table` | string | Reference table name for `ref` type |
| `filterBy` | string | Parent column for hierarchical ref filtering |

```json
"priority": {
  "type": "select",
  "list": "priorities"
},
"due_date": {
  "type": "date",
  "mirror": "projects"
},
"city": {
  "type": "ref",
  "table": "cities",
  "filterBy": "country"
},
"created_at": {
  "type": "text",
  "hidden": true
}
```

#### Column Types

| Type | Renders as | Notes |
|------|-----------|-------|
| `text` | Contenteditable span | Default type |
| `date` | `<input type="date">` | Native date picker |
| `select` | `v-autocomplete` | Dropdown from `list` name |
| `ref` | `v-autocomplete` | Dropdown from reference table with hierarchical filtering |

#### Mirror Columns

Mirror columns copy their value from a master table row with the same `id`. The master table owns the row lifecycle (create/delete/archive). Tables with mirror columns cannot add or delete rows independently.

```json
// tasks.columns.due_date mirrors projects.columns.due_date
"due_date": { "type": "date", "mirror": "projects" }
```

---

### Views (unique properties)

Views combine data from multiple tables without duplicating storage.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sources` | string[] | ✅ | Table names to pull data from |
| `columns` | string[] | ✅ | Columns to display (strings or conditional objects) |
| `mode` | string | ✅ | `"union"` or `"join"` |
| `matchKey` | string | | Column to match rows in join mode (default: `"id"`) |

```json
"dashboard": {
  "sources": ["tasks", "notes"],
  "columns": ["title", "status", {"resolution": {"status": "closed"}}],
  "mode": "join",
  "readonly": true,
  "layout": "card",
  "filter": { "status": "active" },
  "defaultSort": "due_date",
  "embed": { ... }
}
```

---

### View Modes

| Mode | SQL Analogy | Behavior |
|------|-------------|----------|
| `union` | `UNION ALL` | Stacks all rows from all sources. Shows `_source` badge. |
| `join` | `FULL OUTER JOIN ON id` | Merges rows with same id/matchKey. One row shows fields from all tables. |

#### Conditional Columns

Columns in a view's `columns` array support two formats:

```json
"columns": [
  "title",                                  // string: always visible
  {"content": {"status": "In Progress"}}    // object: visible only when condition matches
]
```

Object format: `{ columnName: { field: value } }` — the column is shown only for rows where `field === value`.

In card layout, conditional columns are hidden per-row when the condition doesn't match. In table layout, columns are always visible (conditions cannot hide table columns per-row).

---

### Embed

Embeds show filtered data from another table or view as a read-only section. Can be a single object or an array for multiple embeds. Supports all common properties (`filter`, `columns`, `header`, `footer`, `defaultSort`, `hideEmpty`, `layout`).

**Embed-specific properties:**

| Field | Type | Description |
|-------|------|-------------|
| `table` | string | Source table name (use `table` OR `view`, not both) |
| `view` | string | Source view name (inherits its columns/filter/sources) |
| `afterColumn` | string | Position embed after this column in card layout |

#### Table-based embed
```json
"embed": {
  "table": "subtasks",
  "filter": { "status": "in_progress" },
  "columns": ["title", "assigned_to", "priority"],
  "afterColumn": "description"
}
```

#### View-based embed
```json
"embed": {
  "view": "active_items",
  "afterColumn": "title"
}
```

#### Multiple embeds with headers
```json
"embed": [
  { "header": "Open items", "table": "tasks", "filter": {"status": "Open"}, "columns": ["title"] },
  { "header": "In Progress", "table": "tasks", "filter": {"status": "In Progress"}, "columns": ["title", "assigned_to"], "footer": "Check daily" }
]
```

**Positioning:**
- With `afterColumn`: in card mode, renders between fields. In table mode, renders as full-width row after data.
- Without `afterColumn`: renders at the bottom of the view.

**Validation:** Circular embed references (A → B → A) are detected at boot time.

---

### Lists (Dropdown Options)

Lists provide dropdown options for `select` columns. Defined in schema, items managed in the Lookup Data tab.

```json
"priority": { "type": "select", "list": "priorities" }
```

List names are fixed by schema (not user-creatable). Items within lists are editable in the app's Lookup Data tab.

Storage: Google Sheets mode stores lists in a `lists` spreadsheet with one tab per list name, values in column A.

---

### i18n (Translations)

Translation keys are auto-generated from schema:

| Pattern | Source |
|---------|--------|
| `tab.{tableName}` | Table names |
| `view.{viewName}` | View names |
| `field.{columnName}` | Column names |
| `btn.add`, `btn.show_active`, etc. | Fixed UI keys |

No translations needed in schema — add them in the Languages tab. Untranslated keys show as raw key text (e.g. `field.assigned_to`).

---

### Schema Validation

`validateSchema()` runs at boot and reports errors via snackbar notification + console:

- View columns not found in any source table
- Mirror references to non-existent tables
- Ref table references to non-existent tables
- View sources referencing non-existent tables
- Embed view references to non-existent views
- Circular embed references

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
│ Sheets │ OAuth │ CRDT (IDB+Drive) │ Firestore │ SQLite │
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
