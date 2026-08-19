# Backend API Contract

Every backend adapter must implement these methods. The app (`app-core.js`) calls them
via the global `backend` object. All return Promises (except `backend-local.js` which is
synchronous — the local-client HTTP adapter wraps it in Promises).

Three adapters implement it: `backend-supabase.js` (reference), `backend-firebase.js`, and the
dev-server pair `backend-local.js` / `backend-local-client.js`.

## Required Methods

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `getSchema(folderId)` | `(string) → Promise` | `object \| string \| null` | Schema JSON. String is auto-parsed. Null = first boot. |
| `saveSchema(folderId, schema)` | `(string, object) → Promise` | void | Fire-and-forget. |
| `initSchema(folderId, tables)` | `(string, object) → Promise` | `{tableName: id} \| null` | Creates storage for each table. Returns tableMap (id used in putRow/getTableData). Null = use table names as IDs. |
| `validateFolder(folderId)` | `(string) → Promise` | `{valid: boolean, name: string\|null}` | Validates the storage target exists and is accessible. |
| `getFolderConfig(folderId)` | `(string) → Promise` | `object \| null` | App-level config stored alongside data. |
| `setFolderConfig(folderId, config)` | `(string, object) → Promise` | void | |
| `getTableData(tableId, partition)` | `(string, string) → Promise` | `{headers: string[], rows: object[]}` | Partition: 'active' or 'archive'. |
| `putRow(tableId, row, partition)` | `(string, object, string) → Promise` | void | Upsert by row.id. |
| `deleteRow(tableId, rowId, partition)` | `(string, string, string) → Promise` | void | No-op if not found. Return value discarded. |
| `moveRow(tableId, row, fromPartition, toPartition)` | `(string, object, string, string) → Promise` | void | Delete from source + put to target. Not atomic. |
| `getLists(folderId)` | `(string) → Promise` | `{listName: string[]}` | All dropdown lists. |
| `saveLists(folderId, lists)` | `(string, object) → Promise` | void | Full replacement. Values must be strings. |
| `putListItem(folderId, listName, value)` | `(string, string, string) → Promise` | void | Append single value. |
| `getAvailableLanguages(folderId)` | `(string) → Promise` | `[{code, name}]` | Extra fields (fileId) allowed, ignored by caller. |
| `getTranslations(folderId, langCode)` | `(string, string) → Promise` | `{key: string} \| null` | Null = no translations for that language. |
| `updateTranslations(folderId, code, translations)` | `(string, string, object) → Promise` | void | |
| `createLanguage(folderId, code, name, keys)` | `(string, string, string, string[]) → Promise` | void | Return value discarded. |
| `deleteLanguage(folderId, code)` | `(string, string) → Promise` | void | |

## Optional Methods

| Method | When used | Notes |
|--------|-----------|-------|
| `getAvailableTables(folderId)` | Setup wizard (detect existing tables) | Returns `[{id, name}]`. OK to return `[]` if not applicable (Firebase/CRDT). |
| `getUsers(folderId)` | User access panel | Returns `[{key, addr, role, tables}]`. See **grant shapes** below. |
| `setUserRole(folderId, key, role, email, tables)` | User management | Build the stored record with `BackendHelpers.userGrantDoc(...)` — it also denormalizes `rwTables`, which the server-side rules need. |
| `removeUser(folderId, key)` | User management | |
| `subscribeTable(tableId, partition, onChange)` | Live sync between clients | Returns an **unsubscribe function**. Absent = no live updates (manual refresh only); implemented by Firebase, Supabase and the dev-server backends. See **Live sync** below. |

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
