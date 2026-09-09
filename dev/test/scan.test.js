const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Scan = require('../../scan');

// The catalogue a code is resolved against: a lookup table's rows. `chore` is what a chore_log row
// stores (valueCol); `code` is what is printed on the label (codeCol) — the two differ because an EAN,
// a badge number or a stamped control id is not the text anyone reads.
const chores = [
  { id: 'r1', chore: 'Dishes', code: 'CP-01' },
  { id: 'r2', chore: 'Bedding', code: 'CP-02' }
];

const base = {
  catalog: chores, column: 'chore', valueCol: 'chore',
  me: 'ann@example.com', ownerCol: 'owner', today: '2026-09-09', now: '2026-09-09T18:30:00.000Z'
};

describe('scan.js — resolving a code', () => {
  it('a code that names one catalogue row plans a row carrying its value', () => {
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [] }));
    assert.equal(p.outcome, 'created');
    assert.equal(p.value, 'Dishes');
    assert.deepEqual(p.prefill, { chore: 'Dishes' });
  });

  it('matches on codeCol when the label is not the stored value', () => {
    const p = Scan.plan('CP-02', Object.assign({}, base, { codeCol: 'code', rows: [] }));
    assert.equal(p.outcome, 'created');
    assert.equal(p.value, 'Bedding');       // the stored value, not the code
  });

  it('case and surrounding whitespace are not part of a code', () => {
    // A wedge scanner appends Enter and sometimes a stray CR; a person types lowercase.
    const p = Scan.plan('  cp-01\r', Object.assign({}, base, { codeCol: 'code', rows: [] }));
    assert.equal(p.outcome, 'created');
    assert.equal(p.value, 'Dishes');
  });

  it('an unknown code writes nothing', () => {
    const p = Scan.plan('CP-99', Object.assign({}, base, { codeCol: 'code', rows: [] }));
    assert.equal(p.outcome, 'unknown');
    assert.equal(p.prefill, undefined);
  });

  it('a blank code is unknown, not a match on a blank catalogue cell', () => {
    const p = Scan.plan('   ', Object.assign({}, base, { catalog: chores.concat([{ chore: '' }]), rows: [] }));
    assert.equal(p.outcome, 'unknown');
  });

  it('two catalogue rows sharing a code refuse rather than guess', () => {
    // Guessing writes the wrong door, and the report would look perfectly fine afterwards.
    const dup = chores.concat([{ id: 'r3', chore: 'Dishes again', code: 'CP-01' }]);
    const p = Scan.plan('CP-01', Object.assign({}, base, { catalog: dup, codeCol: 'code', rows: [] }));
    assert.equal(p.outcome, 'ambiguous');
    assert.equal(p.prefill, undefined);
  });
});

describe('scan.js — the rest of the row', () => {
  it('@today and @now resolve; everything else is a literal', () => {
    const p = Scan.plan('Dishes', Object.assign({}, base, {
      rows: [], set: { done_on: '@today', logged_at: '@now', status: 'logged' }
    }));
    assert.deepEqual(p.prefill, {
      done_on: '2026-09-09', logged_at: '2026-09-09T18:30:00.000Z', status: 'logged', chore: 'Dishes'
    });
  });

  it('the scanned value wins over a `set` naming the same column', () => {
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [], set: { chore: 'Something else' } }));
    assert.equal(p.prefill.chore, 'Dishes');
  });
});

describe('scan.js — once', () => {
  const mine = {
    id: 'a', owner: 'ann@example.com', chore: 'Dishes',
    created_at: '2026-09-09T06:00:00.000Z', done_on: '2026-09-09'
  };

  it('without `once`, every scan appends', () => {
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [mine] }));
    assert.equal(p.outcome, 'created');
  });

  it('`day` refuses a second scan today and hands back the first row', () => {
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [mine], once: 'day' }));
    assert.equal(p.outcome, 'already');
    assert.equal(p.existing.id, 'a');
  });

  it('`day` is scoped to the owner — two people walking one route each record their own', () => {
    const theirs = Object.assign({}, mine, { id: 'b', owner: 'bob@example.com' });
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [theirs], once: 'day' }));
    assert.equal(p.outcome, 'created');
  });

  it('`day` is yesterday-blind', () => {
    const old = Object.assign({}, mine, { created_at: '2026-09-08T06:00:00.000Z' });
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [old], once: 'day' }));
    assert.equal(p.outcome, 'created');
  });

  it('`ever` refuses whenever it was logged', () => {
    const old = Object.assign({}, mine, { created_at: '2025-01-01T06:00:00.000Z' });
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [old], once: 'ever' }));
    assert.equal(p.outcome, 'already');
  });

  it('`already` reports the FIRST time, not the latest', () => {
    const later = Object.assign({}, mine, { id: 'c', created_at: '2026-09-09T20:00:00.000Z' });
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [later, mine], once: 'day' }));
    assert.equal(p.existing.id, 'a');
  });

  it('the day comes from created_at in LOCAL time, so a scan after midnight UTC is still today', () => {
    // 2026-09-09T23:30Z is the 10th in UTC+3 and the 9th in UTC-5. Whichever this machine is, the row
    // and the `today` it is compared against are bucketed by the same rule, which is the property that
    // matters: a 03:00 round does not silently split across two days.
    const at = new Date('2026-09-09T23:30:00.000Z');
    const local = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0');
    const row = Object.assign({}, mine, { created_at: at.toISOString() });
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [row], once: 'day', today: local }));
    assert.equal(p.outcome, 'already');
  });

  it('a row with no created_at never blocks a scan', () => {
    const orphan = { id: 'd', owner: 'ann@example.com', chore: 'Dishes' };
    const p = Scan.plan('Dishes', Object.assign({}, base, { rows: [orphan], once: 'day' }));
    assert.equal(p.outcome, 'created');
  });

  it('signed out matches nothing — a blank owner is not an identity', () => {
    const anon = Object.assign({}, mine, { owner: '' });
    const p = Scan.plan('Dishes', Object.assign({}, base, { me: '', rows: [anon], once: 'ever' }));
    assert.equal(p.outcome, 'created');
  });
});

describe('scan.js — configErrors', () => {
  // A schema shaped like the chores bundle: an owner-stamped log, bounded by ownerWritable, whose
  // `chore` column refs a lookup.
  const schema = () => ({
    ref_chores: { isLookup: true, columns: { chore: { type: 'text' }, code: { type: 'text' } } },
    chore_log: {
      ownerWritable: ['chore', 'done_on'],
      columns: {
        owner: { type: 'owner' },
        chore: { type: 'ref', table: 'ref_chores', valueCol: 'chore' },
        done_on: { type: 'date' },
        status: { type: 'select', list: 'chore_status', default: 'logged' },
        note: { type: 'text' }
      }
    }
  });
  const view = (scan, extra) => Object.assign({ name: 'log', sources: ['chore_log'], scan }, extra);
  const errs = (scan, extra, s) => Scan.configErrors(s || schema(), 'log', view(scan, extra));

  it('a well-formed view reports nothing', () => {
    assert.deepEqual(errs({ column: 'chore', set: { done_on: '@today' }, once: 'day' }), []);
  });

  it('a view with no scan object is not a scan view', () => {
    assert.deepEqual(Scan.configErrors(schema(), 'log', { name: 'log', sources: ['chore_log'] }), []);
  });

  it('the scanned column must exist, and must be a ref', () => {
    assert.match(errs({ column: 'nope' })[0], /not a column of "chore_log"/);
    assert.match(errs({ column: 'note' })[0], /must be a `ref` column/);
  });

  it('one table is written, so one source', () => {
    assert.match(errs({ column: 'chore' }, { sources: [] })[0], /needs `sources`/);
    assert.match(errs({ column: 'chore' }, { sources: ['chore_log', 'ref_chores'] })[0], /takes one name/);
  });

  it('codeCol names a column of the lookup, not of the log', () => {
    assert.deepEqual(errs({ column: 'chore', codeCol: 'code' }), []);
    assert.match(errs({ column: 'chore', codeCol: 'done_on' })[0], /not a column of the lookup table "ref_chores"/);
  });

  it('an unrecognised @token would be written through as text, so it is refused', () => {
    assert.match(errs({ column: 'chore', set: { done_on: '@yesterday' } })[0], /the only tokens are @today and @now/);
  });

  it('`set` may not name the scanned column, and its columns must exist', () => {
    assert.match(errs({ column: 'chore', set: { chore: 'x' } })[0], /which is the scanned column/);
    assert.match(errs({ column: 'chore', set: { nope: 'x' } })[0], /is not a column of "chore_log"/);
  });

  it('`once` takes day or ever', () => {
    assert.match(errs({ column: 'chore', once: 'week' })[0], /use "day".*or "ever"/);
  });

  it('`link` takes arm or submit', () => {
    assert.deepEqual(errs({ column: 'chore', link: 'submit' }), []);
    assert.deepEqual(errs({ column: 'chore', link: 'arm' }), []);
    assert.match(errs({ column: 'chore', link: 'auto' })[0], /use "submit".*or "arm"/);
  });

  // Requirement 4: the write layers gate a self-service create on the owner column and on ownerWritable
  // naming every column the row carries. Both mismatches render a perfectly fine view that silently
  // refuses at the rules layer, which is why they are load-time errors.
  it('a table with no owner column cannot take a scanned row', () => {
    const s = schema();
    delete s.chore_log.columns.owner;
    assert.match(errs({ column: 'chore' }, null, s)[0], /has no `owner` column/);
  });

  it('a column the scan writes but ownerWritable omits is refused at load, not at the door', () => {
    const e = errs({ column: 'chore', set: { done_on: '@today', note: 'scanned' } });
    assert.equal(e.length, 1);
    assert.match(e[0], /"note" is written by the scan but missing from "chore_log"\.ownerWritable/);
  });

  it('a table declaring no ownerWritable has no gate, so nothing to list', () => {
    const s = schema();
    delete s.chore_log.ownerWritable;
    assert.deepEqual(errs({ column: 'chore', set: { note: 'scanned' } }, null, s), []);
  });
});

describe('scan.js — Code 39', () => {
  // The 44 patterns are transcribed, so the structural laws of the symbology are what guard them: a
  // typo that breaks one of these is a label that scans as the wrong character, and the only other
  // place it would show up is a scanner in somebody's hand.
  it('every pattern is nine elements with exactly three wide', () => {
    const keys = Object.keys(Scan.C39);
    assert.equal(keys.length, 44);                    // 43 data characters + the * delimiter
    for (const k of keys) {
      const p = Scan.C39[k];
      assert.equal(p.length, 9, k);
      assert.match(p, /^[nw]{9}$/, k);
      assert.equal(p.split('').filter(c => c === 'w').length, 3, k + ' must have three wide elements');
    }
  });

  it('the wide elements fall 2-bars-1-space, except the four punctuation codes which are 0-and-3', () => {
    // This is the split that actually separates a valid Code 39 character from nine arbitrary elements.
    for (const k of Object.keys(Scan.C39)) {
      const p = Scan.C39[k].split('');
      const bars = [0, 2, 4, 6, 8].filter(i => p[i] === 'w').length;
      const spaces = [1, 3, 5, 7].filter(i => p[i] === 'w').length;
      const special = ['$', '/', '+', '%'].indexOf(k) >= 0;
      assert.deepEqual([bars, spaces], special ? [0, 3] : [2, 1], k);
    }
  });

  it('no two characters share a pattern', () => {
    const seen = new Map();
    for (const k of Object.keys(Scan.C39)) {
      assert.equal(seen.has(Scan.C39[k]), false, k + ' collides with ' + seen.get(Scan.C39[k]));
      seen.set(Scan.C39[k], k);
    }
  });

  it('encodes a code between start and stop, with a narrow gap between characters', () => {
    const e = Scan.code39('CP-01');
    // 7 characters (*CP-01*), 5 bars each; 15 modules per character plus 6 inter-character gaps.
    assert.equal(e.bars.length, 35);
    assert.equal(e.width, 7 * 15 + 6);
    assert.equal(e.bars[0].x, 0);
    const last = e.bars[e.bars.length - 1];
    assert.equal(last.x + last.w, e.width);           // the stop character's final bar closes the symbol
  });

  it('no two bars touch — adjacent bars would merge into one wider bar and misread', () => {
    const e = Scan.code39('CP-01 A$/+%.');
    for (let i = 1; i < e.bars.length; i++) {
      assert.ok(e.bars[i].x > e.bars[i - 1].x + e.bars[i - 1].w,
        'bar ' + i + ' starts at ' + e.bars[i].x + ', previous ends at ' + (e.bars[i - 1].x + e.bars[i - 1].w));
    }
  });

  it('a lowercase catalogue value still prints, because case is not part of a code', () => {
    // Standard Code 39 has no lowercase. Printing DISHES is safe precisely because `norm` lowercases
    // both sides of a match, so the label round-trips to the stored value "Dishes".
    const e = Scan.code39('Dishes');
    assert.equal(e.text, 'DISHES');
    const p = Scan.plan(e.text, Object.assign({}, base, { rows: [] }));
    assert.equal(p.value, 'Dishes');
  });

  it('a code Code 39 cannot carry returns null rather than a barcode that reads as something else', () => {
    assert.equal(Scan.code39('Wash-up #2'), null);    // '#' is not in the 43
    assert.equal(Scan.code39('CP*01'), null);         // '*' delimits, it is never data
    assert.equal(Scan.code39('   '), null);
  });
});

describe('scan.js — what a decoder hands back', () => {
  it('a 1D label decodes to the code itself', () => {
    assert.equal(Scan.codeFrom('CP-01'), 'CP-01');
    assert.equal(Scan.codeFrom('  CP-01\r'), 'CP-01');
  });

  it('a QR carrying the deep link resolves to the code inside it, and nothing navigates', () => {
    // Photographing our own QR inside the app must do the write here, not open a second copy of the
    // app to do the same write.
    assert.equal(Scan.codeFrom('https://app.example/?view=walk&scan=CP-01'), 'CP-01');
    assert.equal(Scan.codeFrom('https://app.example/?db=home&view=walk&scan=CP%2D02#top'), 'CP-02');
  });

  it('a payload that is not ours comes back as itself, and fails the catalogue match like any code', () => {
    assert.equal(Scan.codeFrom('https://example.com/promo'), 'https://example.com/promo');
    assert.equal(Scan.codeFrom('https://example.com/?utm=x'), 'https://example.com/?utm=x');
    assert.equal(Scan.codeFrom('A=B'), 'A=B');          // not a URL: an '=' does not make it one
    assert.equal(Scan.codeFrom(''), '');
  });
});

describe('scan.js — which catalogue is scannable', () => {
  const schema = {
    ref_controls: { isLookup: true, columns: { control: {}, code: {} } },
    ref_rewards: { isLookup: true, columns: { reward: {} } },
    visits: { columns: { control: { type: 'ref', table: 'ref_controls', valueCol: 'control' } } }
  };
  const views = {
    walk: { sources: ['visits'], scan: { column: 'control' } },
    walk_auto: { sources: ['visits'], scan: { column: 'control', link: 'submit' } },
    plain: { sources: ['visits'] },                       // a data view over the same table
    broken: { sources: ['visits'], scan: {} }             // no column yet
  };

  it('finds the scan views whose codes name these rows', () => {
    // A catalogue does not know it is scannable — a ref column points AT it — so this is what puts a
    // print action beside it in the Lookup editor.
    assert.deepEqual(Scan.viewsForCatalog(schema, views, 'ref_controls'), ['walk', 'walk_auto']);
  });

  it('a lookup nothing scans has none, so nothing offers to print labels for it', () => {
    assert.deepEqual(Scan.viewsForCatalog(schema, views, 'ref_rewards'), []);
    assert.deepEqual(Scan.viewsForCatalog(schema, views, ''), []);
    assert.deepEqual(Scan.viewsForCatalog(schema, views, 'nope'), []);
  });
});
