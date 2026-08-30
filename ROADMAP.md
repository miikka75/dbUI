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

#### The other arrangement: attendees check themselves in with a shared code

A code shown at the event — on a slide, a poster, a QR — that attendees scan or type on their own
phones. This was first written off here as needing a server. **That was wrong**, and the correction
matters because this is the arrangement that scales: no queue at the door, and the organizer does not
have to touch every phone.

Two things make it work without one.

**Separate the claim from the verdict.** The mistake is thinking self-service means making
`attendance` owner-writable, which does throw the verification property away. It does not have to. Add
a SECOND column — `checkin_code` — and put only that one in `ownerWritable`. The attendee writes what
they typed; `attendance` stays editor-only. An organizer's screen then compares the claims against the
real code and stamps the verdict for every matching row at once. That is one button for the whole
room, it needs **no rules change at all**, and it is the version to build first.

**A rule can check a secret the client cannot read.** For the stricter version, where the attendee's
own write sets `attendance` directly, the enforcement point already exists: rules `get()` runs with
full read access, not the caller's. `selfServiceTable()` and `ownerBounds()` already read
`_meta/ownerWritable` on behalf of members who are denied that document — and `base()` denies clients
every underscore-prefixed collection outright. So a `_checkin/<eventId>` document can hold the live
code, be completely invisible to the app, and still be the thing the rule compares against. Rules also
have `request.time`, so a `validUntil` on that document expires a code without any clock on the
client.

What rules *cannot* do is derive a code — no HMAC, no loops. The obvious workaround is a device at the
entrance writing a fresh code every few minutes, and it does work, but **a browser tab is a poor
clock**: hidden tabs are timer-throttled to about once a minute and harder after five minutes,
a locked screen or a sleeping device stops it dead, and a backgrounded mobile PWA can be suspended
outright. `sw.js` cannot rescue it either — it is a pass-through stub, and `periodicSync` is
Chrome-only, install-gated, and has a minimum interval measured in hours. `navigator.wakeLock` holds
the screen on but still requires the page to be visible. The failure mode is the bad one: check-ins
start being rejected the moment the tablet drops off, silently, while nobody is watching it.

**So do not heartbeat — pre-write the schedule.** Rules have no loops, but they do have arithmetic on
`request.time.toMillis()` and map indexing by a computed key. So one write when the event starts can
store every window's code at once:

```
_checkin/<eventId> = { codes: { "<windowIndex>": "<code>", … }, from, until }
```

and the rule derives the current `windowIndex` itself and looks the code up. Nothing has to stay
awake, nothing expires because a device slept, and the entrance screen becomes a pure DISPLAY — it
reads the map and shows whichever code is current. If it dies, people can still be checked in; only
the display is gone.

Two things this needs, both precedented: a `match /_checkin/{event}` block (the catch-all `base()`
denies clients every underscore collection, so it needs its own block, exactly as `_meta` has one)
granting read+write to editors and nothing to members; and the same logic mirrored into RLS for
Supabase. **Verify the rules arithmetic in `npm run test:rules` before building on it** — integer
division and computed-key map access are the two details worth proving in the emulator rather than
assuming.

Stateless TOTP-style rotation, where nothing is stored at all, remains the one variant that genuinely
needs a function.

Worth being clear about what each step buys, because the ladder has a flat top:

| Step | Stops | Cost |
|---|---|---|
| Per-event code, editor stamps the verdict | Marking yourself present from home without at least asking someone | One column + one screen. No rules change |
| Same, but the rule checks the code | The editor's button-press | New `_meta` mirror + a rule branch, mirrored into RLS, the dev server and `backend-helpers` — four layers, the real cost |
| Code expires (`validUntil`) | Checking in tomorrow for yesterday | One timestamp comparison in the same rule |
| Code rotates during the event | Narrows relaying, does not close it | An organizer device writing a heartbeat |

**No step closes relaying.** Someone at the event can always text the code to someone who is not. A
30-second window narrows it; it does not shut it. Every "type the code on the screen" system has this,
and it is worth deciding up front that it is acceptable rather than buying rotation expecting it to be
the fix. What the code genuinely buys is that presence takes *effort and a confederate* instead of
being free — which for a household, a congregation or a club is the whole requirement.

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

Sequencing: either arrangement is only worth building after the attendance column it writes into
exists, since without that there is nothing for a scan to do. Of the two, the shared-code one is the
better first build — it needs no camera at all in its typed form, so it can ship and be used at a real
event before any of the decoding work above is done.

### Per-row goals — a target that lives in the data, not in the view

`stats` measures every tile against **one goal per view**. The `perRow` branch reads `pr.goal` once and
hands the same value to every row (`stats.js:127`), so a leaderboard can ask "how close
is each person to 30 points" but not "how close is each *chore* to the cadence *that chore* keeps".

The second question is the one a chores database actually has. Bedding once a month, bins once a week,
windows twice a year — different targets, one view.

**What already works, and is worth knowing before building anything.** A ladder goal resolves per
*tile*, against that tile's own value, and the renderer prints the reached rung as a chip. So
"five meals this week earns a badge" is config today, no code:

```json
"stats": { "perRow": { "label": "person", "value": "total" },
           "goal": [ { "at": 5, "label": "text.chef_of_the_week" } ] }
```

Likewise a fixed per-chore target is expressible in `tiles` mode, one hand-written tile per chore with
`when: { "chore": "Bedding", "done_on": { "within": "@month" } }` and `goal: 1`. It renders correctly;
it just names every chore in the schema, so adding a row to `ref_chores` silently gains no tile. The
gap is not the bar — it is that the target is authored in the view instead of looked up per group.

**Proposed shape:**

```json
"perRow": { "label": "chore", "value": "total", "goalFrom": "target" }
```

`target` is an ordinary `computed.lookup` off a new `ref_chores.target_per_month`, the same lookup
shape the scoreboard already uses for `points`. A **separate key**, not an overload of `goal`: `goal`
already means number | `"max"` | ladder, and a bare column name would be indistinguishable from the
literal `"max"`.

Cost: one branch in the `perRow` loop, a `schema.schema.json` property, a `validateSchema` check, a
test. It does not go through the view-kind seam above — no engine module, no component, no classifier.

**Two things it does not fix, and one of them is the important half.**

- **A group with no rows produces no tile.** `aggregateRows` builds its groups from the rows handed to
  it, so a chore nobody has done this month is absent from the view entirely — which is precisely the
  chore the reminder exists for. An empty bar is the whole feature; a missing bar is the bug. The fix
  is to seed the group keys from the referenced lookup table (`chore` is a `ref` to `ref_chores`, so
  the key set is known independently of the data) rather than from the rows. Larger than `goalFrom`,
  and independently useful: the same hole makes any leaderboard omit everyone who scored nothing.
- **"Days since last done" is not expressible.** `aggregate` supports `count` and `sum` only, so a
  per-chore group can say "done twice this month" but not "last done 47 days ago". The per-row half
  already exists as `computed.daysSince`; there is simply no `min`/`latest` aggregate to collapse it
  per group. Adding one is small. Deciding what the bar then *means* is not — today a full bar is
  success and overshoot recolours to `success`, whereas an overdue bar filling up is bad news, and
  inverting that per tile is a renderer decision this entry does not make.

Sequencing: `goalFrom` on its own is honest but partial — chores that get done show their own targets,
and neglected ones stay invisible. Seeding the groups is what turns the view into a reminder. Worth
building the two together.

### Prose that names its rows — a per-row template for an embed

A `markdown` view is prose **plus** grids: `{{self}}` and `{{view:x}}` render a table, a card stack or
a `list` layout, and every one of them puts the data *under* the sentence. Nothing puts a cell *inside*
one.

The sacrament-meeting program is where that shows. The handbook's wording for presenting a member to be
ordained is a sentence about one person — "We propose that [name] receive the Aaronic Priesthood and be
ordained a priest" — and the bishopric schema can only approximate it: a header sentence phrased in the
plural, the names and offices listed beneath it, a footer sentence after. It reads correctly. It is not
what the conductor is meant to say.

**Proposed shape** — a per-row template beside `markdown`, rendered once per matching row in place of
the grid:

```json
{ "sources": ["admin_callings"],
  "filter": { "$and": [ { "status": "accepted" }, { "calling_type": "ordination" } ] },
  "rowMarkdown": "{{t:text.ordination_line}}",
  "hideEmpty": true }
```

with the sentence itself living in the Languages tab (`text.ordination_line` = "We propose that
**{{person}}** … be ordained a {{calling}}."), because a sentence with a name in the middle of it is
per-language prose, not schema. Values interpolate through their own translations, the way a grid cell
already resolves `list.<list>.<value>`.

**The hard half is grammar, not interpolation.** A list value has one stored form and a sentence needs
several: Finnish wants the office inflected (`pappi` → *asetetaan **papin** virkaan*), English wants the
article to agree (*a deacon*, *an elder*). This is precisely why the current program lists the names
under the sentence — a list needs no case. Three ways out, none free: phrase every template around
inflection (works, constrains the wording), give inflected forms their own translation namespace
(`list.callings.priest#gen` — a real vocabulary, and every schema pays for it), or leave it to the
author and accept that some languages cannot use the feature. Worth deciding before building, because
it decides whether the value is worth the branch.

**Access is not free either.** A grid hides what a viewer may not see — `obscureNames` blanks a column,
access gating drops a block. An interpolated sentence has to route every value through the same checks
or it becomes the way to read a name the grid would have masked. The template path must reuse the cell
renderer, not `String(row[col])`.

Cost: no engine module, no classifier, no component — this is not a view kind. A rendering branch in the
read-only data path beside the inline-`{{self}}` block, the same branch again in `print.js` (a program is
printed more often than read on screen), a `schema.schema.json` property, a `validateSchema` check that
every `{{col}}` names a real column, and a test. Read-only by nature: a sentence has no cells to edit.

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

- **`stats`** (KPI tiles / progress bars) — `stats.js` + the `stats` view kind. Confirmed the premise
  it was proposed on: the data half already existed, so the whole feature is a renderer over the
  aggregate pipeline. `chore_points_week` became bars by gaining three lines and changing no data
  config at all, which is the adoption story the entry predicted.
- **`rosterRef`** — a rotation's rosters from one 2-D lookup instead of a table per slot. Adding a
  family member went from five schema edits nobody could make in the app to one row in the Lookup
  editor. It was a resolver swap in `rotation.js`, as the entry predicted; the tests assert both shapes
  produce the same matrix from the same duties.
- **`board`** (kanban) — was the top pick; `board.js` + `chore_board`.
- **`form`** (single-record intake) — `form.js`.
- **`image` / `url` column types** — with an `asset:<id>` tier so a deployment with no storage bucket
  can still hold an uploaded image.
- **Runtime search** — the per-view `search` box (`"search": true`, or an array of columns). This was
  proposed as a cross-cutting enabler for "every list/board/gallery wants it", and it landed.

## Declined

- **Bundling a charting library.** Incompatible with the no-build constraint (static files, CDN Vue,
  no bundler) and with the CSP. The supported answer is the Vuetify primitives already loaded, plus
  inline SVG and the existing `hashColor` where a real mark is needed. `stats` shipped on
  `v-progress-linear` and pulled in nothing — which is the evidence this trade is affordable.

## Suggested order

`.ics` export next — it is small, self-contained, and has no security surface. Then `timeline`, which
closes a gap the calendar documents about itself. Then `tree` and `gallery`, both gated mainly on a
column type.

Per-row goals sits outside that line: it is the cheapest thing on this page and touches no seam, but
it extends a shipped kind rather than adding one, so it competes for attention with nothing. Take it
whenever a schema wants it.

The RSVP attendance pattern is not in that order because it is not code — it can be authored into a
schema today.
