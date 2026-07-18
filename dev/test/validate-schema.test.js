const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Extract validateSchema logic (mirrors app-core.js)
function validateSchema(SCHEMA, VIEWS) {
  var errors = [];
  for (var v in VIEWS) {
    var view = VIEWS[v];
    (view.sources || []).forEach(function(s) { if (!SCHEMA[s]) errors.push('View "' + v + '" references non-existent table "' + s + '"'); });
    (view.columns || []).forEach(function(c) {
      var found = (view.sources || []).some(function(s) { return SCHEMA[s] && SCHEMA[s].columns && SCHEMA[s].columns[c]; });
      if (!found) errors.push('View "' + v + '": column "' + c + '" not found in sources [' + (view.sources || []).join(', ') + ']');
    });
  }
  function hasCircular(vn, visited) {
    if (visited.indexOf(vn) >= 0) return true;
    var vv = VIEWS[vn];
    if (!vv || !vv.embed) return false;
    var embeds = Array.isArray(vv.embed) ? vv.embed : [vv.embed];
    return embeds.some(function(e) { return e.view && hasCircular(e.view, visited.concat(vn)); });
  }
  for (var v3 in VIEWS) {
    var rawEmb = VIEWS[v3].embed;
    var embeds = rawEmb ? (Array.isArray(rawEmb) ? rawEmb : [rawEmb]) : [];
    embeds.forEach(function(emb) {
      if (emb.view && !VIEWS[emb.view]) errors.push('View "' + v3 + '": embed references non-existent view "' + emb.view + '"');
    });
    if (hasCircular(v3, [])) errors.push('View "' + v3 + '": circular embed reference');
  }
  return errors;
}

describe('validateSchema circular embed', () => {
  const SCHEMA = { tasks: { columns: { id: 'text', title: 'text' } } };

  it('no error for valid embed view reference', () => {
    const VIEWS = {
      all: { sources: ['tasks'], columns: ['title'], mode: 'union' },
      main: { sources: ['tasks'], columns: ['title'], embed: { view: 'all' } }
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.equal(errs.filter(e => e.includes('circular')).length, 0);
  });

  it('detects direct circular embed (A embeds A)', () => {
    const VIEWS = {
      loop: { sources: ['tasks'], columns: ['title'], embed: { view: 'loop' } }
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.ok(errs.some(e => e.includes('circular')));
  });

  it('detects indirect circular embed (A -> B -> A)', () => {
    const VIEWS = {
      a: { sources: ['tasks'], columns: ['title'], embed: { view: 'b' } },
      b: { sources: ['tasks'], columns: ['title'], embed: { view: 'a' } }
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.ok(errs.some(e => e.includes('circular')));
  });

  it('detects non-existent embed view reference', () => {
    const VIEWS = {
      main: { sources: ['tasks'], columns: ['title'], embed: { view: 'ghost' } }
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.ok(errs.some(e => e.includes('non-existent view "ghost"')));
  });

  it('no error for table-based embed (no view ref)', () => {
    const VIEWS = {
      main: { sources: ['tasks'], columns: ['title'], embed: { table: 'tasks', filter: {}, columns: ['title'] } }
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.equal(errs.filter(e => e.includes('circular') || e.includes('non-existent view')).length, 0);
  });

  it('no error for array embed with valid refs', () => {
    const VIEWS = {
      open: { sources: ['tasks'], columns: ['title'] },
      main: { sources: ['tasks'], columns: ['title'], embed: [
        { header: 'Open', table: 'tasks', filter: { status: 'open' }, columns: ['title'] },
        { header: 'Done', view: 'open', footer: 'Archive these' }
      ]}
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.equal(errs.filter(e => e.includes('circular') || e.includes('non-existent')).length, 0);
  });

  it('detects non-existent view in array embed', () => {
    const VIEWS = {
      main: { sources: ['tasks'], columns: ['title'], embed: [
        { table: 'tasks', columns: ['title'] },
        { view: 'ghost' }
      ]}
    };
    const errs = validateSchema(SCHEMA, VIEWS);
    assert.ok(errs.some(e => e.includes('non-existent view "ghost"')));
  });
});
