const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Columns = require('../../columns');

// Schema (tables map) with the image/url column types alongside the existing ones.
const schema = {
  gallery: { columns: {
    title: { type: 'text' },
    photo: { type: 'image' },
    link:  { type: 'url' },
    when:  { type: 'date' }
  } },
  other: { columns: { tags: { type: 'multiselect', list: 'tags' }, points: { type: 'number' } } },
  tasks: { columns: {
    status: { type: 'select', list: 'status', picker: 'chips' },
    prio:   { type: 'select', list: 'prio', picker: 'toggle' },
    owner:  { type: 'select', list: 'people' }   // no picker -> dropdown
  } }
};

describe('columns.js — image/url column scanners', () => {
  it('colIsImage / colIsUrl detect the new types (any-table, memoized scan)', () => {
    assert.equal(Columns.colIsImage(schema, 'photo'), true);
    assert.equal(Columns.colIsUrl(schema, 'link'), true);
    assert.equal(Columns.colIsImage(schema, 'link'), false);
    assert.equal(Columns.colIsUrl(schema, 'photo'), false);
  });

  it('does not confuse image/url with other types', () => {
    assert.equal(Columns.colIsImage(schema, 'title'), false);
    assert.equal(Columns.colIsUrl(schema, 'when'), false);
    assert.equal(Columns.colIsDate(schema, 'when'), true);
    assert.equal(Columns.colIsMultiselect(schema, 'tags'), true);
    assert.equal(Columns.colIsImage(schema, 'tags'), false);
  });

  it('colIsNumber detects `number` by column name across tables (a view has no schema entry of its own)', () => {
    assert.equal(Columns.colIsNumber(schema, 'points'), true);
    assert.equal(Columns.colIsNumber(schema, 'title'), false);
    assert.equal(Columns.colIsNumber(schema, 'when'), false);
    assert.equal(Columns.colIsNumber(schema, 'nope'), false);   // unknown column -> false, no throw
  });

  it('colPicker returns a select column\'s widget choice (chips/toggle), else null', () => {
    assert.equal(Columns.colPicker(schema, 'status'), 'chips');
    assert.equal(Columns.colPicker(schema, 'prio'), 'toggle');
    assert.equal(Columns.colPicker(schema, 'owner'), null);   // default dropdown
    assert.equal(Columns.colPicker(schema, 'nope'), null);
  });

  it('tableRefCol finds a table\'s ref column pointing at a target table', () => {
    const s = {
      events: { columns: { date: { type: 'date' } } },
      resp:   { columns: { owner: { type: 'owner' }, link: { type: 'ref', table: 'events', valueCol: 'date' }, note: { type: 'text' } } }
    };
    assert.deepEqual(Columns.tableRefCol(s, 'resp', 'events'), { name: 'link', valueCol: 'date' });
    assert.equal(Columns.tableRefCol(s, 'resp', 'nope'), null);   // no ref to that table
    assert.equal(Columns.tableRefCol(s, 'events', 'resp'), null); // events has no ref column
  });

  it('unknown column falls through to the empty info (no throw)', () => {
    assert.equal(Columns.colIsImage(schema, 'nope'), false);
    assert.equal(Columns.colIsUrl(schema, 'nope'), false);
    assert.equal(Columns.columnType(schema, 'gallery', 'photo'), 'image');
  });
});
