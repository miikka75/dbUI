# Code Review — dbUI (2026-07-17)

Full-repository review: correctness, security, performance, dedup, architecture, and schema-format
soundness. Items marked **[FIXED]** were addressed on this branch; everything else is a recommendation.

**Overall:** well-architected for a no-build app. The extraction of pure modules (`columns.js`,
`rows.js`, `embeds.js`, `list-access.js`, `access-features.js`) with Node tests, the 16-function
backend interface with conformance tests, and the unified CRDT engine are genuinely good design.
The findings below are ordered by severity within each section.

---

## 1. Bugs (correctness)

**B1 [FIXED] — Dead validation from a botched rename** — `schema-loader.html:200`
`def.partitionle` (a `tab→partition` search/replace mangling of `def.table`) meant ref-column
targets were **never validated**; a `ref` pointing at a missing table passed `validateSchema()`.

**B2 [FIXED] — Ignored status code** — `dev/server.js`
`json(res, {...}, 403)` in `saveConfig` — `json()` only accepted `(res, data)`, so the rejection
returned **200** with an error body. `json()` now takes an optional status.

**B3 [FIXED] — `putListItem` used the wrong access model** — `dev/server.js`
`checkTableAccess(body.listName)` treated the *list name* as a *table id*: restricted editors were
denied adding items to lists they own, and a list named like a granted table was writable regardless
of ownership. Now uses `listOwningTables` — the same ownership model as `saveLists`.

**B4 [FIXED (hardened)] — `noUsers()` is a permanent trap** — `firestore.rules`
Bootstrap detection is `!exists(/_meta/users)`. Per-user access migrated to `/_users/{email}`, but
the legacy `_meta/users` doc is load-bearing forever: deleting it (a natural post-migration cleanup)
would flip `noUsers()` true and hand **every signed-in Google account full admin** while `/_users`
docs still exist. The rules now forbid deleting `_meta/users` (even by admins — reset by overwriting
with `{}` instead), with an emulator test. Longer-term: a dedicated bootstrap marker.

**B5 — `putRow` semantics diverge across backends**
SQLite (`INSERT OR REPLACE`; missing columns → `''`) **replaces**; storage-fs (`Object.assign`),
Firestore (`merge:true`) and the CRDT engine **merge**. Today's callers send full rows so it's
latent, but any future partial `putRow` silently wipes fields on SQLite only. Pin the intended
semantics in the backend-conformance test.

**B6 [FIXED] — `resetData` LIKE-pattern hazards** — `dev/backend-local.js`
`name LIKE 'name%'` over-matched: table `task` dropped `tasks__active`, and `_` is a LIKE
single-char wildcard. Now matches the exact name plus escaped `name\_\_%` partitions.

**B7 — `_pages` invisible to restricted users** — `firestore.rules` + `loadPage`
Doc-view bodies live in `_pages__active`, gated by `hasTableAccess('_pages')` — but `_pages` is
never part of any grant (`access-features.js` doesn't emit it). A restricted member's read is
denied, `loadPage`'s empty `.catch` swallows it, and they silently see the stale schema-seeded
markdown instead of the edited document; editors without `tables:'all'` can't save pages either.
Either add `_pages` to grant closures or give it its own rule.

**B8 [FIXED] — Implicit global** — `app-core.html`
`missing = true` in the list seeder (never declared, never read) removed.

**B9 — Drive query interpolation** — `transport-drive.html:21,75,83`
File/folder names (language codes, table names — schema/user-controlled) are interpolated into
Drive `q` strings without escaping `'`. A name with a quote breaks sync. Escape or reject.

---

## 2. Security

**S1 [FIXED] — Storage bucket was open to any Google account** — `storage.rules`
Write required only `request.auth != null` + matching email folder — registration was not checked.
With the Google provider enabled, any Google account (given the config, which shareable links
distribute by design) could use the bucket as free image hosting: unlimited 10 MB files, readable by
all signed-in users. Writes/deletes are now gated on registration via a cross-service Firestore
lookup (`/_users` doc, legacy `_meta/users` map fallback), with emulator tests for the deny
(unregistered) and both allow paths. Note: running `npm run test:storage-rules` now needs both
emulators (script updated) and a `firebase.json` (added — minimal; extend with your hosting config).

**S2 — Admin-bootstrap race**
The first signer-in becomes admin. Anyone who obtains the share link before the intended admin
signs in owns the database. Mitigation: seed the admin `/_users` doc as a documented setup step
before sharing the link.

**S3 [FIXED] — Stored XSS in the print window** — `app-core.html`
`_printOpen` wrote `title` unescaped into `document.write` (`<title>`), and `printView` built
`'<h2>' + title + '</h2>'` unescaped — while the rotation branch and `printCard` escaped. `title`
comes from `t(...)`: translations are editor-writable shared data, so an editor could run script in
another user's (same-origin) print window. `_printOpen` now escapes the title itself; the `<h2>` is
escaped; `printCard` no longer double-escapes. The rest of the XSS story is good: `mdToHtml`
escapes first, `safeUrl`/`safeImgSrc` are well-reasoned and tested, `v-html` only ever receives
`mdToHtml` output.

**S4 [FIXED] — Editor could clobber the legacy lists doc** — `firestore.rules`
`doc == 'lists' && role() == 'editor'` let any editor overwrite the *entire* legacy `_meta/lists`
map, including lists owned by tables outside their grants — exactly what the per-list `_lists` rule
prevents. Since `_lists` is the source of truth (editors write per-list docs), the branch is
dropped, with an emulator test.

**S5 — OAuth scope too broad** — `auth-oauth.html`
`https://www.googleapis.com/auth/drive` grants the user's **entire Drive**; the app only touches
its own folder. Use `drive.file`. (Token in `sessionStorage` is XSS-readable — acceptable for this
class of app, but it raises the stakes on findings like S3.)

**S6 — No SRI / CSP on CDN scripts** — `index.html`
Vue/Vuetify fall back to jsdelivr; Firebase/GSI load from CDNs — no `integrity` hashes, no CSP.
For an app whose security model lives client-side, a compromised CDN is game over.

**S7 — Rules edge cases**
`selfServiceTable()` bounds owner-*create* only; owner-update/delete work on any collection (low
impact — the row must already carry `owner == me`). `_access_requests` create has no shape/size
validation (unlike the nicely validated `_profiles`) — add `keys().hasOnly(...)` + size caps.

**S8 — Dev server nits** (all loopback-mitigated and clearly documented)
`uploadFile` keeps the original extension, so an uploaded `evil.html` is served as `text/html` on
the dev origin; `getUsers`/`getProfiles`/`getAccessRequests` have no role gate (Firestore makes them
admin-only). The `ALLOW_INSECURE_HOST` loopback-bind guard is genuinely good work.

**S9 — CRDT trusts peer timestamps**
LWW uses device wall-clock `Date.now()`; a skewed (or future-dated) clock silently wins every merge.
Document it or clamp incoming `ts` to `now + ε`.

---

## 3. Performance

**P1 [FIXED] — Schema re-parsed on every read** — `dev/backend-local.js`
`msMultiCols()`/`_listOwning()` re-`SELECT`ed and re-`JSON.parse`d the whole stored schema on every
`getTableData`/list write — O(tables × schema size) per boot. Now parsed once and invalidated on
`saveSchema`/`resetData` (public `getSchema` still returns a fresh parse since callers may mutate).

**P2 — Serial fetches where parallel is safe**
The non-`bootData` boot path loads tables one at a time (the Firebase path proves `Promise.all` is
fine); `importData` issues delete+put **per row, serially** (a 1,000-row import = 2,000 sequential
round-trips); `CrdtEngine.mergeChanges` chains one IDB op per *field change* (slow first-device
bootstrap); `TransportDrive.pullChangesets` downloads files one by one.

**P3 — Changesets and tombstones grow forever**
Tombstones are never GC'd, and every 30 s sync re-downloads every peer's full changeset file (the
interface's `getFileModifiedTime` is unused here). Add an mtime/cursor check and periodic compaction.

**P4 — Doc-view render path re-runs the row pipeline**
`mdBlocks`' hide-when-empty and `docHasData` call `embedRows()` — a full
build→aggregate→computed→sort pass — per token per evaluation. Memoize per (view, data generation).

**P5 — Apps Script `putRow`** reads the full data range per save to locate the row; a `TextFinder`
on the id column is much cheaper. (Credit: `bootData` batching and `columns.js`' WeakMap-memoized
`scanSchema` show performance is already a design concern.)

---

## 4. Dedup / simplification

- `startApp`'s two paths duplicate the list auto-seed and default-language/translation-load blocks
  → extract `_seedSchemaLists()` / `_loadStrings()`.
- `exportData` duplicates the entire stringify/Blob/anchor/download dance in `then` and `catch`.
- The lowercased current-user-email expression is copy-pasted 6× in `backend-firebase.html` →
  one `_myEmail()`.
- `loadTableData` repeats the "fetch table if uncached, fail-closed on access" block 5× →
  `_ensureCached(tables, onLoad)`.
- `addRefParent`/`addRefChild`/`addRefRow` hand-roll blank-row creation that `_createBlankRow`
  exists to unify (its own comment: "every add path goes through here").
- `dev/schema.js` re-implements `_normalizeSchema`'s colMap/implicit-id logic — the same drift class
  `list-access.js` was extracted to kill.
- Dev-server user lookup (`Object.values(_users).find(v => v.user === email)`) appears in
  `getAllowedTables` and `getMyAccess` with subtly different fallbacks — that asymmetry is a latent
  access bug.

---

## 5. Architecture

**Strengths:** pure-module extraction with runtime-bound globals documented; one comparator
(`compareValues`), one condition engine (`condMatches`), one blank-row factory; registry-driven view
parts; the projectId-confirm guard on shared links; the loopback-bind refusal; emulator rules tests.

**Concerns:**
1. **The access model is implemented three times** — `firestore.rules`, `dev/server.js`, client UI.
   B3/S8 are live drift. The rules-emulator and Playwright suites are **not in CI**
   (`node.js.yml` runs `npm test` only) — the security model is the least-guarded layer. Add them.
2. **Global mutable state** (`SCHEMA`/`VIEWS`/`window._listsCache`/`appInstance` + `ROOT_PROXY`) is
   a pragmatic no-build choice, honestly documented, but the Node-gotcha comments in
   `rows.js`/`embeds.js` are symptoms. A single explicit context object would remove the class.
3. **Bespoke module loader**: `fetch` + regex `execScript` executes only the first `<script>` per
   fragment and precludes SRI. Native ES modules work without a build step; isolate the Apps Script
   sandbox constraint instead of shaping the whole app around it.
4. **Schema-blind rules + `_meta/ownerTables` mirror** is clever but derives security state
   client-side on `saveSchema`; a schema write that bypasses it leaves the mirror stale. Consider a
   server-side trigger or a rules-side freshness check.
5. `firebase.json` was referenced by the README but never committed — the storage-rules test could
   not run from a fresh clone. A minimal one is now committed (extend with your hosting config).

---

## 6. Is the JSON schema sound / industry-standard?

**Design soundness: largely yes.** Single JSON source of truth; views discriminated by which field
they carry; explicit `nav`; implicit `id` documented; legacy forms migrated at load. Weak points:

- **Presence-based view kinds** (`sources` vs `markdown` vs `rotation`…) make invalid combinations
  representable, and `validateSchema` doesn't reject them (`markdown`+`sources` is deliberately a
  doc-with-self, which makes the valid matrix subtle). An explicit `"kind"` discriminator — the
  standard tagged-union shape — would make invalid states unrepresentable.
- **Dual column shapes** (authored array-of-objects vs runtime name-keyed map, plus `'text'` string
  shorthand) force every consumer to branch — the `Array.isArray(cols) ? … : …` dance appears in at
  least six modules. Export already canonicalizes to arrays; converge readers on one normalized
  shape right after load.
- **No `schemaVersion` field.** Migrations are heuristic shape-sniffing; a version stamp makes them
  deterministic and lets legacy handlers eventually be deleted.

**Industry standard (JSON Schema): no — and it should be adopted for validation.** Validation is
hand-rolled and demonstrably incomplete: B1 silently killed ref validation, column `type` values are
never validated (a typo'd type degrades to `text`), unknown keys are never flagged. Recommendation:
author a JSON Schema (draft 2020-12) meta-schema (`schema.schema.json`) covering structure and enums
(column types, pickers, layouts, `additionalProperties` control), and use it three ways — `$schema`
reference for editor autocomplete (users hand-edit this file, which is the stated design), ajv
validation of `dev/schema.json` in CI, and at import time. Keep the hand-rolled checks for what JSON
Schema can't express (cross-references, rotation slot/roster arithmetic).

---

## Remaining priorities

1. **Soon:** B7 (`_pages` access), S5 (`drive.file` scope), S2 (seeded admin), CI jobs for the
   rules suites, S6 (SRI/CSP).
2. **When touching the area:** B5, B9, S7, S9, P2–P5, the dedup list, meta-schema +
   `schemaVersion`, column-shape normalization.
