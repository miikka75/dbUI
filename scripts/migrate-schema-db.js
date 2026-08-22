// migrate-schema-db.js — copy the (default) Firestore database into a NAMED database, then optionally
// blank out (default) so its URL shows an empty page. For the "the church schema is really in (default),
// move it to its own database and leave (default) empty" migration.
//
// Uses the Admin SDK (bypasses security rules). Auth via a service account:
//   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json      (or: gcloud auth application-default login)
// Needs firebase-admin resolvable — either `npm i firebase-admin` here, or run from ./functions where it
// is already installed:  node ../scripts/migrate-schema-db.js ...
//
// DRY RUN by default (prints what it would do). Add --commit to actually write.
//
//   node scripts/migrate-schema-db.js --to church --project <projectId>                 # dry run: copy
//   node scripts/migrate-schema-db.js --to church --project <projectId> --commit         # copy (default)->church
//   node scripts/migrate-schema-db.js --to church --project <projectId> --commit --empty-default
//                                                                                        # ^ ALSO wipe+blank (default)
//
// This app uses only TOP-LEVEL collections (no subcollections), so a flat collection copy is complete.
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const args = process.argv.slice(2);
const has = (n) => args.includes('--' + n);
const val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };

const TO = val('to');
const COMMIT = has('commit');
const EMPTY_DEFAULT = has('empty-default');
const PROJECT = val('project') || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!TO) { console.error('Missing --to <databaseId> (e.g. --to church)'); process.exit(1); }

admin.initializeApp({ projectId: PROJECT });
const src = getFirestore();          // (default)
const dst = getFirestore(TO);        // named target (must already exist: gcloud firestore databases create --database=TO ...)

// The blank schema left in (default): empty tables + one markdown home page. `tables: {}` MUST be present
// or unwrapSchemaDoc() returns null and the app treats it as first-boot and re-seeds the bundled demo.
const EMPTY_SCHEMA = {
  tables: {},
  views: [{ name: 'home', markdown: '# \n\n_This space is intentionally left blank._' }],
  nav: { items: [{ view: 'home' }] }
};

async function forEachDoc(db, fn) {
  const cols = await db.listCollections();
  let total = 0;
  for (const col of cols) {
    const snap = await col.get();
    let batch = (fn.db || db).batch(), n = 0;
    for (const d of snap.docs) {
      fn(batch, col.id, d); total++; n++;
      if (n >= 400) { if (COMMIT) await batch.commit(); batch = (fn.db || db).batch(); n = 0; }
    }
    if (n && COMMIT) await batch.commit();
    console.log('  ' + col.id + ': ' + snap.size + ' docs');
  }
  return { collections: cols.length, docs: total };
}

async function copyAll() {
  console.log((COMMIT ? 'COPY' : 'DRY RUN copy') + '  (default) -> ' + TO);
  const write = (batch, colId, d) => batch.set(dst.collection(colId).doc(d.id), d.data());
  write.db = dst;
  const r = await forEachDoc(src, write);
  console.log('  = ' + r.docs + ' docs across ' + r.collections + ' collections' + (COMMIT ? '' : ' (nothing written)'));
}

async function emptyDefault() {
  console.log((COMMIT ? 'EMPTY' : 'DRY RUN empty') + '  (default)');
  const del = (batch, colId, d) => batch.delete(d.ref);
  del.db = src;
  await forEachDoc(src, del);
  if (COMMIT) {
    await src.doc('_meta/schema').set(EMPTY_SCHEMA);
    await src.doc('_meta/ownerTables').set({ tables: [] });   // keep the rules-mirror docs consistent
    await src.doc('_meta/pageAccess').set({});
    console.log('  seeded (default) _meta/schema with the empty schema');
  } else {
    console.log('  would seed (default) _meta/schema with the empty schema');
  }
}

(async () => {
  await copyAll();
  if (EMPTY_DEFAULT) await emptyDefault();
  console.log(COMMIT ? 'done.' : 'dry run complete — re-run with --commit to apply.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
