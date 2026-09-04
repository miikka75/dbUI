# Backend API Contract

Every backend adapter must implement these methods. The app (`app-core.js`) calls them
via the global `backend` object. All return Promises (except `backend-local.js` which is
synchronous — the local-client HTTP adapter wraps it in Promises).

`dev/test/backend-conformance.test.js` holds the machine-readable version of the **Required** table
below (its `CONTRACT` array) and fails a backend that is missing one. Everything under **Optional** is
per-feature: absent means the feature degrades, not that the backend is broken — the app checks for the
method before calling it.

Implementations: `backend-kv.js` (the reference — one contract over a key-value table, run by BOTH
`backend-supabase.js` and the browser-local `backend-local-pglite.js`, which supply only a *platform*:
identity, realtime, uploads), `backend-firebase.js`, and the dev-server pair `backend-local.js` /
`backend-local-client.js`.

A new key-value host therefore writes a platform, not a backend — see the `P` contract documented at the
top of `backend-kv.js`. `dev/test/backend-conformance.test.js` pins that split: a platform file that grows
its own copy of a contract method fails the suite.

## Required Methods

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `getSchema()` | `() → Promise` | `object \| string \| null` | Schema JSON. String is auto-parsed. Null = first boot. |
| `saveSchema(schema)` | `(object) → Promise` | void | Fire-and-forget. |
| `initSchema(tables)` | `(object) → Promise` | ignored | Creates storage for each table where that is needed up front (dev SQLite/JSON). Table ids ARE table names on every backend, so nothing is returned. |
| `validateFolder(id)` | `(string) → Promise` | `{valid: boolean, name: string\|null}` | Dev-server probe: does a database exist here? The only method still taking a handle -- every other one addresses the single database implicitly. |
| `getFolderConfig()` | `() → Promise` | `object \| null` | App-level config stored alongside data. |
| `setFolderConfig(config)` | `(object) → Promise` | void | |
| `getTableData(tableId, partition, opts?)` | `(string, string, object?) → Promise` | `{headers: string[], rows: object[]}` | Partition: 'active' or 'archive'. `opts.constraints` (from `query.js`) may narrow the read in the database. **Optional to honour**: ignoring it returns a superset, which the caller re-filters with the residual, so a backend that cannot query stays conformant. It must never return FEWER rows than the constraints describe. |
| `putRow(tableId, row, partition)` | `(string, object, string) → Promise` | void | Upsert by row.id. |
| `deleteRow(tableId, rowId, partition)` | `(string, string, string) → Promise` | void | No-op if not found. Return value discarded. |
| `moveRow(tableId, row, fromPartition, toPartition)` | `(string, object, string, string) → Promise` | void | Delete from source + put to target. **Not atomic** — a failure between the halves loses the row. Archiving no longer uses it (it stamps `_status` instead); the only remaining caller is restoring a row still held in a legacy `__archive` collection. |
| `getLists()` | `() → Promise` | `{listName: string[]}` | All dropdown lists. |
| `saveLists(lists)` | `(object) → Promise` | void | Full replacement. Values must be strings. |
| `putListItem(listName, value)` | `(string, string) → Promise` | void | Append single value. |
| `getAvailableTables()` | `() → Promise` | `[{id, name}]` | Setup wizard (detect existing tables). Required to EXIST — returning `[]` is the right answer where it does not apply (Firebase). |
| `getAvailableLanguages()` | `() → Promise` | `[{code, name}]` | Extra fields (fileId) allowed, ignored by caller. |
| `getTranslations(langCode)` | `(string) → Promise` | `{key: string} \| null` | Null = no translations for that language. |
| `updateTranslations(code, translations)` | `(string, object) → Promise` | void | |
| `createLanguage(code, name, keys)` | `(string, string, string[]) → Promise` | void | Return value discarded. |
| `deleteLanguage(code)` | `(string) → Promise` | void | |

## Optional Methods

| Method | When used | Notes |
|--------|-----------|-------|
| `bootData()` | One-round-trip boot | Returns `{schema, languages, lists, data, tableOrder?, columnOrders?}`. If present, skips sequential loading. Implemented by Firebase and Supabase. |
| `subscribeTable(tableId, partition, onChange)` | Live sync between clients | Returns an **unsubscribe function**. Absent = no live updates (manual refresh only); implemented by Firebase, Supabase and the dev-server backends. See **Live sync** below. |
| `renameLanguage(code, name)` | Languages tab | Renames the entry in the languages index only; the translations document is untouched. |

### Reads of the system stores

Rows in `_pages` / `_assets` are written through the ordinary `putRow` (they are stores, not schema
tables), but reading one by id is its own method so a backend can answer from a document get rather
than a whole-table scan.

| Method | When used | Notes |
|--------|-----------|-------|
| `getPage(name)` | Doc-view bodies | `{markdown} \| null`. Missing or denied must resolve `null`, never reject. |
| `getAsset(id)` | View backgrounds, image cells | `{src} \| null` — a data URI. Same rule: `null`, never reject. |
| `uploadFile(file, opts)` | `image` / `url` column uploads, and calendar feeds | Resolves the **URL to store in the row**; the bytes go to the host's object store. Absent = the app falls back to pasting a URL by hand. `opts.path` asks for a STABLE path overwritten in place (a feed's URL is a subscription and must not move); without it the impl picks a unique one, so an image never collides. `opts.contentType` is stored on the object and is what the public URL serves. |

### Identity, access and profiles

The registry methods split by AUDIENCE, and the split is load-bearing: an admin roster read is denied
to everyone else, so a member needs a self-scoped call for the same facts about themselves. A backend
that answers the admin call for non-admins leaks the whole membership list.

| Method | Audience | Returns |
|--------|----------|---------|
| `getMyAccess()` | the caller | `{role, tables}`, `{registered: false}`, or `{bootstrap: true}` when no users exist yet. Fails **closed**: a denied read resolves `{registered: false}` rather than rejecting. |
| `getUsers()` | admin | `{email: {role, user, tables}}`. See **grant shapes** below. |
| `setUserRole(key, role, email, tables)` | admin | Build the record with `BackendHelpers.userGrantDoc(...)` — it also denormalizes `rwTables`, which the rules layers need. |
| `removeUser(key)` | admin | |
| `requestAccess(name, note)` | any signed-in caller | Writes exactly `{email, name, note, ts}` for their OWN address. Inert until an admin approves it. |
| `getAccessRequests()` | admin | `{email: {email, name, note, ts}}` |
| `removeAccessRequest(email)` | admin | Approve or deny both end here. |
| `getMyProfile()` | the caller | `{name, shared, picture}` |
| `setMyProfile(name, shared, picture)` | the caller | `shared` is the opt-in that publishes the display name. |
| `setProfileName(email, name)` | admin | Merge-writes the name only, leaving the share flag alone. |
| `getProfiles()` | admin | `{email: {name, shared, picture}}` — every profile. |
| `getSharedNames()` | any member | `[name]`, opted-in only. Backs a `"users"` list. |
| `getSharedProfiles()` | any member | `{email: {name, picture}}`, opted-in only. **Never carries an email to a caller who could not already read it.** |

### User-linked lists (`listSources: "userlink"`)

| Method | Audience | Returns |
|--------|----------|---------|
| `getListUserLinks()` | admin | `{list: {value: email}}` — the raw map, for the Lookup editor. |
| `getMyListValues()` | the caller | `{list: myValue}`. The equality query on the caller's own email that lets `@me` resolve to a curated list value. Must be answerable to any member; the map above must not. |
| `setListUser(listName, value, email)` | admin | Empty `email` unlinks. |
| `getListAvatars()` | any member | `{list: {value: pictureUrl}}` — the avatar projection, which carries no email. |

## Live sync (`subscribeTable`)

Without it, a client shows the data it fetched at boot until the user hits refresh or reloads —
nothing pushes another client's writes. A backend that can push implements:

```js
subscribeTable(tableId, partition, onChange) -> function unsubscribe
onChange({ type: 'put' | 'delete', id: <rowId>, row: <full row | null> })
```

Rules for an implementation:

- **`row` is the whole row as stored, not the change.** Subscribers apply it as that row's new state.
  With partial writes (see below) this means re-reading or using the transport's post-image, never
  echoing the request payload.
- **Deliver only what the caller could have read.** The subscription is a read path and must carry the
  same access scoping as `getTableData` — `backend-firebase.js` mirrors `_scopedRead`'s constrained
  queries (Firestore rules are not filters, so an unconstrained listener for a self-service member is
  denied outright and silently never fires); the dev server filters each event per subscriber.
- **One transport, many tables.** Supabase multiplexes every store over one `kv` realtime channel and
  the dev client over one `EventSource`; only Firestore needs a listener per collection.
- Errors degrade to "no live updates". Never throw out of a change callback.

The client side is `live-sync.js` (pure reconciler) plus `_liveWatch`/`_liveHeld`/`_liveFlush` in
`app-core.js`. Subscriptions are opened for the tables of the view being opened and kept for the
session; changes arriving while a cell is focused or a save is in flight are queued and applied on
blur, because the inline cell renders straight off the cached row object and has no draft buffer.

### Partial writes

`putRow` **merges** — this is pinned for every backend by the `putRow merge semantics` suite in
`dev/test/backend-conformance.test.js`. Cell edits therefore send only `{ id, <changed col>,
updated_at }`, so two clients editing different columns of one row no longer overwrite each other.

Consequences for a backend or server that gates writes: judge the **merged** row, not the payload. The
owner column that authorizes a self-service write lives on the stored row, not in the patch. Firestore
gets this for free (`request.resource.data` is the merged document under `set(…, {merge: true})`),
Supabase merges server-side via the `app_kv_merge` RPC, and `dev/server.js` builds the merged row
explicitly before its ownership and `ownerWritable` checks.

## Notes

- Return value inconsistencies between backends are tolerated by the caller (defensive checks).
- `deleteRow` may return a boolean (local) or void (others) — the value is never used.
- `createLanguage` may return a code/id — the value is never used.
- List values MUST be strings. Non-string values are silently dropped by `saveLists`.
- `getTableData` may return a JSON string — the caller parses it via `parseTableResult()`.

### Grant shapes (`tables`)

A user's `tables` value is `'all'`, a **legacy** array of names (read + write on each), or a map
`{ table: 'r' | 'rw' }`. Never branch on the shape yourself — `AccessFeatures.grantMode(tables, t)`,
`.readableTables(tables)` and `.writableTables(tables)` normalize all three (`null` = unrestricted,
`[]` = none). A backend that scopes its own reads (`_myTables`) must use the **readable**
set; write gates use the **writable** one. Records written through `BackendHelpers.userGrantDoc` carry
an extra `rwTables` array for the map shape only — the rules layers can't filter a map, so they read
that list, falling back to plain membership when it's absent. See `## Access modes` in SCHEMA.md.
