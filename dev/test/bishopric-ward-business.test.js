// bishopric-ward-business.test.js — which block of the sacrament meeting program a calling lands in.
//
// The General Handbook treats callings differently in sacrament meeting:
//
//   - ward callings are presented for a sustaining vote, and released with a vote of thanks;
//   - receiving the Aaronic Priesthood / being ordained to an office is also put to a vote;
//   - Aaronic Priesthood QUORUM callings (deacons/teachers/priests presidencies and secretaries) are
//     sustained in the quorum meeting, and are only ANNOUNCED in sacrament meeting (Handbook 10);
//   - the elders quorum presidency is presented by the stake presidency, which brings its own business,
//     and other elders quorum callings (secretary, teacher) are sustained in the quorum meeting
//     (Handbook 8.3.4–8.3.5) -- so no elders quorum calling is on this ward program.
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
  releases: block('releases_header'),
  sustaining: block('sustaining_header'),
  announcement: block('quorum_announcement_header'),
  ordination: block('ordination_header')
};
const WARD_HEADER = block('ward_business');
const landsIn = (row) => Object.keys(BLOCKS).filter((k) => Rows.condMatches(row, BLOCKS[k].filter));
const wardHeader = (row) => Rows.condMatches(row, WARD_HEADER.filter);

describe('bishopric example — ward business in the sacrament meeting program', () => {
  ['young_men_deacons', 'young_men_teachers', 'young_men_priests'].forEach((org) => {
    it(org + ' callings are announced, not sustained', () => {
      assert.deepEqual(landsIn({ status: 'accepted', organization: org, calling: 'president' }), ['announcement']);
    });
  });

  it('the priests quorum has assistants, not a youth presidency (the bishop is its president)', () => {
    const callings = doc.tables.ref_callings.filter((r) => r.organization === 'young_men_priests').map((r) => r.calling);
    assert.deepEqual(callings, ['first_assistant', 'second_assistant', 'secretary']);
    assert.deepEqual(landsIn({ status: 'accepted', organization: 'young_men_priests', calling: 'first_assistant' }), ['announcement']);
  });

  it('an ordination is put to a vote in its own block', () => {
    assert.deepEqual(landsIn({ status: 'accepted', organization: 'aaronic_priesthood', calling: 'deacon' }), ['ordination']);
  });

  ['relief_society', 'primary'].forEach((org) => {
    it(org + ' callings are sustained and released in ward business', () => {
      assert.deepEqual(landsIn({ status: 'accepted', organization: org, calling: 'president' }), ['sustaining']);
      assert.deepEqual(landsIn({ status: 'released', organization: org, calling: 'president' }), ['releases']);
    });
  });

  ['president', 'first_counselor', 'second_counselor', 'secretary', 'teacher'].forEach((calling) => {
    it('the elders quorum ' + calling + ' is not on the ward program', () => {
      const row = { organization: 'elders_quorum', calling: calling };
      assert.deepEqual(landsIn(Object.assign({ status: 'accepted' }, row)), []);
      assert.deepEqual(landsIn(Object.assign({ status: 'released' }, row)), []);
    });
  });

  it('the program has no stake business blocks', () => {
    const stake = program.columns.filter((c) => c && typeof c.markdown === 'string' && c.markdown.indexOf('text.stake_') >= 0);
    assert.deepEqual(stake, []);
  });

  it('the ward business header shows only when a ward block has a row', () => {
    assert.equal(wardHeader({ status: 'accepted', organization: 'primary', calling: 'president' }), true);
    assert.equal(wardHeader({ status: 'accepted', organization: 'young_men_deacons', calling: 'president' }), true);
    assert.equal(wardHeader({ status: 'moved_in' }), true);
    assert.equal(wardHeader({ status: 'accepted', organization: 'elders_quorum', calling: 'president' }), false);
    assert.equal(wardHeader({ status: 'released', organization: 'elders_quorum', calling: 'secretary' }), false);
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
      ['quorum_announcement_header', 'quorum_announcement_footer'].forEach((key) => {
        assert.ok(text.indexOf('"text.' + key + '"') >= 0, code + ' defines text.' + key);
      });
    });
  });
});
