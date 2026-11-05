# Schema reference

A schema is one JSON document:

```json
{
  "$schema": "./schema.schema.json",
  "icons":  { "favicon": "./my-icon.svg", "png512": "./my-icon-512.png" },
  "theme":  { "light": { "primary": "#…" }, "dark": { "primary": "#…" } },
  "tables": { "tasks": { "columns": [ … ], "archivable": true } },
  "views":  [ { "name": "open_tasks", "sources": ["tasks"], "columns": [ … ] } ],
  "nav":    { "layout": "drawer", "items": [ … ] }
}
```

- `tables` hold the data; `views` present it; `nav` (required) is the menu that references both by name.
  Views and tables are flat lists: hierarchy lives only in `nav`.
- A view's kind follows from the object it carries: `sources` (data view), `markdown` (page), `rotation`,
  `calendar`, `pivot`, `rsvp`, `board`, `form`, `stats`, `timeline` or `scan`. You never write `kind`.
- Labels are translation keys (`tab.<table>`, `view.<view>`, `field.<column>`, `list.<list>.<value>`),
  edited in the Languages tab. The browser tab title is the `app.title` key.
- `validateSchema` checks the document at load and names each mistake it finds.

## the meta-schema (`schema.schema.json`)

Point your editor at it for completion and checking as you type; the app ignores the key:

```json
{ "$schema": "./schema.schema.json", "tables": { … } }
```

The column vocabulary is closed: an unknown column type or property (`"type": "slect"`, `"allowNews"`) is
an error at load, not a silent text column.

## icons + title

```json
"icons": { "favicon": "./examples/chores-favicon.svg", "appleTouch": "./examples/chores-icon-512.png",
           "png512": "./examples/chores-icon-512.png" }
```

| Field | Drives | Default |
|---|---|---|
| `favicon` | the browser tab | `./favicon.svg` |
| `appleTouch` | the iOS home-screen tile | `./icon-512.png` |
| `png512` | the install and splash icon: a square PNG, ≥144 px | `./icon-512.png` |
| `png512Sizes` | the size of a `png512` that is not 512×512 | `"512x512"` |

- Each field is optional and falls back to the default. Relative paths resolve against the site root;
  absolute URLs may be on another origin.
- Set `png512` too, or the installed app keeps the generic icon. `node dev/make-icon-png.mjs in.svg
  out.png 512` renders one.
- Prefer a drawn SVG to an emoji (emoji differ per platform). A favicon that 404s fails silently.
- A transparent `png512` looks different on each Android launcher; use an opaque one for a fixed look.

## tables

```json
"tables": { "tasks": { "columns": [ … ], "archivable": true } }
```

- `id`, `created_at`, `updated_at` and `_status` are implicit; never declare `id`.
- `archivable: true` adds Archive and Restore. Archiving sets `_status: "archive"`; the row stays where
  it is. (Older data in a separate `<table>__archive` store is read too; export and re-import to fold it in.)
- `isLookup: true` makes it a lookup table, edited in the Lookup tab instead of the menu.

### `hierarchy` — which column of a lookup is the group

```json
"ref_callings": { "isLookup": true, "hierarchy": { "parent": "organization", "value": "calling" }, "columns": [ … ] }
```

Declares the two dimensions of a lookup (an organization and its callings) once, for the Lookup editor,
a board's two-level lanes, a `list:` naming the table, and `rosterRef` rotations.

- Undeclared, a lookup with exactly two visible columns is read as a hierarchy. Declare it before adding
  a third column, or the editor falls back to a flat grid.
- `"hierarchy": false`: the table is flat (a chore and its points).
- `"by": "id"`: `parent` holds another row's id, so the tree is as deep as the data. Use it for new
  tables only: converting an existing lookup changes every stored value. A broken or cyclic parent makes
  the row a root; deleting a node that has children is refused.
- `parent` and `value` must be different visible columns (under `by: "id"` the parent may be hidden), and
  a `rosterRef` rotation must agree with them.

### `public` — readable with no account

`"public": true` lets anyone read the table, signed in or not (a timetable, a price list). Writing still
needs a grant. Visitors see the views whose tables are public, and a Sign in button. The lists those
tables use, the schema and the translations become readable too; nothing else does. A public table may
not have an owner column, or a `ref` to a table that is not public.

### A page's `search`

`"search": true` (or a column list) on a page puts a search box above its filters that narrows its
embedded lists.

### `copy` — copy a range of dated rows forward

```json
"copy": { "dateColumn": "starts_at", "reset": ["booked", "walk_ins"] }
```

On a data view embedded in a page with `filters`: a **Copy events** button for users who can write.
It copies the rows dated from–to onto a target date, by whole days; `reset` columns start at their
default, and rows already copied are skipped.

### `archiveAfter` — file finished rows away on their own

```json
"archiveAfter": { "column": "status", "values": ["approved", "rejected"], "after": "7d" }
```

A row whose `column` holds one of `values` is archived once it has gone `after` without an edit.

- `after`: `30min`, `2h`, `1d`, `2w`, `1m`, `1y`; `0d` archives at once.
- The clock is `updated_at`, so the table must declare it (`{ "name": "updated_at", "type": "text",
  "hidden": true }`). `dateColumn` ages from the row's own date instead.
- It runs in the browser at load, for users who could archive by hand. A row restored by hand stays.
- A total over the table needs `includeArchive: true`, or it loses rows as they age out.

### column types

| Type | Holds |
|---|---|
| `text` | text (the default) |
| `number` | a number |
| `date` | a date, `YYYY-MM-DD` |
| `datetime` | a moment, shown in local time, stored as UTC (`2026-10-13T15:40:00.000Z`). A calendar or rsvp event lands on its local day. |
| `select` | a value from a named list |
| `multiselect` | old spelling of `select` + `multiple: true`; migrated on load |
| `ref` | a value from a lookup table |
| `url` | a link |
| `image` | a picture reference: a URL or `asset:<id>`, never the bytes. Uploads are resized and stripped of metadata in the browser, then stored in the blob store (≤2560 px, <2 MB) or, without one, in `_assets` (≤1600 px, <900 KB), with a thumbnail. |
| `owner` | the creating user's email, stamped and read-only. Lets members write their own rows without a grant (see Self-service tables). |

### column properties

The list is closed: anything else is an error at load.

| Property | Meaning |
|---|---|
| `name` | Required. |
| `type` | Default `"text"`. |
| `hidden` | Not shown. |
| `list` | The list a `select` uses. It may name a lookup table. |
| `allowNew` | The picker accepts new values, which join the list. |
| `sorted` | Sort the options alphabetically. |
| `multiple` | Several values, stored as an array, edited as chips. Works on `select` and `ref`. |
| `picker` | `"dropdown"` (default), `"chips"`, `"toggle"`, or `"cards"` (each option's catalogue row as a card; needs a `ref` or a lookup list). Not with `multiple` or `allowNew`. |
| `syncFrom` | Mirror the column from another table. |
| `listSwitch` | An alternate list the cell can switch to: `{ "label": "External", "list": "external_workers" }`. |
| `stamped` | Filled by the app and never rewritten (see `stamped` below). Needs `defaultFrom: "@me"` and a `list`; one per table. |
| `default` | A literal set when a row is created, then editable (`"default": "logged"`). |
| `defaultFrom` | Set at creation from a token: `"@today"`, or `"@me"` (the user's identity for this column). Wins over `default`; stays editable. |
| `table`, `valueCol` | For a `ref`: the lookup table and the column stored. |
| `label` | For a `ref`: columns that name the row in pickers and cells (`["plan", "start_on"]`). |
| `filterBy` | For a `ref`: narrow options by another column of the row (`{ "state": "state" }`). |
| `listFilter` | Which lookup rows a picker offers, as a condition (`{ "kind": "position" }`). Stored values keep rendering; the named values cannot be renamed or deleted. |
| `enabledWhen` | Which options may be chosen, as a condition over each option's row; the rest stay visible, greyed. An operand may be `{ "view": "…", "field": "…" }` (a view's first row) or `{ "col": "…" }`. Display only. |

```json
"tasks": { "archivable": true, "columns": [
  { "name": "date", "type": "date" },
  { "name": "status", "type": "select", "list": "status", "default": "open" },
  { "name": "assigned_to", "type": "select", "list": "people", "allowNew": true, "multiple": true },
  { "name": "city", "type": "ref", "table": "cities", "valueCol": "city", "filterBy": { "state": "state" } }
] }
```

A `multiple` cell stores an array; `matchList` / `notMatchList` match any member; concurrent edits to one
array are last-writer-wins.

## views (flat)

```json
"views": [
  { "name": "combined", "sources": ["tasks", "notes"], "mode": "join", "columns": [ … ] },
  { "name": "attendance", "sources": ["tasks", "notes"], "mode": "union", "groupBy": { … }, "collect": "date", "columns": [ … ] }
]
```

### view properties

| Field | Meaning |
|---|---|
| `name` | Identifier. |
| `sources` | Tables to read. |
| `mode` | `"union"` stacks rows; `"join"` merges them by `id`. |
| `columns` | Column names, plus the conditional, computed and embed entries below. |
| `filter` | A row filter (see **filters**). |
| `readonly` | No editing. |
| `includeArchive` | Read archived rows too. Needed for totals, balances and history. |
| `layout` | `"table"`, `"card"`, `"list"`, `"gallery"` (tiles with a picture) or `"split"` (a list beside the selected record; two screens on a phone). |
| `gallery` | For `layout: "gallery"`: `image` (column), `size` (`small`/`medium`/`large`), `shape` (`square`/`landscape`/`portrait`), `fit` (`crop`/`contain`). |
| `collapsed` | Cards start collapsed. |
| `defaultSort`, `defaultSortDesc` | The initial sort column, and descending for newest first. |
| `requires` | Member-only: `{ table, from, to, where }`, shown only while the user has their own row covering today (an active membership). Admins and editors always see it. |
| `filters` | On a page: multi-selects that narrow every view embedded on it, remembered per viewer. |
| `preview` | Embedded: show the first N rows, with **Show all (M)**. |
| `hideEmpty` | Hide empty columns: across all rows in a table, per card in cards and boards. Per column: `{ "name": "c", "hideEmpty": false }`. |
| `icon` | An MDI icon for the menu. |
| `printable` | Print buttons: `"view"`, `"cards"` (card layouts only) or both. Off by default. |
| `markdown` | Makes the view a page (see **markdown**). |
| `access` | Pages only: readable only by users granted one of these tables. |
| `rotation` | Makes it a rotation view. |
| `search` | A search box: `true` for every column, or a column list. |
| `obscureNames` | Show person names as "First L.": `true` for every list column, or a column list. Display only. |
| `mineOnly` | Rotation views: show a member only their own slot. `{ "list": "…" }` names the identity list. |
| `fab` | The corner button: `"add"`, `"scan"`, `"none"`, `{ "add": "<view>", "label": "…", "icon": "…" }` or `{ "open": "<view>", "label": "…" }`. Overrides `nav.fab`. |
| `background` | A background image (see below). |

Besides column names, `columns` may hold:

- **A conditional column** `{ "name": "c", "when": { … } }`: shown only on rows that match.
- **An inline embed** `{ "sources": [ … ], "filter": { … }, "columns": [ … ] }`: a sub-table at that position.
- **A view embed** `{ "view": "name", "filter": { … }, "hideEmpty": true, "bare": true }`: another view
  (a page's whole document, if it has `markdown`); `bare` drops the box around it.

### background images

```json
"background": { "image": "asset:bg_frontPage", "fit": "cover", "position": "top", "opacity": 0.45 }
```

| Field | Meaning |
|---|---|
| `image` | Required: an `http(s)` URL, a raster `data:` URI, `asset:<id>`, or `icon:<mdi-name>` (an icon drawn as the picture; bare `icon:` is the menu entry's own). |
| `fit` | `cover` (default), `contain`, `tile`, or `width` (scaled to `width`% of the card). |
| `width` | 1–100, with `fit: "width"`. |
| `position` | `center` (default), `top`, `bottom`, `left`, `right` or a corner (`"top left"`). |
| `opacity` | 0–1, default 0.5 (a scrim in the theme's surface colour, so text keeps its contrast). |
| `fixed` | Fixed to the viewport. Unreliable on iOS. |

Backgrounds never print. Settings → Appearance overrides the schema's per database (stored in the app
config; removing one that the schema sets stores `{ "image": "" }`).

#### Where the bytes live

- **An external URL**: costs nothing, but each viewer's browser contacts that host.
- **A storage bucket** (Firebase or Supabase Storage): best for many or large pictures. Firebase Storage
  needs the Blaze plan.
- **The database**: `asset:<id>`, an `_assets` row holding a data URI of at most 900,000 characters.
  Works on every backend. Appearance uploads always go here; `image` columns go here when there is no
  bucket.

Uploads keep transparency (a transparent PNG becomes WebP) and are never SVG, which can carry script.

### filters

A filter is an object of conditions that all must match:

```json
{ "status": "open", "city": "X" }
{ "$and": [ { "city": "X" }, { "$or": [ { "status": "open" }, { "status": "in_progress" } ] } ] }
{ "assignee": { "matchList": "leads" } }
{ "done_on": { "within": "@month" } }
```

- Each field takes a value (equality) or an operator; see the table under **conditional columns**.
- `"@me"` is the signed-in user's identity for that column: a `userlink` list's linked value, else the
  profile name. No identity matches nothing. Display only: it never widens access.
- `within` takes `@today`, `@week`, `@month`, `@year`, optionally back-offset (`@month-1`), recomputed each
  render (weeks start Monday); or `{ "calendar": "<view>" }`, the period that calendar shows.
- `matchList` / `notMatchList` read a list at runtime, so editing the list changes the rows.
- A row filter names only stored columns of the view's own sources, never computed ones; a wrong name is
  an error at load. Array values (`{ "status": ["a", "b"] }`) are an old shape, upgraded to `$or` on load.

### aggregate views (groupBy + collect)

```json
{ "name": "presenters", "sources": ["events"], "mode": "union",
  "groupBy": { "column": "person", "from": ["slot1", "slot2", "slot3"] },
  "collect": "date", "columns": ["person", "latest", "second", "third"] }
```

`groupBy.from` names the source columns holding the keys; `collect` gathers a column's values per group,
newest first, into the output columns after the key. `collectWith: "role"` adds the source column
("2026-06-01 (slot1)").

#### Leaderboard totals (`aggregate` count/sum/max/min)

```json
{ "name": "leaderboard", "sources": ["chore_log"], "mode": "union",
  "filter": { "done_on": { "within": "@month" } },
  "groupBy": { "column": "person", "from": ["person"] },
  "compute": [ { "name": "points", "computed": { "lookup": { "table": "chores", "match": "chore", "field": "points" } } } ],
  "aggregate": { "sum": "points", "into": "total" },
  "columns": ["person", "total"] }
```

- `aggregate`: `count: true`, `sum: "<col>"`, `max` or `min` (dates compare correctly), into `into`
  (default `total`). Sorted highest first.
- Filter rows with the top-level `filter`; `groupBy.filter` filters the keys (`{ "person": "@me" }`).
- `compute` derives per-row values before grouping (not displayed). Two defs into one column, scoped by
  `"source": "<table>"` with `"scale": -1` on one, net two tables into a balance.
- `groupBy.seed: true` adds a zero row for every catalogue value nobody has a row for (the group column
  must be a `ref`).
- `period: "month"` (or `week`, `year`) adds ‹ › to step back through periods.

### filterBy (per-card master-detail)

```json
{ "view": "tasks_view", "filterBy": { "owner": "name" } }
```

In card and list layouts, an embed shows only rows whose `owner` equals this card's `name`. A value may
be `{ "matchList": "leads" }`.

### computed columns

A column with `computed` is derived when shown, never stored or edited. On a table, every reader sees
it (views, lookups, forms, rules); in a view's `columns` or `compute`, only that view.

| Shape | Value |
|---|---|
| `{ "lookup": { "table": "chores", "match": "chore", "on": "chore", "field": "points", "default": 0 } }` | A field of the row in another table (or `"view"`) whose `on` equals this row's `match`. |
| `{ "count": "pauses", "on": "membership", "match": "id", "where": { … } }` | How many rows of a table point here. |
| `{ "dateAdd": { "from": "start_on", "months": { "col": "plan.months" }, "weeks": 1, "days": -1 } }` | A date moved; months clamp to the month end. |
| `{ "add": [1, { "col": "lvl" }] }` | A sum; blanks count as 0. |
| `{ "value": 100 }` | A fixed number. |
| `{ "daysSince": "needed_by" }` | Whole days from a date to today (negative in the future). |
| `{ "streakAt": "class_start", "interval": "weekly", "by": "owner", "levels": [1, 3, 8, 26] }` | The run of consecutive periods this row's date ends; with `levels`, how many thresholds it reached. |
| `{ "fromColumns": ["slot1", "slot2"], "matchList": "leads" }` | The values of those columns that are in the list, joined. |
| `{ "fromColumn": "person", "matchList": { "members": "Internal", "leads": "External" } }` | A label by which list holds the value. |

A **reference path** (`"plan.months"`, `"membership.plan.pause_weeks"`) follows `ref` columns to read a
column of another row; it works as a condition key, a `{ "col" }` operand and a `dateAdd` amount.

### conditional computed columns (`when`) + condition operators

Any column may carry `when`, which shows it only on matching rows (a card hides the field; a table
blanks the cell). Computed values are resolved first, so `when` may test one. Embeds take `when` too.

| Condition | Matches |
|---|---|
| `{ "f": "v" }` | equality |
| `{ "f": { "notEmpty": true } }`, `{ "empty": true }` | set / blank |
| `{ "f": { "ne": v } }` | not equal |
| `{ "f": { "lt": v } }`, `gt`, `lte`, `gte` | ordered: numeric when both are numbers, else as strings (so dates work). Blank never matches. Combine for a range. |
| `{ "f": { "gte": { "col": "g" } } }` | compared with another column of the row |
| `{ "f": { "matchList": "L" } }`, `notMatchList` | in / not in a list |
| `{ "$or": [ … ] }`, `{ "$and": [ … ] }` | groups |

Row filters, `when` and embed conditions share this one matcher.

### rotation columns (rotating duty rosters)

A duty cycles through an ordered list of groups, one per occurrence, looping at the end. The groups are
an ordinary table: a `position` number and a `people` multiselect (or another column, named by
`valueCol`). `"reorderable": true` on the table gives it up/down arrows that renumber `position`.

```json
"security_rotation": { "reorderable": true, "defaultSort": "position", "columns": [
  { "name": "position", "type": "number", "hidden": true },
  { "name": "people", "type": "select", "list": "staff", "multiple": true } ] }
```

A computed column in a view resolves whose turn it is:

```json
{ "name": "security", "computed": { "rotationTable": "security_rotation", "advanceBy": "occurrence",
                                    "occurrenceSource": "sessions", "occurrenceSort": "date" } }
{ "name": "cleanup",  "computed": { "rotationTable": "cleanup_rotation", "advanceBy": "calendar", "interval": "weekly" } }
```

- **`occurrence`**: the nth row of `occurrenceSource` (sorted, ties broken by `id`) gets the nth group.
  Deleting a row shifts every later one back; archiving does not, so archive past occurrences.
- **`calendar`**: whole intervals since the view's anchor date. The anchor is set on the rotation view
  ("Start date") and stored per view in the app config; `anchorDate` on the column overrides it.
- `interval`: `daily`, `weekly` (default), `monthly`, `yearly`, or `<n><d|w|m|y>` (`3w`). Unknown values
  are an error.
- The rotation tables load automatically; they need not be in the view's `sources`.

## markdown (documents)

A view with `markdown` is a page:

```json
{ "name": "home", "markdown": "# Welcome\n\nOpen items:\n\n{{view:open_tasks?}}\n\n{{table:tasks}}" }
```

| Token | Renders |
|---|---|
| `{{view:x}}`, `{{table:x}}` | That view or table, live and editable (with the usual permissions). |
| `{{self}}` | This view's own grid, when the page also has `sources`. |
| `{{view:x?}}` | Nothing at all when it has no rows. |
| `{{table:x@archive}}` | The archived rows, read-only. |
| `{{view:x@both}}` | Active and archived behind a tab toggle (shown once there are archived rows). `partitionLabels` renames the tabs. |
| `{{t:key}}` | A translated text block (`text.*`), edited in the Languages tab. |

- Markdown covers headings, bold, italic, lists, links and paragraphs.
- The body is stored in the `_pages` store and edited in the app (the corner Edit toggle). The schema's
  `markdown` is only the starting text.

### Restricting a page to some users (`access`)

```json
{ "name": "staff_handbook", "markdown": "…", "access": ["hr", "payroll"] }
```

- Readable only by users granted one of these tables (admins and full-access users always).
  `["all"]` means full-access users only.
- Enforced by every backend's access policy, embedded or not.
- It restricts **reading**: any editor may edit any page.
- It protects the stored body, not the schema's starting text, which every member can read. Keep secrets
  out of the schema's `markdown`.

## rotationView (third view kind)

A view with `rotation` generates a table of periods (no stored rows):

```json
{ "name": "cleanup_schedule", "layout": "table", "rotation": {
    "columns": [
      { "name": "zone_a", "rotationTable": "zone_a_rotation", "advanceBy": "calendar", "interval": "weekly" },
      { "name": "zone_b", "rotationTable": "zone_b_rotation", "advanceBy": "calendar", "interval": "weekly" } ],
    "range": { "from": "today", "periods": 12 } } }
```

- `range.from`: `"today"` (rolling) or a date (fixed, for printing); `range.periods`: how many intervals.
- Calendar mode only. The rows follow the first column's interval; all columns share the view's anchor.
- Read-only and recomputed: editing a roster changes past and future periods alike.
- The toolbar (start date, window) is for users who can write the rosters.

### Rotating assignment (`slots` + `rosters` + `rotateEvery`)

Rotates which roster serves which slot:

```json
"rotation": { "slots": ["zone_a", "zone_b"], "rosters": ["team_a", "team_b"],
              "interval": "weekly", "rotateEvery": 1, "range": { "from": "today", "periods": 12 } }
```

- Each roster advances one member per period on its own length; `rotateEvery` shifts rosters across
  slots: `n` every n periods, `"cycle"` once per full pass of the first roster. A list sums them
  (`[1, "cycle"]`); `0` or absent fixes each slot to its roster.
- Each period is a permutation, so no slot is doubled or empty. Fewer rosters than slots is an error.
- The anchor fixes the pairing for a date; moving the display window never reshuffles it.
- With two slots swapping every period (`rotateEvery: 1`), a roster of even length keeps each member on
  one slot. `"cycle"` alternates them whatever the length.
- **A person × task matrix**: name the slots after people and give each a roster of their task sets
  (`valueCol: "tasks"`); one row means fixed tasks, N rows cycle.

### Per-person views (`mineOnly`)

`mineOnly: { "list": "members" }` on a rotation view shows a member only the slot that is them (matched
case-insensitively to their identity in that list; `true` uses the profile name). Admins see everything;
an unresolved identity sees no slots. Embed it as `{{view:rota?}}` so the section disappears for someone
with no slot. Display only.

### `rosterRef` — one 2-D lookup instead of a table per slot

```json
"rotation": { "rosterRef": "ref_duties", "rosterBy": "person", "valueCol": "tasks", "interval": "weekly" }
```

The whole roster is one lookup: the distinct `rosterBy` values are the slots, in `position` order, and
each slot's rows are its sequence. Adding a person is a row typed in the app, not a schema edit.

- Slot headers translate through `list.<lookup>.<value>`; cells through `valueCol`'s list.
- `rotateEvery`, `cycle`, `range`, `mineOnly` and `anchorDate` work the same. Not combinable with
  `slots` + `rosters`.
- A member outside the rotation: a row with a blank `valueCol`, plus `skipEmpty: true` (their empty
  group never takes a turn) and the view's `hideEmpty`.
- Per-person editing comes from an `owner` column with `ownerWritable`, not from table grants.

## calendar (fourth view kind)

A view with `calendar` shows rows of one or more tables (and generated rotation duties) on a year, month,
week or list calendar, by a date column. It stores nothing of its own.

- **Month** and **week** show a count per day; a click lists that day's events below the grid. **Year**
  is twelve small months. **List** is an agenda with an **Undated** section for rows with no date.
- An event's dot is coloured by its type: the source's `label`, or the table's `tab.<table>` name.

```json
"calendar": { "source": "chore_log", "dateColumn": "done_on", "titleColumns": ["chore", "person"],
              "defaultView": "month", "weekStart": 1 }
```

Several tables, or one table twice with different dates:

```json
"calendar": { "sources": [
  { "table": "meetings",     "dateColumn": "date",   "titleColumns": ["topic"],  "label": "Meeting" },
  { "table": "appointments", "dateColumn": "starts", "titleColumns": ["person"], "label": "Appointment" },
  { "table": "appointments", "dateColumn": "ends",   "titleColumns": ["person"], "label": "Expiry" } ] }
```

| Per-source field | Meaning |
|---|---|
| `table`, `dateColumn` | Required. |
| `titleColumns` | Joined with " — " for the title. |
| `filter` | A row filter. |
| `label` | The type tag and colour key. |
| `endColumn` | The row lasts until this date (a pause week); shown on every day, up to 92. May be computed. |
| `durationColumn` | Minutes a timed event lasts (a column or a reference path); sets the end in an `.ics`. |
| `feed: false` | Shown on screen, left out of a published feed. |
| `respond` | An rsvp view over this table: each event carries its booking control and places left, under the same rules as the booking list. |

`"export": false` on the calendar removes the download button.

A member's own bookings on a calendar need no feature: give the responses table a computed column that
looks up its event's date and use it as the `dateColumn`.

### Filters the reader picks (`filters`)

`"filters": ["gym"]` puts a multi-select per column above the calendar; the options are the column's own.
A filter narrows only events whose row has the column. Picks are remembered per reader and calendar.

On a page with `filters` embedding a stats view with `tiles`, **Add to comparison** saves the picks as a
row of a table under the stats. An editor's rows are stored with the page and seen by everyone; anyone
else's stay in their browser.

### Adding on a day (`addTo`)

**+** on a selected day creates a row with that date and opens it. With several sources, `"addTo":
"<table>"` names the target; without it there is no **+**. Offered to anyone who can add to that table,
including through self-service.

### Rotation duties (`rotationSources`)

```json
"rotationSources": [ { "view": "duty_rotation", "label": "Duty" } ]
```

A rotation view's duties as read-only events (`Zone A: Alex, Sam`), generated with the view's own anchor
and settings, so they match it. Included only if the user can read one of its rosters.

### Access and labels

- A source the user cannot read contributes nothing. The calendar is in the menu while the user can reach
  any source (self-service included); the same any-of rule applies to every kind that names its inputs
  outside `sources`.
- Its texts are `cal.*` and `period.*` keys. Day and month names come from `Intl`, with the language's
  `code` as the locale (or its `locale`).
- Embed it in a page with `{{view:<calendar>}}`.

## pivot (fifth view kind)

A cross-tab: rows are the values of one column, columns the values of another, each cell an aggregate.

```json
"pivot": { "source": "chore_log", "row": "person", "column": "chore",
           "cell": "minutes", "aggregate": "sum", "totals": "sum" }
```

- `aggregate`: `count` (the default without `cell`), `sum`, `first` (the default with `cell`), `list`.
- `totals`: `count`, `sum` or `{ "eq": "coming" }` (cells equal to a value): adds a totals row, column and
  grand total.
- `colOrder` fixes the columns, empty ones included; otherwise `colSort` / `rowSort` (`asc`, `desc`).
- A multiple value counts in each of its buckets; blank keys are skipped.

## rsvp (sixth view kind)

A sign-up sheet: each upcoming event has a status control bound to the user's own response row.

```json
"rsvp": {
  "events": "practices", "dateColumn": "date", "titleColumns": ["title"],
  "responses": "rsvps", "statusColumn": "response",
  "picker": "toggle", "showCounts": true, "rosterVisibility": "all" }
```

| Key | Meaning |
|---|---|
| `events`, `dateColumn` | Required: the events table and its date or datetime (filters upcoming, sorts). |
| `responses`, `statusColumn` | Required: a table with an `owner` column and a `ref` to the events table by `id`, and its status column. |
| `statuses` | Inline options. Better: make `statusColumn` a `select` with a list, editable in the Lookup tab. |
| `statusList` | The translation namespace for the labels, when the column's own name would clash. |
| `picker` | `dropdown` (default), `toggle` or `chips`. Deselecting removes the response. |
| `showCounts` | A count of each status per event. |
| `rosterVisibility` | Who sees names: `all`, `admins` or `counts`. Display only. |
| `ahead` | `"3d"`: today and the next two days, with **Show more**. |

- The link is the responses table's `ref` column by `id`; two events on one date stay separate.
- **Who can read responses** is set on the responses table: `"privateRoster": true` makes each readable
  only by its owner and organizers; otherwise rows carry `rosterPublic: true`. See
  [What `privateRoster` actually guarantees](#what-privateroster-actually-guarantees).
- An organizer has a **QR code for this page** (`?view=<view>`): a member's camera opens it signed in as
  themselves. A `?view=` link opens a screen only if the reader's nav reaches it.

### `closeBefore` — booking from home stops before the start

With a datetime `dateColumn`, `"closeBefore": "30min"` (`min`, `h`, `d`) closes booking from anywhere 30
minutes before the start; until the start it stays open at the venue (after opening the check-in link or
checking in today). Once an event has started nobody joins or leaves. A screen rule, not a server one.

### `release` — a no-show's place comes back before the start

`"release": "10min"`: from then until the start, a booking not checked in loses its place (its status is
cleared). It runs in the organizer's check-in pass (the open QR or **Check in**), so needs a datetime
`dateColumn` and `checkin.set`.

### `blockedBy` — refused during the member's own periods

```json
"blockedBy": { "table": "pauses", "from": "starts_on", "to": "pause_until", "where": { "sent": "yes" }, "message": "text.paused" }
```

A day inside one of the caller's own rows of `table` (from–to, filtered by `where`) cannot be booked or
checked in to; `message` is shown. `to` may be computed. On a `scan` view it refuses the scan.

### `requires` — allowed only inside the member's own periods

The opposite, same shape: a day must fall inside one of the caller's own rows (an active membership). A
row with no `to` covers one day. Staff are held to neither. Both are screen rules.

### `checkin` — self check-in with a shared code

```json
"checkin": { "codeColumn": "checkin_code", "set": { "attendance": "attended" }, "rotateMinutes": 5 }
```

- A member who booked today types the code shown at the venue; it is saved on **every** response they
  have today. One code covers the day's classes.
- An organizer types the real code and presses **Check in**: rows with a matching code get `set`. The
  real code is stored nowhere.
- The organizer can show the code as a QR linking `?view=<view>&scan=<code>`. `link`: `"arm"` (default)
  fills the box and waits for the member's press; `"submit"` saves at once.
- `rotateMinutes`: the code is random and changes on its own. While the QR is open it confirms every
  15 seconds, accepting the current and previous code.
- `codeColumn` must be `ownerWritable` and the `set` columns must not be; `validateSchema` checks.
- A code can still be relayed. Pair it with verified attendance (`ownerWritableWhile`) to freeze marked
  responses.
- With `checkin.set`, staff can tap a booked person's chip to mark them (someone with no phone).

### `capacity` — places, and the booking refused when they are gone

A property of the responses table, enforced by the server:

```json
"capacity": { "link": "class", "status": "booking", "column": "capacity", "count": "booked", "holds": ["booked"] }
```

| Key | Meaning |
|---|---|
| `link` | The ref column naming the event by `id`. |
| `status` | The response column. |
| `column` | The events table's limit (a number; blank = no limit). |
| `count` | The events table's number column the server keeps the count in. |
| `holds` | Statuses that take a place (default: any non-empty one). |
| `reserved` | Places taken outside responses (walk-ins); staff set it with a − n + stepper. |
| `waitlist` | `{ "status": "waitlisted", "start": "starts_at", "until": "10min" }` (Supabase and dev server only): a full event offers this status; a freed place goes to the longest waiting until `until` before `start`. |

- The list shows *Places left: N* or *Full*. Booking the last place on a stale screen is refused and
  rolled back.
- The count lives on the event row because a private roster lets no client count others' responses.
- Postgres recounts in a trigger with the event row locked. Firestore rules make the client move the
  count by exactly one in the same transaction.
- A member's response cannot change its event; queue order is the server's `updated_at`.

## search — a box the reader types in

`filter` decides what a view is; `search` is what the reader wants now. On a data or board view, or a table:

| Value | Meaning |
|---|---|
| absent / `false` | No box (the default). |
| `true` | Every column except bookkeeping (`id`, `created_at`, `updated_at`, `owner`, `rosterPublic`, `_status`, `_source`). |
| `["col", …]` | Only these. |

- Every word must match somewhere in the row (`kati tup`), and diacritics fold both ways (`hameen` finds
  *Hämeen*).
- It matches what the screen shows (translated values, ref labels, linked names) as well as what is
  stored.
- It narrows the view, never the data that writes read. Navigating clears it; reordering is off while it
  is active. The count reads `shown / total`.

## board (seventh view kind)

A kanban board: one table's rows as cards in lanes by one column; dragging a card (or its move menu)
writes that column. It is a data view plus a lane, so `filter`, `compute` and `defaultSort` apply.

```json
{ "name": "tickets_board", "sources": ["tickets"], "mode": "join", "columns": ["title", "assignee"],
  "board": { "lane": "status", "lanes": ["open", "in_progress", "done"], "hiddenLanes": ["cancelled"],
             "laneGroups": [ { "label": "Closed", "lanes": ["done"], "collapsed": true } ],
             "title": "title", "color": "assignee", "addInLane": true, "summary": ["assignee"],
             "laneWhen": { "done": { … } } } }
```

| Key | Meaning |
|---|---|
| `lane` | Required: a `select` or `ref` column of the single source. |
| `lanes` | Lane order; listed lanes show even when empty. Default: the list's order, else first seen. |
| `hiddenLanes` | Lanes left off. |
| `laneGroups` | Lanes folded under phase headers (`board.group.<label>` translates). |
| `title` | The card heading (default: the first of `columns`). |
| `color` | A column whose value tints the card's edge. |
| `addInLane` | A **+** per lane adding a row with that lane value. |
| `summary` | Cards start closed, showing these on one line; the chevron opens a card for editing. |
| `laneWhen` | A card may enter that lane only while its row matches (`{ "balance": { "gte": { "col": "cost" } } }`). A screen rule. |

- A `ref` lane into a two-level lookup groups by the lookup's parent; adding or reordering lanes is then
  data entry in the lookup.
- On a `reorderable` table, cards order by `position` within a lane and can be dragged or moved with
  arrows (not on self-service tables, in the archive or while searching).
- Cards have the grid's row actions (edit, archive, delete) for users who can write; a table whose
  columns `syncFrom` a master gives a read-only board.

## form (eighth view kind)

One record filled in with labels, sections and required fields: a survey, an application, feedback. The
record is the member's own `owner` row, so no new access rules are needed.

```json
"form": { "table": "palautteet",
          "sections": [ { "title": "field.perustiedot", "columns": ["nimi", "email"] },
                        { "title": "field.viesti", "columns": ["aihe", "viesti"] } ],
          "required": ["aihe", "viesti"], "submitColumn": "tila", "submitValue": "submitted" }
```

| Key | Meaning |
|---|---|
| `table` | Where the record is written; must have an `owner` column. |
| `sections` / `columns` | Titled groups of fields, or one untitled group. |
| `required` | Must be answered (an empty array is unanswered; `0` and `false` are answers) before submitting. |
| `once` | `true` (default): one record per person, reopened. `false`: a new record each time (needs `submitColumn`). |
| `submitColumn`, `submitValue` | Stamped on submit (default `"submitted"`). |
| `compute` | Computed columns shown read-only (an end date from a start and a plan). |
| `rules` | `[{ "require": <condition>, "message": "<key>" }]`: must hold before submitting. |
| `intro`, `done` | Markdown above the form, and in its place once locked. |
| `startLabel`, `submitLabel` | Button labels. |

- Fields save as they change; **Submit** only marks the record done. No row exists until the person starts.
- To make submission final, add `"ownerWritableWhile": { "tila": "luonnos" }` to the table.
- Signed-out visitors are asked to sign in.

## stats (ninth view kind)

Headline numbers, each optionally a bar towards a goal. A stats view is an ordinary data view (`sources`,
`filter`, `compute`, `groupBy`, `aggregate`, `period`) with another renderer, so a leaderboard becomes bars
by adding `stats`:

```json
{ "name": "chore_points_week", "sources": ["chore_log"], "mode": "union",
  "groupBy": { "column": "person" }, "aggregate": { "sum": "points", "into": "total" },
  "filter": { "done_on": { "within": "@week" } }, "period": "week", "includeArchive": true,
  "stats": { "rowTiles": { "label": "person", "value": "total" }, "goal": "max" } }
```

- **`rowTiles`** `{ label, value, goal?, order?, limit?, skipUntargeted? }`: a tile per row of an aggregated view.
- **`tiles`**: a scorecard over all rows. Not both.

```json
"stats": { "tiles": [
  { "label": "text.pulse_awaiting", "agg": "count", "when": { "status": "logged" } },
  { "label": "Points this month", "agg": "sum", "column": "points", "goal": 60 } ] }
```

| Tile key | Meaning |
|---|---|
| `agg` | `count`, `distinct`, `sum`, `avg`, `min`, `max`, `latest`, `streak`. All but `count` need `column`. |
| `when` | A condition narrowing this tile's rows. |
| `plus` | `[{ agg, column, when }]` added to the value. |
| `divide`, `decimals` | Show in a bigger unit (`60`: minutes → hours). Only `avg` and divided values are rounded. |
| `display` | `bar` (default) or `number`; per tile or view-wide. |
| `icons` | `[{ "at": 3, "icon": "mdi-fire" }, …]`: the icon of the highest rung reached. |
| `goal` | A number, `"max"` (the largest tile), a ladder (below), or `{ "column": "target" }` (per row, `rowTiles` only). No goal, no bar. |

- Blank cells are skipped, not read as 0. A value over its goal fills the bar and shows the real number.
- `streak` counts consecutive `interval`s (`daily`, `weekly`, `monthly`) with a row dated by `column`; the
  current period does not break it until it is over.
- `order: "behind"` sorts `rowTiles` by the share of their own goal reached, lowest first; tiles with no goal
  last. `skipUntargeted: true` drops tiles with no goal, so a `groupBy.seed` catalogue is measured only where
  a target is set.
- `period` ‹ › works at top level only; an embedded stats view shows the current period.

### A tile per period (`series`)

```json
{ "agg": "sum", "column": "minutes", "goal": "max", "series": { "column": "done_on", "interval": "weekly", "count": 6 } }
```

One tile per period, the last `count` (1–60) ending now, oldest first. `when`, `plus`, `divide` and `goal`
apply to each; on a page with `filters` each period is a comparison column. Not with `streak`.

### Tiered goals (bronze / silver / gold)

```json
"goal": [ { "at": 10, "label": "text.tier_bronze" }, { "at": 20, "label": "text.tier_silver" }, { "at": 30, "label": "text.tier_gold" } ]
```

The bar targets the next level and the badge names the level reached: 19 reads **19 / 20**, *Bronze*.
Levels must ascend; bare numbers work (`[10, 20, 30]`). Past the top the bar stays full. On `rowTiles` each
row is measured against its own next level; use `"max"` to compare rows on one scale.

### Calendars built in the app, not the schema

**Settings → Your own calendars** creates a calendar from tables, a date column, title columns and
rotation overlays, with an optional **Publish** switch. It is stored in the app config and loaded as an
ordinary calendar view (rendering, download, embeds, feeds).

- Every source is gated by the user's own access, so creating one reveals nothing.
- A schema view of the same name wins. Saving checks the tables and columns exist.
- To put one in the menu, add it to `nav`.
- Unpublishing or deleting it first overwrites the published file with an empty calendar.

### What a calendar's `.ics` contains (`calendar.ics`)

The download and the published feed write the same file:

```json
"calendar": { "source": "events", "dateColumn": "on", "ics": { "back": "3m", "forward": "1y", "lang": "fi" } }
```

- `back` / `forward` (defaults `3m`, `1y`) use the rotation interval vocabulary. Editable from the
  calendar toolbar; an admin's change is saved.
- `lang`: a download defaults to the reader's language, a feed to the database's default.
- A `datetime` source becomes a timed event (ending after `durationColumn` minutes); a `date` is all-day.
- A re-imported download updates events but never deletes them; a subscribed feed mirrors the file, so
  events outside the window disappear from it.

### Publishing a calendar as a subscribable feed (`feed`)

```json
{ "name": "family", "feed": true, "calendar": { "source": "events", "dateColumn": "on" } }
```

Publishes the `.ics` to the blob store at a stable URL that a phone subscribes to. Needs a blob store
(Supabase Storage, or Firebase Storage on Blaze).

- **The URL is a bearer credential**: anyone with it reads the calendar. It carries a 128-bit random id.
- `obscureNames` applies to the file as on screen.
- Republished after writes to its sources or overlaid rosters, coalesced, and only by a full-access
  client, so a restricted member's partial view never overwrites it.
- A shared feed cannot use `mineOnly` or an `@me` filter (`validateSchema` refuses both).
- Calendar apps refresh subscriptions on their own schedule, often hours.

#### Per-person feeds (`feed: "per-person"`)

One file per subscriber, rendered as they see the calendar. Every source (except `feed: false` ones) must
filter by `@me`, and every overlaid rotation must be `mineOnly`. Subscribing is a row the member creates
in a table named by `feedSubscribers`:

```json
"tables": { "cal_subs": { "privateRoster": true,
  "columns": [ { "name": "owner", "type": "owner" }, { "name": "lang" }, { "name": "active" },
               { "name": "fid" }, { "name": "url" } ],
  "ownerWritable": ["lang", "active"], "ownerWritableWhile": { "active": "yes" } } },
"views": [ { "name": "my_calendar", "feed": "per-person",
  "feedSubscribers": { "table": "cal_subs", "langColumn": "lang", "activeColumn": "active",
                       "idColumn": "fid", "urlColumn": "url" },
  "calendar": { "sources": [ { "table": "duties", "dateColumn": "on", "filter": { "who": "@me" } } ] } } ]
```

- The member owns `langColumn`, `activeColumn` (and `viewColumn`); the publisher owns `idColumn` and
  `urlColumn`, which must not be `ownerWritable`. `privateRoster` is required.
- Unsubscribing sets the active column to "no", which freezes the row; the next publish blanks the file.
- The calendar's **Subscribe** menu (also on an embedded calendar) subscribes, picks the language and
  copies the link once a full-access client has published it.

## timeline (tenth view kind)

Rows as bars across periods (a gantt chart), for rows that span days.

```json
{ "name": "project_plan", "sources": ["tasks"],
  "timeline": { "start": "starts_on", "end": "due_on", "label": ["title"],
                "from": "today", "periods": 12, "interval": "weekly" } }
```

- `start` (required) and `end` are date columns of the sources; `interval` uses the rotation vocabulary.
- `from` defaults to today. A row with no `end` (or an end before its start) is one period long.
- Rows outside the window are dropped; a bar crossing an edge is clipped with a square end.
- Read-only; rows come through the normal view pipeline (`filter`, computed columns, access).

## scan (eleventh view kind)

A code scanned or typed becomes a row: a chore done, a door on a security round, a checkpoint. The code
names the thing; the person is whoever is signed in.

```json
{ "name": "chore_scan", "sources": ["chore_log"], "filter": { "person": "@me" },
  "columns": ["done_on", "chore", "status"],
  "scan": { "column": "chore", "codeCol": "code", "set": { "done_on": "@today" },
            "once": "day", "label": "text.door_code", "link": "arm" } }
```

| Key | Meaning |
|---|---|
| `column` | Required: a `ref` column. A code must match a row of its lookup (case and spaces ignored); no match or two matches writes nothing. |
| `codeCol` | The lookup column the code matches (default: its `valueCol`), e.g. an EAN. |
| `set` | The rest of the row: literals, `@today` or `@now`. |
| `once` | `"day"` or `"ever"`: refuse a second scan of the same code by the same person. Omitted, every scan appends. |
| `label` | The box's label. |
| `link` | What a `?view=…&scan=<code>` link does: `"arm"` (default) fills the box; `"submit"` writes at once. |

- It is a data view over the log it writes, plus a box. Embedded (`{{view:chore_scan}}`) it shows only
  the box, so it rarely needs a menu entry.
- Each scan reports `created`, `already` (with when), `unknown` or `ambiguous`.
- The row is written through self-service: the table needs an `owner` column, and `ownerWritable` must
  include `column` and every `set` key. `validateSchema` checks.
- A QR holding `?view=<view>&scan=<code>` opens in any phone camera. Where the browser has
  `BarcodeDetector`, a camera button reads a photographed label in the page.

### A code that changes (`verify`) — a screen at the door vouches for it

```json
"scan": { "column": "gym", "set": { "visited_on": "@today" },
          "verify": { "claim": "door_code", "set": { "verified": "yes" }, "rotateMinutes": 5 } }
```

- The code is shown on a screen at the door and changes every `rotateMinutes`. The member's scan is
  saved as a `claim`; the door screen (the same view opened by staff) confirms claims on the current or
  previous code every 15 seconds, writing `set` and the door.
- `claim` must be `ownerWritable`; `set` and `column` must not be. Not with `once`. Count confirmed rows
  only (`when: { "verified": "yes" }`).
- **A tablet at the door**: sign it in as an editor with `rw` on the log and `r` on the catalogue. The QR
  has **Full screen** and **Lock** (a PIN of 4+ digits, kept in that browser). Pin the browser with the
  OS (Guided Access, app pinning).

### Printing the codes

**Print codes** in the Lookup editor (on a catalogue some scan view reads) prints a label per row: its
name, a QR with the `?scan=` link, and the code as text. Each row also has its own print button. Without
the QR library the sheet falls back to Code 39 (uppercase; `0-9 A-Z - . space $ / + %`), which a handheld
scanner reads. A handheld scanner types the code and Enter into the box.

## Translatable lists (`translatableLists`)

List values translate through `list.<list>.<value>` keys. The Languages tab's **Lists** section offers:

1. Values a schema `filter` or `when` names (locked against rename and delete, since logic depends on them).
2. Every value of each list or lookup table named in `"translatableLists": ["tilat", "ref_callings"]`
   (a lookup's text columns only).

An untranslated value shows as itself.

### A `list:` may name a lookup TABLE

```json
{ "name": "tasks", "type": "select", "multiple": true, "list": "ref_chores", "sorted": true }
{ "name": "responsible", "type": "select", "list": "ref_callings", "valueCol": "slug" }
```

- The options are the lookup's rows: its `hierarchy.parent` (else its name column), or `valueCol`. Values
  are deduped and translate as `list.<table>.<value>`.
- `listFilter` keeps a row out of the picker without removing it from the catalogue.
- Not editable as a list (no `allowNew`); the lookup is maintained in the Lookup tab under its table grant.

## Who may edit a list (`userWritableLists`)

List values are shared vocabulary, so only admins edit lists, unless named:

```json
"userWritableLists": ["shop_items"]
```

- Any registered user may then add, rename, reorder and remove that list's values (in the Lists editor or
  an `allowNew` cell). Deleting the list stays admin-only.
- An allowlist, not the table grant, because a list belongs to every table that uses it.
- Enforced by every backend from a `_meta/listWritable` mirror written by `saveSchema`.

## Self-service tables (Firebase)

A table with an `owner` column is self-service: a registered member may create, edit and delete their own
rows without a grant; editors with a grant and admins manage all rows. The `rsvp`, `form` and `scan`
kinds build on it. Every backend enforces it, not only Firebase.

- **Who reads the rows**: each row carries `rosterPublic: true` (everyone can read it) unless the table
  sets `"privateRoster": true` (only its owner and grant holders).
- The lists its columns use are readable by every registered member.
- A read-only grant (`{ "<table>": "r" }`) plus an `owner` column lets a member see every row and change
  only their own.
- Firestore rules cannot filter, so a member without a grant reads `owner == me` and `rosterPublic ==
  true` as two queries; nothing else is visible to them.
- `saveSchema` mirrors the owner tables to `_meta/ownerTables`; the rules allow owner-create only there.

#### What `privateRoster` actually guarantees

The flag rides on each row and is written by the client. So `privateRoster` stops the app from
publishing submissions, but a member talking to the backend directly may mark **their own** rows public.
Nobody can publish anyone else's. Turning it on later does not hide rows already stamped public. For a
secret that must hold against members, use a table only organizers are granted.

## Access modes (`r` / `rw`)

A user's grant `tables` is one of:

| Stored value | Means |
|---|---|
| `"all"` | every table, read and write |
| `["tasks", "notes"]` | legacy: read and write on each |
| `{ "tasks": "rw", "ref_chores": "r" }` | per table; `"r"` is visible but not editable |

- Edited in Settings → Users as two chip columns, *Tables* (edit) and *Can view*.
- Writes are checked against `rwTables`, saved beside the grant.
- Editing a list needs write access to a table that uses it.
- No grant means no access.

### `ownerWritable` — which columns an owner may set

```json
"chore_log": { "ownerWritable": ["person", "chore", "done_on", "note"], "columns": [ …,
  { "name": "status", "type": "select", "list": "chore_status", "default": "logged" } ] }
```

The owner logs the chore; `status` is not theirs to set, so a parent approves. Grant holders and admins
are not bound.

- Without `ownerWritable` the owner writes the whole row.
- On create, a column outside the list must hold its `default`, so a row cannot be born approved.
- `id`, `owner`, `created_at`, `updated_at` and `rosterPublic` are always allowed.
- A `defaultFrom` column must be in the list (its value cannot be predicted).
- Enforced by every backend from `_meta/ownerWritable`; the UI shows those cells read-only to the owner.

### Identity columns — an owner may only ever name themselves

A list-backed `defaultFrom: "@me"` column in `ownerWritable` must hold the caller's own value (Ann may log
a chore as Ann, not as Bob), on create and update. Grant holders are not bound. The check reads the
`identity` map that linking a list value to an account writes onto the user's grant; grants written
before that are not checked until the link is saved again.

### `ownerWritableWhile` — until when an owner may set them

```json
"ownerWritableWhile": { "status": "logged" }
```

The owner may edit or delete their row only while `status` is one of the values (`["logged", "rejected"]`
allows resubmitting). Read off the stored row. Creates always pass; one column only; needs `ownerWritable`.

### Verified attendance — a status the member cannot set, which then freezes their entry

```json
"rsvps": { "ownerWritable": ["practice", "response", "note"], "ownerWritableWhile": { "attendance": "pending" },
  "columns": [ …, { "name": "attendance", "type": "select", "list": "attendance_status", "default": "pending" } ] }
```

The member changes their response until an organizer marks `attended` or `absent`; then it is frozen.

- The gate column needs a non-empty `default` (a blank one freezes the row from birth).
- Adding the gate to a table with rows freezes them until the column is filled in.

### `stamped` — a column the app fills in and nobody rewrites

```json
{ "name": "added_by", "type": "select", "list": "members", "defaultFrom": "@me", "stamped": true }
```

On a shared table (a shopping list anyone may tick off), records who added the row. On create it must be
the caller's own value; afterwards nobody but an admin changes it. A write that does not touch it is
unaffected; an empty stamp may be filled with your own name. A caller with no linked identity cannot
create rows. One per table, with `defaultFrom: "@me"` and a `list`.

Use `ownerWritable` for a decision a grant holder makes; `stamped` for a fact about who acted.

## user profiles, user-backed lists & membership (Firebase)

All backends implement these; see BACKEND_API.md for the methods.

### `_profiles/<email>` — opt-in display name + avatar

**Settings → My profile**: a `name` (what `@me` resolves to by default), `shared` (opt in to showing it to
other members) and a `picture` (≤256 px, stored inline).

### `listSources: { "<listName>": "users" }` — a name list fed by profiles

The shared profile names are merged into the list's own values, so its columns and rosters can name
registered users without upkeep.

### `listSources: { "<listName>": "userlink" }` — curated names, linked accounts

The list keeps its own values; an admin links each value to an account in the Lookup tab. `@me` on that
list resolves to the caller's linked value, and avatars follow the account.

| | `"users"` | `"userlink"` |
|---|---|---|
| The name comes from | each user's profile | the list, curated by an admin |
| A profile rename | changes the value | changes nothing |
| Setup | users tick *share my name* | an admin links each value |

#### `"userlink-name"` — the value names a ROLE, the cell shows who holds it

```json
"listSources": { "members": "userlink", "callings": "userlink-name", "ref_callings": "userlink-name" }
```

- The cell shows the linked person's name, with the role beside it in the picker and tooltip. Unlinked,
  or a profile the viewer may not see, it shows the translated value.
- A lookup table may be the namespace; links are keyed by the `valueCol` its columns use.
- It resolves live, so archived rows show today's holder.
- Renaming or deleting a value moves or drops its link.

### Membership requests (self-service, admin-approved)

A signed-in, unregistered user requests access with a display name. An admin approves it in Settings →
Users with the schema's `newUser` grant (or as an editor with no tables), seeding the name into the
profile, or denies it.

```json
"newUser": { "role": "viewer", "tables": { "classes": "r", "news": "r" } }
```

- `"open": true`: no approval; a signed-in account registers itself with exactly this grant (checked by
  the server). Needs `tables`. Pair it with public tables and member-only views for an app anyone can join.
- `role` is `viewer` or `editor`; `tables` is a list or a map of `r` / `rw`.

## nav (structure + layout)

```json
"nav": {
  "layout": "drawer",
  "items": [
    { "view": "home", "icon": "mdi-home" },
    { "group": "Data", "icon": "mdi-database", "description": "The raw tables",
      "items": [ { "view": "combined" }, { "table": "tasks" } ] } ],
  "bottomNav": ["home", "combined"],
  "fab": "add"
}
```

- Items are `{view}`, `{table}` or `{group, items}`, nested to any depth; a `{view}` with `items` is its
  section's page. Opening a group shows a page of its entries. Group labels must be unique.
- An entry shows only to users who can reach it. Lookup, Languages and Settings are added automatically.
- Back and Forward move between screens; a reload keeps the open one.

| Key | Meaning |
|---|---|
| `layout` | `drawer` (default), `tabs` (top, desktop), or `browse` (pages with a breadcrumb). Each user may override it in Settings → Navigation. |
| `display` | Browse: `list` (default), `tiles` or `carousel`; on `nav` or on one group. A carousel is swiped sideways and its centred tile opens on a tap; it is drawn on a phone for up to 8 entries, else tiles. |
| `icon`, `title` | Per entry. |
| `description` | Browse: a line under the entry (`nav.desc.<id>` translates). |
| `image`, `focus` | Browse: a picture in place of the icon (`top`/`center`/`bottom` crop). |
| `adminOnly` | Hidden from non-admins (a whole branch on a group). |
| `hideFromAdmin` | Hidden from admins: pages about being a participant. Not with `adminOnly`. |
| `roles` | Who sees it: some of `admin`, `editor`, `viewer`. |
| `requiresGrant` | Needs a real grant on its tables (own rows and public tables don't count). |
| `bottomNav` | Phone bottom bar, in order; over 5 → 4 plus **More**. Default: the first 5. |
| `fab` | The corner button app-wide: `add` (default), `scan` or `none`. A view's `fab` wins. |
| `scan` | Where the scan button sends codes: scan views and rsvp views with `checkin`. |

- Hiding an entry is tidiness, not access control: grants decide what a user may read or write.
- Settings → Appearance lets an admin override each entry's icon, image and background, stored in the
  app config.
- The scan button opens the camera where the browser can decode in the page (else a text field) and
  saves at once. A typed changing code starts with a one-character tag naming its entry in `scan`.

## theme (brand palette)

```json
"theme": { "light": { "primary": "#00695c", "secondary": "#26a69a" }, "dark": { "primary": "#4db6ac" } }
```

- Overrides Vuetify's palettes key by key. Edited live in Settings → Theme (admins), which also accepts a
  pasted palette.
- Roles: `primary` (buttons, links, active states), `secondary` (chips), `surface`, `background`,
  `on-surface` (text), `error`, `success`. Colours are `#rrggbb` or `#rgb`.
- Only colours are themable at runtime; type scale, spacing and shapes need a build.

## Removed shapes (hand-migrate)

These no longer load; edit the schema by hand:

- **`{ "text": "<key>" }` in `columns`**: use a `markdown` view with `{{t:key}}` between `{{view:…}}` embeds.
- **A top-level `pages` map** and `{ "page": "x" }` nav entries: author each page as a `markdown` view.
- **Table `header` / `footer`**: a `markdown` view around `{{table:<name>}}`.

Nested `views` are still flattened at load.

## Lists and translations

- List values are stored as stable keys (`in_progress`) and shown through `list.<list>.<value>`.
- Values a schema filter names are seeded and cannot be deleted; on a `ref` column the lookup row is locked.
- Translation keys are collected into the Languages tab: `tab.*`, `view.*`, `field.*`, `list.*.*`,
  `nav.<group>`, `nav.desc.<id>` and `{{t:<key>}}` tokens.
