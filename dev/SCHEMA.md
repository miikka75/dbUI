# Schema Reference — views + nav/layout

A schema has three layers. Views are the unit of presentation: each view is one **kind**, selected by
which field it carries — a **data view** (sources/columns), a **document** (`markdown`), a
**rotationView** (`rotation` — a generated rotating-duty-roster table), a **calendar** (`calendar`),
a **pivot** (`pivot` — a cross-tab grid), or an **rsvp** (`rsvp` — a self-service signup sheet).
All of these are documented below.

```
icon    ← optional favicon (data URI, relative path, or URL — cached as base64 on first load)
title   ← optional document/tab title
theme   ← optional brand palette (light/dark colors — see ## theme)
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

### `archiveAfter` — file finished rows away on their own
```json
"chore_log": {
  "archivable": true,
  "columns": [ …, { "name": "updated_at", "type": "text", "hidden": true } ],
  "archiveAfter": { "column": "status", "values": ["approved", "rejected"], "days": 7 }
}
```
A row whose `column` holds one of `values` moves to the **archive** partition once it has gone `days`
without an edit — so a log keeps showing the recent past and settles itself, with nobody filing rows by
hand. Reversible from the archive tab like any other archived row.

- **The clock is `updated_at`**, which every write stamps. So it means "finished and left alone for N
  days", not "N days since the status changed": correcting a note restarts the countdown, which is the
  forgiving reading — a row someone is still touching isn't done with. A row with no `updated_at` is
  never swept.
- **The table must DECLARE `updated_at`** (`type: "text"`, `hidden: true`). Columnar backends (dev
  SQLite, Sheets) store only declared columns, so without it the timestamp is dropped and nothing ever
  ages out. `validateSchema` rejects the combination rather than letting it fail silently — as it does
  a missing `archivable`, an unknown `column`, empty `values`, or a negative `days`.
- **Client-side and best-effort**: the sweep runs at load, only for someone who could archive by hand
  anyway (write access to the whole mirror cluster), and does nothing on a read-only grant. There is no
  server-side scheduler, so rows age out the next time somebody with rights opens the app — a
  concurrent second run is harmless.
- `days: 0` archives as soon as the row reaches a listed value.
- **Mind what totals the table feeds.** Archiving removes a row from every ordinary view, so a
  leaderboard or balance over the same table needs `includeArchive: true` or it will quietly shed
  points as rows age out — the chores example turns it on for exactly that reason.

> **`id` is implicit** — every table gets an `id` column auto-injected (storage primary key +
> join/archive match key). Do not declare it in `columns`.

### column types
| Type | Description |
|------|-------------|
| `text` | Plain text (default) |
| `number` | Numeric value (used e.g. as a `rotation`/`reorderable` position, and by pivot `sum`) |
| `date` | Date picker, stored as `YYYY-MM-DD` |
| `select` | Dropdown from a named list |
| `multiselect` | Multiple values from a named list (chip input); stored as an **array** of strings |
| `ref` | Reference to a lookup-table column |
| `url` | A link — stored as a URL **string**; the cell shows an editable field + an open-in-new-tab icon, and a clickable link in read-only views |
| `image` | An image — stored as a URL **string** (never the bytes). On a backend with file storage (**Firebase Storage** in prod, or the **local dev server** in development) the cell is an **upload** button that stores the file and saves the returned URL; backends without an uploader degrade to a paste-a-URL field. Read-only views show a thumbnail linking to the full image |
| `owner` | Per-row access primitive — **auto-stamped** with the current user's email on create, **read-only** thereafter. Backs the `rsvp` view and owner-scoped Firestore rules (a member may write only their own owner-stamped rows). See `## rsvp` and **Self-service tables** below. |

### column properties
| Property | Description |
|----------|-------------|
| `name` | Column identifier (required) |
| `type` | Column type (default `"text"`) |
| `hidden` | Don't display in UI (e.g. `created_at`) |
| `list` | List name for `select` type |
| `allowNew` | Allow adding new list values (combobox) |
| `sorted` | Sort dropdown items alphabetically |
| `picker` | Input widget for a single `select` column: `"chips"` (selectable chips) or `"toggle"` (segmented buttons); omit for the default dropdown. Applies wherever the column is edited (any view). Deselecting the current value clears the cell. Ignored with `allowNew` (which needs free-text entry) and for `multiselect` (already chips). Same widget vocabulary as the `rsvp` view's `picker`. |
| `syncFrom` | Mirror this column's value from another table |
| `default` | A literal seeded into the cell when a row is **created** (`"default": "logged"`), then freely editable. Use it so a new row starts in a sensible state — a status column that begins blank leaves the row outside every lane and filter that names a value. Prefer an explicit value over "whatever is first in the list": list order is data and can be reordered |
| `defaultFrom` | Seed the cell when a row is **created**. Only token: `"@me"` = the signed-in user's identity, resolved exactly as the `@me` filter does for that column (a `userlink` list's curated value, else the profile display name) (blank when they have none, like the `@me` filter). Takes precedence over `default` if both are set. Unlike `owner`, the value stays editable afterwards — use it so a self-service row is attributed to its author by default without hard-wiring it |
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
| `includeArchive` | boolean | Read the **archive** partition alongside the active one. A view sees only active rows by default, which is right for a worklist and wrong for a TOTAL: with `archiveAfter` in play, a sum that nets one thing against another goes wrong the moment either side ages out. Turn it on for balances, leaderboards and any cross-tab of history. Needs the archive preloaded (`preload_archive`, on by default) |
| `layout` | string | `"table"`, `"card"`, or `"list"`. **`list` is a reading layout**: compact single-line rows with values rendered read-only, so a row added there has no editor and must be filled in elsewhere. Add/delete/archive are still offered (a *table* may declare `list` as its only presentation), but use `table`/`card` for any view people actually enter data into |
| `collapsed` | boolean | Cards start collapsed (accordion) |
| `defaultSort` | string | Default sort column |
| `hideEmpty` | boolean | Hide columns where all rows are empty |
| `icon` | string | MDI icon for the sidebar |
| `printable` | `"view"` \| `"cards"` \| `["view","cards"]` | Opt-in print buttons. `"view"` = view toolbar print only; `"cards"` = per-card buttons only; `["view","cards"]` = both. **Off by default** — omit to hide all print buttons. Note: per-card buttons only render in `card`/`list` layout, so `"cards"` on a `table` layout shows nothing. Applies to views and tables |
| `markdown` | string | Makes this a **document** view (see below) instead of a data grid |
| `access` | string[] | **Doc-views only.** Restrict the page to users granted at least one of these tables (see "Restricting a page to some users" below). Omit = visible to all registered users |
| `rotation` | object | Makes this a **rotationView** (third view kind) — a generated rotating-roster table (see below) |
| `obscureNames` | boolean \| string[] | Display-only privacy: abbreviate person names to "First L." in this view. `true` = all list/multiselect columns (or all area columns of a rotationView); an array = exactly those columns. Stored data is untouched |

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
- **`matchList` (dynamic)** = value must be in a named list: `{ "assignee": { "matchList": "leads" } }`.
  The list is resolved at runtime from the Lookup tab — adding/removing items in the list
  immediately changes which rows pass the filter. Use for filters that should stay in sync
  with user-editable lists.
- **`notMatchList` (dynamic)** = value must **not** be in a named list:
  `{ "attendee": { "notMatchList": "leads" } }`. Same dynamic resolution as `matchList`, negated.
- **`$or` / `$and`** = explicit logical groups, nestable:
  `{ "$and": [ { "city": "X" }, { "$or": [ {"status":"open"}, {"status":"in_progress"} ] } ] }`.
- **Value operators** (also usable in column `when` / conditional columns — same engine):
  `{ "col": { "notEmpty": true } }`, `{ "empty": true }`, `{ "ne": v }`,
  and the ordered comparisons `{ "lt": v }` / `{ "gt": v }` / `{ "lte": v }` / `{ "gte": v }`.
  `notEmpty`/`empty` work on **computed** values too. Row filters and column/embed conditions share
  one matcher (`condMatches`), so **every operator above works in `filter`, `when`, and embed `when`.**

**Static vs Dynamic filtering:**
| Syntax | When to use |
|--------|-------------|
| `"col": "value"` | Fixed filter value known at schema design time |
| `{ "$or": [ {"col":"a"}, {"col":"b"} ] }` | Fixed set of values (membership; array shorthand retired) |
| `"col": { "matchList": "listName" }` | Filter should track a user-editable list (Lookup tab) |
| `"col": "@me"` | Resolves to the signed-in user's identity **for that column**: on a `userlink` list, the curated value linked to their account; otherwise their **profile display name** (see **user profiles**). No identity → matches nothing (fail-closed). Works in `filter`, `groupBy.filter`, calendar `sources[].filter`, rotation `filter`, and embeds. Display-only — never widens server-enforced access. |
| `"col": { "within": "@month" }` | Date column falls in the current period. Token: `@today`/`@week`/`@month`/`@year`, with an optional **back-offset** (`@month-1` = last month, `@week-2` = two weeks ago). Recomputed from *today* each render, so it **auto-resets** (a `@month` leaderboard rolls to the new month); weeks are Monday-start; unknown tokens match nothing. Ideal for a period-scoped `groupBy.filter` (e.g. this-month leaderboard). |

### aggregate views (groupBy + collect)
A view with `groupBy` + `collect` groups rows by person/key and collects a column's values:
```json
{ "name": "presenters", "sources": ["events"], "mode": "union",
  "groupBy": { "column": "person", "from": ["slot1","slot2","slot3"] },
  "collect": "date", "columns": ["person", "latest", "second", "third"] }
```
- `groupBy.column`: output key column; `groupBy.from`: source columns to scan for keys.
- `collect`: source column whose values are gathered per group (sorted descending).
- Output columns after `groupBy.column` receive the Nth collected value (most recent first).
- **`collectWith`** (optional): when set, collected values include the source column name:
  `"collectWith": "role"` → values render as `"2026-06-01 (slot1)"` instead of just `"2026-06-01"`.
  Useful for cross-table aggregates where you need to see *which role* produced each entry.

#### Leaderboard totals (`aggregate` count/sum)
Instead of `collect`, use `aggregate` to produce one **numeric** row per group, ranked highest-first:
```json
{ "name": "leaderboard", "sources": ["chore_log"], "mode": "union",
  "groupBy": { "column": "person", "from": ["person"] },
  "compute": [ { "name": "points", "computed": { "lookup": { "table": "chores", "match": "chore", "field": "points" } } } ],
  "aggregate": { "sum": "points", "into": "total" },
  "columns": ["person", "total"] }
```
- `aggregate.count: true` → number of rows per group; `aggregate.sum: "<col>"` → numeric total of that
  column per group. `into` = output column name (default `"total"`).
- Results are returned **sorted by total descending** (a ranking).
- **Scoping:** put a **row/date filter** in the top-level `filter` (applied to source rows before
  grouping — e.g. `"filter": { "done_on": { "within": "@month" } }` for this month's board). Use
  `groupBy.filter` only to restrict by the **group key** itself (e.g. `{ "person": "@me" }` for just my
  own row) — a date filter there won't work because `groupBy.filter` matches the key, not source columns.
- **`period` navigation** (optional): set `"period": "month"` (or `week`/`year`) to show ‹ › controls
  that step a back-offset into the view's bare `@period` tokens (`@month` → `@month-1` = last month…),
  letting users browse past periods. Offset resets to the current period when you open the view.
- **`view.compute`**: an array of computed defs resolved on the **source rows before grouping** — so an
  aggregate can `sum` a *looked-up* (or otherwise computed) per-row value, not just a stored column.
  These are preparation-only (not displayed); the displayed columns are `columns`.
- **Signed totals across two tables** (`source` + `scale` on a compute def): in a **union** view each row
  is tagged with its origin table, and `"source": "<table>"` restricts a def to those rows while
  `"scale": -1` negates its result. Two defs writing the **same** output column — one per table, one
  negated — let a single `aggregate.sum` produce a *balance* (earned minus spent), which one `sum` over
  one table cannot. Rows no def matched leave the column unset and contribute nothing (not a zero).
  `scale` is ignored for non-numeric results.

  ```json
  { "name": "balance", "sources": ["chore_log", "reward_claim"], "mode": "union",
    "groupBy": { "column": "person", "from": ["person"] },
    "compute": [
      { "name": "delta", "source": "chore_log",
        "computed": { "lookup": { "table": "ref_chores", "match": "chore", "field": "points", "default": 0 } } },
      { "name": "delta", "source": "reward_claim", "scale": -1,
        "computed": { "lookup": { "table": "ref_rewards", "match": "reward", "field": "cost", "default": 0 } } }
    ],
    "aggregate": { "sum": "delta", "into": "balance" },
    "columns": ["person", "balance"] }
  ```
  The two tables usually have different date/status column names, so scope such a view with `$or`
  (`{ "$or": [ {"status":"approved"}, {"status":"granted"} ] }`) rather than a flat equality.

##### Worked example — chores with per-chore points → ranked leaderboard
The demo schema (`dev/schema.json`) wires this up: a `chores` ref table holds each chore's point value,
`chore_log.chore` is a `ref` into it, and the `leaderboard` view sums the looked-up points per person.
Structure is in the schema; you add the rows at runtime. Example data:

| `chores` (ref table) | points |
|---|---|
| Dishes | 2 |
| Vacuum | 3 |
| Mow lawn | 5 |

| `chore_log` | person | chore | done_on |
|---|---|---|---|
| | Ann | Dishes | 2026-07-01 |
| | Ann | Mow lawn | 2026-07-02 |
| | Ann | Dishes | 2026-07-05 |
| | Bob | Vacuum | 2026-07-03 |

The `points` lookup resolves each log row (2, 5, 2, 3), then `aggregate.sum` totals per person and ranks:

| Leaderboard | total |
|---|---|
| Ann | 9 |
| Bob | 3 |

Scope it to a period by adding a date `filter` (or, once built, a `{ "done_on": { "within": "@month" } }`
token); scope to the current user with `groupBy.filter: { person: "@me" }`.

### filterBy (per-card master-detail)
A `{view}` column embed with `filterBy` dynamically filters embed rows per card:
```json
{ "view": "tasks_view", "filterBy": { "owner": "name" } }
```
- Maps embed column (`owner`) to the current card's column (`name`).
- Each card shows only rows where `task.owner === card_row.name`.
- Only works in `card`/`list` layout (one card per row hosts the per-row embed).
- Combine with `hideEmpty: true` to hide the embed when a card has no matching rows.
- **`matchList` in filterBy**: `{ "assignee": { "matchList": "leads" } }` — show embed rows
  where `assignee` value is in the named list (same syntax as in `filter`).

### computed columns
A column with `computed` derives its value from other columns at render time (not stored):
```json
{ "name": "flagged", "computed": { "fromColumns": ["slot1","slot2","slot3"], "matchList": "leads" } }
```
- **Collect from list** (`matchList` as string): gathers values from `fromColumns` that exist
  in the named list, joins with ", ". Output is empty if no matches.
- **Categorize by list** (`matchList` as object): checks which list contains the `fromColumn`
  value, outputs the mapped label:
  ```json
  { "name": "type", "computed": { "fromColumn": "person", "matchList": { "members": "Internal", "leads": "External" } } }
  ```
- **Lookup a field** (`lookup`): denormalize one field from another (keyed / `ref`) table into the row.
  Matches this row's `lookup.match` column against the target table's `lookup.on` column (defaults to the
  same name) and copies `lookup.field` (or `lookup.default` when there's no match):
  ```json
  { "name": "points", "computed": { "lookup": { "table": "chores", "match": "chore", "field": "points" } } }
  ```
  General-purpose — chore→points, member→role/phone, room→capacity, category→colour, etc. Pairs with
  `view.compute` + `aggregate.sum` to total a looked-up value (see **Leaderboard totals**).
- **Age of a row** (`daysSince`): whole days from a date column to today, as a **number** (negative for a
  future date, `""` when the date is blank or unparseable):
  ```json
  { "name": "days_late", "computed": { "daysSince": "needed_by" }, "when": { "days_late": { "gt": 0 } } }
  ```
  Recomputed every render and never stored, so an "overdue" view re-evaluates as the day rolls over.
  Pair it with the ordered operators above for due/overdue/stale filters. Note this ages **one row's own
  date** — "when was this chore last done by anyone" would need a max-per-group, which aggregates don't
  feed back into a lookup.
- Computed columns are read-only (no cell editor renders for them).
- They appear in the view's visible columns and in card/table layout.

### conditional computed columns (`when`) + condition operators
Any **named or computed** column may carry a `when` clause that gates its **per-row** visibility
(card/list: hides the field on that card; table: blanks the cell). Because computed values are
resolved into the row before visibility is evaluated, a `when` can be driven by a computed column:
```json
{ "name": "flagged", "computed": { "fromColumns": ["slot1","slot2"], "matchList": "leads" },
  "when": { "flagged": { "notEmpty": true } } }
```
Conditions (used by `when`, row `filter`s, and embed `when` — all the same engine) match a
row when **every** field matches. Each field accepts a scalar (equality) or an operator object:

| Form | Meaning |
|------|---------|
| `{ "f": "v" }` | `row.f === "v"` (equality) |
| `{ "f": { "notEmpty": true } }` | `row.f` is truthy (set) |
| `{ "f": { "empty": true } }` | `row.f` is falsy (blank) |
| `{ "f": { "ne": v } }` | `row.f !== v` |
| `{ "f": { "lt": v } }` / `gt` / `lte` / `gte` | ordered comparison. **Numeric** when both sides parse as numbers (`9 < 10`, not `"9" > "10"`), otherwise a string compare — which orders `YYYY-MM-DD` dates correctly, so no separate date operator is needed. Combinable in one object for a range: `{ "gte": 10, "lte": 20 }`. A **blank or missing value is incomparable** and matches *no* ordered filter in either direction (fail-closed — otherwise `Number('') === 0` would quietly pull undated rows into an "overdue" view) |
| `{ "$or": [...] }` / `{ "$and": [...] }` | logical groups (membership via `$or` of equalities) |
| `{ "f": { "matchList": "L" } }` / `notMatchList` | value in / not in named list |

`when`/conditional columns and row `filter`s share **one matcher** (`condMatches`), so anything
valid in a `filter` is valid in a `when` and vice-versa — `$or`/`$and`,
`matchList`/`notMatchList`, equality, and the operators above. `notEmpty`/`empty` work
on **computed** values, so you can show a column only when a computed result is present.
Column `when`/`hideEmpty` are evaluated against the config that *owns* the column, so they apply
inside a `{{view:x}}` / `{{table:x}}` embed and in an inline embed exactly as they do at top level —
the embedded view's own entries decide, not the page hosting it.

A `when` clause also works on an **embed** (inline, named-view, or markdown prose block) in a
view's `columns`: the embed renders per-card only when the card's row matches — e.g. a markdown
prose block placed above a column, shown only when a computed value is present:
`{ "view": "flagged_heading", "bare": true, "when": { "flagged": { "notEmpty": true } } }`.

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
> (hardcoded coupling). Slots are ordered by the `position` column. Set `"reorderable": true` on the
> table to get **up/down arrow buttons** in the grid that move a slot and auto-renumber `position`
> (like the Lists tab) — no manual renumbering needed. Set `position` to `hidden: true` to drop it
> from the grid entirely — only `people` shows and order is controlled **only** by the arrows.

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
| `"calendar"` | whole intervals elapsed between the anchor date and the row's date | the duty runs on a fixed schedule regardless of rows (weekly cleanup) | `interval`, anchor (per-view — see below) (+ `dateField`) |

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
  falling back to "today" if absent. Calendar mode is primarily intended for `rotation` (below);
  for per-row computed columns, prefer **occurrence** mode.
- **`interval`**: a named value — `"daily"`, `"weekly"`, `"monthly"`, `"yearly"` — **or** a compact
  `"<n><unit>"` form where unit is `d`/`w`/`m`/`y` (e.g. `"3w"` = every 3 weeks, `"2m"`, `"10d"`,
  `"1y"`). Day/week use uniform arithmetic; month/year use real calendar arithmetic (never days/30),
  and years normalize to 12 months. Sub-day units (hours) are **not** supported — dates are stored as
  `YYYY-MM-DD` with no time component. Unknown/typo values are **rejected at load** (no silent weekly
  fallback). Defaults to weekly when omitted.
- **Calendar anchor (per-view, DB-backed)**: the anchor is the date of slot position 0 for *this view*.
  It is stored **per view** in synced folder config under `rotationAnchors[<viewName>]` and edited
  **inline on the rotation view itself** (a "Start date" field at the top) — so different rotation
  views (e.g. `duty_rotation` vs `support_rotation`) can have different anchors. It is *not* a schema literal and
  *not* a per-row column. A literal `anchorDate` on a column overrides the per-view value (handy for a
  fixed/printable one-off); if neither is set, calendar columns resolve to empty. Occurrence mode
  ignores the anchor.
- **Independent lists (R3)**: multiple rotations are separate tables; nothing couples them. Within one
  view, sharing that view's anchor only fixes which calendar period is index 0 — each list keeps its own length and
  contents (different-length lists drift relative to each other over time, which is correct).
- **Dependency preload**: `rotationTable` (and `occurrenceSource`) are auto-loaded into the data cache
  before resolution — they need not appear in the view's `sources`.
- **Validation** (load-time): `rotationTable` must exist; `advanceBy` must be `occurrence` or
  `calendar`; occurrence needs a resolvable `occurrenceSource`; calendar needs a **valid `interval`**.
  The anchor is runtime data (global config or a literal `anchorDate`), so it is not statically validated.

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

### Restricting a page to some users (`access`)

By default a doc-view is visible to **every registered user** (its embedded tables' rows stay
gated by their own access, so only the prose is shared). To restrict a page, add an `access` array
of table names — the page is then visible only to users **granted at least one** of those tables
(admins and `tables: "all"` users always see it):

```json
{ "name": "staff_handbook", "markdown": "…", "access": ["hr", "payroll"] }
```

- Reuses your existing per-table grants — no new permission type or admin UI. Tag a page with a
  table only its intended audience can access.
- **`access: ["all"]`** restricts the page to **full-access users only** (`tables: "all"` + admins).
  `"all"` is a sentinel, not a table name: no partial-grant user's table list ever contains it, so
  every enforcement point (`canAccessPage`, dev-server `filterPages`, firestore.rules `pageAllowed`)
  denies them, while the `tables == "all"` check still admits full-access users. Use it for a section
  only people who can see everything should read.
- **Enforced server-side on Firebase**: `saveSchema` mirrors the page→tables map to
  `_meta/pageAccess`, and the `_pages__active` read rule denies the stored body to users without a
  listed grant. The dev server mirrors this from the schema. (Sheets/Drive-CRDT backends have no
  server rules — there access is Drive folder sharing, so `access` is client-side hiding only.)
- **Protects the stored (edited) body, not the page's existence.** The page name/title and the
  schema-defined *seed* markdown live in the schema every registered user reads — so a restricted
  user can learn the page exists and see its seed, just never its edited body. **Don't put secrets
  in a restricted page's schema `markdown` seed** — put them in the edited (server-stored) body.
- **Embedding a restricted page inside another page** with `{{view:otherPage}}` respects its
  `access`: the embed renders the **access-gated server body** (loaded per-page, server-filtered) and
  is hidden entirely for users who fail `canAccessPage`. This lets one page combine a public section
  and a restricted one — e.g. a welcome for everyone plus `{{view:sisainen}}` below it that only
  full-access users see. The restricted page keeps its own `access` and typically drops its nav entry
  (it shows inline). As always, keep the real content in the embedded page's *body*, not its seed.

## rotationView (third view kind)
A view with a `rotation` field renders a rotating roster across a **range of calendar periods**
at once (e.g. "next 12 weeks of cleanup duty," or a fixed printable schedule). It has **no
underlying stored rows** — every output row is *generated* by repeated calendar-mode resolver calls
— so it is neither a data view (`sources`/`columns`) nor a document (`markdown`). It's a distinct,
read-only third kind. It has **two forms**: the simple **`columns`** form (each area column fixed to
its own rotation table, below) and the **rotating `areas`+`lists`** form (the list→area assignment
rotates over time — see "Rotating assignment").

```json
{
  "name": "cleanup_schedule",
  "rotation": {
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
| `rotationView.columns` | One entry per rotation, each a **calendar-mode** spec (`name`, `rotationTable`, `advanceBy: "calendar"`, `interval`). The anchor is the **per-view** `rotationAnchors[<viewName>]` (folder config, edited inline on the view); a literal `anchorDate` on a column overrides it. Resolved independently per generated row. |
| `range.from` | `"today"` for a rolling window (recomputed each open) **or** a literal `YYYY-MM-DD` for a fixed window (printing/sharing). |
| `range.periods` | A **count of intervals** to generate rows for (not an end date) — matches how calendar resolution counts elapsed intervals. |
| `layout` | `"table"` (minimum supported). |

- Generates `range.periods` rows starting at `range.from`; each row carries the period date plus one
  resolved column per rotation. The **date axis follows the first column's `interval`**.
- **Calendar-mode only** — validation rejects `advanceBy: "occurrence"` here. Occurrence-mode
  rotations render inside an ordinary data view (as a rotation computed column) where each row already
  has its own date/context, so they don't need this view kind.
- **Shared anchor** — all columns in a view use that **view's** anchor, so they align at period 0 while
  keeping independent lengths/contents (different-length lists drift relative to each other — expected).
- **Read-only & recomputed**: a `rotation` is a pure function of *(rotation-table contents, range)*
  at render time. There is no snapshot — editing a slot table changes what every past *and* future
  period resolves to on the next render. This is intended, not a gap.
- **Dependency preload**: each `rotationTable` is fetched into the data cache before generation.
- **Nav**: reference it by `name` like any view; it gets a default `mdi-calendar-clock` icon.
- **Validation** (load-time): each column's `rotationTable` must exist, `advanceBy` may only be
  `calendar`, and the `interval` must be **valid**. The anchor is runtime data (global config or a
  literal `anchorDate`), so it is not statically validated.

### Rotating assignment (`slots` + `rosters` + `rotateEvery`)
Instead of fixing each slot to one roster, you can rotate the **roster→slot assignment** over time — the
generalization of a 2-roster "swap." Use ordered `slots` (output columns) and ordered `rosters` (rotation
tables), with one shared `interval`/`advanceBy` and a `rotateEvery`:

```json
{
  "name": "duty_rotation",
  "rotation": {
    "slots": ["zone_a", "zone_b"],
    "rosters": ["team_a", "team_b"],
    "advanceBy": "calendar",
    "interval": "weekly",
    "rotateEvery": 1,
    "range": { "from": "today", "periods": 12 }
  },
  "layout": "table"
}
```

> Naming: a **slot** is an output assignment column (a zone, post, shift, etc.); a
> **roster** is an ordered pool/table whose members take turns. (These replace the older `areas`/`lists`
> keys — there is no back-compat alias, schemas must use `slots`/`rosters`.)

**Two independent clocks** drive it:
1. **Per-roster member rotation** — each roster advances one slot per period on its **own length** (the
   rosters stay fully independent, can be different lengths, and are maintained separately — R3).
2. **Roster→slot assignment rotation** — driven by `rotateEvery`, which is a **list of swap sources**
   summed into one shift. At period `p`: `shift s = (Σ over sources) mod N` (N = number of rosters), and
   `slot[k] ← roster[(k + s) mod N]` resolved at that roster's member index `p mod len`. Each source is:
   - a **positive integer `n`** → `floor(p / n) mod N` (rotate one step every `n` periods), or
   - **`"cycle"`** → `floor((phase + p) / L) mod N`, where `L` = the live length of `rosters[0]` and
     `phase` anchors the boundary to the global anchor — rotates once per **full roster cycle**, so
     even-length rosters alternate slots every duty turn (see parity below).
   A **scalar is shorthand** for a 1-element list (`"rotateEvery": 1` ≡ `[1]`); `0`/omitted = no swap.
   Sources are summed, so **order doesn't matter** and the result is always a permutation (no double-book).

- **Swap is the `N=2`, `rotateEvery:1` case** — slots served `[a,b]`, then `[b,a]`, then `[a,b]`…
  (exactly the alternating doormen/cleanup pattern).
- **Each period is a permutation** of rosters across slots (with `N = slots.length`), so **no slot is
  double-staffed or left empty**. Over `N` assignment-cycles every roster visits every slot.
- **`rotateEvery: 0` / omitted** = no assignment rotation (each slot fixed to `rosters[k]`) — equivalent
  to the `columns` form. Useful list values: `[1]` per-period swap (≡ scalar `1`), `["cycle"]` per-cycle
  swap, `[1, "cycle"]` both. Extra elements just superimpose more swap frequencies (valid but rarely useful).
- **Anchor / interval**: the per-view `rotationAnchors[<viewName>]` (or a literal `anchorDate` on the
  `rotation`) anchors period 0; `interval` accepts the same values as elsewhere.
- **Display window is assignment-invariant**: `range.from` selects only *which* periods are shown — it
  never changes who is assigned. Both swap sources index off the absolute period count from the
  **anchor** (`abs = wholeIntervalsBetween(anchor, from) + i`), so scrolling the window (or a rolling
  `"today"` start, or a per-view DB range override) yields the same roster→slot pairing for any given
  date. (Earlier a numeric `rotateEvery` counted from `from`, which reshuffled assignments when the
  window moved — fixed 2026-07.)
- **N rosters vs M slots**: `N = M` → clean permutation (recommended). `N > M` → round-robin where
  `N − M` rosters "rest" each period and everyone eventually serves every slot. `N < M` → **rejected at
  load** (some slots would be unstaffed/double-booked).
- **Validation**: every `rosters` table must exist; `advanceBy` (if set) must be `calendar`; `interval`
  must be valid; `rosters.length` must be `>= slots.length`; every `rotateEvery` element must be a
  non-negative integer or `"cycle"`.
- **Embedding**: a data view can embed a rotationView via a `{ "view": "<rotationViewName>" }` column —
  it renders the generated period table inline (date + slot columns), e.g. a cleaning schedule shown
  inside a program view.

#### Per-person slot coverage — roster length (L) vs rotation cadence (R)
The two clocks can **alias**, which decides whether a given person eventually works *every* slot or
stays **locked** to one. For a person at position `p` in a roster of length **`L`**, with swap cadence
`rotateEvery` = **`R`** and `N` rosters/slots:
- They return to duty every `L` periods (member clock); the slot they get is set by the assignment
  shift `s = floor(period / R) mod N` (swap clock, full cycle = `N·R` periods).
- They cover **all slots** iff their duty subsequence isn't stuck on one `s` value — i.e. iff `L` and
  the swap cycle don't share a common factor that pins them. They stay **locked to one slot** iff `L`
  divides evenly into the swap rhythm.

For the common two-team case (**`N=2`, `R=1`**, swap period = 2):
- **Odd `L`** → period parity flips on each return → **alternates slots every turn** (everyone serves
  both slots; back to the start slot every 2nd turn). ✅
- **Even `L`** → period parity is constant on each return → **locked**: even positions always slot 0,
  odd positions always slot 1. ⚠️

This app can use `rotateEvery: [1]` and **rely on odd-length lists**, OR — the clean fix for **any**
length — add the **`"cycle"`** source. `"cycle"` swaps once per full roster pass (cadence = live `L`),
so every person flips slot on each successive duty turn regardless of parity, with no manual `R = L`
bookkeeping when a roster grows or shrinks:
- **`rotateEvery: ["cycle"]`** — per-cycle swap only; even-length rosters alternate slots every turn. ✅
- **`rotateEvery: [1, "cycle"]`** — per-period spread **and** per-cycle alternation, summed.

For equal-length lists the older `R = L` trick still works; `"cycle"` generalizes it to the live length.
With **unequal, independently-maintained** lengths only "eventually covers both" is achievable (per-turn
balance drifts), so equal lengths remains the requirement for a strict per-turn guarantee.

### Worked example (occurrence + calendar end-to-end)
An event needs **security** (one team per session — occurrence-driven) and a two-zone **cleanup**
rota (every week regardless of sessions — calendar-driven). Three rotation tables, one data view with
an occurrence-mode computed column, and one `rotation` for the calendar rota:

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
        { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true }
      ],
      "defaultSort": "position"
    },
    "zone_b_rotation": {
      "columns": [
        { "name": "position", "type": "number" },
        { "name": "people", "type": "multiselect", "list": "staff", "allowNew": true }
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
      "rotation": {
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
| `zone_a_rotation` | `["Alex"]` | `["Sam"]` | — |
| `zone_b_rotation` | `["Riley"]` | `["Jordan"]` | `["Casey"]` |

(The view's anchor `rotationAnchors["cleanup_schedule"]` — set inline on the view, e.g. `2026-01-01` — fixes period 0 for both zone
columns; `security_rotation` is occurrence-mode and ignores the anchor entirely.)

- **`session_schedule`** (occurrence): sessions sorted by `date`; the 1st session → `security` =
  `"Alex"`, 2nd → `"Sam, Jordan"`, 3rd → `"Riley"`, **4th loops** → `"Alex"`. Deleting the 2nd
  session shifts every later session back one slot (no gap).
- **`cleanup_schedule`** (calendar `rotation`): 12 weekly rows from today. The global
  `rotationAnchor` fixes period 0 for both columns — but they keep independent lengths, so `zone_a`
  (2 slots) loops every 2 weeks while `zone_b` (3 slots) loops every 3 weeks, drifting against each
  other (expected).
- The slot tables stay directly editable in the **Rotations** nav group; both schedules recompute on
  next render.

## calendar (fourth view kind)

A view with a `calendar` field renders its source rows on a compact **month / week / list**
calendar, bucketed by a date column — like a lightweight Google Calendar. It has **no stored rows
of its own**: it's a *presentation* of existing table rows (and generated rotation duties).
Distinct from data views, documents, and rotationViews.

### Layout
- **Month**: compact grid (day number + a single **neutral-accent count badge** on days with
  events — NOT one chip per event). Clicking a day opens that day's events in a **selected-day panel
  below the grid** (a one-day agenda slice; it does NOT switch to List mode).
- **Week**: a 7-day strip (day number + count badge); click fills the same panel.
- **List / agenda**: a flat multi-day list (date subheading + event rows), plus an **Undated**
  section for rows with an empty date. This is also the automatic **mobile fallback** for Month.
- Event dots in the panel/list are coloured by **event type** (the `label`, or the source table's
  translated `tab.<table>` name). The month/week count badge is always the neutral accent.

### Single source
```json
{ "name": "chore_calendar",
  "calendar": {
    "source": "chore_log",        // REQUIRED (or `sources`) — one table
    "dateColumn": "done_on",       // REQUIRED — a date column of `source` (YYYY-MM-DD)
    "titleColumns": ["chore", "person"], // OPTIONAL — joined with " — " for the event label
    "defaultView": "month",        // OPTIONAL — "month" | "week" | "list" (default "month")
    "weekStart": 1                 // OPTIONAL — 0=Sun, 1=Mon (default 1)
  }
}
```

### Multi source ("all events")
Use `sources` (instead of `source`) to merge several tables into one calendar. Each source declares
its own date + title; the **same table may appear twice** with different `dateColumn`s (e.g. an
appointment date and an expiry date):
```json
"calendar": {
  "sources": [
    { "table": "meetings",     "dateColumn": "date",   "titleColumns": ["topic"],  "label": "Meeting" },
    { "table": "appointments", "dateColumn": "starts", "titleColumns": ["person"], "label": "Appointment" },
    { "table": "appointments", "dateColumn": "ends",   "titleColumns": ["person"], "label": "Expiry" }
  ],
  "defaultView": "month"
}
```
Per-source fields: `table` (req), `dateColumn` (req), `titleColumns` (opt), `filter` (opt, data-view
grammar), `label` (opt — the type tag + colour key; defaults to the table's translated `tab.<table>`).

### Rotation duties (`rotationSources`)
Overlay a **rotation view's** generated duties (e.g. `duty_rotation` turns) onto the calendar as
**read-only** events. Rotation rows aren't stored — they're generated per date from the rosters +
anchor — so the calendar generates them on demand for the visible window and drops any outside it.
```json
"calendar": {
  "sources": [ { "table": "meetings", "dateColumn": "date", "titleColumns": ["topic"], "label": "Meeting" } ],
  "rotationSources": [ { "view": "duty_rotation", "label": "Duty" } ],
  "defaultView": "month"
}
```
- `view` (req) — names an existing **rotation** view (`v.rotation`); each populated slot on a
  generated period becomes one event titled `<slotLabel>: <people>` (e.g. `"Zone A: Alex, Sam"`).
- `label` (opt) — the type tag + dot colour key (defaults to the rotation view's `tab.<view>` name).
- **Single source of truth**: generation reuses the rotation view's own **anchor**, **range start**,
  and **rotateEvery**, so the calendar shows the *same* assignments as the rotation view. Duties land
  on their true duty date (e.g. weekly rotations on the anchor's weekday), not the grid boundary.
- **Read-only**: rotation events carry `table: null` / `readOnly: true` (no stored row to open) and
  render with a `(read-only)` tag in the panel/list.
- **Per-roster access (fail-closed)**: a rotation source is included only if the signed-in user can
  read **≥1** of its rosters; otherwise it contributes no events.
- Duties only exist from the rotation's start date onward (grid cells before it stay empty).

### Access & i18n
- **Fail-closed per source**: a source whose table the signed-in user cannot read contributes no
  events. A restricted user sees only the event types they're permitted.
- **Labels**: chrome uses `cal.*` translation keys (`cal.today`/`cal.month`/`cal.week`/`cal.list`/
  `cal.undated`/`cal.no_events`/`cal.items`), and period navigation uses `period.*` — like every other
  string these show the **key** until translated (no built-in English), so define them per language (the
  demo bundle does). Event tags default to `tab.<table>`; titles use `field.*` + list-value translations.
  **Weekday/month names** come from `Intl` using the active language's **`code`** as the BCP-47 locale
  (e.g. selecting a language with code `"fi"` yields Finnish names automatically), overridable with an
  explicit per-language `locale`; the browser locale is only a last resort for an unusable code.

### Embedding
A calendar can be **embedded in a markdown/document page** via `{{view:calendarName}}` (renders as a
compact calendar with its own state) — e.g. a "Home" dashboard page with prose + the month calendar.
A view is still one kind at top level; the document *hosts* the calendar via the embed.

### Notes / limits
- Events are **single-day** (point events). Multi-day spans are not modelled yet.
- Rows with an empty `dateColumn` go to the **Undated** list bucket (not lost).
- Data-view `{view:cal}` inline embeds are deferred (use a markdown-page `{{view:cal}}` embed).

## pivot (fifth view kind)

A view with a `pivot` field renders a **cross-tab grid**: rows = distinct values of one column,
columns = distinct values of a second, each cell = an aggregate of a third. It's the two-dimensional
counterpart to an aggregate view (attendance grids, duty rosters, chore heatmaps). Like calendar, it
has **no stored rows of its own** — it's a live presentation of a source table (engine: `pivot.js`).

```json
{ "name": "chore_heatmap",
  "pivot": {
    "source": "chore_log",   // REQUIRED — the table to cross-tabulate
    "row": "person",          // REQUIRED — column whose distinct values become grid ROWS
    "column": "chore",        // REQUIRED — column whose distinct values become grid COLUMNS
    "cell": "minutes",        // OPTIONAL — column that fills each cell (omit for a pure count grid)
    "aggregate": "count",     // OPTIONAL — how to combine rows in one cell (see below)
    "totals": "count"         // OPTIONAL — marginal totals (per-row, per-column, grand). null = none
  }
}
```
- **`aggregate`**: `"count"` (default when no `cell`) · `"sum"` (numeric `cell`) · `"first"` (default
  *with* a `cell` — first non-empty value) · `"list"` (distinct values joined with `, `).
- **`totals`**: `"count"` (source rows) · `"sum"` (numeric `cell`) · `{ "eq": <value> }` (count of cells
  equal to a value, e.g. `{ "eq": "coming" }`). Renders a totals row/column + grand total.
- **`colOrder`** (string[], optional): explicit column order; keys not present in the data still render
  as empty columns (e.g. a fixed roster). Otherwise columns/rows are sorted — override with
  **`colSort`** / **`rowSort`** (`"asc"` default | `"desc"`).
- **Array-valued cells** (from a `multiselect` row/column) are **expanded**: a value of `["a","b"]`
  contributes to both the `a` and `b` buckets. Blank row/column keys are skipped.

## rsvp (sixth view kind)

A view with an `rsvp` field renders a **self-service signup / attendance sheet**: each upcoming event
gets an inline status toggle bound to the current user's **own** response row. Unlike the presentation
views, rsvp is **read-write** — but a participant writes only their own `owner`-stamped row (enforced by
`firestore.rules`; the `owner` column type is the primitive). Engine: `rsvp.js`.

The events live in one table; responses in another that has an **`owner` column** (auto-stamped), a
**`ref` column pointing at the events table** (the response↔event link), and a status column:
```json
{ "name": "my_rsvp",
  "rsvp": {
    "events": "practices",          // REQUIRED — the events table
    "dateColumn": "date",            // REQUIRED — event date column (YYYY-MM-DD): upcoming filter + sort
    "titleColumns": ["title", "opponent"], // OPTIONAL — joined with " — " for the event title
    "responses": "rsvps",           // REQUIRED — response table: needs an `owner` column + a `ref` to `events`
    "statusColumn": "response",      // REQUIRED — response column holding the status value
    "statuses": ["coming", "maybe", "out"], // OPTIONAL — inline options; omit to use the statusColumn's list
    "statusList": "rsvp_status",     // OPTIONAL — label translation namespace override (see below)
    "picker": "toggle",              // OPTIONAL — status control: "dropdown" (default) | "toggle" | "chips"
    "showCounts": true,              // OPTIONAL — show a per-event count of each response
    "rosterVisibility": "all"        // OPTIONAL — who sees the participant roster (see below)
  }
}
```
- **The response↔event link is a `ref` column (required, not configured):** the responses table must
  have a `ref` column pointing at the `events` table, targeting its **`id`** — e.g. `rsvps.practice`:
  `{ "type": "ref", "table": "practices", "valueCol": "id" }`. The view uses that column as the link and
  its `valueCol` as the key each response matches (default `id`). **Link by `id`, not a data column like
  `date`** — `id` is the only unique key, so two events on the same date stay separate (a `date` link would
  merge their responses). `dateColumn` is only for the upcoming filter + sort, never the link. So there is
  **no `linkColumn`/`eventKey`** — you get a validated, collision-free relationship plus a ref-picker when
  editing responses. (Load-time validation errors if the responses table has no such ref.)
- **`statuses`** vs a **real list** (recommended): the cleanest setup is to make `statusColumn` a
  `select` with its own `list` (e.g. a `response` column `{ "type": "select", "list": "rsvp_status" }`)
  and **omit `statuses`** — the options then come from that list, which is **editable in the Lookup tab**.
  The demo does this. (An inline `statuses` array still works when you don't want a Lookup list.)
- **Labels are translated** via `list.<statusList || statusColumn's-list || statusColumn>.<value>`
  (falling back to the raw value). With a real list you get `list.rsvp_status.coming` etc. for free — no
  `statusList` needed. Set **`statusList`** only when the response column's *name* would resolve to
  another table's list under the per-column-name resolver (e.g. a column literally named `status`), to
  point the labels at a distinct namespace.
- **`picker`** — the status control's UI element: `"dropdown"` (`v-select`, **default** — same default as
  the column-level `picker`) · `"toggle"` (segmented buttons, best for a few single-choice options) ·
  `"chips"` (selectable chips). Deselecting the current choice removes the vote in every variant.
- **`rosterVisibility`** (UI gate): `"all"` (everyone sees who responded) · `"admins"` (only organizers/
  admins) · `"counts"` (counts only, no names). This is **only the display gate** — the real read control
  is the Firestore rule.
- **Roster visibility is denormalized per response table**: set `"privateRoster": true` on the
  *responses* table to make each response readable only by its owner + organizers; otherwise the app
  stamps `rosterPublic: true` on each row so everyone can read it. Rules are schema-blind, so this flag
  must be carried on the rows — the `rosterVisibility` view option alone does not restrict reads.
- With owner-scoped reads a non-organizer receives only their own response from the backend, so the
  rendered tally/roster reflects exactly what that user is permitted to see.

## board (seventh view kind)

A view with a `board` field renders a **kanban board**: a single table's rows grouped into vertical
**lanes** by one `select` column, with each row shown as a card. Dragging a card between lanes (or using
the card's move-menu) **writes that column** back to the row. It is the one-dimensional, *writable*
cousin of the pivot — where a pivot aggregates to read-only numbers, a board keeps whole editable rows.
Engine: `board.js`. A board is essentially a single-source **data view** plus a `lane` column, so it
reuses the data-view load path (filters, `compute`, `defaultSort` all apply) and the standard
`saveField` write.

```json
{ "name": "tickets_board",
  "sources": ["tickets"],            // REQUIRED — exactly ONE table (the drag-write target must be unambiguous)
  "mode": "join",
  "defaultSort": "title",            // card order within each lane
  "board": {
    "lane": "status",                // REQUIRED — a `select` column on the source table; its value places the card
    "lanes": ["open", "in_progress", "done"], // OPTIONAL — explicit lane order; keys here render even when empty.
                                     //            Omit -> order from the column's list, else first-seen in the data.
    "hiddenLanes": ["cancelled"],   // OPTIONAL — lane keys to drop from the board
    "laneGroups": [                  // OPTIONAL — fold lanes under collapsible phase headers (tames many lanes)
      { "label": "Active", "lanes": ["open", "in_progress"] },
      { "label": "Closed", "lanes": ["done"], "collapsed": true }
    ],
    "title": "title",                // OPTIONAL — card heading column (default: first entry of `columns`)
    "color": "assignee",             // OPTIONAL — column whose value tints each card's left border (hashed)
    "addInLane": true                // OPTIONAL — per-lane "+" adds a row pre-stamped with that lane value
  },
  "columns": ["title", "assignee"]   // card-face columns (the lane/title columns are shown separately)
}
```

- **One source, one lane column.** The source must be **exactly one** table and `lane` must be a `select`
  **or a `ref`** column on it (load-time validation enforces both) — a drag writes one column on one table,
  so a union/join or an unsupported lane type would be ambiguous. This mirrors why a mirror-**detail** table
  (one whose columns `syncFrom` a master) yields a **read-only** board: such rows are mutated only via their
  master, so the board offers no drag/add (same `hasMaster` gate as the data view's add button). Board a
  **standalone** table (like a status/workflow table).
- **Lane order & labels.** `lanes` fixes the order and materializes empty lanes; otherwise lanes come from
  the `select` column's list (authored order), else first-seen in the data. Lane headers and card values
  are translated through the same `list.<list>.<value>` / `field.<col>` keys the grid uses — no board-only
  i18n. The blank/unassigned lane uses the `board.unassigned` label (default `—`).
- **2-D ref lane (grouping from data, no `laneGroups`).** If `lane` is a **`ref` to a 2-column lookup**, the
  lookup's two dimensions *are* the board: the **parent** column is the phase/group, the **child** column
  (`valueCol`) is the lane value (what the row stores). Lane order, group order, and grouping all come from
  the lookup **rows** — so adding / renaming / reordering states or phases is plain data entry in that
  lookup, with nothing duplicated in the schema (`laneGroups`/`hiddenLanes` aren't needed). A ref lane's
  values **and** its group labels localize through `list.<lookupTable>.<value>` keys — the same namespace as
  list values, so they appear in the Languages editor's **Lists** section when the lookup table is named in
  `translatableLists`. A plain 1-D `select` lane stays flat (or grouped via `laneGroups`); a 2-column ref
  lane is grouped. Drag/move writes the child value exactly like a select lane, so filters and existing data
  keep matching.
- **Writes.** Dropping a card (desktop HTML5 drag) or picking a lane from the card's **move-menu**
  (touch / keyboard / a11y fallback) calls the same debounced `saveField` as inline grid editing, so it
  flows to every backend and updates the cache immediately. Gated on write access (`canMutateRows`); a
  read-only user gets a static board.
- **Many lanes → `laneGroups`.** For long lifecycles (e.g. a calling-status column with a dozen states),
  group lanes into named phases; a group marked `"collapsed": true` starts folded. Lanes not named in any
  group fall into a trailing implicit group. Each phase `label` is translatable through a
  `board.group.<label>` key (seeded into the translation editor), falling back to the literal `label`.
- **Card row controls.** Each card carries the same per-row actions as the grid, gated on write access: a
  **pencil** flips the card into edit mode (every field except the lane becomes the shared `data-cell`
  editor — same widgets and `saveField` persistence as the grid — with dragging disabled while editing); an
  **archive** button (when the source table is `archivable`) files the card to the archive partition
  (reversible via restore); and a **delete** button uses the grid's arm-then-confirm (first click swaps the
  icon, the second removes the row). The lane itself is changed by drag or the card's **move-menu** (⋮).
- **Integration.** Because a board only writes an existing column, moving cards feeds any other view that
  filters on that column (e.g. a program/agenda view filtering `status: "approved"`), with no extra wiring.

## Translatable lists (`translatableLists`)

List **values** (the options behind a `select`/`multiselect` column) are translated through
`list.<list>.<value>` keys — the same keys the grid, board lanes, and pivot axes resolve through. Most
lists are open data you would never localize (member names, song titles), so the Languages editor does
**not** expose every list by default. It surfaces list-value keys from two sources:

1. **Filter/conditional-pinned values** — any value a schema `filter`/`when` references (e.g. a program
   view filtering `tila: "vastaanotettu"`). These are always translatable (and locked from rename/deletion),
   because schema logic keys on them; you get exactly those values, not the whole list. This holds whether
   the filtered column is a `select` (pinned under its list) **or a `ref`** (pinned under its lookup table),
   so a 2-D ref lane's filter-referenced values can't be renamed or removed from the lookup — the ref/lookup
   editor shows them locked, the same way the Lists editor locks list values.
2. **Opt-in lists** — a top-level **`"translatableLists": ["tilat", "organisaatio", …]`** array. Every
   current value of each named list becomes a translation key. Use this for controlled vocabularies you
   want fully localized (status lifecycles, organisations, roles) while leaving open/data lists out. An
   entry may also name a **lookup/ref table** (e.g. a board's 2-D ref-lane table): its distinct cell values
   across all non-system columns are exposed the same way, so both dimensions of a ref lane are translatable.

```json
{ "defaultLanguage": "Suomi",
  "translatableLists": ["tilat", "organisaatio", "tehtävät", "piispakunta"],
  "tables": { … } }
```

In the **Languages** tab these keys are grouped under their own collapsible **Lists** section (separate
from **App** and **Schema**) so they're easy to find. A value with no translation falls back to the raw
value, so opting a list in is non-breaking.

## Self-service tables (Firebase)

Any table that declares an **`owner` column** is a **self-service** table: a registered member may
create / edit / delete **their own** owner-stamped rows there **without a table grant**, while an editor
(table grant) or admin manages all rows. This is the RSVP/sign-up permission model, available to any
table — the `rsvp` view is one presentation of it; a plain data grid over an owner-column table (e.g. a
`leave_requests`, `expenses`, or `shifts` table) is another. Read visibility is the separate `owner` /
`rosterPublic` axis (private to the owner + organizers, or public) described under **rsvp**.

- **In the UI**: a self-service table shows in the nav for such a member and its **Add** button is
  available; per-row edit/delete is gated on ownership (their own rows are editable, others render
  read-only, the `owner` column is always read-only). Admins/editors with a grant manage all rows as
  before.
- **Who can READ the rows** is the separate `owner` / `rosterPublic` axis. Every owner-stamped row
  created through the app carries `rosterPublic: true` unless the table sets **`privateRoster: true`**,
  in which case each row is visible only to its owner and to organizers (a table grant) — the flag has
  to ride on the row because both rules layers are schema-blind. Leave it off for a shared log whose
  totals everyone should see (a chore leaderboard); switch it on for genuinely private submissions.
  Rows written before this behaviour existed carry no flag and stay owner-private until re-saved.
- **Read-only grant + `owner` column** is the other useful combination: `{ "<table>": "r" }` lets a
  member see every row while writes still route through self-service, so they change only their own.
  See **Access modes** below.
- **How the rules know**: Firestore rules are schema-blind, so `saveSchema` mirrors the set of
  owner-column tables to `_meta/ownerTables` (`BackendHelpers.ownerTablesOf`). The data rules allow
  owner-create **only** on a table in that set — otherwise a member could inject owner-stamped rows into
  any table. The set is re-derived on every schema save; no manual upkeep.
- **Migration**: if `_meta/ownerTables` doesn't exist yet (rules deployed before the schema was next
  saved), owner-create falls back to permissive so existing sign-up flows keep working; enforcement
  activates on the next schema save.
- **Enforcement** is the Firestore rules. The local/dev server (unauthenticated, loopback only) is not a
  security boundary, but **mirrors** owner-scoped reads/writes for a self-service table so the local demo
  behaves like Firebase: a non-granted member reads their own rows (+ `rosterPublic`) and may create /
  edit / delete only their own owned rows.

## Access modes (`r` / `rw`)

A user's grant (`_users/<email>.tables`) is one of three shapes, all still accepted:

| Stored value | Means |
|---|---|
| `"all"` | every table, read + write |
| `["tasks", "notes"]` | **legacy** — read + write on each. Nothing writes this shape any more; existing grants keep working untouched |
| `{ "tasks": "rw", "ref_chores": "r" }` | per-table mode. `"r"` = **visible but not editable** |

`"r"` is for reference data a member must see and must not change — a chore catalogue with point
values, a price list, a status vocabulary. The table appears in the nav, its rows load, its lists and
ref-pickers resolve, and every cell renders read-only; add/delete/archive controls are hidden.

- **Edited in Settings → Users** as two chip columns: *Tables* (can edit) and *Can view*. They merge
  into the one stored map, with edit winning where a feature is in both.
- **Enforced server-side.** Reads use plain membership, which both rules languages satisfy for either
  container (`x in <map>` matches keys; `jsonb ? k` matches array elements *or* object keys) — which is
  exactly why no stored grant needed migrating. Writes consult a denormalized **`rwTables`** list saved
  next to the grant, since neither rules layer can filter a map (same trick as `_meta/ownerTables`).
  A user doc without `rwTables` predates the split and falls back to membership.
- **Lists follow the table.** Editing a list requires *write* access to an owning table; a read-only
  grant sees the list and cannot change it.
- No grant at all still means no access (fail closed), and clearing every chip in the UI still means
  "no restriction" rather than locking the user out.

## user profiles, user-backed lists & membership (Firebase)

These features are Firebase-backed (the local/dev backend mirrors them for tests). They build on the
per-user access model (`_users/<lowercased-email>` docs; the legacy `_meta/users` map is admin-read
only).

### `_profiles/<email>` — opt-in display name + avatar
Each user has an optional profile `{ name, shared, picture }`, editable only by themselves (or an admin,
who may set `name` only) under **Settings → My profile**:
- `name` — the user's display name; the identity that `@me` resolves to and that a user-backed list
  shows. Optional (a registered user may have no name → `@me` matches nothing).
- `shared` — opt-in (default `false`). When `true`, the name is readable by any registered user via a
  **rules-provable** `.where('shared','==',true)` query (a constant comparison — unlike an
  intersection query, which Firestore cannot prove-authorize).
- `picture` — an optional self-uploaded avatar stored inline as a `data:` URL. The image is downscaled
  client-side (longest side ≤ 256px, JPEG) before saving and capped by the rules at ~350KB so a profile
  doc stays well under Firestore's 1MB document limit — no separate Storage bucket needed.

### `listSources: { "<listName>": "users" }` — a name list fed by profiles
A top-level schema map marking a list as user-backed. On boot the app **merges** the opted-in shared
display names on top of that list's own values, so `select`/`multiselect` columns and rotation `rosters`
referencing it become **assignable to registered users** — no manual list upkeep. Example:
```json
"listSources": { "members": "users" },
"tables": { "chore_log": { "columns": { "person": { "type": "select", "list": "members" } } } }
```
- The list's stored values are **kept**: a user-backed list still works before anyone opts in (a fresh
  deployment), and a curated value is never removed by the overlay. Only names the overlay itself
  injected are withdrawn when a user opts out.
- Opting in is per-user (**Profile → share name**), so on a new deployment this list contains only its
  stored values until users share. Seed it if the column must be usable immediately.

### `listSources: { "<listName>": "userlink" }` — curated names, linked accounts

The other way to tie a list to real people, and the **opposite trade-off** from `"users"` (a list is one
or the other — the key holds a single string). The list keeps its own **curated** values as the display
name; an admin links each value to an account email in the Lookup tab. Design notes:
[USER-LINKED-LISTS.md](USER-LINKED-LISTS.md).

| | `"users"` | `"userlink"` |
|---|---|---|
| Where the name comes from | each user's profile | the list, curated by an admin |
| A user renames their profile | the list value changes | nothing moves |
| Setup | users tick *share my name* | an admin links each value once |
| Extra | — | avatars, resolved live from the profile |

**`@me` works in both**, resolving per column: on a `userlink` list it becomes the curated value linked
to the caller's account, otherwise their profile display name. So a household can keep calling someone
"Ann" while the account behind her is `ann@example.test`, and `{ "person": "@me" }` still finds her rows.
A member who is linked to nothing resolves to the fail-closed sentinel and matches no rows — the same
stance as an empty profile name.

- The resolution needs the caller's **own** link, which they may read (`getMyListValues` — a rules-provable
  equality query on their own email; see the `_list_users` read rule). The full value→email map stays
  admin-only, and the avatar projection still never carries an email.
- **Renaming a list value** migrates the link with it, but the identity is keyed by the old string — see
  the fragile-case row in USER-LINKED-LISTS.md.

### Membership requests (self-service, admin-approved)
An unregistered (but signed-in) user submits a request from the "not registered" banner: a **required**
display name → writes `_access_requests/<email>` (rules: self create/read/delete; admin read/write).
An admin sees a **Pending requests** table in Settings → Users and **Approves** (registers as `editor`
with no tables yet — grant access via the chips; the request name is **seeded into the user's profile**
so `@me` works immediately, still not shared) or **Denies** (deletes the request). The email is taken
from the authenticated session — never asked for.

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

## theme (brand palette)

An optional top-level `theme` **partially overrides** the built-in Vuetify light/dark palettes, so the
brand is schema-driven (like `icon`/`title`/`nav`). Only the keys you set change; the rest keep
Vuetify's defaults.
```json
"theme": {
  "light": { "primary": "#00695c", "secondary": "#26a69a" },
  "dark":  { "primary": "#4db6ac", "secondary": "#26a69a" }
}
```
- **Editable roles** (surfaced in the admin editor): `primary`, `secondary`, `surface`, `background`,
  `on-surface` (labelled "Text"), `error`, `success`. Any Vuetify theme color key works, but these are
  the curated set. Colors are `#rrggbb` (or `#rgb`).
- **Where each role shows**: `primary` drives every interactive accent (buttons, active nav, links,
  switches, focus/selected states) and is the default for Vuetify components; `secondary` tints the
  metadata/tag chips (multiselect values, union-view source, read-only data chips); `surface`/
  `background`/`on-surface` are the page/card/text base; `error`/`success` are status colors.
- **Admin editor**: **Settings → Theme** (admin only) edits `theme` live and auto-saves — a per-role
  color picker + hex field for each mode, plus **paste-a-palette** (paste a coolors/colorhunt array like
  `["#ccd5ae",…]`; the colors are sorted by luminance/chroma and mapped to roles). Sets the deployment
  brand for everyone, not per-user.
- **Ceiling (no build step)**: only the **runtime** theme API is reachable — colors, `variables`, and
  component `defaults`. SASS-level tokens (type scale, spacing, border-radius, component shape) need a
  build and can't be themed here.
- **Splash / meta**: the pre-Vue splash + static `<meta theme-color>` can't read the schema yet, so the
  splash reads a `brand_splash` `localStorage` cache (written on load from the live theme) and follows
  the brand after one warm load; a dynamic `theme-color` meta tracks the in-app light/dark toggle.

## `text` entries (removed)
The `{ "text": "<key>" }` column entry (free-form text interleaved in a view's columns)
is **fully removed** — there is no longer any runtime handling for it (the old `_stripTextEntries`
load-time stripper was deleted). Author prose with a `markdown` view instead (a filtered view +
markdown + another view replaces text-between-columns). **Legacy schemas with `text` entries must be
hand-upgraded to `markdown` doc-views** (see [Removed shapes](#removed-shapes-hand-migrate)) before
deploying — otherwise the entries would surface as phantom columns. Do not author new `text` entries.

## Removed shapes (hand-migrate)
These shapes are **not supported at load** — the runtime has no handling for them, so a legacy schema
must be edited by hand before it will render correctly. There is no migration tool.
- **`text` entries** (`{ "text": "<key>" }` in a view's `columns`) — see above; they surface as
  phantom columns. Replace with a `markdown` doc-view: split the view at each text boundary into
  sub-views and interleave `{{t:key}}` tokens with one `{{view:subview}}` embed per run of real columns,
  then point `nav` at the markdown view.
- **`pages` map** (top-level `pages` + `{ "page": "x" }` nav entries) — the runtime no longer folds
  `pages` in at load. Author each page as a `markdown` view and use `{ "view": "x" }` in `nav.items`.
- **Table `header`/`footer`** — replace with a `markdown` doc-view that embeds the table
  (e.g. a `<table>_doc` view whose markdown is prose around `{{table:<name>}}`). The old behavior
  emitted `text` entries, which are themselves removed.
- **Nested `views`** are still supported and flattened at load (`_flattenViews`); the hierarchy is
  expressed in `nav.items`.

## Lists and translations
- **List values** are stored as stable keys (e.g. `"in_progress"`, not "In Progress").
- **Display** uses translations: `list.status.in_progress` → "In Progress" (localized per active language).
- **Locked values**: list values referenced in schema filters are auto-seeded and non-deletable.
- **Translation keys** are auto-generated: `tab.*`, `view.*`, `field.*`, `list.*.*`,
  `nav.<group>` (group labels), and `{{t:<key>}}` tokens in markdown views — all collected
  into the Languages tab.
