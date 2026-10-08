// picker-list-filter.spec.js — `listFilter` narrows which rows of a lookup a `list:` picker OFFERS, and nothing else.
//
// The invariant the narrowing must not break: a value a row already stores keeps rendering, keeps its
// place in the sort, and stays among its own cell's options. A historical agenda holds whoever actually
// presided; a picker that cannot show the cell's own value blanks it the next time someone touches it.
const { test, expect } = require('./server-fixture');

const SCHEMA = {
  defaultLanguage: 'en',
  tables: {
    ref_callings: { isLookup: true, hierarchy: false, columns: [{ name: 'calling', type: 'text' }, { name: 'kind', type: 'text' }] },
    agenda: { columns: [
      { name: 'title', type: 'text' },
      { name: 'presiding', type: 'select', list: 'ref_callings', valueCol: 'calling', listFilter: { kind: 'position' } },
      { name: 'anyone', type: 'select', list: 'ref_callings', valueCol: 'calling' }
    ] }
  },
  views: [{ name: 'agenda_v', sources: ['agenda'], columns: ['title', 'presiding'] }],
  nav: { items: [{ view: 'agenda_v' }] }
};

test('the picker offers only matching rows, keeps a stored value, and the sort is untouched', async ({ page }) => {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCHEMA } });
  for (const [id, calling, kind] of [['c1', 'Bishop', 'position'], ['c2', 'Priest', 'ordination'], ['c3', 'Counselor', 'position']]) {
    await page.request.post('/api/putRow', { data: { tableId: 'ref_callings', tab: 'active', data: { id, calling, kind } } });
  }
  await page.addInitScript(() => { localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local'); });
  await page.goto('/');
  await page.waitForFunction(() => window.appInstance && !appInstance.loading && Array.isArray(appInstance.dataCache.ref_callings), { timeout: 30000 });

  const r = await page.evaluate(() => {
    const a = window.appInstance, vals = (o) => o.map((x) => x.value);
    return {
      fresh: vals(a.getListOptions('presiding', null, { presiding: '' })),
      historical: vals(a.getListOptions('presiding', null, { presiding: 'Priest' })),
      unnarrowed: vals(a.getListOptions('anyone', null, { anyone: '' })),
      order: a.columnValueOrder('presiding'),
      problems: a.validateSchema ? (a.validateSchema() || []).filter((e) => /listFilter/.test(e)) : [],
      // The value the condition names is pinned, exactly as a view filter's is: renaming `position` in the
      // Lookup tab would silently empty the picker, so rows carrying it are locked against rename and delete.
      lockedPosition: !!(a.lockedListValues.ref_callings || {}).position,
      bishopLocked: (function () { a.currentRefTable = 'ref_callings'; return a.isLockedRefRow(a.dataCache.ref_callings.find((x) => x.id === 'c1')); })(),
      priestLockedByValue: !!(a.lockedListValues.ref_callings || {}).Priest
    };
  });
  expect(r.fresh).toEqual(['Bishop', 'Counselor']);
  expect(r.historical).toEqual(['Bishop', 'Counselor', 'Priest']);
  expect(r.unnarrowed).toEqual(['Bishop', 'Priest', 'Counselor']);
  expect(r.order).toEqual(['Bishop', 'Priest', 'Counselor']);
  expect(r.problems).toEqual([]);
  expect(r.lockedPosition).toBe(true);
  expect(r.bishopLocked).toBe(true);           // a row whose `kind` is the pinned value
  expect(r.priestLockedByValue).toBe(false);   // only the condition's values are pinned, not every option
});
