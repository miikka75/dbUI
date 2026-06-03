# Schema Reference — pages + flat views + nav/layout

The schema splits the two concerns a flat `views` array would conflate — *what a view is* vs
*how the sidebar is structured* — into three layers, and adds a markdown **content** layer on top.

```
pages   ← markdown documents that embed views/tables  (content layer)
views   ← flat, named, reusable data components        (no nesting)
tables  ← raw data + partitions
nav     ← navigation tree + layout, references the above by name
```

`nav` is **required** and defines the sidebar (there is no auto-derived nav). `pages` is
optional; `views` and `tables` are flat (no nesting).

## tables
```json
"tables": { "tasks": { "columns": [...], "archivable": true } }
```
`archivable: true` enables archive/restore for the table (rows move between the fixed
`active` and `archive` partitions). Omit it for tables that are never archived.

## views (flat)
Named, reusable. Views are flat — hierarchy lives in `nav` (no `views.views` nesting).
```json
"views": [
  { "name": "combined", "sources": ["tasks","notes"], "mode": "join", "columns": [...] },
  { "name": "attendance", "sources": ["tasks","notes"], "mode": "union", "groupBy": {...}, "collect": "date", "columns": [...] }
]
```

## pages (markdown + embedded views)
```json
"pages": {
  "home": { "markdown": "# Welcome\n\nOpen items:\n\n{{view:combined}}\n\nAll meetings:\n\n{{table:tasks}}" }
}
```
- Embed tokens: `{{view:<name>}}` and `{{table:<name>}}` render the live data inline.
  Embeds are **interactive**: inline cell editing plus add/delete/archive row controls
  (gated by the same read-only/permission rules as the main grid).
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
- **Page bodies are stored on the server** in a `_pages` collection (one row per page,
  `{id, markdown}`) — NOT in `schema.json`. Edit in-app via the Edit toggle in the page
  corner → textarea → Save (persists via `putRow`). A schema-defined `pages.<name>.markdown`
  acts only as a seed/fallback until the page is first saved.

## nav (structure + layout)
```json
"nav": {
  "layout": "drawer",            // "drawer" (default) | "tabs" (top, desktop)
  "items": [
    { "page": "home", "icon": "mdi-home" },
    { "group": "Data", "icon": "mdi-database", "items": [ { "view": "combined" }, { "table": "tasks" } ] },
    { "view": "attendance" }
  ]
}
```
- Item kinds: `{page}`, `{view}`, `{table}`, or `{group, items:[...]}` (one level).
- Each item: optional `icon`, `title`. Access-filtered (a view needs all its sources).
- System tabs (Lookup / Languages / Settings) are appended automatically.

## `text` entries (removed)
The `{ "text": "<key>" }` column entry (free-form text interleaved in a view's columns)
is **removed**: it is no longer rendered — any leftover `text` entries are silently ignored.
Author prose in a `pages` markdown document instead (a filtered view + markdown + another
view replaces text-between-columns). `migrate-schema.js` converts existing `text` to
pages automatically. Do not author new `text` entries.

## Migration
`migrate-schema.js <schema-or-export>.json` normalizes a schema to the current format:
- Flattens nested `views` → top-level entries; rebuilds the hierarchy in `nav.items`.
- Adds the formerly-implicit admin tables; excludes lookups.
- Converts `text` entries to a `pages` entry: splits the view at **every** text boundary
  into sub-views (`name`, `name_2`, …) and interleaves `{{t:key}}` tokens with one
  `{{view:subview}}` embed per run of real columns; repoints nav to the page.
- **Export bundles**: if the input has a `.schema` key (an exported JSON with `tables` data,
  `lists`, `translations`), only `schema` is migrated in place; data/lists/translations are
  preserved, so the result re-imports cleanly.

## Translation keys
- `page.<name>` (page title), `nav.<group>` (group label), page `{{t:<key>}}` tokens,
  plus existing `view.*` / `field.*` / `list.*`.
