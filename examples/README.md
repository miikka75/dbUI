# Example schemas

Importable schema bundles that show what a real dbUI database looks like. Each is **schema only** —
tables, columns, views, nav, list *names* and UI translations. There are **no rows and no list values**:
the structure lives here in git, the data lives in your backend (Firebase, Supabase, SQLite, …).

## Using one

Settings → **Import JSON** → pick the file. The app writes the schema to whichever backend you're
connected to and reloads. Then add your own data: Settings → User Access to register yourself, the
Lists tab to fill in the list values the schema declares, and the table tabs to add rows.

Re-importing later updates the schema in place. Rows are matched by `id`, so importing a schema-only
bundle never touches data you've already entered.

## Naming convention

Identifiers are **domain-prefixed** so that alphabetical order is also logical order — tables, views and
their translation keys group by area instead of scattering:

| prefix | meaning | examples |
|--------|---------|----------|
| `meeting_` | the sacrament meeting itself | `meeting_agenda`, `meeting_music`, `meeting_program`, `meeting_speakers` |
| `duty_` | recurring assignment rosters | `duty_cleaning_a`, `duty_interpreters`, `duty_ushers`, `duty_usher_dates` |
| `admin_` | bishopric administration | `admin_callings`, `admin_interviews`, `admin_reminders`, `admin_responsibilities` |
| `doc_` | markdown doc-views | `doc_about`, `doc_sacrament`, `doc_welcome` |
| `ref_` | lookup tables | `ref_statuses` |

A view may share its table's name (`meeting_music` is both) — views and tables are separate namespaces,
and their translation keys (`view.*` vs `tab.*`) keep them distinct.

Column names are **global**: `field.date` is one translation key shared by every table with a `date`
column. Rename a column in one table and you rename its label everywhere.

Free-text blocks pulled into doc-views with `{{t:key}}` are grouped under `text.*`.

## bishopric-schema.json

A congregation's sacrament-meeting and administration tool. Worth a look because it exercises most of
what dbUI can do in one schema:

- **join / union views** over several source tables (`meeting_program` merges agenda, music and interpreters)
- **doc-views** with `{{view:…}}` embeds and `{{t:…}}` text blocks, one of them access-restricted
- a **board** view (`admin_callings_board`) laned by a lookup-table status
- a **rotation** view (`duty_cleaning`) with two slots and two rosters
- **computed columns** — occurrence-driven rotation (`duty_usher_shifts`) and list matching (visitors)
- **grouped/collected** views (`meeting_speakers`, `admin_bishopric`) with per-group sub-views
- **conditional filters**, `listSwitch` columns, `ref` columns into a lookup table, and user-linked lists

The list *names* are declared (`hymns`, `members`, `bishopric`, …) but empty — fill them in the Lists
tab. The doc-view text is placeholder prose, not any real congregation's wording.
