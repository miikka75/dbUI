# Supabase backend + GitHub Pages hosting

Supabase (Postgres) is available as a backend mode alongside Firebase, Google Sheets, and CRDT. It's a
first-class *alternative* — nothing about the other modes changes. Firestore's document model is
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
