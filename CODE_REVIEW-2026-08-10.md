# Code Review — dbUI (2026-08-10, branch `access-gate-fixes`)

Scope as requested: **security, de-duplication, performance, architecture, schema clarity**.
This followed an earlier review (2026-07-17) whose findings were all resolved or overtaken -- the
legacy Sheets/Drive/CRDT backends it discussed were deleted -- so that document has been removed and
the parts still worth keeping were moved into the code they describe.
The headline change since then is the per-table `r`/`rw` grant split, `ownerWritable`, and a fourth
access implementation (Supabase RLS). Most findings below are on that seam.

Items marked **[FIXED]** were addressed on this branch after the review; everything else is a
recommendation. Suites after the fixes: **543 unit / 87 rules / 8 storage-rules / 189 E2E + 5 Firebase-
emulator E2E — all passing.**

---

## 0. What's good (so the criticism has a baseline)

- The `r`/`rw` split is implemented with genuine care: `AccessFeatures.grantMode` normalizes all three
  grant shapes in one place, `rwTables` is denormalized at write time because neither rules language
  can filter a map, and the no-mirror fallback in `firestore.rules:34-39` **fails closed** with a
  written justification. That is the right instinct.
- `firestore.rules:253-257` — rewriting the read gate from a ternary on `'owner' in resource.data` to a
  flat disjunction is exactly right, and the comment explaining *why* (rules are not filters; a
  per-document test is not provable from a query constraint) is the most valuable comment in the repo.
- `backend-firebase.js:120-140` `_scopedRead` + `dev/test/firebase-read-scope.test.js` is model work:
  the query shape is asserted, not just the result, including the lowercasing that would otherwise
  silently match nothing.
- `ownerCreateOk` using `diff(locked).affectedKeys().hasOnly(...)` to express "you may not start a row
  already approved" as one comparison, in a language with no loops, is a real piece of design.

---

## 1. Security

### S-A [HIGH] [FIXED] — Supabase Storage policy re-opens the exact hole `storage.rules` closed
`supabase-schema.sql:362-367` vs `storage.rules:22-32`.

| | Firebase | Supabase |
|---|---|---|
| registration required | ✅ cross-service `/_users` lookup | ❌ any `authenticated` |
| path scoped to own email | ✅ `email.lower() == userEmail` | ❌ any key in the bucket |
| size cap | ✅ 10 MB | ❌ none |
| content type | ✅ `image/.*` | ❌ any |

Finding **S1** in the previous review was precisely "the bucket is open to any Google account, and the
config is distributed by shareable links by design." The Supabase port reintroduces all of it, plus
overwrite (no path scoping means one user can replace another's object). The `-- Adjust if you need
stricter rules` comment understates it: this is not a tuning knob, it is the same bug.

Port the four conditions. Registration is expressible — the helper functions are already
`SECURITY DEFINER` over `public.kv`, so `app_is_registered()` works inside a `storage.objects` policy,
and `(storage.foldername(name))[1] = public.app_email()` gives the folder scope.

### S-B [MED] [FIXED] — Supabase drops every document-shape validation the rules layer enforces
`firestore.rules` validates `_profiles` (`validProfile`, ≤100-char name, ≤350 KB picture, `hasOnly`
keys), `_list_users` (`validLink`) and `_access_requests` (`validRequest`, ≤500-char note).
`supabase-schema.sql:263-265, 260-262, 265` has **no equivalent** — `app_can_create` checks only *who*,
never *what*.

Consequences on Supabase: any authenticated user can store an unbounded `picture` on their own
`_profiles` row (Postgres jsonb tolerates ~1 GB where Firestore rejects at 1 MB), park arbitrary extra
keys, and write an oversized `_access_requests` note — and those render in the admin's approval UI.

These are pure value predicates. Factor them into one `app_valid_shape(store, key, val)` called from
`app_can_create`, mirroring the three rules functions one-for-one.

### S-C [MED] [FIXED] — `app_list_write_allowed` contradicts `app_has_table_write` in the same file
`supabase-schema.sql:131-138`:

```sql
when public.app_user_data() ? 'rwTables' then (public.app_user_data() -> 'rwTables') ? e
else (public.app_user_data() -> 'tables') ? e          -- ← no array guard
```

`app_has_table_write` (line 103) *does* guard the fallback with `jsonb_typeof(...) = 'array'`, and
`firestore.rules:47-52` guards it with `u.tables is list`. Both carry a comment explaining that the
guard is what stops "a map without the mirror silently promoting every `'r'` grant to `'rw'`."
`app_list_write_allowed` is missing that guard, so on Supabase a mirror-less map grant does exactly
that, for list writes. One `when jsonb_typeof(...) = 'array' then ... else false` clause.

### S-D [MED] [FIXED] — Data exports in the hosting root are deployable and committable
`firebase.json` sets `"public": "."` with an `ignore` list that names `dev/**`, `functions/**`, `*.md`
— and nothing about JSON. The working tree currently holds four untracked full exports at the root:

```
drive-sync-export-2026-07-31.json        (schema, tables, lists, translations, pages, config)
drive-sync-export-2026-07-31 (1).json
english-schema-import.json
firebase-tehtavat-board-import.json
```

`tables` is row data. The next `firebase deploy` publishes them at
`https://<site>/drive-sync-export-2026-07-31.json`, world-readable, bypassing every rule in
`firestore.rules`. `.gitignore` doesn't cover them either, so they are one `git add -A` from the
history.

Fix both ends: add `drive-sync-export-*.json` / `*-import.json` to `.gitignore`, and add
`"*.json"` + `"!firebase-config.json"` (or an explicit allowlist) to the hosting `ignore`. Given
`"public": "."`, the ignore list should be an allowlist in spirit — anything dropped in the repo root
ships.

### S-E [LOW] [FIXED] — CSP has no Supabase origin, and Supabase has shipped
`csp.js:19` — *"Future Supabase backend: add `https://*.supabase.co` to connect-src when that lands."*
It landed: `index.html:147` routes to `/backend-supabase.js` and `:223` loads the SDK. The policy is
already ENFORCED in every Playwright run and Report-Only in production. `script-src` covers the SDK
(jsdelivr is allowed); `connect-src` does not cover the project host, so the Supabase backend is dead
the moment the header is flipped to enforcing — and its E2E coverage would have caught this if the
suite ran that backend under `CSP=1`.

Add `https://*.supabase.co wss://*.supabase.co` to `connect-src` (wss for realtime, if used).

### S-F [LOW] [FIXED] — dev server: write routes with no role gate at all
`dev/server.js` — `saveSchema` (204), `setFolderConfig` (207), `resetData` (229), `setUserRole` (360),
`removeUser` (361), `getUsers` (354), `getAccessRequests` (368), `getProfiles` (388) accept any
`X-User`. In the Firestore model every one of these is admin-only. `setUserRole` in particular means
any dev identity can grant itself admin.

The loopback bind makes this not an exploit, and that is well argued in the header comment. But the
file's *stated purpose* is "mirrors firestore.rules on the unauthenticated dev backend so the local
demo behaves like Firebase" (line 183) — and the E2E suite runs against it. An ungated `setUserRole`
means the local suite structurally cannot test privilege-escalation denial. Gate them on
`isAdminReq()`; it already exists.

**Fixed** as one `ADMIN_ROUTES` list checked in a single place before the route switch, rather than ten
inline guards — the list is then auditable, and classifying a new route is a deliberate act. It covers
`saveSchema`, `initSchema`, `setFolderConfig`, `saveConfig`, `getUsers`, `setUserRole`, `removeUser`,
`getAccessRequests`, `getProfiles`, plus `getListUserLinks` / `setListUser`, whose own inline guards
were folded in so there is one gate rather than two mechanisms. `removeAccessRequest` and
`setProfileName` take the rules' other branch — `myEmail() == email || role() == 'admin'` — since both
are things a member legitimately does to their own record. Bootstrap still passes, because
`isAdminReq()` is true while no users exist; that is what lets a fresh database take its first schema
and mint its first admin.

`resetData` is deliberately **not** gated, and the code says why. It is the only route here with no
counterpart in any production backend: it is the local fixture reset, and `storage-pglite` runs it
`asOwner` precisely so no policy applies. Gating it on the roster it is about to delete is circular —
after any test that registers an admin other than the caller, nobody can reset, and the next test
inherits the previous one's users. Loopback is the gate on that one.

`dev/test/dev-admin-routes.test.js` (7 cases) is the thing the finding was actually about: the local
suite can now express privilege-escalation *denial*. All seven fail against the ungated server, which
was checked rather than assumed. Two existing tests were relying on the hole and were corrected, not
worked around: `sse-live.test.js` minted a viewer before the admin (spending the bootstrap grace on the
wrong user, leaving `admin@dev` an unregistered stranger), and an `app.spec.js` case read the whole
membership-requests queue as the member who had just been approved — an admin read on every backend,
which passed only because the dev server did not check.

### S-G [note] — an editor can edit any page, including restricted ones
`_pages__active` write is `role() == 'editor'` with no table qualifier, in all three layers
consistently. Reading a page is grant-scoped; writing it is not. That is defensible (editors are
trusted with content) but it means `access: [tables]` is a read-only boundary. Worth one line in
SCHEMA.md so nobody reads it as confidentiality.

---

## 2. Correctness — cross-backend drift

### D-A [HIGH] [FIXED] — Self-service tables are missing from boot on two of three backends
`backend-firebase.js:88-91` adds owner-column tables to the boot set for a restricted member:

```js
var selfServe = BackendHelpers.ownerTablesOf(parsed);
var names = Object.keys(tableMap).filter(function(t) {
  return !allowed || allowed.indexOf(t) >= 0 || selfServe.indexOf(t) >= 0;
});
```

Neither counterpart does:

- `backend-supabase.js:86` — `filter(function(t) { return !allowed || allowed.indexOf(t) >= 0; })`
- `dev/server.js:222` — `if (allowedB && allowedB.indexOf(name) < 0) return;`

This is not merely a slower first paint. `app-core.js:1420-1437` — the union/join view path builds
rows straight out of `self.dataCache` and, unlike the calendar/rotation/pivot/rsvp branches (which
call `_ensureCached`) and unlike the bare-table branch (which lazily fetches at :1484), it **never
lazily loads `view.sources`**. So on Supabase and on the dev server, a grantless member opening their
self-service data view gets a permanently empty grid, while the nav gate (`canReachTable` →
`canSelfServe`) correctly showed them the tab.

The Firebase fix commit even names the symptom: *"Skipping those left every self-service view empty
until something else happened to fetch them."* The fix landed in one backend of three.

Two options, and I'd take the second:
1. Copy the `selfServe` union into both boot paths.
2. Move it into `BackendHelpers` — `bootTableNames(parsed, allowed)` — since all three compute the
   identical predicate from the identical inputs. This is the same drift class `list-access.js` and
   `access-features.js` were extracted to kill; the third instance of a bug is the signal to extract.

Either way, add a lazy `_ensureCached(view.sources)` to the union/join branch as defence in depth —
that branch is the only one in `loadTableData` that assumes boot got everything.

### D-B [MED] [FIXED] — An editor cannot create a `_lists` doc on Firebase, but can on Supabase
`firestore.rules:126-129`:

```
allow write: if ... (role() == 'editor' && listWriteAllowed() && request.resource.data.tables == resource.data.tables)
```

`allow write` covers create. On a create, `resource` is null, so both `listWriteAllowed()` (which reads
`resource.data.tables`) and the equality pin evaluate against nothing — the branch is denied. So a
restricted editor's `putListItem` on a list whose doc doesn't exist yet (`set(..., {merge:true})` = a
create) is denied. That is the `allowNew` flow for any list an admin hasn't materialized.

`supabase-schema.sql:266-268` gates create on `app_list_write_allowed(val -> 'tables')` — the *new*
value — so the same editor succeeds there.

The emulator suite only covers updates: `dev/test-emulator/firestore-rules.mjs:276-284` pre-seeds both
list docs as admin before testing the editor. Add a create case, then decide which semantics you want
and make both layers say it. (I'd allow the create, gated on the incoming `tables` matching
`listOwningTables` — the value is schema-derived, not user-chosen.)

---

## 3. De-duplication

### R-A [FIXED] — The array-or-map column shape is now branched in 11 places, 5 of them identical
```
backend-firebase.js:217   var defs = Array.isArray(cols) ? cols : Object.keys(cols).map(k => cols[k]);
backend-supabase.js:161   (verbatim identical)
list-access.js:18         (verbatim identical)
backend-helpers.js:87     if (Array.isArray(cols)) cols.forEach(...) else for (k in cols) ...
dev/server.js:194         if (Array.isArray(cols)) { cols.find(c => c.type === 'owner') } else { for ... }
```
plus `backend-helpers.js:137`, `dev/backend-local.js:33,125`, `dev/schema.js:27`,
`schema-loader.js:34`, `app-core.js:501`.

The 2026-07 review counted six and recommended converging readers on one normalized shape. It has
grown to eleven. The cheap win, without touching the storage format: export
`Columns.columnDefs(tableDef) -> { name: def }` and `Columns.ownerColOf(tableDef)` from `columns.js`
(already loaded by every browser path and `require`-able in Node) and collapse the five identical
sites. `dev/server.js:188-197` `selfServiceOwnerCol` then becomes a one-liner over
`Columns.tableOwnerCol`.

**Fixed** — see *Applied 2026-08-25* below.

### R-B [FIXED] — `dev/schema.js` still re-implements `_normalizeSchema`, and has drifted
`dev/schema.js:15-46` duplicates `schema-loader.js`'s `_flattenViews` + colMap + implicit-id logic.
Nine test files import it — so **the unit suite normalizes schemas differently from the app.**

The drift is already there: `schema-loader.js:10` registers a view when it has
`sources || markdown || rotation || calendar || pivot || rsvp || **board**`; `dev/schema.js:17` is
missing `board`. It is latent only because `validateSchema` requires a board view to have exactly one
source, so today every board view is caught by the `sources` clause. A sourceless kind added later
will be invisible to nine test files, silently.

`dev/schema.js` also never calls `convertViewFilters`, so no test exercises a legacy array-IN filter
through the real load path, and it injects `partition`/`archivePartition` fields the browser never
sets.

Extract the normalizer into a shared module (`schema-normalize.js`) that both `schema-loader.js` and
`dev/schema.js` call, exactly as `list-access.js` and `columns.js` were extracted.

**Fixed** — see *Applied 2026-08-25* below.

### R-C — The owner-column-bounds comparison is written three times
`firestore.rules:228-238` (`diff().affectedKeys().hasOnly()`), `supabase-schema.sql:178-205`
(`jsonb_each` union + `is distinct from`), `dev/server.js:170-182` (JS `Set` + `String()` coercion).
Three languages, so this one is *irreducible* — but the JS copy uses `String(a) !== String(b)` while
the SQL uses `coalesce(->>, '')` and the rules use structural equality. Those three disagree on
`0` vs `"0"`, `false` vs `"false"`, and `null` vs `""`. Since `dev/server.js` already imports
`BackendHelpers`, extract the JS comparison into `BackendHelpers.ownerFieldsOk(bounds, incoming,
existing)` and give it a table-driven test naming the coercion contract the other two must match.

---

## 4. Performance

### P-A [MED] — `lookup` computed columns are O(rows × lookupTable)
`rows.js:323-328` — a linear scan of the target table per row, per def:

```js
for (var li = 0; li < lsrc.length; li++) { if (lsrc[li][onCol] === lkey) { lhit = lsrc[li]; break; } }
```

`resolveComputed` runs on every view render, and the chores schema does exactly the quadratic thing
(a chore-log row looking up points on the chores table). Build the index once per `resolveComputed`
call, keyed `(lk.table, onCol)`, and reuse across rows — a few lines, and it removes the only
super-linear term in the render path.

`buildRows` join mode (`rows.js:203`) has the same shape — `rows.find(x => x.id === r.id)` per source
row — but joins are small in practice; a `Map` there is free anyway if you're in the file.

### P-B [MED] — P4 from the previous review is still open, and the doc-view path is hotter now
`embeds.js:81` (`mdBlocks` hide-when-empty) and `:92` (`docHasData`) each call `embedRows(...)`, which
is a full `buildRows → resolveComputed → aggregateRows → sortByCol` pass. `mdBlocks` runs it once per
`?`-suffixed token; `docHasData` runs it per token until one is non-empty. Both are reached from Vue
computeds (`app-core.js:330` `pageBlocks`, `:3658` `embed-view.blocks`) that re-run on any reactive
dependency change, and `resolveEmbed` (`embeds.js:101`) calls **both** for a single doc embed — so an
embedded doc-view with N optional embeds costs up to 2N pipeline passes per render.

The pipeline is pure over `(view, dataCache)`. Memoize on a data-generation counter bumped on every
`dataCache` mutation: `embedRows(type, name, part)` keyed `name|part|gen`.

### P-E [MED] — the boot read budget has no test that would notice it regressing
`dev/test-ui/boot-time.spec.js` is the only guard on boot, and it asserts one thing:

```js
expect(data.bootMs).toBeLessThan(15000);
```

Boot is roughly 1.5s in that harness, so the ceiling is an order of magnitude above the real value. It
cannot fail except on a machine so loaded that every other test has already failed, which makes it a
report rather than a budget.

That matters more than a stale number usually would, because boot cost IS the Firestore bill: every
document read at boot is billed, and several phases of work went into making boot lazy (`bootTableNames`,
fetch-a-partition-once, the listener's first snapshot counted as the load rather than a second fetch).
None of that is pinned. A regression that reintroduces "fetch every granted table at boot" would pass
this suite and show up as a bigger invoice.

Two assertions worth having, in value order:

1. **Count the reads, not the milliseconds.** The Firebase-emulator spec already proves "a viewed table
   is read ONCE" by spying; the same spy over a boot, asserting the number of tables fetched, is what
   actually guards the work. Time is a proxy that drifts with hardware; the read count is the thing
   being bought.
2. **Then tighten the clock** to something near the observed value with headroom (2-3x, not 10x), so a
   genuine slowdown is visible even when the read count is unchanged.

### P-C [LOW] — Firestore rules `get()` budget on owner-bounded writes
A create on an `ownerWritable` table touches `_meta/users` (bootstrap probe), `_users/<me>`,
`_meta/ownerTables`, `_meta/ownerWritable` — roughly 4 distinct documents, and Firestore caps a
single-document request at 10 access calls. There's headroom today, but each new schema-derived mirror
doc spends from the same budget, and the failure mode is a hard denial, not a slow write. If a fifth
mirror is ever needed, merge them into one `_meta/rulesMirror` document instead of adding a key —
`saveSchema` already writes all of them in a single `Promise.all`.

### P-D [LOW] — `canReachTable` runs `withMirrors` per call
`app-core.js:1875` → `canSelfServe` (`:1860`) → `withMirrors([table])`, which scans every table's every
column (`schema-loader.js:90-102`). `sidebarTabs` calls it per nav item, `embedConfigs` per embed
source, `_ensureCached` per table. It's O(nav × tables × columns) per recompute — small today, and
trivially fixed by memoizing `withMirrors` in the same schema-keyed `WeakMap` `columns.js` already uses
for `scanSchema`.

---

## 5. Architecture

**The access model is now implemented four times** — `firestore.rules`, `supabase-schema.sql`,
`dev/server.js`, and the client UI (`userAllowedTables` / `userWritableTables` / `canReachTable` /
`canAccessPage`). The 2026-07 review flagged three and called the drift "live." Adding the fourth
without a shared conformance harness is what produced S-B, S-C, D-A and D-B in this review — every one
of them is "layer N learned something layer M didn't."

The pure-module extraction (`access-features.js`, `list-access.js`, `backend-helpers.js`) already gets
the *decidable* parts right: all four layers agree on grant shapes because `grantMode` is the only
implementation. What has no shared source is the **policy matrix** — for each (store, operation, role,
grant, row-ownership) tuple, allow or deny.

Concretely, and in rough order of value:

1. **Write the matrix down as data.** A single `access-matrix.json` (or a table in SCHEMA.md) listing
   store × op × subject → expected verdict. It is maybe 60 rows.
2. **Drive all four layers' tests from it.** `dev/test/access.test.js` (client), a dev-server HTTP
   suite, `dev/test-emulator/firestore-rules.mjs`, and a `pg-tap`/plain-SQL suite against a local
   Postgres with the RLS installed. Each layer's harness differs; the *cases* must not. A case added
   to the matrix that a layer doesn't implement fails that layer's suite by construction — which is
   exactly the property missing today, since Supabase has **no** RLS test at all.
3. **Make the third implementation the last one.** New schema-derived facts (`ownerTables`,
   `pageAccess`, `ownerWritable` — three in one quarter) should be generated into all mirrors by one
   `BackendHelpers.rulesMirrors(schema)` returning `{ownerTables, pageAccess, ownerWritable}`, so a
   backend's `saveSchema` cannot forget one. Both current backends happen to write all three; there is
   nothing structurally preventing the next from writing two.

Secondary: `app-core.js` is 4 633 lines / 320 KB and holds the root component, ~15 sub-components,
the boot path, import/export, and the whole permission UI. The domain-module extraction was the right
call and worked; the same reasoning now applies to the components (`board-view`, `embed-view`,
`data-cell`, the settings/users panels), which are already string-templated and take `appInstance`
through a documented seam. Splitting them out is mechanical and would make the remaining root a
readable ~1 500 lines.

---

## 6. Schema clarity

All three weak points from the previous review are unaddressed, and two have gotten worse:

**View kinds are still presence-discriminated, and there are now seven.**
`schema-loader.js:10` — `v.sources || markdown || rotation || calendar || pivot || rsvp || board`.
Every consumer re-derives the kind by probing fields, invalid combinations remain representable, and
`validateSchema` still doesn't reject them. `dev/schema.js:17` having drifted (R-B) is the predicted
consequence: an implicit discriminator cannot be kept in sync, because there is nothing to sync.

Partly overtaken: `migrations.js` now WRITES a `kind` (v1->v2) and every shipped schema declares
`schemaVersion: 3`, so the discriminator exists in the data. It is not yet what the loader dispatches
on, and cannot be until migration also labels nav GROUPS — `kindOf` defaults to `'data'`, so a named
group carrying only nested `views` comes out labelled a data view. `SchemaNormalize.isView` is now the
one presence sniff left (it was two), with that reason written next to it.

Add an explicit `"kind"` and derive it at load for legacy schemas — `_normalizeSchema` is already the
place migrations happen, and `resolveEmbed` (`embeds.js:99-136`) already dispatches on a `kind` field
it computes itself. Half the pattern exists; the schema just doesn't carry it.

**Dual column shapes** — see R-A. ~~Eleven branch sites, growing.~~ Now read through one module
(`Columns.columnDefs`); the SHAPES themselves are still two, which is the deeper point and is
unchanged — the storage format still admits both.

**Still no `schemaVersion`, still no meta-schema.** `validateSchema` is 150 lines of hand-rolled
checks that have grown a genuinely good `archiveAfter` block (`schema-loader.js:125-134`, checking
`archivable`, the column's existence, and the `updated_at` prerequisite — exactly the "easy to write,
silently does nothing" failure class worth catching). But it still never validates a column `type`
against an enum, so a typo degrades to `text` silently, and unknown keys are never flagged — the class
of bug that killed ref validation for months (`B1`).

The `access: ["all"]` sentinel added this quarter is a fresh example of the cost: `"all"` is a magic
string that is not a table name, must be exempted from the existence check
(`schema-loader.js:144-147`), and has to be independently understood by `canAccessPage`, `filterPages`
and `pageAllowed`. A JSON Schema `oneOf` between `{"const": "all"}` and an array of table names would
make it self-documenting where authors actually look — their editor. Users hand-edit this file; that
is the stated design, and it's the strongest argument for shipping a `schema.schema.json` with a
`$schema` pointer.

---

## Applied on this branch

All seven security/correctness findings are fixed. What changed, beyond the obvious:

- **S-A** — `supabase-schema.sql`: `uploads_insert` / `uploads_update` / `uploads_delete` each require
  `app_is_registered()` and `(storage.foldername(name))[1] = app_email()`. Size and MIME live on the
  BUCKET (`file_size_limit`, `allowed_mime_types`) rather than in a `WITH CHECK` on
  `storage.objects.metadata`, which the storage service populates as part of the upload and so is not a
  dependable gate. The bucket upsert became `do update` so re-running the script applies limits to a
  bucket created before they existed — the deployments that need it most are the ones that already ran
  the old script.
- **S-B** — one `app_valid_shape(store, key, val)`, bound to the same subjects as the rules version
  (validProfile/validLink apply to admin writes too, validRequest only to the self-create). Key-set
  checks are `not exists (... where k <> all(...))`, not `bool_and`, which is NULL over an empty key
  set and would have denied an empty document.
- **D-A** — extracted `BackendHelpers.bootTableNames(schema, allowed)` and pointed all three backends
  at it, rather than copying the clause into the two that lacked it. The dev server additionally
  scopes rows for a table the caller has no read grant on (`scopeToOwnRows`) — without that, widening
  its boot set would have handed a grantless member the whole table.
- **D-B** — `_lists` create is now authorized from a new `_meta/listTables` mirror
  (`ListAccess.listOwnershipMap`, written by both backends' `saveSchema`) instead of from the `tables`
  label in the incoming write, which on a create is an unverified claim: trusting it would let an
  editor mint a list under an ownership label of their choosing and hijack the read audience of a list
  another table owns. The label is pinned to the mirror. `write` was split into `create` / `update` /
  `delete` so the re-stamp pin stops silently denying deletes by evaluating `request.resource` on a
  delete.

New drift guards, aimed at the §5 root cause:

- `dev/test/rules-parity.test.js` (20 checks) — compares the four layers on the things that *can* be
  compared: the owner-writable system column list (written in all four languages), every document size
  cap, the array guard on both write-fallbacks in both layers, the storage gate conditions, and that
  both backends' `saveSchema` mirror an identical `_meta` key set to rules that actually read them.
- `dev/test/deploy-config.test.js` — asserts data bundles are excluded from hosting *and* that
  `manifest.json` / `firebase-config.json` / `supabase-config.json` are not, so an over-broad `*.json`
  can't silently break boot.
- Emulator suite +7 `_lists` create/delete cases; `bootTableNames` and `listOwnershipMap` unit tests.

### Supabase now has a behavioural RLS suite

`dev/test/supabase-rls.test.js` — 73 assertions that load the real `supabase-schema.sql` into
PostgreSQL-in-WASM (`@electric-sql/pglite`) and execute the policies, covering the same access matrix
as the Firestore emulator suite. It is a plain unit test: no Docker, no service container, no JVM, so
`npm test` runs it locally and in the existing CI `build` job.

It paid for itself on the first run by catching a regression **introduced by the D-B fix above**: the
`_lists` INSERT gate is also the UPDATE policy's `WITH CHECK`, so routing updates through the
mirror-based create rule denied every edit of a list absent from `_meta/listTables` — which is every
list in every existing deployment until the next `saveSchema`. Split into `app_list_editor_ok`:
insert authorizes from the mirror, update from the stored label plus the no-re-stamp pin, matching
`firestore.rules` on both.

It also settled the subtlest assumption in the file. `app_owner_fields_ok` looks up its own baseline,
and on an UPDATE that lookup runs inside a `WITH CHECK` — the gate is only meaningful if the `STABLE`
function sees the *pre*-update row. If it saw the new one the diff would always be empty and
`ownerWritable` would be a silent no-op on Supabase while working correctly on Firebase. It sees the
old row; there are now tests pinning that.

Known limits, stated in the suite header: the `storage.*` policies are stripped (stock Postgres has no
`storage` schema — `rules-parity.test.js` guards those statically), and the harness's SECURITY DEFINER
owner is a superuser, so it validates the design rather than proving the project's role attributes.

Suites: 617 unit (incl. 73 RLS), 87 rules, 8 storage-rules, 189 E2E, 5 Firebase-emulator E2E — all
passing.

---

## Applied 2026-08-25 — R-A / R-B (the two de-duplication findings)

**R-A — one reader for the two column shapes.** `columns.js` gained `columnDefs(tableDef)` (name->def,
either shape), `columnDefList(tableDef)` (the defs alone) and `ownerColOf(tableDef)`. Every site the
finding named now calls one of them: `backend-firebase.js`, `list-access.js` (x2),
`backend-helpers.js` (`ownerWritableOf` / `stampedOf` / `ownerTablesOf`), `dev/server.js` (x2, which
collapse to one function), `dev/backend-local.js`'s multiselect scan, and `columns.js`'s own
`tableDeps` / `tableOwnerCol`. Two sites the finding did not have — `backend-kv.js` (which post-dates
it and carries the identical clause) and `migrations.js`'s `eachColumnDef` — went with them.

Three things worth knowing beyond the mechanical move:

- **The map shape is returned as-is, not copied.** These run per render and per nav item (`P-D`), so a
  defensive copy would have made a de-duplication into a slowdown. The result is documented read-only.
- **A bare-string `owner` def is now refused everywhere.** `tableOwnerCol` went through `columnType`,
  which types `"mine": "owner"` as an owner column; `ownerTablesOf` — what `firestore.rules` and the
  RLS policies actually read — never counted one. A client that believed a table was self-service
  while the store did not is a denial at write time, so the two agree now, in the fail-closed
  direction. No shipped schema uses the string form.
- **One site was deliberately NOT collapsed.** `dev/backend-local.js`'s `initSchema` takes a STORAGE
  schema, whose `columns` may be a plain list of NAMES (`['id', 'v']`) — a third shape the app never
  produces and the shared reader has no definition to return for. Converting it broke two fixtures;
  it is back, with the reason written down. The count is nine collapsed, not ten.

**R-B — `schema-normalize.js`.** The migrate -> `convertViewFilters` -> fold-columns -> implicit-id ->
flatten-views chain is one module now; `schema-loader.js` keeps only what is browser-specific (binding
the globals, recording the migration for the UI) and `dev/schema.js` keeps only what is genuinely
harness-local (the `partition` / `archivePartition` fields the Node backends read off a table def).
`app-core.js`'s import path called the loader-local `_flattenViews` and now calls the module — caught
by the E2E suite, not by any unit test, which is worth remembering about globals.

The gap the finding predicted is closed by construction: the harness now runs the migration chain and
`convertViewFilters`, so a legacy schema finally goes through the real load path in Node.

`dev/schema.js:17` had in fact caught up on `board` since the review was written — but not by any
mechanism, which was the finding's actual point.

New coverage: `dev/test/schema-normalize.test.js` (16 cases, including a source guard that neither
loader re-implements the conversion, and a case pinning WHY the discriminator is still a presence
sniff rather than `kind`) and 7 cases in `columns.test.js` (both shapes, order preservation, the
no-copy contract, the bare-string rule, plus a source guard over twelve files that the array-or-map
clause appears only in `columns.js`).

**Also fixed, found on the way:** `dev/server.js` isolated a test server's sidecar files by
`process.pid` alone. Nothing ever deleted them — a test kills its server, which on Windows runs no
exit handler — so 2 700 had accumulated in the temp dir, and a fresh server whose pid matched a
previous RUN's loaded that run's member registry. That ends bootstrap, and the symptom is the one the
comment above that very line describes: `saveSchema` refused during setup, mirrors never written,
gates silently permissive. `grant-edit-keeps-identity.test.js` failed 4-for-4 on it. The token is now
pid + random, the four sidecars are unlinked on a graceful exit, and startup sweeps anything older
than 24 h (longer than any suite holds a server open, so a live instance can never be swept).

Suites: **1 181 unit, 124 rules, 23 policy-differential, 8 storage-rules, 265 E2E, 7 Firebase-emulator
E2E — all passing**, plus `tsc` clean.

---

## Applied 2026-08-25 — P-A / P-B (the two performance findings)

**P-A — the lookup computed column is indexed, not scanned.** `resolveComputed` now keeps a per-CALL
index cache keyed `(lookup.table, lookup.on)` and `_computeInto` reads through it, so the target table
is walked once per call instead of once per row. The scope is the call, not the app: the pipeline is
synchronous and pure over `dataCache`, so nothing can change under the index and there is nothing to
invalidate. It is built lazily, so a view with no lookup def pays nothing.

Two properties of the scan it replaces are preserved deliberately, and pinned by tests:

- **First hit wins.** The scan `break`s; a keyed table with a duplicate key must still resolve to the
  row it always did.
- **A `Map`, not an object.** The scan compared with `===`. An object index would stringify every key
  and make a row keyed `1` match a lookup of `"1"` — a silent wrong answer on any table whose key is
  numeric.

`buildRows` join mode went with it: the `rows.find(x => x.id === r.id)` per source row was O(n²) in the
rows already merged, and is now an id `Map` spanning the join. It holds the same row objects the output
does, so merging through it still mutates the row in place.

The guard is a read counter, not a timing: each lookup row counts every read of its key column, so 40
view rows over a 50-row table read 50 times (one pass) where the scan read 2 000. Without that
assertion the fix is invisible — both versions produce identical values, which is why the scan lasted.

**P-B — the doc-embed pipeline is memoized per ctx.** `embedRows` takes its answer from a `rowsMemo`
on the ctx when the caller supplies one; `app-core`'s `_embedCtx()` puts a fresh `Map` on every ctx it
builds. That halves a doc embed: `resolveEmbed` asks `mdBlocks` whether to hide each `?` token and
`docHasData` whether the doc-view has any data at all, and both answered by running
`buildRows -> resolveComputed -> aggregateRows -> sortByCol` over the same token. The unmemoized cost is
pinned by a test that counts pipeline passes (2 for one token) beside the memoized one (1).

**The generation counter the finding proposed was deliberately not built.** Keying on a counter bumped
at every `dataCache` write would cache across calls, but the bump would be hand-written at ~80 mutation
sites and one missed bump is stale rows on screen — a correctness bug traded for a render cost. It
would also buy little: the Vue computeds that reach this code are themselves invalidated by any
`dataCache` write, which is exactly when such a counter would move. What is left after Vue's own
computed caching is the duplication *inside* one evaluation, and that is what the per-ctx memo removes,
with an invalidation story that is a proof rather than a discipline: a ctx is built fresh per call, the
pipeline is pure over it, so nothing can go stale inside one. The cost is that a ctx is now single-use,
which is written down at both ends.

New coverage: 3 cases in `rows.test.js` (the read-count guard, first-wins + no `1`/`"1"` coercion, and
a three-source join pinning order, `_source` identity and overwrite precedence) and 3 in
`embeds.test.js` (the 2-passes-to-1 count, the memo keying on partition so a `@both` embed still counts
both halves, and a fresh ctx seeing a changed `dataCache`).

Suites: **1 187 unit, 265 E2E — all passing**, plus `tsc` clean.

---

## Applied 2026-08-26 — P-E (the boot read budget)

**The boot budget is now a count, not a clock.** `dev/test-ui/boot-reads.spec.js` asserts three things
the old 15 s ceiling could not:

1. **`bootData` carries no table data.** Read from the boot payload observed during a real app boot,
   not from a spy: `data` must be `{}`, which is the contract all three backends share and the exact
   thing a reintroduced preload would break.
2. **The landing view reads its own tables, once each, and no others.** The fixture schema has six
   tables; the landing view reaches three (`tasks`, `notes`, and `cities` because `tasks.city` refs it).
   Those three are named, and so are the three that must stay untouched — the gap IS what lazy boot
   bought. "Once each" catches the fetch-and-subscribe double read from the other direction.
3. **Navigating to a second view re-reads nothing already cached**, which is what makes `_ensureCached`
   worth having.

Reads are counted at the TRANSPORT — a `fetch` wrapper installed by `addInitScript` before any app code
runs — rather than by wrapping `backend.getTableData`, so the count survives an adapter refactor.

**The boot/after-boot split is deliberately not taken from a timestamp.** The obvious version of test 1
("no table was read before `window.__bootMs`") was written first and failed: `__bootMs` is set by a Vue
watcher on `loading`, which flushes a tick after `loading` is set, and `_autoSelectTab()` issues its
fetches synchronously in between. The landing view's three reads land *before* the marker while being
caused by the view rather than by boot. Timestamps cannot separate those two; the payload can, so the
question "what did BOOT fetch" is asked of `bootData`'s own response.

**Verified by regression, not by passing.** With `dev/server.js`'s `bootData` temporarily restored to
reading every table's active partition before returning, all three new tests fail — and
`boot-time.spec.js` still passes, reporting `boot_ms=205`. That is the finding demonstrated rather than
argued: against a fixture database, reading every table costs about fifteen milliseconds, so no clock
set anywhere sane would ever have caught the regression that costs money.

**The clock was tightened anyway**, 15 000 ms → 3 000 ms, with the measurements written beside it
(189-192 ms solo, 282-440 ms with eight workers contending) and a note saying what it can and cannot
see. It now guards a genuine slowdown at unchanged read count; the read count guards the bill.

Suites: **1 187 unit, 268 E2E (7 skipped) — all passing**, plus `tsc` clean.

---

## Applied 2026-08-26 — the meta-schema (§6, the `schema.schema.json` half)

**`schema.schema.json` ships at the repo root**, and schemas point at it with `"$schema":
"./schema.schema.json"`. Users hand-edit this document; that is the stated design, so the vocabulary is
now stated where they actually work.

**The column vocabulary is closed in BOTH places, and they are held together.** `Columns.COLUMN_TYPES`
and `COLUMN_KEYS` live next to the readers that consume them, and `Columns.vocabularyErrors(tables)` --
a pure function, so the unit suite runs the same one the browser does -- is concatenated into
`validateSchema`. The meta-schema states the same two lists for the editor, and
`dev/test/schema-meta.test.js` fails if they ever differ. That is the answer to the obvious objection:
a vocabulary written twice is the thing this repo spends its effort not having, so the second copy is
pinned to the first rather than trusted.

Both findings the review named are now reported at load:

- an unknown `type`, which `columnType` otherwise degrades to `"text"` -- the message says so, because
  "unknown type" alone leaves the author wondering whether the column works at all. It does; that is
  the problem.
- an unknown KEY, which is simply never read.

**The meta-schema is checked against real documents, not just written.** `schema-meta.test.js`
validates every schema the repo ships (ajv, a devDependency -- test-only, nothing new reaches the
browser). That is not ceremony: the first draft typed `listSwitch` as a string, and `dev/schema.json`
is what said otherwise. A meta-schema nobody validates against is decoration that puts red underlines
under working JSON.

**The `access` sentinel is expressed as the review suggested**, and slightly more sharply: either
exactly `["all"]` or an array containing no `"all"`. The mixed form is rejected in the editor though
the app tolerates it, because it cannot mean anything -- a full-access user already passes any
non-empty list, so `["all", "tasks"]` IS `["tasks"]`, and an author writing it believes it does
something it does not. That reasoning is in the meta-schema's own `description`, so it does not read
as an app rule.

**What is deliberately NOT closed: tables and views.** A view's kind is still chosen by which field it
carries, and `currentConfig` is `VIEWS[x] || SCHEMA[x]` -- a table answers to the same presentation
vocabulary a view does, so the two are literally the same object position. Closing that list today
would either be wrong or would freeze a vocabulary the `kind`-dispatch work is about to restructure.
Both are described (completion, enums, per-property prose) with `additionalProperties: true`, and the
file says why.

Two documentation gaps fell out of writing it: `listSwitch` and `stamped` were **never** in SCHEMA.md's
column-properties table. Both are there now, next to a line saying the list is closed.

New coverage: 13 cases in `dev/test/schema-vocabulary.test.js` (the two mistakes, both column shapes,
the bare-string shorthand, legacy `multiselect`, and silence over every shipped schema), 14 in
`dev/test/schema-meta.test.js` (vocabulary parity, every shipped document validating, the sentinel), and
2 E2E in `dev/test-ui/schema-vocabulary.spec.js` -- which assert both halves at once: the app boots and
edits a table with a mistyped column perfectly happily, and reports it anyway.

Suites: **1 218 unit, 270 E2E (7 skipped) -- all passing**, plus `tsc` clean.

---

## Applied 2026-08-26 — dispatch on `kind` (§6, the last part)

**The loader dispatches on `kind` now, and nine copies of the discriminator became one.** A view's kind
was worked out by probing for a `rotation`/`calendar`/`pivot`/... key in every consumer that needed the
answer: app-core's seven `is*View` computeds, `SchemaNormalize.isView`, and `Migrations.kindOf`. That
is what an implicit discriminator costs -- there is nothing to sync, so nothing notices when a copy
falls behind, which is precisely how `dev/schema.js`'s copy ended up a kind behind before it was
deleted.

`SchemaNormalize.viewKind(v)` is the one answer. It reads the `kind` the schema carries and derives one
through `Migrations.kindOf` when the document has not been migrated yet (schema-loader flattens the
bundled `defaultSchema` at module load, before anything migrates it). Deriving is **delegated, not
copied** -- the first draft of this change put a local eight-way sniff in `schema-normalize.js` as a
fallback, which is the very duplication being removed, and would have been invisible: in Node
migrations.js is always present, so the copy would never have run.

**The blocker was one wrong label, on a shape nothing ships.** `kindOf` had no answer for a nav folder,
so v1->v2 stamped a named group carrying only nested `views` as `kind: "data"` -- a data view with no
sources and nothing to render. One wrong answer disqualifies a discriminator, so `isView` went on
probing for a body instead. **v3 -> v4** gives the folder its own kind and repairs the mislabel, and
`CURRENT_VERSION` is 4.

The repair is deliberately narrow -- only `'data'` -> `'group'`, only when the entry really is a folder
-- so a hand-written kind is never overruled, and it does two jobs because a document can have missed
either: stamp an entry with no `kind` at all (a hand-authored schema declaring `schemaVersion: 3` never
ran v1->v2) and fix the one v1->v2 got wrong. The three shipped schemas are re-stamped to v4.

**One thing checked and deliberately left alone.** `dev/schema.json`'s `task_doc` carries BOTH
`markdown` and `sources`, and `kindOf` labels it `page` while `isDocViewName` says it is not a doc-view
-- which looks like exactly the mismatch that would break a switch to `kind`. It is not: `currentPage`
renders any view with markdown as a page, so `page` is right for the top-level dispatch, and
`isDocViewName` answers a different question (how the view EMBEDS -- a sourced markdown view's
`{{self}}` must render the grid, not recurse). Two questions, two names, both correct. `resolveEmbed`
is untouched for the same reason: it discriminates on an embed CONFIG, which includes inline embeds
that are not views and have no kind.

`kind` is now a closed enum in `schema.schema.json`, and `dev/test/view-kind.test.js` asserts the
published vocabulary lists every kind `kindOf` can produce -- a kind the app writes but the editor does
not know would put a red underline under a schema the app wrote itself, which is exactly how `group`
would have looked.

New coverage: 8 cases in `dev/test/view-kind.test.js` (every shipped schema's stored label still
matching its shape, derivation for an unmigrated document, precedence when an entry has both a body and
nested views, and the enum parity) and 6 rewritten in `schema-normalize.test.js` (the group case that
was previously asserted as a LIMITATION, the legacy repair, non-override of a hand-written kind, and
chain idempotence).

Suites: **1 230 unit, 270 E2E (7 skipped) -- all passing**, plus `tsc` clean.

---

## Remaining priorities

~~1. The access matrix (§5)~~ — **overtaken.** The premise was four hand-written case lists across four
   layers. There are no longer four layers: dropping the legacy backends moved the dev server onto the
   production policy, so its gates ARE `supabase-schema.sql`. And the case lists were merged where it
   counts — `dev/test-emulator/policy-differential.mjs` runs ONE matrix through BOTH policy engines
   (Firestore emulator and PGlite) and enforces a directional rule: the Firestore mirror may be
   stricter, never looser. `dev/test/gate-parity.test.js` covers the remaining seam (the dev server over
   HTTP vs. the policies in-process). What is still hand-written is the client UI's own list in
   `dev/test/access.test.js`, which is a different question — what the UI OFFERS, not what the store
   permits — and is not worth folding into the same matrix.

~~2. S-F~~ — **done.** See S-F above.

~~3. R-A / R-B~~ — **done 2026-08-25.** See *Applied 2026-08-25* above.

~~4. P-A / P-B~~ — **done 2026-08-25.** See *Applied 2026-08-25 — P-A / P-B* above.

~~5. P-E~~ — **done 2026-08-26.** See *Applied 2026-08-26 — P-E* above.

~~6. `schema.schema.json`~~ (part b) — **done 2026-08-26.** See *Applied 2026-08-26 — the meta-schema*
   above.

**Still open, in value order**
1. S-G — one line in SCHEMA.md: `access:` on a doc-view is a read boundary, not a write one.
2. `saveConfig`'s filename allowlist is `['firebase-config.json', 'config.json']`, but
   `saveSupabaseConfig` posts `supabase-config.json` — so "save it server-side for other users" has
   always silently 403'd on the Supabase path. Noticed while gating that route (S-F); one word to fix,
   and `deploy-config.test.js` already asserts that file must reach the deploy.

**Carried in from outside the review** (raised while working, not findings of this audit; recorded here
so this file is a complete handoff rather than half of one)

- `test:all` starts the Firebase emulators **four separate times** (~6s each). One instance can serve
  all four suites — their distinct project ids already keep the data apart. Worth ~20s a run.
- `SUPABASE.md` is current but linked from nowhere; the README never mentions it, so nobody finds it.
- **No documentation for binding a fresh clone to a Firebase project** — `firebase login`,
  `firebase use --add`, what `.firebaserc` is and whether to commit it. None is committed, so a new
  clone cannot deploy without guessing. The README's deploy section assumes the link already exists.
- **Per-database PWA identity.** The runtime manifest sets `start_url`/`scope` to the origin root and
  declares no `id`, so two databases served by one deployment install as ONE app, wearing whichever
  schema's icon was active at install time. Per-schema *tab* icons already work. The fix is path-based
  hosting rewrites plus per-database config storage (`firebase_config` is currently a single key, which
  is also why one browser profile can only hold one database at a time).
