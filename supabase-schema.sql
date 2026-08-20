-- =====================================================================================================
-- supabase-schema.sql — Postgres schema + Row-Level Security for the dbUI Supabase backend.
--
-- Run this once in your Supabase project (SQL Editor -> New query -> paste -> Run). It is idempotent:
-- re-running it is safe. It reproduces the Firestore data model on a single key-value table and mirrors
-- firestore.rules as per-row RLS policies.
--
-- Model:  Firestore  _col(store).doc(key).data   <->   public.kv (store, key, value)
--
-- Auth:   Enable Authentication -> Providers -> Google in the dashboard. The signed-in user's email is
--         read from the JWT (auth.jwt() ->> 'email'), exactly like Firestore's request.auth.token.email.
-- =====================================================================================================

-- ---------- Table ------------------------------------------------------------------------------------
create table if not exists public.kv (
  store       text        not null,
  key         text        not null,
  value       jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (store, key)
);

create index if not exists kv_store_idx on public.kv (store);

alter table public.kv enable row level security;
alter table public.kv force row level security;

-- Base grants: RLS (below) is the real gate. anon (unauthenticated) gets nothing.
revoke all on public.kv from anon, authenticated;
grant select, insert, update, delete on public.kv to authenticated;

-- ---------- Helper functions (SECURITY DEFINER so they read kv WITHOUT triggering RLS recursion) ------
-- Each mirrors a function in firestore.rules. STABLE + definer-owned; search_path pinned for safety.

create or replace function public.app_email()
returns text language sql stable as $$
  select lower(nullif(auth.jwt() ->> 'email', ''))
$$;

-- Bootstrap: no members configured yet -> the first signed-in Google account acts as admin. Matches
-- firestore.rules noUsers() (= !exists(_meta/users)), plus a guard on the authoritative /_users store.
create or replace function public.app_no_users()
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.kv where store = '_meta' and key = 'users')
     and not exists (select 1 from public.kv where store = '_users')
$$;
grant execute on function public.app_no_users() to authenticated;  -- callable via supabase.rpc(...)

-- The caller's access record: /_users/<email> first, then the legacy _meta/users map. jsonb or null.
create or replace function public.app_user_data()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value from public.kv where store = '_users' and key = public.app_email()),
    (select value -> public.app_email() from public.kv where store = '_meta' and key = 'users')
  )
$$;

create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select case
    when public.app_no_users() then 'admin'
    when public.app_user_data() is not null then public.app_user_data() ->> 'role'
    else null
  end
$$;

create or replace function public.app_is_registered()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_no_users() or public.app_user_data() is not null
$$;

create or replace function public.app_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.app_no_users() or public.app_role() = 'admin'
$$;

-- Table access for a store name like 'tasks__active' -> table 'tasks'. tables == 'all' or membership.
create or replace function public.app_has_table_access(coll text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_no_users() then true
    when public.app_user_data() is null then false
    when public.app_user_data() -> 'tables' = '"all"'::jsonb then true
    else (public.app_user_data() -> 'tables') ? split_part(coll, '__', 1)
  end
$$;

-- Write access to a table. Mirrors firestore.rules hasTableWrite: a grant map { t: 'r' | 'rw' } only
-- permits writes where the mode is 'rw', and the writable subset is denormalized to `rwTables` at grant
-- time because neither rules layer can filter a map. No `rwTables` key -> a pre-split doc (or a legacy
-- array grant), so fall back to plain membership and every existing grant keeps working.
create or replace function public.app_has_table_write(coll text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_no_users() then true
    when public.app_user_data() is null then false
    when public.app_user_data() -> 'tables' = '"all"'::jsonb then true
    when public.app_user_data() ? 'rwTables' then
      (public.app_user_data() -> 'rwTables') ? split_part(coll, '__', 1)
    -- No mirror = a grant written before the split, which is a legacy ARRAY: the map shape arrived with
    -- the same change that introduced rwTables. Restricting the fallback to an array keeps every real
    -- legacy grant working while stopping a mirror-less map from promoting its 'r' entries to 'rw'.
    when jsonb_typeof(public.app_user_data() -> 'tables') = 'array' then
      (public.app_user_data() -> 'tables') ? split_part(coll, '__', 1)
    else false
  end
$$;

-- listAllowed(): the user's grants overlap a list row's owning `tables`. The `?` operator matches an
-- array element OR an object key, so this reads a legacy array grant and a mode map identically.
create or replace function public.app_list_allowed(row_tables jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_is_admin() then true
    when public.app_user_data() is null then false
    when public.app_user_data() -> 'tables' = '"all"'::jsonb then true
    else exists (
      select 1 from jsonb_array_elements_text(coalesce(row_tables, '[]'::jsonb)) e
      where (public.app_user_data() -> 'tables') ? e
    )
  end
$$;

-- Editing a list is editing SHARED VOCABULARY (member names, the status words every view reads), so it
-- is admin-only unless the schema names the list in `userWritableLists`, mirrored to
-- _meta/listWritable. Mirrors firestore.rules listUserWritable, and gates every editor branch on
-- _lists (create/update/delete) ON TOP of the owning-table check below. No mirror row -> no list is
-- editor-writable: the safe default, so a deployment that has not re-saved its schema cannot silently
-- keep the old permissive behaviour.
create or replace function public.app_list_user_writable(listname text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (value -> 'lists') ? listname from public.kv where store = '_meta' and key = 'listWritable'),
    false)
$$;

-- listCreateAllowed(): authorize CREATING a _lists row. On an insert there is no stored row, so the
-- `tables` ownership label in the incoming value is an unverified CLAIM — trusting it would let an
-- editor mint a list under an ownership label of their choosing and hijack the read audience of a list
-- another table actually owns. Answer from _meta/listTables instead: the schema-derived ownership map
-- (list-access.js listOwnershipMap, mirrored by saveSchema), and pin the claimed label to it.
-- Missing mirror -> no editor creates (admins still create freely); it activates on the next schema save.
-- Mirrors firestore.rules listCreateAllowed exactly.
create or replace function public.app_list_create_allowed(listname text, claimed jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with m as (
    select value -> listname as owners from public.kv where store = '_meta' and key = 'listTables'
  )
  select case
    when (select owners from m) is null then false          -- no mirror, or a list the schema doesn't own
    when claimed is distinct from (select owners from m) then false   -- the stored label must be the true one
    else true
  end
$$;

-- The _lists branch of app_can_create serves BOTH the INSERT policy and the UPDATE policy's WITH CHECK,
-- and those are different questions:
--   INSERT — no stored row, so the ownership label is an unverified claim: authorize from the mirror.
--   UPDATE — there IS a stored row, so the question is firestore.rules': does the editor have write
--            access through the label, and is the label UNCHANGED (re-stamping ownership decides who
--            can see the list, so it stays an admin action, exactly as the rules pin
--            request.resource.data.tables == resource.data.tables).
-- Routing updates through the create rule instead denies every edit of a list that predates the mirror
-- — which is every existing deployment until the next saveSchema. (Found by dev/test/supabase-rls.test.js
-- on its first run; the mirror was introduced without this split.)
create or replace function public.app_list_editor_ok(rowkey text, claimed jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.kv where store = '_lists' and key = rowkey) then
      claimed is not distinct from
        (select value -> 'tables' from public.kv where store = '_lists' and key = rowkey)
    else public.app_list_create_allowed(rowkey, claimed)
  end
$$;

-- selfServiceTable(): a data table declares an owner column (mirrored to _meta/ownerTables by saveSchema).
-- Missing doc -> permissive (migration grace), exactly like firestore.rules.
create or replace function public.app_self_service(coll text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.kv where store = '_meta' and key = 'ownerTables') then true
    else (
      select coalesce(value -> 'tables', '[]'::jsonb) from public.kv where store = '_meta' and key = 'ownerTables'
    ) ? split_part(coll, '__', 1)
  end
$$;

-- pageAllowed(): restricted doc-view read gate from _meta/pageAccess (untagged page -> all registered).
create or replace function public.app_page_allowed(page text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from public.kv where store = '_meta' and key = 'pageAccess') then true
    when not ((select value from public.kv where store = '_meta' and key = 'pageAccess') ? page) then true
    when public.app_no_users() or public.app_role() = 'admin' then true
    when public.app_user_data() -> 'tables' = '"all"'::jsonb then true
    else exists (
      select 1 from jsonb_array_elements_text(
        (select value -> page from public.kv where store = '_meta' and key = 'pageAccess')
      ) e where (public.app_user_data() -> 'tables') ? e
    )
  end
$$;

-- ownerWritable: bound an owner-scoped write to named COLUMNS. Mirrors firestore.rules
-- ownerCreateOk/ownerUpdateOk. _meta/ownerWritable holds { table: { cols: [...], locked: {col: default} } };
-- a table absent from it is unbounded, so the feature is opt-in and existing deployments do not change.
--
-- The baseline a write may differ from is looked up HERE rather than passed in: kv_update's WITH CHECK
-- only sees the new row, so an update would otherwise be compared against the create-time defaults and
-- an owner could not edit their own note once a parent had approved it. Being SECURITY DEFINER, this can
-- read the stored row itself — present means update (compare against it), absent means insert (compare
-- against the gated defaults), which is exactly the firestore.rules split.
create or replace function public.app_owner_fields_ok(coll text, rowkey text, incoming jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with b as (
    select value -> split_part(coll, '__', 1) as bound
    from public.kv where store = '_meta' and key = 'ownerWritable'
  ),
  base as (
    select coalesce(
      (select value from public.kv where store = coll and key = rowkey),
      (select bound -> 'locked' from b)
    ) as baseline
  )
  select case
    when (select bound from b) is null then true
    else not exists (
      select 1
      from (
        select key from jsonb_each(coalesce(incoming, '{}'::jsonb))
        union
        select key from jsonb_each(coalesce((select baseline from base), '{}'::jsonb))
      ) k
      where k.key <> all (array['id','owner','created_at','updated_at','rosterPublic'])
        and not ((select bound -> 'cols' from b) ? k.key)
        and coalesce(incoming ->> k.key, '') is distinct from
            coalesce((select baseline from base) ->> k.key, '')
    )
  end
$$;

-- ---------- Document-shape validation ----------------------------------------------------------------
-- Mirrors firestore.rules' validProfile / validLink / validRequest. These stores are SELF-WRITABLE (a
-- member writes their own profile and their own access request), so "who" is only half the gate: without
-- a shape check an authenticated caller can park arbitrary extra keys and unbounded values in a row that
-- an admin's approval UI then renders. Postgres makes this MORE important than Firestore, not less --
-- jsonb tolerates ~1GB where Firestore rejects the document at 1MB, so the picture cap is the only thing
-- bounding an avatar upload.
--
-- Written as one function keyed on `store` so app_can_create (which is also the UPDATE with-check) has a
-- single call site, and so a store with no shape rules falls through to `true` explicitly rather than by
-- omission. Key-set checks use `not exists (... where k <> all(...))`: bool_and over an empty key set is
-- NULL, not true, which would deny an empty document instead of allowing it.
create or replace function public.app_valid_shape(store text, key text, val jsonb)
returns boolean language sql immutable as $$
  select case
    when store = '_profiles' then
      not exists (select 1 from jsonb_object_keys(val) k where k <> all (array['name','shared','picture']))
      and jsonb_typeof(val -> 'name') = 'string'
      and length(val ->> 'name') <= 100
      and (not (val ? 'shared')  or jsonb_typeof(val -> 'shared') = 'boolean')
      and (not (val ? 'picture') or (jsonb_typeof(val -> 'picture') = 'string' and length(val ->> 'picture') <= 350000))
    when store = '_list_users' then
      not exists (select 1 from jsonb_object_keys(val) k where k <> all (array['list','value','email','shared']))
      and jsonb_typeof(val -> 'list')  = 'string' and length(val ->> 'list')  <= 200
      and jsonb_typeof(val -> 'value') = 'string' and length(val ->> 'value') <= 500
      and jsonb_typeof(val -> 'email') = 'string' and length(val ->> 'email') <= 320
      and jsonb_typeof(val -> 'shared') = 'boolean'
    when store = '_access_requests' then
      not exists (select 1 from jsonb_object_keys(val) k where k <> all (array['email','name','note','ts']))
      and (not (val ? 'name') or (jsonb_typeof(val -> 'name') = 'string' and length(val ->> 'name') <= 100))
      and (not (val ? 'note') or (jsonb_typeof(val -> 'note') = 'string' and length(val ->> 'note') <= 500))
      and (not (val ? 'ts')   or jsonb_typeof(val -> 'ts') = 'number')
    -- Stored image assets (view backgrounds / image-cell bytes as data URIs, the no-bucket tier). Not
    -- self-writable -- admins/editors only -- but shape-checked anyway for the same reason the avatar is:
    -- jsonb would happily take a gigabyte, so the cap is the only thing bounding an upload here. Mirrors
    -- firestore.rules' _assets__active block; rules-parity.test.js compares the cap multisets.
    when store = '_assets__active' then
      not exists (select 1 from jsonb_object_keys(val) k where k <> all (array['id','src']))
      and jsonb_typeof(val -> 'src') = 'string'
      and length(val ->> 'src') <= 900000
    else true   -- _meta / _users / _lists / _pages__active / data tables: gated by role, not by shape
  end
$$;

-- ---------- Row predicates (keep the policies below readable) ----------------------------------------
-- READ gate. `val` is the existing row's value.
create or replace function public.app_can_read(store text, key text, val jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_email() is null then false
    when store = '_meta' then
      public.app_is_registered() and (
        (key <> 'lists' and key <> 'users') or public.app_no_users() or public.app_role() = 'admin'
      )
    when store = '_users' then
      public.app_no_users() or key = public.app_email() or public.app_role() = 'admin'
    when store = '_access_requests' then
      key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_profiles' then
      (val ->> 'shared') = 'true' or key = public.app_email()
        or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_list_users' then
      -- ...or the link that names ME: `@me` resolves through it on a `userlink` list, and it is the
      -- caller's own identity, so this exposes no email they don't already have.
      (val ->> 'shared') = 'true' or lower(val ->> 'email') = public.app_email()
      or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_lists' then
      public.app_is_registered() and (
        public.app_no_users() or public.app_role() = 'admin' or public.app_list_allowed(val -> 'tables')
        -- A list the schema OPENS to everyone (userWritableLists) is readable by every registered user.
        -- Not cosmetic: without it Postgres cannot APPEND to such a list either. An UPDATE has to locate
        -- its row, which applies the SELECT policy, so a list the caller cannot read is a list they
        -- cannot edit -- even though app_can_update deliberately grants them exactly that. Firestore
        -- evaluates its write rules independently of read, so the same member succeeds there; this is
        -- the clause that closes that gap. It grants read of precisely the lists the schema already
        -- lets everyone modify, so it widens nothing that writing did not already imply.
        or public.app_list_user_writable(key)
      )
    when store = '_pages__active' then
      public.app_is_registered() and (
        public.app_no_users() or public.app_role() = 'admin' or public.app_page_allowed(key)
      )
    -- Stored image assets: readable by every registered user (decoration; the row or view that REFERENCES
    -- an asset stays gated by its own rule, which is what controls seeing the image in context).
    when store = '_assets__active' then public.app_is_registered()
    when store like '\_%' then false   -- any other system store: deny (fail-safe; add its own rule)
    else  -- data tables
      -- Flat disjunction, matching the firestore.rules read gate exactly (see the note there): a grant,
      -- OR my own owner-stamped row, OR a row flagged public. RLS genuinely filters, so the shape is a
      -- free choice here -- it is written this way so the two layers say the same thing and cannot drift
      -- into different answers for the same row. `->>` on a missing key is NULL, never an error, so no
      -- key-presence guard is needed.
      public.app_is_registered() and (
        public.app_no_users() or public.app_role() = 'admin'
        or public.app_has_table_access(store)
        or (val ->> 'owner') = public.app_email()
        or (val ->> 'rosterPublic') = 'true'
      )
  end
$$;

-- An IDENTITY column (`defaultFrom: "@me"`, and owner-writable because otherwise the owner could not
-- create the row at all) may only ever carry the CALLER'S OWN value — otherwise a member logs the work
-- as somebody else, which the column bounds cannot catch since the column IS one they may write. The
-- caller's value comes from `_users/<email>.identity`, mirrored by setListUser: admin-write-only, so a
-- member cannot forge it, and app_user_data() already reads it. Mirrors firestore.rules ownerIdentityOk.
--   Only for a LIST-backed column: without a list the identity is the profile display name, which the
-- user writes themselves, so there would be nothing to verify against.
--   No `identity` on the grant -> migration grace (permissive), like app_self_service's missing doc.
create or replace function public.app_owner_identity_ok(coll text, incoming jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with b as (
    select value -> split_part(coll, '__', 1) as bound
    from public.kv where store = '_meta' and key = 'ownerWritable'
  )
  select case
    when (select bound from b) is null then true
    when coalesce((select bound ->> 'identityCol' from b), '') = '' then true
    when coalesce((select bound ->> 'identityList' from b), '') = '' then true
    when not (incoming ? (select bound ->> 'identityCol' from b)) then true
    when not (public.app_user_data() ? 'identity') then true          -- migration grace
    else incoming ->> (select bound ->> 'identityCol' from b)
         is not distinct from
         public.app_user_data() -> 'identity' ->> (select bound ->> 'identityList' from b)
  end
$$;

-- CREATE gate. `val` is the incoming row value.
create or replace function public.app_can_create(store text, key text, val jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_email() is null then false
    when store = '_meta' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_users' then public.app_no_users() or public.app_role() = 'admin'
    -- Shape gates mirror firestore.rules exactly, including WHO they bind: validProfile/validLink apply
    -- to the admin write too, validRequest only to the SELF-create (an admin editing a request is
    -- trusted there and here).
    when store = '_access_requests' then
      (key = public.app_email() and (val ->> 'email') = public.app_email()
        and public.app_valid_shape(store, key, val))
      or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_profiles' then
      (key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin'))
      and public.app_valid_shape(store, key, val)
    when store = '_list_users' then
      (public.app_no_users() or public.app_role() = 'admin')
      and public.app_valid_shape(store, key, val)
    -- INSERT is authorized from the schema mirror; UPDATE (which re-checks here as its WITH CHECK) from
    -- the stored label plus the no-re-stamp pin. app_list_editor_ok tells the two apart.
    when store = '_lists' then
      public.app_no_users() or public.app_role() = 'admin'
      or (public.app_is_registered() and public.app_list_user_writable(key)
          and public.app_list_editor_ok(key, val -> 'tables'))
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store = '_assets__active' then
      (public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor')
      and public.app_valid_shape(store, key, val)
    when store like '\_%' then false
    else  -- data tables
      public.app_no_users() or public.app_role() = 'admin'
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store)
          and public.app_owner_identity_ok(store, val)
          and public.app_owner_fields_ok(store, key, val))
      or (public.app_role() = 'editor' and public.app_has_table_write(store))
  end
$$;

-- ownerWritableWhile: does the owner branch still reach this STORED row? _meta/ownerWritable carries the
-- gate as whileCol + whileVals (a single column and a value list — neither rules language can loop over a
-- map). Empty whileCol, or a table absent from the mirror, means no gate. Mirrors firestore.rules
-- ownerStateOk, and like it this is asked of the OLD row (USING), never the incoming one — otherwise an
-- owner could send a compliant state alongside the edit and unlock their own approved row.
create or replace function public.app_owner_state_ok(coll text, oldval jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  with b as (
    select value -> split_part(coll, '__', 1) as bound
    from public.kv where store = '_meta' and key = 'ownerWritable'
  )
  select case
    when (select bound from b) is null then true
    when coalesce((select bound ->> 'whileCol' from b), '') = '' then true
    else (select bound -> 'whileVals' from b) ? coalesce(oldval ->> (select bound ->> 'whileCol' from b), '')
  end
$$;

-- UPDATE gate over the OLD row (USING). New-row validity is re-checked with app_can_create (WITH CHECK).
create or replace function public.app_can_update(store text, key text, val jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_email() is null then false
    when store = '_meta' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_access_requests' then not public.app_no_users() and public.app_role() = 'admin'
    when store = '_profiles' then
      key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_list_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_lists' then
      public.app_no_users() or public.app_role() = 'admin'
      -- Opened lists (userWritableLists) are editable by any registered user; the ownership label is
      -- pinned separately by app_list_editor_ok in the WITH CHECK. A table grant is deliberately not
      -- consulted — see app_list_user_writable.
      or (public.app_is_registered() and public.app_list_user_writable(key))
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store = '_assets__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store like '\_%' then false
    else  -- data tables: edit own owned row (while it is still owner-writable), or table editor
      public.app_no_users() or public.app_role() = 'admin'
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store)
          and public.app_owner_state_ok(store, val))
      or (public.app_role() = 'editor' and public.app_has_table_write(store))
  end
$$;

-- DELETE gate over the existing row.
create or replace function public.app_can_delete(store text, key text, val jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_email() is null then false
    when store = '_meta' then key <> 'users' and (public.app_no_users() or public.app_role() = 'admin')
    when store = '_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_access_requests' then
      key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_profiles' then
      key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_list_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_lists' then
      -- Deleting the DOC prunes a whole list, which only a full-view holder can judge: admin only,
      -- exactly as firestore.rules states it. Removing a VALUE is an update, handled above.
      public.app_no_users() or public.app_role() = 'admin'
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store = '_assets__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store like '\_%' then false
    else  -- data tables
      public.app_no_users() or public.app_role() = 'admin'
      -- Deleting my own row stops where editing it stops: ownerWritableWhile freezes an approved row
      -- against both. `val` IS the stored row here (a delete policy's USING sees the existing row).
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store)
          and public.app_owner_state_ok(store, val))
      or (public.app_role() = 'editor' and public.app_has_table_write(store))
  end
$$;

-- ---------- Policies ---------------------------------------------------------------------------------
drop policy if exists kv_select on public.kv;
drop policy if exists kv_insert on public.kv;
drop policy if exists kv_update on public.kv;
drop policy if exists kv_delete on public.kv;

create policy kv_select on public.kv
  for select to authenticated
  using (public.app_can_read(store, key, value));

create policy kv_insert on public.kv
  for insert to authenticated
  with check (public.app_can_create(store, key, value));

create policy kv_update on public.kv
  for update to authenticated
  using (public.app_can_update(store, key, value))
  with check (public.app_can_create(store, key, value));

create policy kv_delete on public.kv
  for delete to authenticated
  using (public.app_can_delete(store, key, value));

-- ---------- Realtime (live sync between clients) ------------------------------------------------------
-- The app subscribes to kv changes so one client's write appears in another's open view immediately
-- (backend-supabase.js subscribeTable -> live-sync.js). That needs kv in the realtime publication.
-- Guarded rather than a bare `alter publication ... add table`, which errors when the table is already
-- a member -- this file promises to be re-runnable.
-- Two guards, both needed: the publication itself only exists on Supabase (a plain Postgres, including
-- the pglite instance the RLS tests run against, has no supabase_realtime), and adding a table that is
-- already a member is an error rather than a no-op.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'kv'
     ) then
    alter publication supabase_realtime add table public.kv;
  end if;
end $$;

-- SECURITY NOTE -- what a realtime subscriber can see:
--   INSERT / UPDATE events ARE filtered by the kv_select policy above, per subscriber. A member
--   receives exactly the rows they could have fetched themselves, so realtime opens no read path that
--   the initial load did not already allow.
--   DELETE events are NOT filtered by RLS (a Postgres limitation, not a configuration choice: the row
--   is gone, so the policy has nothing left to evaluate). They carry the REPLICA IDENTITY, which here
--   is the default -- the primary key (store, key) and nothing else. So a subscriber can learn that
--   some row id under some store was deleted, never its contents. The client treats a delete for a row
--   it never cached as a no-op (live-sync.js applyChange).
--   Do NOT set `replica identity full` on kv: that would put the deleted row's full jsonb value into
--   an unfiltered broadcast.

-- Server-side shallow merge, the Postgres counterpart of Firestore's set(..., { merge: true }).
-- StorageSupabase.put used to do this as a client-side read-modify-write, which reintroduced the very
-- clobber that partial writes exist to prevent: two clients patching different columns of one row
-- within the same round-trip each wrote back their own stale copy of the other's column. `value || patch`
-- is a single atomic statement, so the second write merges onto the first instead of racing it.
-- SECURITY INVOKER (the default): this runs as the caller, so kv_insert/kv_update still gate it exactly
-- as a direct upsert would -- it is a concurrency fix, NOT a privilege bypass.
-- UPDATE FIRST, insert only if nothing was there. `insert ... on conflict do update` reads better and
-- is wrong here: Postgres evaluates the INSERT policy's WITH CHECK against the row PROPOSED FOR
-- INSERTION -- the bare patch -- before any conflict is detected. A partial write therefore had to
-- satisfy the CREATE rule on its own, with only the columns it happened to carry.
--
-- That silently broke every self-service cell edit. app-core's saveField sends { id, <col>, updated_at }
-- and nothing else, so the owner column lives on the STORED row, not in the patch; app_can_create saw a
-- row with no owner and refused. Firestore evaluates request.resource.data AFTER the merge and allows
-- it, and the dev server was taught to gate the merged row for exactly this reason -- Supabase was the
-- odd one out, and the only place a member's edits simply stopped working.
--
-- Update-first puts an existing row on the UPDATE policy instead, whose USING sees the stored value and
-- whose WITH CHECK sees the merged one. Both carry the owner. A genuinely new row still takes the
-- INSERT path and is still judged by the create rule, which is correct: there is no stored row to
-- inherit anything from.
create or replace function public.app_kv_merge(p_store text, p_key text, p_patch jsonb)
returns void language plpgsql as $$
begin
  update public.kv set value = public.kv.value || p_patch, updated_at = now()
   where store = p_store and key = p_key;
  if found then return; end if;
  begin
    insert into public.kv (store, key, value, updated_at)
    values (p_store, p_key, p_patch, now());
  exception when unique_violation then
    -- The row exists but the UPDATE above matched nothing. Either another caller inserted it in the
    -- gap (retry, and this succeeds), or the UPDATE policy filtered it away -- a refusal, which RLS
    -- expresses as zero rows rather than an error. Returning quietly here would report a refused write
    -- as a success, which is worse than refusing it.
    update public.kv set value = public.kv.value || p_patch, updated_at = now()
     where store = p_store and key = p_key;
    if not found then
      raise insufficient_privilege using
        message = 'new row violates row-level security policy for table "kv"';
    end if;
  end;
end $$;

grant execute on function public.app_kv_merge(text, text, jsonb) to authenticated;

-- ---------- Storage bucket for image uploads (optional; needed only if you use image columns) --------
-- Mirrors storage.rules (the Firebase Storage gate) condition for condition. Uploads land at
-- `<lowercased-user-email>/<ts>_<name>` (backend-supabase uploadFile), so the first path segment IS the
-- owner, exactly as it is on Firebase.
--
-- READ is public, and deliberately so: the row stores getPublicUrl(), and Firebase's stored download URL
-- carries an access token that renders regardless of its read rule -- so "anyone holding the URL can
-- fetch the image" is the behaviour on BOTH backends. Everything else is gated.
--
-- WRITE requires REGISTRATION, not merely a signed-in session. With the Google provider enabled,
-- "authenticated" means any Google account on the internet, and the project config is distributed by
-- shareable links by design -- so a registration-less bucket is free image hosting for strangers (this
-- is finding S1 in CODE_REVIEW.md, and it applies verbatim here). app_is_registered() is SECURITY
-- DEFINER over public.kv, so it answers the same question the kv policies do.
--
-- Size and MIME limits live on the BUCKET rather than in a policy: storage.objects.metadata is populated
-- by the storage service as part of the upload, so a WITH CHECK on it is not a dependable gate, whereas
-- file_size_limit / allowed_mime_types are enforced by the service before the row is ever written.
-- `do update` (not `do nothing`) so re-running this script applies the limits to a bucket created by an
-- earlier version -- which is exactly the deployment that has none.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', true, 10485760,
        array['image/png','image/jpeg','image/gif','image/webp','image/avif','image/bmp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists uploads_read on storage.objects;
drop policy if exists uploads_write on storage.objects;
drop policy if exists uploads_insert on storage.objects;
drop policy if exists uploads_update on storage.objects;
drop policy if exists uploads_delete on storage.objects;

create policy uploads_read on storage.objects
  for select using (bucket_id = 'uploads');

-- A registered member may write ONLY inside their own email folder. Without the foldername check any
-- authenticated caller could write (and, with update, replace) another member's object.
create policy uploads_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and public.app_is_registered()
    and (storage.foldername(name))[1] = public.app_email()
  );

create policy uploads_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'uploads'
    and public.app_is_registered()
    and (storage.foldername(name))[1] = public.app_email()
  )
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = public.app_email()
  );

create policy uploads_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'uploads'
    and public.app_is_registered()
    and (storage.foldername(name))[1] = public.app_email()
  );

-- =====================================================================================================
-- Bootstrap note: while no members exist (no _meta/users doc and no _users rows), ANY signed-in Google
-- account is treated as admin — this lets you sign in and load a schema. Add yourself as an admin in
-- Settings -> User Access immediately; from then on only registered users have access.
-- =====================================================================================================
