# Example schemas

Importable bundles that show what a real dbUI database looks like. Structure lives here in git; your
rows live in whichever backend you connect (Firebase, Supabase, SQLite, …).

Each concern is a separate file, so they can be mixed: the app's own UI text is reusable with **any**
schema, and a schema's labels carry no UI prose.

| file | what it is |
|------|------------|
| `bishopric-schema.json` | structure: tables, columns, views, nav, list *names* — plus the `ref_statuses` lookup rows the schema depends on |
| `bishopric-lang-en.json` / `-fi.json` | labels for **this schema**: `tab.*`, `field.*`, `view.*`, `list.*`, `text.*` |
| `chores-schema.json` | a household chore tracker — points, approvals, rewards, a weekly rota and a shopping list |
| `chores-lang-en.json` | labels for the chores schema |
| `chores-data.json` | optional **sample rows** for the chores schema — a household of four, a chore catalogue, a fortnight of logged chores, rewards and a shopping list |
| `demo-schema.json` | the **demo** — the widest of the three, and the one the test suite runs against: rotations, RSVPs, a board, embeds, doc-views, archive partitions, mirrored tables |
| `demo-lang-en.json` / `-es.json` / `-sv.json` | labels for the demo schema, in three languages |
| `demo-data.json` | sample rows, lists and rotation config for the demo. The dates are literal, so the leaderboard's *this week* and the RSVP demo's *upcoming* age out of the current period — edit them here when it matters |
| `app-lang-en.json` / `-fi.json` | the **app's own UI**: buttons, messages, settings, calendar. Schema-independent — the browser-tab title lives in the *schema* bundle (`app.title`), since it names the deployment |

## Installing one from the app

**Settings → Examples**, or the offer an empty database makes on its first screen. The picker reads
`index.json` — a generated index of everything here — and installs the files you choose in one run:
the schema, a language pack per language you tick, the matching app-UI pack, and optionally the sample
rows.

`index.json` carries a hash per file, and an install records which files it took and what each unit of
them (every column, view, list and translation string) looked like at the time. So when the deployment
is redeployed with newer examples, **Settings** says which of the files you installed have moved, and
offers to reinstall.

> Reinstalling **replaces** the schema and merges the labels — a schema edit you made in the app is
> lost. Export first. (The recorded fingerprints exist so this can become a merge rather than a
> replace; that part is not built yet.)
>
> Your **lists survive**: a bundle ships its vocabularies empty, so installing one fills the lists this
> database has not started and leaves every list that has values in it alone — including the ones the
> bundle never mentions (`Examples.listsForInstall`). Rows, translations and doc-view bodies are
> layered on as before. A hand-picked **Import JSON** is the other case and still replaces the whole
> set, pruning any list the file omits: that is a restore, and it is how a list is retired.

Regenerate the index after changing anything here:

```bash
node scripts/examples-manifest.js
```

A test fails if you forget — and another fails if a file in this folder is not named so the generator
can place it (`<id>-schema.json`, `<id>-lang-<code>.json`, `<id>-data.json`, `app-lang-<code>.json`).

## Import order, by hand

Settings → **Import JSON**, one file at a time — the long way round, and what the picker automates:

1. **`bishopric-schema.json`** — the structure. The UI will show raw keys (`view.meeting_program`) until
   a language is loaded; that's expected.
2. **`bishopric-lang-<lang>.json`** — schema labels.
3. **`app-lang-<lang>.json`** — app UI text.

Translations **merge** into the language, so steps 2 and 3 combine rather than overwrite, in either
order. Add a second language any time by importing the other pair.

`chores-data.json` is a fourth, optional step for the chores schema: import it last for a database
that already has something in it. It is the same bundle shape Export produces, so it layers onto the
schema without touching it. `demo-data.json` plays the same part for the demo.

> The demo files lived in `dev/` until the app itself needed to be able to fetch them. `dev/` is pruned
> from both publish paths (`hosting.ignore` in `firebase.json`, and the prune step in
> `.github/workflows/deploy-pages.yml`), so nothing kept there is reachable from a browser — while
> everything here is served by the deployment itself. The dev server still seeds from these files;
> `cd dev && npm run seed:import` reads them from here (`-- chores` for the household bundle).

**What a bundle may not contain: users.** Accounts, grants, profiles and user-linked-list links are
per-deployment security data, not portable content. The importer has no branch for them, so adding them
to a `*-data.json` would be inert — and if it read them, importing an example would become a way to hand
somebody a grant. `dev/seed-import.js` seeds them through the local dev server's admin API instead,
which is the one context where that trade is safe. Its `SEED` table is where a bundle's demo family
lives.

## Icons

Each bundle brands its own tab and installed app through `schema.icons`, so one deployment serving
several of them gives each its own identity rather than showing the app default everywhere.

| bundle | favicon / install icon | drawn from |
|--------|------------------------|------------|
| bishopric | `bishopric-favicon.svg`, `bishopric-icon-512.png` | its beehive, which used to sit at the repo root and therefore branded *every* database |
| chores | `chores-favicon.svg`, `chores-icon-512.png` | MDI `home-plus` with its plus replaced by the tick from `file-check-outline` — a household, and a job done. The filled house carries a circular cutout for the badge, which is what keeps the tick legible against a transparent background |

The MDI paths are the real outlines taken from `@mdi/svg` at **7.4.47**, the version `vendor/mdi.css`
pins, because MDI is vendored here as a webfont and a font carries no path data. The tick is fitted to
the box the plus occupied — measured with `getBBox()`, not judged by eye.

Regenerate a PNG from any of these SVGs with the Chromium the E2E suite already ships:

```bash
node dev/make-icon-png.mjs examples/chores-favicon.svg examples/chores-icon-512.png 512
```

## Trying the search box

Search is opt-in per view, so most views deliberately do not offer one. The views that do, in these
bundles:

| bundle | view | setting | what to try |
|--------|------|---------|-------------|
| chores | `chore_mine` | `"search": true` | any word from a chore, note or status |
| chores | `chore_board` | `"search": true` | the same, on a **board** rather than a grid |
| chores | `shop_todo` | `"search": ["item"]` | `leipa` finds *Leipä*; a shopper's name finds nothing, because only `item` is searched |

Terms fold diacritics both ways (`saestaja` finds *Säestäjä*, and vice versa) and every word has to
match somewhere in the row, not all in one column — so `kati tup` finds *Kati Tuppurainen*. The count
beside the box reads `shown / total`. Import `chores-data.json` first if you want rows
to search without typing them yourself.

Then start entering data: Settings → User Access to register yourself, the Lists tab to fill in the
list values the schema declares, and the table tabs for rows.

> **Approving a request grants nothing on its own.** Settings → Users → Approve registers the person as
> an `editor` with an empty table list — the grants are the admin's next, separate decision, made with
> the chips. So an approved user still sees no data until you tick something (or set them to `admin`).
> Approving someone who was *already* registered overwrites whatever they had.
>
> On the **local dev server** the identity is the `?user=` query parameter, defaulting to `local@dev`.
> Once any user exists the registry is enforced, so register `local@dev` too (or always browse with
> `?user=<a registered address>`) — otherwise a plain `localhost:3000` visit is an unknown account and
> fails closed with "not registered for this database", showing no data.

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
  lanes by it, so without rows there'd be no lanes and nothing to pick. Its stored values are
  **`lowercase_underscore` codes** (`under_discussion`, `set_apart`, `release_recorded`), never display
  text — the label comes from `list.ref_statuses.<code>` in the language files. That keeps the stored
  value stable when the wording changes, and lets the same row read correctly in every language.
  Because the table is listed in `translatableLists`, this applies to **both** its columns: the app
  exposes the distinct values of every non-system column, so the `phase` codes are translatable too.
- **`ref_callings`** ships the whole catalogue — 99 rows, a ward's organizations crossed with the
  callings each one has. It used to carry only the three Aaronic Priesthood offices, which left the
  `admin_callings` board with an organization dropdown of one and a calling dropdown that emptied as
  soon as you picked anything else. Same discipline as `ref_statuses`, and for the same reason: both
  columns store codes (`relief_society`, `first_counselor`), and both are translatable, so the same
  row reads *Apuyhdistys / 1. neuvonantaja* in Finnish and *Relief Society / First Counselor* in
  English. A ward adds its own rows where the catalogue is thin; nothing here has to be deleted first.

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

## What chores-schema.json exercises

A household chore tracker, built to sit next to the commercial apps in the category (OurHome, OurFlat,
Sweepy, Homey). It leans on a different part of dbUI than the bishopric schema:

- an **`owner` column** on `chore_log` / `reward_claim`, so a family member logs their own rows with
  **no table grant** (self-service; the Firestore rules are the enforcement)
- **aggregate leaderboards** with `period` navigation — `chore_points_week` / `chore_points_month`
  sum each chore's catalogue `points` through a `lookup` computed column
- **two boards**: the parent's approve/reject pass over `chore_log` (whose cards carry the
  auto-stamped `owner`, so *who logged it* is checked where it is approved), and the shopping list as
  needed → in the trolley → bought, so nothing is hidden behind a filter and there is no second
  "raw table" nav entry for the same data
- a **pivot** heatmap (person × chore) and a **multi-source calendar** that also overlays the rota
- a **rotation** view for whose-week-it-is, over a `reorderable` roster table
- **`archiveAfter`** on `chore_log` and `home_shopping`: an approved/rejected chore files itself
  after a week, a bought shopping item after three days, so neither list becomes a wall
- **a growing item list**: `item` is a `select` with `allowNew`, so the weekly shop is picked from
  what the household buys rather than retyped, and anything new joins the list as it is typed
- **`default`** on each status column, so a new row starts in the first state of its flow instead of
  outside every lane
- **pages that compose views**: Home is instructions plus the reward price list, Scoreboard is one
  page stacking week, month, balance and the heatmap — so the nav stays eight entries deep
- **`includeArchive`** on every total, because `archiveAfter` would otherwise drain them as rows age out
- **`calendar.addTo`**, so clicking a day on the two-source calendar logs a chore on that date
- **`defaultFrom: "@me"`** on `person`, so a logged chore is attributed to whoever logged it
- **`daysSince` + an ordered comparison** on the shopping list — `days_late` appears only once an item
  is past its `needed_by` date
- a **signed cross-source aggregate** (`chore_balance`): points earned minus points spent, as one
  figure, by scoping one compute def per source table and negating the second

`ref_chores` and `ref_rewards` ship empty in the schema — the chores a household cares about, and what a point is
worth, are theirs to enter.

`members` is a **`userlink`** list: the household keeps calling people what it calls them ("Ann", not
whatever she typed into her profile), and an admin links each value to an account in the Lookup tab.
That link is what makes *My chores* and the `person` auto-fill follow the signed-in user, so it is
worth doing straight after registering everyone — until a value is linked, `@me` matches nothing for
that person. Switch `listSources` to `"users"` instead if you would rather the list populate itself
from shared profile names and skip the linking step.

**Sample data.** `chores-data.json` fills the catalogue (11 chores priced 1–5 points across five
rooms), four rewards, a three-slot rota, fourteen logged chores, three reward claims and a shopping
list — enough for every view to show something real: the leaderboards rank, the balance nets earned
against spent, the heatmap has a grid and the shopping list has one genuinely overdue item.

Two things it deliberately does **not** contain:

- **User accounts.** Roles and table grants are per-deployment security data, not portable content —
  the importer has no branch for them by design. The bundle seeds the `members` *list* and stamps a
  plausible `owner` email on each row so the data reads like a household; register the real people in
  Settings → User Access.
- **Fresh dates.** `done_on` / `claimed_on` are written relative to the day the bundle was generated,
  and `chore_points_week` / `chore_points_month` filter on the *current* period — so an old bundle
  ranks empty. Either bump the dates or use the ‹ › period arrows to step back to when they land.

**Approval is a parent's job, and enforced as one.** `chore_log` names
`ownerWritable: ["person", "chore", "done_on", "note"]`, so a member may log what they did and edit it
afterwards, but `status` is not theirs — they cannot approve themselves, nor create a row that is
already approved. An editor with a `chore_log` grant, or an admin, still approves normally.

**Suggested access setup.** Parents `admin`. Everyone else `editor`, with *Can view* on `ref_chores`
and `ref_rewards` (see what a chore is worth, can't rewrite it), *Tables* on `home_shopping`, and **no**
grant on `chore_log` / `reward_claim` — those carry an `owner` column, so self-service lets each person
log their own and nobody else's, while `rosterPublic` keeps the leaderboard shared.

**Still not expressible**: recurring/scheduled chores and Tody-style aging ("this chore hasn't been
done in three weeks") — `daysSince` ages a row's own date, and there is no max-per-group that feeds
back into a lookup. Reminders and push notifications have no foundation in the app at all.
