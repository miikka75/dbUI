# Supabase backend + GitHub Pages hosting

Supabase (Postgres) is the reference backend, alongside Firebase and the local dev server. Firestore's document model is
reproduced on a single Postgres key-value table (`kv`), so each per-document Firestore rule maps to a
per-row Row-Level-Security (RLS) policy.

## Files

| File | Role |
|------|------|
| `backend-supabase.js` | Backend + `backend_users` + Google auth. Classic script (globals `backend` / `backend_users` / `triggerOAuth`), mirroring `backend-firebase.js`. |
| `storage-supabase.js` | Storage adapter over the `kv` table (`createSupabaseStorage(sb)`, mirrors `storage-firestore.js`). Also `module.exports` for the Node test. |
| `supabase-schema.sql` | Postgres `kv` table + RLS mirroring `firestore.rules`. Run once in Supabase. |
| `.github/workflows/deploy-pages.yml` | Deploy the static site to GitHub Pages on push to `main`. |
| `dev/test/storage-supabase.test.js` | Unit test for the storage adapter (in-memory fake client). |
| `supabase/functions/csp-report/` | CSP violation collector as an Edge Function — the FREE one. The Firebase-native collector needs the Blaze plan; this does not. Independent of which backend the app uses. |
| `supabase/csp-reports.sql` | Storage for it. Standalone and additive — applying it to a project already running `supabase-schema.sql` changes nothing about the app. |
| `csp-client.js` | Reports violations from the PAGE, because a `<meta>` CSP cannot carry `report-uri`. |
| `dev/sync-csp.js` | `npm run csp:sync` — regenerates both static copies of the CSP from `csp.js`: firebase.json's header and `index.html`'s `<meta>` (the delivery that covers a GitHub Pages deploy). Needed after naming a self-hosted origin in `CONNECT_HOSTS`. |

Wiring is applied to `index.html` (mode branch, shared-link support, SDK + adapter `loadScript`),
`ui.html` (setup button + step), `app-core.js` (`saveSupabaseConfig`, `shareLink`, setup fields), and the
`backend-conformance` drift-guard test.

The Supabase SDK loads as a classic UMD script (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`,
global `window.supabase`), exactly like the Firebase compat SDK — no ES modules, matching this branch.

## Supabase project setup

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Providers → Google**: enable it. Create a Google OAuth client
   ([console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → Web application):
   - **Authorized redirect URI**: `https://<project-ref>.supabase.co/auth/v1/callback` (shown on the
     Supabase provider page).
   - Paste the client ID + secret into Supabase.
3. **Authentication → URL Configuration → Redirect URLs**: add your site URL, e.g.
   `https://dbui.ddns.net/` (and `http://localhost:*` for local dev). It must match what the app
   sends as `redirectTo` — `location.origin + location.pathname`, so the *deployed* origin, not the
   `github.io` one it may redirect from.
4. **SQL Editor**: paste all of `supabase-schema.sql` and **Run**. One paste is the whole backend —
   the `kv` table, every RLS policy and helper function, the realtime publication, **and** the
   `uploads` Storage bucket with its size/MIME limits and object policies. There is no bucket to
   create by hand.

   It is idempotent, and **re-running it is how an existing project picks up new policies**: do that
   after every upgrade that touches `supabase-schema.sql`, not just on first setup. (The bucket insert
   is `on conflict do update`, so it also applies limits to a bucket an earlier version created
   without them.)

   Or run it from a shell with `psql`. That is handier for the re-run after each upgrade:

   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase-schema.sql
   ```

   The two flags make the run all or nothing, like the SQL Editor's: a plain `psql -f` carries on past
   an error and can leave the policies half-applied. `SUPABASE_DB_URL` is the connection string from
   the dashboard's **Connect** button. The direct connection is IPv6-only on the free plan, so from an
   IPv4-only network use the **Session pooler** string (not the Transaction pooler). Not
   `supabase db push`: that applies only files in `supabase/migrations/`, and this file is not one.
5. **Project Settings → API Keys**: copy the **Project URL** and *one* client key — enter them in the
   app's setup screen (Setup → Supabase). Either key format works; the app passes the key straight to
   `createClient` as an opaque string and never parses it:
   - **Publishable key** (`sb_publishable_…`, under "Publishable and secret API keys") — the current
     format, and the one to prefer for new projects.
   - **anon public** key (a long `eyJ…` JWT, under "Legacy anon, service_role API keys") — the older
     format, still fine.

   Both are public by design; RLS is the security boundary. **Never** use the **Secret key**
   (`sb_secret_…`) or **service_role** key: this app is pure client-side, so the key ships to every
   visitor's browser, and those keys bypass RLS entirely — anyone loading the page would get
   unrestricted read/write over the whole database. They belong only on a trusted server.

First sign-in, while no members exist, acts as **admin** (bootstrap). Import a schema
(Settings → Import from JSON), then add yourself under **Settings → User Access**. From then on only
registered users have access.

## Self-hosted (Docker)

Everything above assumes supabase.com. The stack is open source, so the same project can run on a
machine you own — usually to escape the free tier's inactivity pause, at the price of owning Postgres
backups yourself. **`supabase-schema.sql` does not change**: its policies reach identity only through
`auth.jwt() ->> 'email'`, which a self-hosted GoTrue populates identically.

```bash
git clone --depth 1 https://github.com/supabase/supabase
cp -r supabase/docker my-supabase && cd my-supabase
cp .env.example .env
```

1. **Replace every secret in `.env`** — `POSTGRES_PASSWORD`, `JWT_SECRET` (40+ chars),
   `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD`,
   `POOLER_TENANT_ID`. Then generate `ANON_KEY` and `SERVICE_ROLE_KEY`: those are JWTs **signed with
   your `JWT_SECRET`**, not random strings (Supabase's self-hosting docs carry the generator). The
   example values are published on GitHub, so leaving any of them is the same as running with no auth.
2. **URLs**: point `SITE_URL`, `API_EXTERNAL_URL` and `SUPABASE_PUBLIC_URL` at your domain, and add the
   app's own origin (where the static site is served — `https://dbui.ddns.net/`) to
   `ADDITIONAL_REDIRECT_URLS`.
3. **Google sign-in** has no provider UI here — it is env on the `auth` service:
   `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`, `..._CLIENT_ID`, `..._SECRET`, and
   `..._REDIRECT_URI=https://db.example.org/auth/v1/callback`. Register that redirect URI with Google
   in place of the `<ref>.supabase.co` one in **Supabase project setup** step 2.
4. **Terminate TLS in front of Kong** (the whole stack enters on `:8000`) with Caddy or Traefik. Not
   optional: Google OAuth and the browser's realtime `wss://` both require https.
5. `docker compose pull && docker compose up -d`, then run all of `supabase-schema.sql` through
   Studio's SQL editor or `psql` (the same command as **Supabase project setup** step 4, with your
   own Postgres connection string).
6. In the app's setup screen: **Project URL** is your domain, and the key is the `ANON_KEY` you
   generated — the legacy `eyJ…` shape, which is still accepted (**Supabase project setup** step 5).

Budget ~4 GB of RAM for the stock stack (see *Trimming* below for how to fit it in less). A small VPS
or an always-free ARM instance handles it; a laptop or Pi behind a tunnel that provides the hostname
and certificate works too, and covers step 4 at the same time.

### The one edit this app needs

`csp.js` wildcards `*.supabase.co` in `connect-src`, which your domain is not. Name it in
`CONNECT_HOSTS` — **both** schemes, https for the PostgREST/GoTrue calls and wss for realtime — then
regenerate the static copy that Firebase Hosting serves:

```js
var CONNECT_HOSTS = ['https://db.example.org', 'wss://db.example.org'];
```

```bash
cd dev && npm run csp:sync    # rewrites firebase.json's header; test/csp.test.js guards the drift
```

Skipping this costs nothing while the header is Report-Only, and then breaks the app the moment it is
enforced — as an **empty database** with no visible error, because a blocked fetch looks exactly like
one. Nothing else changes: `databases.js` already keys a host that is not `<ref>.supabase.co` by its
whole hostname, so two self-hosted databases cannot collide into one installed app.

### Trimming the stack

This app talks to **Postgres, PostgREST and GoTrue**, plus Realtime and Storage. `studio`, `analytics`
(the usual reason `docker compose up` fails), `vector`, `imgproxy`, `supavisor` and `meta` are all
droppable, which fits the stack under 2 GB. One caveat if you drop Realtime or Storage: both are
*optional* per BACKEND_API.md, but `backend-supabase.js` passes `subscribeTable` and `uploadFile` to
`createKvBackend` unconditionally, so their absence surfaces as runtime errors rather than as the
documented degradation to manual refresh and paste-a-URL.

## GitHub Pages

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. `.github/workflows/deploy-pages.yml` uploads the repo root (minus dev/secret files)
   and publishes it.
3. Optional, and how the live site is served: **Settings → Pages → Custom domain**, then
   **Enforce HTTPS** once the certificate is issued (see below).

Config lives in `localStorage` (entered once via setup, or shared via `?mode=supabase&url=…&key=…`), so
no secrets are baked into the deploy. Alternatively commit a `supabase-config.json`
(`{"url":"…","anonKey":"…"}`) — the anon key is safe to publish; remove it from the workflow's prune list
if you want it deployed.

### Custom domain

The live site is <https://dbui.ddns.net/>, a custom domain on the same Pages deploy. Nothing in the app
had to change for it: `index.html` derives `APP_BASE` from `location.pathname` and every share link,
QR code, manifest identity and redirect URL is built from `location` at runtime, so moving from the
`/<repo>/` project path to a domain root is invisible to the code.

What it does take:

- **The domain lives in the Pages settings, not in the repo.** Publishing from a custom Actions workflow
  means GitHub "ignores any existing `CNAME` file and does not require one" — so adding one here would
  be inert, and the binding is `gh api repos/<owner>/<repo>/pages`'s `cname` field. A 404 reading
  *"There isn't a GitHub Pages site here"* while DNS already resolves to GitHub is exactly this field
  being unset.
- **DNS.** GitHub asks for a `CNAME` → `<owner>.github.io` for a subdomain, but No-IP does not allow
  `CNAME` records on its own domains, so a `ddns.net` hostname has to be an **A record** to one of
  `185.199.108-111.153`. That works, with the costs of the shortcut: a single edge IP instead of four,
  no `AAAA` (IPv6-only clients cannot reach it), no `TXT` and therefore no domain verification, a free
  hostname that must be reconfirmed every 30 days — and a **DDNS update client must never be pointed at
  this hostname**, because it would overwrite the A record with a home IP and take the site down.
- **HTTPS is not optional here.** Service workers require a secure context, so over plain `http://` the
  registration in `index.html` silently no-ops: no offline cache, no installable PWA. Google sign-in
  needs it too. Enforce it as soon as the certificate is approved.
- **A new origin is a new `localStorage`.** Database configs, the active-database key and PWA installs
  do not follow the redirect from the old `github.io` URL; returning users land on the setup screen and
  need the database re-added, or a share link.
- **Tell the backends about it.** Firebase → Authentication → Authorized domains, and Supabase →
  Authentication → URL Configuration → Redirect URLs. Both authorize by origin, and neither learns about
  the move on its own.

## Content-Security-Policy reporting

The app ships an **enforcing** CSP. On GitHub Pages that policy is delivered as a `<meta>` tag, because
Pages cannot send a custom header at any price — and that one fact decides everything below.

**`report-uri` is a header-only directive.** A `<meta>` CSP ignores it, exactly as it ignores
`frame-ancestors`. So on this deployment the policy has no way to ask browsers for reports, and the
usual advice — "point `report-uri` at a collector" — cannot work. The page reports for itself instead:
`csp-client.js` listens for `securitypolicyviolation`, which fires however the policy arrived.

A common assumption worth correcting: **this is not a billing problem.** A CSP *header* on Firebase
Hosting is ordinary Hosting config and works on the free Spark plan. Only the Firebase *collector* — a
Cloud Function plus a Secret Manager secret — needs Blaze, which is exactly why the Edge Function below
exists. The blocker here is the delivery, not the plan.

### Turning it on

```bash
# 1. Storage: create the table. From a shell (SUPABASE_DB_URL as in setup step 4):
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/csp-reports.sql
#    Or paste supabase/csp-reports.sql into the dashboard's SQL EDITOR and run it.
#    NOT `supabase db push` -- that applies migrations from supabase/migrations/, and this file is
#    deliberately not one (see its header). An earlier version of this document said otherwise; the
#    symptom is a collector that accepts reports, answers 204 to every browser, and then returns
#    "Storage error" on the first read, because the table was never created.

# 2. The collector. --no-verify-jwt is REQUIRED and is not a loosening: browsers post violation
#    reports with no credentials of any kind, so a function demanding a JWT receives nothing.
npx supabase@latest functions deploy csp-report --no-verify-jwt

# 3. A token. This gates READING the log, not writing to it.
npx supabase@latest secrets set DBUI_CSP_REPORT_TOKEN=<long random string>
```

Generate the token with something cryptographic — `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.
`base64url` matters: the token travels in a query string, and plain base64 emits `+` and `/`.

Then point the page at it, in `csp.js`, and regenerate:

```js
var REPORT_ENDPOINT = 'https://<project-ref>.supabase.co/functions/v1/csp-report';
```
```bash
cd dev && npm run csp:sync    # bakes it into index.html next to the policy
```

`csp:sync` owns every static copy, so the endpoint cannot drift from the constant; `dev/test/csp.test.js`
fails if it does.

### Checking it end to end

```bash
cd dev
DBUI_CSP_REPORT_TOKEN=<token> npm run check:live          # or: node check-supabase.mjs https://your.site
```

One real request per claim, against the deployment as it actually is: the page serves an **enforcing**
policy, the tag sits above the first fetch, the collector answers a preflight, accepts a report — and,
the only check that matters, **a posted report comes back out of the log again**.

That last one exists because a `204` means *accepted* and never *stored*. The collector answers 204 even
when the write fails, deliberately, so every other check here can pass while nothing is being saved.
That is not hypothetical: it is the state this deployment sat in, undetected, through four separate
bugs and a green unit suite — none of which were findable by a test that stubs the network, because all
four lived exactly where the stub goes.

The canary it posts is a **stable** URI (`healthcheck.invalid`), so repeated runs increment one row
rather than adding one per run. Remove it whenever you like:

```bash
psql "$SUPABASE_DB_URL" -c "delete from public.csp_reports where blocked_uri = 'https://healthcheck.invalid/probe.js';"
```

Or run the same `delete` in the SQL Editor.

Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as well to include the backend checks — `kv` reachable and
the `uploads` bucket present.

### Reading the log

**`Storage error` means the table is missing, not that the token is wrong** — a bad token answers
`Forbidden`, so getting this far proves the token is right. Apply `supabase/csp-reports.sql` in the SQL
editor. The write path hides this: the function logs the storage failure and returns 204 regardless,
because a collector that 500s at a browser teaches it nothing, so reports are accepted and dropped until
the first read says so.


```
GET https://<project-ref>.supabase.co/functions/v1/csp-report?token=<your token>
→ { "total": 12, "violations": [ { directive, blocked_uri, sample_document, count, last_seen }, … ] }
```

Rows are **counters keyed by `directive + blocked_uri`**, so a violation repeating on every page load
increments rather than appending — a policy that is wrong in one small way cannot grow the table without
bound. RLS is on with no policies and `revoke all from anon, authenticated`; the function reaches the
table with the service role, so the log is unreachable from the app itself.

### Four things worth knowing before you rely on it

- **A page on loopback never reports.** `localhost`, `127.0.0.1` and `::1` are development, and their
  violations are not production telemetry. Without that rule every `npm start` and every E2E run files
  into the shared collector — and the E2E suite *deliberately* provokes a violation to test this very
  module, which would have made CI the loudest reporter the table ever saw.
- **The POST endpoint is necessarily public.** A browser cannot authenticate a violation report, so
  anyone who finds the URL can post to it. The damage is bounded by design — 64 KB body cap, ids
  truncated, counters rather than rows — but there is no rate limit. The token protects *reading*, which
  is the part that matters.
- **`connect-src` must permit the collector**, because the report POST is itself a connection. A
  `*.supabase.co` endpoint needs no change (the wildcard is already there for the backend); a collector
  anywhere else goes in `CONNECT_HOSTS` in `csp.js`. A collector the policy blocks reports nothing and
  says nothing, which is the worst of the two available failures — so `csp.test.js` checks this whenever
  the endpoint is set.
- **The report POST must not trip a CORS preflight.** The collector is on another origin, and only
  `text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data` are CORS-safelisted —
  anything else preflights with `OPTIONS`. `csp-client.js` sends `text/plain` for exactly this reason.
  `application/csp-report`, which looks like the obvious choice, is what a *browser* sends for a
  `report-uri` report, and those are CORS-exempt because the browser generates them; a page-initiated
  POST gets no such exemption. Send it and every report is dropped **before leaving the page** — no
  console error, no row, indistinguishable from a site with nothing to report. The function also
  answers `OPTIONS` now, so a client that does send a non-simple type still works.
- **Content blockers block the report.** uBlock Origin and similar match URLs that look like
  telemetry, and a path ending `/csp-report` looks exactly like one, so the POST dies with
  `net::ERR_BLOCKED_BY_CLIENT` before it reaches the network. Nothing can be done about it from the
  page, and renaming the endpoint only buys a round of cat-and-mouse. **Treat the log as a biased
  sample, not a census:** it under-represents precisely the users running extensions that inject into
  pages and trip the policy. To test the pipeline yourself, use a window with extensions disabled.
- **A violation of `connect-src` may not report itself**, because the report is a connection. This
  cannot be fixed from the page. It is the cheapest gap available: those violations are the most visible
  in DevTools anyway.

### If you would rather use the Firebase collector

It works, and it costs money for no benefit here. `functions/index.js` needs **Blaze** (Cloud Functions
*and* Secret Manager). Its `report-uri /csp-report` rewrite only fires for pages served by **Firebase
Hosting** — not this deployment — so reaching it from Pages means pointing `REPORT_ENDPOINT` at the
function's absolute URL and paying for Blaze to receive reports the Edge Function takes for free.

## How it maps to Firestore

| Firestore | Supabase |
|-----------|----------|
| `_col(store).doc(key).data` | row `(store, key, value)` in table `kv` |
| Per-document security rule | Per-row RLS calling `app_can_read/create/update/delete` |
| `request.auth.token.email` | `auth.jwt() ->> 'email'` |
| `noUsers()` bootstrap = admin | `app_no_users()` (+ the `app_no_users` RPC for the client) |
| Firebase Storage download URL | Public `uploads` bucket public URL |
| `storage.rules` (registration + own-email folder + 10 MB + `image/*`) | `uploads_insert/update/delete` policies + bucket `file_size_limit` / `allowed_mime_types` |
| `validProfile` / `validLink` / `validRequest` | `app_valid_shape(store, key, value)` |

**Testing the RLS**

`dev/test/supabase-rls.test.js` loads this file's policies into PostgreSQL-in-WASM
(`@electric-sql/pglite`) and executes them — 73 assertions covering the same access matrix as the
Firestore emulator suite. It is a plain unit test: `npm test` in `dev/` runs it, with no Docker,
service container or JVM, so it gates CI in the existing `build` job.

It shims `auth.jwt()` as a read of the `request.jwt.claims` GUC (Supabase's own definition) and drops
to `set role authenticated` so RLS actually applies. Two limits worth knowing: the `storage.*` policies
are stripped (stock Postgres has no `storage` schema — `dev/test/rules-parity.test.js` guards those
statically instead), and because the harness's definer is a superuser it validates the *design* rather
than proving your project's role attributes.

Remember that RLS **filters** where Firestore **denies**: a forbidden `SELECT` returns zero rows and a
forbidden `UPDATE`/`DELETE` reports zero affected rows — neither raises. Only a `WITH CHECK` violation
errors. The suite's helpers encode that, and it is the single easiest thing to get wrong when adding a
case.

**Parity notes**

- `/_users/<email>` rows are authoritative on Supabase (written on every role change). A legacy
  `_meta/users` map is still read by admins for one-time migration of a Firestore export.
- A forbidden Firestore read *throws*; a forbidden Postgres `SELECT` returns *zero rows*. `bootData()`
  therefore pre-checks registration via `getMyAccess()` so an unregistered user gets the request-access
  banner rather than a spurious "first boot".
- The `_lists` editor-update policy is slightly looser than Firestore's (it can't compare old vs. new
  `tables` in one `WITH CHECK`), but still requires the editor to have *write* access to the list's
  tables — and both layers now authorize a list **create** from the `_meta/listTables` mirror, pinning
  the stored ownership label to what the schema says rather than to what the writer claims.
- Uploads are **not** open to any signed-in account. `authenticated` means any Google account on the
  internet and the project config travels in shareable links, so every write policy calls
  `app_is_registered()` and scopes the object to `<my-email>/…`. Re-running `supabase-schema.sql` after an
  upgrade is what applies these to an existing project — see step 4 of the setup, which is where that
  instruction now lives rather than buried here.
- If you enforce a CSP, `connect-src` must include `https://*.supabase.co` (and `wss://` for realtime).
  `/csp.js` already does; a blocked fetch looks exactly like an empty database.
- **Access modes** (`tables: { t: 'r' | 'rw' }`) mirror firestore.rules exactly. Reads go through
  `app_has_table_access`, which is unchanged: `jsonb ? key` matches an array element *or* an object key,
  so a legacy array grant and a mode map read identically and nothing needs migrating. Writes go through
  the new `app_has_table_write` / `app_list_write_allowed`, which consult the denormalized `rwTables`
  array and fall back to plain membership when it is absent.

## Testing

- `cd dev && node --test test/storage-supabase.test.js` runs the adapter unit test.
- `node --test test/backend-conformance.test.js` confirms `backend-supabase.js` implements every backend
  contract method (drift guard).
