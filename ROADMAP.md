# Roadmap

Features that have been proposed but not built, and the reasoning behind each. A proposal lives here
until it either ships (move it to **Shipped**, with the PR) or is rejected (move it to **Declined**,
with the reason — a rejected idea that leaves no trace gets re-proposed every six months).

This is not a commitment or a schedule. It is a record, so that "could we…?" is answered from
something written down rather than from memory.

## The seam a new view kind goes through

Every view kind since `pivot` has cost the same five things, which is why the estimates below are
mostly "small". A proposal that does *not* fit this shape is the expensive one, and says so.

1. **A pure engine module** — `pivot.js` (90 lines), `board.js` (53), `form.js` (123). Framework-
   agnostic, Node-tested, no DOM. This is where the logic goes.
2. **A registered component** + a `VIEW_KINDS` entry (`app-core.js`), which is the whole top-level
   dispatch.
3. **An `isXView` classifier** (`SchemaNormalize.viewKind`) and the `_flattenViews` gate.
4. **`schema.schema.json` + `validateSchema`** — the config shape, and the errors for getting it wrong.
5. **`dev/test/<kind>.test.js`.**

Embedding is free: `embed-view` dispatches on the same classifier, so a new kind renders inside a
`{{view:x}}` in any document the day it exists, with access gating, `?` hide-when-empty, the
`blockRefs` preload, and the print path all inherited.

## Proposed

### `stats` — KPI tiles and progress bars *(top pick)*

A row of big-number tiles — count / sum / latest, optionally against a goal, rendered as a bar.

The reason this is the top pick is that **the data half already exists**. `chore_points_month` in
[examples/chores-schema.json](examples/chores-schema.json) already does group → lookup → sum → period
filter and renders inside `doc_scoreboard` via `{{view:chore_points_week}}`. It produces a *table*.
`stats` is a second renderer over that identical pipeline output — no new data plumbing, no new
markdown syntax:

```json
"signins_today": {
  "sources": ["signins"],
  "filter": { "date": { "within": "@today" } },
  "stats": { "tiles": [
    { "label": "Signed in today", "agg": "count", "goal": 120, "display": "bar" }
  ]}
}
```

Render with `v-progress-linear` (Vuetify is already loaded) or inline SVG. Both stay inside the
no-build and CSP constraints; a charting library does not — see *Declined*.

Watch for: a total that omits archived rows is silently wrong, so tiles need the same
`includeArchive` discipline the aggregate views already document.

### RSVP attendance verification *(schema pattern, not code)*

"Did the people who signed up actually turn up?" — a verifier marks attendance, and only verified
rows count toward any report.

Listed here because it is **worth documenting, not building**. The mechanism already exists and is
proven by `chore_log`: a status column with a real default, `ownerWritable` excluding that column so
the submitter cannot self-approve, `ownerWritableWhile` locking the row once verified, a `board` view
as the verifier's UI, and reports filtered on the verified value. It is enforced server-side —
`ownerStateOk` in [firestore.rules](firestore.rules) reads the *stored* row, so an owner cannot send a
compliant status alongside their edit.

Applying it to `rsvps` is config: add an `attendance` column, declare
`ownerWritable: ["practice","response","note"]`, and gate on `ownerWritableWhile: { "attendance": "pending" }`.

Two traps worth writing into SCHEMA.md when this is done:

- **A table with no `ownerWritable` is unbounded.** Omitting the list does not create a weak gate; it
  creates no gate, and the owner may write every column including the one meant for the verifier.
- **The gate column needs a non-empty default.** Reading a missing property is an evaluation *error*
  in the rules language, not `undefined` — the same trap already annotated around `whileCol`. Use
  `"pending"`, never `""`.

Known limitation: `ownerWritableWhile` gates on a column value, not a date. "Editable until the event
happens" is not expressible; "editable until someone marks attendance" is.

### QR check-in — scan a code to mark attendance

The companion to *RSVP attendance verification* above: instead of the verifier hunting for each name
in a list, they scan a code and the attendance column is written.

**Invert the gym-door model.** A gym scans your phone because the turnstile has no identity of its
own — the code has to *be* the credential, which is why those systems need rotating, server-minted
codes. Here the situation is reversed: the verifier is a signed-in user who already holds a write
grant. So the right shape is **the verifier scans the attendee**, and the QR carries nothing secret —
just a person identifier. It is a fast row-picker, not an auth token.

That distinction is what makes this cheap. The write is performed by an authenticated editor under
the existing rules; a copied or photographed code buys nothing, because using it still requires a
verifier who is standing there looking at the person. **No new access primitive, no server, no CSP
change** — it works on the free Spark plan and on a GitHub Pages deployment.

The opposite arrangement — a code posted at the door that attendees scan with their own phones — is
the one to avoid. It requires making the attendance column owner-writable, which throws away the
verification property the whole feature exists to provide, and a poster code can be photographed and
sent to someone sitting at home. Making *that* honest needs time-boxed rotating codes, hence a server
to mint and validate them, hence the same Blaze/Edge-Function dependency the calendar feed carries.

Decomposition follows the usual seam: a pure `checkin.js` over
`(scanned payload, rows, config) -> which row to update and to what`, Node-tested, with the camera as
the impure shell around it. Config names the target rather than hardcoding it, e.g.
`{ "source": "rsvps", "match": "owner", "set": { "attendance": "attended" } }`.

Costs, in order of how much they will actually hurt:

1. **Decoding on iOS.** `BarcodeDetector` is native and free where it exists, but at the time of
   writing that is Chrome/Edge/Android only — **not Safari, not Firefox** (worth re-checking, it
   moves). Since this is a PWA people install on phones, that gap is not ignorable, so the plan is
   feature-detect `BarcodeDetector` and fall back to a vendored decoder. Vendoring is a well-trodden
   path here but has real ceremony: `vendor/versions`, a curl line in `update-vendor.sh`, an SRI pin,
   the CI hook, and the `deploy-config.test.js` drift guard.
2. **Camera lifecycle.** `getUserMedia({ video: { facingMode: 'environment' } })` into a `<video>`,
   frames to a canvas, decode on a rAF loop. The part that goes wrong is teardown — stop the tracks on
   unmount or the camera light stays on after the user navigates away.
3. **Issuing the codes.** Everyone needs one. Either render it client-side on a "My code" panel beside
   the existing profile picture and name in Settings (an encoder is smaller than a decoder), or print
   cards. This is a design question more than a technical one.

Non-issues, checked: camera access is **not** governed by CSP — a `MediaStream` assigned via
`srcObject` never goes through `media-src` — and no `Permissions-Policy` header is set that would need
amending. `getUserMedia` needs a secure context, which Firebase Hosting, GitHub Pages and loopback dev
all satisfy.

Sequencing: this is only worth building after the attendance column it writes into exists, since
without that there is nothing for a scan to do.

### Calendar export (`.ics`) and subscribable feeds

Two features that sound like one. They differ by roughly an order of magnitude in cost, and the
cheap half delivers most of the value.

**A. Export a `.ics` file — small, no blockers.** Client-side only: serialize the events the calendar
already computes into `VEVENT` records and hand the browser a download. No server, no endpoint, no new
auth surface; works on every backend including a GitHub Pages deployment, where there is nothing but
static files. The JSON export already establishes the download plumbing. Its limitation is inherent:
it is a **snapshot**. Add an event and everyone re-exports.

**B. A subscribable feed (`webcal://…/feed.ics`) — the expensive half.** Generating iCalendar text is
not the hard part. Three other things are:

1. **The URL *is* the credential.** Calendar clients do not perform OAuth, send headers, or hold
   cookies — Google Calendar, Apple Calendar and Outlook fetch a plain anonymous URL. So access has to
   be a long random per-user token in the query string, and that token is a bearer credential that
   gets emailed around, synced to phones, and stored on Google's servers indefinitely. The app has
   deliberately never had one of these for row data: `?mode=…&config=…` share links carry *connection
   config*, and the reader still signs in. The only existing token-in-URL is the admin-only CSP read
   endpoint. This needs a decision, not just code: per-user tokens, revocable, ideally scoped to one
   calendar view.
2. **A feed endpoint bypasses Firestore rules.** It runs with the Admin SDK, so every access rule the
   feed relies on — `canReachTable`, `@me` resolution, owner-scoped rows, per-view filters — has to be
   re-implemented server-side and kept in agreement with the rules. That is the same
   "this comparison exists in three languages" hazard already annotated around `ownerWritable`, and it
   fails silently in the dangerous direction: an over-permissive feed leaks, and nothing reports it.
3. **The event model is not extractable yet.** `calEventsFor` lives on the Vue root, not in a pure
   module, and reaches into `dataCache`, `canReachTable`, `resolveMeTokens`, `t()`, `displayValue`
   and `hashColor`. A server cannot reuse it. The prerequisite is the same extraction `pivot.js` /
   `board.js` went through — an `events.js` pure over `(views, rows, access)` — which is worth doing
   on its own merits and would serve export, print, and the feed alike.

Deployment mirrors the CSP collector exactly, and for the same reasons: a Blaze-plan Cloud Function
behind a Hosting rewrite, a Supabase Edge Function on the free tier, or self-hosted. On Firebase's
free Spark plan there is no server at all, so on that deployment only the export half is possible.

Expectation to set before building B: subscribed feeds are **not** live. Google Calendar refreshes
external `.ics` subscriptions on its own schedule — typically many hours, sometimes longer — and the
interval is not client-controllable. People who expect an edit to appear on their phone in seconds
will be disappointed by a feed, and better served by the export.

Suggested split: build **A** on its own, and treat **B** as blocked on the `events.js` extraction plus
an explicit decision about per-user feed tokens.

### `timeline` / `gantt`

Rows with a start *and* end date, drawn as bars across periods. This fills the calendar's documented
gap — it places single-day events only, so anything spanning days has nowhere to go today.

### `tree`

Hierarchies via a self-referencing parent column. Would generalize the ref-hierarchy the Lookup screen
already renders. Needs the `parent` column type below.

### `gallery`

A media grid. Unblocked since `image`/`url` columns shipped, so this is now mostly layout.

### `feed`

Reverse-chronological activity stream. Pairs naturally with a changeset/audit trail if one is ever
added.

### `split`

Master-detail two-pane layout — a list on the left, the selected record on the right.

### New column types

Several proposed views are really "a layout plus a column type":

- **`parent`** — self-referencing, required by `tree`.
- **`geo`** — lat/lng, required by `map`.
- **`richtext`** — speculative; the markdown renderer seam in `embeds.js` may cover it more cheaply.

### `map`

Geographic view. Ranked last deliberately: it would be the first view to depend on an **external tile
provider**, which means a new CSP origin, a third-party dependency at render time, and a feature that
stops working offline. Everything above it stays inside the app boundary.

## Shipped

Recorded so the roadmap shows what graduated rather than silently shrinking.

- **`board`** (kanban) — was the top pick; `board.js` + `chore_board`.
- **`form`** (single-record intake) — `form.js`.
- **`image` / `url` column types** — with an `asset:<id>` tier so a deployment with no storage bucket
  can still hold an uploaded image.
- **Runtime search** — the per-view `search` box (`"search": true`, or an array of columns). This was
  proposed as a cross-cutting enabler for "every list/board/gallery wants it", and it landed.

## Declined

- **Bundling a charting library.** Incompatible with the no-build constraint (static files, CDN Vue,
  no bundler) and with the CSP. Inline SVG plus the existing `hashColor` is the supported answer, and
  is what `stats` should use.

## Suggested order

`stats` first — it is the smallest (the aggregate pipeline it renders already exists and ships), and
it is the one that makes documents useful for reporting rather than only for listing. Then `.ics`
export, which is similarly small and self-contained. Then `timeline`, which closes a gap the calendar
documents about itself. Then `tree` and `gallery`, both
gated mainly on a column type.

The RSVP attendance pattern is not in that order because it is not code — it can be authored into a
schema today.
