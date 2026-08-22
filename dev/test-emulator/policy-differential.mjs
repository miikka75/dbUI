// policy-differential.mjs — the SAME access matrix run through BOTH production policy engines.
//
//   firestore.rules      -> the Firestore emulator
//   supabase-schema.sql  -> PostgreSQL-in-WASM (PGlite)
//
// This is the test the plan calls for and rules-parity.test.js only approximates. That one compares the
// SOURCE TEXT of the two policy layers, hunting for constants that drifted; it cannot see a rule that
// says the same thing and MEANS something different, which is most of what actually goes wrong -- the
// two divergences found so far were both of that kind.
//
// DIRECTIONAL, not identical. Firestore is the mirror and Postgres the reference, so the rule is:
//
//     Firestore may be STRICTER than Postgres. It may never be LOOSER.
//
// Demanding identical verdicts would block every Supabase feature on Firestore's expressiveness.
// Demanding fail-closed drift keeps the security property while letting the mirror lag -- and every
// place it lags is named below rather than discovered later.
//
// Run via: npm run test:differential   (wraps this in the Firestore emulator)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const require = createRequire(import.meta.url);
const { createPgliteStorage } = require('../storage-pglite.js');

// --- the world both engines are given -------------------------------------------------------------
const ACTORS = {
  'admin@x.com':  { role: 'admin',  tables: 'all' },
  'editor@x.com': { role: 'editor', tables: ['tasks'] },
  'viewer@x.com': { role: 'viewer', tables: [] }
};

const SCHEMA = {
  tables: {
    tasks:   { columns: { id: { type: 'text' }, title: { type: 'text' } } },
    notes:   { columns: { id: { type: 'text' }, body: { type: 'text' } } },
    signups: {
      ownerWritable: ['status'],
      columns: { id: { type: 'text' }, owner: { type: 'owner' }, status: { type: 'text' }, organizerNote: { type: 'text' } }
    }
  },
  views: []
};

// [actor, store, key, op, payload|null, expected]
// `expected` is what the REFERENCE (Postgres) should say. Firestore is then checked against the
// directional rule rather than against this directly.
const MATRIX = [
  ['admin@x.com',  'tasks__active',   'r1', 'read',  null,                                            'allow'],
  ['admin@x.com',  'tasks__active',   'w1', 'write', { id: 'w1', title: 'x' },                        'allow'],
  ['admin@x.com',  'notes__active',   'w2', 'write', { id: 'w2', body: 'x' },                         'allow'],
  ['editor@x.com', 'tasks__active',   'r1', 'read',  null,                                            'allow'],
  ['editor@x.com', 'tasks__active',   'w3', 'write', { id: 'w3', title: 'x' },                        'allow'],
  ['editor@x.com', 'notes__active',   'r2', 'read',  null,                                            'deny'],
  ['editor@x.com', 'notes__active',   'w4', 'write', { id: 'w4', body: 'x' },                         'deny'],
  ['viewer@x.com', 'tasks__active',   'r1', 'read',  null,                                            'deny'],
  ['viewer@x.com', 'tasks__active',   'w5', 'write', { id: 'w5', title: 'x' },                        'deny'],
  // The owner branch: a member with NO grant, acting on a self-service table.
  ['viewer@x.com', 'signups__active', 's1', 'write', { id: 's1', owner: 'viewer@x.com', status: 'y' }, 'allow'],
  ['viewer@x.com', 'signups__active', 's2', 'write', { id: 's2', owner: 'editor@x.com', status: 'y' }, 'deny'],
  ['viewer@x.com', 'signups__active', 's1', 'read',  null,                                            'allow'],
  // ownerWritable: the column bound holds even on a row they own.
  ['viewer@x.com', 'signups__active', 's1', 'write', { id: 's1', owner: 'viewer@x.com', organizerNote: 'no' }, 'deny']
];

// Places the mirror is knowingly stricter than the reference. Empty is the goal; an entry here is a
// product gap on the Firebase deployment, not a licence for the two to drift.
const KNOWN_STRICTER = [];

// --- Firestore -------------------------------------------------------------------------------------
const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-diff',
  firestore: { rules: readFileSync(rulesPath, 'utf8'), host: '127.0.0.1', port: 8080 }
});

const BackendHelpers = require('../../backend-helpers.js');
const ListAccess = require('../../list-access.js');

await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const db = ctx.firestore();
  const users = {};
  for (const [email, g] of Object.entries(ACTORS)) users[email] = { role: g.role, tables: g.tables };
  await setDoc(doc(db, '_meta/users'), users);
  // The schema-derived facts the schema-blind rules read -- the same set saveSchema mirrors.
  await setDoc(doc(db, '_meta/schema'), SCHEMA);
  await setDoc(doc(db, '_meta/ownerTables'), { tables: BackendHelpers.ownerTablesOf(SCHEMA) });
  await setDoc(doc(db, '_meta/ownerWritable'), BackendHelpers.ownerWritableOf(SCHEMA));
  await setDoc(doc(db, '_meta/pageAccess'), BackendHelpers.pageAccessOf(SCHEMA));
  await setDoc(doc(db, '_meta/listTables'), ListAccess.listOwnershipMap(SCHEMA.tables));
  await setDoc(doc(db, '_meta/listWritable'), BackendHelpers.userWritableListsOf(SCHEMA));
  // Rows the read cases look at.
  await setDoc(doc(db, 'tasks__active/r1'), { id: 'r1', title: 'seed' });
  await setDoc(doc(db, 'notes__active/r2'), { id: 'r2', body: 'seed' });
  await setDoc(doc(db, 'signups__active/s1'), { id: 's1', owner: 'viewer@x.com', status: 'y' });
});

const fsDb = {};
let uid = 0;
for (const email of Object.keys(ACTORS)) fsDb[email] = testEnv.authenticatedContext('u' + (uid++), { email }).firestore();

async function firestoreVerdict(email, store, key, op, payload) {
  const db = fsDb[email];
  try {
    if (op === 'read') { await getDoc(doc(db, store + '/' + key)); return 'allow'; }
    await setDoc(doc(db, store + '/' + key), payload, { merge: true });
    return 'allow';
  } catch (e) {
    // A rules refusal arrives as a FirebaseError whose CODE says so; the message is the rule-evaluation
    // trace and does not reliably contain the word. Matching on the message alone let real denials
    // escape as uncaught errors.
    if (e.code === 'permission-denied' || /permission|insufficient/i.test(e.message || '')) return 'deny';
    throw e;
  }
}

// --- Postgres --------------------------------------------------------------------------------------
const S = await createPgliteStorage();
S.setCaller('admin@x.com');
// Bootstrap (no members yet) writes the schema and its mirrors, then the registry closes bootstrap.
await S.setMeta('schema', SCHEMA);
await S.setMeta('ownerTables', { tables: BackendHelpers.ownerTablesOf(SCHEMA) });
await S.setMeta('ownerWritable', BackendHelpers.ownerWritableOf(SCHEMA));
await S.setMeta('pageAccess', BackendHelpers.pageAccessOf(SCHEMA));
await S.setMeta('listTables', ListAccess.listOwnershipMap(SCHEMA.tables));
await S.setMeta('listWritable', BackendHelpers.userWritableListsOf(SCHEMA));
for (const [email, g] of Object.entries(ACTORS)) {
  const rec = { role: g.role, user: email, tables: g.tables };
  await S._seed('_users', email, rec);
}
await S._seed('tasks__active', 'r1', { id: 'r1', title: 'seed' });
await S._seed('notes__active', 'r2', { id: 'r2', body: 'seed' });
await S._seed('signups__active', 's1', { id: 's1', owner: 'viewer@x.com', status: 'y' });

async function postgresVerdict(email, store, key, op, payload) {
  S.setCaller(email);
  try {
    if (op === 'read') {
      const v = await S.get(store, key);
      return v === undefined ? 'deny' : 'allow';     // RLS filters a forbidden read to nothing
    }
    await S.put(store, key, payload);
    return 'allow';
  } catch (e) {
    if (/row-level security/.test(e.message || '')) return 'deny';
    throw e;
  }
}

// --- compare ---------------------------------------------------------------------------------------
let checks = 0;
const problems = [];
const label = (a, s, k, o) => `${o} ${s}/${k} as ${a.split('@')[0]}`;

for (const [actor, store, key, op, payload, expected] of MATRIX) {
  const pg = await postgresVerdict(actor, store, key, op, payload);
  const fs = await firestoreVerdict(actor, store, key, op, payload);
  const l = label(actor, store, key, op);
  checks++;

  if (pg !== expected) problems.push(`REFERENCE WRONG  ${l}: Postgres says ${pg}, intent is ${expected}`);

  if (pg === fs) { console.log(`  ✓ ${l}  both ${pg}`); continue; }
  if (pg === 'allow' && fs === 'deny') {
    const known = KNOWN_STRICTER.includes(l);
    console.log(`  ${known ? '~' : '✗'} ${l}  postgres allow / firestore deny${known ? '  (known)' : ''}`);
    if (!known) problems.push(`MIRROR STRICTER  ${l}: allowed by the policies, refused by the rules. ` +
      'Fail-closed, so not a hole -- but it is a feature the Firebase deployment does not have. ' +
      'Fix the rules, or add it to KNOWN_STRICTER on purpose.');
    continue;
  }
  // The one direction that is never acceptable.
  problems.push(`MIRROR LOOSER    ${l}: refused by the policies, ALLOWED by the rules. ` +
    'Firebase grants access Supabase does not.');
  console.log(`  ✗ ${l}  postgres deny / firestore ALLOW`);
}

await S.close();
await testEnv.cleanup();

console.log('');
if (problems.length) {
  console.error('POLICY DIFFERENTIAL FAILED\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`POLICY DIFFERENTIAL OK — ${checks} cases, both engines agree`);
