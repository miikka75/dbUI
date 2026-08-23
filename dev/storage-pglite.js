// storage-pglite.js — PGlite (PostgreSQL-in-WASM) storage adapter for the dev server.
//
// WHY THIS EXISTS: dev enforces access control in JavaScript (dev/server.js), Supabase enforces it in
// RLS, and Firebase in rules — three implementations of one policy, kept honest by comparing their
// source TEXT. This adapter runs the real supabase-schema.sql, verbatim, inside the dev process, so
// dev and Supabase stop being two implementations and become one file executed twice.
//
// It presents the same interface as storage-supabase.js / storage-firestore.js (get/put/delete/getAll/
// getMeta/setMeta/_all) over the identical kv(store, key, value jsonb) table, so the mapping from the
// app's contract onto storage is shared rather than reinvented.
//
// IDENTITY: Supabase authenticates with a JWT; here the dev server hands over the caller's email and
// this adapter sets `request.jwt.claims` + `set role authenticated` for the statement, exactly as
// dev/test/supabase-rls.test.js does. The policies cannot tell the difference.
//
// CONCURRENCY: role and request.jwt.claims are CONNECTION state, and PGlite is a single connection.
// Two overlapping requests would otherwise interleave one's `set role` with the other's queries and run
// under the wrong identity — a privilege bug rather than a race you would notice. Every operation is
// therefore serialized through a promise chain, and the identity is re-established inside each critical
// section rather than assumed to have survived the previous one.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORAGE_MARKER = '-- ---------- Storage bucket';   // the same cut point supabase-rls.test.js uses

async function createPgliteStorage(opts) {
  const options = opts || {};
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(options.dataDir || undefined);   // undefined = in-memory

  // --- serialize every operation (see CONCURRENCY above) -------------------------------------------
  let chain = Promise.resolve();
  function serial(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(function () {}, function () {});   // a rejection must not poison the queue
    return run;
  }

  const q = (sql, params) => db.query(sql, params);

  async function applySchema() {
    // Roles must exist before the schema's REVOKE/GRANT statements name them. Guarded, because on a
    // PERSISTED dataDir (APP_DB=<file>) this runs again on every boot against a database that already
    // has them -- and an unguarded CREATE ROLE made the second start fail outright with `role
    // "authenticated" already exists`, so the persistent option could be used exactly once. The rest of
    // the bootstrap is already idempotent (`create or replace`, and supabase-schema.sql's own
    // `drop policy if exists`); these two statements were the only ones that were not.
    await db.exec(`do $roles$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    end $roles$;`);
    // Supabase's own auth.jwt(), reproduced — the policies read the caller's email through it.
    await db.exec([
      'create schema if not exists auth;',
      'create or replace function auth.jwt() returns jsonb language sql stable as $shim$',
      "  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb",
      '$shim$;',
      'grant usage on schema auth to authenticated, anon;'
    ].join('\n'));

    const full = fs.readFileSync(path.join(ROOT, 'supabase-schema.sql'), 'utf8');
    const cut = full.indexOf(STORAGE_MARKER);
    if (cut <= 0) throw new Error('supabase-schema.sql: the storage-section marker moved; this adapter cuts there');
    await db.exec(full.slice(0, cut));   // the real policies, verbatim
  }
  await applySchema();

  // --- identity ------------------------------------------------------------------------------------
  let currentEmail = null;

  async function enterCaller(email) {
    await db.exec('reset role');
    await q('select set_config($1, $2, false)',
            ['request.jwt.claims', JSON.stringify(email ? { email: email } : {})]);
    await db.exec('set role authenticated');
  }
  const leave = () => db.exec('reset role');

  // asCaller: RLS enforcing, as the caller in effect WHEN THE OPERATION WAS REQUESTED. Capturing the
  // email here rather than inside the queued body is load-bearing: setCaller() mutates one variable, so
  // an operation that reads it at execution time runs as whoever called setCaller LAST, not as the
  // caller who asked for it. With overlapping requests that silently evaluates one user's write under
  // another user's grants.
  // asOwner: RLS bypassed, for the few things that are genuinely not a user action.
  function asCaller(fn) {
    const email = currentEmail;
    return serial(async function () {
      await enterCaller(email);
      try { return await fn(); } finally { await leave(); }
    });
  }
  function asOwner(fn) {
    return serial(async function () { await leave(); return fn(); });
  }

  // An RLS refusal surfaces either as an error, or as zero affected rows because USING filtered the row
  // out before the statement saw it. Both are denials; callers must not be able to tell them apart.
  const isRlsError = (e) => /row-level security|permission denied/i.test((e && e.message) || '');
  // Keep the original error as `cause`: a denial that discards why it happened turns every policy
  // investigation into guesswork, and this is a dev server -- there is no one to leak it to.
  const denied = (e) => Object.assign(new Error('denied by row-level security'), { cause: e });

  return {
    // --- lifecycle ---
    open: () => Promise.resolve(),
    ensureStore: () => Promise.resolve(),
    close: () => db.close(),

    // The dev server calls this per request, before touching any data.
    setCaller(email) { currentEmail = email || null; },

    // --- interface shared with StorageSupabase / StorageFirestore ---
    get(store, key) {
      return asCaller(async function () {
        const r = await q('select value from public.kv where store = $1 and key = $2', [store, key]);
        return r.rows.length ? r.rows[0].value : undefined;
      });
    },

    // Calls the schema's OWN merge function rather than reimplementing it, so dev takes exactly the
    // write path production takes: `value || patch` in one statement, SECURITY INVOKER, gated by the
    // same kv policies.
    //
    // Note what is deliberately NOT here: a `returning` clause used as the verdict. That was the first
    // version, and it reported a false DENIAL for a caller who may WRITE a row but not READ it --
    // `returning` is a read, so it yields nothing and the write looks refused. Write-without-read is
    // not a corner case: a list opened by userWritableLists is exactly that, appendable by any member
    // while the grants still govern who can see it. A refusal now comes only from the policy raising.
    put(store, key, value) {
      return asCaller(async function () {
        try {
          await q('select public.app_kv_merge($1, $2, $3::jsonb)', [store, key, JSON.stringify(value || {})]);
          return null;
        } catch (e) { throw isRlsError(e) ? denied(e) : e; }
      });
    },

    // A DELETE that RLS filters away affects zero rows and RAISES NOTHING, so "no error" is not a
    // verdict here -- the first version of this reported a refused delete as a success. Zero rows is
    // genuinely ambiguous though: the contract says deleting an absent row is a no-op, so it means
    // either "refused" or "not there". The only way to tell them apart is to look, which is why the
    // privileged probe runs on that path alone and never on the happy one.
    delete(store, key) {
      return asCaller(async function () {
        let affected;
        try {
          const r = await q('delete from public.kv where store = $1 and key = $2', [store, key]);
          affected = r.affectedRows;
        } catch (e) { throw isRlsError(e) ? denied(e) : e; }
        if (affected) return null;
        await leave();                                   // owner: RLS off, to ask whether it survived
        const still = await q('select 1 from public.kv where store = $1 and key = $2', [store, key]);
        if (still.rows.length) throw denied();           // it is there and the delete did not touch it
        return null;                                     // genuinely absent -- a no-op, per the contract
      });
    },

    // `constraints` (from query.js) narrow the read in the database instead of in the browser. Only
    // equality is ever passed -- the compiler refuses anything whose meaning differs between the matcher
    // and a query -- so this is a jsonb text comparison and nothing cleverer.
    //
    // Narrowing here is always SAFE even if it were wrong, in one direction only: the caller re-filters
    // whatever comes back with the residual. What it must never do is drop a row the condition would
    // keep, which is why the compiler is the one deciding what may be pushed, not this function.
    getAll(store, constraints) {
      const where = ['store = $1'];
      const params = [store];
      (constraints || []).forEach(function (c) {
        if (!c || c.op !== '==') return;                 // unknown op: leave it to the residual
        params.push(c.field, c.value === null ? null : String(c.value));
        where.push('value->>$' + (params.length - 1) + ' = $' + params.length);
      });
      return asCaller(async function () {
        const r = await q('select value from public.kv where ' + where.join(' and ') + ' order by key', params);
        return r.rows.map((x) => x.value);
      });
    },

    getMeta(key) {
      return asCaller(async function () {
        const r = await q("select value from public.kv where store = '_meta' and key = $1", [key]);
        return r.rows.length ? r.rows[0].value : undefined;
      });
    },

    // setMeta REPLACES (no merge), matching StorageSupabase/StorageFirestore. A non-object is boxed as
    // { _value } so BackendHelpers unwraps it identically across every backend.
    setMeta(key, value) {
      const boxed = (typeof value === 'object' && value !== null) ? value : { _value: value };
      return asCaller(async function () {
        try {
          const r = await q(
            "insert into public.kv (store, key, value) values ('_meta', $1, $2::jsonb)" +
            ' on conflict (store, key) do update set value = excluded.value returning key',
            [key, JSON.stringify(boxed)]);
          if (!r.rows.length) throw denied();
          return null;
        } catch (e) { throw isRlsError(e) ? denied(e) : e; }
      });
    },

    // Collection-style read (keys alongside values) — the kv equivalent of a Firestore query.
    _all(store) {
      return asCaller(async function () {
        const r = await q('select key, value from public.kv where store = $1 order by key', [store]);
        return r.rows;
      });
    },

    // --- escape hatches, deliberately few -------------------------------------------------------------
    // Seeding and reset are not user actions, so they run as owner with RLS bypassed. Everything an
    // actual request touches goes through asCaller above.
    _seed(store, key, value) {
      return asOwner(() => q(
        'insert into public.kv (store, key, value) values ($1, $2, $3::jsonb)' +
        ' on conflict (store, key) do update set value = excluded.value',
        [store, key, JSON.stringify(value)]));
    },
    _resetData() { return asOwner(() => q('delete from public.kv')); },
    // Run a statement UNDER THE CALLER, with RLS enforcing. _query runs as owner, which is the wrong
    // tool for asking "what would the policy say for this user?" -- it answers as the one identity the
    // policies never see.
    _callerQuery(sql, params) { return asCaller(() => q(sql, params)); },
    _query(sql, params) { return asOwner(() => q(sql, params)); }
  };
}

module.exports = { createPgliteStorage };
