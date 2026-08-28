const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const LU = require('../../list-users');

// email -> profile. Ann shared with a photo AND a name; Bob shared with a name but no photo; Cara NOT
// shared (has both); Dave has no profile at all (deregistered); Eve is shared but has neither.
const profiles = {
  'ann@x.com':  { shared: true,  picture: 'PIC_ANN',  name: 'Ann Aalto' },
  'bob@x.com':  { shared: true,  picture: '',         name: 'Bob Berg' },
  'cara@x.com': { shared: false, picture: 'PIC_CARA', name: 'Cara Calo' },
  'eve@x.com':  { shared: true,  picture: '',         name: '' }
};
const listUsers = {
  seurakuntalaiset: { 'Ann': 'ann@x.com', 'Bob': 'bob@x.com', 'Cara': 'cara@x.com', 'Dave': 'dave@x.com', 'Eve': 'eve@x.com' },
  piispakunta:      { 'piispa': 'ann@x.com' }
};

describe('list-users: buildLinkProjection', () => {
  it('admin sees every linked user, shared or not, and never an email', () => {
    const proj = LU.buildLinkProjection(listUsers, profiles, true);
    assert.deepEqual(proj, {
      seurakuntalaiset: {
        Ann:  { picture: 'PIC_ANN', name: 'Ann Aalto' },
        Bob:  { name: 'Bob Berg' },                      // no picture: still worth a name
        Cara: { picture: 'PIC_CARA', name: 'Cara Calo' }
      },                                                 // Dave (no profile) and Eve (nothing to offer) omitted
      piispakunta: { piispa: { picture: 'PIC_ANN', name: 'Ann Aalto' } }
    });
    assert.equal(JSON.stringify(proj).includes('@'), false, 'no email may reach a viewer');
  });

  it('non-admin sees only SHARED linked users; unshared are not even referenced', () => {
    const proj = LU.buildLinkProjection(listUsers, profiles, false);
    assert.deepEqual(proj, {
      seurakuntalaiset: { Ann: { picture: 'PIC_ANN', name: 'Ann Aalto' }, Bob: { name: 'Bob Berg' } },
      piispakunta: { piispa: { picture: 'PIC_ANN', name: 'Ann Aalto' } }
    });
    assert.equal(JSON.stringify(proj).toLowerCase().includes('cara'), false);
  });

  it('a linked account offering neither picture nor name contributes nothing', () => {
    // Otherwise a bare {} entry would tell a viewer the value is linked while showing them nothing.
    const proj = LU.buildLinkProjection({ l: { Eve: 'eve@x.com' } }, profiles, true);
    assert.deepEqual(proj, {});
  });

  it('empty / missing inputs are safe', () => {
    assert.deepEqual(LU.buildLinkProjection(null, null, true), {});
    assert.deepEqual(LU.buildLinkProjection({}, profiles, false), {});
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

describe('list-users: pictureFor / nameFor', () => {
  const proj = { seurakuntalaiset: { Ann: { picture: 'PIC_ANN', name: 'Ann Aalto' }, Bob: { name: 'Bob Berg' } } };

  it('reads a picture out of a projection, or "" when absent', () => {
    assert.equal(LU.pictureFor(proj, 'seurakuntalaiset', 'Ann'), 'PIC_ANN');
    assert.equal(LU.pictureFor(proj, 'seurakuntalaiset', 'Bob'), '', 'name-only entry has no picture');
    assert.equal(LU.pictureFor(proj, 'seurakuntalaiset', 'Nobody'), '');
    assert.equal(LU.pictureFor(proj, 'nope', 'Ann'), '');
  });

  it('still reads the pre-userlink-name shape, where the entry WAS the picture', () => {
    // A client can hold a cached getListAvatars response from before the upgrade; it must render an
    // avatar, not a broken one.
    assert.equal(LU.pictureFor({ l: { Ann: 'PIC_ANN' } }, 'l', 'Ann'), 'PIC_ANN');
    assert.equal(LU.nameFor({ l: { Ann: 'PIC_ANN' } }, 'l', 'Ann'), '', 'the old shape carries no name');
  });

  it('reads a linked name, and never invents one from the value', () => {
    assert.equal(LU.nameFor(proj, 'seurakuntalaiset', 'Ann'), 'Ann Aalto');
    assert.equal(LU.nameFor(proj, 'seurakuntalaiset', 'Bob'), 'Bob Berg');
    assert.equal(LU.nameFor(proj, 'seurakuntalaiset', 'Nobody'), '');
    assert.equal(LU.nameFor(proj, 'nope', 'Ann'), '');
    assert.equal(LU.nameFor(null, 'l', 'v'), '');
  });
});
