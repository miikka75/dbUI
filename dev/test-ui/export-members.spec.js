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

// Capture every file a selection writes — NAMES as well as bodies, because the names are what make a
// contribution droppable into examples/ without renaming anything.
const exportFiles = (page) => page.evaluate(async () => {
  const app = window.appInstance;
  const out = [];
  let pending = null;
  const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (b) => { pending = b.text(); return 'blob:stub'; };
  HTMLAnchorElement.prototype.click = function() { out.push({ name: this.download, text: pending }); };
  try {
    await app.exportData();
    for (let i = 0; i < 120 && !out.length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1200));   // the set downloads sequentially, with a gap
    const files = {};
    for (const f of out) files[f.name] = JSON.parse(await f.text);
    return files;
  } finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
});
const oneFile = async (page) => {
  const files = await exportFiles(page);
  const names = Object.keys(files);
  return { name: names[0], body: files[names[0]], count: names.length };
};

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

  await page.evaluate(() => { window.appInstance.exportParts = ['backup', 'users']; });
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
  await page.evaluate(() => { window.appInstance.exportParts = ['backup', 'users']; });
  const out = await exported(page);
  for (const p of Object.values(out.members.profiles)) {
    expect(p.picture, 'an avatar reached the file').toBeUndefined();
    expect(typeof p.shared).toBe('boolean');
  }
});

test('importing a file with members does nothing to the roster unless asked', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  await page.evaluate(() => { window.appInstance.exportParts = ['backup', 'users']; });
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
  await page.evaluate((f) => { window.appInstance.importParts = ['backup', 'users']; window.appInstance.applyBundle(f); }, file);
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
  await page.evaluate(() => { window.appInstance.exportParts = ['backup']; });
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
  await page.evaluate((f) => { window.appInstance.importParts = ['backup']; window.appInstance.applyBundle(f); }, older);
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
  expect(f.tables, 'reference data is its own part now').toBeUndefined();
  expect(f.lists, 'so are the list names it declares').toBeUndefined();
  expect(f.members, 'never without asking').toBeUndefined();
});

test('languages come out one file per language, in the shape examples/ ships', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  for (const [code, name, title] of [['fi', 'Suomi', 'Työkalu'], ['sv', 'Svenska', 'Verktyg']]) {
    await page.request.post('/api/createLanguage', { data: { code: code, name: name, keys: [] },
      headers: { 'X-User': 'boss@x.test' } });
    await page.request.post('/api/updateTranslations', { data: { langCode: code, updates: { 'app.title': title } },
      headers: { 'X-User': 'boss@x.test' } });
  }
  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  await page.evaluate(() => { window.appInstance.exportParts = ['languages']; });
  const files = await exportFiles(page);

  // One file per language, because that is what the examples manifest reads — not one file holding
  // them all, which imports fine and contributes to nothing.
  const names = Object.keys(files).sort();
  expect(names.filter((n) => /-lang-(fi|sv)\.json$/.test(n)).length).toBe(2);
  const fi = files[names.find((n) => n.endsWith('-lang-fi.json'))];
  // Byte-shape of a shipped pack: the language it declares, and the translations under that code.
  expect(Object.keys(fi).sort()).toEqual(['languages', 'translations']);
  expect(fi.languages).toEqual([{ code: 'fi', name: 'Suomi' }]);
  expect(fi.translations.fi['app.title']).toBe('Työkalu');
  expect(fi.translations.sv, 'a pack carries its own language and no other').toBeUndefined();
});

test('an example is a selection now: structure + languages + reference, and no ward in it', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);
  // A reference catalogue the schema is useless without, and a row of somebody's actual work.
  await page.request.post('/api/putRow', { data: { tableId: 'ref_grades', tab: 'active',
    data: { id: 'g1', grade: 'first' } }, headers: { 'X-User': 'boss@x.test' } });
  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'reference']; });
  const out = await oneFile(page);

  // A file with no ordinary rows and nobody's account in it is a contribution, so it is named the way
  // the examples manifest reads one rather than as a dated backup.
  expect(out.name).toMatch(/-schema\.json$/);
  // Byte-shaped like examples/bishopric-schema.json: the structure, the list names, the catalogues.
  // The packs are their own files beside it, which is how the manifest reads a bundle.
  expect(Object.keys(out.body).sort()).toEqual(['lists', 'schema', 'tables']);
  expect(out.body.config, "an installer should not inherit this deployment's settings").toBeUndefined();
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

test('a contribution imports as the files it ships, not one at a time', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  await page.request.post('/api/putRow', { data: { tableId: 'ref_grades', tab: 'active',
    data: { id: 'g1', grade: 'first' } }, headers: { 'X-User': 'boss@x.test' } });
  await page.request.post('/api/createLanguage', { data: { code: 'fi', name: 'Suomi', keys: [] },
    headers: { 'X-User': 'boss@x.test' } });
  await page.request.post('/api/updateTranslations', { data: { langCode: 'fi', updates: { 'app.title': 'Työkalu' } },
    headers: { 'X-User': 'boss@x.test' } });
  await page.reload();
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  // Exactly what a contributor uploads: the two files the two export actions produce.
  const grab = (fn) => page.evaluate(async (f) => {
    const app = window.appInstance;
    let text = null;
    const realCreate = URL.createObjectURL, realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { text = b.text(); return 'blob:stub'; };
    HTMLAnchorElement.prototype.click = function() {};
    try { await app[f]({ code: 'fi', name: 'Suomi' }); return JSON.parse(await text); }
    finally { URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick; }
  }, fn);
  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages', 'reference']; });
  const files = await exportFiles(page);
  const schemaName = Object.keys(files).find((n) => n.endsWith('-schema.json'));
  const langName = Object.keys(files).find((n) => n.endsWith('-lang-fi.json'));
  expect(schemaName, 'one selection, the whole bundle').toBeTruthy();
  expect(langName, 'one file per language, as the manifest reads them').toBeTruthy();
  const schemaFile = files[schemaName], langFile = files[langName];

  // Folded the way the file picker hands them over, which is what importData now does.
  const merged = await page.evaluate(([a, b]) => {
    const m = window.Examples.mergeFiles([a, b]);
    return { hasSchema: !!m.schema, langs: (m.languages || []).map((l) => l.code),
             title: ((m.translations || {}).fi || {})['app.title'],
             lookupRows: Object.keys(m.tables || {}) };
  }, [schemaFile, langFile]);

  expect(merged.hasSchema, 'the structure').toBe(true);
  expect(merged.langs).toEqual(['fi']);
  expect(merged.title, 'the pack came with it').toBe('Työkalu');
  expect(merged.lookupRows).toEqual(['ref_grades']);
});

test('a list declared empty is a declaration, never a restore', async ({ page }) => {
  test.setTimeout(60000);
  await boot(page);
  // The ward has typed its vocabulary. A contribution names the same list and ships it EMPTY, because
  // that is what examples/ does — and a hand-picked import otherwise replaces and prunes lists.
  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'reference']; });
  const contribution = (await oneFile(page)).body;
  expect(contribution.lists.crew, 'a contribution declares the name and leaves it empty').toEqual([]);

  await page.evaluate((f) => {
    window.appInstance.importParts = ['schema', 'reference'];
    window.appInstance.applyBundle(f);
  }, contribution);
  await page.waitForTimeout(5000);
  await page.waitForSelector('.v-navigation-drawer .v-list-item', { timeout: 10000 });

  // Replacing with nothing could only destroy, so it fills gaps instead. Without this rule the
  // contribution path itself would be the fastest way to lose a year of typing.
  expect(await page.evaluate(() => appInstance.listsCache.crew)).toEqual(['lead', 'second']);
});

test('the parts a backup already contains are shown as contained, not as choices', async ({ page }) => {
  test.setTimeout(30000);
  await boot(page);

  // What the menu offers has to answer "what is in a backup?" from the same place the EXPORT answers
  // it. A sentence in a label could drift from `_activeParts`; asking it cannot.
  const state = () => page.evaluate(() => appInstance.partOptions('exportParts')
    .map((o) => o.value + (o.disabled ? ':locked' : '')));

  expect(await state()).toEqual(['backup', 'schema:locked', 'languages:locked', 'reference:locked',
    'data:locked', 'users']);
  // `users` is never locked: a backup does not carry it until that tick says so, which is the whole
  // reason it is a separate part.

  await page.evaluate(() => { window.appInstance.exportParts = ['schema', 'languages']; });
  expect(await state(), 'unticking the backup hands every part back').toEqual(
    ['backup', 'schema', 'languages', 'reference', 'data', 'users']);

  // And the lock tracks the SAME expansion the export gates on, so the two cannot disagree.
  expect(await page.evaluate(() => { window.appInstance.exportParts = ['backup'];
    return window.appInstance._activeParts('exportParts'); }))
    .toEqual(['schema', 'languages', 'reference', 'data']);
});
