# Firebase backend + Firebase Hosting

Firebase (Firestore) is one of the two hosted backends, alongside [Supabase](SUPABASE.md) and the local
dev server. It is the only backend with an offline cache and the only one whose access rules are
enforced by a rules language rather than by SQL — `firestore.rules` is the authority on who may read
and write what, and `storage.rules` does the same for uploaded images.

| File | Role |
|------|------|
| `backend-firebase.js` | Backend + `backend_users` + Google auth. Classic script (globals `backend` / `backend_users`). |
| `storage-firestore.js` | Storage adapter over Firestore collections. |
| `firestore.rules` | Who may read and write each collection. The production access model. |
| `storage.rules` | Image uploads: registration gate, per-user path scoping, size and content-type caps. |
| `firebase.json` | Hosting config (what is published, the CSP header) + emulator ports. |
| `dev/test-emulator/firestore-rules.mjs` | The rules, executed against the Firestore emulator. |
| `dev/test-ui/firebase-emulator.spec.js` | The whole app against the auth/firestore/storage emulators. |

## Project setup

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

## Linking a clone to your project (do this once)

`firebase deploy` needs to know *which* project, and a fresh clone does not say — nothing here names one.
The link lives in `.firebaserc`, which is **not committed**: it would name whoever wrote it, and a fork
running `firebase deploy` would then aim at somebody else's project. So each clone makes its own:

```bash
npm install -g firebase-tools
firebase login                 # once per machine
firebase use --add             # pick your project, give it an alias (e.g. `default`)
```

`firebase use --add` writes `.firebaserc` in the repo root. It is in `.gitignore` for the reason above —
leave it there. `firebase use` with no arguments shows which project you are currently pointed at, which
is worth checking before any deploy that matters.

## Deploying (and why plain `firebase deploy` may fail)

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
violation counts described under [Violation reports](README.md#violation-reports); the Report-Only header
still works, so you can still watch violations in DevTools while you soak the policy.

Firebase config is stored in browser localStorage. Share a pre-configured URL to onboard users without manual setup.

## Firefox: "Sign in with Google" fails (third-party cookies)

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
