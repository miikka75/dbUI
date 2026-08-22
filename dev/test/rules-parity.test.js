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
  //
  // `_status` is here as a KEY the owner may carry, not as a field they may set to anything: its VALUE
  // is gated separately (firestore.rules statusCreateOk/statusUnchanged, app_status_ok in the RLS) to
  // 'active' on create and unchanged on update. Both halves are needed — without the key an owner
  // cannot create a row at all once the app stamps _status on every row; without the value gate they
  // could file their own row away with no table grant.
  const EXPECTED = ['id', 'owner', 'created_at', 'updated_at', 'rosterPublic', '_status'];

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

describe('rules parity — ownerWritableWhile (the owner-branch state gate)', () => {
  // `ownerWritable` says which columns an owner may rewrite; `ownerWritableWhile` says until when. It is
  // the half that stops a member editing (or deleting) their own row after it was approved, so a layer
  // that never learned it leaves exactly that hole open on one backend.
  it('backend-helpers.js mirrors it as whileCol + whileVals', () => {
    assert.match(HELPERS, /whileCol:\s*whileCol/, 'ownerWritableOf must emit whileCol');
    assert.match(HELPERS, /whileVals:\s*whileVals/, 'ownerWritableOf must emit whileVals');
    assert.match(HELPERS, /ownerRowInState:\s*function/, 'the shared predicate must exist');
  });
  it('firestore.rules gates owner UPDATE and DELETE on it', () => {
    assert.match(RULES, /function ownerStateOk\(coll\)/, 'firestore.rules needs ownerStateOk');
    assert.match(RULES, /ownerStateOk\(coll\)[\s\S]{0,200}?affectedKeys/, 'ownerUpdateOk must consult ownerStateOk');
    assert.match(RULES, /selfServiceTable\(collection\) && ownerStateOk\(collection\)\) \|\| \/\/ delete/,
      'the owner DELETE branch must consult ownerStateOk');
  });
  it('supabase-schema.sql gates owner UPDATE and DELETE on it', () => {
    assert.match(SQL, /create or replace function public\.app_owner_state_ok/, 'supabase needs app_owner_state_ok');
    const uses = (SQL.match(/public\.app_owner_state_ok\(store, val\)/g) || []).length;
    assert.equal(uses, 2, 'app_can_update AND app_can_delete must both call it (found ' + uses + ')');
  });
  it('dev/server.js gates owner update and delete on it', () => {
    assert.match(SERVER, /BackendHelpers\.ownerRowInState\(bounds, existing\)/, 'the update path must consult it');
    assert.match(SERVER, /BackendHelpers\.ownerRowInState\(dBounds, existing\)/, 'the delete path must consult it');
  });
  it('a mirror written BEFORE the feature does not deny every owner write', () => {
    // Reading a missing property is an evaluation ERROR in Firestore rules, not undefined — so without
    // the `in` probe, ownerUpdateOk threw on every deployment whose _meta/ownerWritable predates this.
    // Supabase gets it for free (`->> 'whileCol'` on a missing key is NULL, coalesced to '').
    assert.match(RULES, /!\('whileCol' in ownerBounds\(coll\)\)/,
      'ownerStateOk must probe for whileCol before reading it');
    assert.match(SQL, /coalesce\(\(select bound ->> 'whileCol' from b\), ''\) = '' then true/,
      'app_owner_state_ok must treat a missing whileCol as "no gate"');
  });
  it('every layer reads the STORED row, never the incoming one', () => {
    // Reading the incoming row would let an owner send a compliant state alongside the edit and unlock
    // their own approved row — the one mistake that makes this feature decorative.
    assert.match(RULES, /resource\.data\[ownerBounds\(coll\)\.whileCol\]/);
    assert.doesNotMatch(RULES, /request\.resource\.data\[ownerBounds\(coll\)\.whileCol\]/);
    assert.match(SQL, /oldval ->> \(select bound ->> 'whileCol' from b\)/);
  });
});

describe('rules parity — identity columns (an owner may only name themselves)', () => {
  // A `defaultFrom: "@me"` column has to be owner-writable or the owner cannot create the row, which
  // left them free to log the work as somebody else. Rules cannot QUERY for "the link naming me", so the
  // caller's value is mirrored onto the admin-write-only grant doc both layers already read.
  it('backend-helpers emits identityCol + identityList and the shared predicate', () => {
    assert.match(HELPERS, /identityCol:\s*identityCol/, 'ownerWritableOf must emit identityCol');
    assert.match(HELPERS, /identityList:\s*identityList/, 'ownerWritableOf must emit identityList');
    assert.match(HELPERS, /ownerIdentityOk:\s*function/, 'the shared predicate must exist');
  });
  it('firestore.rules gates owner CREATE and UPDATE on it', () => {
    assert.match(RULES, /function ownerIdentityOk\(coll\)/, 'firestore.rules needs ownerIdentityOk');
    const uses = (RULES.match(/ownerIdentityOk\(coll\)/g) || []).length;
    assert.equal(uses, 3, 'declaration + create + update should reference it (found ' + uses + ')');
  });
  it('supabase gates the owner branch on it', () => {
    assert.match(SQL, /create or replace function public\.app_owner_identity_ok/, 'supabase needs app_owner_identity_ok');
    assert.match(SQL, /public\.app_owner_identity_ok\(store, val\)/, 'the owner branch must call it');
  });
  it('dev/server.js gates the owner branch on it', () => {
    // `await` is tolerated: the dev server's backend calls became async so the same code could run
    // against PGlite. What this guards is that the identity is RESOLVED and passed, not the spelling.
    assert.match(SERVER, /BackendHelpers\.ownerIdentityOk\(bounds, incoming, (?:await )?myIdentityFor\(bounds\.identityList\)\)/,
      'the dev server must consult it with the caller resolved identity');
  });
  it('all three read the mirror off the grant doc, never a self-writable one', () => {
    // `_profiles` is self-writable, so an identity taken from there could be forged by its own subject.
    assert.match(RULES, /u\.identity\.get\(b\.identityList/, 'firestore must read identity off userData()');
    assert.match(SQL, /app_user_data\(\) -> 'identity'/, 'supabase must read identity off app_user_data()');
  });
  it('an absent mirror is permissive (migration grace), in both layers', () => {
    // Failing closed here would lock every existing member out of logging until an admin re-saved links.
    assert.match(RULES, /!\('identity' in u\)/);
    assert.match(SQL, /not \(public\.app_user_data\(\) \? 'identity'\) then true/);
  });
});

describe('rules parity — userWritableLists (list editing is admin-only by default)', () => {
  // A list is shared vocabulary, so writing one is admin-only unless the schema opens it. A layer that
  // never learned the allowlist keeps handing every editor with one rw table the run of every list those
  // columns touch — `members` included.
  it('backend-helpers.js emits the allowlist mirror', () => {
    assert.match(HELPERS, /userWritableListsOf:\s*function/, 'the mirror generator must exist');
    assert.match(HELPERS, /userWritableLists/, 'it must read the schema key');
  });
  it('firestore.rules gates the non-admin branch of _lists create and update', () => {
    assert.match(RULES, /function listUserWritable\(listName\)/, 'firestore.rules needs listUserWritable');
    const uses = (RULES.match(/listUserWritable\(listName\)/g) || []).length;
    assert.equal(uses, 3, 'declaration + create + update should reference it (found ' + uses + ')');
    assert.doesNotMatch(RULES, /listUserWritable\(listName\) && list(Create|Write)Allowed/,
      'the table-grant conjunction should be gone — the allowlist alone authorizes');
  });
  it('supabase-schema.sql gates the non-admin branch of _lists create and update', () => {
    assert.match(SQL, /create or replace function public\.app_list_user_writable/, 'supabase needs app_list_user_writable');
    const uses = (SQL.match(/public\.app_list_user_writable\(key\)/g) || []).length;
    // THREE, not two, and the third is load-bearing rather than belt-and-braces: READ must consult it
    // as well. Postgres applies the SELECT policy to rows an UPDATE has to locate, so a list a member
    // cannot read is a list they cannot append to -- which silently disabled userWritableLists on
    // Supabase while it kept working on Firebase and on the dev server. Firestore evaluates its write
    // rules independently of read, which is why its own count stays at two. Delete remains admin-only.
    assert.equal(uses, 3, 'read, create and update must each call it; delete is admin-only (found ' + uses + ')');
    assert.doesNotMatch(SQL, /app_list_write_allowed/, 'the table-grant helper should be gone');
  });
  it('dev/server.js no longer implements this rule at all', () => {
    // It used to consult userWritableListsOf on both list write paths, because it carried its own copy
    // of the access model. It does not any more: the dev server runs supabase-schema.sql, so the
    // policies answer this. ZERO is the assertion -- a reappearance means the third implementation is
    // growing back.
    const uses = (SERVER.match(/BackendHelpers\.userWritableListsOf\(/g) || []).length;
    assert.equal(uses, 0, 'the dev server should not be re-deciding list access (found ' + uses + ')');
  });
  it('an absent mirror fails CLOSED in both rules layers', () => {
    // A deployment that has not re-saved its schema must not keep the old permissive behaviour.
    assert.match(RULES, /exists\(\/databases\/\$\(database\)\/documents\/_meta\/listWritable\)\s*\n?\s*&&/,
      'firestore.rules must require the mirror to exist, not default to permissive');
    assert.match(SQL, /coalesce\(\s*\n?\s*\(select \(value -> 'lists'\) \? listname[\s\S]{0,120}?false\)/,
      'supabase must default to false when the mirror row is absent');
  });
});

describe('rules parity — document-shape bounds', () => {
  // Each self-writable store's field caps. Firestore enforces them in validProfile/validLink/
  // validRequest; Supabase in app_valid_shape. A cap raised on one side only means the stricter
  // backend starts rejecting documents the other happily stores.
  const CAPS = [
    ['_profiles name', 100],
    ['_profiles picture', 350000],
    // Stored image assets (view backgrounds / image-cell bytes as data URIs — the no-bucket tier).
    // Below Firestore's 1048576-byte document limit; Postgres would take far more, so on Supabase this
    // cap is the ONLY bound on an upload.
    ['_assets src', 900000],
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

  it('Supabase validates the same shape-checked stores Firestore does', () => {
    for (const store of ['_profiles', '_list_users', '_access_requests', '_assets__active']) {
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
  // its 'r' entries to 'rw'. (The list twins of these gates are gone — list writes no longer key on
  // a table grant at all — so only the table-write gates remain to guard.)
  it('firestore.rules guards hasTableWrite', () => {
    const fn = (name) => RULES.slice(RULES.indexOf('function ' + name), RULES.indexOf('function ' + name) + 400);
    assert.match(fn('hasTableWrite'), /is list/, 'hasTableWrite fallback is not array-guarded');
    // listWriteAllowed is gone: list writes key on `userWritableLists`, not on a table grant, so the
    // legacy-grant fallback has nothing left to get wrong there.
    assert.doesNotMatch(RULES, /function listWriteAllowed/, 'listWriteAllowed should be gone');
  });

  it('supabase-schema.sql guards app_has_table_write', () => {
    const fn = (name) => SQL.slice(SQL.indexOf('function public.' + name), SQL.indexOf('function public.' + name) + 900);
    assert.match(fn('app_has_table_write'), /jsonb_typeof\([\s\S]*?'tables'\s*\)\s*=\s*'array'/,
      'app_has_table_write fallback is not array-guarded');
    // app_list_write_allowed is gone with its Firestore twin: list writes key on `userWritableLists`,
    // not on a table grant, so there is no legacy-grant fallback left to get wrong.
    assert.doesNotMatch(SQL, /app_list_write_allowed/, 'app_list_write_allowed should be gone');
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
    for (const k of ['schema', 'ownerTables', 'pageAccess', 'ownerWritable', 'listTables', 'listWritable']) {
      assert.ok(keys.includes(k), `saveSchema no longer mirrors _meta/${k}`);
    }
    // Each non-schema mirror must be consulted by BOTH rules layers, or it is dead weight in one.
    for (const k of ['ownerTables', 'pageAccess', 'ownerWritable', 'listTables', 'listWritable']) {
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

describe('rules parity — a partial write is judged on the MERGED row, on every layer', () => {
  // A cell edit sends only the column it changed (app-core saveField), so the owner column a
  // self-service write is judged by lives on the STORED row, not in the payload. Firestore has this for
  // free (request.resource.data is the merged document under set({merge:true})) and Supabase computes
  // the merge server-side; the dev server had to be taught it explicitly. If any layer regressed to
  // judging the raw payload, self-service members would hit 403s on one backend only.
  it('dev/server.js gates putRow on existing-merged-with-payload', () => {
    const i = SERVER.indexOf("case 'putRow'");
    assert.ok(i > 0, "the putRow route moved");
    const body = SERVER.slice(i, i + 2200);
    assert.match(body, /const merged = Object\.assign\(\{\}, existing \|\| \{\}, body\.data \|\| \{\}\)/,
      'dev server no longer builds the merged row');
    assert.match(body, /_mine\(merged\[oc\]\)/, 'ownership is not judged on the merged row');
    assert.match(body, /ownerFieldsOk\(body\.tableId, merged, existing\)/,
      'the ownerWritable bound is not judged on the merged row');
  });

  it('Supabase merges server-side rather than read-modify-write, so concurrent patches cannot clobber', () => {
    assert.match(SQL, /create or replace function public\.app_kv_merge/,
      'the app_kv_merge RPC is missing — StorageSupabase.put falls back to a racy client-side merge');
    // The shape changed from `insert ... on conflict do update` to UPDATE-first, because the former
    // evaluated the INSERT policy against the bare patch and so refused every partial write on a
    // self-service row. What this guards is unchanged: the patch must merge ONTO the stored value
    // rather than replace it, which is `kv.value || <patch>` in either shape.
    assert.match(SQL, /set value = public\.kv\.value \|\| (p_patch|excluded\.value)/,
      'app_kv_merge does not merge onto the stored value');
    // SECURITY INVOKER (the default) is load-bearing: a DEFINER merge would bypass the kv policies and
    // turn a concurrency fix into a write-anything hole.
    const i = SQL.indexOf('create or replace function public.app_kv_merge');
    assert.ok(!/security definer/i.test(SQL.slice(i, i + 500)), 'app_kv_merge must NOT be security definer');
  });

  it('kv is published for realtime, and only under both guards', () => {
    assert.match(SQL, /alter publication supabase_realtime add table public\.kv/,
      'kv is not published — Supabase clients would get no live updates');
    assert.match(SQL, /select 1 from pg_publication where pubname = 'supabase_realtime'/,
      'the publication-exists guard is gone; the script would fail on plain Postgres');
    assert.match(SQL, /select 1 from pg_publication_tables/,
      'the already-a-member guard is gone; the script would stop being idempotent');
  });
});
