#!/usr/bin/env node
// build-site.js — copy what the site serves into _site/, and nothing else. Both publish paths (the Pages
// workflow and Firebase Hosting's predeploy) upload that folder, so a file is public only if it is listed
// here: a new file in the repo root stays private until someone adds it.
//
//   node scripts/build-site.js [--with-config] [--root <dir>] [--out <dir>]
// --with-config adds firebase-config.json / supabase-config.json, so visitors connect without setup.
const fs = require('fs');
const path = require('path');

// Patterns relative to the repo root. `*` stays inside one folder, `**` crosses folders. Scripts are not
// listed: the ones published are the ones index.html names (scriptsOf).
const SITE = [
  'index.html', 'ui.html', 'style.html', 'manifest.json', 'favicon.svg', 'icon-512.png',
  'firestore.rules', 'supabase-schema.sql', 'schema.schema.json',
  'examples/*.json', 'examples/*.svg', 'examples/*.png',
  'vendor/**'
];
const CONFIG = ['firebase-config.json', 'supabase-config.json'];

const toRe = (p) => new RegExp('^' + p.split('**').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('.*') + '$');
const RES = SITE.map(toRe), CONFIG_RES = CONFIG.map(toRe);

// The root scripts index.html loads, by name ('/app-core.js', './sw.js').
function scriptsOf(indexHtml) {
  return new Set([...indexHtml.matchAll(/'\.?\/([\w.-]+\.js)'/g)].map((m) => m[1]));
}

// rel uses forward slashes. Dot files and dot folders are never published.
function isPublished(rel, opts) {
  if (rel.split('/').some((seg) => seg.charAt(0) === '.')) return false;
  if (/^[^/]+\.js$/.test(rel)) return !!(opts && opts.scripts && opts.scripts.has(rel));
  return RES.some((re) => re.test(rel)) || (!!(opts && opts.withConfig) && CONFIG_RES.some((re) => re.test(rel)));
}

function walk(root, dir, out) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name.charAt(0) === '.' || e.name === 'node_modules' || e.name === '_site') continue;
    const rel = dir ? dir + '/' + e.name : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function build(root, outDir, opts) {
  opts = Object.assign({ scripts: scriptsOf(fs.readFileSync(path.join(root, 'index.html'), 'utf8')) }, opts);
  fs.rmSync(outDir, { recursive: true, force: true });
  const files = walk(root, '', []).filter((rel) => isPublished(rel, opts));
  for (const rel of files) {
    const to = path.join(outDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, ...rel.split('/')), to);
  }
  return files;
}

module.exports = { SITE, CONFIG, scriptsOf, isPublished, build };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
  const out = path.resolve(arg('--out') || path.join(root, '_site'));
  const files = build(root, out, { withConfig: process.argv.includes('--with-config') });
  if (!files.includes('index.html')) { console.error('build-site: no index.html under ' + root); process.exit(1); }
  console.log('✓ _site — ' + files.length + ' files');
}
