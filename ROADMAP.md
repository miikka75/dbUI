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

**The exception.** A view filtered on `@me`, or a rotation with `mineOnly`, differs genuinely per
person and cannot fold into a tier. Either refuse such views as feed sources in `validateSchema` — the
better default, since a shared file has no "me" to resolve and would otherwise pick one arbitrarily —
or accept one blob per SUBSCRIBER, which is opt-in and far smaller than one per user.

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

`timeline` next, which closes a gap the calendar documents about itself. Then `tree` and `gallery`,
both gated mainly on a column type. (`.ics` export was previously first here, and has shipped.)

The subscribable feed is deliberately not in that line despite being mostly designed. Everything left
in it is a judgement rather than an implementation — whether this deployment wants a bearer token for
row data at all, and which of the four delivery options it prefers — a choice whose answer differs by
backend, since the cheapest option is free on Supabase and costs either a second identity provider or a
function on Firebase. Those belong to whoever owns the deployment, so the entry waits for that answer
instead of being ranked against features.

Per-row goals sits outside that line: it is the cheapest thing on this page and touches no seam, but
it extends a shipped kind rather than adding one, so it competes for attention with nothing. Take it
whenever a schema wants it.

The RSVP attendance pattern is not in that order because it is not code — it can be authored into a
schema today.
