// lookup-dimension.spec.js — a `list:` naming a lookup TABLE, and WHICH of its columns the picker offers.
//
// A catalogue can answer more than one question. The bishopric example's `ref_callings` holds an
// organization, a calling, and a handle naming the pair — and two columns of the same table
// legitimately want two different dimensions of it. Until `valueCol` was read here, a select over a
// lookup was stuck with the group dimension, so a column meant to hold ward POSITIONS offered
// ORGANIZATIONS instead: a full, plausible, entirely wrong dropdown.
//
// That is why this is a browser test and not a Node one. The pure half (which dimension a column asks
// for, and which one accounts are linked through) is unit-tested in dev/test/columns.test.js; what can
// only be checked here is that `getListOptions` — the function every list-backed cell renders through —
// actually reads it, and that the account picker reaches a catalogue that is maintained as a table.
// `test` comes from the server fixture, not from @playwright/test: each worker runs its own
// in-memory server, and a spec importing the bare runner gets a baseURL pointing at nothing.
const { test, expect } = require('./server-fixture');

const SCH = {
  defaultLanguage: 'en',
  tables: {
    ref_positions: {
      isLookup: true, reorderable: true, defaultSort: 'position',
      hierarchy: { parent: 'organization', value: 'calling' },
      columns: [
        { name: 'organization', type: 'text' },
        { name: 'calling', type: 'text' },
        { name: 'slug', type: 'text', hidden: true },
        { name: 'position', type: 'number', hidden: true }
      ]
    },
    duties: {
      columns: [
        // The same catalogue, twice, through two different dimensions of it.
        { name: 'organization', type: 'select', list: 'ref_positions' },
        { name: 'responsible', type: 'select', list: 'ref_positions', valueCol: 'slug' },
        { name: 'note', type: 'text' }
      ]
    }
  },
  lists: {},
  listSources: { ref_positions: 'userlink-name' },
  views: [{ name: 'duties', sources: ['duties'], mode: 'union', columns: ['organization', 'responsible', 'note'] }],
  nav: { items: [{ view: 'duties' }] }          // drawer, so the spec can wait on the nav list
};

// Two organizations, and a `president` in each — the collision that makes the calling dimension
// useless as an identity and the handle necessary. One row carries NO handle: a catalogue entry that
// names no position anybody holds.
// No handles stored: every one of these derives, which is what a catalogue predating the handle looks
// like. `p3` keeps an explicit one, because a row that must hold an older spelling is the only reason
// the cell exists at all.
const ROWS = [
  { id: 'p1', position: '1', organization: 'primary', calling: 'president' },
  { id: 'p2', position: '2', organization: 'primary', calling: 'teacher' },
  { id: 'p3', position: '3', organization: 'music', calling: 'president', slug: 'the_chorister' }
];

async function boot(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCH } });
  await page.request.post('/api/initSchema', { data: { schema: SCH.tables } });
  for (const row of ROWS)
    await page.request.post('/api/putRow', { data: { tableId: 'ref_positions', data: row, tab: 'active' } });
  await page.request.post('/api/createLanguage', { data: { code: 'en', name: 'English', keys: [] } });
  await page.request.post('/api/updateTranslations', { data: { langCode: 'en', updates: {
    'list.ref_positions.primary': 'Primary', 'list.ref_positions.music': 'Music',
    'list.ref_positions.primary_president': 'Primary — President',
    'list.ref_positions.primary_teacher': 'Primary — Teacher',
    'list.ref_positions.the_chorister': 'The chorister'
  } } });
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 6000 });
  // Open the Lookup TAB and then the catalogue inside it: the ref editor renders only for the table
  // that is open, and the per-row pickers live inside its expanded group.
  await page.evaluate(() => { appInstance.selectTab('__lookup'); appInstance.selectRefTable('ref_positions'); });
  await expect.poll(() => page.evaluate(() => (appInstance.dataCache.ref_positions || []).length), { timeout: 6000 }).toBe(3);
}

test('two columns draw on two dimensions of one catalogue', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const app = window.appInstance;
    const opts = (c) => app.getListOptions(c).map((o) => ({ value: o.value, title: o.title }));
    return { org: opts('organization'), responsible: opts('responsible') };
  });
  // The column that names no dimension keeps the old behaviour exactly: the lookup's group dimension,
  // deduped — two rows are `primary` and only one option is.
  expect(r.org.map((o) => o.value)).toEqual(['primary', 'music']);
  // The one that asks for `slug` gets a handle per row: two derived from the row's own dimensions, one
  // taken from the cell that overrides it. Nothing had to be typed for the first two.
  expect(r.responsible.map((o) => o.value)).toEqual(['primary_president', 'primary_teacher', 'the_chorister']);
  // Both dimensions label through the SAME `list.<table>.<value>` namespace, which is what lets one
  // catalogue carry both without a second vocabulary beside it.
  expect(r.org.map((o) => o.title)).toEqual(['Primary', 'Music']);
  expect(r.responsible.map((o) => o.title)).toEqual(['Primary — President', 'Primary — Teacher', 'The chorister']);
});

test('the account picker reaches a catalogue maintained as a table', async ({ page }) => {
  await boot(page);
  // A user-linked LOOKUP is linked per row in the Lookup editor. Without this the schema could declare
  // `listSources` and leave an admin no way to link anybody — the Lists section never shows a lookup,
  // and `canEditList` is false for one by design.
  expect(await page.evaluate(() => appInstance.isUserNameList('ref_positions'))).toBe(true);
  const pickers = page.locator('[data-testid="list-user-picker"]');
  await expect.poll(() => pickers.count(), { timeout: 6000 }).toBe(3);   // every row is nameable, so every row links

  // And it links the HANDLE, not the calling — `primary_president`, never the `president` that two
  // rows share. Linking the shared value would put two people's work on one card.
  await page.evaluate(async () => {
    const app = window.appInstance;
    await app.setListUserLink('ref_positions', app.refIdentityValue({ slug: 'primary_president' }), 'pres@x.test');
  });
  // setListUserLink refreshes the raw link map WITHOUT awaiting it (the editor re-renders when it
  // lands), so this polls rather than reading once.
  await expect.poll(() => page.evaluate(() => appInstance.listUserLinks.ref_positions || null), { timeout: 6000 })
    .toEqual({ primary_president: 'pres@x.test' });
});

test('a position added in the app is linkable without anyone filling in a handle', async ({ page }) => {
  await boot(page);
  // The defect this design exists to remove: the handle column is hidden, and the lookup editor draws
  // a hierarchy as its parent and value only — so a row added here could never be given one by hand.
  await page.request.post('/api/putRow', { data: { tableId: 'ref_positions', tab: 'active',
    data: { id: 'p4', position: '4', organization: 'music', calling: 'chorister' } } });
  await page.evaluate(() => appInstance._ensureCached(['ref_positions'], null, false));
  await expect.poll(() => page.evaluate(() => (appInstance.dataCache.ref_positions || []).length), { timeout: 6000 }).toBe(4);

  expect(await page.evaluate(() => appInstance.getListOptions('responsible').map((o) => o.value)))
    .toContain('music_chorister');
  await page.evaluate(() => appInstance.setListUserLink('ref_positions', 'music_chorister', 'chorister@x.test'));
  await expect.poll(() => page.evaluate(() => (appInstance.listUserLinks.ref_positions || {}).music_chorister), { timeout: 6000 })
    .toBe('chorister@x.test');
});
