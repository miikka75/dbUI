# Roadmap

What is proposed, partly built, or declined. A proposal is written here before it is built. Once it ships
it becomes one line under **Shipped**; its reasoning lives in the PR. A declined idea keeps its reason, so
it is not proposed again.

## Adding a view kind

Every kind since `pivot` has cost the same five things:

1. A pure engine module (`pivot.js`, `board.js`, `form.js`), Node-tested.
2. A registered component and a `VIEW_KINDS` entry in `app-core.js`.
3. A classifier in `SchemaNormalize.viewKind` and the `_flattenViews` gate.
4. `schema.schema.json` and the `validateSchema` errors.
5. `dev/test/<kind>.test.js`.

Embedding is free: `embed-view` dispatches on the same classifier, so a new kind works inside
`{{view:x}}` with access gating, `?` hide-when-empty and printing.

## Open

### Code review 2026-11-01: what is left

- **Retire `app-core-fn.js`** (finding 8). 28 root members are still tested by slicing them out of the
  source. Move each one's pure part to its module, as #328 did for the grant chips; done when the helper
  has no callers.
- **Split `app-core.js` by file** (finding 9). `methods` is ~540 members in one object. One file per
  cluster (calendar + feeds, rsvp/scan, embeds/pages, data loading, cell edit + permissions, ref/list
  editors, users/profiles/assets, import/export, theme/print), each a methods object merged into the
  root, moved verbatim. The duplicate-key and dead-method guards then span the files.
- **Clearing a member's last table chip saves `'all'`** (full access) when they have no view-only
  grants. Pinned by a test as intended; worth a decision, since removing access grants it.

### Reminders and notifications (Supabase only)

Telling someone about a row while their app is closed: a class in two hours, a waitlist place they were
just given. Needs a sender that runs with no browser open: on Supabase, `pg_cron` + `pg_net` calling an
Edge Function, on the free plan, like `supabase/functions/csp-report`. Firebase needs Blaze; the
in-browser backend sends nothing; the dev server logs what it would send, for tests.

- **Schema**: `"remind": { "at": "starts_at", "before": "2h", "to": "owner", "text": "text.class_soon" }`
  on a table. `to` is an `owner` column or a `userlink` list column. Server events (waitlist promotion,
  an approval) write the same outbox from their trigger.
- **Delivery**: an outbox table; cron every 5 min → the `notify` function sends what is due, marks it
  sent, retries a few times. Before sending it checks the recipient may still read the row.
- **Opt-in**, per person and channel, in Settings → My profile; nothing is sent by default. The text is
  the view name and the row's title, nothing the recipient cannot see in the app.
- **Channels, in order**: (1) Web Push: a VAPID key pair, `push` and `notificationclick` in `sw.js`
  opening `?view=`; on iPhone only for the installed app. (2) Email through a provider's free tier, with
  a verified sender domain and an unsubscribe link. Telegram, SMS or WhatsApp only if asked (SMS and
  WhatsApp are paid per message); Signal has no bot API.
- No CSP change: the browser talks only to its own push service.

### Gym example: what is left (only if asked)

- **Waitlist on Firestore.** Supabase promotes in a trigger; Firestore has no server code. Options: a
  Cloud Function (Blaze plan), a queue on the class row, or staff promoting by hand.
- **Time of day in `stats`** (night-owl, early-bird): a `computed.hourOf`.
- **A per-viewer "my gym" choice**: a viewer-chosen value for one `@` token (`"gym": "@chosen"`),
  display-only like `@me`. Medium.

### Scan: phase 5 (on demand)

`then: "edit"` (hand the new row to a `form`), a batch session with a correctable list, and a `geo`
stamp. Each is a small addition to the existing shape.

### Registering at the venue: option B (only if A is not enough)

The venue tablet stays signed in as a kiosk and shows a QR naming a fresh session; the member's phone
unlocks it.

### Comparing statistics: a period per row

Rows of picks are saved and shared (steps 1–2). Next: each row can carry its own period.

### `tree`: two questions nothing has asked yet

- **Deleting a node with children**: cascade or re-parent. One gesture, one `Undo.action`, and the
  undo puts the descendants back where they were.
- **Order within a level**: `position` is numbered across the whole table; with depth it is per parent.

### Board: dragging cards on a phone (low priority)

Native drag barely works on touch; a phone moves a card only by its arrows and menu.

- Long-press (~400 ms) lifts the card; a few pixels of movement first stays a scroll.
- The drop target comes from `elementFromPoint`, through the desktop path (`placeCard` → `boardPlace`).
- Edge scroll within ~60 px of the viewport edges.
- Own touch handling, not SortableJS (which fights Vue's render and is a new vendor file).
- Tested with Playwright touch emulation.

### Prose that names its rows

A per-row template beside `markdown`, rendered once per matching row in place of the grid:
`"rowMarkdown": "{{t:text.ordination_line}}"`, with the sentence in the Languages tab ("We propose that
**{{person}}** … be ordained a {{calling}}.").

- **Grammar is the hard part.** Finnish inflects the office, English needs *a*/*an*. Either phrase
  templates around it, add inflected forms as translations (`list.callings.priest#gen`), or accept that
  some languages cannot use it. Decide before building.
- **Access**: each value goes through the cell renderer, so `obscureNames` and access gating still apply.
- Cost: a branch in the read-only data path and in `print.js`, a `schema.schema.json` property, a
  `validateSchema` check that every `{{col}}` exists, a test. Not a view kind.

### Small layout follow-ups

- `split`: a deep link to the open row, arrow keys through the list, a draggable divider.
- `browse`: tile images (cover art), only if asked.
- `groupBy.having`: no predicate over an aggregated row yet.

### Not started

- **`feed`**: a reverse-chronological activity stream; pairs with an audit trail if one is added.
- **New column types**: `geo` (needed by `map`); `richtext` (the markdown renderer seam may cover it).
- **`map`**: last on purpose. It would be the first view needing an external tile provider: a new CSP
  origin, a third party at render time, and no offline.

## Shipped

### Code review 2026-11-01 (#313–#328)

- A refused write says "Save failed"; page saves keep the editor open until stored (#314).
- supabase-js and the Firebase SDK vendored and SRI-pinned; gstatic out of the CSP (#315, #317).
- The dev server refuses cross-site requests (#316).
- Eleven dead root methods deleted, with a guard (#318).
- Every pure module typechecked, with a scope guard (#319).
- One helper for viewer preferences; `app_mode` only through `Databases` (#320).
- `validateSchema` in its own tested module, `schema-validate.js` (#321).
- Firebase runs the shared `backend-kv.js` contract (#322).
- Deploys publish an allowlist (`_site/`, `scripts/build-site.js`) (#323).
- App scripts minified at deploy; CI tests the published build (#324).
- A caching service worker: repeat visits download nothing, the app boots offline (#325).
- Templates precompiled; the published page runs without `'unsafe-eval'` (#326).
- Labelled ref cells look rows up by index, not by scanning (#327).
- The grant-chip rules in `access-features.js` (#328), the first cut of retiring `app-core-fn.js`.
- Shorter docs (this change).

### Code review 2026-09-22

- `copyText` was defined twice; the survivor now reports a failed copy.
- Raw control bytes removed from `rows.js`, `pivot.js` and the CSP collector.
- The deployed site got an enforcing CSP, and violation reporting (Settings → Security policy reports,
  `npm run csp:log`), with a rotatable read token.
- One answer to "what kind is this view?" (`SchemaNormalize.viewKind`); the `isUnionView` stub deleted.
- `app-core.js` extractions: `brand.js`, `reorder.js`, the ref editor's deletes, `profiles.js` +
  `images.js`, `bundle.js`, the feed publisher.
- View components that declare what they need: the calendar, the shared UI elements, pivot, timeline,
  stats and rotation take services through `inject`.

### Features

- **Views**: `rotationView`, `calendar` (+ year, week, agenda), `pivot`, `rsvp`, `board` (lanes, card
  order, compact cards, folding lanes), `form`, `timeline`, `stats` (tiers, series, streaks, a goal per
  row, `order: "behind"`), `scan` (phases 1–4: typed or scanned codes, printed labels, the phone camera
  via `?scan=`, the in-app scanner), the `gallery` and `split` layouts.
- **Calendars**: calendars defined in the database (#176); `.ics` export; subscribable feeds, shared
  (#174) and per person, with the orphan sweep and storage rules; reports that follow the calendar's period.
- **Columns**: `image` / `url`, `datetime`, computed columns, reference paths, counting related rows,
  `rosterRef`, `listFilter`, `skipEmpty`, `stamped`, `picker: "cards"`.
- **Lookups**: one declaration for a hierarchy; `tree` rendering and `by: "id"`; a linked position shows
  its role beside the name; sorting inside an embed and a `ref` that knows its order (#233).
- **Data**: undo/redo for cells, rows and value cascades; `archiveAfter` by the row's own date;
  copying events forward; leftovers (data the schema no longer names) in a badge and a Settings report;
  sample rows that stay current (`asOf`); export of members; structure separable from data.
- **People and access**: callings as identity; membership requests and `newUser`; open sign-up, public
  tables and member-only pages; sign-in without Google, verified emails only; staff who are not admins
  (nav `roles`, `requiresGrant`); one identity per row, membership before booking.
- **Gym**: self-service tables' lists readable; check-in without a press; capacity (both backends);
  no-show release; waitlist (Supabase); my upcoming bookings + add to calendar; one scan button and a
  rotating door code; the desk (walk-ins, arrivals); rewards only when covered; pausing a membership;
  periods that refuse or last; a log of the recent past; a folded embed (`preview: N`); my calendar as a
  feed; streak coins; a kiosk code screen with a PIN; rooms per gym.
- **RSVP**: attendance verification; QR check-in with the organizer's shared, rotating code (#265);
  registering at the venue with a QR (option A, #265).
- **Navigation and look**: `nav.layout: "browse"` (#230); one Appearance editor for icon, image and
  background (#231); comparison rows shared with the page.
- **Search and display**: runtime search over the rendered text; empty groups; a rotation narrowed to
  nothing says so; one date format in the grid and the calendar.
- **Setup**: `npm run check:live` and `npm run supabase:setup` for a fresh Supabase project.

## Declined

- **One roster instead of a list beside it.** A parent does chores but is not on the duty roster, so the
  roster is a subset of the membership, which `ref_duties.person = { list: "members" }` already says.
- **Bundling a charting library.** Breaks the no-bundler setup and the CSP; `stats` shipped on Vuetify
  primitives and inline SVG.
- **Injecting services into `board-view`, `embed-view` and `data-cell`.** They read 19–28 root members
  each: they are the editing surface, and a service per call site would only move the coupling.
  Reopens if a second host needs to edit rows.
- **Scan check-in as config (phase 1.5).** Built and withdrawn (#264); members check in with the
  organizer's shared code instead. The verifier-scans-attendee arrangement was dropped with it.
- **Moving the string templates into `ui.html`** (code review 2026-11-01, 4a). Not needed to drop
  `'unsafe-eval'`: the build compiles them where they are.
- **Gym features that need a server we do not have**: opening the gate, payment, device step sync.
  (Push notifications moved to **Open**: Supabase Edge Functions are that server.)

## Suggested order

1. The two code-review follow-ups (retiring `app-core-fn.js`, splitting `app-core.js`), in small PRs.
   The split goes when few PRs touching `app-core.js` are open.
2. A decision on the last-chip grant.
3. Reminders and notifications: push first, then email.
4. Everything else under **Open** waits for someone to ask.
