# dbUI App

A schema-driven web app with multiple backend options. No build step — Vue 3 + Vuetify 3 via CDN.

## Features

- **Schema-driven**: JSON config defines tables, columns, views, and behavior
- **Three backends**: Supabase (Postgres + RLS), Firebase (Firestore), Dev Server (PGlite — runs the *real* `supabase-schema.sql` policies locally)
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
| **Firebase** | Firestore | Firebase Auth | ✅ | ✅ Instant | Firebase Console |
| **Dev Server (PGlite)** | PostgreSQL-in-WASM | Trusted `X-User` header (loopback only) | N/A | ✅ SSE | `npm start` |
| **Dev Server (SQLite)** | SQLite | **none — every request permitted** | N/A | ✅ SSE | `npm start -- --sqlite` |

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

Browser: click "Create Local Database" → app loads with schema from `schema.json`.
Optionally run `npm run seed:import` (with the server running) to layer the demo data — rows, lists,
translations, rotation config, plus example users/profiles — on top of the schema. The importable data
lives in `dev/demo-bundle.json` (the same bundle shape as Settings → Import); regenerate its
date-relative rows with `node seed-import.js --regen`.

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

The startup banner prints the database actually in use, so you can confirm which one you are on. To
load an example schema into it, import a bundle from `examples/` via Settings → Import JSON (see
[examples/README.md](examples/README.md)).

## Quick Start (Firebase)

1. Create project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable Firestore Database + Google Auth provider
3. Add your domain to Authentication → Authorized domains (e.g. `127.0.0.1`)
4. Register Web app → copy config JSON
5. Firestore → Rules → paste contents of `firestore.rules` → Publish
6. Run the app, select Firebase mode, paste config → Sign in with Google
7. Settings → Import from JSON to load schema + data

First user is auto-registered as admin (bootstrap mode). After that, only registered users can access. Per-table permissions configurable per user.

> ⚠️ **Sign in yourself immediately after publishing the rules.** The first Google account to sign
> in becomes the admin — so never share the app URL or a pre-configured link before you have signed
> in once. Anyone holding the link during the bootstrap window could claim the admin role.
>
> A stronger fix, if you would rather not rely on timing: seed the admin `/_users/<email>` document
> at deploy time, which closes the window entirely rather than shortening it.

### Deploying (and why plain `firebase deploy` may fail)

```bash
firebase deploy --only firestore:rules          # rules FIRST — see the note below
firebase deploy --only hosting,storage          # `storage` here is storage.rules
```

Rules before the app, always: the app is what starts making requests, so a deploy that ships new code
against yesterday's rules is a window where the two disagree.

**On the free (Spark) plan, deploy with `--only`.** A bare `firebase deploy` also deploys
`functions/`, and the CSP report collector there declares a Secret Manager secret — both Cloud
Functions and Secret Manager need the **Blaze** plan, so the deploy dies before it gets to your app:

```
Error: Request to https://secretmanager.googleapis.com/v1/.../DBUI_CSP_REPORT_TOKEN
had HTTP Error: 403, This API method requires billing to be enabled.
```

Nothing about the app needs that function. The `/csp-report` Hosting rewrite pointing at a function
that was never deployed is not a deploy error and not a runtime one either — the path 404s, and a
browser drops an undeliverable CSP report silently. The only thing you lose is the aggregated
violation counts described under [Violation reports](#violation-reports); the Report-Only header
still works, so you can still watch violations in DevTools while you soak the policy.

Firebase config is stored in browser localStorage. Share a pre-configured URL to onboard users without manual setup.

### Firefox: "Sign in with Google" fails (third-party cookies)

Google sign-in (`signInWithPopup`) loads Firebase's auth handler from `<projectId>.firebaseapp.com`.
When the app is hosted on a **different origin** (e.g. GitHub Pages) that handler runs as a
*third party*, and Firefox's **Enhanced Tracking Protection** + **Total Cookie Protection** (default
since FF 103) block its cookies/storage — so sign-in silently fails. Same applies to Safari ITP.

User-side fixes (easiest first):

1. **Per-site (recommended):** click the **shield icon** left of the address bar → turn
   **Enhanced Tracking Protection OFF** for this site → reload.
2. **Cookie exception:** Settings → Privacy & Security → Cookies and Site Data →
   **Manage Exceptions** → add `https://<projectId>.firebaseapp.com` → **Allow**.
3. **Global:** set ETP to **Standard** (not Strict) — least reliable, since Standard still
   partitions third-party storage; prefer the exception in (2).

Robust fix (no per-user setting): serve the auth handler **same-origin** with the app — host on
**Firebase Hosting** (or a custom domain whose `authDomain` matches the app's origin). Then the auth
popup is first-party and no third-party cookies are involved.

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
  `start_url`/`scope`/icon `src` are written as **absolute** URLs (a Blob-URL manifest can't
  resolve relative paths). `background_color`/`theme_color` follow the current Vuetify theme; a
  dynamic `theme-color` meta tracks the in-app light/dark toggle. The runtime manifest's install
  icons come from **`schema.icons` when set, else the bundled static files** (below).
- **Service worker** (`sw.js`): minimal pass-through `fetch` (no offline caching) — its purpose
  is to satisfy the browser installability check so the install prompt appears reliably.
- **Per-database icons via `schema.icons` (optional).** All three icon surfaces can be driven
  from the database schema using **absolute URLs** to PNG/SVG files hosted **anywhere** (a CDN,
  Firebase Storage, S3, GitHub raw, …). This works with the *Firebase-for-database-only, no app
  server* model because the icon files are just static objects on some HTTPS host — no runtime
  rasterization or app server is required. Schema shape (every field optional):

  ```json
  "icons": {
    "favicon":     "https://cdn.example.com/db/icon-512.png",
    "appleTouch":  "https://cdn.example.com/db/icon-512.png",
    "png512":      "https://cdn.example.com/db/icon-512.png",
    "png512Sizes": "512x512"
  }
  ```

  The **manifest install icon is a single 512×512 PNG** (`png512`) — Chromium only needs one square
  PNG ≥144px and 512 also covers the splash/maskable role, so no separate small icon is required.
  `png512Sizes` (optional, default `"512x512"`) lets a differently-sized source be declared
  accurately (e.g. a 256×256 PNG → `"256x256"`) to avoid a DevTools size-mismatch warning.
  `_applyIconLinks()` sets `<link rel="icon">` / `<link rel="apple-touch-icon">` and
  `_updateManifest()` emits the manifest install icons from these URLs. **Any missing field falls
  back to the bundled static file**, so a deployment can mix (e.g. per-database favicon, shared
  bundled install icon) or omit `icons` entirely for the all-static default.

  Hard rules that still apply (why `data:`/`blob:` don't work):
  - The manifest **install** icon must be a **square raster PNG** (`png192`/`png512`); SVG /
    `sizes:"any"` is skipped for install (fine as a `favicon`).
  - URLs must be **absolute `http(s)`** and reachable. Chromium's manifest icon downloader runs
    outside the document and **cannot fetch renderer-minted `data:`/`blob:` URLs** (both log
    *"Icon … failed to load"*) — but it **can** fetch a real network URL, including cross-origin
    (icons are exempt from the same-origin rule that binds `start_url`/`scope`).
  - Production must be **HTTPS→HTTPS** (a cross-origin `http:` icon on an HTTPS page is
    mixed-content blocked).

  > Note: automated headless tests verify the manifest/links carry the URLs and that the browser
  > fetches+decodes the cross-origin PNG (no-CORS image path — the same mode the install-icon
  > downloader uses), but headless Chromium does **not** run the desktop install-icon download.
  > Confirm the actual install icon once in real Chrome → DevTools → Application → Manifest.

### Bundled static icon files (default / fallback)
When `schema.icons` is absent (or a field is omitted), the app uses these files shipped **at the
deploy root** (next to `index.html`); the host must serve them with correct image MIME types:

| File | Size | Purpose |
|------|------|---------|
| `favicon.svg` | any | browser-tab favicon (`<link rel="icon">`) |
| `icon-512.png` | 512×512 | apple-touch-icon + manifest install / splash / maskable icon |

These two are the **generic dbUI mark** — Material Design Icons' `database-eye`, on a **transparent**
background — so an unbranded database looks like the app rather than like whichever schema happened to
ship its artwork at the repo root. (It used to be a beehive, which is bishopric iconography; that now
travels with `examples/bishopric-schema.json`, where it belongs.) The path is taken from `@mdi/svg` at
the version `vendor/mdi.css` pins, so it is the same icon set the app already draws with.

> The bundled icons — the default and both examples — are **transparent**, which is right for a tab
> and for the `any` manifest purpose. The manifest also declares `maskable`, and an Android launcher
> applying an adaptive-icon mask composites a transparent icon onto a background it picks, so the
> installed tile can look different from device to device. A schema that wants its installed icon to
> look identical everywhere should point `png512` at a full-bleed **opaque** PNG of its own; nothing
> in the app requires it.

To brand a deployment, prefer **`schema.icons`** above: it is per-database, so one deployment serving
several schemas gives each its own tab and home-screen icon. Replacing these two files instead changes
the default for every unbranded database at once, which is the right tool only when the whole
deployment is one product.

Either way the install icon must be a real PNG, square and ≥144px. Regenerate one from any SVG with
the Chromium the E2E suite already ships:

```bash
node dev/make-icon-png.mjs favicon.svg icon-512.png 512
```

It renders full-bleed and inset to the inner 80%, because the manifest declares
`purpose: "any maskable"` and a round launcher crops to that.

- **Requirements**: install needs HTTPS (Firebase Hosting provides it) and a valid manifest;
  the icon files must be reachable and served as `image/*`.

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
[Deploying](#deploying-and-why-plain-firebase-deploy-may-fail). Setup:

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

## Project Structure

```
index.html                     ← unified entry point (auto-detects backend)
manifest.json                  ← static PWA manifest (baseline name/icons, display: standalone)
sw.js                          ← minimal service worker (enables install prompt; no caching)
favicon.svg                    ← static favicon (replace to rebrand)
icon-512.png                   ← static apple-touch + manifest install/splash/maskable icon (512×512)
app-core.js                  ← Vue app logic + computeds + helpers
ui.html                        ← Vue template (data views, forms, setup)
style.html                     ← CSS styles
backend-firebase.js          ← adapter: Firestore + Firebase Auth
storage-firestore.js         ← Firestore storage adapter
backend-supabase.js          ← adapter: Postgres/RLS + Supabase Auth
storage-supabase.js          ← Supabase kv storage adapter
────────────────────────────────────────────
firebase.json                  ← Firebase Hosting config
firestore.rules                ← Firestore Security Rules
supabase-schema.sql            ← Postgres kv table + RLS (run once in Supabase)
dev/                           ← Local development (dev-server-only files live here)
  schema.json                  ← schema definition (tables, views, settings)
  schema.js                    ← test helper (parses schema.json)
  demo-bundle.json             ← portable demo DATA (rows/lists/translations), imported over schema.json
  seed-import.js               ← applies demo-bundle.json to the dev server (--regen rebuilds it)
  package.json                 ← dependencies + scripts (npm start/test)
  server.js                    ← HTTP server (port 3000; --fs for JSON-file storage)
  backend-pglite.js            ← DEFAULT: dev contract over the kv table (no access checks of its own)
  storage-pglite.js            ← PGlite storage; applies supabase-schema.sql verbatim at startup
  backend-local.js             ← SQLite backend (better-sqlite3), via --sqlite
  storage-fs.js                ← JSON-file backend (node server.js --fs)
  backend-local-client.js    ← client adapter for local server (direct SQLite)
  test/                        ← node:test backend tests
  test-ui/                     ← Playwright E2E tests
```

---

## Schema Reference (`schema.json`)

The complete schema reference is maintained in **[`dev/SCHEMA.md`](dev/SCHEMA.md)** — the single
source of truth. It covers: `icon`/title, `theme` (brand palette), tables (column types incl.
`multiselect`, `owner` & properties), views (data, document, rotationView, calendar, pivot, rsvp & board),
embeds (inline / named-view / `filterBy`), filters (`$or`/`$and`/`matchList`), aggregate views
(`groupBy`/`collect`/`collectWith`), computed columns (incl. rotation columns — occurrence/calendar),
markdown documents and their `{{view:}}`/`{{table:}}`/`{{self}}`/`{{t:}}` tokens, `nav` (layout, groups,
`bottomNav`), and lists & translations.

```json
{
  "icons": { "favicon": "https://…", "appleTouch": "https://…", "png512": "https://…" },
  "theme": { "light": { "primary": "#..." }, "dark": { "primary": "#..." } },
  "tables": { "...": { "columns": [ ... ], "archivable": true } },
  "views":  [ { "name": "...", "sources": [ ... ], "columns": [ ... ] } ],
  "nav":    { "layout": "drawer", "items": [ ... ], "bottomNav": [ ... ] }
}
```

> `icons` values must be **absolute `http(s)` URLs**, not `data:` URIs — see the per-database icon
> section above for why the PWA install icon in particular cannot be a renderer-minted URL. (A view's
> `background` image is a different mechanism and *does* accept in-database bytes; see SCHEMA.md.)

> `nav` is **required**; `views` are flat (hierarchy lives in `nav`). Each view is one **kind**, chosen
> by which field it carries: a **data view** (`sources`/`columns`), a **document** (`markdown`), a
> **rotationView** (`rotation`), a **calendar** (`calendar`), a **pivot** (`pivot`), an **rsvp**
> (`rsvp`), or a **board** (`board`).

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  index.html                      │  ← auto-detects backend
├────────────────┬─────────────────────────────────┤
│  app-core.js │         ui.html                 │  ← Vue 3 app + template
├────────────────┼─────────────────────────────────┤
│ backend-*.html │   schema.json / firebase-config │  ← adapter + config
├────────────────┴─────────────────────────────────┤
│ Supabase │ Firestore │ PGlite / SQLite │
└──────────────────────────────────────────────────┘
```

**Schema flow:**
1. Server loads `schema.json` from disk (dev) or the database (Supabase/Firebase)
2. Client receives schema via `getSchema()`
3. `validateSchema()` checks for errors
4. Tables auto-created if missing (`initSchema`)
5. UI renders based on schema definitions

**Key design decisions:**
- Schema is pure JSON (user-editable via Settings → Import without code access)
- `defaultSchema` in app-core.js is minimal empty fallback only
- All backends implement the same contract (see `dev/BACKEND_API.md`)
