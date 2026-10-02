// ui-conventions.test.js — the shared UI elements are used, not re-made by hand.
//
// The same kinds of element kept being built afresh, each a little different: a separate Copy button
// beside one field and an icon inside the next, a one-press x on one row and two presses on another,
// three button sizes on one screen. CLAUDE.md ("UI conventions") names the shared component for each;
// these checks fail on the hand-made versions, whoever writes them.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
const core = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');

// The source of one registered component (from its app.component call to the next one), so a component's
// own definition can be told apart from a hand-made copy elsewhere.
function componentSource(name) {
  const at = core.indexOf("app.component('" + name + "'");
  assert.ok(at >= 0, 'component ' + name + ' is registered');
  const next = core.indexOf('app.component(', at + 1);
  return core.slice(at, next < 0 ? undefined : next);
}
function count(text, re) { return (text.match(re) || []).length; }
function template(id) {
  const at = ui.indexOf('<template id="' + id + '">');
  assert.ok(at >= 0, 'template ' + id + ' exists');
  return ui.slice(at, ui.indexOf('\n</template>', at));
}
const SEE = ' — see CLAUDE.md, "UI conventions"';

describe('UI conventions', () => {
  it('a copyable one-line value is a <copy-field>, not a field with its own copy icon or button', () => {
    const own = componentSource('copy-field');
    const inner = /append-inner-icon="mdi-content-copy"/g;
    assert.equal(count(ui, inner), 0, 'ui.html builds a copy field by hand' + SEE);
    assert.equal(count(core, inner) - count(own, inner), 0, 'app-core.js builds a copy field by hand' + SEE);
    // A copy BUTTON is only for a multi-line <pre> block (the setup dialog's rules).
    const buttons = [...(ui + core).matchAll(/<v-btn[^>]*mdi-content-copy[^>]*>/g)];
    buttons.forEach((m) => {
      const before = (ui + core).slice(Math.max(0, m.index - 400), m.index);
      assert.ok(/<pre\b/.test(before), 'a copy button that is not over a <pre> block: ' + m[0].slice(0, 120) + SEE);
    });
  });

  it('a two-press button is a <confirm-x> or <confirm-btn>, not a hand-made icon swap', () => {
    // The tell-tale of the hand-made version: an ARMED test choosing between the check mark and an idle
    // icon spelled out beside it. (A check mark that marks a state, like the active database, is not one.)
    const handMade = /[Aa]rmed\b[^?\n]*\?\s*\\?'mdi-check-circle\\?' : \\?'mdi-/g;
    assert.equal(count(ui, handMade), 0, 'ui.html has a hand-made two-press icon' + SEE);
    assert.equal(count(core, handMade), 0, 'app-core.js has a hand-made two-press icon' + SEE);
  });

  it('a collapsible Settings section uses <section-toggle>', () => {
    const settings = template('settings-view-tpl');
    assert.equal(count(settings, /@click="a\.settings\._collapse/g), 0, 'a Settings section toggles itself by hand' + SEE);
  });

  it('Settings buttons use the role sizes: never extra-small', () => {
    for (const id of ['settings-view-tpl', 'calendar-editor-tpl']) {
      const tags = [...template(id).matchAll(/<v-btn\b[^>]*>/g)].map((m) => m[0]).filter((t) => /size="x-small"/.test(t));
      assert.deepEqual(tags, [], id + ' has an extra-small button' + SEE);
    }
  });

  it('a label is one key, never two fixed keys glued together', () => {
    // "{{ a.t('btn.add') }} {{ a.t('settings.cal_new') }}" took word order away from the translator. (An
    // "Add" beside a DYNAMIC name -- a table's or a list's -- is a known residue: doing it properly needs
    // placeholders in t(), which it does not have yet.)
    const key = String.raw`a?\.?t\('[a-z_]+\.[a-z0-9_.]+'\)`;
    const inTemplate = new RegExp(String.raw`\{\{\s*` + key + String.raw`\s*\}\}\s*\{\{\s*` + key + String.raw`\s*\}\}`, 'g');
    const inBinding = new RegExp(key + String.raw`\s*\+\s*' '\s*\+\s*` + key, 'g');
    assert.deepEqual(ui.match(inTemplate) || [], [], 'a label built from two keys in a template' + SEE);
    assert.deepEqual((ui + core).match(inBinding) || [], [], 'a label built from two keys in a binding' + SEE);
  });
});
