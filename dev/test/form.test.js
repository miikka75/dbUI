// form.test.js — the `form` view's pure engine.
//
// A form is the self-service shape rsvp already had, loosened: one owner-stamped row the member writes
// themselves, gated by the same ownerWritable/ownerWritableWhile rules — but with several fields,
// grouped, some required, submitted once rather than toggled. Everything below is pure over rows, so
// the awkward cases can be stated directly instead of clicked through.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Form = require('../../form');

const ME = 'me@x.com';

describe('form — whose record is it', () => {
  const rows = [
    { id: 'a', owner: 'other@x.com', q: 'theirs' },
    { id: 'b', owner: ME, q: 'mine' }
  ];

  it('finds the caller’s own row', () => {
    assert.equal(Form.build(rows, { me: ME, columns: ['q'] }).record.id, 'b');
  });

  it('finds nothing for a caller with no row', () => {
    const r = Form.build(rows, { me: 'nobody@x.com', columns: ['q'] });
    assert.equal(r.record, null);
    assert.equal(r.submitted, false);
  });

  it('matches NOTHING when signed out, even against blank owners', () => {
    // An owner column is stamped with an identity. Matching rows whose owner is also blank would hand
    // one anonymous visitor another's draft — the whole point of the owner primitive.
    const anon = [{ id: 'x', owner: '', q: 'loose' }, { id: 'y', q: 'no owner at all' }];
    assert.equal(Form.build(anon, { me: '', columns: ['q'] }).record, null);
  });

  it('honours a non-default owner column', () => {
    const custom = [{ id: 'a', kirjoittaja: ME }];
    assert.equal(Form.build(custom, { me: ME, ownerCol: 'kirjoittaja', columns: ['q'] }).record.id, 'a');
  });

  it('with `once: false` it never claims an existing row', () => {
    // A form that collects many submissions per person starts blank every time; the previous ones are
    // rows in the table, not this person's draft.
    assert.equal(Form.build(rows, { me: ME, once: false, columns: ['q'] }).record, null);
  });

  it('a duplicate resolves to the most recently updated one', () => {
    // Two tabs, or a delete that failed. Whichever they last worked on is the one to show.
    const dupes = [
      { id: 'old', owner: ME, updated_at: '2026-01-01' },
      { id: 'new', owner: ME, updated_at: '2026-06-01' }
    ];
    assert.equal(Form.build(dupes, { me: ME, columns: ['q'] }).record.id, 'new');
    assert.equal(Form.build(dupes.slice().reverse(), { me: ME, columns: ['q'] }).record.id, 'new');
  });
});

describe('form — sections', () => {
  it('declared sections keep their order and titles', () => {
    const r = Form.build([], { me: ME, sections: [
      { title: 'field.perustiedot', columns: ['nimi'] },
      { columns: ['viesti'] }
    ] });
    assert.deepEqual(r.sections, [
      { title: 'field.perustiedot', columns: ['nimi'] },
      { title: '', columns: ['viesti'] }
    ]);
    assert.deepEqual(r.columns, ['nimi', 'viesti']);
  });

  it('a form with no sections is ONE untitled section, so the component renders one shape', () => {
    const r = Form.build([], { me: ME, columns: ['a', 'b'] });
    assert.deepEqual(r.sections, [{ title: '', columns: ['a', 'b'] }]);
  });

  it('sections win over a bare `columns` list', () => {
    const r = Form.build([], { me: ME, columns: ['ignored'], sections: [{ columns: ['used'] }] });
    assert.deepEqual(r.columns, ['used']);
  });

  it('drops empty and malformed sections rather than rendering blank headings', () => {
    const r = Form.build([], { me: ME, sections: [null, { title: 'x' }, { columns: [] }, { columns: ['ok'] }] });
    assert.deepEqual(r.sections, [{ title: '', columns: ['ok'] }]);
  });

  it('dedupes a column named in two sections', () => {
    const r = Form.build([], { me: ME, sections: [{ columns: ['a', 'b'] }, { columns: ['b', 'c'] }] });
    assert.deepEqual(r.columns, ['a', 'b', 'c']);
  });
});

describe('form — what is still missing', () => {
  const opts = (over) => Object.assign({ me: ME, columns: ['nimi', 'viesti'], required: ['nimi', 'viesti'] }, over);

  it('everything is missing before there is a record', () => {
    const r = Form.build([], opts());
    assert.deepEqual(r.missing, ['nimi', 'viesti']);
    assert.equal(r.complete, false);
  });

  it('a filled field stops being missing', () => {
    const r = Form.build([{ id: 'a', owner: ME, nimi: 'Kati' }], opts());
    assert.deepEqual(r.missing, ['viesti']);
  });

  it('complete when nothing is missing', () => {
    const r = Form.build([{ id: 'a', owner: ME, nimi: 'Kati', viesti: 'Hei' }], opts());
    assert.deepEqual(r.missing, []);
    assert.equal(r.complete, true);
  });

  it('whitespace is not an answer', () => {
    assert.deepEqual(Form.build([{ id: 'a', owner: ME, nimi: '   ', viesti: 'x' }], opts()).missing, ['nimi']);
  });

  it('an EMPTY ARRAY is not an answer either', () => {
    // A multi-value column with nothing chosen is exactly as unanswered as an empty text box. Treating
    // [] as filled would let `required` be satisfied by a field nobody touched.
    assert.deepEqual(Form.build([{ id: 'a', owner: ME, nimi: [], viesti: 'x' }], opts()).missing, ['nimi']);
    assert.deepEqual(Form.build([{ id: 'a', owner: ME, nimi: ['Kati'], viesti: 'x' }], opts()).missing, []);
  });

  it('false and 0 ARE answers', () => {
    // A checkbox answered "no" and a number answered "0" have been answered. Reusing plain falsiness
    // here would quietly force people to pick the other one.
    assert.equal(Form.filled(false), true);
    assert.equal(Form.filled(0), true);
  });

  it('a `required` column the form does not show is ignored', () => {
    // Otherwise a form could never be completed, and nothing on screen would say why.
    const r = Form.build([{ id: 'a', owner: ME, nimi: 'Kati' }],
      { me: ME, columns: ['nimi'], required: ['nimi', 'ghost'] });
    assert.deepEqual(r.required, ['nimi']);
    assert.deepEqual(r.missing, []);
  });
});

describe('form — may it still be changed', () => {
  it('a record that does not exist yet is writable — creating it is the point', () => {
    assert.equal(Form.build([], { me: ME, columns: ['q'] }).editable, true);
  });

  it('no state gate means always editable', () => {
    assert.equal(Form.build([{ id: 'a', owner: ME }], { me: ME, columns: ['q'] }).editable, true);
  });

  it('editable only while the record holds an owner-writable value', () => {
    // Mirrors ownerWritableWhile in both rule layers: "you may fix your entry until it is approved".
    const gate = { me: ME, columns: ['q'], whileCol: 'tila', whileVals: ['luonnos'] };
    assert.equal(Form.build([{ id: 'a', owner: ME, tila: 'luonnos' }], gate).editable, true);
    assert.equal(Form.build([{ id: 'a', owner: ME, tila: 'hyvaksytty' }], gate).editable, false);
  });

  it('an empty whileVals is no gate, not a closed one', () => {
    // A mirror written before the feature carries no values. Reading that as "nothing is writable"
    // would lock every member out of their own record until an admin re-saved the schema.
    const r = Form.build([{ id: 'a', owner: ME, tila: 'x' }],
      { me: ME, columns: ['q'], whileCol: 'tila', whileVals: [] });
    assert.equal(r.editable, true);
  });
});

describe('form — degenerate input', () => {
  it('survives no rows, no options, and no columns', () => {
    for (const args of [[null, null], [[], {}], [undefined, undefined]]) {
      const r = Form.build(args[0], args[1]);
      assert.deepEqual(r.sections, []);
      assert.deepEqual(r.columns, []);
      assert.deepEqual(r.missing, []);
      assert.equal(r.complete, true, 'a form with nothing required is trivially complete');
      assert.equal(r.submitted, false);
    }
  });

  it('ignores rows that are not objects', () => {
    assert.equal(Form.build([null, 0, 'x', { id: 'a', owner: ME }], { me: ME, columns: ['q'] }).record.id, 'a');
  });
});
