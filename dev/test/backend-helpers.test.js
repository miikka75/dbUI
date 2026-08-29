const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../backend-helpers');

describe('backend-helpers - storeName', () => {
  it('joins table + tab', () => assert.equal(H.storeName('tasks', 'active'), 'tasks__active'));
  it('defaults tab to active', () => assert.equal(H.storeName('tasks'), 'tasks__active'));
  it('supports custom partitions', () => assert.equal(H.storeName('music', 'upcoming'), 'music__upcoming'));
});

describe('backend-helpers - tableOf (the inverse of storeName)', () => {
  it('drops the partition suffix', () => {
    assert.equal(H.tableOf('tasks__active'), 'tasks');
    assert.equal(H.tableOf('tasks__archive'), 'tasks');
    assert.equal(H.tableOf('music__upcoming'), 'music');
  });
  // Callers pass either a store name or a bare table id (dev/server.js takes body.tableId, which is
  // both depending on the route), so this has to be idempotent rather than assume a suffix is there.
  it('leaves a bare table name alone, and is idempotent', () => {
    assert.equal(H.tableOf('tasks'), 'tasks');
    assert.equal(H.tableOf(H.tableOf('tasks__active')), 'tasks');
  });
  it('round-trips storeName for every partition', () => {
    ['active', 'archive', 'upcoming'].forEach((p) => assert.equal(H.tableOf(H.storeName('tasks', p)), 'tasks'));
  });
  it('null/undefined/empty -> empty string, never a throw', () => {
    assert.equal(H.tableOf(null), '');
    assert.equal(H.tableOf(undefined), '');
    assert.equal(H.tableOf(''), '');
  });
  // The assumption this function rests on, stated as a test so the reason validateSchema refuses a
  // '__' in a table name is recorded where the truncation lives: `x__y` is INDISTINGUISHABLE from
  // table `x`, which is why the name is rejected at load rather than mishandled here.
  it('truncates at the FIRST separator — which is why a table name may not contain one', () => {
    assert.equal(H.tableOf('x__y__active'), 'x');
    assert.equal(H.tableOf('x__archive'), 'x');
  });
});

describe('backend-helpers - deriveHeaders', () => {
  it('keys of first row', () => assert.deepEqual(H.deriveHeaders([{ id: 'a', name: 'x' }]), ['id', 'name']));
  it('empty array -> []', () => assert.deepEqual(H.deriveHeaders([]), []));
  it('null -> []', () => assert.deepEqual(H.deriveHeaders(null), []));
});

describe('backend-helpers - unwrapSchemaDoc', () => {
  it('legacy {_json} -> parsed object', () => {
    assert.deepEqual(H.unwrapSchemaDoc({ _json: '{"tables":{"t":{}}}' }), { tables: { t: {} } });
  });
  it('{tables} -> as-is', () => {
    const d = { tables: { t: {} }, defaultLanguage: 'xx' };
    assert.equal(H.unwrapSchemaDoc(d), d);
  });
  it('null/empty -> null', () => {
    assert.equal(H.unwrapSchemaDoc(null), null);
    assert.equal(H.unwrapSchemaDoc(undefined), null);
    assert.equal(H.unwrapSchemaDoc({}), null);
  });
  it('malformed _json -> null (no throw)', () => {
    assert.equal(H.unwrapSchemaDoc({ _json: '{bad' }), null);
  });
});

describe('backend-helpers - seedTranslations', () => {
  // The rule that stops an import from erasing a language. createLanguage is called once per language
  // in an imported file, so it has to be safe to call on a language that already has strings -- the
  // whole point of splitting schema translations and app translations into separate packs is that both
  // can be applied to the same language.
  it('keeps every stored string, and every stored key the caller did not mention', () => {
    const existing = { 'field.topic': 'Topic', 'msg.saved': 'Saved' };
    const out = H.seedTranslations(existing, ['btn.add', 'field.topic']);
    assert.deepEqual(out, { 'btn.add': '', 'field.topic': 'Topic', 'msg.saved': 'Saved' });
  });

  it('a stored value always beats the blank seed for the same key', () => {
    // The direction that matters. Seeding over a translated string is the data loss this exists to stop.
    assert.equal(H.seedTranslations({ a: 'kept' }, ['a']).a, 'kept');
  });

  it('seeds blanks when there is nothing stored yet', () => {
    assert.deepEqual(H.seedTranslations(null, ['a', 'b']), { a: '', b: '' });
    assert.deepEqual(H.seedTranslations(undefined, ['a']), { a: '' });
  });

  it('does not mutate what it was given', () => {
    const existing = { a: 'kept' };
    H.seedTranslations(existing, ['b']);
    assert.deepEqual(existing, { a: 'kept' }, 'the stored document was modified in place');
  });

  it('survives a missing key list', () => {
    assert.deepEqual(H.seedTranslations({ a: 'kept' }, null), { a: 'kept' });
    assert.deepEqual(H.seedTranslations(null, null), {});
  });

  it('an empty stored string is still a stored key — it does not get re-seeded away', () => {
    assert.deepEqual(H.seedTranslations({ a: '' }, ['a', 'b']), { a: '', b: '' });
  });
});

describe('backend-helpers - addLanguage / removeLanguage', () => {
  it('addLanguage appends a new code without mutating', () => {
    const list = [{ code: 'xx', name: 'TestLang' }];
    const out = H.addLanguage(list, 'en', 'English');
    assert.deepEqual(out, [{ code: 'xx', name: 'TestLang' }, { code: 'en', name: 'English' }]);
    assert.equal(list.length, 1); // original untouched
  });
  it('addLanguage handles null list', () => {
    assert.deepEqual(H.addLanguage(null, 'xx', 'TestLang'), [{ code: 'xx', name: 'TestLang' }]);
  });
  it('addLanguage upserts by code -- re-adding never duplicates (re-importing a bundle calls it per language)', () => {
    const list = [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }];
    let out = H.addLanguage(list, 'en', 'English');
    assert.deepEqual(out, list);                       // same set, no second 'en'
    out = H.addLanguage(H.addLanguage(out, 'en', 'English'), 'en', 'English');
    assert.equal(out.filter(l => l.code === 'en').length, 1);
    assert.equal(list.length, 2);                      // original untouched
  });
  it('addLanguage heals a list already corrupted by the old append behaviour', () => {
    const dupes = [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' },
                   { code: 'en', name: 'English' }, { code: 'es', name: 'Español' }];
    const out = H.addLanguage(dupes, 'en', 'English');
    assert.deepEqual(out, [{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }]);
  });
  it('addLanguage refreshes the display name of an existing code, in place', () => {
    const out = H.addLanguage([{ code: 'en', name: 'English' }, { code: 'es', name: 'Español' }], 'en', 'English (US)');
    assert.deepEqual(out, [{ code: 'en', name: 'English (US)' }, { code: 'es', name: 'Español' }]);
  });
  it('removeLanguage filters by code without mutating', () => {
    const list = [{ code: 'xx', name: 'TestLang' }, { code: 'en', name: 'English' }];
    const out = H.removeLanguage(list, 'xx');
    assert.deepEqual(out, [{ code: 'en', name: 'English' }]);
    assert.equal(list.length, 2);
  });
  it('removeLanguage handles null list', () => {
    assert.deepEqual(H.removeLanguage(null, 'xx'), []);
  });
});

describe('backend-helpers - emptyTranslations', () => {
  it('builds empty-string map from keys', () => {
    assert.deepEqual(H.emptyTranslations(['hello', 'bye']), { hello: '', bye: '' });
  });
  it('no keys -> {}', () => {
    assert.deepEqual(H.emptyTranslations(), {});
    assert.deepEqual(H.emptyTranslations(null), {});
  });
});

describe('backend-helpers - ownerTablesOf (self-service table set)', () => {
  it('lists tables with an owner column, sorted; both column shapes', () => {
    const schema = { tables: {
      rsvps:  { columns: [{ name: 'owner', type: 'owner' }, { name: 'status', type: 'select' }] }, // array shape
      signups:{ columns: { who: { type: 'owner' }, item: 'text' } },                                // map shape
      tasks:  { columns: { title: 'text', status: { type: 'select' } } },                           // no owner -> excluded
      notes:  { columns: [{ name: 'body', type: 'text' }] }                                         // no owner -> excluded
    } };
    assert.deepEqual(H.ownerTablesOf(schema), ['rsvps', 'signups']);
  });
  it('a bare-string column def is never an owner', () => {
    assert.deepEqual(H.ownerTablesOf({ tables: { t: { columns: { owner: 'text' } } } }), []);
  });
  it('empty / missing schema -> []', () => {
    assert.deepEqual(H.ownerTablesOf(null), []);
    assert.deepEqual(H.ownerTablesOf({}), []);
    assert.deepEqual(H.ownerTablesOf({ tables: {} }), []);
  });
});

describe('backend-helpers - pageAccessOf (restricted doc-view map)', () => {
  it('maps only markdown views with a non-empty access array; tables sorted', () => {
    const schema = { views: [
      { name: 'handbook', markdown: '# hi', access: ['staff', 'board'] },   // restricted
      { name: 'notice',   markdown: '# all' },                              // untagged -> omitted
      { name: 'empty',    markdown: '# x', access: [] },                    // empty -> omitted
      { name: 'data',     sources: ['t'], access: ['staff'] }              // not a doc-view -> omitted
    ] };
    assert.deepEqual(H.pageAccessOf(schema), { handbook: ['board', 'staff'] });
  });
  it('recurses into nested views', () => {
    const schema = { views: [{ name: 'grp', views: [{ name: 'secret', markdown: '#', access: ['x'] }] }] };
    assert.deepEqual(H.pageAccessOf(schema), { secret: ['x'] });
  });
  it('empty / missing schema -> {}', () => {
    assert.deepEqual(H.pageAccessOf(null), {});
    assert.deepEqual(H.pageAccessOf({}), {});
    assert.deepEqual(H.pageAccessOf({ views: [] }), {});
  });
  it('mirrors the "all" sentinel verbatim (full-access-only page)', () => {
    // access:["all"] gates a page to tables:'all' users + admins. No real grant array contains the
    // literal 'all', so the mirrored map denies every partial-grant user while the rules' tables=='all'
    // check still admits full-access users. pageAccessOf passes it through unchanged.
    const schema = { views: [{ name: 'sisainen', markdown: '#', access: ['all'] }] };
    assert.deepEqual(H.pageAccessOf(schema), { sisainen: ['all'] });
  });
});

describe('backend-helpers - autoArchiveIds (age a terminal row out of the active partition)', () => {
  const CFG = { column: 'status', values: ['approved', 'rejected'], days: 7 };
  const NOW = new Date('2026-08-20T12:00:00Z');
  const at = (iso) => iso;
  const rows = [
    { id: 'old-approved', status: 'approved', updated_at: at('2026-08-01T00:00:00Z') },
    { id: 'old-rejected', status: 'rejected', updated_at: at('2026-08-05T00:00:00Z') },
    { id: 'fresh-approved', status: 'approved', updated_at: at('2026-08-19T00:00:00Z') },
    { id: 'old-but-open', status: 'logged', updated_at: at('2026-01-01T00:00:00Z') },
    { id: 'no-timestamp', status: 'approved' }
  ];

  it('picks terminal rows that have been settled for at least `days`', () => {
    assert.deepEqual(H.autoArchiveIds(rows, CFG, NOW), ['old-approved', 'old-rejected']);
  });

  it('leaves a row still in progress, however old, and one still being edited', () => {
    const ids = H.autoArchiveIds(rows, CFG, NOW);
    assert.equal(ids.includes('old-but-open'), false);    // wrong status: never ages out
    assert.equal(ids.includes('fresh-approved'), false);  // right status, edited yesterday
  });

  it('a row with no/unparseable updated_at is left alone, not archived on sight', () => {
    assert.equal(H.autoArchiveIds(rows, CFG, NOW).includes('no-timestamp'), false);
    assert.deepEqual(H.autoArchiveIds([{ id: 'x', status: 'approved', updated_at: 'soon' }], CFG, NOW), []);
  });

  it('the boundary is inclusive: exactly `days` old qualifies', () => {
    const exactly = [{ id: 'edge', status: 'approved', updated_at: '2026-08-13T12:00:00Z' }];
    assert.deepEqual(H.autoArchiveIds(exactly, CFG, NOW), ['edge']);
    const hairEarly = [{ id: 'edge', status: 'approved', updated_at: '2026-08-13T12:00:01Z' }];
    assert.deepEqual(H.autoArchiveIds(hairEarly, CFG, NOW), []);
  });

  it('days: 0 archives as soon as the row is in a terminal state', () => {
    const cfg0 = { column: 'status', values: ['approved'], days: 0 };
    assert.deepEqual(H.autoArchiveIds([{ id: 'a', status: 'approved', updated_at: '2026-08-20T11:59:00Z' }], cfg0, NOW), ['a']);
  });

  it('a malformed or absent policy archives nothing', () => {
    for (const bad of [null, {}, { column: 'status' }, { column: 'status', values: [] },
                       { column: 'status', values: ['approved'], days: -1 },
                       { column: 'status', values: ['approved'], days: 'soon' }]) {
      assert.deepEqual(H.autoArchiveIds(rows, bad, NOW), [], JSON.stringify(bad));
    }
  });
});

describe('backend-helpers - ownerWritableOf (bound an owner-scoped write to columns)', () => {
  const schema = { tables: {
    chore_log: {
      ownerWritable: ['chore', 'note', 'person'],
      columns: [
        { name: 'owner', type: 'owner' },
        { name: 'person', type: 'select', defaultFrom: '@me' },
        { name: 'chore', type: 'text' },
        { name: 'note', type: 'text' },
        { name: 'status', type: 'select', default: 'logged' },
        { name: 'score', type: 'number' },
        { name: 'updated_at', type: 'text', hidden: true }
      ]
    },
    // declares the bound but has no owner column -> the key would be inert, so it is not emitted
    no_owner: { ownerWritable: ['a'], columns: [{ name: 'a', type: 'text' }] },
    // has an owner column but sets no bound -> unbounded, the historical behaviour
    unbounded: { columns: [{ name: 'owner', type: 'owner' }, { name: 'x', type: 'text' }] }
  } };

  it('emits the allowlist plus every gated column with its create-time value', () => {
    const m = H.ownerWritableOf(schema);
    assert.deepEqual(m.chore_log.cols, ['chore', 'note', 'person']);
    assert.deepEqual(m.chore_log.locked, { status: 'logged', score: '' });   // no default -> '' (what _createBlankRow writes)
  });

  it('omits owner, the system bookkeeping and defaultFrom columns from `locked`', () => {
    const locked = H.ownerWritableOf(schema).chore_log.locked;
    // owner/updated_at are system; person is defaultFrom, resolved per user, so no rule can predict it
    for (const k of ['owner', 'updated_at', 'person']) assert.equal(k in locked, false, k);
  });

  it('only tables that both declare the bound AND have an owner column are emitted', () => {
    assert.deepEqual(Object.keys(H.ownerWritableOf(schema)), ['chore_log']);
  });

  it('no tables, or a schema without any, yields an empty map', () => {
    assert.deepEqual(H.ownerWritableOf({}), {});
    assert.deepEqual(H.ownerWritableOf(null), {});
  });

  // ownerWritableWhile: the owner branch reaches a row only while it is still in one of these states.
  // Mirrored as ONE column + a value list because neither rules language can loop over a map.
  it('mirrors ownerWritableWhile as whileCol + whileVals (absent -> no gate)', () => {
    assert.deepEqual(H.ownerWritableOf(schema).chore_log.whileCol, '');
    assert.deepEqual(H.ownerWritableOf(schema).chore_log.whileVals, []);
    const gated = { tables: { chore_log: Object.assign({}, schema.tables.chore_log, { ownerWritableWhile: { status: 'logged' } }) } };
    assert.deepEqual(H.ownerWritableOf(gated).chore_log.whileCol, 'status');
    assert.deepEqual(H.ownerWritableOf(gated).chore_log.whileVals, ['logged']);
    const list = { tables: { chore_log: Object.assign({}, schema.tables.chore_log, { ownerWritableWhile: { status: ['logged', 'rejected'] } }) } };
    assert.deepEqual(H.ownerWritableOf(list).chore_log.whileVals, ['logged', 'rejected']);
    // a gate naming a column the table does not have is dropped rather than half-applied
    const bogus = { tables: { chore_log: Object.assign({}, schema.tables.chore_log, { ownerWritableWhile: { nope: 'x' } }) } };
    assert.deepEqual(H.ownerWritableOf(bogus).chore_log.whileCol, '');
  });
});

describe('backend-helpers - identity columns', () => {
  // A `defaultFrom: "@me"` column must be owner-writable or the owner cannot create the row at all
  // (its value is per-user, so `locked` cannot predict it) — which left them free to write somebody
  // else's identity into it. The mirror names the column so the write layers can require it to be theirs.
  const schema = { tables: { chore_log: {
    ownerWritable: ['person', 'chore', 'note'],
    columns: [
      { name: 'owner', type: 'owner' },
      { name: 'person', type: 'select', list: 'members', defaultFrom: '@me' },
      { name: 'chore', type: 'text' }, { name: 'note', type: 'text' }
    ] } } };

  it('names the identity column and its list', () => {
    const b = H.ownerWritableOf(schema).chore_log;
    assert.equal(b.identityCol, 'person');
    assert.equal(b.identityList, 'members');
  });
  it('a defaultFrom column that is NOT owner-writable is already unreachable, so it is not named', () => {
    const s2 = JSON.parse(JSON.stringify(schema));
    s2.tables.chore_log.ownerWritable = ['chore', 'note'];
    assert.equal(H.ownerWritableOf(s2).chore_log.identityCol, '');
  });

  const bounds = { identityCol: 'person', identityList: 'members' };
  it('accepts the caller own value and refuses anybody else', () => {
    assert.equal(H.ownerIdentityOk(bounds, { person: 'Ann' }, 'Ann'), true);
    assert.equal(H.ownerIdentityOk(bounds, { person: 'Bob' }, 'Ann'), false);
  });
  it('a write that does not carry the column cannot forge it', () => {
    assert.equal(H.ownerIdentityOk(bounds, { note: 'x' }, 'Ann'), true);
  });
  it('a caller with no identity cannot claim one', () => {
    assert.equal(H.ownerIdentityOk(bounds, { person: 'Ann' }, ''), false);
  });
  it('a table with no identity column is unaffected', () => {
    assert.equal(H.ownerIdentityOk({ identityCol: '', identityList: '' }, { person: 'Bob' }, ''), true);
    assert.equal(H.ownerIdentityOk(null, { person: 'Bob' }, ''), true);
  });
});

describe('backend-helpers - ownerRowInState (the shared while-gate predicate)', () => {
  const gated = { whileCol: 'status', whileVals: ['logged'] };
  it('a create (no stored row) always passes — it is in its own starting state', () => {
    assert.equal(H.ownerRowInState(gated, null), true);
  });
  it('passes while the STORED row is in a listed state, and freezes once it leaves', () => {
    assert.equal(H.ownerRowInState(gated, { status: 'logged' }), true);
    assert.equal(H.ownerRowInState(gated, { status: 'approved' }), false);
    assert.equal(H.ownerRowInState(gated, {}), false);            // missing -> '' -> not listed
  });
  it('no gate (or no bounds at all) never freezes anything', () => {
    assert.equal(H.ownerRowInState({ whileCol: '', whileVals: [] }, { status: 'approved' }), true);
    assert.equal(H.ownerRowInState(null, { status: 'approved' }), true);
  });
});

