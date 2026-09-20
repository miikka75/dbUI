// export-members.spec.js — the roster travels only when somebody asks, on BOTH ends.
//
// An export is the data; the people are separate. `_users` (role + table grants), `_profiles` (display
// names) and `_list_users` (the value → account links) used to stay behind entirely, so a deployment
// could be restored — or moved between backends — with every row intact and nobody able to sign in to
// anything. The links are what made that expensive: since a calling became an identity there are dozens
// of them behind `@me`, the per-person cards and the per-person feeds, and they are the one thing in a
// deployment that cannot be reconstructed from the data.
//
// Two switches rather than one, because what a file CARRIES and what an import REPLAYS are different
// decisions. A file with members in it holds everybody's email; an import that replays one is granting
// those people access to whatever received it. So the import side defaults off even when the file has a
// roster, and that is what most of this file pins.
const { test, expect } = require('./server-fixture');

const SCH = {
  defaultLanguage: 'en',
  tables: {
    // A reference catalogue and a table of somebody's work: an example carries the first and not the second.
    ref_grades: { isLookup: true, columns: [{ name: 'grade', type: 'text' }] },
    duty: { columns: [{ name: 'who', type: 'select', list: 'crew' }, { name: 'grade', type: 'ref', table: 'ref_grades', valueCol: 'grade' }] } },
  lists: { crew: ['lead', 'second'] },
  listSources: { crew: 'userlink-name' },
  views: [{ name: 'duty', sources: ['duty'], mode: 'union', columns: ['who'] }],
  nav: { items: [{ view: 'duty' }] }
};

async function boot(page) {
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCH } });
  await page.request.post('/api/initSchema', { data: { schema: SCH.tables } });
  await page.request.post('/api/saveLists', { data: { lists: SCH.lists } });
  await page.request.post('/api/putRow', { data: { tableId: 'duty', data: { id: 'd1', who: 'lead' }, tab: 'active' } });
  // A ward as it really is: two accounts with different access, a display name, and a position linked.
  // The first call is the bootstrap one (no users yet); everything after it is admin-gated, so it has
  // to say who is asking — exactly as a real admin session does.
  const asAdmin = { headers: { 'X-User': 'boss@x.test' } };
  await page.request.post('/api/setUserRole', { data: { uid: 'boss@x.test', role: 'admin', user: 'boss@x.test', tables: 'all' } });
  for (const [op, data] of [
    ['setUserRole', { uid: 'helper@x.test', role: 'editor', user: 'helper@x.test', tables: ['duty'] }],
    ['setProfileName', { email: 'helper@x.test', name: 'Helper' }],
    ['setListUser', { listName: 'crew', value: 'lead', email: 'boss@x.test' }]
  ]) {
    const r = await page.request.post('/api/' + op, Object.assign({ data: data }, asAdmin));
    expect(r.ok(), op + ' was refused while seeding').toBeTruthy();
  }
  // Seeding real users makes the dev client itself unregistered unless it says who it is — and an
  // unregistered client exports nothing, which is the correct behaviour and would silently pass for the
  // wrong reason here.
  await page.addInitScript(() => {
    localStorage.setItem('app_folder', 'local'); localStorage.setItem('app_mode', 'local');
    localStorage.setItem('test_user', 'boss@x.test');
  });
  await page.goto('/');
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
}

// The export writes a file through a Blob + anchor; capture the payload instead of the download.
const exported = (page) => page.evaluate(async () => {
  const app = window.appInstance;
  let captured = null;
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (blob) => { captured = blob.text(); return 'blob:stub'; };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {};
  try {
    await app.exportData();
    for (let i = 0; i < 100 && !captured; i++) await new Promise((r) => setTimeout(r, 50));
    return captured ? JSON.parse(await captured) : null;
  } finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
});

test('an export carries no roster unless it is asked for', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  const plain = await exported(page);
  expect(plain, 'the export produced no file').toBeTruthy();
  expect(plain.tables.duty.length).toBe(1);                 // it is still a real backup
  expect(plain.members, 'a backup must not quietly contain everybody\'s email').toBeUndefined();

  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages', 'data', 'users']; });
  const withMembers = await exported(page);
  expect(Object.keys(withMembers.members.users).sort()).toEqual(['boss@x.test', 'helper@x.test']);
  expect(withMembers.members.users['helper@x.test'].tables).toEqual(['duty']);   // the grant, not just the name
  expect(withMembers.members.profiles['helper@x.test'].name).toBe('Helper');
  // The link is the point of the whole feature.
  expect(withMembers.members.listUsers).toEqual({ crew: { lead: 'boss@x.test' } });
});

test('avatars stay behind, and the shared flag travels as a record', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);
  // A picture is a data: URL capped near 350KB; a hundred of them would dominate the file, and a member
  // can re-upload one where nobody can re-derive a grant.
  await page.request.post('/api/setMyProfile', { data: { name: 'Helper', shared: true, picture: 'data:image/png;base64,AAAA' } })
    .catch(() => {});
  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages', 'data', 'users']; });
  const out = await exported(page);
  for (const p of Object.values(out.members.profiles)) {
    expect(p.picture, 'an avatar reached the file').toBeUndefined();
    expect(typeof p.shared).toBe('boolean');
  }
});

test('importing a file with members does nothing to the roster unless asked', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages', 'data', 'users']; });
  const file = await exported(page);

  // A different deployment: same schema, nobody in it.
  await page.request.post('/api/resetData');
  await page.request.post('/api/saveSchema', { data: { schema: SCH } });
  await page.request.post('/api/initSchema', { data: { schema: SCH.tables } });
  await page.reload();   // no users at all now, so this client is the bootstrap admin
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  // Booting an empty deployment registers whoever arrives first as the bootstrap admin, so the
  // question is not "is the roster empty" but "did the people in the FILE get enrolled".
  const roster = async () => Object.keys(await (await page.request.post('/api/getUsers',
    { data: {}, headers: { 'X-User': 'boss@x.test' } })).json()).sort();

  // Default: the file is imported as DATA. Handing somebody an export to look at must not enrol anyone.
  await page.evaluate((f) => { window.appInstance.applyBundle(f); }, file);
  // An import RELOADS the page when it finishes. Wait that out before touching app state again, or the
  // reload lands on top of the next step and quietly resets the switch it is about to set.
  await page.waitForTimeout(5000);
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
  expect(await roster(), 'a plain import enrolled somebody from the file').not.toContain('helper@x.test');

  // Asked for: roles, grants, names and links all land.
  await page.evaluate((f) => { window.appInstance.importParts = ['schema', 'languages', 'data', 'users']; window.appInstance.applyBundle(f); }, file);
  await expect.poll(roster, { timeout: 20000 }).toContain('helper@x.test');
  const users = await (await page.request.post('/api/getUsers', { data: {}, headers: { 'X-User': 'boss@x.test' } })).json();
  expect(users['helper@x.test'].role).toBe('editor');
  expect(users['helper@x.test'].tables).toEqual(['duty']);
  await expect.poll(() => page.evaluate(() => (appInstance.listUserLinks.crew || {}).lead), { timeout: 10000 })
    .toBe('boss@x.test');
});

test('the structure is separable: a data-only file, and an import that leaves the schema alone', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);

  // A plain export carries the structure, because a restore into an empty deployment has to.
  expect((await exported(page)).schema).toBeTruthy();

  await page.evaluate(() => { window.appInstance.exportParts = ['data']; });
  const dataOnly = await exported(page);
  expect(dataOnly.schema, 'a data-only file must not carry the structure').toBeUndefined();
  expect(dataOnly.tables.duty.length, 'it is still the rows').toBe(1);
  expect(dataOnly.lists.crew).toEqual(['lead', 'second']);

  // Now the half that matters: a file whose schema is OLDER than the deployment. Importing it applies
  // that schema and silently rolls the structure back — unless the import is told not to.
  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages', 'data']; });
  const older = await exported(page);
  // An export writes columns as the documented array-of-objects form; this stands in for "a column the
  // deployment has since dropped", i.e. a file whose structure is behind the one in use.
  older.schema.tables.duty.columns.push({ name: 'gone_since', type: 'text' });

  await page.evaluate((f) => { window.appInstance.importParts = ['data']; window.appInstance.applyBundle(f); }, older);
  await page.waitForTimeout(5000);
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });
  expect(await page.evaluate(() => Object.keys(appInstance.schemaData.tables.duty.columns || {})),
    'the import applied a schema it was told to leave alone').not.toContain('gone_since');

  // And with the switch on, the same file does replace it — and says so, because the rows look
  // identical either way and the structure moving is the one thing you cannot see in them.
  await page.evaluate((f) => { window.appInstance.importParts = ['schema', 'languages', 'data']; window.appInstance.applyBundle(f); }, older);
  await expect.poll(() => page.evaluate(() => Object.keys(appInstance.schemaData.tables.duty.columns || {})), { timeout: 20000 })
    .toContain('gone_since');
});

test('schema only: the structure, with nothing a ward typed', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);
  await page.evaluate(() => { window.appInstance.exportParts = ['schema']; });
  const f = await exported(page);

  // What a copy of the deployment needs, and nothing a ward typed.
  expect(Object.keys(f.schema.tables)).toContain('duty');
  expect(f.translations, 'languages are their own part now').toBeUndefined();
  expect(f.tables, 'no rows').toBeUndefined();
  expect(f.lists, 'a list is a vocabulary somebody typed').toBeUndefined();
  expect(f.members, 'never without asking').toBeUndefined();
});

test('a language pack exports in the shape examples/ ships, one file per language', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);
  await page.request.post('/api/createLanguage', { data: { code: 'fi', name: 'Suomi', keys: [] },
    headers: { 'X-User': 'boss@x.test' } });
  await page.request.post('/api/updateTranslations', { data: { langCode: 'fi', updates: { 'app.title': 'Työkalu' } },
    headers: { 'X-User': 'boss@x.test' } });
  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  const out = await page.evaluate(async () => {
    const app = window.appInstance;
    let name = null, text = null;
    const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { text = b.text(); return 'blob:stub'; };
    HTMLAnchorElement.prototype.click = function() { name = this.download; };
    try {
      await app.exportLanguagePack({ code: 'fi', name: 'Suomi' });
      return { name: name, body: JSON.parse(await text) };
    } finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
  });

  // The manifest reads `<id>-lang-<code>.json`, so the file drops into examples/ under the name it
  // already expects — which is what makes a contribution a copy rather than a rename.
  expect(out.name).toMatch(/-lang-fi\.json$/);
  // Byte-shape of a shipped pack: the language it declares, and the translations under that code.
  expect(Object.keys(out.body).sort()).toEqual(['languages', 'translations']);
  expect(out.body.languages).toEqual([{ code: 'fi', name: 'Suomi' }]);
  expect(out.body.translations.fi['app.title']).toBe('Työkalu');
});

test('export as example: the structure somebody else installs, with no ward in it', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);
  // A reference catalogue the schema is useless without, and a row of somebody's actual work.
  await page.request.post('/api/putRow', { data: { tableId: 'ref_grades', tab: 'active',
    data: { id: 'g1', grade: 'first' } }, headers: { 'X-User': 'boss@x.test' } });
  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  const out = await page.evaluate(async () => {
    const app = window.appInstance;
    let name = null, text = null;
    const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { text = b.text(); return 'blob:stub'; };
    HTMLAnchorElement.prototype.click = function() { name = this.download; };
    try {
      await app.exportAsExample();
      return { name: name, body: JSON.parse(await text) };
    } finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
  });

  expect(out.name).toMatch(/-schema\.json$/);
  expect(Object.keys(out.body).sort()).toEqual(['lists', 'schema', 'tables']);
  // The structure, in the documented column shape rather than the runtime's map.
  expect(Array.isArray(out.body.schema.tables.duty.columns)).toBe(true);
  // A lookup is reference data the schema cannot work without; `duty` is somebody's rows and stays home.
  expect(out.body.tables.ref_grades.map((r) => r.grade)).toEqual(['first']);
  expect(out.body.tables.duty, 'rows a ward typed are not an example').toBeUndefined();
  // Every referenced list is DECLARED and EMPTY: the installing ward types its own, and
  // Examples.listsForInstall fills the gap without touching one that already has values.
  expect(out.body.lists.crew).toEqual([]);
  expect(out.body.lists.ref_grades, 'a lookup is a table, not a list').toBeUndefined();
});
