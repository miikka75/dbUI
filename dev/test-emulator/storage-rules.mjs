// Verifies storage.rules + the image-upload flow (backend-firebase uploadFile) against the Firebase
// Storage EMULATOR. Run via: firebase emulators:exec --only storage,firestore --project demo-image \
//   "node dev/test-emulator/storage-rules.mjs"   (see `npm run test:storage-rules`).
// The Firestore emulator must run too: the write rule's registration gate is a cross-service
// firestore.exists()/get() lookup against /_users and the legacy _meta/users map.
//
// Mirrors uploadFile: authed user writes uploads/<lowercased-email>/<ts>_<name> (image/*), then reads a
// download URL. Also asserts the rules DENY unregistered writes, cross-user writes, non-image types,
// and unauthenticated reads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, getDownloadURL, listAll } from 'firebase/storage';
import { doc, setDoc } from 'firebase/firestore';

const rulesPath = fileURLToPath(new URL('../../storage.rules', import.meta.url));
// The Firestore side is a DATA FIXTURE for the cross-service lookup, so it gets a permissive read
// ruleset: in production, storage-rules firestore.get()/exists() calls are privileged (not subject to
// Firestore rules), but the emulator routes them through the REST API where a loaded deny-by-default
// ruleset would 403 them ("denied by policy: no rule matched") and fail-closed every registered write.
const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read: if true; } } }`;
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-image',
  storage: { rules: readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 9199 },
  firestore: { rules: OPEN_FIRESTORE_RULES, host: '127.0.0.1', port: 8080 }
});

// Registration state for the cross-service gate: alice via the per-user /_users doc, carol via the
// legacy _meta/users map fallback. bob is signed in but UNREGISTERED.
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  await setDoc(doc(ctx.firestore(), '_users/alice@example.com'), { role: 'editor', user: 'alice@example.com', tables: 'all' });
  await setDoc(doc(ctx.firestore(), '_meta/users'), {
    'carol@example.com': { role: 'viewer', tables: [] },
    'frank@example.com': { role: 'admin', tables: [] }        // a legacy-map ADMIN: full access by role
  });
  await setDoc(doc(ctx.firestore(), '_users/erin@example.com'), { role: 'editor', user: 'erin@example.com', tables: { tasks: 'rw' } });
});

// Signed-in users (note mixed-case email -> the rule lowercases it) + an anonymous visitor.
const alice = testEnv.authenticatedContext('alice-uid', { email: 'Alice@Example.com' });
const bob = testEnv.authenticatedContext('bob-uid', { email: 'bob@example.com' });
const carol = testEnv.authenticatedContext('carol-uid', { email: 'carol@example.com' });
const anon = testEnv.unauthenticatedContext();

const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
const imageMeta = { contentType: 'image/gif' };
const alicePath = 'uploads/alice@example.com/1720000000000_pic.gif'; // uploadFile's path shape (email lowercased)

let passed = 0;
const ok = async (label, p) => { await p; console.log('  ✓', label); passed++; };

// 1. Owner uploads an image to their own folder -> allowed, and round-trips (the uploadFile happy path).
await ok('owner uploads image to own folder', assertSucceeds(uploadBytes(ref(alice.storage(), alicePath), gif, imageMeta)));
const bytes = new Uint8Array(await getBytes(ref(alice.storage(), alicePath)));
assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0x47, 0x49, 0x46]); // GIF header survived the round-trip
const url = await getDownloadURL(ref(alice.storage(), alicePath));
assert.ok(/^http/.test(url), 'getDownloadURL returns a URL (this is what uploadFile stores on the row)');
console.log('  ✓', 'download URL resolves:', url.slice(0, 60) + '...'); passed++;

// 2. A different user may NOT write into someone else's folder.
await ok('cross-user write is denied', assertFails(uploadBytes(ref(bob.storage(), alicePath), gif, imageMeta)));

// 2b. Registration gate: a signed-in but UNREGISTERED Google account may not upload even to "their
// own" folder (otherwise anyone holding the public Firebase config gets free image hosting).
await ok('unregistered signed-in write is denied', assertFails(
  uploadBytes(ref(bob.storage(), 'uploads/bob@example.com/1_pic.gif'), gif, imageMeta)));
// 2c. Legacy-map registration (un-migrated user in _meta/users, no /_users doc) still passes the gate.
await ok('legacy _meta/users registration passes the gate', assertSucceeds(
  uploadBytes(ref(carol.storage(), 'uploads/carol@example.com/1_pic.gif'), gif, imageMeta)));

// 3. Non-image content type is rejected even in your own folder.
await ok('non-image upload is denied', assertFails(
  uploadBytes(ref(alice.storage(), 'uploads/alice@example.com/2_note.txt'), gif, { contentType: 'text/plain' })));

// 4. Reads: any signed-in user may read; an unauthenticated visitor may not.
await ok('signed-in user can read', assertSucceeds(getBytes(ref(bob.storage(), alicePath))));
await ok('unauthenticated read is denied', assertFails(getBytes(ref(anon.storage(), alicePath))));

// 5. Calendar feeds: feeds/<id>.ics, written and listed only by a FULL-access member (admin, or a grant
// of every table) -- the client's canPublishFeeds. Subscribers read through the download URL's token.
const erin = testEnv.authenticatedContext('erin-uid', { email: 'erin@example.com' });
const frank = testEnv.authenticatedContext('frank-uid', { email: 'frank@example.com' });
const ics = new TextEncoder().encode('BEGIN:VCALENDAR' + String.fromCharCode(13, 10) + 'END:VCALENDAR' + String.fromCharCode(13, 10));
const icsMeta = { contentType: 'text/calendar' };
const feedPath = 'feeds/0123456789abcdef0123456789abcdef.ics';
await ok('full-access member publishes a feed', assertSucceeds(uploadBytes(ref(alice.storage(), feedPath), ics, icsMeta)));
await ok('and overwrites it in place (republish, or blank to revoke)', assertSucceeds(uploadBytes(ref(alice.storage(), feedPath), ics, icsMeta)));
await ok('and reads its download URL back', assertSucceeds(getDownloadURL(ref(alice.storage(), feedPath))));
await ok('legacy-map admin publishes too', assertSucceeds(uploadBytes(ref(frank.storage(), 'feeds/frank1.ics'), ics, icsMeta)));
const listed = await listAll(ref(alice.storage(), 'feeds'));
assert.deepEqual(listed.items.map((r) => r.fullPath).sort(), [feedPath, 'feeds/frank1.ics'].sort());
console.log('  ✓', 'full-access member lists feeds/ (the orphan sweep)'); passed++;
await ok('a narrower grant may not publish', assertFails(uploadBytes(ref(erin.storage(), 'feeds/erin1.ics'), ics, icsMeta)));
await ok('a narrower grant may not list', assertFails(listAll(ref(erin.storage(), 'feeds'))));
await ok('a viewer may not overwrite a live feed', assertFails(uploadBytes(ref(carol.storage(), feedPath), ics, icsMeta)));
await ok('an unregistered account may not publish', assertFails(uploadBytes(ref(bob.storage(), 'feeds/bob1.ics'), ics, icsMeta)));
await ok('a feed must be a calendar', assertFails(uploadBytes(ref(alice.storage(), 'feeds/x1.ics'), gif, imageMeta)));
await ok('a feed path must be <id>.ics', assertFails(uploadBytes(ref(alice.storage(), 'feeds/x1.html'), ics, icsMeta)));
await ok('nothing nests under feeds/', assertFails(uploadBytes(ref(alice.storage(), 'feeds/a/b.ics'), ics, icsMeta)));
await ok('unauthenticated read of feeds/ is denied', assertFails(getBytes(ref(anon.storage(), feedPath))));

await testEnv.cleanup();
console.log(`\nSTORAGE RULES OK — ${passed} checks passed`);
