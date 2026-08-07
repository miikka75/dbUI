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

Some views filter on specific values (`{"status": "released"}`, `{"responsible": "bishop"}`). Those
values are **not** shipped as list contents — the lists here are empty — but you don't have to recreate
them by hand either: on import the app scans every filter and **auto-seeds** the values it finds
(`lockedListValues`). After importing the schema you'll find `bishopric` already populated with
`bishop`, `counselor1`, `counselor2`.

The one thing auto-seeding cannot recreate is a **lookup table's rows**. `status` is a `ref` column into
the `ref_statuses` table, and the board view lanes by it — with no rows there would be no lanes and
nothing to pick in the status dropdown. So `ref_statuses` rows ship *with the schema*: they're a
controlled vocabulary (a callings workflow of 14 statuses in 5 phases), not anyone's data.

That's the rule of thumb for this split: **a lookup table is structure, a data table is yours.**

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
