#!/usr/bin/env node
// examples-manifest.js — (re)generate examples/index.json, the machine-readable index of the shipped
// example bundles.
//
//   node scripts/examples-manifest.js           write examples/index.json
//   node scripts/examples-manifest.js --check   exit non-zero if it is stale (what CI does)
//
// The app fetches this file (same origin — examples/ ships on both publish paths) to populate the
// example picker, and compares its per-file hashes against the ones recorded when a bundle was
// installed, which is how a deployment notices its examples have moved on.
//
// EVERYTHING a schema can state about itself is derived, so adding an example is adding files:
//
//   <id>-schema.json        the structure          -> a bundle called <id>
//   <id>-lang-<code>.json   labels for <id>        -> one entry in its `languages`
//   <id>-data.json          optional sample rows   -> its `data`
//   <id>-about.json         PROSE a schema cannot  -> its `description` and `notes`
//   app-lang-<code>.json    the app's own UI       -> the top-level `appLanguages`
//
// `title` comes from the bundle's own `app.title` translation and `icon` from its `schema.icons`, so
// neither can drift from what installing it actually produces. `revision` is a human-facing counter:
// it goes up by one whenever any of a bundle's files changes, which is why this reads the previous
// manifest instead of computing from scratch.
//
// --- Writing a release note -------------------------------------------------------------------------
// `<id>-about.json` holds the two things a schema cannot say: what it is FOR, and what each revision
// brought. Settings shows the notes for the range a deployment is behind by, so an admin reads what a
// reinstall will bring before accepting one that replaces their schema and labels.
//
// It is deliberately OUTSIDE `sameFiles` below, so writing a note does not bump the revision it
// describes. That is what makes this authoring order work:
//
//   1. edit the schema / lang files
//   2. run this script      -> revision becomes N
//   3. add "N": "..." to <id>-about.json
//   4. run this script      -> revision STAYS N, and the note is now in the manifest
//
// Had the notes lived in a language pack they would be part of that hash, so every wording fix would
// move the revision off the key it was written for -- and the note would only reach a database through
// the reinstall it was meant to explain.
'use strict';
const fs = require('fs');
const path = require('path');
const Examples = require('../examples');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'examples');
const OUT = path.join(DIR, 'index.json');

const read = (file) => fs.readFileSync(path.join(DIR, file), 'utf8');
const parse = (file) => JSON.parse(read(file));
const entry = (file) => ({ file: file, hash: Examples.hashText(read(file)) });

function build(previous) {
  const files = fs.readdirSync(DIR).filter((n) => n.endsWith('.json') && n !== 'index.json').sort();
  const appLanguages = [];
  const byId = new Map();

  for (const file of files) {
    const app = /^app-lang-([a-z-]+)\.json$/.exec(file);
    if (app) { appLanguages.push(Object.assign({ code: app[1], name: langName(file, app[1]) }, entry(file))); continue; }

    const schema = /^(.+)-schema\.json$/.exec(file);
    const lang = /^(.+)-lang-([a-z-]+)\.json$/.exec(file);
    const data = /^(.+)-data\.json$/.exec(file);
    const about = /^(.+)-about\.json$/.exec(file);
    const id = (schema || lang || data || about || [])[1];
    if (!id) throw new Error('examples/' + file + ' fits none of the bundle filename patterns — '
      + 'name it <id>-schema.json, <id>-lang-<code>.json, <id>-data.json or <id>-about.json, '
      + 'or teach this script about it');

    const b = byId.get(id) || { id: id, languages: [] };
    if (schema) b.schema = entry(file);
    if (lang) b.languages.push(Object.assign({ code: lang[2], name: langName(file, lang[2]) }, entry(file)));
    if (data) b.data = entry(file);
    if (about) b.about = entry(file);
    byId.set(id, b);
  }

  const bundles = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((b) => {
    if (!b.schema) throw new Error('examples/: bundle "' + b.id + '" has labels or data but no ' + b.id + '-schema.json');
    b.languages.sort((x, y) => x.code.localeCompare(y.code));

    const doc = parse(b.schema.file);
    const s = doc.schema || doc;                       // bishopric-schema.json wraps its schema
    const en = b.languages.filter((l) => l.code === 'en')[0] || b.languages[0];
    const labels = en ? (parse(en.file).translations || {})[en.code] || {} : {};

    // The prose a schema cannot state about itself. Required: without it the picker has nothing to say
    // about the bundle, and that used to be enforced only by a test on the generated file.
    if (!b.about) throw new Error('examples/: bundle "' + b.id + '" has no ' + b.id + '-about.json — it '
      + 'carries the one-line `description` the picker shows and the per-revision `notes` Settings shows');
    const about = parse(b.about.file);
    if (typeof about.description !== 'string' || !about.description.trim()) {
      throw new Error('examples/' + b.about.file + ': `description` is required — it is the one line the picker shows');
    }

    const out = {
      id: b.id,
      title: labels['app.title'] || b.id,
      description: about.description,
      icon: (s.icons && s.icons.favicon) || null,
      revision: 1,
      tables: Object.keys(s.tables || {}).length,
      views: (s.views || []).length,
      schema: b.schema,
      languages: b.languages
    };
    if (b.data) out.data = b.data;
    out.about = b.about;

    // A revision is only meaningful against the last published one: same files, same number.
    const was = ((previous && previous.bundles) || []).filter((p) => p.id === b.id)[0];
    if (was) out.revision = sameFiles(was, out) ? (was.revision || 1) : (was.revision || 1) + 1;

    // Notes are validated against the revision they claim, not trusted. A key that is not a revision
    // number, or one ahead of where the bundle actually is, would simply never render -- the quietest
    // possible failure for the one field whose entire job is to be read.
    const notes = {};
    Object.keys(about.notes || {}).forEach((k) => {
      const where = 'examples/' + b.about.file + ': note "' + k + '"';
      if (!/^[1-9][0-9]*$/.test(k)) throw new Error(where + ' is not a revision number');
      if (Number(k) > out.revision) throw new Error(where + ' describes a revision ' + b.id + ' has not '
        + 'reached (it is at ' + out.revision + ') — write the note after the run that bumps the revision');
      if (typeof about.notes[k] !== 'string' || !about.notes[k].trim()) throw new Error(where + ' is empty');
      notes[k] = about.notes[k];
    });
    if (Object.keys(notes).length) out.notes = notes;
    return out;
  });

  return {
    '//': 'Generated by scripts/examples-manifest.js — do not edit by hand.',
    appLanguages: appLanguages.sort((a, b) => a.code.localeCompare(b.code)),
    bundles: bundles
  };
}

// A language pack names its own language; the manifest must not invent a second name for it.
function langName(file, code) {
  const declared = (parse(file).languages || []).filter((l) => l && l.code === code)[0];
  return (declared && declared.name) || code;
}

function sameFiles(was, now) {
  const flat = (b) => JSON.stringify([b.schema, b.data || null].concat(b.languages)
    .map((f) => (f ? f.file + ':' + f.hash : null)));
  return flat(was) === flat(now);
}

const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
const text = JSON.stringify(build(previous), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== text) {
    console.error('examples/index.json is stale — run: node scripts/examples-manifest.js');
    process.exit(1);
  }
  console.log('examples/index.json is current.');
} else {
  fs.writeFileSync(OUT, text);
  console.log('Wrote examples/index.json (' + JSON.parse(text).bundles.length + ' bundles).');
}
