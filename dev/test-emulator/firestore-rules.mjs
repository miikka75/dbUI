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
import { doc, setDoc } from 'firebase/firestore';

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
    'viewer@x.com': { role: 'viewer', tables: [] }
  });
});

const viewer = testEnv.authenticatedContext('viewer-uid', { email: 'viewer@x.com' }).firestore();
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

await testEnv.cleanup();
console.log(`\nFIRESTORE RULES OK — ${passed} checks passed`);
