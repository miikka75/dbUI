# Example schemas

Importable bundles that show what a real dbUI database looks like. Structure lives here in git; your
rows live in whichever backend you connect (Firebase, Supabase, SQLite, …).

Each concern is a separate file, so they can be mixed: the app's own UI text is reusable with **any**
schema, and a schema's labels carry no UI prose.

| file | what it is |
|------|------------|
| `bishopric-schema.json` | structure: tables, columns, views, nav, list *names* — plus the `ref_statuses` lookup rows the schema depends on |
| `bishopric-lang-en.json` / `-fi.json` | labels for **this schema**: `tab.*`, `field.*`, `view.*`, `list.*`, `text.*` |
| `app-lang-en.json` / `-fi.json` | the **app's own UI**: buttons, messages, settings, calendar. Schema-independent |

## Import order

Settings → **Import JSON**, one file at a time:

1. **`bishopric-schema.json`** — the structure. The UI will show raw keys (`view.meeting_program`) until
   a language is loaded; that's expected.
2. **`bishopric-lang-<lang>.json`** — schema labels.
3. **`app-lang-<lang>.json`** — app UI text.

Translations **merge** into the language, so steps 2 and 3 combine rather than overwrite, in either
order. Add a second language any time by importing the other pair.

Then start entering data: Settings → User Access to register yourself, the Lists tab to fill in the
list values the schema declares, and the table tabs for rows.

Re-importing later updates in place — rows are matched by `id`, so a schema-only re-import never
disturbs data you've already entered.

## What about list values used in filters?

Some views filter on specific values — `admin_bishopric` matches `{"responsible": "bishop"}`,
`"counselor1"`, `"counselor2"` and groups by them; `meeting_program` filters on `{"status": "released"}`
and `"accepted"`. **A value the schema names is part of the schema**, so those ship here:

- **`bishopric`** carries its three role slots (`bishop`, `counselor1`, `counselor2`) with labels
  (*Bishop*, *First Counselor*, *Second Counselor*). It's a user-linked list, so a deployment attaches
  its own people to the slots — the slots belong to the schema, the people don't.
- **`ref_statuses`** ships its 14 rows: `status` is a `ref` column into that lookup table and the board
  lanes by it, so without rows there'd be no lanes and nothing to pick.

Every other list is empty — those are yours to fill (`members`, `hymns`, `visitors`, …).

Two things worth knowing about how the app behaves here:

- On import it **auto-seeds** filter-referenced values it finds (`lockedListValues`), so the
  `bishopric` values would reappear even if this file omitted them. They ship anyway, so the file is
  self-describing and the values can carry proper labels.
- Auto-seeding creates **list entries only, never table rows** — which is exactly why `ref_statuses`
  has to ship its rows explicitly.

The rule of thumb: **a lookup table and the values a filter names are structure; a roster is yours.**

## Naming convention

Identifiers are **domain-prefixed** so alphabetical order is also logical order:

| prefix | meaning | examples |
|--------|---------|----------|
| `meeting_` | the sacrament meeting | `meeting_agenda`, `meeting_music`, `meeting_program`, `meeting_speakers` |
| `duty_` | recurring assignment rosters | `duty_cleaning_a`, `duty_interpreters`, `duty_ushers`, `duty_usher_dates` |
| `admin_` | bishopric administration | `admin_callings`, `admin_interviews`, `admin_reminders`, `admin_responsibilities` |
| `doc_` | markdown doc-views | `doc_about`, `doc_sacrament`, `doc_welcome` |
| `ref_` | lookup tables | `ref_statuses` |

A view may share its table's name (`meeting_music` is both) — views and tables are separate namespaces,
and their keys (`view.*` vs `tab.*`) keep them distinct.

Column names are **global**: `field.date` is one key shared by every table with a `date` column.

Free-text blocks pulled into doc-views with `{{t:key}}` are grouped under `text.*`.

## What bishopric-schema.json exercises

A congregation's sacrament-meeting and administration tool — useful because it covers most of dbUI in
one schema:

- **join / union views** over several source tables (`meeting_program` merges agenda, music, interpreters)
- **doc-views** with `{{view:…}}` embeds and `{{t:…}}` text blocks, one access-restricted
- a **board** laned by a lookup-table status, grouped into phases
- a **rotation** view (`duty_cleaning`) with two slots and two rosters
- **computed columns** — occurrence-driven rotation (`duty_usher_shifts`) and list matching (visitors)
- **grouped/collected** views (`meeting_speakers`, `admin_bishopric`) with per-group sub-views
- **conditional filters**, `listSwitch` columns, `ref` columns, and user-linked lists

The doc-view text is placeholder prose, and the people-lists are empty — no real congregation's roster
or wording is in here.
