# dbUI App

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Four backends**: In-browser Postgres (PGlite in IndexedDB — no account, no server, nothing to install), Supabase (Postgres + RLS), Firebase (Firestore), Dev Server (PGlite — runs the *real* `supabase-schema.sql` policies locally)
- **i18n**: multi-language with auto-generated translation keys from schema
- **Views**: flat union, join, and aggregate views, plus **rotationView** (generated rotating roster), **calendar** (month/week/list), **pivot** (cross-tab grid), **rsvp** (self-service signup sheet), and **board** (kanban — group a table's rows into lanes by a `select` column; drag a card between lanes to write that column); columns can embed named views/inline tables
- **Rotating rosters**: `multiselect` columns hold a group of people; rotation tables cycle a group per occurrence (tied to another table's rows) or per calendar interval (`daily/weekly/monthly/yearly` or `<n><unit>` like `3w`), with the anchor stored as editable data
  - **Occurrence rotations & archiving**: an occurrence rotation assigns each row a roster slot by its rank among the occurrence rows (e.g. ushers cycling through meetings). The rank counts both **active and archived** occurrences, so **archiving** a past occurrence leaves every remaining assignment anchored to its date. **Deleting** an occurrence, however, removes it from the count entirely, so later occurrences shift up a slot. Archive occurrences that happened; reserve delete for genuine mistakes.
- **Self-service RSVP**: an `rsvp` view is a read-write signup sheet where each member toggles their own attendance; backed by the `owner` column type (auto-stamped current-user email, read-only) + per-row Firestore rules, so a participant writes only their own row without a table grant
- **Documents**: a view with `markdown` is an editable document with interactive embeds (`{{view:x}}`, `{{self}}` for its own grid, `{{view:x?}}` hides when empty) — bodies stored on the server, not in the schema
- **Theming**: an optional `schema.theme` sets a brand palette (light/dark colors); an admin **Settings → Theme** editor tweaks it live (per-role pickers + paste-a-palette) and auto-saves, driving all Vuetify accents + the PWA/splash colors
- **Nav**: explicit sidebar tree with drawer/tabs layout and nested groups
- **Print**: layout-aware printing (table or card mode), per-card print, embeds included
- **Responsive**: auto-switches between table and card layout based on column count; mobile gets a bottom navigation bar (`nav.bottomNav`) + floating add button
- **Installable (PWA)**: web manifest + service worker → install to home screen / desktop and run in a standalone window (no address bar). Name, icon, and theme color follow the schema and the live light/dark theme
- **Validation**: schema validated at boot time with error reporting

## Backends

| Backend | Storage | Auth | Offline | Real-time | Setup |
|---------|---------|------|---------|-----------|-------|
| **In this browser** | PGlite (WASM Postgres) in IndexedDB | none — a self-asserted email | ✅ (it *is* local) | n/a — one tab | none |
| **Firebase** | Firestore | Firebase Auth | ✅ | ✅ Instant | Firebase Console — see **[FIREBASE.md](FIREBASE.md)** |
| **Supabase** | Postgres (`kv` table + RLS) | Supabase Auth (Google) | ❌ | ✅ Realtime | Supabase dashboard — see **[SUPABASE.md](SUPABASE.md)** |
| **Dev Server (PGlite)** | PostgreSQL-in-WASM | Trusted `X-User` header (loopback only) | N/A | ✅ SSE | `npm start` |
| **Dev Server (SQLite)** | SQLite | **none — every request permitted** | N/A | ✅ SSE | `npm start -- --sqlite` |

Each hosted backend has its own end-to-end guide — see **Quick Start (a hosted backend)** below.
Writing a new backend is a different document: [BACKEND_API.md](BACKEND_API.md) is the contract every
adapter implements.

## Quick Start (nothing to install)

Open the deployed app, pick **In this browser**, and you have a working database. There is no account to
create, no server to run and nothing to install: PostgreSQL compiled to WebAssembly starts inside the
tab, its cluster is persisted in IndexedDB, and `supabase-schema.sql` — the same policy file a Supabase
project runs — is applied to it. So the access model is not simulated here; it is the production one,
evaluated by a real Postgres.

The one thing that is *not* production-grade is the identity. It comes from `localStorage`, typed in on
the setup screen, and nothing verifies it — you can act as anyone and rehearse exactly what a viewer, an
editor or a stranger would see. That is safe precisely because the database is in your own browser and
belongs to you; the moment a second person is involved, deploy the same app against Supabase or Firebase,
where the same policies judge a signed token instead.

Worth knowing before you rely on it:

- **First start downloads ~17 MB** (the WASM engine plus its Postgres data image) and takes a few
  seconds; after that it is quick and works offline.
- **The data lives in this browser**, and another device sees nothing. Use *Settings → Export* for a
  copy — and *Settings → Import* to move it into Firebase or Supabase later.
- **The browser can delete it without asking.** Origin storage is "best-effort" by default: every engine
  evicts least-recently-used origins when the device runs low on space, and WebKit also clears
  script-writable storage for sites that go unvisited for a while. The app therefore calls
  `navigator.storage.persist()` on boot, which moves the origin to *persistent* — after which only the
  user deletes it. Browsers decide differently whether to grant it: Chrome and Safari from engagement
  heuristics (installing the app as a PWA is the reliable one), Firefox by asking. *Settings → Local
  database* shows which mode you got, how much space is used, and offers to ask again. Export anyway.
- **One tab at a time.** Two tabs writing one IndexedDB cluster corrupts it, so a second tab takes a Web
  Lock, fails to get it, and says so rather than opening.
- **Self-hosting it wants the vendored dist.** `vendor/pglite/` is generated, not committed — run
  `./update-vendor.sh` (or `scripts/vendor-pglite.sh`) locally; the GitHub Pages workflow materialises it
  on every deploy. If it is missing the app falls back to jsdelivr, the same way Vue and Vuetify do, so a
  fresh fork still boots — but self-hosted stays the intended path, because reaching a CDN is the one
  thing this mode otherwise never does.

## Quick Start (Local Development)

```bash
cd dev
npm install
npm start        # http://127.0.0.1:3000
npm test         # run backend unit tests
npx playwright test  # run E2E tests
```

**The dev server runs the production access policy.** `npm start` boots PostgreSQL compiled to
WebAssembly and applies `supabase-schema.sql` — the same file Supabase runs — so a permission question
is answered in dev exactly as it is in production, rather than by a hand-written imitation of it. It
costs a few seconds of startup.

`npm start -- --sqlite` (or `--fs`) opts out for speed — but those backends have **no access policy at
all**: every request is permitted, and the server says so loudly on startup. The access model used to be
re-implemented here in JavaScript so that dev behaved like production; running the real policies made
that copy redundant, and it has been deleted rather than left to drift. Use the default whenever the
question is "can this member actually do that?".

Browser: click "Create Local Database" → app loads with the schema from
[`examples/demo-schema.json`](examples/demo-schema.json). Optionally run `npm run seed:import` (with the
server running) to layer the demo data — rows, lists, translations, rotation config, plus example
users/profiles — on top of it. The importable parts live in `examples/demo-data.json` and
`examples/demo-lang-<code>.json` (the same bundle shape as Settings → Import, and the same three files
the in-app example picker installs). Its dates are fixed in the file, so the demo's "this week" and
"upcoming" drift as it ages — edit `examples/demo-data.json` when that matters, then re-run
`node scripts/examples-manifest.js`.

**Reset**: delete `dev/local.db*` and `dev/*.pgdata/` + browser `localStorage.clear(); location.reload()`

> The PGlite default starts from an empty database; an existing `dev/local.db` is not migrated. Nothing
> is lost — the demo content lives in the repo, so `npm run seed:import` rebuilds it.

**A second, isolated instance.** `PORT` alone is *not* isolation — every dev server shares
`dev/local.db`, so a reset on one wipes the other. Point `APP_DB` at another file to get a genuinely
separate database, and its user registry / requests / profiles follow it as
`<name>.users.json` and friends:

```bash
APP_DB=chores-demo.db PORT=3200 node server.js     # own DB + own sidecars, dev/local.db untouched
APP_DB=:memory: PORT=0    node server.js           # throwaway; PORT=0 = any free port, printed on boot
```

The startup banner prints the database actually in use, so you can confirm which one you are on. An
empty database offers the shipped examples on its first screen — pick one and it installs, no files to
download (Settings → Examples reopens the picker). Settings → Import JSON still takes a bundle of your
own; see [examples/README.md](examples/README.md).

## Quick Start (a hosted backend)

Both hosted backends follow the same three beats — create the project, publish the access policy, then
paste the project's public config into the app's setup screen and sign in. **The first account to sign
in becomes the admin**, so do that yourself immediately after publishing the policy; until you do, the
database is open to whoever gets there first.

The setup itself is per-provider, and each guide carries it end to end rather than a summary here:

- **[FIREBASE.md](FIREBASE.md)** — Firestore + Google auth, publishing `firestore.rules`, linking a
  clone with `firebase use --add`, why a bare `firebase deploy` fails on the free plan, and the Firefox
  third-party-cookie problem with Google sign-in.
- **[SUPABASE.md](SUPABASE.md)** — Postgres + Google auth, the OAuth redirect URIs, running
  `supabase-schema.sql`, which project key to paste, hosting on GitHub Pages, and how each Firestore
  rule maps to an RLS policy.

Then fill the database: pick one of the shipped examples on the empty-database screen, or
Settings → Import from JSON for a bundle of your own.

## Sharing & Access

### Shareable Links (URL params)

Share a pre-configured link so new users connect instantly without manual setup:

```
# Firebase
https://your-app.github.io/?mode=firebase&config=BASE64_ENCODED_CONFIG

# Supabase
https://your-app.github.io/?mode=supabase&url=PROJECT_URL&key=PUBLISHABLE_KEY
```

The app reads URL params on load, stores them in localStorage, then cleans the URL. One click = connected.

> Firebase links also accept the config as discrete params instead of base64:
> `?mode=firebase&k=<apiKey>&p=<projectId>` (with optional `&d=<authDomain>`). `d=` is
> **optional** — it defaults to `<projectId>.firebaseapp.com` (the standard Firebase auth
> domain), so it's only needed for a custom/non-default `authDomain`.

Generate the link from Settings tab (shown under "Share link" for Firebase mode).

### User Access by Backend

| Backend | How to add users | Admin UI? |
|---------|-----------------|:---:|
| **In this browser** | Settings → User Access panel (identity is self-asserted — see below) | ✅ Yes |
| **Firebase** | Settings → User Access panel | ✅ Yes |
| **Dev Server** | Settings → User Access panel (test with `?user=`) | ✅ Yes |
| **Supabase** | Settings → User Access panel | ✅ Yes |

### User Registry

Any backend defining `backend_users` gets built-in user access control (Settings → User Access):

1. **Bootstrap mode**: first user auto-registered as admin
2. **Add users** inline (click +, edit email/role/tables in-place)
3. **Roles**: admin (manage schema/users/translations + all tables), editor (read+write allowed tables + edit allowed lists), viewer (read-only)
4. **Per-table access**: two chip columns per user — *Tables* (can edit) and *Can view* (read-only:
   visible in the nav, rows load, every cell renders read-only, no add/delete). Or "All".
5. **View filtering**: views are only visible if user has access to ALL source tables
6. **List filtering**: editors see only lists used by their allowed tables; editing a list needs *write*
   access to an owning table
7. **Security Rules** (`firestore.rules`): enforces roles + per-table access server-side. Deploy once.

Local dev: test access control with `http://localhost:3000/?user=editor1` (user must exist in registry).

Firestore document structure (`_users/<email>`, mirrored into the legacy `_meta/users` map):
```json
{
  "user@gmail.com":  { "role": "admin",  "user": "user@gmail.com",  "tables": "all" },
  "other@gmail.com": { "role": "editor", "user": "other@gmail.com",
                       "tables": { "tasks": "rw", "notes": "rw", "price_list": "r" },
                       "rwTables": ["tasks", "notes"] }
}
```
`tables` may also be a plain array of names (the older shape — read + write on each); it keeps working
unchanged, so no existing deployment needs migrating. `rwTables` is a denormalized copy of the writable
subset that the rules read, written automatically alongside the grant.

### Multi-Database (Single Deployment)

One hosted instance serves multiple independent databases:
- Each user enters their own connection details during setup
- Details stored in browser localStorage (per-origin)
- Different users on the same URL can connect to different Firebase or Supabase projects
- Share a pre-configured URL to onboard users to a specific database

## Installable (PWA)

The app is a Progressive Web App — installable to a phone home screen or desktop, running in a
standalone window with no browser address bar.

- **Static manifest** (`manifest.json`) + `<link rel="manifest">` in `index.html` provide the
  baseline name/icons/`display: standalone` before the app boots.
- **Runtime manifest**: once the schema loads, `_updateManifest()` rebuilds the manifest with the
  live **app title** (per-database name) + theme colors and swaps in a Blob URL.
  `id`/`start_url`/`scope`/icon `src` are written as **absolute** URLs (a Blob-URL manifest can't
  resolve relative paths) — which is also why a relative `schema.icons` path is fine to *write*: the
  app resolves it against the deployment root before it reaches the manifest. `background_color`/`theme_color` follow the current Vuetify theme; a
  dynamic `theme-color` meta tracks the in-app light/dark toggle. The runtime manifest's install
  icons come from **`schema.icons` when set, else the bundled static files** (below).
- **Service worker** (`sw.js`): minimal pass-through `fetch` (no offline caching) — its purpose
  is to satisfy the browser installability check so the install prompt appears reliably.
- **Per-database icons via `schema.icons` (optional).** All three icon surfaces — tab favicon,
  apple-touch tile, and the manifest install icon — are driven from the database schema, so one
  deployment serving several databases gives each its own. The fields, defaults and authoring advice
  are in [SCHEMA.md → icons](SCHEMA.md#icons-title); any field you omit falls back to the bundled
  static file below, so a deployment can mix or skip `icons` entirely.

  What the **browser** requires, which is what makes this a PWA note rather than a schema note:

  - The manifest **install** icon must be a **square raster PNG** ≥144px. An SVG, or `sizes: "any"`,
    is skipped for install — fine as a `favicon`, useless as a home-screen tile.
  - It must end up at a **network URL**. Relative paths are fine to write (the app resolves them), but
    a `data:` or `blob:` URI is not: Chromium's manifest-icon downloader runs outside the document and
    cannot fetch renderer-minted URLs — both log *"Icon … failed to load"*. A real cross-origin URL
    works, including one on another host: icons are exempt from the same-origin rule that binds
    `start_url`/`scope`, which is what makes this usable when Firebase holds the database and the app
    is hosted elsewhere.
  - Production must be **HTTPS→HTTPS**: a cross-origin `http:` icon on an HTTPS page is
    mixed-content blocked.

  > The E2E suite verifies the manifest and `<link>` tags carry the right URLs, and that the browser
  > fetches and decodes a cross-origin PNG through the same no-CORS path the install downloader uses.
  > Headless Chromium does **not** run the desktop install-icon download itself, so confirm the real
  > install icon once in Chrome → DevTools → Application → Manifest.

### Bundled static icon files (default / fallback)

When `schema.icons` is absent, or a field is omitted, the app uses these files shipped **at the deploy
root** next to `index.html`. The host must serve them with correct image MIME types.

| File | Size | Purpose |
|------|------|---------|
| `favicon.svg` | any | browser-tab favicon (`<link rel="icon">`) |
| `icon-512.png` | 512×512 | apple-touch-icon + manifest install / splash / maskable icon |

Both are the generic dbUI mark — Material Design Icons' `database-eye` on a transparent background —
so an unbranded database looks like the app rather than like whichever schema happened to ship its
artwork at the repo root. To brand ONE database prefer `schema.icons`; replacing these files changes
the default for every unbranded database at once, which is right only when the whole deployment is a
single product. [SCHEMA.md → icons](SCHEMA.md#icons-title) covers the trade-offs, including why the
transparent default can look different on each Android launcher.

Regenerate a square PNG from any SVG with the Chromium the E2E suite already ships:

```bash
node dev/make-icon-png.mjs favicon.svg icon-512.png 512
```

It renders full-bleed and inset to the inner 80%, because the manifest declares
`purpose: "any maskable"` and a round launcher crops to that.

- **Requirements**: install needs HTTPS (Firebase Hosting provides it), a valid manifest, and icon
  files that are reachable and served as `image/*`.

## Caching

The app is a set of separately cached files that have to come from the same deploy: `index.html` names
the module list, `ui.html` holds the templates, and `app-core.js` holds the state those templates bind
to. On a default `max-age`, each expires on its own clock — so for as long as that lasts, a returning
visitor can hold a **new template bound to an old instance**, which fails on the first render and is
not fixed by reloading, because each file is individually still "fresh".

`firebase.json` therefore serves the app's own sources (`*.html`, the root `*.js` and `*.json`,
`firestore.rules`, `supabase-schema.sql` and `examples/**`) with `Cache-Control: no-cache` — revalidate,
not "don't cache": the browser keeps the bytes and Hosting answers `304` when nothing changed.
`vendor/**` is left on the default, since those change only on a deliberate dependency bump.

> **GitHub Pages cannot set headers.** It serves everything with `max-age=600`, so that deployment keeps
> a ten-minute window after each push where a visitor can pick up a mixed set. A hard reload clears it.

## Content-Security-Policy

The app ships a CSP built in **`/csp.js`** (one source of truth — rationale documented in the file):
Firebase-mode origins with multi-database wildcards, hash-allowed inline boot scripts (no
`'unsafe-inline'` scripts), `'unsafe-eval'` only for Vue's in-browser template compiler, and
loopback entries so local dev + the Firebase emulators keep working.

- **Enforced in every E2E run**: the dev server sends the policy as an enforcing header under
  `CSP=1` (the E2E harness sets it on every worker's server), so CI proves the app works under the policy.
- **Production (Firebase Hosting)**: `firebase.json` currently sends it as
  **`Content-Security-Policy-Report-Only`** — deploy, watch DevTools/violation reports across your
  real flows (especially Google sign-in) for a few days, then rename the header key to
  `Content-Security-Policy` to enforce.
- **Other static hosts (e.g. GitHub Pages)**: after the soak, add
  `<meta http-equiv="Content-Security-Policy" content="...">` to `index.html` using the
  `buildPolicy({ meta: true })` variant (drops `frame-ancestors`, which meta can't express).
- **Keeping it in sync**: `dev/test/csp.test.js` fails CI if the `firebase.json` header drifts from
  `csp.js`, or if an inline script in `index.html` is edited without its hash updating. After
  editing either, regenerate the header value from `csp.js`.
  additions; a Supabase backend needs `https://*.supabase.co` in `connect-src`.

### Violation reports

The production (Report-Only) header carries `report-uri /csp-report` (relative — `csp.js`
`REPORT_URI`). Two ways to collect:

**A. Firebase-native (same-origin, recommended when hosting on Firebase Hosting).**
The `/csp-report` Hosting rewrite (`firebase.json`) routes reports to the `cspReport` Cloud
Function (`functions/`), which aggregates them into the client-inaccessible `_csp_reports`
Firestore collection (one doc per distinct violation, counted at write time). Requires the
**Blaze plan** (Cloud Functions) — and note that this is what makes a bare `firebase deploy` fail on
the free plan, since it tries to deploy `functions/` too. See
[Deploying](FIREBASE.md#deploying-and-why-plain-firebase-deploy-may-fail). Setup:

```bash
firebase functions:secrets:set DBUI_CSP_REPORT_TOKEN   # long random string; gates the read endpoint
cd functions && npm install && cd ..                   # deploy analyzes source locally, needs node_modules
firebase deploy --only functions,hosting               # run from the repo root
```

Read the aggregated summary: `https://<your-hosting-domain>/csp-report?token=<DBUI_CSP_REPORT_TOKEN>`

**B. Supabase Edge Function (free tier, no Blaze).** Same collector, on a free Supabase project —
useful when you want the policy soak without enabling billing, and independent of which backend the
app uses: on Firestore, only the `report-uri` changes.

```bash
psql "$SUPABASE_DB_URL" -f supabase/csp-reports.sql   # or paste it into the SQL editor, once
supabase functions deploy csp-report --no-verify-jwt
supabase secrets set DBUI_CSP_REPORT_TOKEN=<long random string>
```

Then point the policy at it — `csp.js` takes the endpoint as `buildPolicy({ reportUri })`, so set it to
`https://<project-ref>.supabase.co/functions/v1/csp-report` and regenerate the header value in
`firebase.json` (or your host's headers file). Read the summary at that URL with `?token=…`.

`--no-verify-jwt` is required and is not a loosening: a browser posts violation reports with no
credentials and ignores the response, so a function demanding a JWT would receive nothing. Writes are
append-only counters keyed by the violation itself; the only read is token-gated. Reports land in
`public.csp_reports`, which has RLS on with **no policies** — unreachable by `anon`/`authenticated`,
reached by the function's service role. `dev/test/supabase-csp-collector.test.js` executes that SQL
against a real PostgreSQL and asserts both halves: the log is closed to the app's users, and repeat
reports increment atomically rather than losing concurrent ones.

**C. Self-hosted (any static host, no Blaze).** Run the dependency-free collector
(`REPORT_TOKEN=... node dev/csp-report-collector.js`, port 3900) on your own box behind an
HTTPS-terminating proxy, and point `csp.js` `REPORT_URI` at its absolute URL.

The dev/CI **enforcing** policy deliberately omits `report-uri` so test runs never post to the
real collector; `dev/test/csp.test.js` pins that split.

## Schema Reference

Everything about the schema document — tables and column types, the view kinds, embeds, filters,
computed and rotation columns, markdown documents and their tokens, `nav`, lists and translations,
access and self-service — is in **[SCHEMA.md](SCHEMA.md)**, the single source of truth.

Point your editor at the meta-schema and it will complete and check the vocabulary as you type:

```json
{ "$schema": "./schema.schema.json", "tables": { ... }, "views": [ ... ], "nav": { ... } }
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  index.html                      │  ← auto-detects backend
├────────────────┬─────────────────────────────────┤
│  app-core.js │         ui.html                 │  ← Vue 3 app + template
├────────────────┼─────────────────────────────────┤
│  backend-*.js  │  demo-schema.json / firebase-cfg │  ← platform + config
├────────────────┴─────────────────────────────────┤
│  backend-kv.js (Supabase + in-browser PGlite)    │  ← one contract, two hosts
├──────────────────────────────────────────────────┤
│ Supabase │ Firestore │ PGlite (browser / dev)    │
└──────────────────────────────────────────────────┘
```

The two Postgres backends are split along one line: **backend-kv.js is the contract** (which store a row
lives in, what shape it has, which schema-derived facts the schema-blind policies need mirrored) and the
`backend-*.js` file above it is the **platform** (who the caller is, whether other clients exist, where an
uploaded file goes). `backend-supabase.js` and `backend-local-pglite.js` are platforms only — they share
that one contract, and both run `supabase-schema.sql` underneath it, so a policy question has a single
answer whether the database is in São Paulo or in the tab.

**Schema flow:**
1. Server loads `examples/demo-schema.json` from disk (dev) or the database (Supabase/Firebase)
2. Client receives schema via `getSchema()`
3. `validateSchema()` checks for errors
4. Tables auto-created if missing (`initSchema`)
5. UI renders based on schema definitions

**Key design decisions:**
- Schema is pure JSON (user-editable via Settings → Import without code access)
- `defaultSchema` in app-core.js is minimal empty fallback only
- All backends implement the same contract — [BACKEND_API.md](BACKEND_API.md) is that contract, and
  `dev/test/backend-conformance.test.js` enforces it
