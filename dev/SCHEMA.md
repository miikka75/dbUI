# Schema Reference — views + nav/layout

A schema has three layers. Views are the unit of presentation: a view is either a **data view**
(sources/columns) or a **document** (a view with a `markdown` field).

```
icon    ← optional favicon (data URI, relative path, or URL — cached as base64 on first load)
title   ← optional document/tab title
views   ← flat, named components: data views, or views with markdown (documents)
tables  ← raw data + partitions
nav     ← navigation tree + layout, references views/tables by name
```

## icon + title
```json
{ "icon": "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='28' font-size='28'>📋</text></svg>" }
```
- **`icon`** — sets the browser favicon **and** the PWA install icon. Accepts:
  - `data:` URI (inline SVG/PNG — recommended, no network)
  - Relative path (`"./favicon.png"`)
  - External URL (`"https://..."`) — fetched once, cached as base64 in localStorage; re-fetched when the URL changes
  - Also drives the **PWA manifest icon** (remote icons are embedded as the cached base64) and
    the **apple-touch-icon** for iOS (PNG used directly; SVG rasterized to a 180×180 PNG via
    canvas). See the README "Installable (PWA)" section.
- **Browser tab title** — derived from the `app.title` translation key (set in Languages tab), not a schema field. The tab title updates reactively when the translation changes.

`nav` is **required** and defines the sidebar (there is no auto-derived nav). `views` and
`tables` are flat (no nesting; hierarchy lives in `nav`).

## tables
```json
"tables": { "tasks": { "columns": [...], "archivable": true } }
```
`archivable: true` enables archive/restore for the table (rows move between the fixed
`active` and `archive` partitions). Omit it for tables that are never archived.
`isLookup: true` marks a reference/lookup table (managed in the Lookup tab, not the sidebar).

> **`id` is implicit** — every table gets an `id` column auto-injected (storage primary key +
> join/archive match key). Do not declare it in `columns`.

### column types
| Type | Description |
|------|-------------|
| `text` | Plain text (default) |
| `date` | Date picker, stored as `YYYY-MM-DD` |
| `select` | Dropdown from a named list |
| `ref` | Reference to a lookup-table column |

### column properties
| Property | Description |
|----------|-------------|
| `name` | Column identifier (required) |
| `type` | Column type (default `"text"`) |
| `hidden` | Don't display in UI (e.g. `created_at`) |
| `list` | List name for `select` type |
| `allowNew` | Allow adding new list values (combobox) |
| `sorted` | Sort dropdown items alphabetically |
| `syncFrom` | Mirror this column's value from another table |
| `table` | Reference table name (for `ref`) |
| `valueCol` | Column used as value (for `ref`) |
| `filterBy` | Filter ref options by another column (for `ref`) |

```json
"tasks": {
  "columns": [
    { "name": "date", "type": "date" },
    { "name": "status", "type": "select", "list": "status" },
    { "name": "assigned_to", "type": "select", "list": "assigned_to", "allowNew": true, "sorted": true },
    { "name": "city", "type": "ref", "table": "cities", "valueCol": "city", "filterBy": {"state": "state"} }
  ],
  "archivable": true
}
```

## views (flat)
Named, reusable. Views are flat — hierarchy lives in `nav` (no `views.views` nesting).
```json
"views": [
  { "name": "combined", "sources": ["tasks","notes"], "mode": "join", "columns": [...] },
  { "name": "attendance", "sources": ["tasks","notes"], "mode": "union", "groupBy": {...}, "collect": "date", "columns": [...] }
]
```

### view properties
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | View identifier |
| `sources` | string[] | Table names to pull data from |
| `mode` | string | `"union"` (stack rows) or `"join"` (merge by `id`) |
| `columns` | array | Column names, embeds, conditional/computed columns (below) |
| `filter` | object | Static row filter (see **filters**) |
| `readonly` | boolean | Disable editing (report views) |
| `layout` | string | `"table"`, `"card"`, or `"list"` |
| `collapsed` | boolean | Cards start collapsed (accordion) |
| `defaultSort` | string | Default sort column |
| `hideEmpty` | boolean | Hide columns where all rows are empty |
| `icon` | string | MDI icon for the sidebar |
| `printable` | `"view"` \| `"cards"` \| `["view","cards"]` | Opt-in print buttons. `"view"` = view toolbar print only; `"cards"` = per-card buttons only; `["view","cards"]` = both. **Off by default** — omit to hide all print buttons. Note: per-card buttons only render in `card`/`list` layout, so `"cards"` on a `table` layout shows nothing. Applies to views and tables |
| `markdown` | string | Makes this a **document** view (see below) instead of a data grid |

A view's `columns` may contain, besides plain column names:
- **Conditional column** `{ "<col>": { <filter> } }` — show the column only for rows matching the filter.
- **Inline embed** `{ "sources": [...], "filter": {...}, "columns": [...] }` — a filtered sub-table at that position.
- **Named-view embed** `{ "view": "<name>", "filter": {...}, "hideEmpty": true, "bare": true }` — embed a defined
  view (reuses its sources/columns/mode), with the entry's `filter`/`hideEmpty`/`bare` overriding.
  If the named view has `markdown`, its document (header + nested embeds + footer) renders
  inline at that position; the whole block is hidden when all its embedded tables are empty.
  `"bare": true` suppresses the box wrapper (background + padding + border-radius) — the embed
  renders flush with the card content. Applies to both screen and print.
  > **Markdown columns** must go through a named-view embed: there is **no** inline
  > `{ "markdown": "..." }` column (it would be treated as a data column named `markdown`).
  > Define a `{ "name": "x", "markdown": "..." }` doc-view and reference it with `{ "view": "x" }`.
- **Per-column hideEmpty** `{ "name": "<col>", "hideEmpty": true|false }` — override the view-level
  `hideEmpty` for a specific column. `false` forces the column to always show (even when empty);
  `true` hides it when empty even if the view shows empties. Works in both table and card layout.

### filters
A `filter` (on a view, an inline/named-view embed, or a conditional column) matches rows:
- **Flat object** = AND of equality: `{ "status": "open", "city": "X" }` -> `status==open AND city==X`.
- **Array value** = IN (OR on one column): `{ "status": ["open", "in_progress"] }`.
- **`matchList` (dynamic)** = value must be in a named list: `{ "speaker": { "matchList": "guests" } }`.
  The list is resolved at runtime from the Lookup tab — adding/removing items in the list
  immediately changes which rows pass the filter. Use for filters that should stay in sync
  with user-editable lists.
- **`$or` / `$and`** = explicit logical groups, nestable:
  `{ "$and": [ { "city": "X" }, { "$or": [ {"status":"open"}, {"status":"in_progress"} ] } ] }`.

**Static vs Dynamic filtering:**
| Syntax | When to use |
|--------|-------------|
| `"col": "value"` | Fixed filter value known at schema design time |
| `"col": ["a","b","c"]` | Fixed set of values known at schema design time |
| `"col": { "matchList": "listName" }` | Filter should track a user-editable list (Lookup tab) |

### aggregate views (groupBy + collect)
A view with `groupBy` + `collect` groups rows by person/key and collects a column's values:
```json
{ "name": "puheet", "sources": ["kokoukset"], "mode": "union",
  "groupBy": { "column": "person", "from": ["puhe1","puhe2","puhe3"] },
  "collect": "pvm", "columns": ["person", "edellinen", "toinen", "kolmas"] }
```
- `groupBy.column`: output key column; `groupBy.from`: source columns to scan for keys.
- `collect`: source column whose values are gathered per group (sorted descending).
- Output columns after `groupBy.column` receive the Nth collected value (most recent first).
- **`collectWith`** (optional): when set, collected values include the source column name:
  `"collectWith": "role"` → values render as `"2026-06-01 (puhe1)"` instead of just `"2026-06-01"`.
  Useful for cross-table aggregates where you need to see *which role* produced each entry.

### filterBy (per-card master-detail)
A `{view}` column embed with `filterBy` dynamically filters embed rows per card:
```json
{ "view": "tasks_view", "filterBy": { "owner": "name" } }
```
- Maps embed column (`owner`) to the current card's column (`name`).
- Each card shows only rows where `task.owner === card_row.name`.
- Only works in `card`/`list` layout (one card per row hosts the per-row embed).
- Combine with `hideEmpty: true` to hide the embed when a card has no matching rows.
- **`matchList` in filterBy**: `{ "speaker": { "matchList": "guests" } }` — show embed rows
  where `speaker` value is in the named list (same syntax as in `filter`).

### computed columns
A column with `computed` derives its value from other columns at render time (not stored):
```json
{ "name": "visitors", "computed": { "fromColumns": ["puhe1","puhe2","puhe3"], "matchList": "guests" } }
```
- **Collect from list** (`matchList` as string): gathers values from `fromColumns` that exist
  in the named list, joins with ", ". Output is empty if no matches.
- **Categorize by list** (`matchList` as object): checks which list contains the `fromColumn`
  value, outputs the mapped label:
  ```json
  { "name": "type", "computed": { "fromColumn": "person", "matchList": { "members": "Internal", "guests": "External" } } }
  ```
- Computed columns are read-only (no cell editor renders for them).
- They appear in the view's visible columns and in card/table layout.

## markdown (documents)
A view with a `markdown` field renders as a **document** instead of a data grid:
```json
{ "name": "home", "markdown": "# Welcome\n\nOpen items:\n\n{{view:combined}}\n\nAll tasks:\n\n{{table:tasks}}" }
```
- Embed tokens: `{{view:<name>}}` and `{{table:<name>}}` render the live data inline.
  Embeds are **interactive**: inline cell editing plus add/delete/archive row controls
  (gated by the same read-only/permission rules as the main grid).
- **Own grid** `{{self}}` — render *this* view's own data grid at that position. Use it when a
  view has both `sources`/`columns` and `markdown`, so one view is prose **plus** its own data
  (no need to name itself in an embed token).
- **Conditional views**: a view with a `filter` (e.g. `{"status":"open"}`) embeds only its
  matching rows — embed several filtered views to compose a report.
- **Hide when empty**: append `?` to a token (`{{view:open?}}`) to skip the embed entirely
  when its view/table yields 0 rows.
- **Archived data**: append `@<partition>` to embed a non-active partition, e.g.
  `{{table:tasks@archive}}` or `{{view:report@archive?}}`. Partitioned embeds are **read-only**.
  (Requires the partition to be preloaded — on by default via the `preload_archive` setting.)
- Translatable text: `{{t:<key>}}` resolves via the translations store and is collected
  into the Languages tab as a translation key.
- Markdown supports headings, bold/italic, lists, links, paragraphs.
- **Bodies are stored on the server** in a `_pages` collection (one row per view,
  `{id, markdown}`) — NOT in `schema.json`. Edit in-app via the Edit toggle in the corner →
  textarea → Save (persists via `putRow`). The view's schema `markdown` acts only as a
  seed/fallback until first saved.

## nav (structure + layout)
```json
"nav": {
  "layout": "drawer",            // "drawer" (default) | "tabs" (top, desktop)
  "items": [
    { "view": "home", "icon": "mdi-home" },
    { "group": "Data", "icon": "mdi-database", "items": [ { "view": "combined" }, { "table": "tasks" } ] },
    { "view": "attendance" }
  ],
  "bottomNav": ["home", "combined", "attendance"]
}
```
- Item kinds: `{view}`, `{table}`, or `{group, items:[...]}` (one level). A `{view}` may point
  at a data view or a view with `markdown`.
- Each item: optional `icon`, `title`. Access-filtered (a view needs all its sources).
- System tabs (Lookup / Languages / Settings) are appended automatically.
- **`bottomNav`** (string[], optional) — **mobile only**: view/table ids shown in the bottom
  navigation bar, in this order. More than 5 → the first 4 plus a "⋯ More" button that opens the
  drawer. Omit to auto-pick the first 5 flattened nav items. Ids must match `items` entries
  (including nested group children); unresolved ids are silently dropped.

## `text` entries (removed)
The `{ "text": "<key>" }` column entry (free-form text interleaved in a view's columns)
is **removed**: it is no longer rendered — any leftover `text` entries are silently ignored.
Author prose with a `markdown` view instead (a filtered view + markdown + another view
replaces text-between-columns). `migrate-schema.js` converts existing `text` automatically.
Do not author new `text` entries.

## Migration
`migrate-schema.js <schema-or-export>.json` normalizes a schema:
- Flattens nested `views` → top-level entries; rebuilds the hierarchy in `nav.items`.
- Adds the formerly-implicit admin tables; excludes lookups.
- Converts `text` entries to a `markdown` view: splits the view at **every** text boundary
  into sub-views (`name`, `name_2`, …) and interleaves `{{t:key}}` tokens with one
  `{{view:subview}}` embed per run of real columns; points nav at the markdown view.
- Converts a legacy `pages` map into `markdown` views (also folded in automatically at load,
  so older schemas keep working without re-migration).
- **Export bundles**: if the input has a `.schema` key (an exported JSON with `tables` data,
  `lists`, `translations`), only `schema` is migrated in place; data/lists/translations are
  preserved, so the result re-imports cleanly.

## Lists and translations
- **List values** are stored as stable keys (e.g. `"in_progress"`, not "In Progress").
- **Display** uses translations: `list.status.in_progress` → "Käynnissä" / "In Progress".
- **Locked values**: list values referenced in schema filters are auto-seeded and non-deletable.
- **Translation keys** are auto-generated: `tab.*`, `view.*`, `field.*`, `list.*.*`,
  `nav.<group>` (group labels), and `{{t:<key>}}` tokens in markdown views — all collected
  into the Languages tab.
