# Firebase

Firestore as the database, Firebase Auth for sign-in, `firestore.rules` and `storage.rules` as the
access policy. The only backend with an offline cache.

| File | Role |
|---|---|
| `backend-firebase.js` | The platform: sign-in (Google, emailed link), live updates, uploads. Builds on `backend-kv.js`. |
| `storage-firestore.js` | Reads and writes Firestore documents. |
| `firestore.rules` | Who may read and write each collection. |
| `storage.rules` | Uploads (registered users, own folder, size and type caps) and calendar feeds (full-access members). |
| `dev/test-emulator/firestore-rules.mjs` | The rules against the Firestore emulator (`npm run test:rules`). |
| `dev/test-ui/firebase-emulator.spec.js` | The app against the emulators (`npm run test:e2e-firebase`). |

## Setup

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Enable Firestore and the Google sign-in provider (for email sign-in see below).
3. Add every origin the app is served from to Authentication → Authorized domains (`127.0.0.1` for dev,
   your site's host). An unlisted origin fails with `auth/unauthorized-domain`.
4. Register a web app and copy its config.
5. Publish the rules: paste `firestore.rules` in Firestore → Rules, or deploy them (below).
6. Open the app, choose Firebase, paste the config, and **sign in right away**: the first account becomes
   the admin.
7. Install an example, or Settings → Import.

## Email sign-in

Firebase sends the sign-in links itself, from `noreply@<project>.firebaseapp.com`; there is no mail
server to set up. The rules count only verified emails.

```bash
cd dev
npm run firebase:auth -- --project <project-id> --site https://example.org/ --deploy-rules
```

This turns on Email link (passwordless) sign-in, adds the site and `localhost` to the authorized domains,
and deploys the rules. It needs the Google Cloud CLI (`gcloud auth login`). By hand: Authentication →
Sign-in method → Email/Password → Email link.

## Deploying

A clone names no project. Link yours once; `.firebaserc` is gitignored so a fork never deploys to yours:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
```

Then deploy the rules first, the site second:

```bash
firebase deploy --only firestore:rules,storage
firebase deploy --only hosting
```

- The hosting `predeploy` fetches `vendor/` and builds `_site/`. It fails if `vendor/versions` was changed
  without `./update-vendor.sh`.
- **On the free (Spark) plan, always use `--only`.** A bare `firebase deploy` also deploys `functions/`
  (the CSP report collector), which needs the Blaze plan. Without it, `/csp-report` simply 404s.

## Firefox and Safari: Google sign-in fails on another host

When the app is not on Firebase Hosting, Firebase's sign-in handler on `<project>.firebaseapp.com` is a
third party, and Firefox's Total Cookie Protection (and Safari's ITP) block it.

- A user can turn off Enhanced Tracking Protection for the site (the shield icon), or allow cookies for
  `https://<project>.firebaseapp.com`.
- The real fix is Firebase Hosting with the app's own domain, which makes the handler first-party. A
  custom domain on GitHub Pages does not.
