# Schema Reference — views + nav/layout

A schema has three layers. Views are the unit of presentation: a view is one of three kinds — a
**data view** (sources/columns), a **document** (a view with a `markdown` field), or a
**rotationView** (a view with a `rotationView` field — a generated rotating-duty-roster table,
see below).

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
| `multiselect` | Multiple values from a named list (chip input); stored as an **array** of strings |
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

### multiselect

`multiselect` extends `select` — same properties (`list`, `allowNew`, `sorted`) — but a cell holds
**multiple** values:

```json
{ "name": "people", "type": "multiselect", "list": "people", "allowNew": true }
```

- **Storage**: an array of strings, e.g. `["Alex", "Sam"]` (vs. a scalar string for `select`).
- **Editor**: chip/tag input (combobox when `allowNew`, autocomplete otherwise).
- **Display**: comma-joined, list-translated, e.g. `"Alex, Sam"`.
- **`matchList`/`notMatchList`**: match on **any** array member (array membership, not scalar equality).
  Works in row `filter`, column `when`, and `filterBy`.
- **`computed` `fromColumns`**: array-valued source columns are flattened before `matchList` evaluation.
- **Backends**: object-storing backends (Firebase/Firestore, IndexedDB/CRDT) store arrays natively;
  columnar backends (dev SQLite, Google Sheets) JSON-encode the array into the text cell on write and
  decode it back on read for `multiselect` columns. Concurrent edits to the same cell are
  whole-array last-writer-wins (no element-level merge).

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
| `rotationView` | object | Makes this a **rotationView** (third view kind) — a generated rotating-roster table (see below) |

A view's `columns` may contain, besides plain column names:
- **Conditional column** `{ "name": "<col>", "when": { <cond> } }` — show the column only on rows
  matching `when` (the unified condition language; works on plain **and** computed columns).
  *Legacy shorthand `{ "<col>": { <cond> } }` is auto-canonicalized to the `{ name, when }` form at
  load (`convertViewFilters`) — prefer the explicit `when` form in new schemas.*
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
- **Array value** = IN — **retired.** `{ "status": ["open","in_progress"] }` is **auto-upgraded to
  `$or` at load** (`convertViewFilters`) and on export; the matcher itself no longer accepts raw
  arrays. **Use `$or`** in new schemas (legacy arrays keep working via the load-time upgrade).
- **`matchList` (dynamic)** = value must be in a named list: `{ "speaker": { "matchList": "guests" } }`.
  The list is resolved at runtime from the Lookup tab — adding/removing items in the list
  immediately changes which rows pass the filter. Use for filters that should stay in sync
  with user-editable lists.
- **`notMatchList` (dynamic)** = value must **not** be in a named list:
  `{ "attendee": { "notMatchList": "guests" } }`. Same dynamic resolution as `matchList`, negated.
- **`$or` / `$and`** = explicit logical groups, nestable:
  `{ "$and": [ { "city": "X" }, { "$or": [ {"status":"open"}, {"status":"in_progress"} ] } ] }`.
- **Value operators** (also usable in column `when` / conditional columns — same engine):
  `{ "col": { "notEmpty": true } }`, `{ "empty": true }`, `{ "ne": v }`.
  `notEmpty`/`empty` work on **computed** values too. Row filters and column/embed conditions share
  one matcher (`condMatches`), so **every operator above works in `filter`, `when`, and embed `when`.**

**Static vs Dynamic filtering:**
| Syntax | When to use |
|--------|-------------|
| `"col": "value"` | Fixed filter value known at schema design time |
| `{ "$or": [ {"col":"a"}, {"col":"b"} ] }` | Fixed set of values (membership; array shorthand retired) |
| `"col": { "matchList": "listName" }` | Filter should track a user-editable list (Lookup tab) |

### aggregate views (groupBy + collect)
A view with `groupBy` + `collect` groups rows by person/key and collects a column's values:
```json
{ "name": "talks", "sources": ["sessions"], "mode": "union",
  "groupBy": { "column": "person", "from": ["talk1","talk2","talk3"] },
  "collect": "date", "columns": ["person", "latest", "second", "third"] }
```
- `groupBy.column`: output key column; `groupBy.from`: source columns to scan for keys.
- `collect`: source column whose values are gathered per group (sorted descending).
- Output columns after `groupBy.column` receive the Nth collected value (most recent first).
- **`collectWith`** (optional): when set, collected values include the source column name:
  `"collectWith": "role"` → values render as `"2026-06-01 (talk1)"` instead of just `"2026-06-01"`.
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
{ "name": "visitors", "computed": { "fromColumns": ["talk1","talk2","talk3"], "matchList": "guests" } }
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

### conditional computed columns (`when`) + condition operators
Any **named or computed** column may carry a `when` clause that gates its **per-row** visibility
(card/list: hides the field on that card; table: blanks the cell). Because computed values are
resolved into the row before visibility is evaluated, a `when` can be driven by a computed column:
```json
{ "name": "guests", "computed": { "fromColumns": ["talk1","talk2"], "matchList": "guests" },
  "when": { "guests": { "notEmpty": true } } }
```
Conditions (used by `when`, row `filter`s, and embed `when` — all the same engine) match a
row when **every** field matches. Each field accepts a scalar (equality) or an operator object:

| Form | Meaning |
|------|---------|
| `{ "f": "v" }` | `row.f === "v"` (equality) |
| `{ "f": { "notEmpty": true } }` | `row.f` is truthy (set) |
| `{ "f": { "empty": true } }` | `row.f` is falsy (blank) |
| `{ "f": { "ne": v } }` | `row.f !== v` |
| `{ "$or": [...] }` / `{ "$and": [...] }` | logical groups (membership via `$or` of equalities) |
| `{ "f": { "matchList": "L" } }` / `notMatchList` | value in / not in named list |

`when`/conditional columns and row `filter`s share **one matcher** (`condMatches`), so anything
valid in a `filter` is valid in a `when` and vice-versa — `$or`/`$and`,
`matchList`/`notMatchList`, equality, and the operators above. `notEmpty`/`empty` work
on **computed** values, so you can show a column only when a computed result is present.
A `when` clause also works on an **embed** (inline, named-view, or markdown prose block) in a
view's `columns`: the embed renders per-card only when the card's row matches — e.g. a markdown
prose block placed above a column, shown only when a computed value is present:
`{ "view": "guests_heading", "bare": true, "when": { "guests": { "notEmpty": true } } }`.

### rotation columns (rotating duty rosters)

A rotating duty (e.g. "security", "cleanup crew") cycles through a **pre-authored ordered list of
groups**, one slot per occurrence, looping when exhausted. The runtime computes only
*position-in-sequence* — never *who* is in a slot (that is authored data, not arithmetic).

**Storage — one ordinary table per rotation.** No special table concept; it's editable, sortable,
and archivable like any table. Convention: a `position` number column (manual order) + a `people`
multiselect column (the group for that slot — variable size, not capped):

```json
"security_rotation": {
  "columns": [
    { "name": "position", "type": "number" },
    { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true }
  ],
  "defaultSort": "position"
}
```

> The slot's group column **must be named `people`** — the resolver reads `cells[i].people`
> (hardcoded coupling). Slots are ordered by the `position` column.

**Resolution — a `computed` column** in an ordinary view that indexes into the rotation table.
`advanceBy` declares the trigger explicitly (it is never inferred):

```json
{ "name": "security", "computed": {
    "rotationTable": "security_rotation",
    "advanceBy": "occurrence",
    "occurrenceSource": "sessions",
    "occurrenceSort": "date" } }
```
```json
{ "name": "cleanup", "computed": {
    "rotationTable": "cleanup_rotation",
    "advanceBy": "calendar",
    "interval": "weekly" } }
```

| `advanceBy` | Position formula | Use when | Extra fields |
|-------------|------------------|----------|--------------|
| `"occurrence"` | count of `occurrenceSource` rows at/before the current row (sorted by `occurrenceSort`, `id` tie-break) | the duty exists *because* a row exists (one team per session) | `occurrenceSource`, `occurrenceSort` |
| `"calendar"` | whole intervals elapsed between the anchor date and the row's date | the duty runs on a fixed schedule regardless of rows (weekly cleanup) | `interval`, anchor (from the rotation table — see below) (+ `dateField`) |

- **Output** is the slot's `people` **array** → renders via the multiselect display-join (`"Alex, Sam"`).
- **Looping** is automatic (modulo over slot count); negative-safe in calendar mode.
- **Occurrence mode** ties position to *row count*, not date math — a deleted/cancelled source row
  leaves **no gap** (every later slot shifts back by one).
- **Same-date occurrences** are disambiguated by a stable `id` tie-break: when two source rows share
  the same `occurrenceSort` value (e.g. two meetings on one date), they take **consecutive, distinct**
  slots — they do *not* get the same group. The order between them follows the rows' opaque `id`
  (creation order), which is deterministic but not user-controllable; if you need a predictable order,
  give the rows a secondary sort value (a `time`/`seq` column) and sort by it. The only ways two rows
  resolve to the *same* group are a single-slot rotation (`index % 1`) or duplicate row `id`s.
- **Calendar mode, per-row** needs a date source: it reads `dateField` (a date column on the row),
  falling back to "today" if absent. Calendar mode is primarily intended for `rotationView` (below);
  for per-row computed columns, prefer **occurrence** mode.
- **`interval`**: a named value — `"daily"`, `"weekly"`, `"monthly"`, `"yearly"` — **or** a compact
  `"<n><unit>"` form where unit is `d`/`w`/`m`/`y` (e.g. `"3w"` = every 3 weeks, `"2m"`, `"10d"`,
  `"1y"`). Day/week use uniform arithmetic; month/year use real calendar arithmetic (never days/30),
  and years normalize to 12 months. Sub-day units (hours) are **not** supported — dates are stored as
  `YYYY-MM-DD` with no time component. Unknown/typo values are **rejected at load** (no silent weekly
  fallback). Defaults to weekly when omitted.
- **Calendar anchor (DB-backed, not a schema literal)**: the anchor is the date of slot position 0.
  It is read from the **rotation table itself** — the value in the first slot's (lowest `position`)
  `anchor` date column (rename via `anchorField`, default `"anchor"`). This keeps the anchor as
  editable, synced **data** rather than a hardcoded date in `schema.json`. A literal `anchorDate` on
  the column is still accepted and **takes precedence** (handy for a fixed/printable one-off schedule);
  if neither is present the column resolves to empty. Occurrence mode ignores the anchor entirely.
- **Independent lists (R3)**: multiple rotations are separate tables; nothing couples them. To author
  two lists on a shared timeline, give each rotation table the **same first-slot `anchor` value** —
  that fixes which period is index 0 without coupling contents or lengths (different-length lists
  drift, which is correct).
- **Dependency preload**: `rotationTable` (and `occurrenceSource`) are auto-loaded into the data cache
  before resolution — they need not appear in the view's `sources`.
- **Validation** (load-time): `rotationTable` must exist; `advanceBy` must be `occurrence` or
  `calendar`; occurrence needs a resolvable `occurrenceSource`; calendar needs a **valid `interval`**
  and a **resolvable anchor** (an `anchor`/`anchorField` date column on the rotation table, or a
  literal `anchorDate`).

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

## rotationView (third view kind)
A view with a `rotationView` field renders a rotating roster across a **range of calendar periods**
at once (e.g. "next 12 weeks of cleanup duty," or a fixed printable schedule). It has **no
underlying stored rows** — every output row is *generated* by repeated calendar-mode resolver calls
— so it is neither a data view (`sources`/`columns`) nor a document (`markdown`). It's a distinct,
read-only third kind.

```json
{
  "name": "cleanup_schedule",
  "rotationView": {
    "columns": [
      { "name": "zone_a", "rotationTable": "zone_a_rotation", "advanceBy": "calendar", "interval": "weekly" },
      { "name": "zone_b", "rotationTable": "zone_b_rotation", "advanceBy": "calendar", "interval": "weekly" }
    ],
    "range": { "from": "today", "periods": 12 }
  },
  "layout": "table"
}
```

| Field | Description |
|-------|-------------|
| `rotationView.columns` | One entry per rotation, each a **calendar-mode** spec (`name`, `rotationTable`, `advanceBy: "calendar"`, `interval`). The anchor comes from each rotation table's first-slot `anchor` column (`anchorField` to rename; a literal `anchorDate` still wins if set). Resolved independently per generated row. |
| `range.from` | `"today"` for a rolling window (recomputed each open) **or** a literal `YYYY-MM-DD` for a fixed window (printing/sharing). |
| `range.periods` | A **count of intervals** to generate rows for (not an end date) — matches how calendar resolution counts elapsed intervals. |
| `layout` | `"table"` (minimum supported). |

- Generates `range.periods` rows starting at `range.from`; each row carries the period date plus one
  resolved column per rotation. The **date axis follows the first column's `interval`**.
- **Calendar-mode only** — validation rejects `advanceBy: "occurrence"` here. Occurrence-mode
  rotations render inside an ordinary data view (as a rotation computed column) where each row already
  has its own date/context, so they don't need this view kind.
- **Shared anchor** across columns aligns "which period is index 0" while keeping each list's length
  and contents independent (lists of different lengths drift relative to each other — expected). Give
  each rotation table the **same first-slot `anchor` value** to align them.
- **Read-only & recomputed**: a `rotationView` is a pure function of *(rotation-table contents, range)*
  at render time. There is no snapshot — editing a slot table changes what every past *and* future
  period resolves to on the next render. This is intended, not a gap.
- **Dependency preload**: each `rotationTable` is fetched into the data cache before generation.
- **Nav**: reference it by `name` like any view; it gets a default `mdi-calendar-clock` icon.
- **Validation** (load-time): each column's `rotationTable` must exist, `advanceBy` may only be
  `calendar`, the `interval` must be **valid**, and an anchor must be **resolvable** (an
  `anchor`/`anchorField` date column on the rotation table, or a literal `anchorDate`).

### Worked example (occurrence + calendar end-to-end)
An event needs **security** (one team per session — occurrence-driven) and a two-zone **cleanup**
rota (every week regardless of sessions — calendar-driven). Three rotation tables, one data view with
an occurrence-mode computed column, and one `rotationView` for the calendar rota:

```json
{
  "tables": {
    "sessions": {
      "columns": [
        { "name": "date", "type": "date" },
        { "name": "topic", "type": "text" }
      ],
      "archivable": true
    },

    "security_rotation": {
      "columns": [
        { "name": "position", "type": "number" },
        { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true }
      ],
      "defaultSort": "position"
    },
    "zone_a_rotation": {
      "columns": [
        { "name": "position", "type": "number" },
        { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true },
        { "name": "anchor", "type": "date" }
      ],
      "defaultSort": "position"
    },
    "zone_b_rotation": {
      "columns": [
        { "name": "position", "type": "number" },
        { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true },
        { "name": "anchor", "type": "date" }
      ],
      "defaultSort": "position"
    }
  },

  "views": [
    {
      "name": "session_schedule",
      "sources": ["sessions"],
      "layout": "table",
      "defaultSort": "date",
      "columns": [
        "date",
        "topic",
        { "name": "security", "computed": {
            "rotationTable": "security_rotation",
            "advanceBy": "occurrence",
            "occurrenceSource": "sessions",
            "occurrenceSort": "date" } }
      ]
    },
    {
      "name": "cleanup_schedule",
      "rotationView": {
        "columns": [
          { "name": "zone_a", "rotationTable": "zone_a_rotation", "advanceBy": "calendar", "interval": "weekly" },
          { "name": "zone_b", "rotationTable": "zone_b_rotation", "advanceBy": "calendar", "interval": "weekly" }
        ],
        "range": { "from": "today", "periods": 12 }
      },
      "layout": "table"
    }
  ],

  "nav": {
    "items": [
      { "view": "session_schedule", "icon": "mdi-shield-account" },
      { "view": "cleanup_schedule" },
      { "group": "Rotations", "icon": "mdi-rotate-3d-variant", "items": [
        { "table": "security_rotation" },
        { "table": "zone_a_rotation" },
        { "table": "zone_b_rotation" }
      ] }
    ]
  }
}
```

**How it resolves.** Say the slot tables are authored as:

| table | position 1 | position 2 | position 3 |
|-------|-----------|-----------|-----------|
| `security_rotation` | `["Alex"]` | `["Sam","Jordan"]` | `["Riley"]` |
| `zone_a_rotation` | `["Alex"]` (anchor `2026-01-01`) | `["Sam"]` | — |
| `zone_b_rotation` | `["Riley"]` (anchor `2026-01-01`) | `["Jordan"]` | `["Casey"]` |

(`security_rotation` is occurrence-mode, so it needs no `anchor`. The two calendar zone tables carry
the anchor on their **first slot** — both `2026-01-01` so they align at period 0.)

- **`session_schedule`** (occurrence): sessions sorted by `date`; the 1st session → `security` =
  `"Alex"`, 2nd → `"Sam, Jordan"`, 3rd → `"Riley"`, **4th loops** → `"Alex"`. Deleting the 2nd
  session shifts every later session back one slot (no gap).
- **`cleanup_schedule`** (calendar `rotationView`): 12 weekly rows from today. Both zone tables' first
  slot carries `anchor: "2026-01-01"`, so period 0 is the same week for both — but they keep
  independent lengths, so `zone_a` (2 slots) loops every 2 weeks while `zone_b` (3 slots) loops every
  3 weeks, drifting against each other (expected).
- The slot tables stay directly editable in the **Rotations** nav group; both schedules recompute on
  next render.

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
is **fully removed** — there is no longer any runtime handling for it (the old `_stripTextEntries`
load-time stripper was deleted). Author prose with a `markdown` view instead (a filtered view +
markdown + another view replaces text-between-columns). **Legacy schemas with `text` entries must be
upgraded with `migrate-schema.js`** (which converts `text` → `markdown` doc-views) before deploying —
otherwise the entries would surface as phantom columns. Do not author new `text` entries.

## Migration
`migrate-schema.js <schema-or-export>.json` normalizes a schema:
- Flattens nested `views` → top-level entries; rebuilds the hierarchy in `nav.items`.
- Adds the formerly-implicit admin tables; excludes lookups.
- Converts `text` entries to a `markdown` view: splits the view at **every** text boundary
  into sub-views (`name`, `name_2`, …) and interleaves `{{t:key}}` tokens with one
  `{{view:subview}}` embed per run of real columns; points nav at the markdown view.
- Converts a legacy `pages` map into `markdown` views and rewrites `{page:x}` nav → `{view:x}`.
  (The runtime no longer auto-folds `pages` at load — older schemas **must** be re-migrated
  with this tool before loading.)
- Converts a legacy table `header`/`footer` into a `markdown` doc-view that embeds the table
  (`<table>_doc` with `{{table:<name>}}`); the old behavior emitted now-removed `text` entries.
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
