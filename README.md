# dbUI

A schema-driven web app: a JSON schema defines the tables, columns, views and navigation, and the app
renders them. Vue 3 and Vuetify, no build step for development.

- **Features**, with screenshots and the backends each supports: [docs/README.md](docs/README.md)
- **The schema language**: [SCHEMA.md](SCHEMA.md)
- **Example databases** you can install from the app: [examples/README.md](examples/README.md)
- **Backend contract**, for writing a new backend: [BACKEND_API.md](BACKEND_API.md)
- **What is proposed or declined**: [ROADMAP.md](ROADMAP.md)

## Backends

| Backend | Storage | Sign-in | Live updates | Setup |
|---|---|---|---|---|
| **In this browser** | Postgres (PGlite) in IndexedDB | an email you type in, unverified | — (one tab) | none |
| **Supabase** | Postgres, row-level security | Supabase Auth | ✅ | [SUPABASE.md](SUPABASE.md) |
| **Firebase** | Firestore, security rules | Firebase Auth | ✅ | [FIREBASE.md](FIREBASE.md) |
| **Dev server** | Postgres (PGlite) or SQLite | trusted `X-User` header, loopback only | ✅ | `npm start` |

The in-browser, Supabase and dev-server backends all run `supabase-schema.sql`, so the access policy is
the production one everywhere. `npm start -- --sqlite` trades it for speed: SQLite enforces no access at
all.

## Quick start

**Nothing to install:** open the deployed app and pick **In this browser**. Postgres compiled to
WebAssembly runs in the tab and keeps its data in IndexedDB.

- The first start downloads ~17 MB, then works offline.
- The data stays in this browser. Use Settings → Export for a copy, and Import to move it to Supabase or
  Firebase later.
- The browser may evict it under storage pressure; the app asks for persistent storage, and Settings →
  Local database shows whether it got it.
- One tab at a time: a second tab is refused rather than corrupting the database.
- The identity is self-asserted, which is fine for one person and wrong for a team: use a hosted
  backend once a second person is involved.

**Local development:**

```bash
cd dev
npm install
npm start            # http://127.0.0.1:3000
npm test             # unit tests
npx playwright test --config=playwright.config.js   # UI tests
npm run typecheck
```

- An empty database offers the shipped examples on its first screen. `npm run seed:import [-- chores]`
  also seeds an example's users and list links, which the in-app picker never installs.
- `?user=ann@dev` signs in as that user (the dev server trusts it; it binds to loopback only).
- `APP_DB=other.db PORT=3200 node server.js` runs an isolated instance; `APP_DB=:memory:` a throwaway one.
- Reset: delete `dev/local.db*` and `dev/*.pgdata/`, then `localStorage.clear()` in the browser.

**A hosted backend:** create the project, publish its access policy, paste its public config into the
setup screen, and sign in. **The first account to sign in becomes the admin**, so do that right after
publishing the policy. Then install an example or import a bundle. The step-by-step guides are
[SUPABASE.md](SUPABASE.md) and [FIREBASE.md](FIREBASE.md).

## Deploying

The live site is GitHub Pages: `.github/workflows/deploy-pages.yml` runs on every push to `main`.
Firebase Hosting works too (`firebase deploy --only hosting`).

Both publish `_site/`, which `node scripts/build-site.js --compile --minify` builds:

- only the files the app serves (an allowlist), so nothing else in the repo goes public;
- the Vue templates precompiled, so the page needs no `'unsafe-eval'`;
- the app's scripts minified (vendor files are already).

`vendor/` holds Vue, Vuetify, the icon font, PGlite and the backend SDKs at the versions in
`vendor/versions`. It is not committed: `./update-vendor.sh` fetches it, and both deploys do so too. Each
file has an SRI-pinned jsdelivr fallback.

## Sharing & Access

### Shareable Links (URL params)

A link can carry a database's public config, so a new user connects in one click:

```
https://dbui.ddns.net/?mode=supabase&url=PROJECT_URL&key=PUBLISHABLE_KEY
https://dbui.ddns.net/?mode=firebase&config=BASE64_CONFIG
https://dbui.ddns.net/?mode=firebase&k=API_KEY&p=PROJECT_ID     # &d=AUTH_DOMAIN only if not the default
```

The app asks before connecting to a project it does not know, stores the config, and removes it from
the address bar. Settings → Share link builds the link. One deployment serves any number of databases:
each browser keeps its own list.

### User Registry

Settings → User Access, on every backend:

- The first user to sign in becomes the admin.
- Roles: **admin** (schema, users, translations, every table), **editor** (writes the tables granted),
  **viewer** (reads only).
- Each user has two chip rows: tables they may edit, and tables they may only view; or "All".
- A view is shown only when the user can read all its source tables; a list is editable only with write
  access to a table that uses it.
- The access policy (`supabase-schema.sql`, `firestore.rules`) enforces the same on the server.

## Installable (PWA)

The app installs to a phone's home screen or a desktop window.

- `manifest.json` is the starting point; once the schema loads, the app swaps in a manifest with the
  database's title, theme colours and icons.
- Icons come from `schema.icons` ([SCHEMA.md → icons](SCHEMA.md#icons-title)), else from `favicon.svg` and
  `icon-512.png` at the site root. An install icon must be a square PNG ≥144 px at a network URL (not
  `data:` or `blob:`), served over HTTPS. Regenerate the PNG with
  `node dev/make-icon-png.mjs favicon.svg icon-512.png 512`.
- The service worker (`sw.js`) caches the published site: a repeat visit downloads nothing and the app
  opens offline. In development it does nothing.

## Content-Security-Policy

`csp.js` defines one policy. `npm run csp:sync` writes it into `index.html` (an enforcing `<meta>` tag,
the only option on GitHub Pages) and `firebase.json` (a Report-Only header). `dev/test/csp.test.js` fails
if either drifts or if an inline script changes without its hash. The E2E suite runs under the policy.

- Inline scripts are allowed by hash only. `'unsafe-eval'` is there for Vue's in-browser compiler in
  development; the published page drops it.
- **Violation reports** are off until a collector is set in `csp.js` (`REPORT_ENDPOINT`). The page posts
  them itself, since a `<meta>` policy cannot carry `report-uri`. Loopback pages never report. Collectors:
  - Supabase Edge Function (free): apply `supabase/csp-reports.sql`, then
    `supabase functions deploy csp-report --no-verify-jwt` and set `DBUI_CSP_REPORT_TOKEN`.
  - Firebase Cloud Function `cspReport` (Blaze plan): `firebase deploy --only functions,hosting`.
  - Self-hosted: `REPORT_TOKEN=… node dev/csp-report-collector.js`.

  Read them in Settings → Security policy reports, or with `npm run csp:log`.

## Architecture

```
index.html                picks the backend, loads the scripts
ui.html, app-core.js      the Vue app: templates and the root component
*.js (columns, rows, …)   pure domain modules, unit-tested in Node
backend-*.js              the platform: sign-in, live updates, uploads
backend-kv.js             the backend contract, shared by Supabase, PGlite and Firebase
storage-*.js              each store's get/put/delete
```

`validateSchema()` (`schema-validate.js`) checks the schema at load and reports what it cannot use. Every
backend implements [BACKEND_API.md](BACKEND_API.md); `dev/test/backend-conformance.test.js` holds them to it.
