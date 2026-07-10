// Verifies storage.rules + the image-upload flow (backend-firebase uploadFile) against the Firebase
// Storage EMULATOR. Run via: firebase emulators:exec --only storage --project demo-image \
//   "node dev/test-emulator/storage-rules.mjs"   (see `npm run test:storage-rules`).
//
// Mirrors uploadFile: authed user writes uploads/<lowercased-email>/<ts>_<name> (image/*), then reads a
// download URL. Also asserts the rules DENY cross-user writes, non-image types, and unauthenticated reads.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, getDownloadURL } from 'firebase/storage';

const rulesPath = fileURLToPath(new URL('../../storage.rules', import.meta.url));
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-image',
  storage: { rules: readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 9199 }
});

// Two signed-in users (note mixed-case email -> the rule lowercases it) + an anonymous visitor.
const alice = testEnv.authenticatedContext('alice-uid', { email: 'Alice@Example.com' });
const bob = testEnv.authenticatedContext('bob-uid', { email: 'bob@example.com' });
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

// 3. Non-image content type is rejected even in your own folder.
await ok('non-image upload is denied', assertFails(
  uploadBytes(ref(alice.storage(), 'uploads/alice@example.com/2_note.txt'), gif, { contentType: 'text/plain' })));

// 4. Reads: any signed-in user may read; an unauthenticated visitor may not.
await ok('signed-in user can read', assertSucceeds(getBytes(ref(bob.storage(), alicePath))));
await ok('unauthenticated read is denied', assertFails(getBytes(ref(anon.storage(), alicePath))));

await testEnv.cleanup();
console.log(`\nSTORAGE RULES OK — ${passed} checks passed`);
