// Verifies firestore.rules against the Firestore EMULATOR. Run via:
//   firebase emulators:exec --only firestore --project demo-rules \
//     "node dev/test-emulator/firestore-rules.mjs"   (see `npm run test:rules`).
//
// Focus: the data catch-all (`match /{collection}/{doc}`) must not also govern a SYSTEM collection.
// Its owner-create branch lets any registered user create a doc they stamp as their own — harmless on a
// data table, a privilege escalation on _users (role() reads that doc). Asserts a viewer cannot forge
// _users / _profiles / _access_requests, while the legitimate owner-create (data rows, _pages) still works.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';

const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-rules',
  firestore: { rules: readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 8080 }
});

// Registry: an admin and a plain viewer, seeded into the legacy _meta/users map (role() reads it when
// there is no per-user _users doc). Seeding also makes noUsers() false, so the bootstrap-admin path is off.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/users'), {
    'admin@x.com': { role: 'admin', tables: 'all' },
    'editor@x.com': { role: 'editor', tables: ['tasks'] },
    'viewer@x.com': { role: 'viewer', tables: [] }
  });
});

const viewer = testEnv.authenticatedContext('viewer-uid', { email: 'viewer@x.com' }).firestore();
const editor = testEnv.authenticatedContext('editor-uid', { email: 'editor@x.com' }).firestore();
const admin = testEnv.authenticatedContext('admin-uid', { email: 'admin@x.com' }).firestore();

let passed = 0;
const ok = async (label, p) => { await p; console.log('  ✓', label); passed++; };

// --- The escalation: a viewer owner-stamps a system doc. Each must be DENIED. ---
// Before the fix, base('_users') was true and the owner-create branch granted these.
await ok('viewer CANNOT mint an admin _users doc',
  assertFails(setDoc(doc(viewer, '_users/evil@x.com'), { owner: 'viewer@x.com', role: 'admin', tables: 'all' })));
await ok('viewer CANNOT forge a _profiles doc for someone else',
  assertFails(setDoc(doc(viewer, '_profiles/victim@x.com'), { owner: 'viewer@x.com', name: 'Spoofed', shared: true })));
await ok('viewer CANNOT forge an _access_requests doc for someone else',
  assertFails(setDoc(doc(viewer, '_access_requests/victim@x.com'), { owner: 'viewer@x.com', name: 'x' })));
// A viewer can't reach their OWN _users doc either (self-service create is data-only, not privilege docs).
await ok('viewer CANNOT create their own _users doc',
  assertFails(setDoc(doc(viewer, '_users/viewer@x.com'), { owner: 'viewer@x.com', role: 'admin', tables: 'all' })));

// --- Regression: the legitimate owner-create the catch-all exists for still works. ---
await ok('viewer CAN create their own owner-stamped data row (rsvp/self-service pattern)',
  assertSucceeds(setDoc(doc(viewer, 'signups__active/r1'), { id: 'r1', owner: 'viewer@x.com', status: 'coming' })));
await ok('viewer CANNOT create a data row owned by someone else',
  assertFails(setDoc(doc(viewer, 'signups__active/r2'), { id: 'r2', owner: 'other@x.com', status: 'coming' })));
// _pages is a genuine data store written through putRow('_pages', …) -> _pages__active, so it must stay
// reachable via the catch-all despite its leading underscore (the exact case the fix carves out).
await ok('admin CAN still write a _pages__active doc (doc-view body store)',
  assertSucceeds(setDoc(doc(admin, '_pages__active/home'), { id: 'home', markdown: '# Home' })));

// --- Self-service is bounded to owner-column tables (via _meta/ownerTables). ---
// The checks above ran with no ownerTables doc -> permissive fallback (owner-create allowed anywhere),
// which is the pre-migration behaviour. Now publish the set and assert enforcement.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/ownerTables'), { tables: ['rsvps'] });   // saveSchema derives this
});
await ok('viewer CAN create their own row in a self-service (owner-column) table',
  assertSucceeds(setDoc(doc(viewer, 'rsvps__active/mine'), { id: 'mine', owner: 'viewer@x.com', status: 'coming' })));
await ok('viewer CANNOT owner-inject into a non-self-service table (the #3 fix)',
  assertFails(setDoc(doc(viewer, 'tasks__active/spam'), { id: 'spam', owner: 'viewer@x.com', title: 'junk' })));
// --- _profiles shape validation (display names feed user-backed lists / roster). ---
await ok('user CAN write a well-formed profile',
  assertSucceeds(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: true })));
await ok('name-only profile is allowed (setProfileName merge shape)',
  assertSucceeds(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic2' })));
await ok('oversized name is denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'x'.repeat(101), shared: true })));
await ok('non-string name is denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: { a: 1 }, shared: true })));
await ok('non-bool shared is denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: 'yes' })));
await ok('extra fields are denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: true, role: 'admin' })));
await ok('profile with a picture data-URL is allowed',
  assertSucceeds(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: true, picture: 'data:image/jpeg;base64,abc' })));
await ok('non-string picture is denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: true, picture: 123 })));
await ok('oversized picture is denied',
  assertFails(setDoc(doc(viewer, '_profiles/viewer@x.com'), { name: 'Vic', shared: true, picture: 'x'.repeat(350001) })));

// --- _pages (doc-view bodies): readable by every registered user, writable by editors/admins. ---
// (Restricted members previously hit the data catch-all's hasTableAccess('_pages') gate, which no
// grant ever satisfies, and silently saw the stale schema-seeded markdown.)
await ok('viewer (no grants) CAN read a _pages__active doc',
  assertSucceeds(getDoc(doc(viewer, '_pages__active/home'))));
await ok('viewer CANNOT write a _pages__active doc',
  assertFails(setDoc(doc(viewer, '_pages__active/home'), { id: 'home', markdown: 'defaced' })));
await ok('editor CAN write a _pages__active doc',
  assertSucceeds(setDoc(doc(editor, '_pages__active/home'), { id: 'home', markdown: '# Edited' })));

// --- Per-page access: a doc-view with `access:[tables]` (mirrored to _meta/pageAccess by saveSchema)
// is readable only by users granted a listed table (admins/unrestricted always). editor grants 'tasks';
// viewer grants nothing. Seed pageAccess + two restricted pages + an untagged one. ---
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/pageAccess'), { staff_handbook: ['tasks'], board_notes: ['finance'] });
  await setDoc(doc(ctx.firestore(), '_pages__active/staff_handbook'), { id: 'staff_handbook', markdown: 'staff only' });
  await setDoc(doc(ctx.firestore(), '_pages__active/board_notes'), { id: 'board_notes', markdown: 'board only' });
  await setDoc(doc(ctx.firestore(), '_pages__active/open_notice'), { id: 'open_notice', markdown: 'everyone' });
});
await ok('untagged page stays readable by any registered user (viewer, no grants)',
  assertSucceeds(getDoc(doc(viewer, '_pages__active/open_notice'))));
await ok('editor (grants tasks) CAN read a page gated on tasks',
  assertSucceeds(getDoc(doc(editor, '_pages__active/staff_handbook'))));
await ok('viewer (no grants) CANNOT read a page gated on tasks',
  assertFails(getDoc(doc(viewer, '_pages__active/staff_handbook'))));
await ok('editor (grants tasks, not finance) CANNOT read a page gated on finance',
  assertFails(getDoc(doc(editor, '_pages__active/board_notes'))));
await ok('admin reads a restricted page regardless of grants',
  assertSucceeds(getDoc(doc(admin, '_pages__active/board_notes'))));

// --- Owner-scoped update/delete are bounded to self-service (owner-column) tables, like create. ---
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), 'tasks__active/stray'), { id: 'stray', owner: 'viewer@x.com', title: 'x' });
});
await ok('owner CAN update their own row in a self-service table',
  assertSucceeds(setDoc(doc(viewer, 'rsvps__active/mine'), { id: 'mine', owner: 'viewer@x.com', status: 'out' })));
await ok('owner CANNOT update an owner-stamped row in a non-self-service table',
  assertFails(setDoc(doc(viewer, 'tasks__active/stray'), { id: 'stray', owner: 'viewer@x.com', title: 'y' })));
await ok('owner CAN delete their own row in a self-service table',
  assertSucceeds(deleteDoc(doc(viewer, 'rsvps__active/mine'))));
await ok('owner CANNOT delete an owner-stamped row in a non-self-service table',
  assertFails(deleteDoc(doc(viewer, 'tasks__active/stray'))));

// --- _access_requests shape validation (self-create only; these render in the admin approval UI). ---
const stranger = testEnv.authenticatedContext('s-uid', { email: 'stranger@x.com' }).firestore();
await ok('well-formed access request is allowed',
  assertSucceeds(setDoc(doc(stranger, '_access_requests/stranger@x.com'), { email: 'stranger@x.com', name: 'Sam', note: 'hi', ts: Date.now() })));
await ok('oversized request note is denied',
  assertFails(setDoc(doc(stranger, '_access_requests/stranger@x.com'), { email: 'stranger@x.com', name: 'Sam', note: 'x'.repeat(501), ts: Date.now() })));
await ok('request with extra fields is denied',
  assertFails(setDoc(doc(stranger, '_access_requests/stranger@x.com'), { email: 'stranger@x.com', name: 'Sam', note: '', ts: 1, role: 'admin' })));
await ok('request with mismatched email is denied',
  assertFails(setDoc(doc(stranger, '_access_requests/stranger@x.com'), { email: 'other@x.com', name: 'Sam', note: '', ts: 1 })));

// --- _meta hardening. ---
// The bootstrap probe is exists(_meta/users): if that doc could be deleted while /_users docs exist,
// noUsers() would flip true and every signed-in account would be admin. Not even an admin deletes it.
await ok('admin CANNOT delete _meta/users (bootstrap probe)',
  assertFails(deleteDoc(doc(admin, '_meta/users'))));
await setDoc(doc(admin, '_meta/lang_xx'), { 'app.title': 'X' });   // other _meta docs stay admin-deletable
await ok('admin CAN delete another _meta doc (deleteLanguage path)',
  assertSucceeds(deleteDoc(doc(admin, '_meta/lang_xx'))));
// Per-list storage moved to /_lists; the old editor branch on the legacy _meta/lists doc only allowed
// clobbering lists outside their table grants. Editors write /_lists (gated per list), never _meta.
await ok('editor CANNOT write the legacy _meta/lists doc',
  assertFails(setDoc(doc(editor, '_meta/lists'), { mylist: ['a'] })));

await testEnv.cleanup();
console.log(`\nFIRESTORE RULES OK — ${passed} checks passed`);
