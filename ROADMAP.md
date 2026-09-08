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

### Empty groups — the bar that is missing is the one that matters

Half of *per-row goals* (below, in Shipped). That half made each tile carry its own target; this one
is about the tiles that never appear.

`aggregateRows` builds its groups from the rows it is handed, so a chore nobody has done this month
has no group and no tile — and that is precisely the chore a reminder exists for. `chore_cadence`
demonstrates it today: twelve chores in `ref_chores`, nine tiles, and the three missing ones are the
neglected ones. **An empty bar is the whole feature; a missing bar is the bug.**

The fix is to seed the group keys from the referenced lookup table rather than from the rows — `chore`
is a `ref` to `ref_chores`, so the key set is known independently of the data. Independently useful:
the same hole makes any leaderboard omit everyone who scored nothing, which is the person most worth
seeing on a scoreboard.

The cost was a decision rather than lines, and the decisions are now made. They are recorded here
because each one was argued down from a plausible alternative, and an entry that shows only the answer
gets the alternative re-proposed.

**`seed: true`, not `seedFrom: "ref_chores"`.** `aggregateRows` serves every aggregate view, so seeding
cannot be unconditional — a leaderboard over a 400-row lookup would grow 400 tiles — which means a key
on the view either way. It reads the column's own declaration rather than restating it: `chore` is
already `{ type: "ref", table: "ref_chores", valueCol: "chore" }`, so naming the table again on the
view creates a second place to be wrong and the two can disagree. That is the failure the `hierarchy:`
fix was written to end (see Shipped), and it is not worth re-introducing one entry later.

Scoped to `ref` columns first, and say so. "The key set" has more than one origin — `person` is
`{ type: "select", list: "members" }`, whose keys are a `listSources: users` roster, not a table's rows
— so covering both means type dispatch. A `seed: true` that quietly does nothing on a `select` is worse
than one that reports it at load.

**Gate on the target, not on the count.** A key with no `target_per_month` is not on a cadence and gets
no tile. This is what makes the seeded set self-maintaining: retiring a chore means clearing its
target, in the Lookup tab, with no schema edit — so "which rows of the lookup count" is answered by
data that already exists rather than by a new flag. The drop belongs in `stats.js`, which holds the row
and the resolved goal together; `rows.js` must not learn what a goal is. Wanted under its own name
(`skipUntargeted` or similar) rather than as a silent rule, because a tile with a value and no goal is
legitimate elsewhere — a `display: "number"` scorecard is exactly that.

**Hiding zero tiles is NOT the answer, though it looks like one.** For this view the zeros are the
output; a view that hides them did not need seeding in the first place. It is also not expressible
today: `filter` runs on source rows, `groupBy.filter` tests a synthetic row built from the key alone
(`rows.js`) and so never sees a total, and `limit` is a top-N slice rather than a predicate. A real
predicate over the aggregated row — SQL's `HAVING`, as `groupBy.having` — is a genuine gap and worth
recording as its own, but it is a different feature and must not be built as this one's excuse.

**Where the zeros sort: `stats.js`, over `pct` — NOT `defaultSort`.** `aggregateRows` ranks
highest-total first, so every seeded zero lands at the bottom: right for a leaderboard, exactly
backwards for a reminder, where the chore at 0/1 is the one the page was opened for.

The schema's existing sort vocabulary cannot express the fix, and it is worth writing down why, because
`defaultSort: "done"` looks like it would. It sorts ascending on one named column, which puts the zeros
first and then gets the rest wrong: raw count is a poor proxy for *behind*. Cook dinner at 1/20 is 5%
and would sort AHEAD of Hoover at 2/4, on nothing but 1 < 2. The order a reminder wants is by
completion ratio, and no column holds one — `pct` is computed inside `stats.js` after the goal
resolves, and `computed` has no arithmetic to manufacture it (the kinds are `lookup`, `fromColumns`,
`daysSince`, `occurrenceSource`).

So this belongs to the renderer, as a key on `rowTiles` (`order: "behind"` or similar), sorting the
built tiles. That placement has the property worth having: `defaultSort` cannot reach `pct` by
construction, so the two orderings cannot disagree about the same view — which is the failure mode
`sortRosterRows` was consolidated to end (#180, four inline copies of one order).

One inconsistency to fix or to know about first: a top-level stats view renders `currentData` straight
out of `aggregateRows`, while the embedded one goes through `sortByCol` (`embeds.js`). Today that is
invisible, since `sortByCol` returns rows untouched when no column is named — but any view that sets
`defaultSort` orders differently depending on where it is rendered.

A seeded row is `{ id: key, <keyCol>: key, <into>: 0 }`. Zero is honest for `count` and `sum`, where
"nothing" genuinely is zero; it would be a lie for the `avg`/`min` below, which is a reason to land
those two in the other order or to seed `null` when they arrive.

**"Days since last done" is the other thing this view cannot say.** `aggregateRows` supports `count`
and `sum` only, so a per-chore group can report "done twice this month" but not "last done 47 days
ago". The per-row half already exists as `computed.daysSince`, and `stats.js`'s own `reduce` already
has `min`/`max`/`latest` — the gap is only that the aggregate pipeline has neither. Adding one is
small. Deciding what the bar then *means* is not: today a full bar is success and overshoot recolours
to `success`, whereas an overdue bar filling up is bad news, and inverting that per tile is a renderer
decision this entry does not make.

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

### Leftovers — data the schema no longer refers to

A schema moves on; the database does not. When the bishopric example replaced its `callings` list with
a catalogue, a deployment that upgraded was left holding an `organizations` list and a `callings` list
that nothing reads any more, beside a stray list minted by a seeder that no longer exists, beside
`_pages` bodies orphaned when their doc-views were renamed. None of it announces itself. The Lists tab
renders a retired vocabulary exactly like a live one, and the only way to know which is which is to
read the schema.

**What can be computed** by walking the schema once — the same traversal `_seedSchemaLists` and
`forEachFilterListValue` already do:

- lists no column's `list` or `listSwitch.list` names
- collections holding rows for a table the schema no longer declares (and their archive partitions)
- `_pages` rows whose view is gone
- translation keys whose referent is gone — `field.<col>`, `tab.<table>`, `view.<name>`,
  `list.<ns>.<value>` for a value no longer in that list or lookup
- `_list_users` links pointing at a list value that no longer exists

**It must be a report, not a sweep.** A rename is indistinguishable from a deletion plus a creation, so
anything automatic would delete a vocabulary the moment someone renamed a list and had not yet
reimported. The data is the only copy. The app already has one wrong-way-round precedent here: the
prune in `saveLists` is how a list is deliberately retired, and it is also how a reinstall emptied the
vocabularies a deployment had spent a year filling in (fixed in `Examples.listsForInstall` — an example
fills gaps, an import replaces).

**Start with the badge, not the panel.** The cheaper half of this answers the question where the person
is already standing: mark a list in the Lists tab, and a lookup table in the Lookup tab, that the schema
does not refer to. Mark the NEGATIVE — on a healthy database every vocabulary but a handful is live, so
colouring the live ones paints the whole screen and the eye stops reading it, while a chip on the three
leftovers is a glance. Colour cannot be the only channel: the Lists editor already carries a locked
badge for filter-pinned values and a translate badge, so a "not referenced" chip in that same slot
survives both themes, a screenshot, and a reader who cannot separate the hues.

It has to fail safe, and that is the whole difficulty. A plain list is reached by `list` or
`listSwitch.list` and nothing else, which is easy to prove. A lookup TABLE is reached by a `ref` column,
by a `list:` naming it, by `translatableLists`, by a board's ref lane, by a rotation's `rosterRef` and by
a `computed.lookup` — miss one and the badge tells someone their live catalogue is dead. So: mark only
what can be PROVEN unreferenced, and stay silent when unsure. The badge is allowed to say nothing; it is
not allowed to be wrong.

The badge does not subsume the report. It answers "is this one used?" for things that have a tab; the
report answers "what is left over?" for the things that do not — orphaned page bodies, dead translation
keys, links pointing at deleted values.

**Shape:** a panel in Settings beside Examples. One inventory, each entry with what it is and how much
of it there is ("`hymns` — a list of 200 values, referenced by no column"), and a per-item delete using
the grid's arm-then-confirm. Never a "delete all", never a prompt on boot; the answer to "is this
finished with?" belongs to the person, and the cost of getting it wrong is asymmetric.

One subtlety worth building in from the start: a list and a lookup TABLE may share a name — the
bishopric example has both a `ref_statuses` table and, on older deployments, a `ref_statuses` list.
The report has to say which of the two it means, and must never offer the table when the leftover is
the list.

Cost: a pure function (schema + what the database holds -> an inventory), Node-tested; the panel; the
deletes reuse writes that already exist. No engine module, no view kind. The same panel is the natural
home for the example-drift notice Settings already shows.

### A subscribable calendar feed

The `.ics` **export** shipped (see Shipped below); this entry is what is left: a URL a calendar client
can subscribe to, so an edit reaches a phone without anyone re-exporting.

The earlier version of this entry priced the feed as the expensive half of a pair. Most of that price
turned out to be an assumption rather than a cost, and two of its three blockers are gone. What
remains is one decision, and a choice between four ways of delivering the file. On a Supabase
deployment the cheapest needs no component at all; on Firebase it does, for a reason that is about
IDENTITY rather than storage — see option 1.

**The delivery constraint, stated first because everything follows from it.** A calendar client is not
a browser. Google fetches your URL from *its* servers, Outlook from its own, Apple with an HTTP client
— none has a JS engine, a DOM, or a service worker. So the response body must literally begin
`BEGIN:VCALENDAR`. That rules out, definitively:

- a static page that fetches the data and rewrites itself — the client receives the HTML source;
- the Firestore REST API — `{"fields":{"ics":{"stringValue":"BEGIN:VCALENDAR…"}}}`;
- the Realtime Database REST API — a *quoted* JSON string;
- a Hosting rewrite — it can only target Cloud Functions or Cloud Run, both Blaze.

Access is not what blocks these. A single document can be made world-readable. The JSON envelope is.

**Correction: Cloud Storage is not available on Spark.** An earlier draft of this proposal assumed a
client could publish the file to a bucket. It cannot — Storage needs Blaze, which is exactly why the
`asset:<id>` tier exists (`app-core.js`: "an image kept IN THE DATABASE as a data URI, for deployments
with no blob store"). Recorded so it is not re-proposed.

#### Pre-render into the database, and the server stops being dangerous

The design that dissolves the old hazard is to **store the finished `.ics` as a blob, exactly the way
an image is stored** — `_assets`-shaped, `ASSET_CAP` 900 KB against Firestore's 1 MiB document limit,
which is roughly 4000 events.

The point is not storage. It is *who renders*. The APP renders the text, with the real signed-in
identity, the real access gating and the real translations, and writes the result. The serving layer
then fetches one document and returns its string with `Content-Type: text/calendar` — about ten lines,
with no knowledge of the schema, the views, or the access model.

That is the whole difference. This entry used to cost a server that had to re-implement
`canReachTable`, `@me`, owner scoping and per-view filters, and keep them in agreement with
`firestore.rules` — the "comparison in three languages" hazard, failing silently toward leaking.
Pre-rendering removes it rather than mitigating it: the only thing the endpoint holds is data.

It also makes the update **write-triggered**, through the `writes.js` funnel — whose header already
says it exists so exactly this kind of thing can be added in one place. No schedule, no polling,
nothing that has to stay awake.

#### What updates, what is fetched, and what is stored

Three counts, routinely conflated, and only the last can grow with headcount:

| | Count | Paid by |
|---|---|---|
| Update | **one**, regardless of subscriber count | the app, on write |
| Fetch | one per subscriber per refresh | *their* calendar client |
| Blob | one per distinct CONTENT — i.e. per audience tier | storage |

The fetch count is identical whether everyone shares one URL or each holds their own: 200 subscribers
means 200 fetches either way. **Per-person URLs therefore cost nothing in requests** — one extra
document read inside a request that was happening anyway — and they buy individual revocation: someone
leaves, delete one row, their URL dies and nobody else's does. A shared URL is all-or-nothing, and
rotating it after a leak breaks every subscription at once.

**Rendering scales with access shapes, not people.** The number of genuinely distinct calendars is the
number of distinct grant combinations — one for a household, perhaps three for a congregation. One
full-access client renders every tier in a single pass, because `events.js` takes `canReachTable` and
`resolveMeTokens` as **ctx functions** rather than reading root state: narrowing them renders the
calendar as another audience would see it, through the same predicate the app itself uses, so a
mistake narrows too far rather than leaking. That capability was an unintended consequence of the
extraction, and it is what makes tiering affordable.

**The exception, and what it would take.** A view filtered on `@me`, or a rotation with `mineOnly`,
differs genuinely per person and cannot fold into a tier. `validateSchema` refuses such views as feed
sources today — the right default, since a published file has no "me" to resolve and would otherwise
carry whoever pressed publish and serve it to everyone. That is the one failure in this feature that
LEAKS rather than disappoints, so the refusal stays until something replaces it deliberately.

Lifting it means one blob per SUBSCRIBER rather than per tier. The shipped `my_calendar` in the
bishopric example is the shape that wants it: three sources, each filtered `responsible: "@me"`, so one
view is a different calendar for every member of a bishopric.

#### Per-person feeds — the plan

**Rendering is already possible, and that is the surprising part.** `events.js` takes `canReachTable`
and `resolveMeTokens` as ctx FUNCTIONS rather than reading root state, so a full-access client can
render "the calendar as this other person sees it" by substituting both — through the same predicates
the app itself uses, so a mistake narrows rather than leaks. No new rendering path is needed. What is
missing is everything around it.

1. **Who to render for.** A feed needs a subscriber list, and it must be opt-in: rendering one blob per
   USER would publish a file for people who never asked and never look. The natural shape is a
   self-service table with an `owner` column — the primitive that already backs RSVP — so subscribing is
   a row the person creates for themselves and unsubscribing is deleting it. That also makes the count
   honest: N is subscribers, not headcount.
2. **Resolving another person's `@me`.** `meValueForList` reads `myListValues`, which is the SIGNED-IN
   user's link. Rendering for someone else needs the same lookup for an arbitrary account, from
   `listAvatars` / the `_list_users` sidecar. Per-person is where a wrong answer means one person's
   calendar handed to another, so this wants its own tests, and the sentinel matters: an identity that
   cannot be resolved must yield the no-match token and an EMPTY calendar, never an unfiltered one.
3. **Access, not just filtering.** `@me` is display-only — the app's own note on `mineOnly` says so:
   "the roster rows are still fetched … Real secrecy is a per-roster-table grant". On screen that is
   fine, because the viewer could read those rows anyway. In a FEED it is not: the file is rendered by a
   full-access client and served to one subscriber, so `@me` becomes the only thing standing between
   them and everyone else's rows. A per-person feed therefore has to be checked as an ACCESS boundary,
   which the filter was never built to be. This is the real work, and the reason this is not a small
   change.
4. **N blobs, one write.** Republishing stays a single pass — the loop is inside one operation — but it
   costs N renders and N uploads per debounce window. Fine for a household or a bishopric; a
   congregation-sized subscriber list wants a cap and a way to see how many are being written.
5. **Tokens.** Per-person URLs are what make revocation possible, and they are the decision this whole
   entry already waits on.

Not scheduled. Steps 1, 2 and 4 are ordinary work; step 3 is a security boundary being asked to hold
weight it was not designed for, and it should be entered deliberately or not at all.

#### Decoupling a feed from a calendar VIEW

Asked because the bishopric example had no calendar and therefore no way to publish anything, which
made the requirement look like an obstacle. It is not, and the cheap answer is better than the change.

**Cost if built: small — perhaps half a day.** `Feeds.isFeed` tests `v.calendar && v.feed`, and
`events.js` reads sources through `Calendar.sources`, which already expands the single-source
`{source, dateColumn, titleColumns}` sugar. A `feed` on a DATA view would need the same three facts
under some other key, `Feeds.tablesOf` taught to read it, and validation for it.

**Why it is the wrong shape anyway.** A calendar view IS the declaration "these rows are dated events,
this column is the date, these are the title". A data view does not say that, so decoupling means
inventing a second vocabulary for the same fact — two places to look, two to keep in step, and the
question "what does this feed contain" answered differently depending on which one an author used.

**And the problem it would solve is not real.** A calendar view is a few lines of config, `nav` and
`views` are independent (the bishopric schema defines eighteen views and navigates to thirteen), and
because republishing is write-triggered a feed's first publish happens on the first write to a source
table — nobody has to press anything. A calendar view that exists only to be published is therefore
already possible, costs almost nothing, and keeps one vocabulary.

Declined for now on that basis rather than on cost. Worth revisiting only if something OTHER than a
calendar ever needs publishing, at which point the question is not "decouple the feed" but "what is the
second thing, and does it share a shape with the first".

**Who regenerates matters, and this is the remaining trap.** The rendering client must be able to see
everything the feed contains. A restricted member's write regenerating from their own `dataCache`
would overwrite the complete calendar with a truncated one — silent loss for every subscriber, caused
by a perfectly legitimate edit. Gate regeneration on a full-access client; a member's write then
leaves the feed stale rather than wrong, which is the correct direction to fail.

#### What is actually left

**One decision, and one choice of delivery.**

The decision is not code: this would be the app's **first bearer token for ROW DATA**. `?mode=…&config=…`
share links carry connection config and the reader still signs in; the only token-in-URL today is the
admin-only CSP read endpoint. A feed token is mailed around, synced to phones and stored on Google's
servers indefinitely, with no expiry and no second factor. Per-person tokens make it revocable and
attributable, which is the best available answer — but it is a real widening of the surface, and it
belongs to whoever owns the deployment rather than to an implementer.

#### Four ways to deliver the file

All four serve the SAME pre-rendered blob, so the app-side work is identical and the choice is
reversible. What differs is what has to exist, and whether an edit reaches subscribers without waiting.

| | Update | Component you maintain | Runs on Spark | Per-person URLs |
|---|---|---|---|---|
| **1. Managed blob store** (Supabase Storage) | on write | none on Supabase; see identity note on Firebase | yes | yes |
| **2. Byte pipe** (Worker / Edge Function) | on write | one, ~10 lines | yes | yes |
| **3. Static file** (scheduled Action → Pages) | scheduled | none (a workflow) | yes | no |
| **4. Blaze** (Firebase Storage, or a Function) | on write | none | no | yes |

**1. A managed blob store — recommended, but read the identity note below before assuming it is free.**
The app uploads the rendered `.ics` to a PUBLIC bucket and the object's own URL is the subscription.
This is not a component in the sense the others are: it is the same managed service Firebase Storage
would have been if Spark included it.

*This repo already does it, on Supabase.* `_sbUpload` in `backend-supabase.js` uploads to a public
bucket and returns `getPublicUrl(...)`, and `uploadFile` is the interface the image column already
uses — a feed calls the same method with a `Blob` of `text/calendar`.

- **Pro:** on a SUPABASE deployment, nothing to write, deploy, monitor or keep alive. Write-triggered
  through `writes.js`. Free tier. The smallest total surface of the four.
- **Con on Supabase:** none worth the name — the signed-in user is already a Supabase user, so an RLS
  policy on `storage.objects` is the whole access story.
- **Con on FIREBASE — the part an earlier draft of this entry glossed over.** "A second free project
  used only as a bucket" is true of the *data*, and misleading about *identity*. The user is
  authenticated with Firebase; Supabase has never heard of them. Storage writes are gated by RLS, and
  the anon key is PUBLIC by design (it ships in client code), so "allow anon insert" means
  world-writable — anyone could exhaust the quota or overwrite the feed. Three ways out, none free:
  sign admins into Supabase with the same Google account and gate writes on an allowlist table
  (`auth.jwt()->>'email' in (select …)`) — no server, but a second identity provider and a second
  sign-in; or a Supabase Edge Function that verifies the Firebase ID token and uploads with the service
  role — proper, but a component on the WRITE side; or Blaze, and use Firebase Storage.
- **What that means for the comparison.** On Firebase, option 1's "no component to maintain" advantage
  largely evaporates: you end up with a second identity provider or a function either way. If a
  Supabase project is being stood up regardless, ONE read-side byte pipe (option 2) reading the blob
  out of Firestore may be simpler than a function plus a second storage service. The gap between rows
  1 and 2 is real on Supabase and nearly nil on Firebase.
- **The mechanical half is genuinely easy**, and worth separating from the identity half so it is not
  re-investigated: no CSP change (`connect-src` already allows `https://*.supabase.co`, for the Supabase
  backend), and no SDK (the Storage REST API is
  `POST {url}/storage/v1/object/{bucket}/{path}` with `x-upsert: true`, public reads at
  `/object/public/…`), so a `fetch`-based uploader is about thirty lines and does not drag
  `backend-supabase.js` onto a Firebase deployment. `uploadFile` is already the seam; what is missing is
  a storage config INDEPENDENT of the data backend, since `Databases.config(mode)` is keyed by the
  active backend's mode.
- **Three details that each fail silently:** `_sbUpload` writes `<email>/<ts>_<name>`, deliberately
  unique so one image never clobbers another — a feed needs the opposite, a STABLE path with
  `upsert: true`, or the subscription URL changes on every edit. `contentType: 'text/calendar'` must be
  set at upload, since the stored type is what the public URL serves. And a public bucket's URL shape is
  predictable, so the random token has to live in the FILENAME (Supabase signed URLs expire, which is
  wrong for a subscription).

**2. A byte pipe.** A Cloudflare Worker or Supabase Edge Function that reads the one blob and returns it
with a Content-Type (`supabase/functions/csp-report/index.ts` is the deployment template).

- **Pro:** works with the data wherever it already is, so no second service for storage. Ten lines,
  swappable, not a commitment to a second backend. Rough numbers: 200 subscribers polling every few
  hours is ~1600 requests/day against a 100k free allowance, and ~3200 Firestore reads against 50k.
- **Con:** it is a component you own — deployed, versioned, and capable of breaking on its own. Its
  secrets live somewhere. Strictly more to maintain than option 1 for the same result.

**3. A static file, committed by a scheduled Action.** The Action reads the blob and commits
`feed/<random>.ics`, which Pages already publishes on every push to `main`.

- **Pro:** no runtime component of any kind. The delivery path is the one you already deploy.
- **Con:** **necessarily scheduled** — a browser cannot push to the deploy, so this is the one option
  that cannot be write-triggered. A repo-write credential must live in GitHub Secrets, every refresh is
  a commit plus a full Pages rebuild, and a shared static path gives up per-person revocation.

**4. Blaze.** Firebase Storage (option 1 without the second service) or a Cloud Function (option 2
without the extra host). The straightforward version of all of this.

- **Pro:** everything stays in one project, and the whole question disappears.
- **Con:** billing enabled, on a deployment that is otherwise free and has been designed to stay that
  way.

#### Considered and rejected

Both fail the same test — the credential ends up stronger than the thing it protects.

- **Deploying from the browser via the Firebase Hosting REST API.** Technically real: create a version,
  upload, release, with an OAuth scope an admin could grant. But a Hosting version is a WHOLE-SITE
  snapshot, so every calendar edit becomes a full site deploy that can race with a real one.
- **A GitHub PAT in Settings**, committing the file so Pages serves it. It works, and it stores a
  repo-write credential in a browser in order to protect a calendar.

Neither is worth revisiting unless the trade changes.

**Expectation to set either way: a feed is not live.** Google refreshes external subscriptions on its
own schedule, typically many hours, and it is not client-controllable. Write-triggered regeneration
buys *correctness* — never stale relative to the data — not speed. Anyone wanting an edit on their
phone within seconds is better served by the export.

### Calendars defined in the DATABASE, not the schema

"Can a new calendar — ushers, cleaning, whatever someone thinks of next — be made without editing the
schema document?" Today: no. `calendar.sources` is schema, and the app has no schema editor by design
(SCHEMA.md: *hand-editing this document is the design*), so the routes are Settings → Import or editing
the file and reinstalling.

The proposal is not a schema editor. It is to let a calendar be a ROW.

**Why this fits rather than fights the architecture.** The split already exists and this lands on the
side that is already database-backed:

- `_pages` holds doc-view BODIES in the database, not in the schema;
- folder config holds per-view runtime settings — a rotation's anchor and range, a calendar's `ics`
  window and language, a feed's URL;
- lists and lookup tables hold vocabulary.

Schema is structure; the database holds content and per-deployment configuration. A calendar is a
saved question over tables that already exist — closer to a lookup table than to a column definition.

**Shape.** A `_calendars` system store, one row per calendar:

```json
{ "id": "ushers", "title": "Ushers",
  "sources": [ { "table": "duty_usher_dates", "dateColumn": "date", "titleColumns": ["…"] } ],
  "obscureNames": ["…"], "ics": { "back": "3m", "forward": "1y" } }
```

Read at boot and merged into `VIEWS` as ordinary calendar views. From there everything downstream is
inherited and needs no changes at all: rendering, the `.ics` download, publishing, the window and
language settings, `embed-view` for `{{view:x}}`, and the Settings list, which already enumerates
`Object.keys(VIEWS)` rather than the nav — so a database-defined calendar appears there with a download
button without a nav entry existing.

**Two constraints that shape it, both already written into the code.**

1. **A schema change forces a reload.** `columns.js` memoizes schema-static scans in a WeakMap keyed on
   the schema object, "safe because SCHEMA is built once at load and every runtime schema change forces
   a full page reload". Adding a CALENDAR does not touch `SCHEMA` (tables), so those caches stay valid —
   but the honest design is still create-then-reload, matching how installing an example behaves. Not a
   live-editing feature.
2. **Rendering is already fail-closed per source.** `events.js` drops any source whose table the viewer
   cannot reach, so a calendar created by one person cannot show another person rows they could not
   already open. This is what makes the feature safe to expose at runtime at all, and it is existing
   behaviour rather than something to add.

**The decision this needs, and it is not the code.** Creating a calendar is harmless — it reveals
nothing new. PUBLISHING one is not: a feed is world-readable to anyone holding its URL. Today that is a
schema commit, which is reviewed and deliberate; as a runtime action it becomes a button. So the two
want different permissions — create for any admin, publish gated more tightly, or not offered on
database-defined calendars at first. Worth deciding before building, not after.

**Cost.** The engine half is small, because everything downstream already exists: a system store, a
boot merge, and the save-time validation `validateSchema` already performs for `calendar` (a real table,
a real DATE column, real title columns — each of which otherwise fails as a permanently empty
calendar). The bulk is the UI nobody has built yet: pick a table, pick its date column, pick title
columns, repeat per source. That is a small form, but it is the first place the app asks someone to
choose a column by name, so it wants the same care the Lookup editor got.

Sequencing: worth doing after the feed's token decision, since "who may publish" is the same question
in a different hat, and answering it once covers both.

### Undo/redo — take the last thing back

Every write in this app is final the moment it happens. A cell edit saves 300ms after the last
keystroke, a row delete removes a row, a group rename rewrites forty rows across two tables, and the
only way back from any of them is to remember what it used to say and type it in again. On a database
whose rows are the only copy, that is the sharpest edge left in the grid.

**The seam exists and is already enforced.** `writes.js` was built for this and says so in its header:
`putRow`/`deleteRow`/`moveRow` were called from twenty-six places, and there was no one place to stand
if you wanted to change what a write *does*. There are twenty-seven call sites today, all in
`app-core.js`, and `dev/test/write-funnel.test.js` asserts that no direct `backend.putRow` survives
outside the funnel. Undo is the second thing to use the chokepoint, after the calendar-feed observer.

So the stack is not the difficulty. Three other things are.

**1. The before-image.** To invert a write you need the row as it was, and the funnel does not have it.
Several call sites mutate the cached row *before* they call `Writes` — `r.position = String(pos)` then
`putRow`, `row.updated_at = …` then `putRow` — so by the time the funnel sees the payload, `dataCache`
already agrees with it and there is nothing to diff against. The before-image has to be captured at the
call site and handed in.

The case that matters most is already holding it. `saveField` is the single entry point for every cell
edit, and its first two statements are:

```js
if (item[col] === value) return;   // item[col] is still the OLD value here
item[col] = value;
```

One function, old value in hand, covering the grid, the form view, and every inline editor that routes
through it. Row create (inverse: delete), row delete (inverse: put the row back — the object is in hand
at delete time) and archive/unarchive (inverse: the reverse `moveRow`) are the same shape and nearly as
cheap. That set is most of what anyone means by undo.

**2. One user action is not one write, and this is where the day actually goes.** A cell edit fans out
through `propagateMirror`. A group rename writes every matching row and then `propagateListChange`
across every column whose `list:` names the table. A reorder writes each row whose position shifted.
Without a grouping concept, the first Ctrl+Z of a forty-row rename puts one row back and leaves
thirty-nine — which is worse than having no undo, because it looks like it worked. So the funnel needs a
transaction wrapper, and the ten-odd multi-write call sites need auditing into it. The wrapper is small;
the audit is the work, and it is the part that cannot be hurried.

**3. Undo is a WRITE, not a restore.** Every backend subscribes to its tables, so an undo that reaches
into `dataCache` and puts the old values back would leave this client disagreeing with every other one.
It has to replay an inverse write through the same funnel, which also gets the observers, the feed
republish and the failure handling for free. This lands well: a cell write is already a partial patch,
and every backend merges partials (pinned by the "putRow merge semantics" suite in
`backend-conformance.test.js`), so undoing one column does not clobber a colleague's edit to a different
column of the same row. If they edited *the same* cell, the undo wins — that is the honest behaviour of
an inverse-op log against live data, and it is worth accepting rather than solving. Nothing here should
attempt a shared or collaborative undo.

The stack is **in-memory, per-session and local**. Not persisted, not shared, cleared on reload. Redo is
then close to free, because the forward patch is the payload the funnel already received.

**What stays out of it.** Schema import, `_pages` bodies and `_assets` writes are not logged. Undoing
"import a schema" is not an undo, it is a migration, and the import path already deletes-then-writes per
row for change detection — pretending that inverts cleanly would be the kind of guarantee this codebase
does not make elsewhere (`moveRow`'s comment about atomicity is the precedent: it does not claim what it
cannot do).

**The button.** The proposal is to give undo/redo the toolbar slot the refresh button holds. Refresh is
not dead — all four backends implement `subscribeTable`, so it is redundant only while a subscription is
alive, and it remains the one escape hatch when a socket drops silently — but it is the fallback, not
the daily action, and it belongs in an overflow menu or Settings. Undo and redo want to sit together, so
the slot becomes a pair. Ctrl+Z / Ctrl+Shift+Z alongside, and a disabled state that says the stack is
empty rather than doing nothing when clicked.

**Cost.** A pure `undo.js` (the stack, the transaction collapse, the replay) that is Node-testable with
no DOM; the call-site audit; the toolbar pair and the keybindings. No view kind, no schema change, no
backend contract change — notably no `getRow`, which a read-before-write design would have needed on
four backends and which would have put a Firestore read on every write. The audit rather than the volume
is what decides whether this is any good.

**Built so far — the mechanism and the cell-edit path.** `undo.js`, the grouping, the replay, the
keybindings and the toolbar pair; `saveField` and `propagateMirror` record into one action, so a cell
and every mirror it feeds come back in one press. Three findings worth keeping:

- `writes.js` is UNCHANGED, and that turned out to be right. The funnel knows a write happened, which is
  the wrong moment: `saveField` debounces 300ms, and typing `a` -> `b` -> `c` inside that window cancels
  two timers and writes once. Recording at edit time would have left two entries for writes that never
  happened. Recording happens where the write is actually issued, and the before-image is held per timer
  key so a debounce reset keeps the FIRST one — the undo restores `a`, not the `b` nothing ever stored.
- The clock is stamped at replay time rather than carried in the op. An undo is a write happening now,
  and `updated_at` is what `archiveAfter` measures age by; replaying a stored timestamp would leave a
  row the user just touched claiming it had sat still, and eventually file it away for it.
- The local half of a replay is `LiveSync.applyChange`, not a second merge implementation — but
  deliberately NOT `_liveApply`, which queues behind `_liveHeld`. That gate is right for a remote change
  arriving mid-edit and wrong for the user's own undo, which would otherwise sit invisible until they
  clicked away.

Refresh moved to Settings, as proposed. It is not gone: every backend subscribes, so it is the escape
hatch for a dropped subscription rather than a daily action, and a browser reload already refetches
strictly more than it does.

**Also built — the row lifecycle.** Add (`_createBlankRow`, one action across the whole mirror cluster),
delete (all three paths: `_deleteFromSources`, `deleteRefRow`, `deleteRefParent`), archive and restore,
and all three reorders (`moveRowPosition`, `moveRefChild`, `moveRefGroup`). Three more findings:

- The automatic `archiveAfter` sweep is excluded. It runs on boot and is nobody's action; an entry for
  it would sit at the bottom of the stack, and on a database with a short window it would be the FIRST
  thing Ctrl+Z reached — un-filing rows the user never filed.
- A delete records nothing for a partition the row was not in. The write there is a no-op on every
  backend, and inventing an inverse for it would resurrect the row into a partition it never occupied.
- `undo.js` grew one method, `abandon()`, for the branch that genuinely cannot be inverted: restoring a
  row archived under the old STORE model moves it between two collections, and that inverse is only
  correct while both are cached — which is exactly what the branch exists because boot does not
  guarantee. It poisons the whole action rather than skipping the one op, because an entry that puts
  back three mirrors of four is not an undo and looks like one.

**What remains.** The value cascades, which are a different question from the row ones: the group rename
(`renameRefParent`) and the lookup cell edit (`saveRefField`) both fan out through
`propagateListChange` / `propagateRefChange` into `_rewriteValueInColumns`, and onwards into list
vocabularies and translations. Undoing a row is local; undoing a rename means deciding what happens to
the list value and the translation key it carried, and `saveLists` prunes — the same asymmetry the
Leftovers entry above warns about. Worth designing before building.

### `tree`

Hierarchies of arbitrary depth. Would generalize the ref-hierarchy the Lookup screen already renders.
The prerequisite half — one declared answer to "which column is the parent", returned as nodes with
children — shipped (see Shipped), so this is no longer a fifth place guessing at it.

**Not a `parent` COLUMN TYPE, which is how this entry used to propose it.** Building the declaration
settled the shape: `hierarchy` already names columns, so the second model is a mode of the same key
rather than a second way to say the same thing.

```json
"hierarchy": { "parent": "parent_id", "value": "name", "by": "id" }
```

`by: "value"` (the default, and every lookup that exists) means the parent column holds the group's
VALUE; `by: "id"` means it holds another row's id. `lookupHierarchy` returns the mode, `buildHierarchy`
branches on it once, and every caller goes on reading nodes with children without learning which model
it is looking at. One declaration, one resolver, two edge kinds.

**Where it belongs is a DATA table, not a lookup, and that is a boundary rather than a preference.** In
this app a lookup value *is* its identity, in four places at once: `list.<table>.<value>` translation
keys (`migrateListTranslation` re-keys them on rename), schema filters that pin values by hand — which
`lockedListValues` then refuses to let anyone rename — `select list: <lookup>` columns storing the
value, and the exports and rules mirrors comparing those same strings. An id-keyed lookup has to
choose: keep storing values, and the ids buy depth but not the single-row rename that made them
attractive; store ids, and a hand-written schema filter has to name `o1` instead of
`aaronic_priesthood`, in a document whose whole premise is that hand-editing it is the design.

So the value model stays for lookups, `by: "id"` serves the tables that actually want depth — a task
with subtasks, an agenda item with sub-items — and the two coexist behind one resolver. Which is also
the reason this is not urgent: every hierarchy in every shipped schema is two levels and value-keyed,
so `by: "id"` would be a second model with no user, and the write paths do NOT unify (rename
propagation exists *because* parents are values, and is simply dead under ids).

### `gallery`

A media grid. Unblocked since `image`/`url` columns shipped, so this is now mostly layout.

### `feed`

Reverse-chronological activity stream. Pairs naturally with a changeset/audit trail if one is ever
added.

### `split`

Master-detail two-pane layout — a list on the left, the selected record on the right.

### New column types

Several proposed views are really "a layout plus a column type":

- **`geo`** — lat/lng, required by `map`.
- **`richtext`** — speculative; the markdown renderer seam in `embeds.js` may cover it more cheaply.

### `map`

Geographic view. Ranked last deliberately: it would be the first view to depend on an **external tile
provider**, which means a new CSP origin, a third-party dependency at render time, and a feature that
stops working offline. Everything above it stays inside the app boundary.

## Shipped

Recorded so the roadmap shows what graduated rather than silently shrinking.

- **A goal each row carries** — `goal: { "column": "<col>" }` on `rowTiles`, plus the shipped
  `chore_cadence` view reading `ref_chores.target_per_month`. One view now holds "bedding once a
  month" beside "wash up daily", which no single `goal` could express. The proposal argued for a
  separate `goalFrom` key on the grounds that a bare column name is indistinguishable from the literal
  `"max"` — true of a *string*, and the reason it shipped as an OBJECT instead: `stGoalOk` already
  dispatches on type, so a fourth shape cost one branch and spent no new key, and no precedence rule
  had to be invented for a view that set both. It resolves where the row is still in hand and becomes
  a plain number, so `"max"`, the ladder and the pct/over arithmetic never learned about it. Shipped
  knowingly partial: a chore with no rows still produces no tile (see *Empty groups*, above).
- **`timeline`** (#173) — rows with a start *and* end date as bars across periods, closing the gap the
  calendar documents about itself: a calendar places a row on ONE day, so anything spanning days had
  nowhere to go. `timeline.js` reuses `rotation.js`'s interval arithmetic rather than growing a second
  definition of "a week". The decisions that mattered were all about not lying with a picture — a row
  with no end is one period rather than open-ended, a row outside the window is dropped rather than
  flattened to a zero-width bar that reads as "happening now", and a crossing bar is clipped and
  squared-off so "continues past here" is in the shape.
- **One declaration for a lookup's hierarchy** — `hierarchy: { "parent": …, "value": … }` on a lookup
  table (or `false` for a flat catalogue), and `Columns.lookupHierarchy` as the ONE answer the Lookup
  editor, a board's 2-D ref lane, a `list:` naming a lookup, and `validateSchema` all read. Proposed as
  the prerequisite for `tree`; landed as a bug fix. Three of those four re-derived "which column is the
  parent" independently and two disagreed — the editor required EXACTLY two author-facing columns, the
  board accepted any number — so a lookup that grew a third column kept its lanes and silently lost its
  parents and children in the editor, with nothing invalid to point at. The grouped rows became an
  ordered array of nodes rather than a value→rows map, which is what keeps depth open for `tree` and
  which incidentally fixed a lookup grouped by year ignoring `position` (an object iterates
  integer-like keys first and ascending). `hierarchy: false` settled two shipped catalogues the
  inference had been rendering as groups of numbers: `ref_chores` (chore + points) and `ref_rewards`.
- **`stats`** (KPI tiles / progress bars) — `stats.js` + the `stats` view kind. Confirmed the premise
  it was proposed on: the data half already existed, so the whole feature is a renderer over the
  aggregate pipeline. `chore_points_week` became bars by gaining three lines and changing no data
  config at all, which is the adoption story the entry predicted.
- **`.ics` export** — `ics.js` + a download button on top-level calendars. The serializer is pure over
  the map `events.js` builds, so it exports exactly what the screen shows, rotation duties included, and
  inherits that map's per-source access gating. It is also the half every feed design needs: a file and a
  URL differ in how the text is delivered, not in the text. RFC 5545 supplied the reasons it is a tested
  module rather than a template string — all-day events need a non-inclusive `DTEND`, lines fold at 75
  OCTETS without splitting a UTF-8 sequence, and UIDs must be stable or every refresh becomes a
  delete-and-re-add of the whole calendar on someone's phone.
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

`gallery` next, then `tree`. `gallery` is gated on nothing since `image`/`url` shipped; `tree` is gated
on wanting it — its prerequisite landed, and what remains is a second hierarchy model that no shipped
schema has asked for. (`.ics` export and `timeline` were each first here in turn, and have shipped.)

Undo/redo sits ahead of both, and is the one entry on this page that would be first on merit rather
than on cheapness: it is gated on nothing, it needs no schema change and no backend change, and it is
the only proposal here that removes an existing sharp edge instead of adding a surface. What holds it
back is that its cost is an audit of the multi-write call sites rather than an implementation, so it
wants an uninterrupted sitting rather than a spare afternoon.

Database-defined calendars sit outside that line for the same reason the feed does: what it needs
decided is who may PUBLISH one, which is the feed's open question wearing a different hat.

The subscribable feed is deliberately not in that line despite being mostly designed. Everything left
in it is a judgement rather than an implementation — whether this deployment wants a bearer token for
row data at all, and which of the four delivery options it prefers — a choice whose answer differs by
backend, since the cheapest option is free on Supabase and costs either a second identity provider or a
function on Firebase. Those belong to whoever owns the deployment, so the entry waits for that answer
instead of being ranked against features.

Empty groups sits outside that line: it extends a shipped kind rather than adding one, so it competes
for attention with nothing. It is also the half of per-row goals that was left behind — the shipped
half is honest but partial, and this is what turns a scoreboard into a reminder. Take it whenever a
schema wants it, and settle the seeding key first.

The RSVP attendance pattern is not in that order because it is not code — it can be authored into a
schema today.
