const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure copies of the folder-config export/import helpers in app-core.js. The design is a DENYLIST:
// everything in appConfig is round-tripped EXCEPT keys listed here (environment-specific). This is what
// makes a NEW appConfig parameter survive export/import with zero export-code changes — the guard test
// at the bottom verifies exactly that property, so a future param can't silently get dropped.
const FOLDER_CONFIG_EXPORT_EXCLUDE = { mode: true };

function exportableConfig(appConfig) {
  var out = {};
  Object.keys(appConfig || {}).forEach(function(k) { if (!FOLDER_CONFIG_EXPORT_EXCLUDE[k]) out[k] = appConfig[k]; });
  return out;
}
function mergeImportedConfig(currentConfig, importedConfig, mode) {
  var merged = Object.assign({}, currentConfig || {});
  Object.keys(importedConfig || {}).forEach(function(k) { if (!FOLDER_CONFIG_EXPORT_EXCLUDE[k]) merged[k] = importedConfig[k]; });
  if (mode !== undefined && mode !== null && mode !== '') merged.mode = mode; else delete merged.mode;
  return merged;
}

describe('Folder config export/import round-trip', () => {
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
