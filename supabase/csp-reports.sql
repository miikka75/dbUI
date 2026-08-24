-- csp-reports.sql — storage for the Supabase Edge Function CSP collector
-- (supabase/functions/csp-report/index.ts). Apply once, in the SQL editor or via `supabase db push`.
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
