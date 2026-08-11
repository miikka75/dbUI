// rules-parity.test.js — Drift guards between the FOUR implementations of the access model:
//   firestore.rules        (production, Firebase)
//   supabase-schema.sql    (production, Supabase RLS)
//   dev/server.js          (dev backend, trusted X-User)
//   backend-helpers.js     (the shared mirror generator both rules layers read)
//
// The policy MATRIX can't be shared across four languages, but the constants and bounds inside it can
// be compared as text — and every cross-layer bug found so far has been one layer knowing a value the
// others didn't. These tests read the real files rather than a fixture, so a change to one side that
// isn't mirrored fails here instead of in production on one backend only.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, ...f.split('/')), 'utf8');

const RULES = read('firestore.rules');
const SQL = read('supabase-schema.sql');
const SERVER = read('dev/server.js');
const HELPERS = read('backend-helpers.js');
const STORAGE_RULES = read('storage.rules');

describe('rules parity — owner-writable system columns', () => {
  // The columns an owner-scoped write may always carry (identity + write bookkeeping). Listed in all
  // four layers; a column added to one and not the others either silently locks a field the app stamps
  // (write denied) or leaves a gated field writable on one backend.
  const EXPECTED = ['id', 'owner', 'created_at', 'updated_at', 'rosterPublic'];

  const fromQuoted = (src, re) => {
    const m = re.exec(src);
    assert.ok(m, 'system-column list not found — did the declaration move?');
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  };

  it('firestore.rules ownerSystemCols()', () => {
    assert.deepEqual(fromQuoted(RULES, /function ownerSystemCols\(\)\s*\{\s*return \[([^\]]+)\]/), EXPECTED);
  });
  it('supabase-schema.sql app_owner_fields_ok', () => {
    assert.deepEqual(fromQuoted(SQL, /k\.key <> all \(array\[([^\]]+)\]\)/), EXPECTED);
  });
  it('dev/server.js OWNER_SYSTEM', () => {
    assert.deepEqual(fromQuoted(SERVER, /const OWNER_SYSTEM = \[([^\]]+)\]/), EXPECTED);
  });
  it('backend-helpers.js ownerWritableOf SYSTEM', () => {
    assert.deepEqual(fromQuoted(HELPERS, /var SYSTEM = \[([^\]]+)\]/), EXPECTED);
  });
});

describe('rules parity — document-shape bounds', () => {
  // Each self-writable store's field caps. Firestore enforces them in validProfile/validLink/
  // validRequest; Supabase in app_valid_shape. A cap raised on one side only means the stricter
  // backend starts rejecting documents the other happily stores.
  const CAPS = [
    ['_profiles name', 100],
    ['_profiles picture', 350000],
    ['_list_users list', 200],
    ['_list_users value', 500],
    ['_list_users email', 320],
    ['_access_requests name', 100],
    ['_access_requests note', 500]
  ];

  const rulesCaps = (RULES.match(/size\(\)\s*<=\s*(\d+)/g) || []).map((s) => Number(s.match(/\d+/)[0]));
  const sqlCaps = (SQL.match(/length\(.+?\)\s*<=\s*(\d+)/g) || []).map((s) => Number(s.match(/\d+/)[0]));

  it('both layers declare the same multiset of size caps', () => {
    assert.deepEqual(
      sqlCaps.slice().sort((a, b) => a - b),
      rulesCaps.slice().sort((a, b) => a - b),
      'firestore.rules and supabase-schema.sql disagree on document size caps'
    );
  });

  for (const [what, cap] of CAPS) {
    it(`${what} is capped at ${cap} in both layers`, () => {
      assert.ok(rulesCaps.includes(cap), `firestore.rules is missing the ${cap} cap`);
      assert.ok(sqlCaps.includes(cap), `supabase-schema.sql is missing the ${cap} cap`);
    });
  }

  it('Supabase validates the same three self-writable stores Firestore does', () => {
    for (const store of ['_profiles', '_list_users', '_access_requests']) {
      assert.ok(
        new RegExp(`when store = '${store}' then`).test(SQL.slice(SQL.indexOf('app_valid_shape'))),
        `app_valid_shape has no branch for ${store}`
      );
    }
  });
});

describe('rules parity — the r/rw write fallback fails closed', () => {
  // A grant with no `rwTables` mirror predates the r/rw split, and those are legacy ARRAYS. Both write
  // gates in each layer must restrict the fallback to an array, or a mirror-less MAP silently promotes
  // its 'r' entries to 'rw'. This guard exists because app_list_write_allowed was missing the check
  // that app_has_table_write right above it had.
  it('firestore.rules guards both hasTableWrite and listWriteAllowed', () => {
    const fn = (name) => RULES.slice(RULES.indexOf('function ' + name), RULES.indexOf('function ' + name) + 400);
    assert.match(fn('hasTableWrite'), /is list/, 'hasTableWrite fallback is not array-guarded');
    assert.match(fn('listWriteAllowed'), /is list/, 'listWriteAllowed fallback is not array-guarded');
  });

  it('supabase-schema.sql guards both app_has_table_write and app_list_write_allowed', () => {
    const fn = (name) => SQL.slice(SQL.indexOf('function public.' + name), SQL.indexOf('function public.' + name) + 900);
    assert.match(fn('app_has_table_write'), /jsonb_typeof\([\s\S]*?'tables'\s*\)\s*=\s*'array'/,
      'app_has_table_write fallback is not array-guarded');
    assert.match(fn('app_list_write_allowed'), /jsonb_typeof\([\s\S]*?'tables'\s*\)\s*=\s*'array'/,
      'app_list_write_allowed fallback is not array-guarded — a mirror-less map would promote r to rw');
  });
});

describe('rules parity — both backends mirror the same schema-derived facts', () => {
  // Both rules layers are schema-blind, so saveSchema denormalizes what they need into _meta docs.
  // A backend that forgets one doesn't fail loudly — the corresponding rule just falls through to its
  // "no mirror yet" migration branch, which is permissive by design. So the only thing keeping the two
  // honest is that they write the SAME set.
  const mirrorKeys = (src) => {
    const body = src.slice(src.indexOf('saveSchema:'), src.indexOf('getPage:'));
    return (body.match(/setMeta\('([a-zA-Z]+)'/g) || [])
      .map((s) => s.match(/'([a-zA-Z]+)'/)[1])
      .sort();
  };

  const FIREBASE = read('backend-firebase.js');
  const SUPABASE = read('backend-supabase.js');

  it('backend-firebase and backend-supabase saveSchema mirror an identical key set', () => {
    assert.deepEqual(mirrorKeys(SUPABASE), mirrorKeys(FIREBASE),
      'one backend mirrors a _meta doc the other does not — its rules layer will silently use the permissive fallback');
  });

  it('the mirrored set is the one the rules layers actually read', () => {
    const keys = mirrorKeys(FIREBASE);
    for (const k of ['schema', 'ownerTables', 'pageAccess', 'ownerWritable', 'listTables']) {
      assert.ok(keys.includes(k), `saveSchema no longer mirrors _meta/${k}`);
    }
    // Each non-schema mirror must be consulted by BOTH rules layers, or it is dead weight in one.
    for (const k of ['ownerTables', 'pageAccess', 'ownerWritable', 'listTables']) {
      assert.ok(RULES.includes('_meta/' + k), `firestore.rules never reads _meta/${k}`);
      assert.ok(SQL.includes("key = '" + k + "'"), `supabase-schema.sql never reads _meta/${k}`);
    }
  });
});

describe('rules parity — the upload bucket is gated the same way on both backends', () => {
  // CODE_REVIEW.md S1: "signed in" means any Google account on the internet, and the project config is
  // distributed by shareable links by design. Both backends must require REGISTRATION, scope the write
  // to the caller's own email folder, and bound size + content type.
  it('Firebase Storage requires registration, own folder, size and content type', () => {
    assert.match(STORAGE_RULES, /isRegistered\(userEmail\)/);
    assert.match(STORAGE_RULES, /request\.auth\.token\.email\.lower\(\) == userEmail/);
    assert.match(STORAGE_RULES, /request\.resource\.size < 10 \* 1024 \* 1024/);
    assert.match(STORAGE_RULES, /contentType\.matches\('image\/\.\*'\)/);
  });

  it('Supabase Storage requires registration and the caller-owned folder on every write', () => {
    const policies = ['uploads_insert', 'uploads_update', 'uploads_delete'];
    for (const p of policies) {
      const i = SQL.indexOf('create policy ' + p);
      assert.ok(i > 0, `policy ${p} is missing`);
      const body = SQL.slice(i, i + 600);
      assert.match(body, /app_is_registered\(\)/, `${p} does not require registration`);
      assert.match(body, /storage\.foldername\(name\)\)\[1\] = public\.app_email\(\)/,
        `${p} does not scope the object to the caller's own folder`);
    }
  });

  it('Supabase bounds upload size and MIME on the bucket, matching the Firebase 10 MB image-only gate', () => {
    const i = SQL.indexOf('insert into storage.buckets');
    const body = SQL.slice(i, i + 600);
    assert.match(body, /10485760/, 'bucket has no 10 MB file_size_limit');
    assert.match(body, /allowed_mime_types/, 'bucket does not restrict MIME types');
    assert.match(body, /on conflict \(id\) do update/,
      're-running the script must apply limits to a bucket created before they existed');
  });
});
