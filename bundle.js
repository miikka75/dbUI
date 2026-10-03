// bundle.js — Pure planning for export and import: what a bundle file holds, how it splits into files,
// and what importing one will do. Framework-agnostic + Node-tested, mirroring reorder.js / profiles.js.
//   Browser: <script src="/bundle.js">, then Bundle.importPlan(...). Node: const Bundle = require('../bundle').
//
// WHY THIS EXISTS: the export and the import each answered the same questions on their own. "Is this
// table key reference data?" was asked three times (the export's file split, the import's part filter,
// and the export's gather), and "are these lists only the names a schema declares?" twice. The import's
// plan -- which rows land where, which parts the file offered and this import declines, how many steps
// the progress dialog counts -- was built inline in a 270-line method, so none of it had a test below
// the UI suite.
//
// WHAT IS NOT HERE: reading tables, the progress dialog, and every write. Those stay in app-core's
// exportData / applyBundle, which run the plan this module draws up.
(function(root) {
  // `tasks` and `tasks__archive` are the same table; the suffix names a partition.
  function tableOf(key) { return String(key).split('__')[0]; }

  // A lookup's rows are reference data and every other table is somebody's work. A table the schema
  // does not know is treated as ordinary: a catalogue this deployment has never heard of cannot be
  // claimed as its reference data.
  function isReference(schema, key) { var t = tableOf(key); return !!(schema && schema[t] && schema[t].isLookup); }

  // Lists that are ALL empty are the names a schema declares, not anybody's vocabulary. On the way out
  // they belong with the structure; on the way in they can never be a restore, only fill gaps.
  function declaresOnly(lists) {
    return Object.keys(lists || {}).every(function(n) { return !((lists[n] || []).length); });
  }

  // WHO can reach the deployment, from the three reads an admin's export makes. Null when the registry
  // read was refused: a backup that silently drops people is the one that gets trusted. Avatars stay
  // behind (each is a data URL near 350 KB, and a member can re-upload one); `shared` travels as a
  // record and is not replayed on import, because re-asserting a person's opt-in is a consent decision.
  function memberRecord(users, profiles, links) {
    if (users == null) return null;
    var out = {};
    Object.keys(profiles || {}).forEach(function(e) {
      var p = profiles[e] || {};
      if (p.name || p.shared) out[e] = { name: p.name || '', shared: !!p.shared };
    });
    return { users: users, profiles: out, listUsers: links || {} };
  }

  // One payload as the SET of files examples/ is read as: `<id>-schema.json` (structure, its reference
  // rows, declared list names, config), `<id>-data.json` (the rows and vocabularies a ward typed), one
  // `<id>-lang-<code>.json` per language, `<id>-users.json`, and `<id>-pages.json`. Returns
  // [[filename, content], ...] with the schema file first.
  function fileSet(payload, schema, id) {
    var files = [], schemaFile = {}, dataFile = {};
    if (payload.schema) schemaFile.schema = payload.schema;
    if (payload.config) schemaFile.config = payload.config;
    if (payload.lists) (declaresOnly(payload.lists) ? schemaFile : dataFile).lists = payload.lists;
    if (payload.tables && Object.keys(payload.tables).length) {
      var ref = {}, own = {};
      Object.keys(payload.tables).forEach(function(k) { (isReference(schema, k) ? ref : own)[k] = payload.tables[k]; });
      if (Object.keys(ref).length) schemaFile.tables = ref;
      if (Object.keys(own).length) dataFile.tables = own;
    }
    if (Object.keys(dataFile).length) files.push([id + '-data.json', dataFile]);
    if (Object.keys(schemaFile).length) files.unshift([id + '-schema.json', schemaFile]);
    (payload.languages || []).forEach(function(l) {
      var t = (payload.translations || {})[l.code];
      if (!t) return;
      var one = { languages: [{ code: l.code, name: l.name || l.code }], translations: {} };
      one.translations[l.code] = t;
      files.push([id + '-lang-' + l.code + '.json', one]);
    });
    if (payload.members) files.push([id + '-users.json', { members: payload.members }]);
    if (payload.pages || payload.assets) {
      var content = {};
      if (payload.pages) content.pages = payload.pages;
      if (payload.assets) content.assets = payload.assets;
      files.push([id + '-pages.json', content]);
    }
    return files;
  }

  // What importing `imported` (already through Examples.asBundle) will do, given which parts were asked
  // for. `want(part)` answers for 'schema' | 'data' | 'reference' | 'languages' | 'users';
  // opts = { isAdmin, assetCap, provenance }.
  //
  // Every row lands in the ACTIVE store whatever key it arrived under: a `tasks__archive` key becomes a
  // `_status` stamp (kept if the row already carries one) and `clearArchive`, so the old collection is
  // emptied as the row moves. That is the migration route from partition-as-store to partition-as-field.
  function importPlan(imported, want, schema, opts) {
    opts = opts || {};
    var wantSchema = want('schema'), wantData = want('data'), wantRef = want('reference');
    var applySchema = !!imported.schema && wantSchema;
    var rowJobs = [];
    Object.keys(imported.tables || {}).forEach(function(key) {
      if (!(isReference(schema, key) ? wantRef : wantData)) return;
      var rows = Array.isArray(imported.tables[key]) ? imported.tables[key] : (imported.tables[key].rows || []);
      var archived = String(key).indexOf('__') >= 0;
      rows.forEach(function(row) {
        rowJobs.push({ table: tableOf(key), tab: 'active', clearArchive: archived,
          row: archived ? Object.assign({}, row, { _status: row._status || 'archive' }) : row });
      });
    });
    var langCodes = (want('languages') && imported.translations) ? Object.keys(imported.translations) : [];
    // Page bodies and image assets are content, so they follow the data. An over-cap asset is dropped
    // rather than attempted: both production rule layers refuse it, so it could only fail.
    var pages = (wantData && Array.isArray(imported.pages)) ? imported.pages.filter(function(p) { return p.id && p.markdown; }) : [];
    var assets = (wantData && Array.isArray(imported.assets))
      ? imported.assets.filter(function(a) { return a && a.id && typeof a.src === 'string' && a.src.length <= opts.assetCap; }) : [];
    // The roster only when the file carries one AND an admin asked for it in the same gesture.
    var hasMembers = !!(imported.members && typeof imported.members === 'object');
    var members = (want('users') && opts.isAdmin && hasMembers) ? imported.members : null;
    // What the file OFFERED that this import will not apply: declining is the selection working, but
    // declining in silence looks exactly like failing.
    var declined = [['schema', !!imported.schema], ['languages', !!imported.translations],
      ['data', !!(imported.tables && Object.keys(imported.tables).length)], ['users', hasMembers]]
      .filter(function(p) { return p[1] && !want(p[0]); }).map(function(p) { return p[0]; });
    var applyLists = !!imported.lists && (wantData || wantRef);
    var applyConfig = !!imported.config && wantSchema;
    return {
      applySchema: applySchema, rowJobs: rowJobs, applyLists: applyLists, langCodes: langCodes, pages: pages,
      assets: assets, members: members, declined: declined, applyConfig: applyConfig,
      // One per step the dialog shows, the trailing 1 being the locked-list check every import ends with.
      // Lists count only when they will be applied: counting `imported.lists` alone left a schema-only
      // import of a file that carries lists finishing one step short of its own total.
      total: (applySchema ? 1 : 0) + rowJobs.length + (applyLists ? 1 : 0) + langCodes.length + pages.length +
        assets.length + (declined.length ? 1 : 0) + (applyConfig ? 1 : 0) + (members ? 1 : 0) + (opts.provenance ? 1 : 0) + 1
    };
  }

  var M = { tableOf: tableOf, isReference: isReference, declaresOnly: declaresOnly, memberRecord: memberRecord,
            fileSet: fileSet, importPlan: importPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Bundle = M;
})(typeof self !== 'undefined' ? self : this);
