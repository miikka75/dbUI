# dbUI

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Five backends**: Google Sheets (Apps Script), OAuth REST API, CRDT (IndexedDB + Drive sync), Firebase (Firestore), local SQLite
- **i18n**: multi-language with auto-generated translation keys from schema
- **Views**: union, join, embedded views (chips or compact table mode)
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
npm test         # run backend tests
```

Browser: click "Create Local Database" → app loads with schema from `schema.json`.

**Reset**: delete `dev/local.db` + browser `localStorage.clear(); location.reload()`

## Quick Start (Apps Script)

See `apps-script/DEPLOY.md` for deployment guide.

## Quick Start (Firebase)

1. Create project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Firestore Database + Google Auth provider
3. Add your domain to Authentication → Authorized domains
4. Register Web app → copy config JSON
5. Run the app, select Firebase mode, paste config → Sign in
6. Import data via Settings → Import from JSON

Firebase config is stored in browser localStorage. For production hosting, place `firebase-config.json` in the root directory — all users will auto-load it.

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

These properties work identically on both table and view definitions via shared `currentConfig`:

| Field | Type | Description |
|-------|------|-------------|
| `icon` | string | MDI icon for sidebar (e.g. `"mdi-table"`) |
| `filter` | object | Filter displayed rows (`{field: value}`) |
| `hideEmpty` | boolean | Hide empty fields per-row in card, hide column if ALL rows empty in table |
| `readonly` | boolean | Disable editing (cells render as text, no add/delete buttons) |
| `cardOnly` | boolean | Always render in card layout (never table) |
| `defaultSort` | string | Column to sort by on load |
| `header` | string | Static text displayed above the data area |
| `footer` | string | Static text displayed below the data area |
| `embed` | object\|array | Embed filtered data from another table/view (see Embed section) |

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
  "cardOnly": true,
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

#### Inline showIf (per column)

Conditionally show a column based on field values in the same row. Use object syntax in the `columns` array:

```json
"columns": [
  "title",
  "status",
  {"resolution": {"status": "closed"}},
  {"notes": {"type": "bug"}},
  "due_date"
]
```

- String entry → always visible
- Object entry → key is column name, value is condition (show only when condition matches)

Columns with conditions are hidden per-row in card layout when the condition doesn't match. In table layout, the column is always visible (condition is per-row, can't hide table columns per row).

---

### Embed

Embeds show filtered data from another table or view as a read-only section within a view. Renders as compact chips. Can be a single object or an array for multiple embeds.

| Field | Type | Description |
|-------|------|-------------|
| `table` | string | Source table name (use `table` OR `view`, not both) |
| `view` | string | Source view name (inherits its columns/filter/sources) |
| `filter` | object | Row filter (`{field: value}`) — only with `table` |
| `columns` | string[] | Columns to show in chips/table |
| `afterColumn` | string | Position embed after this column in card layout |
| `header` | string | Text displayed above (translation key or literal) |
| `footer` | string | Text displayed below (translation key or literal) |
| `defaultSort` | string | Column to sort embed rows by |
| `hideEmpty` | boolean | Remove columns where all rows are empty |
| `mode` | string | Render mode: `"table"` for compact table, omit for chips (default) |

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

**Render modes:**
- **Chips** (default): compact inline tags joined by `·` separators. Best for few items with few columns (quick glance).
- **Compact table** (`"mode": "table"`): read-only table with translated column headers and rows. Best for many items or many columns where you need to compare values side-by-side.

```json
// Chips (default - mode omitted)
{ "table": "tasks", "filter": {"status": "Open"}, "columns": ["title"] }

// Compact table
{ "table": "tasks", "filter": {"status": "In Progress"}, "columns": ["date", "title", "assigned_to"], "mode": "table" }
```

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
