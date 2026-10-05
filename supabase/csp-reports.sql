-- csp-reports.sql — storage for the Supabase Edge Function CSP collector
-- (supabase/functions/csp-report/index.ts). Apply once, in the dashboard's SQL EDITOR.
--
-- NOT via `supabase db push`: that applies migrations from supabase/migrations/, and this file is
-- deliberately not a migration (see below). This header used to say `db push` would do it, which
-- fails silently in the worst way -- the collector then accepts every report, answers 204, and
-- stores nothing, so the gap only surfaces on the first read as "Storage error".
--
-- WHY THIS EXISTS SEPARATELY FROM supabase-schema.sql: the collector is useful whether or not
-- Supabase is the app's backend. Somebody on Firestore who only wants somewhere free to receive CSP
-- reports should not have to apply the whole application schema, and somebody on Supabase should not
-- have their app's `kv` table entangled with violation counters. So this is standalone and additive:
-- applying it to a project that already runs supabase-schema.sql changes nothing about the app.

create table if not exists public.csp_reports (
  -- (directive, blocked_uri) collapsed into one key, so a repeated violation increments rather than
  -- appending. A browser can emit one report per page load per violation; storing them individually
  -- would grow without bound for a policy that is wrong in one small way.
  id              text primary key,
  directive       text not null,
  blocked_uri     text not null,
  sample_document text,
  count           bigint not null default 0,
  last_seen       timestamptz not null default now()
);

-- No policies, deliberately. RLS with an empty policy set denies everything, and the Edge Function
-- talks to this table with the SERVICE ROLE, which bypasses RLS. So the violation log is readable
-- only through the token-gated GET, never by a signed-in user of the app -- the same property the
-- Firestore version gets from its leading underscore and the client catch-all deny.
alter table public.csp_reports enable row level security;
alter table public.csp_reports force row level security;
revoke all on public.csp_reports from anon, authenticated;

-- Counting has to be atomic: two browsers reporting the same violation at once must produce 2, not 1.
-- A read-modify-write from the function would lose one of them, so the increment happens in the
-- database as a single statement. SECURITY DEFINER so it can write a table nobody else may touch;
-- execute is revoked from the client roles, so only the service role can call it.
create or replace function public.csp_report_record(
  p_id text, p_directive text, p_blocked text, p_doc text
) returns void language sql security definer set search_path = public as $$
  insert into public.csp_reports (id, directive, blocked_uri, sample_document, count, last_seen)
  values (p_id, p_directive, p_blocked, p_doc, 1, now())
  on conflict (id) do update
    set count           = public.csp_reports.count + 1,
        last_seen       = now(),
        -- Keep the most recent page a violation was seen on: it is the useful one when tracking down
        -- which flow trips the policy, and a stale sample is worse than none.
        sample_document = excluded.sample_document;
$$;

-- REVOKE FROM PUBLIC, not from the named roles. Postgres grants EXECUTE on a new function to PUBLIC
-- by default, so revoking from anon/authenticated individually leaves them holding it through PUBLIC
-- -- a SECURITY DEFINER function anyone could call, which is precisely the write the table grant above
-- withholds. (Caught by supabase-csp-collector.test.js, which is why it tests the roles and not the
-- grant statements.)
revoke all on function public.csp_report_record(text, text, text, text) from public;

-- ...then hand it back to the one role the Edge Function uses. Guarded, because `service_role` is a
-- Supabase-provisioned role and does not exist on a plain PostgreSQL (the test harness, for one).
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.csp_report_record(text, text, text, text) to service_role;
    grant select, insert, update on public.csp_reports to service_role;
  end if;
end
$grant$;

-- ── The read token, rotatable without the CLI ───────────────────────────────────────────────────────
-- The token used to live only in the function's environment (`supabase secrets set`), which nothing but
-- the CLI or the Management API can write -- and reaching that API from a browser takes a credential
-- for the whole project. So the token can live HERE instead, where the function (service role) can
-- rewrite it, and a rotation is authorised by the token being rotated: whoever holds it may swap it for
-- a new one. No user model, so this file stays standalone and a Firestore deployment can rotate too.
--
-- The environment secret is the BOOTSTRAP: with no row, the function's `DBUI_CSP_REPORT_TOKEN` is the
-- token, so an existing deployment keeps working and moves into this table on its first rotation.
-- After that the environment value is dead -- which is the point when it is rotated because it leaked.
create table if not exists public.csp_report_token (
  id    boolean primary key default true check (id),   -- one row, by construction
  token text not null
);
alter table public.csp_report_token enable row level security;
alter table public.csp_report_token force row level security;
revoke all on public.csp_report_token from anon, authenticated;

-- Is `p_token` the token? The stored one when a row exists, else the environment's (`p_env`). An EMPTY
-- token is never valid: an unset secret must not publish the log.
create or replace function public.csp_report_token_ok(p_token text, p_env text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(nullif(p_token, ''), chr(1)) = coalesce(
    (select token from public.csp_report_token where id),
    nullif(p_env, ''), chr(2));
$$;

-- Swap the token for `p_new`, if `p_current` is the token now. Compare-and-swap, so two rotations racing
-- with the same token cannot both succeed and leave one admin holding a token that no longer opens
-- anything without being told.
create or replace function public.csp_report_rotate(p_current text, p_env text, p_new text)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_new is null or length(p_new) < 32 then return false; end if;
  if exists (select 1 from public.csp_report_token where id) then
    update public.csp_report_token set token = p_new where id and token = p_current and p_current <> '';
  else
    -- Bootstrapping from the environment: only the environment's token may claim the row, and
    -- `do nothing` lets just one of two racing first rotations win.
    if coalesce(p_env, '') = '' or p_current is distinct from p_env then return false; end if;
    insert into public.csp_report_token (id, token) values (true, p_new) on conflict (id) do nothing;
  end if;
  get diagnostics n = row_count;
  return n = 1;
end
$$;

revoke all on function public.csp_report_token_ok(text, text) from public;
revoke all on function public.csp_report_rotate(text, text, text) from public;
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.csp_report_token_ok(text, text) to service_role;
    grant execute on function public.csp_report_rotate(text, text, text) to service_role;
    grant select, insert, update on public.csp_report_token to service_role;
  end if;
end
$grant$;
