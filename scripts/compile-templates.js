#!/usr/bin/env node
// compile-templates.js — every Vue template the app registers, compiled ahead of time to render
// functions. The published page then needs no in-browser template compiler, which is the one thing the
// CSP's 'unsafe-eval' was for (csp.js). Development keeps compiling in the browser.
//
// The templates are taken as the app registers them, not by parsing source: app-core.js runs against a
// stub Vue that records each component, and ui.html goes through parse5, the HTML spec's parser, so a
// `#id` template is exactly the markup the browser would hand Vue (lowercased attributes, table rules).
// The compiler is the one matching the vendored Vue (vendor/versions), installed once into a cache dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const PARSE5 = 'parse5@7.3.0';

function deps(root) {
  const vue = (/^VUE=(.+)$/m.exec(fs.readFileSync(path.join(root, 'vendor', 'versions'), 'utf8')) || [])[1].trim();
  const dir = path.join(os.tmpdir(), 'dbui-compiler-' + vue);
  if (!fs.existsSync(path.join(dir, 'node_modules', '@vue', 'compiler-dom', 'package.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--silent', '--prefix', dir, '@vue/compiler-dom@' + vue, PARSE5],
      { stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const req = (m) => require(path.join(dir, 'node_modules', m));
  return { compiler: req('@vue/compiler-dom'), parse5: req('parse5') };
}

// Component name -> template string, for every app.component(...) with a template, plus the root.
function componentTemplates(root) {
  const registered = {};
  const noop = () => {};
  const stubApp = {
    use() { return stubApp; }, directive() { return stubApp; }, provide() { return stubApp; }, mixin() { return stubApp; },
    component(name, def) { if (def && typeof def.template === 'string') registered[name] = def.template; return stubApp; },
    mount() { return {}; }, config: { globalProperties: {} }
  };
  const sandbox = {
    Vue: { createApp: () => stubApp }, Vuetify: { createVuetify: () => ({}) },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    matchMedia: () => ({ matches: false, addEventListener: noop }), addEventListener: noop,
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Object, Array, JSON, Math, Date, String, Number, RegExp
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // What index.html loads before app-core, in its order: createVueApp reads those globals as it runs.
  const order = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8').matchAll(/'\/([\w.-]+\.js)'/g)].map((m) => m[1]);
  const boot = order.slice(0, order.indexOf('app-core.js') + 1).filter((f, i, a) => a.indexOf(f) === i && !/^(backend-(?!helpers)|storage-)/.test(f));
  for (const f of boot) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
  vm.runInContext('createVueApp()', sandbox);
  return registered;
}

// '#id' -> markup, for the root (#vue-app) and every <template id> in ui.html, as the browser parses it.
function domTemplates(root, parse5) {
  const host = parse5.parse('<!doctype html><html><body><div id="app-root"></div></body></html>');
  const find = (node, test) => {
    if (test(node)) return node;
    for (const c of (node.childNodes || []).concat(node.content ? [node.content] : [])) { const hit = find(c, test); if (hit) return hit; }
    return null;
  };
  const idOf = (n) => ((n.attrs || []).find((a) => a.name === 'id') || {}).value;
  const ctx = find(host, (n) => idOf(n) === 'app-root');
  const frag = parse5.parseFragment(ctx, fs.readFileSync(path.join(root, 'ui.html'), 'utf8'));
  const out = {};
  for (const n of frag.childNodes) {
    const id = idOf(n);
    if (!id) continue;
    out['#' + id] = parse5.serialize(n.tagName === 'template' ? n.content : n);
  }
  return out;
}

// The JS that defines CompiledTemplates: { '#id' | componentName: render }.
function compileAll(root) {
  const { compiler, parse5 } = deps(root);
  const dom = domTemplates(root, parse5);
  const sources = { '#vue-app': dom['#vue-app'] };
  const byName = componentTemplates(root);
  for (const [name, tpl] of Object.entries(byName)) {
    if (tpl.charAt(0) === '#') { if (!dom[tpl]) throw new Error('compile-templates: ' + name + ' uses ' + tpl + ', which ui.html does not define'); sources[tpl] = dom[tpl]; }
    else sources[name] = tpl;
  }
  if (!sources['#vue-app']) throw new Error('compile-templates: ui.html has no #vue-app root');
  const parts = Object.entries(sources).map(([key, tpl]) => {
    const errors = [];
    const { code } = compiler.compile(tpl, { mode: 'function', prefixIdentifiers: true, hoistStatic: true, onError: (e) => errors.push(e.message) });
    if (errors.length) throw new Error('compile-templates: ' + key + ': ' + errors.join('; '));
    return '  T[' + JSON.stringify(key) + '] = (function () {\n' + code + '\n})();';
  });
  return { count: parts.length, components: Object.keys(byName).length,
    js: '\n// Compiled by scripts/compile-templates.js.\nvar CompiledTemplates = (function () {\n  var T = {};\n' + parts.join('\n') + '\n  return T;\n})();\n' };
}

module.exports = { compileAll, componentTemplates };

if (require.main === module) {
  const r = compileAll(path.join(__dirname, '..'));
  console.log('✓ ' + r.count + ' templates (' + r.components + ' components and the root)');
}
