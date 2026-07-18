# Apps Script Deployment

## Setup (one-time, ~5 minutes)

### 1. Create the script

1. Go to https://script.google.com
2. Click **New project**
3. Rename to your app name

### 2. Add files

In the Apps Script editor, create these files:

| Script editor file | Source |
|-------------------|--------|
| `Code.gs` (default) | `apps-script/Code.gs` |
| `sheets-helpers.gs` | `apps-script/sheets-helpers.js` (add as **+ → Script**) |
| HTML: `index` | `apps-script/index.html` |
| HTML: `ui` | `ui.html` |
| HTML: `style` | `style.html` |
| HTML: `backend-appscript` | `apps-script/backend-appscript.html` |
| HTML: `columns` | `columns.js` ⚠ wrap |
| HTML: `access-features` | `access-features.js` ⚠ wrap |
| HTML: `list-access` | `list-access.js` ⚠ wrap |
| HTML: `calendar` | `calendar.js` ⚠ wrap |
| HTML: `rotation` | `rotation.js` ⚠ wrap |
| HTML: `rows` | `rows.js` ⚠ wrap |
| HTML: `embeds` | `embeds.js` ⚠ wrap |
| HTML: `print` | `print.js` ⚠ wrap |
| HTML: `pivot` | `pivot.js` ⚠ wrap |
| HTML: `rsvp` | `rsvp.js` ⚠ wrap |
| HTML: `schema-loader` | `schema-loader.js` ⚠ wrap |
| HTML: `app-core` | `app-core.js` ⚠ wrap |

To add HTML files: click **+** → **HTML file** → enter name (without `.html`)

> ⚠ **wrap**: the app's code files are plain `.js` in the repo (the web loader uses real
> `<script src>` tags so a Content-Security-Policy needs no `'unsafe-inline'`). Apps Script can only
> include HTML files, so when pasting a `.js` source into its HTML file, wrap the whole content in
> `<script>` … `</script>` tags. `index` includes them in dependency order — keep that order if you
> rename files.

### 3. Create a Drive folder

1. In Google Drive, create a folder for your app data
2. Upload `schema.json` to this folder
3. Copy the folder ID from the URL (the part after `/folders/`)

### 4. Deploy

1. Click **Deploy** → **New deployment**
2. Type: **Web app**
3. Execute as: **User accessing the web app** (each user uses their own permissions)
4. Who has access: **Anyone** (or restrict to your organization)
5. Click **Deploy**
6. Copy the web app URL — share this with users

### 5. First visit

Users will see:
1. Google authorization prompt (one-time) — click **Allow**
2. Setup screen — select "Sheets" mode, paste the Drive folder ID
3. App loads with tables defined in schema.json

## Updating

After code changes:
1. Update the files in the script editor (paste from local files)
2. Reload the `/dev` URL to test immediately (no deployment needed)
3. For production URL: **Deploy** → **Manage deployments** → pencil → **New version** → **Deploy**

**Tip:** The `/dev` test URL (`Run as → Test deployment`) serves files directly from the editor without a new version. Changes take effect on reload.

## Schema changes

Edit `schema.json` in your Drive folder. The app reads it fresh on each boot. New tables are auto-created as spreadsheets.

## Translations

Languages are managed in-app via the Languages tab:
1. Go to Languages tab → Add language
2. Fill in translations for each key
3. Translations are stored as sheets in a language spreadsheet in your Drive folder

## Permissions model

- **Folder access** = app access: share the Drive folder with users
- **Editor** = read + write all tables
- **Viewer** = read-only access
- **Per-table**: share individual spreadsheets for granular access
- **OAuth consent screen**: add each user's email under Test users (Google Cloud Console → APIs → OAuth consent screen)

## Limitations

- `google.script.run` serialization: no Date objects, no parallel calls (max 1-2)
- Payload size: ~50KB per response (archive tabs loaded lazily)
- Template literals with nested quotes get corrupted in editor (use ES5 concatenation)
- Arrow functions and const/let work fine in .html files (run in user's browser)

## Alternative deployments

The same app-core.html + ui.html + style.html work on:

| Hosting | Backend | Notes |
|---------|---------|-------|
| Apps Script | Sheets (google.script.run) | This guide |
| Any static host | OAuth (REST API) | Needs Google Cloud OAuth setup |
| Any static host | CRDT (IndexedDB + Drive) | Offline-first, 30s sync |
| Any static host | Firebase (Firestore) | Real-time, no OAuth consent needed |
| localhost:3000 | SQLite (dev server) | `cd dev && npm start` |
