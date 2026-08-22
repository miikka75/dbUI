const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseStorage } = require('../../storage-supabase');

// storage-supabase.js is a classic browser script that also exports createSupabaseStorage for Node. The
// test needs no network / real supabase SDK — we drive the adapter with a tiny in-memory fake of the
// supabase-js query builder (only the surface the adapter calls):
//   from(t).select(cols).eq(c,v)...maybeSingle()   -> { data: {value}|null, error }
//   from(t).select(cols).eq(c,v)                    -> thenable { data: [{key,value}], error }
//   from(t).upsert({store,key,value}, {onConflict}) -> thenable { data:null, error }
//   from(t).delete().eq(c,v).eq(c,v)                -> thenable { data:null, error }
function makeFakeSb() {
  const rows = []; // { store, key, value }
  // PostgREST accepts a jsonb path as a filter column ('value->>status'); the fake has to read one the
  // same way, or a pushed-down constraint would silently match nothing here and everything in Postgres.
  const fieldOf = (r, k) => {
    const arrow = k.indexOf('->>');
    if (arrow < 0) return r[k];
    const v = (r[k.slice(0, arrow)] || {})[k.slice(arrow + 3)];
    return v === undefined || v === null ? v : String(v);
  };
  const matches = (r, f) => Object.keys(f).every(k => fieldOf(r, k) === f[k]);
  const find = (f) => rows.find(r => matches(r, f));
  return {
    _rows: rows,
    from() {
      const st = { op: 'select', filters: {}, payload: null };
      const exec = () => {
        if (st.op === 'upsert') {
          const { store, key, value } = st.payload;
          const ex = find({ store, key });
          if (ex) ex.value = value; else rows.push({ store, key, value });
          return Promise.resolve({ data: null, error: null });
        }
        if (st.op === 'delete') {
          for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], st.filters)) rows.splice(i, 1);
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: rows.filter(r => matches(r, st.filters)).map(r => ({ key: r.key, value: r.value })), error: null });
      };
      const builder = {
        select() { st.op = 'select'; return builder; },
        eq(c, v) { st.filters[c] = v; return builder; },
        upsert(obj) { st.op = 'upsert'; st.payload = obj; return builder; },
        delete() { st.op = 'delete'; return builder; },
        maybeSingle() { const r = find(st.filters); return Promise.resolve({ data: r ? { value: r.value } : null, error: null }); },
        then(res, rej) { return exec().then(res, rej); }   // thenable terminal for the non-maybeSingle chains
      };
      return builder;
    }
  };
}

describe('storage-supabase adapter — interface parity with the Firestore adapter', () => {
  it('getMeta returns undefined for a missing key', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    assert.equal(await S.getMeta('schema'), undefined);
  });

  it('setMeta stores an object and getMeta round-trips it (replace, not merge)', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S.setMeta('languages', { list: [{ code: 'en', name: 'English' }] });
    assert.deepEqual(await S.getMeta('languages'), { list: [{ code: 'en', name: 'English' }] });
    await S.setMeta('languages', { list: [] });   // REPLACES, does not merge old keys back
    assert.deepEqual(await S.getMeta('languages'), { list: [] });
  });

  it('setMeta boxes a non-object value as { _value }', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S.setMeta('flag', 'yes');
    assert.deepEqual(await S.getMeta('flag'), { _value: 'yes' });
  });

  it('put MERGES onto the stored row (omitted fields preserved) — the pinned putRow contract', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S.put('tasks__active', 'r1', { id: 'r1', a: 'A', b: 'B' });
    await S.put('tasks__active', 'r1', { id: 'r1', a: 'A2' });        // partial update
    const row = await S.get('tasks__active', 'r1');
    assert.equal(row.a, 'A2', 'updated column');
    assert.equal(row.b, 'B', 'omitted column preserved');
  });

  it('getAll returns the value objects for a store', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S.put('tasks__active', 'r1', { id: 'r1', n: 1 });
    await S.put('tasks__active', 'r2', { id: 'r2', n: 2 });
    await S.put('other__active', 'x1', { id: 'x1' });                 // different store, excluded
    const rows = await S.getAll('tasks__active');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.id).sort(), ['r1', 'r2']);
  });

  it('delete removes only the targeted row', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S.put('tasks__active', 'r1', { id: 'r1' });
    await S.put('tasks__active', 'r2', { id: 'r2' });
    await S.delete('tasks__active', 'r1');
    const rows = await S.getAll('tasks__active');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'r2');
  });

  it('_all returns { key, value } rows for the collection-style backend queries', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S._replace('_users', 'a@x.com', { role: 'admin', tables: 'all' });
    await S._replace('_users', 'b@x.com', { role: 'viewer', tables: ['tasks'] });
    const rows = await S._all('_users');
    assert.equal(rows.length, 2);
    const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
    assert.equal(byKey['a@x.com'].role, 'admin');
    assert.deepEqual(byKey['b@x.com'].tables, ['tasks']);
  });

  it('_replace overwrites the whole value; _merge shallow-merges top-level keys', async () => {
    const S = createSupabaseStorage(makeFakeSb());
    await S._replace('_profiles', 'me', { name: 'Me', shared: true, picture: 'p' });
    await S._merge('_profiles', 'me', { name: 'Renamed' });           // keep shared + picture
    assert.deepEqual(await S.get('_profiles', 'me'), { name: 'Renamed', shared: true, picture: 'p' });
    await S._replace('_profiles', 'me', { name: 'Only' });            // drops the rest
    assert.deepEqual(await S.get('_profiles', 'me'), { name: 'Only' });
  });
});

describe('storage-supabase — pushing a filter into the query', () => {
  const Query = require('../../query');
  const Rows = require('../../rows');

  const seeded = () => {
    const S = createSupabaseStorage(makeFakeSb());
    return S.put('tasks__active', 'p1', { id: 'p1', status: 'open', owner: 'ann' })
      .then(() => S.put('tasks__active', 'p2', { id: 'p2', status: 'done', owner: 'ann' }))
      .then(() => S.put('tasks__active', 'p3', { id: 'p3', status: 'open', owner: 'bob' }))
      .then(() => S.put('tasks__active', 'p4', { id: 'p4', owner: 'bob' }))     // no status
      .then(() => S);
  };

  for (const cond of [{ status: 'open' }, { status: 'open', owner: 'ann' }, { status: { ne: 'open' } }, {}]) {
    it('agrees for ' + JSON.stringify(cond), async () => {
      const S = await seeded();
      const { constraints, residual } = Query.compile(cond);
      const pushed = (await S.getAll('tasks__active', constraints))
        .filter((r) => Rows.condMatches(r, residual)).map((r) => r.id).sort();
      const whole = (await S.getAll('tasks__active'))
        .filter((r) => Rows.condMatches(r, cond)).map((r) => r.id).sort();
      assert.deepEqual(pushed, whole, 'pushing the filter down changed which rows came back');
    });
  }

  it('narrows rather than ignoring the constraints', async () => {
    // Equivalence holds trivially if getAll drops them on the floor, and then this buys nothing.
    const S = await seeded();
    const { constraints } = Query.compile({ status: 'open' });
    assert.deepEqual((await S.getAll('tasks__active', constraints)).map((r) => r.id).sort(), ['p1', 'p3']);
  });

  it('a row missing the field does not match an equality', async () => {
    const S = await seeded();
    const { constraints } = Query.compile({ status: 'open' });
    assert.ok(!(await S.getAll('tasks__active', constraints)).some((r) => r.id === 'p4'));
  });
});
