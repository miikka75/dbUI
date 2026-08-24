// supabase-csp-collector.test.js — the storage half of the Supabase Edge Function CSP collector.
//
// The function itself is Deno and cannot run here, but everything that decides whether it is SAFE and
// whether it COUNTS correctly is SQL, and that runs against a real PostgreSQL via PGlite — the same
// approach supabase-rls.test.js takes for the app's policies.
//
// Two properties matter:
//   - the violation log must be unreachable by the app's own users. It records what a browser refused
//     to load on somebody's screen, and the Firestore version gets that from a leading underscore
//     plus the client catch-all deny; here it comes from RLS with an empty policy set.
//   - counting must be ATOMIC. A browser emits one report per page load per violation, so the same
//     violation arrives concurrently from several clients; a read-modify-write in the function would
//     lose reports and quietly understate a policy problem.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
let db;
const q = (sql, params) => db.query(sql, params);
const exec = (sql) => db.exec(sql);

const asOwner = () => exec('reset role');
const asClient = async (role) => { await exec('reset role'); await exec('set role ' + role); };

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await exec('create role authenticated; create role anon; create role service_role bypassrls;');
  await exec(fs.readFileSync(path.join(ROOT, 'supabase', 'csp-reports.sql'), 'utf8'));
});
after(async () => { try { await db.close(); } catch (e) { /* already closed */ } });

const record = (id, directive, blocked, doc) =>
  q('select public.csp_report_record($1, $2, $3, $4)', [id, directive, blocked, doc]);
const rows = async () => (await q('select * from public.csp_reports order by count desc')).rows;

describe('supabase CSP collector — counting', () => {
  it('records a violation once', async () => {
    await asOwner();
    await record('v_1', 'script-src', 'https://evil.example/x.js', 'https://app/page');
    const r = await rows();
    assert.equal(r.length, 1);
    assert.equal(Number(r[0].count), 1);
    assert.equal(r[0].directive, 'script-src');
    assert.equal(r[0].blocked_uri, 'https://evil.example/x.js');
  });

  it('INCREMENTS on repeat rather than adding a row', async () => {
    // The whole reason for a keyed upsert: one wrong directive on a busy page would otherwise write a
    // row per page load, forever.
    await asOwner();
    await record('v_1', 'script-src', 'https://evil.example/x.js', 'https://app/other');
    await record('v_1', 'script-src', 'https://evil.example/x.js', 'https://app/third');
    const r = await rows();
    assert.equal(r.length, 1, 'a repeat violation created a second row');
    assert.equal(Number(r[0].count), 3);
  });

  it('keeps the MOST RECENT document as the sample', async () => {
    // Which page tripped the policy is the useful part when tracking one down, and the newest sample
    // is the one worth keeping.
    await asOwner();
    const r = await rows();
    assert.equal(r[0].sample_document, 'https://app/third');
  });

  it('counts concurrent reports of the same violation without losing any', async () => {
    // The property a read-modify-write in the Edge Function would break.
    await asOwner();
    await q("delete from public.csp_reports");
    await Promise.all(Array.from({ length: 25 }, () =>
      record('v_race', 'img-src', 'data:', 'https://app/p')));
    const r = await rows();
    assert.equal(Number(r[0].count), 25, 'concurrent reports were lost');
  });

  it('distinct violations stay distinct', async () => {
    await asOwner();
    await record('v_other', 'style-src', 'inline', 'https://app/p');
    const r = await rows();
    assert.deepEqual(r.map((x) => x.directive).sort(), ['img-src', 'style-src']);
  });
});

describe('supabase CSP collector — the log is not readable by the app’s users', () => {
  for (const role of ['anon', 'authenticated']) {
    it(role + ' cannot read the violation log', async () => {
      await asClient(role);
      // RLS with no policies filters everything; a bare table grant would have been the mistake.
      const r = await q('select * from public.csp_reports').catch((e) => ({ rows: [], err: e }));
      assert.equal((r.rows || []).length, 0, role + ' can read what browsers refused to load on real screens');
    });

    it(role + ' cannot write to the violation log', async () => {
      await asClient(role);
      await assert.rejects(
        () => q("insert into public.csp_reports (id, directive, blocked_uri) values ('x','y','z')"),
        role + ' can forge violation records');
    });

    it(role + ' cannot call the recorder directly', async () => {
      // It is SECURITY DEFINER, so an un-revoked EXECUTE would hand exactly the write that the table
      // grant above withholds.
      await asClient(role);
      await assert.rejects(() => record('v_forged', 'script-src', 'x', 'y'),
        role + ' can call csp_report_record, which writes as the definer');
    });
  }
});

describe('supabase CSP collector — the Edge Function’s own role still works', () => {
  it('service_role CAN record and read', async () => {
    // The mirror image of the revokes above: locking the function down must not lock out the caller
    // it exists for. Revoking from PUBLIC is broad enough to catch service_role too, hence the
    // explicit grant-back.
    await asClient('service_role');
    await record('v_svc', 'font-src', 'https://fonts.example/f.woff2', 'https://app/p');
    const r = await q('select * from public.csp_reports where id = $1', ['v_svc']);
    assert.equal(r.rows.length, 1, 'the Edge Function’s own role cannot use its collector');
    assert.equal(Number(r.rows[0].count), 1);
  });
});

describe('supabase CSP collector — report shapes match the other two collectors', () => {
  // Three implementations now parse browser reports: the Firebase function, the dev collector, and the
  // Edge Function. They cannot share a module (each is bundled from its own directory), so the thing
  // worth pinning is that none of them quietly stops understanding one of the two report formats.
  const sources = {
    'functions/index.js': fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'),
    'dev/csp-report-collector.js': fs.readFileSync(path.join(ROOT, 'dev', 'csp-report-collector.js'), 'utf8'),
    'supabase/functions/csp-report/index.ts': fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'csp-report', 'index.ts'), 'utf8')
  };
  // report-uri sends hyphenated keys; report-to sends camelCase ones. Missing either means silently
  // dropping every report from browsers using that shape.
  const FIELDS = ['violated-directive', 'effective-directive', 'effectiveDirective',
                  'blocked-uri', 'blockedURL', 'document-uri', 'documentURL'];
  for (const [name, src] of Object.entries(sources)) {
    it(name + ' understands both report shapes', () => {
      assert.ok(src.includes('normalize'), name + ': no normalize() — this test would pass vacuously');
      const missing = FIELDS.filter((f) => !src.includes(f));
      assert.deepEqual(missing, [], name + ' ignores these report fields');
    });
  }
});
