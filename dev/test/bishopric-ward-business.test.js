// bishopric-ward-business.test.js — which block of the sacrament meeting program a calling lands in.
//
// The General Handbook treats callings differently in sacrament meeting:
//
//   - ward callings are presented for a sustaining vote;
//   - receiving the Aaronic Priesthood / being ordained to an office is also put to a vote;
//   - Aaronic Priesthood QUORUM callings (deacons/teachers/priests presidencies and secretaries) are
//     sustained in the quorum meeting, and are only ANNOUNCED in sacrament meeting (Handbook 10).
//
// Each block is a filter over admin_callings. They are written separately, so nothing but this test
// stops a calling from matching two blocks at once or none at all.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SchemaNormalize = require('../../schema-normalize');
const Rows = require('../../rows');

const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'bishopric-schema.json'), 'utf8'));
const program = SchemaNormalize.flattenViews(doc.schema.views).meeting_program;

const block = (header) => {
  const b = program.columns.filter((c) => c && typeof c.markdown === 'string' && c.markdown.indexOf('{{t:text.' + header + '}}') === 0)[0];
  assert.ok(b, 'meeting_program has a ' + header + ' block');
  return b;
};
const BLOCKS = {
  sustaining: block('sustaining_header'),
  announcement: block('quorum_announcement_header'),
  ordination: block('ordination_header')
};
const landsIn = (row) => Object.keys(BLOCKS).filter((k) => Rows.condMatches(row, BLOCKS[k].filter));

describe('bishopric example — ward business in the sacrament meeting program', () => {
  ['young_men_deacons', 'young_men_teachers', 'young_men_priests'].forEach((org) => {
    it(org + ' callings are announced, not sustained', () => {
      assert.deepEqual(landsIn({ status: 'accepted', organization: org, calling: 'president' }), ['announcement']);
    });
  });

  it('an ordination is put to a vote in its own block', () => {
    assert.deepEqual(landsIn({ status: 'accepted', organization: 'aaronic_priesthood', calling: 'deacon' }), ['ordination']);
  });

  ['elders_quorum', 'relief_society', 'primary'].forEach((org) => {
    it(org + ' callings are sustained', () => {
      assert.deepEqual(landsIn({ status: 'accepted', organization: org, calling: 'president' }), ['sustaining']);
    });
  });

  it('a calling not yet accepted is in none of them', () => {
    assert.deepEqual(landsIn({ status: 'called', organization: 'young_men_deacons', calling: 'president' }), []);
  });

  it('the announcement carries no sustaining vote', () => {
    assert.ok(BLOCKS.announcement.markdown.indexOf('sustaining_footer') < 0);
  });

  it('every block the program uses has an English and a Finnish text', () => {
    ['en', 'fi'].forEach((code) => {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'bishopric-lang-' + code + '.json'), 'utf8');
      ['text.quorum_announcement_header', 'text.quorum_announcement_footer'].forEach((key) => {
        assert.ok(text.indexOf('"' + key + '"') >= 0, code + ' defines ' + key);
      });
    });
  });
});
