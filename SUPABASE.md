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
| `dev/sync-csp.js` | `npm run csp:sync` — regenerates firebase.json's CSP header from `csp.js`. Needed after naming a self-hosted origin in `CONNECT_HOSTS`. |

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
   `https://miikka75.github.io/dbUI/` (and `http://localhost:*` for local dev).
4. **SQL Editor**: paste all of `supabase-schema.sql` and **Run** (idempotent).
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
   app's own origin (the GitHub Pages URL) to `ADDITIONAL_REDIRECT_URLS`.
3. **Google sign-in** has no provider UI here — it is env on the `auth` service:
   `GOTRUE_EXTERNAL_GOOGLE_ENABLED=true`, `..._CLIENT_ID`, `..._SECRET`, and
   `..._REDIRECT_URI=https://db.example.org/auth/v1/callback`. Register that redirect URI with Google
   in place of the `<ref>.supabase.co` one in **Supabase project setup** step 2.
4. **Terminate TLS in front of Kong** (the whole stack enters on `:8000`) with Caddy or Traefik. Not
   optional: Google OAuth and the browser's realtime `wss://` both require https.
5. `docker compose pull && docker compose up -d`, then run all of `supabase-schema.sql` through
   Studio's SQL editor or `psql`.
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

Config lives in `localStorage` (entered once via setup, or shared via `?mode=supabase&url=…&key=…`), so
no secrets are baked into the deploy. Alternatively commit a `supabase-config.json`
(`{"url":"…","anonKey":"…"}`) — the anon key is safe to publish; remove it from the workflow's prune list
if you want it deployed.

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
  `app_is_registered()` and scopes the object to `<my-email>/…`. Re-run `supabase-schema.sql` after
  upgrading: the bucket upsert is `on conflict do update`, so it applies the size/MIME limits to a
  bucket an earlier version created without them.
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
