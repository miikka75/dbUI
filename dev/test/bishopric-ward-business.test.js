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
  blessing: block('blessing_header'),
  confirmation: block('confirmation_header'),
  welcome: block('welcome_header'),
  child_baptized: block('child_baptized_header'),
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

  it('the quorum announcement comes last in ward business, after the ordinations', () => {
    const idx = (b) => program.columns.indexOf(b);
    assert.equal(idx(BLOCKS.announcement), idx(BLOCKS.ordination) + 1);
    assert.ok(idx(BLOCKS.ordination) > idx(BLOCKS.sustaining));
  });

  it('ward business runs blessing, confirmation, welcome, recognition, releases, sustainings, ordinations, announcements', () => {
    const idx = (b) => program.columns.indexOf(b);
    const order = ['blessing', 'confirmation', 'welcome', 'child_baptized', 'releases', 'sustaining', 'ordination', 'announcement'];
    order.forEach((k, i) => { if (i) assert.equal(idx(BLOCKS[k]), idx(BLOCKS[order[i - 1]]) + 1, k + ' follows ' + order[i - 1]); });
    assert.equal(idx(BLOCKS.blessing), idx(WARD_HEADER) + 1);
  });

  it('a child to be blessed is named and blessed, with no vote', () => {
    assert.deepEqual(landsIn({ status: 'child_blessing' }), ['blessing']);
    ['sustaining_footer', 'welcome_footer', 'ordination_footer'].forEach((vote) => assert.ok(BLOCKS.blessing.markdown.indexOf(vote) < 0, vote));
    assert.equal(wardHeader({ status: 'child_blessing' }), true);
  });

  // Confirmation may happen at the baptismal service or in sacrament meeting, so each kind of new member
  // has a "to be confirmed" and an "already confirmed" status, and only the first is listed for confirmation.
  it('a convert still to be confirmed is confirmed, then welcomed into the ward', () => {
    assert.deepEqual(landsIn({ status: 'recently_baptized' }), ['confirmation', 'welcome']);
  });

  it('a convert confirmed at the baptism is only welcomed', () => {
    assert.deepEqual(landsIn({ status: 'convert_confirmed' }), ['welcome']);
    assert.equal(wardHeader({ status: 'convert_confirmed' }), true);
  });

  it('a child of record still to be confirmed is confirmed, then recognized without a welcome vote', () => {
    assert.deepEqual(landsIn({ status: 'child_baptized' }), ['confirmation', 'child_baptized']);
    assert.ok(BLOCKS.child_baptized.markdown.indexOf('welcome_footer') < 0);
    assert.equal(wardHeader({ status: 'child_baptized' }), true);
  });

  it('a child of record confirmed at the baptism is only recognized', () => {
    assert.deepEqual(landsIn({ status: 'child_confirmed' }), ['child_baptized']);
    assert.equal(wardHeader({ status: 'child_confirmed' }), true);
  });

  it('every Welcome-phase status appears on the program, and the Welcome lane comes before needs_calling', () => {
    const st = doc.tables.ref_statuses;
    const welcome = st.filter((r) => r.phase === 'welcome').map((r) => r.status);
    assert.deepEqual(welcome, ['child_blessing', 'recently_baptized', 'convert_confirmed', 'child_baptized', 'child_confirmed', 'moved_in']);
    welcome.forEach((status) => assert.ok(landsIn({ status }).length > 0, status + ' is on the program'));
    const pos = (x) => Number(st.filter((r) => r.status === x)[0].position);
    assert.equal(pos('needs_calling'), pos('moved_in') + 1);
  });

  it('a member who moved in is only welcomed', () => {
    assert.deepEqual(landsIn({ status: 'moved_in' }), ['welcome']);
  });

  it('every block the program uses has an English and a Finnish text', () => {
    ['en', 'fi'].forEach((code) => {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'bishopric-lang-' + code + '.json'), 'utf8');
      ['quorum_announcement_header', 'quorum_announcement_footer', 'blessing_header', 'blessing_footer', 'confirmation_header', 'confirmation_footer', 'child_baptized_header', 'child_baptized_footer'].forEach((key) => {
        assert.ok(text.indexOf('"text.' + key + '"') >= 0, code + ' defines text.' + key);
      });
    });
  });
});
