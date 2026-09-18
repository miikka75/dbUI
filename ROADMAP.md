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

An entry that is PARTLY built says so in its heading and records what landed inline, rather than being
split in two: the reasoning for what remains is the same document as the reasoning for what shipped.

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

### QR check-in — scan a code to mark attendance *(scan phase 1.5 — the config branch of the shipped scan view)*

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
outright. `sw.js` cannot rescue it either — it is an installability stub that caches nothing, and `periodicSync` is
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
the impure shell around it. **See *Scan to log an action*, below** — that entry argues
the module should be `scan.js` and cover appending a row too, since the two cases differ only in
whether the target row exists yet. Config names the target rather than hardcoding it, e.g.
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

### Scan to log an action — the same camera, a row appended *(phases 1–4 landed; 1.5 and 5 open)*

QR check-in, above, writes an *answer* onto a row that already exists: someone signed up, and the scan
records that they turned up. This entry asks whether the same scan can create the record instead — a
code on the dishwasher that logs a chore done, a code at each door on a security round that logs the
place visited, a control at an orienteering checkpoint. **Yes, and it is the cheaper half of the two.**

**The code names a thing, not a person.** That is the whole inversion. In check-in the payload
identifies the attendee and the row is found by owner; here the payload identifies a *lookup row* — a
chore, a checkpoint — and the owner comes from being signed in. Which half is configured swaps; nothing
underneath changes.

**The target table already exists.** `chore_log` in the chores example is this feature's destination as
it stands today: `owner` (auto-stamped), `person` (`defaultFrom: "@me"`), `chore` (a `ref` into
`ref_chores`), `done_on`, `status` defaulting to `logged`, and `ownerWritable`/`ownerWritableWhile`
bounding what the member may write and until when. A scan sets `chore` and `done_on`; every other
column is filled by machinery that shipped long ago. A guard's route is the *same table* with a
`ref_checkpoints` lookup in place of `ref_chores` — not one line of code different, which is the sign
this is one feature and not three.

**No new access primitive, and — unlike check-in — not even a verifier.** Check-in leans on an editor
standing at the door; this leans on nothing but `owner`. Appending a row you own is exactly what `rsvp`
and `form` already do, gated by the same two rule layers. The write is the one `setRsvp` performs
today: upsert the row keyed by (a value, me), create it if it is not there. So the honest description
of the write half is *`setRsvp` with the key taken from config instead of from an event*.

**Which means `checkin.js` should be `scan.js`.** Not a generalization invented in advance — two
concrete cases are on the table, and they differ only in whether the row already exists. The pure
module maps a payload to a write *plan*:

    (payload, rows, config, { me, today }) -> { table, match, set } | { error }

with the component performing the write and the camera as the impure shell, the same division every
kind here uses. Config names the target rather than hardcoding it, exactly as the check-in entry
proposed:

```json
{ "scan": { "table": "chore_log", "column": "chore", "from": "ref_chores",
            "set": { "done_on": "@today" }, "once": "day" } }
```

`@today` is resolved by the scan shell, which knows the date. It is deliberately **not** a new
`defaultFrom` token — `defaultFromValue` resolves `@me` and stamps `''` for everything else, and giving
it a second token would put a clock in the column layer to save one line here.

**The payload is the stored value, so there is no code format to invent.** A `ref` cell already holds
the lookup's `valueCol` text, so a barcode carrying `CP-07` resolves by equality against
`ref_checkpoints`. No id space, no registry, no mapping table. Two things follow for free: a payload
matching no lookup row is *rejected* rather than written as free text (the ref column's own validity is
the check), and a code that will not scan can be **typed** — the same fallback that lets the
shared-code arrangement above ship before any decoder exists.

`once` is the double-scan question, and it is the reason the plan carries a `match` at all. A guard who
scans a door twice visited it once; someone who washes up twice did it twice. `once: "day"` makes the
plan an upsert keyed by (column, owner, date); omitting it appends. That is a config choice per view,
not a policy the module can guess.

**Issuing the codes is a print job, and encoding is the cheap direction.** Decoding is the expensive
half — the iOS `BarcodeDetector` gap and the vendoring ceremony documented above, all of it shared with
check-in and none of it duplicated. Encoding is not in that class: Code 39 is bars from a 44-entry
pattern table, tens of lines of inline SVG, no vendored library, and every phone camera reads it. QR
needs a real encoder and therefore the full `vendor/versions` + SRI + drift-guard ritual. So the first
build is a **printable sheet of labels over a lookup table**, one code per row, through `print.js`.

**What a printed code proves, stated plainly.** It proves the scanner had the code — not that they were
there. The check-in entry's argument for why its QR may carry nothing secret (a verifier is standing in
front of the person) does not survive this inversion: here nobody is watching, and a code photographed
once walks the route from a sofa forever. Rotation cannot rescue it either, because the code is glued
to a wall. This is not a corner being cut — commercial guard-tour systems are static NFC buttons on
walls and have exactly this property — but it has to be decided up front that **a scan is a convenient
truthful record, not evidence.**

What makes it credible is the trail rather than the token. Every row carries who, what and when — as
long as the *when* is a time and not merely a date, which is requirement 2 below and the reason it is
in the first build. Then a round logged in forty seconds, or logged at 03:00 from one spot, is visible
in the report — which is a
`pivot` (checkpoint × person) or a `timeline` over data the scan already writes. A `geo` column (see
*New column types*) would raise the cost of faking it from zero to something; it would not close it,
and it is not a prerequisite.

**Offline works, but only for a page that is already open.** Basements, car parks and forests have no
signal, which is where this feature is used, so the distinction matters. `backend-firebase.js` enables
Firestore persistence, so a scan performed in a loaded tab queues locally and flushes on reconnect with
no code of ours involved. What does NOT work is a cold start: `sw.js` is an installability stub that
caches nothing, so a scan that arrives as a fresh navigation needs the network to load the app at all.
That is not a limitation of this feature — the app has never started offline — but it decides which
form of scanning survives a basement, and the build order below is arranged around it. Worth writing
down for a second reason: it makes the Supabase assessment's "no offline cache" line a real regression
rather than a footnote, since on that backend even the open tab needs a connection at the door.

**It makes *Empty groups* load-bearing rather than nice.** The checkpoint nobody visited is the entire
point of a patrol report, and a group built from the rows that exist leaves the missing one invisible.
That half has since SHIPPED (see Shipped): a report over `checkpoint` — a `ref` into the route — asks
for `groupBy: { …, seed: true }` and the skipped door is a zero rather than an absence. Nothing here
depends on it to work, but a report that silently omits the skipped door is worse than no report.

#### What each use case needs

The cases below were collected by asking what else a "scan a thing, record that it happened" gesture is
good for. Most add nothing — which is the argument that this is one feature. The four that do add
something are small, and two of them are needed by the cases already documented above.

| Use case | The write | What it adds |
|---|---|---|
| Chore logged — a code on the dishwasher | Append to `chore_log` | Nothing. This is the baseline |
| Guard round · orienteering control | Append per checkpoint | **A time, not a date** (2). `once` per round. `groupBy.seed` (shipped) for the door nobody opened |
| Attendance check-in *(the entry above)* | Update the row that exists | `match: "owner"` — the other branch of the same plan |
| Equipment out and back — tools, AV kit, boats | Append a movement | Nothing. "Who has it now" is a `latest` tile over the log, which `stats` already computes |
| Training log, reading log, recycling drop-off | Append | Nothing |
| Shop shelf — scan the product's own barcode | Append to `home_shopping` | **`codeCol`** (1): an EAN is not a value anyone typed into a list |
| Member card, staff badge, pre-printed label | Either branch | `codeCol` again — an opaque id, not a name |
| Single-use ticket or meal voucher | Append once, ever | `once: "ever"`, and a **refusal the scanner can see** (3) |
| Vehicle check, incident report — scan, then fill in | Start a record | `then: "edit"` — hand the new row to `form`. Deferred |
| Stock count — fifty items in a minute | Append many | A batch session with a correctable list. Deferred |
| Kiosk: scan the person's badge *and* the place | — | **Declined**, see below |

**The kiosk case is declined, and it is worth writing down why**, because it is the one that will be
asked for. On a shared device with nobody signed in, the identity would have to come from a scanned
badge — which makes the code a credential, exactly the model the check-in entry above rejects on the
grounds that this app has real identities and does not need to invent one. `owner` is stamped from
auth; a device signed in as one account writing rows attributed to whoever waved a card at it is
authentication by possession of a photocopiable token, and it would be the first place here where a
row's owner is not the person who wrote it. The supported answer is that each person signs in on their
own phone, which is also how the round gets its honest timestamps.

#### Requirements that follow

1. **`codeCol`** — the scanned payload matches a *named column* of the lookup, defaulting to its
   `valueCol`. An EAN, a badge number or a stamped checkpoint id is not the display text. This is one
   parameter in the resolver, and check-in needs it too, so it is in the first build rather than after.
2. **A time, not a date.** `@today` is enough for a chore and useless for a round: the whole credibility
   argument above is that *when* each control was logged is visible, and a `date` column cannot show
   that four controls were logged in the same minute. So `set` also resolves **`@now`** into a declared
   timestamp column. `created_at` is not the answer — it is hidden, its meaning is "when the row was
   written" rather than "when the thing happened", and it is not a column a `timeline` or `pivot` may
   read.
3. **Outcomes, not exceptions.** The plan reports `created` · `updated` · `already` · `unknown`, and
   the view shows which. A ticket scanned twice must *refuse loudly with the first time on the screen*;
   a door scanned twice should say "already, at 02:14" rather than silently doing nothing, which is
   indistinguishable from a scan that did not register. This is the difference between a tool someone
   trusts at 3am and one they stop using.
4. **The table must be able to accept the write, and `validateSchema` must say so.** A `scan` view over
   a table with no `owner` column, or whose scanned column is missing from `ownerWritable`, is a view
   that renders fine and fails at the rules layer with nothing to point at. That check belongs beside
   the other config checks, not in a bug report.

#### Build order

Each phase is shippable and useful on its own, and the expensive half is last on purpose.

**Phase 1 — the engine and a box you type into. LANDED.** No camera, no printing, no new dependency.
`scan.js` — `plan(code, rows, lookupRows, cfg, { me, now }) -> { outcome, table, row | patch, existing }`
— plus the standard five: `kindOf` (`migrations.js`), `VIEW_KINDS` + `isScanView` (`app-core.js`), the
`kind` enum and the `scan` object in `schema.schema.json`, the `validateSchema` branch including
requirement 4, and `dev/test/scan.test.js`. The write is `_createBlankRow(table, prefill)`, which
already stamps the owner, resolves `defaultFrom`, writes every mirror under one id, records an undo
entry and honours `rosterPublic` — so the root's share of this is roughly fifteen lines. The view body
is a code box, the outcome line, and my last few rows. Embedding is free, per the seam at the top of
this file.

*Usable the day it lands*: by typing, and — worth noting because it is nearly free — with a **handheld
barcode scanner, which is a keyboard**. A twenty-euro USB or Bluetooth wedge scanner types the code
into the box and presses Enter. A library desk, a stock room or a check-in table is fully served by
phase 1 with no camera code in existence.

*Acceptance*: a typed code appends the row with owner, person, chore and timestamp set; an unknown code
refuses and writes nothing; under `once: "day"` the second scan reports the first one's time. All three
are asserted end to end in `dev/test-ui/scan.spec.js`, over a patrol route rather than the chores
bundle, since that is the arrangement `once` exists for.

Two things the build taught that the plan had not settled. **`ambiguous` is a fifth outcome**, not a
detail of `unknown`: two catalogue rows carrying one code is a label reprinted onto the wrong post, and
resolving it by taking the first would log the wrong door and leave a report that looks perfectly fine
afterwards. And **the config check belongs to `scan.js`, not to `validateSchema`** — `Columns.vocabularyErrors`
is the precedent, and it is what makes requirement 4 (a view that renders but cannot write) a tested
property rather than an error string nobody executes.

**Phase 1.5 — check-in, as config.** `match: "owner"` plus `codeCol` turns the same module into the
entry above, still with no camera. It is listed as a half-phase because it is a resolver branch and a
test, not a feature.

**Phase 2 — codes on paper. LANDED.** A printable label sheet over the scan view's catalogue, one code
per row, through `print.js`. Code 39 is a 44-entry pattern table rendered as inline SVG — no vendored
library, no CSP change — and every handheld and phone decoder reads it. This is the phase that makes a
real route deployable: print, stick on the doors, scan with the wedge or type.

*Acceptance*: printing yields one scannable label per row, and what is on the paper resolves the row it
names. Both asserted in `dev/test-ui/scan.spec.js`.

The symbology turned out to settle a question the entry had not asked. **Code 39 has no lowercase**, so
a label prints uppercase — which is free only because matching lowercases both sides, and that decision
was already made in phase 1 for a different reason (a wedge scanner's stray carriage return). Had codes
been matched exactly, this phase would have needed either a second symbology or a rule about how
catalogues may be spelled. The table itself is transcribed rather than derived, so it is guarded by the
symbology's own laws — nine elements, exactly three wide, a 2-bars-1-space split except for the four
punctuation codes, and no two characters sharing a pattern. That catches a transcription slip; it does
not substitute for holding a scanner in front of a printed sheet, which is still worth doing once.

**Phase 3 — the phone's own camera, without writing a decoder.** Encode the label as a QR carrying a
URL into the app — `?scan=<code>&view=<name>` — and the platform's own camera decodes it. iOS Camera
and Control Center, Android's camera, and every third-party scanner already do this; the app's share is
one boot parameter resolved after sign-in, beside the `?db=` and `?user=` params already handled. **No
`BarcodeDetector`, no vendored decoder, no camera lifecycle, and it works on the platform the decoding
problem was about.** Its cost is a QR *encoder* for the print sheet, which does need the
`vendor/versions` + SRI + drift-guard ceremony — encoding is the cheap direction, but QR is not Code 39.

Two things to state plainly: an installed iOS PWA and Safari have **separate storage**, so a scanned
link opening in Safari will ask for sign-in once; and every scan is a page navigation, which is what
the offline note below is about.

*Acceptance*: scanning a printed QR with the phone's stock camera app opens the view with the code in
the box, and one press records it.

**LANDED, in two separable halves.** The boot parameter carries the architecture and needed no
dependency at all; the encoder is the convenience of the app drawing its own codes, and it went in
second, once printing sheets, "any camera app" and a door display had each arrived at the same missing
piece.

`qrcode-generator` is vendored the way every other dist here is — pinned in `vendor/versions`, fetched
by all three materialisation paths (`update-vendor.sh`, the Pages workflow, the session-start hook),
with an SRI-pinned CDN fallback and drift guards in `deploy-config.test.js` for each. One thing it does
NOT do is load at boot: 56 KB of third party for an action most sessions never take is paid for on
first use instead, which means a schema with no scan view never pays for it at all. That is the only
place this repo's vendoring pattern was extended rather than copied, and it is why the fallback URL and
its hash live in `app-core.js` rather than `index.html`.

The sheet now prints QR, with Code 39 as the fallback when the encoder cannot be fetched — which also
retired the "this code cannot be printed" note for anything but that fallback, since a QR carries a URL
and has none of Code 39's 43-character limit.

The acceptance criterion above also changed while building it, and the reason is worth keeping. **The
link arms the box by default rather than writing the row**, and `link: "submit"` opts out per view. A link is something anyone can send you, and a GET that logs
a visit as you is a row somebody else caused — which for a patrol round is exactly the property the log
exists to have. One deliberate press costs nothing next to pointing a camera, and it removes a
drive-by write entirely. This is also an argument for phase 4 that was not recorded before: zero-tap is
safe in an in-app scanner, because there the person pointing the camera *is* the intent. For a URL it
is a deployment's call, not the app's: a wrong chore costs nothing and gets approved by somebody
anyway, while a falsified patrol round is the one thing that log exists to prevent.

Auto-submit also turned out to need something arming does not: **it must wait for the view's tables**.
Writing into the gap before they land is not merely a race on the catalogue (a good code reported as
`unknown`) — the log arriving afterwards REPLACES dataCache, so the created row disappears from the
screen while still reaching the backend, and `once` cannot see an earlier scan it should have refused.
Found by the test, not by reading the code.

**Phase 4 — the in-app scanner. LANDED, and it cost far less than this entry budgeted for.** The plan
allowed for a vendored decoder, `getUserMedia` and teardown discipline. What shipped is
`BarcodeDetector` plus `<input type="file" accept="image/*" capture="environment">` — one frame from the
OS camera, decoded in the page. **No vendored decoder, no `getUserMedia`, no permission of the app's
own, no decode loop, and no stream to forget to stop**, which was the failure this entry actually warned
about. It reads both symbologies the app produces: the sheet's Code 39, and a QR carrying the `?scan=`
link, which is unwrapped to its code rather than navigated to.

The decoder gap is answered by **not answering it**. `BarcodeDetector` is absent on iOS Safari, Firefox
and desktop Chrome for Windows; there, no button appears, rather than a button that fails. The camera is
an enhancement, and the typed box — with a wedge scanner or fingers — was always the path that works
everywhere. Vendoring a decoder to close that gap would buy an enhancement, not a capability, which is
the trade the QR encoder decision already declined.

*Acceptance*: a photographed label writes its row without the page being left, which is the structural
reason this form works offline — asserted in `dev/test-ui/scan.spec.js` with a sentinel a navigation
would wipe. The queue-and-flush half is Firestore's offline cache and is not exercised by the local dev
server, so it is claimed on the backend's behaviour rather than on a test here.

What is genuinely untestable in this repo is **the decode itself**: `BarcodeDetector` does not exist in
the browser the suite runs in. The tests stub exactly that one call and exercise everything around it —
whether the button appears at all, what a photograph does to the row, and what each refusal says. Worth
holding a phone in front of a printed sheet once before trusting it in a basement.

**Phase 5 — deferred, and only on demand.** `then: "edit"` (hand the new row to a `form`), a batch
session with a correctable list, and a `geo` stamp. None is needed by any case above; each is a small
addition to a shape that already exists, which is the reason for not building them now.

Phases 2 and 3 can swap. Phase 4 depends on nothing and could be built at any point — it is last
because it is the only expensive one and, until the offline case is actually in front of someone,
phase 3 does the same job for free.

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

### A subscribable calendar feed *(shared-content feeds landed in #174; PER-PERSON feeds are what remain)*

A URL a calendar client can subscribe to, so an edit reaches a phone without anyone re-exporting. The
`.ics` export shipped first; the shared-content feed shipped after it, in #174.

**What is left is the per-person half, and only that.** A calendar whose rows are the same for every
reader is done and in use. A calendar filtered on `@me` — "my duties" — is still refused outright by
`validateSchema`, and the sections below are the design for lifting that refusal. Read *Per-person
feeds — the plan* for the shape and *What landed* for what the build already settled; the four-way
delivery table is kept because it records what was considered, but it no longer describes a choice
anyone has to make.

The earlier version of this entry priced the feed as the expensive half of a pair. Most of that price
turned out to be an assumption rather than a cost.

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

**The GUARD for step 3 landed first, deliberately, before any rendering path exists that could trip
it.** `Feeds.configErrors` replaces `validateSchema`'s inline feed branch and checks the two modes in
OPPOSITE directions: a shared feed refuses `@me`, a `per-person` one requires it on every source and
`mineOnly` on every rotation overlay. The inversion is the point — a shared feed carrying `@me` renders
the publisher's calendar for everyone, which somebody notices, while a per-person feed with one
unfiltered source among four renders a perfectly plausible calendar containing everybody's rows.

Three things the build settled that the plan above had not.

- **The rule is per SOURCE, not per view.** `events.js` filters a calendar's rows through `s.filter`
  only; `view.filter` never reaches them. A view-level `@me` on a calendar filters nothing, so accepting
  one would have been accepting a guard that does not run.
- **An unrecognised `feed` value is not a feed.** `modeOf` is an explicit allowlist rather than a
  truthiness test, because a typo could plausibly resolve either way and the two directions fail very
  differently: read as "shared" it publishes an unfiltered file, read as nothing it publishes nothing
  and says why. `isFeed` is derived from `modeOf` so the two cannot drift.
- **It belongs to feeds.js, not to validateSchema** — the division `Scan.configErrors` already set, and
  what makes this a Node-tested property rather than an error string only a browser executes.

**Step 2 landed with it: rendering as somebody else.** `ListUsers.valuesForEmail` inverts the admin link
map for one account — the general form of the self-scoped `myListValues` — and `_eventsCtxAs(identity)`
swaps the two identity-dependent ctx functions, leaving everything else shared so it cannot drift from
what the app draws on screen. `resolveMeTokens` and `mineOnlySlot` were refactored onto one identity
rule (`_listValueOf`) rather than copied, because a copy that drifted would filter one person's calendar
by another person's name and still render something plausible.

**The trap was `mineOnly`, and it was not in the plan.** `mineOnlySlot` returns `null` — meaning the
WHOLE matrix — when the caller is a full-access client, which is correct on screen and catastrophic in
a file. A per-person feed is rendered BY a full-access client FOR somebody else, so deferring to that
rule would have drawn every slot's duties into every subscriber's file: the admin's own view of the
rotation, mailed to each of them under their own name. `_mineOnlySlotOf` therefore has no admin branch
at all. This is the second instance of the entry's own warning — a display-time convenience that
inverts its meaning once the renderer is not the audience — and the first was `view.filter` not
reaching a calendar's rows. Both were found by reading the render path rather than the config.

`canReachTable` is deliberately NOT narrowed. The publisher reaches everything, and what makes a
per-person file that person's own is `@me` alone — held by the static guard above, which refuses a
per-person feed unless every source carries `@me` and every rotation overlay is `mineOnly`. Narrowing
at render time as well would be a second, weaker copy of a rule that already holds.

**Step 1 landed too: the subscriber list.** A per-person calendar names a `feedSubscribers` table, and
subscribing is a row the person creates in it — opt-in by construction, so N is subscribers rather than
headcount, and unsubscribing is deleting the row.

**Where the URL lives was forced, not chosen.** Folder config holds the shared feed's `{id, url, at}`,
and the obvious move was to keep a map of them there. It cannot: `_saveFolderConfig` is a "local
override for everyone with view access", so N per-person URLs there would hand every member everyone
else's bearer token. An owner-stamped row is already read-restricted to its owner, which makes the row
the only place that is both readable by the subscriber and unreadable by everyone else.

That gives the row **two halves with different writers**, exactly as `chore_log` does: the subscriber
owns the request (that they subscribe, and in which language), the publisher owns the grant (the minted
URL). `Feeds.configErrors` holds that split, and the check that matters most is the one for a table
declaring no `ownerWritable` at all — not a weak gate but no gate, letting a subscriber write their own
url column and point it at a path revocation never blanks. The language column is checked in the
opposite direction: absent from `ownerWritable` it is a picker that cannot pick.

**`forSubscriberTable` is deliberately not folded into `forTable`.** A subscriber table is not a source
of any calendar, so `forTable` returns nothing for it and a language change would have republished
nothing — the stale-forever failure that function exists to prevent, arriving through a table it was
never taught about. They stay apart because they are acted on differently: a source write invalidates
every subscriber's file, a subscriber write invalidates one person's, and folding them together would
make somebody changing their language cost a full re-render for everyone.

#### Unsubscribing, and the orphan it must not create

"Unsubscribing is deleting the row" — written above, and WRONG, for a reason only visible once the URL
was forced into the row. A subscriber may delete their own self-service row: `firestore.rules` allows
it on the owner branch of `allow delete`. Doing so destroys the only record of where their file lives,
and they cannot blank it themselves because uploading needs full access. The result is a public file
frozen on its last snapshot that **nothing can ever name again** — "unsubscribed" reading as success
while the calendar stays online for good. That is the exact failure `_blankFeedAt` exists to prevent,
reached from the other end.

So unsubscribing is a STATE the publisher can see: an `activeColumn` in `ownerWritable`, which keeps
the decision entirely the subscriber's. `ownerWritableWhile` gating on that column freezes the row the
moment they use it — and `ownerStateOk` governs an owner's DELETE as well as their edits, so the
tombstone survives for the publisher to act on. Both are required by `configErrors` when a `urlColumn`
is declared, because the failure has no symptom at the moment it happens. `pendingRevocation` is the
resulting to-do list: unsubscribed, but the file is still live.

Blank counts as subscribed. Reading a yes as no stops somebody's calendar updating for a reason they
cannot see; reading a no as yes leaves one file the next pass blanks anyway.

**Revocation is therefore not instant**, and that belongs next to the button rather than in a help
page: the file dies when a full-access client next runs a pass, not when the subscriber presses
unsubscribe.

#### Orphans: the ones prevented, and the ones that need sweeping

The guard above closes the orphan a SUBSCRIBER can make. Four others remain, and they share a shape —
the blob store is the truth about what exists, and the rows are only a derived record of it, so
anything that updates one without the other strands a file:

- an **admin** deleting a subscriber row (admins bypass `ownerStateOk`);
- an upload that succeeds while the row write fails — the blob exists and nothing records it;
- a failed blank during `regenerateFeed`, which leaves the old file live while the row points at the new;
- `feed` turned off, or the view renamed, with rows still holding URLs.

Perfect bookkeeping will not fix these, because each is a partial failure of the bookkeeping itself.
**The structural answer is to reconcile rather than to remember**: list the `feeds/` prefix, compare
against the paths the rows and folder config account for, and blank anything unexpected. That turns the
requirement from "never lose a record" into "notice later", which is achievable.

It needs one addition to the backend contract — a `listFiles(prefix)` beside `uploadFile`; Supabase
Storage has `list` and Firebase Storage `listAll`, so it is thin on both. Nothing needs DELETE: an
orphan that has been blanked is an empty calendar, which is harmless, and blanking is idempotent, so a
sweep may run over the same file repeatedly without needing to be sure. That is what makes the sweep
safe to write before it is possible to be certain which files are live.

Not built. It is the right shape for a periodic admin action rather than a write-triggered one, and it
should be entered with step 4 rather than before it, since the loop is what starts producing files in
quantity.

#### Step 4 landed: the pass, its order, and when it runs

`publishPerPersonFeed` blanks whatever unsubscribed, then renders and uploads one file per remaining
subscriber through `_eventsCtxAs`. Three decisions in it were not obvious from the plan.

**Revocation runs FIRST, and unconditionally.** If the cap or a render failure stops the pass half way,
the files that should stop serving have already stopped. The other order would make a busy pass the
reason somebody's calendar stayed online after they left — the cost falling on exactly the person who
asked to be removed.

**The cap is visible.** `feedSubscriberCap` defaults to 100 and says how many it skipped. This is the
only part of the feature that scales with PEOPLE rather than with access shapes, and silently rendering
four hundred calendars because a roster grew is not something that should happen without anyone
choosing it.

**A subscriber's id is stored, not derived.** The path is `feeds/<id>.ics` and republishing needs the
path — but recovering one from a stored URL would mean parsing whichever shape the backend spells a
public object in, which is the one place this feature would have learned which backend it runs on. So
`idColumn` sits beside `urlColumn`, guarded identically: both are the publisher's to write, because
either one in a subscriber's hands is a link revocation cannot reach.

**"When a full-access client next runs a pass" was too vague to ship.** Write-triggered republishing
cannot bound revocation on its own: the person unsubscribing is not full-access, so their own write
publishes nothing, and if nobody edits a source afterwards their file serves indefinitely. Two things
close it. `_onWriteRepublish` now also reacts to the SUBSCRIBER table via `forSubscriberTable`, so any
publisher present acts within the 2s debounce; and `_sweepFeedsOnBoot` runs one pass per per-person
feed when a publisher opens the app. The worst case is therefore "until an admin next opens the app"
rather than "until somebody happens to edit a duty" — with no schedule and nothing that has to stay
awake, which is the property the whole feature was designed around.

That pass writes each subscriber's id and url back into their row, which is itself a write to the
subscriber table — so `_publishingFeeds` guards against the pass re-arming on its own output, which
would otherwise republish for ever.

What remains is the orphan sweep above, and the UI: a subscribe button, the language picker, and the
subscriber's own link. The engine is done.

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

#### What landed (#174), and what the build settled

**The shared-content feed SHIPPED.** The decision this section used to wait on — whether row data may
sit behind a bearer token at all — was taken by building it. The question is kept here because a
decision that leaves no trace gets re-litigated as reliably as a rejected idea does: this is the app's
**first bearer token for ROW DATA**. `?mode=…&config=…` share links carry connection config and the
reader still signs in; the only other token-in-URL is the admin-only CSP read endpoint. A feed URL is
mailed around, synced to phones and stored on Google's servers indefinitely, with no expiry and no
second factor. That is a real widening of the surface, and it was accepted deliberately.

`publishFeed` renders through the same window and language settings as the download, uploads via
`backend.uploadFile` at `Feeds.pathFor(id)`, and keeps `{id, url, at}` in the folder config.
`_onWriteRepublish` marks feeds dirty through `Feeds.forTable` and coalesces at 2s, so a bulk import is
one upload rather than hundreds. Delivery ended up **backend-agnostic** rather than Supabase-specific:
`uploadFile` was already the seam for image columns, so the four-way table above priced a choice the
code did not have to make. What it could not dodge is the Spark trap — `uploadFile` EXISTS on
backend-firebase whenever Storage initialized, and fails at runtime because Storage needs Blaze. An
image column survives that by falling back to the `asset:` tier; a feed cannot, since an asset is a
database row and a subscription needs an HTTP URL. So the failure is remembered in `_blobStoreDown` and
only the background path honours it — otherwise every edit on such a deployment retries the same doomed
upload for ever — while a person pressing the button always gets an attempt, which is also how the flag
clears.

**Who may publish was answered more strictly than the question assumed.** `canPublishFeeds()` requires
a full-access client (`!userAllowedTables`), and that gate is doing two jobs that are worth keeping
apart. One is permission. The other is correctness, and it is the load-bearing one: a restricted
member's write regenerating from their own `dataCache` would overwrite the complete calendar with a
truncated one — silent loss for every subscriber, caused by a legitimate edit. Anyone proposing to
loosen the permission has to answer the second job separately, or the feature fails in the direction
this entry has warned about throughout.

#### Revoking a link — what the build taught, and what revocation cannot do

The intuition is that revoking means deleting the file. **The build rejected that, and the reasoning is
worth keeping**, because "mint a new id and walk away" is the obvious wrong answer and it leaves the
leaked link serving the last snapshot for ever.

`_blankFeedAt` uploads a **valid but empty VCALENDAR over the old object**. It is deliberately not a
delete: there is no delete in the backend contract, and adding one would not be better — a 404 leaves
clients retrying a dead address, while an empty calendar is a clean "there is nothing here" that every
client understands. What matters either way is that the old URL stops SERVING DATA.

Three operations sit on that one primitive. `regenerateFeed` blanks the old file, drops the id so a
fresh one is minted, and republishes — every existing subscriber breaks, which IS the feature, since it
is how a link that got out is taken back. `unpublishFeed` blanks and forgets, which exists because
turning `feed` off in the schema would otherwise stop republishing while leaving the last file
world-readable at a URL already sitting in people's calendar apps. And the id lives in the folder
config precisely because the PATH is what makes a subscription stable.

**What none of them can do is un-tell.** Events already synced to someone's phone stay on that phone; a
calendar client holds its last successful fetch until the next refresh replaces it. Revocation stops
future updates and reaches back into nothing. Worth saying out loud to anyone who asks for a link to be
cut off, because the intuition is usually that it recalls the data.

#### Four ways to deliver the file *(settled by #174 — kept as a record, not a choice)*

**The build did not have to pick.** `uploadFile` was already the seam for image columns, so a feed
calls it and each backend answers in its own way — which is option 1 on Supabase and option 4 on a
Blaze Firebase project, decided by the deployment rather than by this table. What survives from the
analysis below is the Spark trap, recorded against option 1 and now handled in `_blobStoreDown`.

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

### Undo/redo — take the last thing back *(fully landed: mechanism, cells, rows and the value cascades)*

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

**The value cascades — LANDED.** A different question from the row ones. The list rename
(`updateListItem2`), the list delete (`removeListItem2`), the group rename (`renameRefParent`) and the
lookup cell edit (`saveRefField`) all fan out through `propagateListChange` / `propagateRefChange` into
`_rewriteValueInColumns`, and onwards into list vocabularies and translations. Undoing a row is local;
undoing a rename means deciding what happens to the list value and the translation key it carried.

**One gesture, four stores — and only two of them are rows.** That is the whole difficulty, stated
plainly:

| What a rename writes | Written through | Row? |
|---|---|---|
| Every table cell holding the value | `_rewriteValueInColumns` -> `Writes.putRow` | yes |
| The vocabulary — a list's array, or a lookup ROW | `backend.saveLists` / `Writes.putRow` | half |
| The label — `list.<ns>.<value>` in every language | `backend.updateTranslations` | no |
| The account linked to it | `backend.setListUser` | no |

`undo.js` is row-shaped by design and says so: an op is the change shape `LiveSync.applyChange` already
reconciles, replayed through the funnel. Three of these four do not fit, and widening `Writes` to carry
them would be widening the row funnel to hold things that are not rows.

**So `undo.js` learns that not every write is a row, and nothing more than that.** `replay` dispatches on
`change.type`; anything that is not `put` or `delete` goes to a handler the app registers alongside
`apply`. The module gains six lines and no knowledge of any store. Three op types, and the reason each
has the shape it does is that **the op mirrors how its store is actually written**:

- `{ type: 'lists', list, values }` — the whole array. `saveLists` writes the entire blob anyway, so
  there is no partial to express; snapshot-shaped also means index-free, and therefore still correct if
  the list was reordered between the edit and the undo.
- `{ type: 'trans', ns, from, to }` — a key MOVE, because `migrateListTranslation` is already its own
  inverse under a swap. Reused rather than re-implemented.
- `{ type: 'link', list, value, email }` — a state SET, not a move. A move cannot revive: after a delete
  there is no link left to read, so the op has to CARRY the email it restores. A rename records two of
  these (clear the old, set the new), each exactly invertible.

**Why not simply rename back?** It looks like the cheap answer — the inverse of a rename is a rename —
and it is wrong wherever the new name already exists. Renaming A onto an existing B and then re-running
the cascade B -> A would drag back every row that held B all along and had nothing to do with the edit.
Recording the row half as per-row before-images keeps the inverse exact: the forward rewrite only
touched rows holding A, so only those are recorded, and a partial patch means taking back a value
rewrite cannot revert a colleague's edit to another column of the same row.

**An action has to be allowed to span an await, and that is the second change.** `propagateListChange`
is asynchronous for a real reason: an archive partition that is not cached is FETCHED before it can be
rewritten. `Undo.action` is a synchronous scope today, so every archived row would land in its own
entry — the forty-row-rename failure the grouping was built to prevent, one tier down. So `action()`
gains one branch: a body that returns a thenable holds the group open until it settles. The cost is
worth stating rather than hiding — a debounced write from elsewhere that fires inside that window joins
the rename's entry. That MERGES two entries; it cannot corrupt either, since every op still carries its
own before-image. The alternative, pre-fetching every partition before opening the action, is more code
for the same window.

**What the forward destroyed, the undo does not restore — and must not compound.** Renaming A onto a
name B that already exists clobbers B's label and B's account link *today, in the forward direction*.
The inverse moves the key back to A, which restores A's label faithfully and leaves B's gone — lost by
the rename, not by taking it back. That is the honest boundary, and the forward clobber is a
pre-existing bug worth its own fix (it belongs with *Leftovers*, since a merged value is exactly the
kind of thing that leaves no trace).

**The list delete is in scope even though the entry called this "renames".** `removeListItem2` cascades
`propagateListChange(name, value, null)`, which BLANKS the value out of every row that stored it — the
sharpest unrecoverable edit left in the Lists tab, and it costs nothing extra once
`_rewriteValueInColumns` records: the recording lives in the shared engine, so leaving delete out would
mean that engine records for some callers and not others, which is not an invariant anyone can hold. It
needs no translation op, because `removeListItem2` never moved the key — `list.<name>.<value>` is still
there, so a revived value gets its label back for free.

**`saveRefField` records at blur, not in its debounce**, which is where it differs from `saveField`. The
cascade already runs at blur (per column, and the editors are `@blur`-bound, so once per edit); the row
write is debounced 500ms behind it. Recording at blur puts the cascade and the row in one entry without
moving the cascade into the timer, where a two-column lookup — tab from `city` to `state` — would have
had to fan out for several columns under one timer key. Two columns edited inside one window then make
two entries, which is correct: each is a complete unit, and the row op is a partial naming its own
column. The pending whole-row write is not a race either, because the undo patches the cached row the
timer will write.

Out of scope, and deliberately: `addListItem2` (a blank value with nothing at risk), `moveListItem`
(order only), and schema import, which the entry already excludes above.

**Built, and four things it settled that the design had not.**

- **`Undo.undo()` could throw SYNCHRONOUSLY**, and that is a bug the feature merely exposed. `replayAll`
  maps `replay` over the ops, so a synchronous throw inside one escaped before `Promise.all` ever
  existed — past `undoLast`'s `.catch`, which is attached to the returned promise, and out as an
  uncaught error rather than a notice. Both stacks had already been mutated by then. It is the rule
  `writes.js` states in its own header, arrived at from the other direction: always a promise, including
  when the failure is synchronous.
- **`configure` ignored an explicit null**, so `configure({ apply: null })` silently kept the previous
  handler installed. The undo suite's own `beforeEach` had been assuming otherwise since the mechanism
  first landed, and passing for unrelated reasons. A key that is PRESENT is now honoured; only an absent
  one is left alone, which is what still lets one handler be set without disturbing the others.
- **Recording in the shared engine is what made the list DELETE free**, which is the strongest argument
  for the placement. `_rewriteValueInColumns` sits under all four cascades, so the delete — the only one
  of them that destroys data outright — needed nothing at its call site but the list snapshot and the
  link. Recording at four call sites would have meant four chances to leave one out.
- **`saveLists` and `setListUserLink` now return their promises.** Neither did, because nothing had ever
  needed to wait for them; a replay does, and a handler that resolves before the write lands would let
  an undo report success ahead of the store agreeing.

One property is worth stating because no test can hold it: a rename onto a name that already exists
still destroys that name's label and link in the FORWARD direction. The undo does not compound it, as
above — but that forward clobber is real, unreported, and belongs with *Leftovers*.

### `tree` — depth *(landed: the editor's recursion and an id-keyed store; delete semantics and ordering open)*

Hierarchies of arbitrary depth. Two halves, and they are worth pricing apart, because one was nearly
free and the other is a data migration: the screen that RENDERS depth, and the store that can HOLD it.

**The rendering half — LANDED, and it cost a component.** `buildHierarchy` has always returned nodes
whose children are nodes ("depth would be a change here rather than at every caller"); the Lookup
editor was the one place that contradicted it, nesting the child `<v-list-item>` inside the group's
`<v-list-group>` by hand. That is now one recursive `ref-node` (`#ref-node-tpl`), branching on what a
node IS rather than on a depth counter. It landed on its own, before the store half, and on that day it
rendered exactly the pixels it always had.

The branch **is not "depth 1 vs depth 2"**, which is the part worth keeping: under the value model a
group is a VALUE its rows carry and has no row of its own, so `node.row` is the honest discriminator and
stays correct at any depth. The store half later WIDENED it to `byId || !node.row` rather than replacing
it (item 1 below) — which is the evidence it was the right question to branch on.

*Superseded, and recorded because it was right at the time:* with nothing in the app building a third
level, the recursion was first proved by a test that stubbed `Columns.buildHierarchy` and handed the
real editor a group holding a group. That test was DELETED when `by: "id"` landed. It existed to prove a
claim that had become demonstrable for real, and a stub kept beside the genuine article is a second
answer to a question already answered.

#### The store: `by` as a mode of the same key

**Not a `parent` COLUMN TYPE, which is how this entry used to propose it.** Building the declaration
settled the shape: `hierarchy` already names columns, so the second model is a mode of the same key
rather than a second way to say the same thing.

```json
"hierarchy": { "parent": "parent_id", "value": "name", "by": "id" }
```

`by: "value"` (the default, and every lookup written before this) means the parent column holds the group's
VALUE; `by: "id"` means it holds another row's id. `lookupHierarchy` returns the mode, `buildHierarchy`
branches on it once, and every READER goes on consuming nodes with children without learning which
model it is looking at. One declaration, one resolver, two edge kinds.

#### Existing lookups must not be ported, and this is the plan's load-bearing decision

The tempting move once the editor recurses is to convert the two-level lookups and be done. **No**, and
the reason is not taste: in this app a lookup value *is* its identity, in four places at once, each
with a call site that would have to be answered.

| Where the value is the identity | The call site | What ids would do to it |
|---|---|---|
| The group's label | `listLabel(ns, r[parentCol])`, keyed `list.<table>.<value>` | The key becomes `list.ref_callings.o1` — unreadable in the Languages tab, and every deployment's existing keys orphaned |
| Schema filters pinning a value by hand | `lockedListValues` / `isLockedRefValue`, which refuse the rename that would break them | A hand-written filter names `o1`, in a document whose whole premise is that hand-editing it is the design |
| `select list: <lookup>` columns | `lookupListValues` returns `hierarchy.parent`'s values as the stored option | Every stored cell in every referring table has to be rewritten to an id |
| `rosterRef` rotations | `rosterBy` groups on the parent value; slot headers render through the same keys | Same rewrite, plus slot headers that no longer have a value to translate |

And the conversion itself is not a schema edit but a **one-way data migration per deployment**: mint a
parent row per distinct value (new ids), rewrite every child's parent cell, run
`_rewriteValueInColumns` across both partitions of every referring table, re-key the translations, and
hand-edit the pinned filters. `lookup-row-ids.test.js` is the reason the first step is the expensive
one — *"the id of a row a BUNDLE ships is its identity forever"*, because import merges by id, and a
minted parent is a new contract with every deployment that reinstalls. Undo now records value cascades,
so a mis-run is takebackable within the session that ran it; the import contract is not.

So: **the value model stays for the lookups that EXIST**, and the two coexist behind one resolver.

That sentence used to read "the value model stays for lookups", with `by: "id"` reserved for data tables
— a task with subtasks, an agenda item with sub-items. Building it proved the line is drawn in the
wrong place, and where it actually falls is worth stating, because the shipped example is a lookup:

- **The couplings belong to a lookup's HISTORY, not to lookups as a kind.** Translation keys, filter
  pins, `select list:` cells and `rosterRef` slots exist because something already points at those
  values. A catalogue created id-keyed from birth, which nothing references, carries none of them —
  there is no key to re-key and no stored value to rewrite. The rule is *never convert*, not *never a
  lookup*.
- **And a data table could not have shown depth anyway.** The Lookup editor is the only screen that
  renders a tree at all; `isLookup` is what puts a table in front of it. So `by: "id"` on `tasks` would
  have been a store nothing could display — the opposite of the acceptance this entry wanted.

#### `by: "id"` — LANDED, additively, with the lookups that exist untouched

Built because a three-level example was wanted in the demo bundle and no schema could produce one. It
is additive in the strict sense: the default stays `by: "value"`, every shipped lookup keeps it, and
nothing was converted. `demo` now ships `teams` (Acme > Engineering > Backend) beside the value-keyed
`cities`, which is the pair this entry argues for.

What it cost, against the estimate below: the readers were as cheap as predicted, and the editor was
cheaper than feared because the recursive `ref-node` had already landed — the branch became `isGroup`
(under ids every node is a group, since a row with nothing under it is the one you add the first child
to) plus a row-cell in the activator. `lookupListValues` answers with the VALUE column for an id-keyed
catalogue, since offering row ids in a picker is offering plumbing.

Three decisions worth keeping, because each was a fork:

- **One answer to three failures.** A parent naming no row, a row parented to itself, and a CYCLE all
  end with the node promoted to a root and the bad edge CUT. Cutting matters and walking around it does
  not: a cycle left in the data would recurse the renderer, not merely the walker. The invariant the
  tests hold is the useful one — *every row appears exactly once, whatever the parent column says* —
  because a row that drops out of the tree is invisible in the editor and still in the database.
- **Deleting a node with children is REFUSED, not cascaded.** Cascade-or-re-parent is genuinely open
  (item 5 below), and both guesses lose rows somebody can still see. Refusing leaves the choice with
  whoever empties it.
- **Ordering stayed on the value model.** `position` is one global sequence; item 6 below is unchanged
  and unbuilt.

Known boundaries, none of them load-bearing for the demo: a `ref` column INTO an id-keyed lookup is
untested — the picker's duplicate-value disambiguation labels the parent through `listLabel`, which
under ids would print a row id — and the focus-after-add in `addRefChild` still takes the last matching
cell in the document, which under depth need not be the row just created. `addRefParent`'s equivalent
was scoped to top-level groups, which was a real bug once nesting existed.

#### What `by: "id"` cost, and what is still open

Small, in the readers; the work is in the editor's WRITE paths, which are value-shaped throughout.
Items 1, 2, 3 and 7 landed as written. **Item 4 landed by halves, and item 6 is the reason**: the two
helpers the id path actually calls were branched, and the three that exist to serve the reorder arrows
were not, because an id-keyed lookup renders no arrows to serve. 5 and 6 stay open.

1. **`buildHierarchy` branches once** — index rows by id, hang each row off `row[parent]`, and every
   node then carries a `row`. The editor needs no further change, which is the point of having landed
   it first. *What shipped differs from the guess in the brackets this item used to carry: the branch is
   `byId || !node.row`, not "has children". Under ids EVERY node is a group, a childless one included,
   because that is precisely the row you add a first child to — a leaf with no expander has nowhere to
   put the button.*
2. **Two failures the value model cannot have**, and both must surface rather than vanish: a
   `parent_id` naming a row that is gone, and a CYCLE. A value-keyed tree is acyclic by construction; an
   id-keyed one is not, and a row that quietly drops out of the tree is the worst available outcome.
   Belongs in `scan.js`'s tradition — a tested property of the pure module, not a rendering accident.
3. **The value-keyed write paths do not port; they go dead** — `renameRefParent`'s whole cascade
   (`propagateRefChange` → `_rewriteValueInColumns`, `migrateListTranslation`) exists *because* parents
   are values, and under ids a rename is `saveRefField` on one row. Not shared, not simplified:
   unreachable for id-keyed tables and still required for value-keyed ones.
4. **Four editor helpers key on `node.value`** and need an id branch: `_refGroupRows`,
   `refGroupAtEdge`/`moveRefGroup`, `refParentLocked`, and `addRefChild(parentValue)`, which prefills
   the parent column with a value. `addRefParent`'s focus query (`.ref-hierarchy .v-list-group`, take
   the last) is a fifth, and a nesting-specific bug rather than a value one: under depth, "the last
   group in the DOM" is not "the group just added at the top level".
   *Landed: `refParentLocked` and `addRefChild`, through the node's own `locked` and `childOf`, and the
   focus query, now scoped to `> .v-list > .v-list-group`. NOT branched: `_refGroupRows` and
   `refGroupAtEdge`/`moveRefGroup`, which exist for the reorder arrows — giving them an id branch would
   have been writing item 6's answer before deciding it.*
5. **Deleting a node becomes a question that has no precedent here** — cascade to descendants, or
   re-parent them? `deleteRefParent` deletes by value match today and never had to ask, because a group
   was not a row. Whichever is chosen is one gesture and therefore one `Undo.action`, and the inverse
   has to put the descendants back *where they were*, not merely back.
6. **Ordering changes shape.** `position` is numbered globally across the table (`moveRefGroup`
   renumbers every row, which is why `moveRefChild` renumbers globally too). With depth, order is a
   per-parent fact, and a global sequence stops expressing it.
7. **No new access primitive, and nothing in the rules layers.** A self-referencing column is a plain
   column; rows are rows. Worth stating because it is the one place this feature is cheaper than it
   looks.

This entry kept `by: "id"` unbuilt on the grounds that it would be **a second model with no user**, and
what changed is worth recording rather than quietly deleting: the user turned out to be the demo bundle
itself, which could not show three levels because no schema could produce them. So the acceptance landed
as `teams` — a LOOKUP, not the task/subtask data table this entry guessed at, for the reason in the
section above — rendering three levels in the editor it already had, with the dangling parent, the
self-parent and the cycle each asserted in `buildHierarchy`'s own tests rather than found as a blank
screen.

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

- **Calendars defined in the DATABASE, not the schema** (#176) — a calendar is a row now, so "can we
  have an ushers calendar?" stops being a schema commit. Everything downstream was inherited exactly as
  the proposal predicted: rendering, the `.ics` download, publishing, the window and language settings,
  `embed-view`, and the Settings list, which enumerates `Object.keys(VIEWS)` rather than the nav.
  **The one thing the proposal got wrong was the storage shape.** It asked for a `_calendars` system
  store; `firestore.rules` denies clients every underscore-prefixed collection outright, which is the
  same property the feed's `_checkin` idea RELIES on elsewhere on this page — so the definitions live in
  the folder config instead, beside the per-view settings they sit next to conceptually. Worth keeping
  because the mistake is re-makeable: "system store" and "underscore collection" are the same thought in
  this codebase, and one of them is unreadable by the app on purpose.
  Two things the build added that the entry had not asked for. A schema view of the same name **wins**,
  because silently shadowing one from a config row is how a calendar starts disagreeing with the file it
  appears to come from. And a user-defined calendar may overlay `rotationViews`, which the entry's
  `sources`-only shape had no room for — generated duties draw on the same grid through the matrix's own
  resolvers, so a rotation's `obscureNames` masks names here without the calendar repeating it.
  The permission question the entry said to decide first was decided by `canPublishFeeds()`: publishing
  needs a full-access client, on both schema and database-defined calendars alike.

- **A rotation narrowed to nothing says so** — `rotationColsFor` returned `['_period']` unconditionally,
  so a viewer the narrowing left with no slot got a lone column of dates: a heading with a date list
  under it, which reads as a schedule that failed to load rather than as one that has nothing for you.
  It has a real trigger rather than a hypothetical one — a household member who does chores but is not
  on the duty roster holds no slot, so `mineOnly` matches none of them. It returns `[]` now.
  That alone would have left the section on the page and empty, because the optional-embed `?` could
  never hide a rotation: a rotation generates its periods from the calendar rather than from `sources`,
  so `buildRows` reported ZERO rows for every one of them and `{{view:rota?}}` hid a full matrix while a
  bare embed showed an empty one — the mechanism was inverted, not merely absent. The `view` block's
  `count` asks `rotationColsFor` for a rotation now, so emptiness means "no slot to show", which is the
  same question `mineOnly` and `hideEmpty` already answer, and `docHasData` stops reading a
  rotation-only page as blank. `examples/chores-schema.json` marks its `doc_mine` matrix `?`
  accordingly. The heading above a hidden optional embed still renders — that is how every `?` in the
  shipped examples already behaves, and changing it is a separate question about prose, not rotations.
- **`skipEmpty`** — a roster group that carries nothing (no rows, or every row blank in `valueCol`) is
  left out of the `rotateEvery` swap ring, so a member with no duties stops being handed somebody else's.
  Two restrictions are the design rather than caution. It is **off by default**, because in the
  `slots` + `rosters` form an empty roster states a real thing — *three areas, two crews* — and today's
  ring shares that shortage out fairly; skipping it would starve one area permanently instead. And it is
  **`rosterRef` only**, because there a slot exists solely because a row named it, so an empty group is
  an artifact of a roster doubling as a roll-call; that form is also the only one where `M === N` holds,
  so "the group this slot owns" names one thing — the `slots` form lets rosters outnumber slots, where a
  skip rule needs a second branch to avoid stranding a slot that had a live group available. That
  generalization is declined, not deferred. It pairs with the view-level `hideEmpty` and could not be
  folded into it: `hideEmpty` is evaluated against the generated rows, so one flag would be deciding its
  own input. Implementation is a bare `N` ring becoming an index ring, which reduces to the expression it
  replaced when the flag is off — asserted rather than argued, by a test that runs both settings over a
  roster with no empty group. It exposed one real bug on the way: `cycle` read `groups[0]` for its
  cadence, so a duties-less person sorted to `position: 1` handed it a one-period cycle and quietly
  turned a per-cycle swap into `rotateEvery: 1`; it reads the first RING group now. Also hoisted the
  `rotateEvery` element validation out of the `slots && rosters` branch it was trapped in, which had left
  `rosterRef` — the shape that form exists to replace — accepting any junk there and resolving it to no
  swap at all.
- **Search matches the rendered text**, not only the stored value: `searchRows` takes an optional
  `label(col, value)` resolver and folds what the grid shows alongside what the row holds. A linked
  account's name, a translated list value and a `ref`'s label are all produced by the renderer, so
  without it a reader looking at *Hyväksytty* had to know the row stores `approved`. Additive rather
  than a replacement, so every stored key stays findable and a term may span the pair. That
  deliberately leaves `obscureNames` where it was — display-only privacy over rows the viewer has
  already been served, not an access boundary, and closing the probe would have cost every stored-key
  match to buy nothing. Passed as an argument rather than added to rows.js's runtime-bound globals:
  those exist for values consumed deep in the pipeline, and all three callers of this one are in
  app-core, so the dependency stays visible at the call site.
- **Empty groups** — `groupBy.seed` (rows.js) + `stats.rowTiles.skipUntargeted`, the other half of
  per-row goals. `aggregateRows` built its groups from the rows it was handed, so a chore nobody had
  done had no group and no tile — precisely the chore a reminder exists for. It seeds the key set from
  the CATALOGUE the group column references instead: `chore_cadence` went from nine tiles to twelve,
  and the three nobody had done now lead its `order: "behind"` list at 0%. An empty bar was the whole
  feature; a missing bar was the bug.
  Every decision the entry had argued down held. `seed: true` rather than `seedFrom: "ref_chores"` —
  it reads the column's own `ref` declaration, so the table is not named twice and the two cannot
  disagree, which is the failure the `hierarchy:` fix was written to end. `ref` columns only, reported
  at LOAD rather than quietly doing nothing on a `select`. The target gate under its own name, dropping
  in `stats.js` where the row and the resolved goal are together, so `rows.js` never learned what a
  goal is — which is what makes the seeded set self-maintaining: retiring a chore is clearing its
  target in the Lookup tab, with no schema edit. And zero tiles are not hidden: for this view the zeros
  ARE the output, and `order: "behind"` (shipped first, on purpose) already had a place to put them.
  Four things the build settled that the entry had not. **`aggregateRows` needed a context**: it was
  pure over `(view, rows)` and the key set lives in the row cache, so it now takes the same ctx object
  `resolveComputed` was already being handed — which collapsed three inline copies of that object into
  one per call site. The schema half goes through the runtime-bound `getColumnRef` global, the seam
  `sortByCol`'s list order already used, so rows.js still holds no schema of its own. **`groupBy.filter`
  has to gate a seeded key exactly as it gates a counted one**, or a group the filter excluded would
  come back as a zero; making that one `keyOk` predicate retired the duplicated synthetic-row idiom
  beside it. **An archived catalogue row is not seeded** — a retired row that was filed rather than
  deleted must not reappear as an empty bar. And **`skipUntargeted` reads the RESOLVED goal**, so the
  `default: 0` a computed lookup falls back to is dropped alongside a blank one; both mean nobody set a
  cadence, and a zero goal draws no bar either way. No new load path was needed: the catalogue is the
  `ref` target of a source column, which `Columns.defTables` already names as a dependency.
  Two things the entry recorded are unchanged and still open. `groupBy.having` — a real predicate over
  an aggregated row — remains a genuine gap, and was deliberately not built as this one's excuse. And
  zero is honest for `count`/`sum` only: if `avg`/`min` ever join the aggregate pipeline, a seeded key
  wants `null` there rather than a zero that would read as a measurement.
- **`order: "behind"`** — a `rowTiles` board sorted by how much of its OWN goal each tile reached,
  against the default ranking's "who is winning". The reason it is a `stats` key and not a
  `defaultSort` is that the number it sorts on does not exist as a column: `pct` is computed after the
  goal resolves, and `computed` has no arithmetic to build one. That turned out to be the feature
  rather than the obstacle — `defaultSort` cannot reach it, so the two orderings cannot disagree about
  one view, which is what #180 spent four inline copies of a roster order learning. Two decisions
  worth keeping: it sorts on the RATIO, since a shortfall (`goal - value`) is dominated by whichever
  row carries the biggest goal and puts every row back on one scale; and a tile with no goal sorts
  LAST, because absent means unmeasured rather than zero — the same rule a missing `position` follows.
  `limit` moved to the end of the pipeline so it means "the first N of the order asked for", which
  changed nothing for the default order and made "the five most neglected" expressible at all.
- **A goal each row carries** — `goal: { "column": "<col>" }` on `rowTiles`, plus the shipped
  `chore_cadence` view reading `ref_chores.target_per_month`. One view now holds "bedding once a
  month" beside "wash up daily", which no single `goal` could express. The proposal argued for a
  separate `goalFrom` key on the grounds that a bare column name is indistinguishable from the literal
  `"max"` — true of a *string*, and the reason it shipped as an OBJECT instead: `stGoalOk` already
  dispatches on type, so a fourth shape cost one branch and spent no new key, and no precedence rule
  had to be invented for a view that set both. It resolves where the row is still in hand and becomes
  a plain number, so `"max"`, the ladder and the pct/over arithmetic never learned about it. Shipped
  knowingly partial — a chore with no rows still produced no tile — and *Empty groups*, above, is the
  half that closed it.
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

- **One roster instead of a list beside it** — renaming `ref_duties` to `ref_members`, pointing
  `listSources` at it and deleting the `members` list, so the duty roster doubles as the household roll.
  Declined on the answer to the question the proposal was waiting for: **a parent does chores but is not
  on the duty roster.** That makes the roster a deliberate SUBSET of the membership, and the two are then
  not one list maintained twice — which was the entire premise. `ref_duties.person` is already
  `{ list: "members" }`, a foreign key into the roll rather than a copy of it, so the subset relation is
  the thing the current shape exists to express. Merging would delete that and make you rebuild it from a
  placeholder row plus `skipEmpty` plus `hideEmpty`: three mechanisms to reconstruct what one reference
  gives for free, and a schema in which "is a member of this household" and "is in the duty rotation" can
  no longer be said apart.
  Worth keeping from the investigation, because none of it depended on the merge going ahead. A `list:`
  may already name a LOOKUP TABLE (`lookupListValues`), and every part of the userlink machinery keys on
  a bare name string — `listSources`, `_list_users`, `isUserLinkList`, `meValueForList`, and the rules'
  `identityList` — so a table-backed identity source is a coherent schema against today's code. What
  stops it is that the link PICKER renders only in the Lists tab, gated on `canEditList`, which returns
  false for a lookup by design; that a lookup rename calls `propagateRefChange` and
  `migrateListTranslation` but not `migrateListUserLink`, so the account link is silently orphaned; and
  that modelling the column as `ref:` rather than `list:` empties `identityList` and `stampedOf`, which
  short-circuits `ownerIdentityOk` permissive and unbinds the stamped column. That second one is a real
  bug on the shipped `userlink` path today, independent of any of this, and is worth fixing on its own.
  Two consequences of the answer that DO need acting on, and are not about the merge: identity is 1:1
  (`_list_users` is keyed `list~value` and `_mirrorIdentity` clears a value from whoever held it before),
  so two parents who both log chores need two member values rather than a shared "Parent"; and a
  non-admin parent holds no slot, which is what the empty-`mineOnly` fix in Shipped is for.
- **Bundling a charting library.** Incompatible with the no-build constraint (static files, CDN Vue,
  no bundler) and with the CSP. The supported answer is the Vuetify primitives already loaded, plus
  inline SVG and the existing `hashColor` where a real mark is needed. `stats` shipped on
  `v-progress-linear` and pulled in nothing — which is the evidence this trade is affordable.

## Suggested order

TWO entries here are PARTLY built, and that matters because a half-built mechanism is the only thing on
this page that can mislead: it looks finished from the outside. Only one of the two is ranked. **Scan**'s
remainder is, and leads the list below, because it is cheap and its shipped half points at it; `tree`'s
is not, for the reason given beside `gallery` further down — what is left of it is two questions nothing
has asked rather than work waiting to be done.
(Undo/redo was a third, and led this list on merit rather than on cheapness until its value cascades
shipped — see its entry above, which is kept in place rather than reduced to a Shipped bullet because
the reasoning behind what landed is the same document as the reasoning for the rest of it.)

**Scan phase 1.5** — check-in as config (`match: "owner"` + `codeCol`) — is the cheapest unbuilt thing
on the page, a resolver branch and a test, and it is what turns the shipped scan view into the QR
check-in entry above. Worth doing only when somebody actually wants the verifier-scans-attendee
arrangement; it is not owed to the shipped half.

Then `gallery`. `tree` has since shipped in the only form that was worth building: the editor's
recursion, and `hierarchy.by: "id"` for tables that want depth, with the value-keyed lookups left
exactly as they were. What remains of it is two questions nothing has asked yet — what deleting a node
with children should do, and how order works within a level — and both are recorded in its entry rather
than ranked here. (`.ics` export, `timeline`, `stats`, the scan family and *Empty groups* were each
first here in turn, and have shipped.)

**A correction worth leaving visible.** An earlier pass of this section ranked the feed and
database-defined calendars as the next things to build, and recorded four "decisions" about how to
build them. Both had already shipped — #174 and #176 — and the entries had simply never been moved out
of *Proposed*. Three of the four decisions had been answered by the code, one of them (revocation by
blanking rather than deleting) better than the answer written here. The fault was reading this file as
the state of the repo. **It is a record of reasoning, not an inventory**, and an entry left in the wrong
section is the one failure mode it has: a stale proposal reads exactly like a live one. The heading
convention at the top of this file exists for precisely that, and is now applied to the feed.

**What remains of the feed is the per-person half, and it is genuinely unbuilt.** It is not ranked in
the line above, because it is not the same kind of work as the features in it. Shared-content feeds were
pre-render, upload, serve. Per-person feeds make `@me` an ACCESS boundary rather than a display filter —
the one thing on this page that fails by LEAKING rather than by disappointing. Anyone picking it up
should read *Per-person feeds — the plan* before estimating, and should treat `validateSchema`'s current
refusal of `@me` feed sources as the thing being deliberately replaced, narrowed rather than deleted.

The RSVP attendance pattern is not in that order because it is not code — it can be authored into a
schema today.

`groupBy.having` (recorded inside *Empty groups*, in Shipped) is unranked on purpose. It is a genuine
gap — there is no predicate over an aggregated row — but it was named there to stop it being built as
that feature's excuse, and nothing has asked for it since.
