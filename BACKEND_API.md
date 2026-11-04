# Backend API

The methods every backend implements. `app-core.js` calls them on the global `backend` (and
`backend_users`). All return promises; the dev SQLite backend is synchronous and its HTTP client wraps it.

- `backend-kv.js` is the contract over a key-value store. `backend-supabase.js`, `backend-local-pglite.js`
  and `backend-firebase.js` supply only a *platform* (identity, live updates, uploads); Firebase also
  overrides the methods where Firestore differs. A new key-value host writes a platform: see the `P`
  contract at the top of `backend-kv.js`.
- The dev server is the other implementation: `dev/backend-local.js` behind `dev/backend-local-client.js`.
- `dev/test/backend-conformance.test.js` holds the **Required** list (`CONTRACT`) and fails a backend that
  misses one. **Optional** methods degrade a feature when absent; the app checks before calling.

## Required

| Method | Returns | Notes |
|---|---|---|
| `getSchema()` | schema object, JSON string or `null` | `null` is a first boot. |
| `saveSchema(schema)` | — | Also writes the schema-derived mirrors the access policy reads. |
| `initSchema(tables)` | — | Creates per-table storage where needed up front (dev SQLite). |
| `validateFolder(id)` | `{valid, name}` | The dev-server probe: is there a database here? |
| `getFolderConfig()` / `setFolderConfig(config)` | object or `null` | App config stored beside the data. |
| `getTableData(tableId, partition, opts?)` | `{headers, rows}` | `partition` is `'active'` or `'archive'`. `opts.constraints` may narrow the read; ignoring it is allowed (the caller re-filters), returning fewer rows is not. |
| `putRow(tableId, row, partition)` | — | Upsert by `row.id`. **Merges** onto the stored row. |
| `deleteRow(tableId, rowId, partition)` | — | No-op if absent. |
| `moveRow(tableId, row, from, to)` | — | Delete then put; not atomic. Only restoring a legacy `__archive` row uses it. |
| `getLists()` / `saveLists(lists)` | `{listName: string[]}` | `saveLists` replaces; values must be strings. |
| `putListItem(listName, value)` | — | Appends one value. |
| `getAvailableTables()` | `[{id, name}]` | `[]` where it does not apply. |
| `getAvailableLanguages()` | `[{code, name}]` | |
| `getTranslations(code)` | `{key: string}` or `null` | |
| `updateTranslations(code, strings)` | — | Merges. |
| `deleteTranslations(code, keys)` | — | Absent keys and a missing language are a no-op. |
| `createLanguage(code, name, keys)` | — | Seeds the keys and keeps strings already stored. |
| `deleteLanguage(code)` | — | |

## Optional

| Method | Notes |
|---|---|
| `bootData()` | One round trip: `{schema, languages, lists, data, tableOrder?, unrestricted}`. |
| `subscribeTable(tableId, partition, onChange)` | Live updates; see below. Returns an unsubscribe function. |
| `renameLanguage(code, name)` | Renames the index entry only. |
| `getPage(name)` | `{markdown}` or `null`; never rejects. |
| `getAsset(id)` | `{src}` (a data URI) or `null`; never rejects. |
| `uploadFile(file, opts)` | Resolves the URL to store. `opts.path` asks for a stable path overwritten in place (calendar feeds); `opts.contentType` is served. Absent: the app takes a pasted URL. |
| `listFiles(prefix)` | Every stored path under `prefix`, paged to the end; rejects on failure. Backs the feed orphan sweep. |

### Identity, access and profiles (`backend_users`)

The split by audience matters: a member must never be answered by the admin's roster read.

| Method | Audience | Returns |
|---|---|---|
| `getMyAccess()` | the caller | `{role, tables}`, `{registered: false}` or `{bootstrap: true}`. A denied read resolves `{registered: false}`. |
| `getUsers()` | admin | `{email: {role, user, tables}}` |
| `setUserRole(key, role, email, tables)` | admin | Build the record with `BackendHelpers.userGrantDoc`, which keeps the stored identity and adds `rwTables`. |
| `removeUser(key)` | admin | |
| `requestAccess(name, note)` | signed in | Writes `{email, name, note, ts}` for the caller's own address. |
| `selfRegister()` | signed in, no record | Open sign-up: the caller's own record with exactly the schema's `newUser` grant. |
| `getAccessRequests()` / `removeAccessRequest(email)` | admin | |
| `getMyProfile()` / `setMyProfile(name, shared, picture)` | the caller | `shared` opts into showing the name. |
| `setProfileName(email, name)` | admin | Merges the name only. |
| `getProfiles()` | admin | Every profile. |
| `getSharedNames()` / `getSharedProfiles()` | any member | Opted-in profiles only; never an email the caller could not already read. |

### User-linked lists

| Method | Audience | Returns |
|---|---|---|
| `getListUserLinks()` | admin | `{list: {value: email}}` |
| `getMyListValues()` | the caller | `{list: myValue}`, what `@me` resolves to. |
| `setListUser(list, value, email)` | admin | An empty `email` unlinks. |
| `getListAvatars()` | any member | `{list: {value: picture}}`, no emails. |

## Live sync (`subscribeTable`)

```js
subscribeTable(tableId, partition, onChange) -> unsubscribe
onChange({ type: 'put' | 'delete', id, row })   // row: the whole stored row, or null
```

- `row` is the stored row after the write, never the request payload.
- Deliver only what the caller could read, as `getTableData` does. Firestore listens with the same
  owner-scoped queries; the dev server filters per subscriber.
- Errors mean no live updates; never throw out of a callback.

The client side is `live-sync.js`. Changes arriving while a cell is being edited are held and applied
when it loses focus.

## Partial writes and grants

- `putRow` merges (pinned by the conformance suite), so a cell edit sends only `{id, <column>,
  updated_at}`. Access checks judge the merged row: Firestore does so natively, Supabase merges in
  `app_kv_merge`, the dev server builds it before its checks.
- A grant's `tables` is `'all'`, a legacy array (read and write on each) or `{table: 'r' | 'rw'}`. Read it
  through `AccessFeatures.grantMode`, `readableTables` and `writableTables` (`null` = unrestricted); never
  branch on the shape.
