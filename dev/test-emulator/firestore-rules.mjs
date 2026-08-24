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
import { doc, getDoc, setDoc, deleteDoc, collection, getDocs, query, where } from 'firebase/firestore';

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

// --- _assets (stored image bytes: view backgrounds / image cells as data URIs — the no-bucket tier).
// Readable by every registered user (decoration; the referencing row keeps its own gate), writable by
// editors/admins, and SHAPE-PINNED so the store can't become a general blob dump. Cap is 900000, matching
// supabase-schema.sql's app_valid_shape (rules-parity.test.js compares the two cap multisets). ---
const dataUri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
await ok('editor CAN write an _assets__active doc',
  assertSucceeds(setDoc(doc(editor, '_assets__active/bg_home'), { id: 'bg_home', src: dataUri })));
await ok('admin CAN write an _assets__active doc',
  assertSucceeds(setDoc(doc(admin, '_assets__active/bg_admin'), { id: 'bg_admin', src: dataUri })));
await ok('viewer (no grants) CAN read an _assets__active doc',
  assertSucceeds(getDoc(doc(viewer, '_assets__active/bg_home'))));
await ok('viewer CANNOT write an _assets__active doc',
  assertFails(setDoc(doc(viewer, '_assets__active/bg_home'), { id: 'bg_home', src: dataUri })));
await ok('an over-cap asset is REJECTED (the only bound on an upload here)',
  assertFails(setDoc(doc(editor, '_assets__active/bg_huge'), { id: 'bg_huge', src: 'd'.repeat(900001) })));
await ok('an asset just under the cap is accepted',
  assertSucceeds(setDoc(doc(editor, '_assets__active/bg_big'), { id: 'bg_big', src: 'd'.repeat(900000) })));
await ok('an extra key is REJECTED (shape is exactly { id, src })',
  assertFails(setDoc(doc(editor, '_assets__active/bg_extra'), { id: 'bg_extra', src: dataUri, script: '<script>' })));
await ok('a non-string src is REJECTED',
  assertFails(setDoc(doc(editor, '_assets__active/bg_num'), { id: 'bg_num', src: 42 })));
await ok('editor CAN delete an asset (delete carries no resource, so the shape test must not gate it)',
  assertSucceeds(deleteDoc(doc(editor, '_assets__active/bg_big'))));

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

// --- _list_users (Option C): a SHARED link is world-readable (its email is already public via _profiles);
// an UNSHARED link is admin-only; only admins write. Non-admins may query only `.where('shared','==',true)`. ---
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_list_users/people~Ann'),  { list: 'people', value: 'Ann',  email: 'ann@x.com',  shared: true });
  await setDoc(doc(ctx.firestore(), '_list_users/people~Cara'), { list: 'people', value: 'Cara', email: 'cara@x.com', shared: false });
});
await ok('admin CAN write a valid list-user link',
  assertSucceeds(setDoc(doc(admin, '_list_users/people~Bob'), { list: 'people', value: 'Bob', email: 'bob@x.com', shared: true })));
await ok('viewer CANNOT write a list-user link',
  assertFails(setDoc(doc(viewer, '_list_users/people~Evil'), { list: 'people', value: 'Evil', email: 'e@x.com', shared: true })));
await ok('list-user link with extra fields is denied',
  assertFails(setDoc(doc(admin, '_list_users/people~BadA'), { list: 'people', value: 'BadA', email: 'b@x.com', shared: true, role: 'admin' })));
await ok('list-user link with a non-bool shared is denied',
  assertFails(setDoc(doc(admin, '_list_users/people~BadB'), { list: 'people', value: 'BadB', email: 'b@x.com', shared: 'yes' })));
await ok('viewer CAN read a SHARED list-user link (email already public via _profiles)',
  assertSucceeds(getDoc(doc(viewer, '_list_users/people~Ann'))));
await ok('viewer CANNOT read an UNSHARED list-user link',
  assertFails(getDoc(doc(viewer, '_list_users/people~Cara'))));
await ok('admin CAN read an unshared list-user link',
  assertSucceeds(getDoc(doc(admin, '_list_users/people~Cara'))));
await ok('viewer CAN query ONLY the shared links (rules-provable)',
  assertSucceeds(getDocs(query(collection(viewer, '_list_users'), where('shared', '==', true)))));
await ok('viewer CANNOT list ALL links (unconstrained query denied)',
  assertFails(getDocs(collection(viewer, '_list_users'))));

// --- Per-table grant modes: `tables` may be 'all', a LEGACY name array (read+write on each), or a map
// { table: 'r' | 'rw' }. Reads use membership, which `in` satisfies for BOTH a list and a map — that is
// what lets old grants keep working unmigrated. Writes read the denormalized `rwTables` list, falling
// back to membership when it is absent (pre-split docs). Seeded as real /_users docs, which take
// precedence over the legacy _meta/users map. ---
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, '_users/mixed@x.com'), {
    role: 'editor', user: 'mixed@x.com',
    tables: { tasks: 'rw', refdata: 'r' }, rwTables: ['tasks']
  });
  // Same modes but with NO rwTables mirror — a doc written before the split. Must stay fully writable
  // rather than silently losing write access to tables it was granted.
  await setDoc(doc(db, '_users/premigration@x.com'), {
    role: 'editor', user: 'premigration@x.com', tables: { tasks: 'rw', refdata: 'r' }
  });
  await setDoc(doc(db, 'refdata__active/ref1'), { id: 'ref1', label: 'points' });
  await setDoc(doc(db, 'tasks__active/t1'), { id: 't1', title: 'a task' });
});
const mixed = testEnv.authenticatedContext('mixed-uid', { email: 'mixed@x.com' }).firestore();
const premig = testEnv.authenticatedContext('premig-uid', { email: 'premigration@x.com' }).firestore();

await ok("map grant: 'r' table is READABLE",
  assertSucceeds(getDoc(doc(mixed, 'refdata__active/ref1'))));
await ok("map grant: 'r' table CANNOT be updated",
  assertFails(setDoc(doc(mixed, 'refdata__active/ref1'), { id: 'ref1', label: 'tampered' })));
await ok("map grant: 'r' table CANNOT be created into",
  assertFails(setDoc(doc(mixed, 'refdata__active/ref2'), { id: 'ref2', label: 'new' })));

// The MAP-shaped grant, which is what the access UI actually writes (buildGrants returns a map) and the
// shape both these gates were split by type to support. Every case above uses `editor`, whose grant is a
// legacy LIST -- so the map branch of pageAllowed/listAllowed had no coverage at all, and a refactor of
// either could have removed it silently. `mixed` holds { tasks: 'rw', refdata: 'r' }.
await ok('map grant: CAN read a page gated on a table in the map',
  assertSucceeds(getDoc(doc(mixed, '_pages__active/staff_handbook'))));
await ok('map grant: CANNOT read a page gated on a table NOT in the map',
  assertFails(getDoc(doc(mixed, '_pages__active/board_notes'))));
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/listTables'), { crew: ['tasks'], ledger: ['finance'] });
  await setDoc(doc(ctx.firestore(), '_lists/crew'), { tables: ['tasks'], values: ['Ann'] });
  await setDoc(doc(ctx.firestore(), '_lists/ledger'), { tables: ['finance'], values: ['x'] });
});
await ok('map grant: CAN read a list owned by a table in the map',
  assertSucceeds(getDoc(doc(mixed, '_lists/crew'))));
await ok('map grant: CANNOT read a list owned by a table NOT in the map',
  assertFails(getDoc(doc(mixed, '_lists/ledger'))));

await ok("map grant: 'r' table CANNOT be deleted from",
  assertFails(deleteDoc(doc(mixed, 'refdata__active/ref1'))));
await ok("map grant: 'rw' table is readable AND writable",
  assertSucceeds(setDoc(doc(mixed, 'tasks__active/t1'), { id: 't1', title: 'edited' })));
await ok('map grant: an ungranted table stays unreadable',
  assertFails(getDoc(doc(mixed, 'secrets__active/s1'))));
await ok('legacy array grant still reads AND writes (no migration)',
  assertSucceeds(setDoc(doc(editor, 'tasks__active/t1'), { id: 't1', title: 'editor edit' })));
// The no-rwTables fallback covers grants written before the split — which are legacy LISTS, because the
// map shape arrived WITH rwTables. A map missing the mirror is therefore not a pre-split doc but a
// malformed one, and must not silently promote its 'r' entries to 'rw'.
await ok('a MAP grant with no rwTables mirror does NOT get write on an r table',
  assertFails(setDoc(doc(premig, 'refdata__active/ref1'), { id: 'ref1', label: 'still writable' })));
await ok('a LEGACY LIST grant with no rwTables mirror still writes (the real pre-split shape)',
  assertSucceeds(setDoc(doc(editor, 'tasks__active/t1'), { id: 't1', title: 'legacy write' })));

// Per-page access has to understand the SAME three grant shapes the table gates do. Every grant the
// access UI writes today is a map (buildGrants), so a page gate that only handles the legacy list
// locks map-grant users out of pages they hold a listed table for. `staff_handbook` is gated on
// ['tasks'] and `mixed` holds tasks:'rw'.
await ok('map grant: a page gated on a table I hold IS readable',
  assertSucceeds(getDoc(doc(mixed, '_pages__active/staff_handbook'))));
await ok('map grant: a page gated on a table I lack stays unreadable',
  assertFails(getDoc(doc(mixed, '_pages__active/board_notes'))));

// A read-only grant on an OWNER-column table is the chore-log shape: see every row, write only my own.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, '_meta/ownerTables'), { tables: ['rsvps', 'chore_log'] });
  await setDoc(doc(db, '_users/kid@x.com'), {
    role: 'editor', user: 'kid@x.com', tables: { chore_log: 'r' }, rwTables: []
  });
  await setDoc(doc(db, 'chore_log__active/sib'), { id: 'sib', owner: 'other@x.com', chore: 'dishes' });
});
const kid = testEnv.authenticatedContext('kid-uid', { email: 'kid@x.com' }).firestore();
await ok("read-only grant on an owner table: CAN read a sibling's row (shared leaderboard)",
  assertSucceeds(getDoc(doc(kid, 'chore_log__active/sib'))));
await ok('read-only grant on an owner table: CAN create my own owner-stamped row',
  assertSucceeds(setDoc(doc(kid, 'chore_log__active/mine'), { id: 'mine', owner: 'kid@x.com', chore: 'bins' })));
await ok("read-only grant on an owner table: CANNOT edit a sibling's row",
  assertFails(setDoc(doc(kid, 'chore_log__active/sib'), { id: 'sib', owner: 'other@x.com', chore: 'stolen' })));

// --- Self-service READS have to be expressible as a QUERY, not just a per-document get. Rules are not
// filters, so what matters is which constraints make the read rule provable — this is the contract the
// Firestore backend's scoped read is written against (backend-firebase _scopedRead). A member with NO
// grant at all is the sign-up/RSVP case. ---
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'rsvps__active/v-own'),    { id: 'v-own',    owner: 'viewer@x.com', rosterPublic: true,  s: 'coming' });
  await setDoc(doc(db, 'rsvps__active/pub'),      { id: 'pub',      owner: 'ann@x.com',    rosterPublic: true,  s: 'out' });
  await setDoc(doc(db, 'rsvps__active/priv'),     { id: 'priv',     owner: 'ann@x.com',    rosterPublic: false, s: 'maybe' });
});
await ok('grantless member: an UNCONSTRAINED collection read is still denied (rules are not filters)',
  assertFails(getDocs(collection(viewer, 'rsvps__active'))));
await ok('grantless member: an owner-scoped query IS allowed',
  assertSucceeds(getDocs(query(collection(viewer, 'rsvps__active'), where('owner', '==', 'viewer@x.com')))));
await ok('grantless member: a rosterPublic query IS allowed (the shared-log read)',
  assertSucceeds(getDocs(query(collection(viewer, 'rsvps__active'), where('rosterPublic', '==', true)))));
await ok("grantless member: cannot query someone else's private rows",
  assertFails(getDocs(query(collection(viewer, 'rsvps__active'), where('owner', '==', 'ann@x.com')))));
await ok('grantless member: a private row stays unreadable per-document',
  assertFails(getDoc(doc(viewer, 'rsvps__active/priv'))));
await ok('a GRANTED user still reads the whole collection unconstrained',
  assertSucceeds(getDocs(collection(kid, 'chore_log__active'))));

// Lists follow the same split: sight of an owning table is not permission to edit its list.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_lists/refvalues'), { name: 'refvalues', items: ['a'], tables: ['refdata'] });
  await setDoc(doc(ctx.firestore(), '_lists/taskvalues'), { name: 'taskvalues', items: ['a'], tables: ['tasks'] });
  // Editing a list is admin-only unless the schema opens it (userWritableLists -> _meta/listWritable).
  // `lockedvalues` is owned by the SAME rw table as taskvalues but is not opened, which is what shows the
  // allowlist doing the work rather than the table grant alone.
  await setDoc(doc(ctx.firestore(), '_lists/lockedvalues'), { name: 'lockedvalues', items: ['a'], tables: ['tasks'] });
  await setDoc(doc(ctx.firestore(), '_meta/listWritable'), { lists: ['taskvalues', 'newtasklist'] });
});
await ok("a list the schema does not open is readable",
  assertSucceeds(getDoc(doc(mixed, '_lists/refvalues'))));
await ok("...but not writable",
  assertFails(setDoc(doc(mixed, '_lists/refvalues'), { name: 'refvalues', items: ['a', 'b'], tables: ['refdata'] })));
await ok("a list the schema OPENS is writable by a non-admin",
  assertSucceeds(setDoc(doc(mixed, '_lists/taskvalues'), { name: 'taskvalues', items: ['a', 'b'], tables: ['tasks'] })));
await ok("a list the schema does NOT open stays admin-only, whatever the table grant",
  assertFails(setDoc(doc(mixed, '_lists/lockedvalues'), { name: 'lockedvalues', items: ['a', 'b'], tables: ['tasks'] })));
await ok('...and an admin still edits that same list',
  assertSucceeds(setDoc(doc(admin, '_lists/lockedvalues'), { name: 'lockedvalues', items: ['a', 'b'], tables: ['tasks'] })));

// CREATE is a separate question from update: there is no stored doc, so the ownership label in the
// incoming write is an unverified CLAIM. The old `allow write` rule referenced resource.data on a
// create and denied editors outright by evaluation error — which broke putListItem adding the first
// value to an `allowNew` list, while the same editor on Supabase was allowed. Now the create is
// authorized from the _meta/listTables mirror (saveSchema -> listOwnershipMap) and the claim is pinned.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/listTables'), { newtasklist: ['tasks'], newreflist: ['refdata'] });
});
await ok('a non-admin CAN create an opened list (label pinned to the schema mirror)',
  assertSucceeds(setDoc(doc(mixed, '_lists/newtasklist'), { name: 'newtasklist', items: ['x'], tables: ['tasks'] })));
await ok("a non-admin CANNOT create a list the schema does not open",
  assertFails(setDoc(doc(mixed, '_lists/newreflist'), { name: 'newreflist', items: ['x'], tables: ['refdata'] })));
await ok('editor CANNOT mint a list under a self-chosen ownership label (the claim is pinned to the mirror)',
  assertFails(setDoc(doc(mixed, '_lists/newreflist'), { name: 'newreflist', items: ['x'], tables: ['tasks'] })));
await ok('editor CANNOT create a list the schema does not own at all',
  assertFails(setDoc(doc(mixed, '_lists/unknownlist'), { name: 'unknownlist', items: ['x'], tables: ['tasks'] })));
await ok('admin creates a list regardless of the mirror',
  assertSucceeds(setDoc(doc(admin, '_lists/adminlist'), { name: 'adminlist', items: [], tables: [] })));
await ok('editor still CANNOT delete a list (pruning is the full-view holder\'s call)',
  assertFails(deleteDoc(doc(mixed, '_lists/newtasklist'))));
await ok('admin CAN delete a list',
  assertSucceeds(deleteDoc(doc(admin, '_lists/adminlist'))));

// A member may read the link that names THEM — their own identity, and what lets `@me` resolve to a
// curated value on a userlink list. The equality query must be rules-provable, like the shared-only one.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_list_users/members~Vic'), { list: 'members', value: 'Vic', email: 'viewer@x.com', shared: false });
});
await ok('viewer CAN read the unshared link naming THEM',
  assertSucceeds(getDoc(doc(viewer, '_list_users/members~Vic'))));
await ok('viewer CAN query their own link by email (rules-provable)',
  assertSucceeds(getDocs(query(collection(viewer, '_list_users'), where('email', '==', 'viewer@x.com')))));
await ok("viewer still CANNOT read someone else's unshared link",
  assertFails(getDoc(doc(viewer, '_list_users/people~Cara'))));
await ok("viewer CANNOT query someone else's links",
  assertFails(getDocs(query(collection(viewer, '_list_users'), where('email', '==', 'cara@x.com')))));

// --- ownerWritable: bound an owner-scoped write to named COLUMNS -----------------------------------
// The owner branch is otherwise all-or-nothing, so on a table with an approval column a member could
// approve themselves. saveSchema mirrors { table: { cols, locked } }; `locked` carries each gated
// column's create-time default so a create can be checked with one map diff.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, '_meta/ownerTables'), { tables: ['rsvps', 'chore_log', 'claims'] });
  await setDoc(doc(db, '_meta/ownerWritable'), {
    chore_log: { cols: ['chore', 'done_on', 'note', 'person'], locked: { status: 'logged' } }
    // `claims` is deliberately absent -> unbounded, proving the feature is opt-in.
  });
  await setDoc(doc(db, 'chore_log__active/mine'), {
    id: 'mine', owner: 'viewer@x.com', person: 'Vic', chore: 'Hoover', done_on: '2026-08-01',
    note: '', status: 'logged', rosterPublic: true
  });
  await setDoc(doc(db, 'claims__active/free'), { id: 'free', owner: 'viewer@x.com', status: 'logged' });
});
const row = (over) => Object.assign({
  id: 'mine', owner: 'viewer@x.com', person: 'Vic', chore: 'Hoover', done_on: '2026-08-01',
  note: '', status: 'logged', rosterPublic: true
}, over);

await ok('owner CAN edit a listed column on their own row',
  assertSucceeds(setDoc(doc(viewer, 'chore_log__active/mine'), row({ note: 'took ages' }))));
await ok('owner CANNOT approve themselves (a gated column)',
  assertFails(setDoc(doc(viewer, 'chore_log__active/mine'), row({ status: 'approved' }))));
await ok('owner CANNOT sneak the gated column through alongside a legitimate edit',
  assertFails(setDoc(doc(viewer, 'chore_log__active/mine'), row({ note: 'x', status: 'approved' }))));
await ok('owner CAN create a row that starts at the gated default',
  assertSucceeds(setDoc(doc(viewer, 'chore_log__active/new1'),
    row({ id: 'new1', chore: 'Bins', status: 'logged' }))));
await ok('owner CANNOT create a row that is already approved',
  assertFails(setDoc(doc(viewer, 'chore_log__active/new2'),
    row({ id: 'new2', chore: 'Bins', status: 'approved' }))));
await ok('an ADMIN still approves it (the gate binds only the owner branch)',
  assertSucceeds(setDoc(doc(admin, 'chore_log__active/mine'), row({ status: 'approved' }))));
// An IDENTITY column may only carry the CALLER'S own value. It has to be owner-writable (a defaultFrom
// value is per-user, so `locked` cannot predict it), which left a member free to log the work as
// somebody else. The caller's value rides on the admin-write-only grant doc, which userData() already
// reads, because rules cannot QUERY for "the link naming me".
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_meta/ownerWritable'), {
    chore_log: { cols: ['person', 'chore', 'note'], locked: { status: 'logged' },
                 whileCol: '', whileVals: [], identityCol: 'person', identityList: 'members' }
  });
  await setDoc(doc(ctx.firestore(), '_users/kid@x.com'), {
    role: 'editor', user: 'kid@x.com', tables: { chore_log: 'r' }, rwTables: [], identity: { members: 'Kid' }
  });
});
await ok('owner CAN log a chore as THEMSELVES',
  assertSucceeds(setDoc(doc(kid, 'chore_log__active/ident1'),
    { id: 'ident1', owner: 'kid@x.com', person: 'Kid', chore: 'Wash up', note: '', status: 'logged' })));
await ok('owner CANNOT log a chore as somebody else',
  assertFails(setDoc(doc(kid, 'chore_log__active/ident2'),
    { id: 'ident2', owner: 'kid@x.com', person: 'Ann', chore: 'Wash up', note: '', status: 'logged' })));
await ok('owner CANNOT reassign their own row to somebody else',
  assertFails(setDoc(doc(kid, 'chore_log__active/ident1'),
    { id: 'ident1', owner: 'kid@x.com', person: 'Ann', chore: 'Wash up', note: '', status: 'logged' })));
await ok('...but may still edit a field that is not the identity',
  assertSucceeds(setDoc(doc(kid, 'chore_log__active/ident1'),
    { id: 'ident1', owner: 'kid@x.com', person: 'Kid', chore: 'Hoover', note: 'ok', status: 'logged' })));
// A grant written before this feature has no `identity` map -> migration grace, or every member would
// be locked out of logging until an admin re-saved every link.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_users/kid@x.com'), {
    role: 'editor', user: 'kid@x.com', tables: { chore_log: 'r' }, rwTables: []
  });
});
await ok('a grant with no identity mirror still writes (migration grace)',
  assertSucceeds(setDoc(doc(kid, 'chore_log__active/ident3'),
    { id: 'ident3', owner: 'kid@x.com', person: 'Ann', chore: 'Wash up', note: '', status: 'logged' })));

await ok('a table with no ownerWritable entry stays unbounded (opt-in)',
  assertSucceeds(setDoc(doc(viewer, 'claims__active/free'), { id: 'free', owner: 'viewer@x.com', status: 'approved' })));


// --- _status: the partition, as data ---------------------------------------------------------------
// A VOCABULARY, not a prohibition. An owner could already file their own row away under the store model
// -- archiving was a delete from one collection plus a create in the other, and both halves are
// permitted on a row you own -- so refusing the equivalent field write would REMOVE a capability
// (withdrawing your own signup) rather than harden anything. What is closed is that `_status` may only
// ever name a partition.
//
// Deliberately tested on `claims`, the table with NO ownerWritable entry: there the owner branch is
// all-or-nothing, so it is the one place a column-bounds solution would not have reached.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'claims__active/st_active'), { id: 'st_active', owner: 'viewer@x.com', status: 'logged' });
  await setDoc(doc(db, 'claims__active/st_theirs'), { id: 'st_theirs', owner: 'other@x.com', status: 'logged' });
  await setDoc(doc(db, '_users/keeper@x.com'),
    { role: 'editor', user: 'keeper@x.com', tables: { claims: 'rw' }, rwTables: ['claims'] });
});
const keeper = testEnv.authenticatedContext('keeper-uid', { email: 'keeper@x.com' }).firestore();

await ok('owner CAN create their own row with no _status',
  assertSucceeds(setDoc(doc(viewer, 'claims__active/st_new'),
    { id: 'st_new', owner: 'viewer@x.com', status: 'logged' })));
// An absent field IS active, so both spellings have to behave the same or the gate would depend on
// which one the client happened to send.
await ok('owner CAN create their own row saying _status: active explicitly',
  assertSucceeds(setDoc(doc(viewer, 'claims__active/st_new2'),
    { id: 'st_new2', owner: 'viewer@x.com', status: 'logged', _status: 'active' })));

await ok('owner CAN archive their own row — withdrawing a signup still works',
  assertSucceeds(setDoc(doc(viewer, 'claims__active/st_active'),
    { id: 'st_active', owner: 'viewer@x.com', status: 'logged', _status: 'archive' })));
await ok('owner CAN restore their own row',
  assertSucceeds(setDoc(doc(viewer, 'claims__active/st_active'),
    { id: 'st_active', owner: 'viewer@x.com', status: 'logged', _status: 'active' })));

// The door that IS closed: anything gating on _status later gets a closed set, not free text.
await ok('owner CANNOT invent a partition that is not one',
  assertFails(setDoc(doc(viewer, 'claims__active/st_active'),
    { id: 'st_active', owner: 'viewer@x.com', status: 'logged', _status: 'deleted' })));
await ok('...not on a create either',
  assertFails(setDoc(doc(viewer, 'claims__active/st_new3'),
    { id: 'st_new3', owner: 'viewer@x.com', status: 'logged', _status: 'hidden' })));

// Ownership still bounds the owner branch — it is the only route a grantless member has.
await ok('owner CANNOT set _status on a row that is not theirs',
  assertFails(setDoc(doc(viewer, 'claims__active/st_theirs'),
    { id: 'st_theirs', owner: 'other@x.com', status: 'logged', _status: 'archive' })));

await ok('an editor with table write CAN archive a row',
  assertSucceeds(setDoc(doc(keeper, 'claims__active/st_active'),
    { id: 'st_active', owner: 'viewer@x.com', status: 'logged', _status: 'archive' })));
await ok('an editor with table write CAN un-archive a row',
  assertSucceeds(setDoc(doc(keeper, 'claims__active/st_active'),
    { id: 'st_active', owner: 'viewer@x.com', status: 'logged', _status: 'active' })));

// --- stamped columns: a bound that binds the GRANT-HOLDER too --------------------------------------
// `ownerWritable` is inert for an editor holding a table grant, which is right for an approval column.
// A stamped column is the other shape: on a shared table everybody may edit, the record of WHO created
// a row is not a decision anyone gets to revise. So the cases that matter are the ones an `rw` grant
// would otherwise wave through.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  await setDoc(doc(db, '_meta/stamped'), { home_shopping: { col: 'added_by', list: 'members' } });
  // A grant-holder linked to the members value "Vic"...
  await setDoc(doc(db, '_users/viewer@x.com'), { role: 'editor', user: 'viewer@x.com',
    tables: { home_shopping: 'rw', plainlist: 'rw' }, rwTables: ['home_shopping', 'plainlist'],
    identity: { members: 'Vic' } });
  await setDoc(doc(db, 'home_shopping__active/milk'),
    { id: 'milk', item: 'Milk', shop_status: 'needed', added_by: 'Bob' });
  await setDoc(doc(db, 'plainlist__active/free'), { id: 'free', added_by: 'Bob' });
});
const shop = (over) => Object.assign({ id: 'milk', item: 'Milk', shop_status: 'needed', added_by: 'Bob' }, over);

await ok('a grant-holder CAN edit a row somebody else added (the sharing is the point)',
  assertSucceeds(setDoc(doc(viewer, 'home_shopping__active/milk'), shop({ shop_status: 'bought' }))));
await ok('...but CANNOT relabel who added it, even as themselves',
  assertFails(setDoc(doc(viewer, 'home_shopping__active/milk'), shop({ added_by: 'Vic' }))));
await ok('...nor hand it to a third party',
  assertFails(setDoc(doc(viewer, 'home_shopping__active/milk'), shop({ added_by: 'Cara' }))));
await ok('resending the SAME stamp is not a change',
  assertSucceeds(setDoc(doc(viewer, 'home_shopping__active/milk'), shop({ shop_status: 'needed', added_by: 'Bob' }))));
await ok('a create must carry the stamper’s OWN value',
  assertSucceeds(setDoc(doc(viewer, 'home_shopping__active/eggs'),
    shop({ id: 'eggs', item: 'Eggs', added_by: 'Vic' }))));
await ok('a create CANNOT be stamped as somebody else',
  assertFails(setDoc(doc(viewer, 'home_shopping__active/bread'),
    shop({ id: 'bread', item: 'Bread', added_by: 'Bob' }))));
await ok('an ADMIN can still correct a wrong stamp',
  assertSucceeds(setDoc(doc(admin, 'home_shopping__active/milk'), shop({ added_by: 'Cara' }))));
await ok('a table absent from the mirror is unbounded (opt-in)',
  assertSucceeds(setDoc(doc(viewer, 'plainlist__active/free'), { id: 'free', added_by: 'Whoever' })));

await testEnv.cleanup();
console.log(`\nFIRESTORE RULES OK — ${passed} checks passed`);
