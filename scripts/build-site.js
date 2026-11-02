#!/usr/bin/env node
// build-site.js — copy what the site serves into _site/, and nothing else. Both publish paths (the Pages
// workflow and Firebase Hosting's predeploy) upload that folder, so a file is public only if it is listed
// here: a new file in the repo root stays private until someone adds it.
//
//   node scripts/build-site.js [--with-config] [--compile] [--minify] [--root <dir>] [--out <dir>]
// --with-config adds firebase-config.json / supabase-config.json, so visitors connect without setup.
// --minify runs the app's own scripts through esbuild (vendor/ is already minified; index.html is not
// touched, so the CSP hashes of its inline scripts still hold). Top-level names survive: the modules
// are classic scripts that share them as globals.
// --compile precompiles the Vue templates and drops 'unsafe-eval' from the page's policy.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ESBUILD = 'esbuild@0.28.2';

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
  if (opts.compile) compileTemplates(root, outDir);
  if (opts.minify) minify(outDir, files.filter((rel) => /^[^/]+\.js$/.test(rel) && rel !== 'sw.js'));
  if (files.includes('sw.js')) writeServiceWorker(outDir, files);
  return files;
}

// What the service worker precaches: what every boot loads, whichever backend. The rest is cached on
// first use (a backend's files, examples, the PGlite dist).
const VENDOR_SHELL = ['vendor/vue.js', 'vendor/vuetify.js', 'vendor/vuetify.css', 'vendor/mdi.css',
  'vendor/fonts/materialdesignicons-webfont.woff2'];
function shellOf(files) {
  return files.filter((f) => /^[^/]+\.(html|js|json|svg|png)$/.test(f) && f !== 'sw.js' && f !== 'schema.schema.json'
    && !CONFIG.includes(f) && !/^(backend-(?!helpers\.js)|storage-)/.test(f)).concat(VENDOR_SHELL.filter((f) => files.includes(f)));
}

// The published sw.js gets the two cache revisions and the shell; the source copy keeps its placeholders.
function writeServiceWorker(outDir, files) {
  const rev = (list) => {
    const h = crypto.createHash('sha256');
    for (const f of list.slice().sort()) h.update(f + '\0').update(fs.readFileSync(path.join(outDir, ...f.split('/'))));
    return h.digest('hex').slice(0, 12);
  };
  const vendor = files.filter((f) => f.startsWith('vendor/'));
  const app = files.filter((f) => !f.startsWith('vendor/') && f !== 'sw.js');
  const file = path.join(outDir, 'sw.js');
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace("'__APP_REV__'", JSON.stringify(rev(app))).replace("'__VENDOR_REV__'", JSON.stringify(rev(vendor)))
    .replace("'__SHELL__'", JSON.stringify(shellOf(files)));
  if (out === src || /'__(APP_REV|VENDOR_REV|SHELL)__'/.test(out)) throw new Error('build-site: sw.js placeholders not found');
  fs.writeFileSync(file, out);
}

// The templates go into app-core.js as render functions, and the page's policy loses 'unsafe-eval'
// (only Vue's in-browser compiler needed it). The policy is a <meta> outside any inline script, so the
// script hashes it lists still match.
function compileTemplates(root, outDir) {
  const { compileAll } = require('./compile-templates');
  fs.appendFileSync(path.join(outDir, 'app-core.js'), compileAll(root).js);
  // ui.html is the root and the <template id> blocks, all compiled now: only the mount point is left.
  fs.writeFileSync(path.join(outDir, 'ui.html'), '<div id="vue-app" v-cloak></div>\n');
  const page = path.join(outDir, 'index.html');
  const html = fs.readFileSync(page, 'utf8');
  const out = html.replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*)'unsafe-eval' /, '$1');
  if (out === html) throw new Error("build-site: the page's policy has no 'unsafe-eval' to drop");
  fs.writeFileSync(page, out);
}

// In place, with a linked source map beside each file (the source is public anyway).
function minify(outDir, scripts) {
  if (!scripts.length) return;
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  execFileSync(npx, ['--yes', ESBUILD].concat(scripts, ['--minify', '--target=es2020', '--sourcemap',
    '--outdir=.', '--allow-overwrite', '--log-level=warning']), { cwd: outDir, stdio: 'inherit', shell: process.platform === 'win32' });
}

module.exports = { SITE, CONFIG, scriptsOf, isPublished, shellOf, build };

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
  const out = path.resolve(arg('--out') || path.join(root, '_site'));
  const files = build(root, out, { withConfig: process.argv.includes('--with-config'), minify: process.argv.includes('--minify'), compile: process.argv.includes('--compile') });
  if (!files.includes('index.html')) { console.error('build-site: no index.html under ' + root); process.exit(1); }
  console.log('✓ _site — ' + files.length + ' files');
}
