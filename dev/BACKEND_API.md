# Backend API Contract

Every backend adapter must implement these methods. The app (`app-core.html`) calls them
via the global `backend` object. All return Promises (except `backend-local.js` which is
synchronous — the local-client HTTP adapter wraps it in Promises).

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
| `bootData(folderId)` | Apps Script batch path | Returns `{schema, tableMap, languages, lists, data, tableOrder?, columnOrders?}`. If present, skips sequential loading. |
| `getAvailableTables(folderId)` | Setup wizard (detect existing tables) | Returns `[{id, name}]`. OK to return `[]` if not applicable (Firebase/CRDT). |
| `getUsers(folderId)` | User access panel | Returns `[{key, addr, role, tables}]`. |
| `setUserRole(folderId, key, role, email, tables)` | User management | |
| `removeUser(folderId, key)` | User management | |
| `readFile(folderId, name)` / `writeFile` / `deleteFile` | CRDT transport layer | Generic named-file store. |
| `saveChangesets` / `loadChangesets` | CRDT sync | |
| `getFileModifiedTime(folderId, name)` | CRDT cache invalidation | |

## Notes

- Return value inconsistencies between backends are tolerated by the caller (defensive checks).
- `deleteRow` may return a boolean (local) or void (others) — the value is never used.
- `createLanguage` may return a code/id — the value is never used.
- List values MUST be strings. Non-string values are silently dropped by `saveLists`.
- `getTableData` may return a JSON string — the caller parses it via `parseTableResult()`.
