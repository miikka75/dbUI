const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// The folder-config export/import helpers, pulled OUT OF app-core.js rather than copied here. The
// design is a DENYLIST: everything in appConfig is round-tripped EXCEPT keys listed there
// (environment-specific), which is what makes a NEW appConfig parameter survive export/import with
// zero export-code changes -- the guard test at the bottom verifies exactly that property.
//
// It used to be a copy, which is a test that agrees with the implementation by construction: the copy
// would have kept passing while the real function grew the `example.units` strip below.
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app-core.js'), 'utf8');
const grab = (name, kind) => {
  const re = kind === 'var'
    ? new RegExp('^var ' + name + ' = [^;]+;', 'm')
    : new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm');
  const m = SRC.match(re);
  if (!m) throw new Error('could not find ' + name + ' in app-core.js');
  return m[0];
};
const { FOLDER_CONFIG_EXPORT_EXCLUDE, exportableConfig, mergeImportedConfig } = (0, eval)(
  '(function () {' + grab('FOLDER_CONFIG_EXPORT_EXCLUDE', 'var') + grab('exportableConfig') + grab('mergeImportedConfig')
  + ' return { FOLDER_CONFIG_EXPORT_EXCLUDE: FOLDER_CONFIG_EXPORT_EXCLUDE, exportableConfig: exportableConfig,'
  + ' mergeImportedConfig: mergeImportedConfig }; })()');

describe('Folder config export/import round-trip', () => {
  it('drops the example fingerprints, which nothing reads and every viewer would fetch at boot', () => {
    const withUnits = { example: { bundle: 'chores', revision: 2, files: { 'a.json': 'h' }, units: { 'views/x': 'abc' } } };
    const exp = exportableConfig(withUnits);
    assert.equal(exp.example.units, undefined, 'units must not cross the export boundary');
    assert.equal(exp.example.bundle, 'chores', '...but the provenance itself still does');
    assert.deepEqual(exp.example.files, { 'a.json': 'h' }, 'the file hashes are what the update check needs');
    assert.ok(withUnits.example.units, 'the caller\'s own config is not mutated');
  });

  const appConfig = {
    mode: 'firebase',
    rotationAnchors: { cleaning: '2026-01-05', ushers: '2026-02-01' },
    rotationRanges: { cleaning: { periods: 8, from: '2026-01-01' } }
  };

  it('export keeps portable keys (rotationAnchors, rotationRanges) and drops mode', () => {
    const exp = exportableConfig(appConfig);
    assert.deepEqual(exp, {
      rotationAnchors: { cleaning: '2026-01-05', ushers: '2026-02-01' },
      rotationRanges: { cleaning: { periods: 8, from: '2026-01-01' } }
    });
    assert.equal('mode' in exp, false);
  });

  it('import applies portable keys and PRESERVES this environment\'s mode (never the source mode)', () => {
    const exported = exportableConfig(appConfig);            // from a firebase env (mode stripped)
    const merged = mergeImportedConfig({ mode: 'local' }, exported, 'local'); // imported into a local env
    assert.equal(merged.mode, 'local');                      // env mode kept, not 'firebase'
    assert.deepEqual(merged.rotationAnchors, appConfig.rotationAnchors);
    assert.deepEqual(merged.rotationRanges, appConfig.rotationRanges);
  });

  it('import ignores a mode smuggled into the imported config', () => {
    const merged = mergeImportedConfig({ mode: 'local' }, { mode: 'firebase', rotationAnchors: { x: '2026-03-01' } }, 'local');
    assert.equal(merged.mode, 'local');
    assert.deepEqual(merged.rotationAnchors, { x: '2026-03-01' });
  });

  it('full round-trip preserves the anchor that was lost before this fix', () => {
    const exported = exportableConfig({ mode: 'firebase', rotationAnchors: { cleaning: '2026-01-05' } });
    const reimported = mergeImportedConfig({}, exported, 'local');
    assert.equal(reimported.rotationAnchors.cleaning, '2026-01-05'); // anchor survives
  });

  it('handles empty / undefined config safely', () => {
    assert.deepEqual(exportableConfig(undefined), {});
    assert.deepEqual(exportableConfig({}), {});
    assert.deepEqual(mergeImportedConfig(undefined, undefined, 'local'), { mode: 'local' });
  });

  // GUARD: a NEW appConfig parameter is round-tripped automatically (no export/import code change needed).
  // If someone later adds an environment-specific key that must NOT be exported, this test reminds them
  // to add it to FOLDER_CONFIG_EXPORT_EXCLUDE — otherwise it will (correctly, by default) be exported.
  it('a future appConfig key is auto-exported and auto-imported (denylist contract)', () => {
    const future = { mode: 'firebase', rotationAnchors: { a: '1' }, brandNewSetting: { foo: 'bar' }, anotherFlag: true };
    const exp = exportableConfig(future);
    assert.equal(exp.brandNewSetting.foo, 'bar', 'new object key must be exported without code changes');
    assert.equal(exp.anotherFlag, true, 'new scalar key must be exported without code changes');
    assert.equal('mode' in exp, false, 'only denylisted keys are excluded');
    const merged = mergeImportedConfig({ mode: 'local' }, exp, 'local');
    assert.equal(merged.brandNewSetting.foo, 'bar');
    assert.equal(merged.anotherFlag, true);
    assert.equal(merged.mode, 'local');
  });

  it('documents the current denylist (env-specific keys excluded from export)', () => {
    // If this fails because the denylist changed, confirm the new key is truly environment-specific
    // (machine-local, must not travel with an export) before updating this assertion.
    assert.deepEqual(Object.keys(FOLDER_CONFIG_EXPORT_EXCLUDE).sort(), ['mode']);
  });
});
