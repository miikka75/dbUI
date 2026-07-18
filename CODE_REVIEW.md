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

**B5 [FIXED] — `putRow` semantics diverged across backends**
SQLite (`INSERT OR REPLACE`; missing columns → `''`) **replaced** while storage-fs
(`Object.assign`), Firestore (`merge:true`) and the CRDT engine **merge**. SQLite now overlays
partial rows onto the stored values, and the merge contract is pinned in the backend-conformance
test for both Node backends.

**B6 [FIXED] — `resetData` LIKE-pattern hazards** — `dev/backend-local.js`
`name LIKE 'name%'` over-matched: table `task` dropped `tasks__active`, and `_` is a LIKE
single-char wildcard. Now matches the exact name plus escaped `name\_\_%` partitions.

**B7 [FIXED] — `_pages` invisible to restricted users**
Doc-view bodies now have a dedicated `_pages__active` rules block (read: any registered user;
write: admins/editors), mirrored in the dev server, with emulator tests. The page Edit/Save
buttons are also gated on the same roles (viewers previously saw controls whose save would 403).

**B8 [FIXED] — Implicit global** — `app-core.html`
`missing = true` in the list seeder (never declared, never read) removed.

**B9 [FIXED] — Drive query interpolation**
Schema/user-controlled names interpolated into Drive `q` strings are now escaped via
`DriveHelpers.q()` (backslash + quote) in drive-helpers and transport-drive.

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

**S2 [MITIGATED] — Admin-bootstrap race**
The first signer-in becomes admin; anyone holding the share link during the bootstrap window can
claim the role. The README now warns to sign in once before sharing any link. A stronger fix
remains available: seed the admin `/_users` doc at deploy time.

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

**S6 [PARTIAL] — No SRI / CSP on CDN scripts** — `index.html`
The jsdelivr Vue/Vuetify fallbacks are now SRI-pinned (sha384 of the exact npm-package bytes).
Still open: the gstatic Firebase / GSI bundles can't be pinned (Google rotates them in place), and
there is no CSP — adding one needs a carefully tested connect-src/script-src allowlist.

**S7 [FIXED] — Rules edge cases**
Owner-scoped update/delete are now bounded to self-service (owner-column) tables like create, and
`_access_requests` self-creates are shape/size-validated (`keys().hasOnly`, name ≤100, note ≤500,
numeric ts) — both with emulator tests.

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

**P2 [PARTIAL] — Serial fetches where parallel is safe**
Fixed: `CrdtEngine.mergeChanges` now does one storage get/put per **row** instead of per field
change (with a new functional test suite for the engine), and `TransportDrive.pullChangesets`
downloads changesets concurrently — made safe by a single-flight OAuth token refresh (concurrent
401s previously would each have opened a consent popup). Left as-is deliberately: the sequential
boot path and per-row `importData` writes also serve the OAuth **Sheets** backend, whose per-call
rate limits are why they were serialized — parallelize per-backend if needed.

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
   B3/S8 are live drift. **[FIXED]** The rules-emulator suites AND the Playwright E2E suite now run
   as CI jobs (`node.js.yml` `rules` + `e2e` jobs). The e2e job also exercises the SRI-pinned CDN
   fallbacks on every run (vendor payloads are gitignored), so a stale integrity hash fails CI.
2. **Global mutable state** (`SCHEMA`/`VIEWS`/`window._listsCache`/`appInstance` + `ROOT_PROXY`) is
   a pragmatic no-build choice, honestly documented, but the Node-gotcha comments in
   `rows.js`/`embeds.js` are symptoms. A single explicit context object would remove the class.
3. **Bespoke module loader**: **[FIXED]** the `fetch` + regex `execScript` pattern (which injected
   every code fragment as an INLINE script — the blocker for any meaningful CSP `script-src`) is
   gone. All 16 script fragments are now plain `.js` files loaded as real same-origin
   `<script src>` elements; only the markup fragments (`ui.html`, `style.html`) are still fetched
   and injected, which executes no script. The Apps Script deployment keeps working via its
   existing manual paste step (wrap each `.js` in `<script>` tags — DEPLOY.md updated, and its
   stale file list now includes `schema-loader` + the ten domain modules the GAS page was missing).
4. **Schema-blind rules + `_meta/ownerTables` mirror** is clever but derives security state
   client-side on `saveSchema`; a schema write that bypasses it leaves the mirror stale. Consider a
   server-side trigger or a rules-side freshness check.
5. `firebase.json`, `favicon.svg` and `icon-512.png` were referenced by the README (and required
   by the Playwright suite) but never committed — a fresh clone could run neither the storage-rules
   test nor the E2E suite. Minimal defaults are now committed (extend `firebase.json` with your
   hosting config; replace the icons to rebrand). The `vendor/` JS payloads are in the same class
   (only the `versions` manifest was tracked): they are now explicitly gitignored as local artifacts
   of `update-vendor.sh`, `vendor/versions` is re-synced with the `index.html` fallback pin
   (`VUE=3.5.24` vs `vue@3.5.34` had drifted), and `update-vendor.sh` now refreshes the SRI hashes
   on version bumps — without that, any bump would leave a stale hash and the CDN fallback would
   permanently fail its integrity check.

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

1. **Needs a product decision:** S5 — narrowing the OAuth scope to `drive.file` restricts the app
   to files it created or the user picked, which changes the shared-folder onboarding flow; decide
   before switching. CSP (S6 tail) needs a tested allowlist. S9 (clamping peer timestamps) trades
   CRDT convergence guarantees for clock-skew protection — document or redesign, don't patch.
2. **When touching the area:** P3 (changeset compaction/mtime cursor), P4 (doc-view embed
   memoization), P5 (Apps Script TextFinder), meta-schema + `schemaVersion`, column-shape
   normalization. The CSP prerequisite is DONE (the loader now uses real `<script src>` elements —
   no `'unsafe-inline'` scripts needed except index.html's own static boot script, which can be
   hash-allowed); what remains is authoring the policy itself: accept `'unsafe-eval'` for Vue's
   in-browser template compiler, wildcarded Google origins to fit the multi-database design, and a
   `Content-Security-Policy-Report-Only` rollout before enforcing.
