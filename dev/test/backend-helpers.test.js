const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../../backend-helpers');

describe('backend-helpers - storeName', () => {
  it('joins table + tab', () => assert.equal(H.storeName('tasks', 'active'), 'tasks__active'));
  it('defaults tab to active', () => assert.equal(H.storeName('tasks'), 'tasks__active'));
  it('supports custom partitions', () => assert.equal(H.storeName('music', 'upcoming'), 'music__upcoming'));
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
});
