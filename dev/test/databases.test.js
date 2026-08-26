// databases.test.js — which database this browser is looking at, and which others it knows about.
//
// One deployment serves many databases; a Firebase project id is what makes it somebody's app. That
// lived in ONE localStorage key per backend, which cost two things nobody chose: a profile could hold
// exactly one database, and every install was the SAME PWA — identity is the manifest `id` (or
// `start_url` in older browsers) and both were the origin root for every database alike.
//
// The two cases that matter most here are the ones that are invisible when wrong: a key minted from a
// half-filled config (which would install as its own app), and the migration of an existing install
// (which must not move the user to a different database while it runs).
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Databases = require('../../databases');

// A localStorage stand-in: the real API, including the `length`/`key(i)` pair `list()` walks.
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}
const bind = (seed) => { const s = fakeStorage(seed); Databases._bind(s); return s; };

beforeEach(() => bind({}));

describe('Databases.keyFor — derived, never generated', () => {
  it('names a Firebase database by its project id', () => {
    assert.equal(Databases.keyFor('firebase', { projectId: 'chores-board', apiKey: 'x' }), 'firebase:chores-board');
  });

  it('names a Supabase database by its project ref', () => {
    assert.equal(Databases.keyFor('supabase', { url: 'https://abcdefgh.supabase.co', anonKey: 'k' }), 'supabase:abcdefgh');
  });

  it('keeps a self-hosted Supabase identifiable rather than unnamed', () => {
    assert.equal(Databases.keyFor('supabase', { url: 'https://db.example.org/' }), 'supabase:db.example.org');
  });

  it('is stable, because a random id would install as a second app', () => {
    // The key has to survive a profile being wiped and rebuilt from the same shared link. That is the
    // whole reason it is derived from the connection instead of minted.
    const cfg = { projectId: 'p', apiKey: 'k' };
    assert.equal(Databases.keyFor('firebase', cfg), Databases.keyFor('firebase', { ...cfg, apiKey: 'rotated' }));
  });

  it('refuses to name a config that identifies nothing', () => {
    // A half-filled setup form must not mint a key — that is a second installed app for a database
    // that does not exist.
    assert.equal(Databases.keyFor('firebase', { apiKey: 'k' }), null);
    assert.equal(Databases.keyFor('supabase', { anonKey: 'k' }), null);
    assert.equal(Databases.keyFor('firebase', null), null);
    assert.equal(Databases.keyFor('nonsense', { projectId: 'p' }), null);
  });

  it('gives the two local backends a key, because they take part in the same story', () => {
    assert.equal(Databases.keyFor('pglite'), 'pglite');
    assert.equal(Databases.keyFor('local'), 'local');
  });
});

describe('Databases — a profile holds several', () => {
  it('remembers two databases at once and switches between them', () => {
    const a = Databases.remember('firebase', { projectId: 'alpha', apiKey: 'k1' });
    const b = Databases.remember('firebase', { projectId: 'beta', apiKey: 'k2' });
    assert.equal(Databases.activeKey(), b, 'remembering makes it active');
    assert.deepEqual(Databases.list().map((d) => d.key), [a, b].sort());

    // The first is still there — which is the whole point; before this it had been overwritten.
    assert.equal(Databases.setActive(a), true);
    assert.equal(Databases.config('firebase').projectId, 'alpha');
  });

  it('moves the MODE with the database', () => {
    // A config and its backend have to switch together: pointing at a Firebase database while
    // `app_mode` still says supabase loads the wrong backend, which then finds no config at all.
    const s = bind({});
    Databases.remember('supabase', { url: 'https://sb.supabase.co', anonKey: 'k' });
    const fb = Databases.remember('firebase', { projectId: 'p', apiKey: 'k' });
    assert.equal(s.getItem('app_mode'), 'firebase');
    Databases.setActive('supabase:sb');
    assert.equal(s.getItem('app_mode'), 'supabase');
    Databases.setActive(fb);
    assert.equal(s.getItem('app_mode'), 'firebase');
  });

  it('refuses to activate a database it does not hold', () => {
    Databases.remember('firebase', { projectId: 'p', apiKey: 'k' });
    assert.equal(Databases.setActive('firebase:someone-elses'), false);
    assert.equal(Databases.activeKey(), 'firebase:p', 'a bad key must not leave the app pointing at nothing');
  });

  it('re-remembering updates the config and keeps one entry', () => {
    Databases.remember('firebase', { projectId: 'p', apiKey: 'old' });
    Databases.remember('firebase', { projectId: 'p', apiKey: 'new' });
    assert.equal(Databases.list().length, 1);
    assert.equal(Databases.config('firebase').apiKey, 'new');
  });

  it('forgetting the active one leaves nothing active', () => {
    Databases.remember('firebase', { projectId: 'p', apiKey: 'k' });
    Databases.forget('firebase:p');
    assert.equal(Databases.activeKey(), null);
    assert.deepEqual(Databases.list(), []);
  });
});

describe('Databases.migrate — an existing install keeps working', () => {
  it('folds the legacy single key in, and stays on the same database', () => {
    const s = bind({ app_mode: 'firebase', firebase_config: JSON.stringify({ projectId: 'old-app', apiKey: 'k' }) });
    assert.deepEqual(Databases.migrate(), ['firebase:old-app']);
    assert.equal(Databases.activeKey(), 'firebase:old-app', 'migrating must not move the user to another database');
    assert.equal(Databases.config('firebase').projectId, 'old-app');
    assert.equal(s.getItem('firebase_config'), JSON.stringify({ projectId: 'old-app', apiKey: 'k' }),
      'the legacy key is left alone — a downgrade, or a tab still running the old code, would otherwise find nothing');
  });

  it('is idempotent, because it runs on every boot', () => {
    bind({ app_mode: 'firebase', firebase_config: JSON.stringify({ projectId: 'p', apiKey: 'k' }) });
    Databases.migrate();
    Databases.remember('firebase', { projectId: 'p', apiKey: 'rotated' });
    assert.deepEqual(Databases.migrate(), [], 'a second run must not overwrite what has happened since');
    assert.equal(Databases.config('firebase').apiKey, 'rotated');
  });

  it('carries both backends over when a profile has used each', () => {
    bind({
      app_mode: 'supabase',
      firebase_config: JSON.stringify({ projectId: 'fb', apiKey: 'k' }),
      supabase_config: JSON.stringify({ url: 'https://sb.supabase.co', anonKey: 'k' }),
    });
    assert.deepEqual(Databases.migrate().sort(), ['firebase:fb', 'supabase:sb']);
    assert.equal(Databases.activeKey(), 'supabase:sb', 'app_mode decides which one the user was looking at');
  });

  it('gives a local-only profile its key too', () => {
    bind({ app_mode: 'pglite' });
    Databases.migrate();
    assert.equal(Databases.activeKey(), 'pglite');
  });

  it('leaves a fresh profile with nothing active', () => {
    bind({});
    assert.deepEqual(Databases.migrate(), []);
    assert.equal(Databases.activeKey(), null, 'a first visit has no database, and must not invent one');
  });
});

describe('Databases.config — the legacy fallback', () => {
  it('answers from the legacy key before migration has run', () => {
    // Things read this during boot, some of them before migrate(); returning null there would show the
    // setup screen to a user who has been using the app for a year.
    bind({ firebase_config: JSON.stringify({ projectId: 'p', apiKey: 'k' }) });
    assert.equal(Databases.config('firebase').projectId, 'p');
  });

  it('prefers the active database over the legacy key', () => {
    bind({ firebase_config: JSON.stringify({ projectId: 'stale', apiKey: 'k' }) });
    Databases.remember('firebase', { projectId: 'current', apiKey: 'k' });
    assert.equal(Databases.config('firebase').projectId, 'current');
  });

  it('does not hand one backend another backend’s config', () => {
    Databases.remember('supabase', { url: 'https://sb.supabase.co', anonKey: 'k' });
    assert.equal(Databases.config('firebase'), null);
  });
});

describe('Databases.manifestIdentity — two databases, two apps', () => {
  const base = 'https://example.com/app/';

  it('puts the key in `id` AND `start_url`', () => {
    // `id` is what a modern browser compares; `start_url` is the fallback in one too old for `id`. The
    // key has to be in both, or the two databases stay one app in exactly the browsers that cannot
    // say why.
    const m = Databases.manifestIdentity(base, 'firebase:alpha');
    assert.equal(m.id, base + '?db=firebase%3Aalpha');
    assert.equal(m.start_url, m.id);
  });

  it('gives different databases different identities', () => {
    const a = Databases.manifestIdentity(base, 'firebase:alpha');
    const b = Databases.manifestIdentity(base, 'firebase:beta');
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.start_url, b.start_url);
  });

  it('keeps ONE scope, because the code really is shared', () => {
    const a = Databases.manifestIdentity(base, 'firebase:alpha');
    const b = Databases.manifestIdentity(base, 'firebase:beta');
    assert.equal(a.scope, base);
    assert.equal(b.scope, base);
    assert.ok(a.start_url.indexOf(a.scope) === 0, 'start_url must be inside scope or the manifest is invalid');
  });

  it('falls back to the bare base when no database is chosen', () => {
    // The setup screen is not a database and must not install as one.
    assert.deepEqual(Databases.manifestIdentity(base, null), { id: base, start_url: base, scope: base });
  });
});
