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
    else (public.app_user_data() -> 'tables') ? split_part(coll, '__', 1)
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

-- Writing a list needs WRITE access to an owning table, not merely sight of it.
create or replace function public.app_list_write_allowed(row_tables jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_is_admin() then true
    when public.app_user_data() is null then false
    when public.app_user_data() -> 'tables' = '"all"'::jsonb then true
    else exists (
      select 1 from jsonb_array_elements_text(coalesce(row_tables, '[]'::jsonb)) e
      where case
        when public.app_user_data() ? 'rwTables' then (public.app_user_data() -> 'rwTables') ? e
        else (public.app_user_data() -> 'tables') ? e
      end
    )
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
      )
    when store = '_pages__active' then
      public.app_is_registered() and (
        public.app_no_users() or public.app_role() = 'admin' or public.app_page_allowed(key)
      )
    when store like '\_%' then false   -- any other system store: deny (fail-safe; add its own rule)
    else  -- data tables
      public.app_is_registered() and (
        public.app_no_users() or public.app_role() = 'admin' or (
          case when val ? 'owner'
            then (val ->> 'owner') = public.app_email()
                 or (val ->> 'rosterPublic') = 'true'
                 or public.app_has_table_access(store)
            else public.app_has_table_access(store)
          end
        )
      )
  end
$$;

-- CREATE gate. `val` is the incoming row value.
create or replace function public.app_can_create(store text, key text, val jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.app_email() is null then false
    when store = '_meta' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_access_requests' then
      (key = public.app_email() and (val ->> 'email') = public.app_email())
      or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_profiles' then
      key = public.app_email() or (not public.app_no_users() and public.app_role() = 'admin')
    when store = '_list_users' then public.app_no_users() or public.app_role() = 'admin'
    when store = '_lists' then
      public.app_no_users() or public.app_role() = 'admin'
      or (public.app_role() = 'editor' and public.app_list_write_allowed(val -> 'tables'))
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store like '\_%' then false
    else  -- data tables
      public.app_no_users() or public.app_role() = 'admin'
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store))
      or (public.app_role() = 'editor' and public.app_has_table_write(store))
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
      or (public.app_role() = 'editor' and public.app_list_write_allowed(val -> 'tables'))
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store like '\_%' then false
    else  -- data tables: edit own owned row, or table editor
      public.app_no_users() or public.app_role() = 'admin'
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store))
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
      public.app_no_users() or public.app_role() = 'admin'
      or (public.app_role() = 'editor' and public.app_list_write_allowed(val -> 'tables'))
    when store = '_pages__active' then
      public.app_no_users() or public.app_role() = 'admin' or public.app_role() = 'editor'
    when store like '\_%' then false
    else  -- data tables
      public.app_no_users() or public.app_role() = 'admin'
      or ((val ->> 'owner') = public.app_email() and public.app_self_service(store))
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

-- ---------- Storage bucket for image uploads (optional; needed only if you use image columns) --------
-- Creates a PUBLIC bucket `uploads`; any signed-in user may upload, everyone may read (parity with the
-- Firebase download-URL behavior). Adjust if you need stricter rules.
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;

drop policy if exists uploads_read on storage.objects;
drop policy if exists uploads_write on storage.objects;

create policy uploads_read on storage.objects
  for select using (bucket_id = 'uploads');

create policy uploads_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'uploads');

-- =====================================================================================================
-- Bootstrap note: while no members exist (no _meta/users doc and no _users rows), ANY signed-in Google
-- account is treated as admin — this lets you sign in and load a schema. Add yourself as an admin in
-- Settings -> User Access immediately; from then on only registered users have access.
-- =====================================================================================================
