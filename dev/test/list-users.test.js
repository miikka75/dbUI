const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const LU = require('../../list-users');

// email -> profile. Ann shared with a photo; Bob shared but no photo; Cara NOT shared (has a photo);
// Dave has no profile at all (deregistered).
const profiles = {
  'ann@x.com':  { shared: true,  picture: 'PIC_ANN' },
  'bob@x.com':  { shared: true,  picture: '' },
  'cara@x.com': { shared: false, picture: 'PIC_CARA' }
};
const listUsers = {
  seurakuntalaiset: { 'Ann': 'ann@x.com', 'Bob': 'bob@x.com', 'Cara': 'cara@x.com', 'Dave': 'dave@x.com' },
  piispakunta:      { 'piispa': 'ann@x.com' }
};

describe('list-users: buildAvatarProjection', () => {
  it('admin sees every linked user WITH a picture (shared or not), never an email', () => {
    const proj = LU.buildAvatarProjection(listUsers, profiles, true);
    assert.deepEqual(proj, {
      seurakuntalaiset: { Ann: 'PIC_ANN', Cara: 'PIC_CARA' },  // Bob omitted (no picture), Dave omitted (no profile)
      piispakunta: { piispa: 'PIC_ANN' }
    });
    // no email leaks into the projection
    assert.equal(JSON.stringify(proj).includes('@'), false);
  });

  it('non-admin sees only SHARED linked users with a picture; unshared are hidden', () => {
    const proj = LU.buildAvatarProjection(listUsers, profiles, false);
    assert.deepEqual(proj, {
      seurakuntalaiset: { Ann: 'PIC_ANN' },   // Cara hidden (not shared), Bob (no pic), Dave (no profile)
      piispakunta: { piispa: 'PIC_ANN' }
    });
    assert.equal(JSON.stringify(proj).includes('cara'), false);  // unshared user not even referenced
  });

  it('empty / missing inputs are safe', () => {
    assert.deepEqual(LU.buildAvatarProjection(null, null, true), {});
    assert.deepEqual(LU.buildAvatarProjection({}, profiles, false), {});
  });
});

describe('list-users: setLink', () => {
  it('adds a link (lowercasing the email) without mutating the input', () => {
    const base = {};
    const next = LU.setLink(base, 'roles', 'piispa', 'A@X.com');
    assert.deepEqual(next, { roles: { piispa: 'a@x.com' } });
    assert.deepEqual(base, {});   // untouched
  });

  it('clearing a link prunes an emptied list', () => {
    const base = { roles: { piispa: 'a@x.com' } };
    const next = LU.setLink(base, 'roles', 'piispa', '');
    assert.deepEqual(next, {});   // list dropped when it becomes empty
  });
});

describe('list-users: renameValue', () => {
  it('carries the link from the old value to the new one', () => {
    const base = { seurakuntalaiset: { 'Miika': 'm@x.com', 'Ann': 'ann@x.com' } };
    const next = LU.renameValue(base, 'seurakuntalaiset', 'Miika', 'Miikka');
    assert.deepEqual(next, { seurakuntalaiset: { 'Ann': 'ann@x.com', 'Miikka': 'm@x.com' } });
  });

  it('is a no-op when the old value was not linked', () => {
    const base = { seurakuntalaiset: { 'Ann': 'ann@x.com' } };
    assert.equal(LU.renameValue(base, 'seurakuntalaiset', 'Nobody', 'X'), base);
  });
});

describe('list-users: pictureFor', () => {
  it('reads a value out of a projection, or "" when absent', () => {
    const proj = { seurakuntalaiset: { Ann: 'PIC_ANN' } };
    assert.equal(LU.pictureFor(proj, 'seurakuntalaiset', 'Ann'), 'PIC_ANN');
    assert.equal(LU.pictureFor(proj, 'seurakuntalaiset', 'Bob'), '');
    assert.equal(LU.pictureFor(proj, 'nope', 'Ann'), '');
  });
});
