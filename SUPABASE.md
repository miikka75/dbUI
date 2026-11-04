# Supabase

Postgres as the database, Supabase Auth for sign-in, row-level security as the access policy. This is the
backend the live site uses. Firestore's document model is kept in one key-value table (`kv`), so each
Firestore rule becomes a per-row policy.

| File | Role |
|---|---|
| `backend-supabase.js` | The platform: sign-in (Google, emailed link and code), realtime, uploads. Builds on `backend-kv.js`. |
| `storage-supabase.js` | Reads and writes the `kv` table. |
| `supabase-schema.sql` | The `kv` table, every policy, the realtime publication and the `uploads` bucket. |
| `supabase/functions/csp-report/`, `supabase/csp-reports.sql` | The free CSP violation collector (optional). |
| `dev/test/supabase-rls.test.js` | Runs the policies in PGlite as part of `npm test`. |

## Setup

1. Create a project at [supabase.com](https://supabase.com).
2. **Authentication → Providers → Google**: enable it with a Google OAuth client whose redirect URI is
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. **Authentication → URL Configuration**: add your site URL (and `http://localhost:*` for development)
   to the redirect URLs.
4. Apply `supabase-schema.sql`: paste it into the SQL Editor and run it, or from the repo root
   `npx supabase@latest db query --linked --project-ref <project-ref> -f supabase-schema.sql`.
   It is idempotent: **re-run it after every upgrade** that changes it. (Not `supabase db push`.)
5. Open the app, choose Supabase, and enter the **Project URL** and the **publishable key**
   (`sb_publishable_…`, or the legacy anon key). Never the secret or `service_role` key: the app runs in
   the browser, and those keys bypass RLS.
6. **Sign in right away**: the first account becomes the admin. Then install an example or Settings → Import.

Steps 4 onward in one re-runnable command (after `npx supabase@latest login` once):

```bash
cd dev
npm run supabase:setup -- --project-ref <project-ref>
```

It applies the schema, sets up the CSP collector and its read token (shown once, created only if none
exists; `--new-token` replaces it), offers email sign-in, and checks the live site. `--csp-only` sets up
only the collector, for a Firebase deployment.

## Email sign-in

One email carries a link and a 6-digit code; no password. Unconfirmed addresses count for nothing in the
policies. It needs:

- `{{ .Token }}` in the **Magic Link** and **Confirm signup** templates.
- A mail service (SMTP). Supabase's built-in mailer sends only a few emails an hour, and only to the
  project's team. Resend (`smtp.resend.com:465`, user `resend`) and Brevo (`smtp-relay.brevo.com:587`)
  have free tiers.
- A sender domain verified with that service (SPF/DKIM records at your registrar). A `ddns.net` name
  usually cannot take them.

```bash
cd dev
export SUPABASE_ACCESS_TOKEN=sbp_...       # supabase.com/dashboard/account/tokens
export SMTP_PASS=re_...                    # an env var, not a flag, so it stays out of shell history
npm run supabase:auth -- --project-ref <ref> --site https://example.org/ --app-name "Fitness Club" \
  --smtp resend --smtp-from noreply@example.org --rate-limit 100
```

Without arguments it asks for each value. In the dashboard: Authentication → Email (on, Confirm email
on), Emails → Templates, Emails → SMTP Settings, Rate Limits.

## Self-hosted (Docker)

The open-source stack runs the same `supabase-schema.sql` unchanged.

```bash
git clone --depth 1 https://github.com/supabase/supabase
cp -r supabase/docker my-supabase && cd my-supabase && cp .env.example .env
```

1. Replace **every** secret in `.env`; generate `ANON_KEY` and `SERVICE_ROLE_KEY` as JWTs signed with your
   `JWT_SECRET`. The example values are public.
2. Point `SITE_URL`, `API_EXTERNAL_URL` and `SUPABASE_PUBLIC_URL` at your domain; add the app's origin to
   `ADDITIONAL_REDIRECT_URLS`.
3. Google sign-in is env on the `auth` service: `GOTRUE_EXTERNAL_GOOGLE_ENABLED`, `…_CLIENT_ID`,
   `…_SECRET`, `…_REDIRECT_URI=https://<your-domain>/auth/v1/callback`.
4. Put TLS in front of Kong (`:8000`); OAuth and realtime need HTTPS.
5. `docker compose up -d`, then apply the schema with `npx supabase@latest db query --db-url "<url>" -f supabase-schema.sql`.
6. In the app: your domain as the Project URL, the `ANON_KEY` as the key.
7. Add `https://<your-domain>` and `wss://<your-domain>` to `CONNECT_HOSTS` in `csp.js`, then
   `npm run csp:sync`. Otherwise the policy blocks the backend and the app looks like an empty database.

The stock stack needs ~4 GB of RAM. The app uses Postgres, PostgREST, GoTrue, Realtime and Storage;
`studio`, `analytics`, `vector`, `imgproxy`, `supavisor` and `meta` can go.

## GitHub Pages and a custom domain

Repo Settings → Pages → Source: GitHub Actions. Every push to `main` deploys (see the README's
*Deploying*). The live site is `https://dbui.ddns.net/`, a custom domain on that deploy:

- The domain is set in the Pages settings (`cname`), not by a `CNAME` file.
- `ddns.net` takes no CNAME, so it is an A record to one of `185.199.108-111.153`. Never point a DDNS
  update client at it.
- Enforce HTTPS: the service worker and Google sign-in need it.
- A new origin starts with empty `localStorage`: users re-add the database or follow a share link.
- Add the domain to Supabase's redirect URLs (and Firebase's authorized domains).

## CSP violation reports

Set up by `npm run supabase:setup` (or `--csp-only`). Then set `REPORT_ENDPOINT` in `csp.js` to
`https://<project-ref>.supabase.co/functions/v1/csp-report` and run `npm run csp:sync`.

- Read the log in Settings → Security policy reports (paste the token once; **Rotate token** replaces
  it), or `DBUI_CSP_REPORT_TOKEN=<token> npm run csp:log`.
- `DBUI_CSP_REPORT_TOKEN=<token> npm run check:live` checks the deployed policy and that a posted report
  comes back out of the log. A `204` only means accepted.
- `Storage error` on reading means `supabase/csp-reports.sql` was never applied; a wrong token answers
  `Forbidden`.
- The POST endpoint is public by necessity (bounded: 64 KB, counters per directive and URI). The token
  guards reading.
- Content blockers drop reports to a path ending `/csp-report`, so treat the log as a sample.

## How it maps to Firestore

| Firestore | Supabase |
|---|---|
| a document | a row `(store, key, value)` in `kv` |
| a per-document rule | a per-row policy calling `app_can_read/create/update/delete` |
| `request.auth.token.email` | `auth.jwt() ->> 'email'` |
| `noUsers()` bootstrap | `app_no_users()` |
| Storage download URL | public URL in the `uploads` bucket |
| `storage.rules` | `uploads_*` / `feeds_*` policies and the bucket's size and type limits |
| `validProfile`, `validLink`, `validRequest` | `app_valid_shape(store, key, value)` |

- RLS **filters** where Firestore **denies**: a forbidden `SELECT` returns no rows, a forbidden
  `UPDATE`/`DELETE` affects none. Only a `WITH CHECK` violation raises. So `bootData` checks registration
  first, through `getMyAccess`.
- Grant modes (`{ table: 'r' | 'rw' }`) read through `app_has_table_access` and write through
  `app_has_table_write`, which uses the denormalised `rwTables`.
- `dev/test/supabase-rls.test.js` runs the policies in PGlite (no Docker). It strips the `storage.*`
  policies, which `rules-parity.test.js` checks statically.
