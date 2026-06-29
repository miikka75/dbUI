const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../../apps-script/sheets-helpers');

describe('Apps Script helpers - formatCell', () => {
  it('formats Date as local YYYY-MM-DD (no UTC shift)', () => {
    // Local midnight May 24 must stay May 24 (toISOString would shift to May 23 in +EEST)
    assert.equal(h.formatCell(new Date(2026, 4, 24)), '2026-05-24');
  });
  it('pads single-digit month/day', () => {
    assert.equal(h.formatCell(new Date(2026, 0, 5)), '2026-01-05');
  });
  it('null/undefined -> empty string', () => {
    assert.equal(h.formatCell(null), '');
    assert.equal(h.formatCell(undefined), '');
  });
  it('coerces numbers/booleans to string', () => {
    assert.equal(h.formatCell(42), '42');
    assert.equal(h.formatCell(false), 'false');
  });
});

describe('Apps Script helpers - normalizeColumns', () => {
  it('object map -> keys', () => {
    assert.deepEqual(h.normalizeColumns({ id: 'text', name: 'text' }), ['id', 'name']);
  });
  it('string array -> as-is', () => {
    assert.deepEqual(h.normalizeColumns(['id', 'name']), ['id', 'name']);
  });
  it('object array -> names, drops nameless', () => {
    assert.deepEqual(h.normalizeColumns([{ name: 'id' }, { name: 'x' }, { foo: 1 }]), ['id', 'x']);
  });
  it('null/undefined -> empty', () => {
    assert.deepEqual(h.normalizeColumns(null), []);
  });
});

describe('Apps Script helpers - valuesToObjects', () => {
  it('maps headers + rows, coercing cells', () => {
    const r = h.valuesToObjects([['id', 'date'], ['a', new Date(2026, 5, 1)], ['b', 7]]);
    assert.deepEqual(r.headers, ['id', 'date']);
    assert.deepEqual(r.rows, [{ id: 'a', date: '2026-06-01' }, { id: 'b', date: '7' }]);
  });
  it('filters empty headers', () => {
    const r = h.valuesToObjects([['id', '', 'name'], ['a', 'x', 'b']]);
    assert.deepEqual(r.headers, ['id', 'name']);
    assert.deepEqual(r.rows, [{ id: 'a', name: 'b' }]);
  });
  it('header-only sheet -> empty rows', () => {
    assert.deepEqual(h.valuesToObjects([['id', 'name']]), { headers: ['id', 'name'], rows: [] });
  });
  it('empty input -> empty', () => {
    assert.deepEqual(h.valuesToObjects([]), { headers: [], rows: [] });
    assert.deepEqual(h.valuesToObjects(null), { headers: [], rows: [] });
  });
});

describe('Apps Script helpers - objectToValues', () => {
  it('orders by headers, missing -> empty string', () => {
    assert.deepEqual(h.objectToValues({ id: 'a', name: 'B' }, ['id', 'name', 'extra']), ['a', 'B', '']);
  });
});

describe('Apps Script helpers - findRowIndex', () => {
  const data = [['id', 'v'], ['x1', 'a'], ['x2', 'b'], [3, 'c']];
  it('finds by string-compared id', () => {
    assert.equal(h.findRowIndex(data, 0, 'x2'), 2);
  });
  it('matches numeric/string loosely (String compare)', () => {
    assert.equal(h.findRowIndex(data, 0, '3'), 3);
    assert.equal(h.findRowIndex(data, 0, 3), 3);
  });
  it('returns -1 when not found', () => {
    assert.equal(h.findRowIndex(data, 0, 'nope'), -1);
  });
});

describe('Apps Script helpers - buildColumnOrders', () => {
  it('builds per-table column arrays preserving order', () => {
    const tables = { tasks: { columns: ['id', 'name'] }, notes: { columns: { id: 'text', body: 'text' } } };
    assert.deepEqual(h.buildColumnOrders(tables), { tasks: ['id', 'name'], notes: ['id', 'body'] });
  });
});

describe('Apps Script helpers - parseTranslations', () => {
  it('builds key->text map, skips incomplete rows', () => {
    const values = [['key', 'text'], ['hello', 'Hello'], ['empty', ''], ['', 'orphan'], ['bye', 'Bye']];
    assert.deepEqual(h.parseTranslations(values), { hello: 'Hello', bye: 'Bye' });
  });
});

describe('Apps Script helpers - multiselect arrays', () => {
  it('multiselectCols extracts multiselect column names (object + array forms)', () => {
    assert.deepEqual(h.multiselectCols({ a: 'text', h: { type: 'multiselect', list: 'p' } }), ['h']);
    assert.deepEqual(h.multiselectCols([{ name: 'a', type: 'text' }, { name: 'h', type: 'multiselect' }]), ['h']);
  });
  it('objectToValues JSON-encodes array cells; valuesToObjects(msCols) decodes them', () => {
    const headers = ['id', 'title', 'people'];
    const enc = h.objectToValues({ id: 'r1', title: 'Crew', people: ['Alice', 'Bob'] }, headers);
    assert.equal(enc[2], '["Alice","Bob"]');           // array -> JSON string for the cell
    const back = h.valuesToObjects([headers, enc], ['people']).rows[0];
    assert.deepEqual(back.people, ['Alice', 'Bob']); // decoded back to array
    assert.equal(back.title, 'Crew');                  // scalar untouched
  });
  it('empty multiselect cell decodes to []', () => {
    const back = h.valuesToObjects([['id', 'people'], ['r2', '']], ['people']).rows[0];
    assert.deepEqual(back.people, []);
  });
});
