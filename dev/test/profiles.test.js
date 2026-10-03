// profiles.test.js — who a person reads as, and what saving a profile writes (profiles.js).
//
// The parity block lifts the members app-core.js shipped BEFORE profiles.js existed and runs both over
// the same inputs; it had to pass before any caller was switched over, so it pins behaviour rather than
// re-describing the module. After the switch the lifted members delegate, so it keeps holding them
// together.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Profiles = require('../../profiles');
const { appCoreFn } = require('./app-core-fn');

const BY = {
  'ann@x.org': { name: 'Ann', picture: 'data:image/jpeg;base64,AAA' },
  'bo@x.org': { name: '', picture: 'data:image/jpeg;base64,BBB' }
};

describe('label: the privacy rule', () => {
  it('a shared name wins for everyone', () => {
    assert.equal(Profiles.label(BY, 'ann@x.org', false), 'Ann');
    assert.equal(Profiles.label(BY, 'ann@x.org', true), 'Ann');
  });
  it('an unshared user is their email to an admin and nobody to a member', () => {
    assert.equal(Profiles.label(BY, 'bo@x.org', true), 'bo@x.org');
    assert.equal(Profiles.label(BY, 'bo@x.org', false), '');
    assert.equal(Profiles.label(BY, 'stranger@x.org', false), '');
  });
  it('matches emails case-insensitively, and keeps the address as given for the admin', () => {
    assert.equal(Profiles.label(BY, 'ANN@X.org', false), 'Ann');
    assert.equal(Profiles.label(BY, 'Stranger@X.org', true), 'Stranger@X.org');
  });
  it('a missing email or map is nobody, never a crash', () => {
    assert.equal(Profiles.label(null, null, true), '');
    assert.equal(Profiles.label(undefined, 'a@b', false), '');
  });
});

describe('picture', () => {
  it('your own face comes from your profile, even unshared and even if a stale copy is cached', () => {
    const stale = Object.assign({}, BY, { 'me@x.org': { picture: 'old' } });
    assert.equal(Profiles.picture(stale, 'Me@x.org', { email: 'me@x.org', picture: 'new' }), 'new');
    assert.equal(Profiles.picture(stale, 'me@x.org', { email: 'me@x.org', picture: '' }), '');
  });
  it('anyone else comes from the shared map, or nothing', () => {
    assert.equal(Profiles.picture(BY, 'ann@x.org', { email: 'me@x.org', picture: 'p' }), BY['ann@x.org'].picture);
    assert.equal(Profiles.picture(BY, 'nobody@x.org', null), '');
    assert.equal(Profiles.picture(BY, '', { email: '', picture: 'p' }), '', 'a blank email is not "me"');
  });
});

describe('toSave', () => {
  const saved = { name: 'Ann', shared: true, picture: '' };
  it('trims the name, and a focus-out that changed nothing writes nothing', () => {
    const s = Profiles.toSave({ name: '  Ann ', shared: true, picture: '' }, saved);
    assert.deepEqual(s, { name: 'Ann', shared: true, picture: '', changed: false });
  });
  it('sharing requires a name: clearing it drops the opt-in', () => {
    assert.deepEqual(Profiles.toSave({ name: '   ', shared: true, picture: '' }, saved),
      { name: '', shared: false, picture: '', changed: true });
  });
  it('any field differing is a change, and nothing saved yet is always one', () => {
    assert.equal(Profiles.toSave({ name: 'Ann', shared: false, picture: '' }, saved).changed, true);
    assert.equal(Profiles.toSave({ name: 'Ann', shared: true, picture: 'x' }, saved).changed, true);
    assert.equal(Profiles.toSave({ name: 'Ann', shared: true, picture: '' }, null).changed, true);
  });
});

describe('normalize', () => {
  it('fills every field, so a template never reads undefined', () => {
    assert.deepEqual(Profiles.normalize(null), { name: '', shared: false, picture: '' });
    assert.deepEqual(Profiles.normalize({ name: 'A', shared: 1 }), { name: 'A', shared: true, picture: '' });
  });
});

describe('parity with the members app-core.js calls', () => {
  // The root's own members, run over the module's cases. `this` is the slice of root state each reads.
  const emails = ['ann@x.org', 'ANN@X.ORG', 'bo@x.org', 'stranger@x.org', '', null, 'me@x.org'];
  const root = (isAdmin) => {
    const ctx = { profilesByEmail: BY, isAdmin, currentUserEmail: 'Me@x.org', myProfile: { picture: 'mine' } };
    ctx.profileName = appCoreFn('profileName', { Profiles }).bind(ctx);
    ctx.profilePicture = appCoreFn('profilePicture', { Profiles }).bind(ctx);
    ctx.userLabel = appCoreFn('userLabel', { Profiles }).bind(ctx);
    return ctx;
  };
  for (const isAdmin of [true, false]) {
    it('userLabel / profileName / profilePicture agree' + (isAdmin ? ' (admin)' : ' (member)'), () => {
      const r = root(isAdmin);
      for (const e of emails) {
        assert.equal(r.userLabel(e), Profiles.label(BY, e, isAdmin), 'userLabel ' + e);
        assert.equal(r.profileName(e), Profiles.name(BY, e), 'profileName ' + e);
        assert.equal(r.profilePicture(e), Profiles.picture(BY, e, { email: 'Me@x.org', picture: 'mine' }), 'profilePicture ' + e);
      }
    });
  }
});
