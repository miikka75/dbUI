// transport-drive.js -- Google Drive transport for CrdtEngine sync
var TransportDrive = (function() {
  var _folderId = null;

  function setFolder(folderId) { _folderId = folderId; }


  function _downloadFile(fileId) {
    return _fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media').then(function(r) { return r.text(); });
  }

  function pushChangesets(siteId, changes) {
    return DriveHelpers.getOrCreateFolder(_folderId, 'sync').then(function(syncId) {
      // Group by table
      var byTable = {};
      changes.forEach(function(c) { if (!byTable[c.t]) byTable[c.t] = []; byTable[c.t].push(c); });
      return Object.keys(byTable).reduce(function(chain, table) {
        return chain.then(function() {
          return DriveHelpers.getOrCreateFolder(syncId, table).then(function(tableFolderId) {
            return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + tableFolderId + '\' in parents and name=\'' + siteId + '.json\' and trashed=false&fields=files(id)')
              .then(function(r) { return r.json(); }).then(function(d) {
                var existing = { siteId: siteId, changes: [] };
                if (d.files && d.files.length) {
                  return _downloadFile(d.files[0].id).then(function(t) { try { existing = JSON.parse(t); } catch(e) {} return existing; });
                }
                return existing;
              }).then(function(existing) {
                existing.changes = existing.changes.concat(byTable[table]);
                // Dedup: keep latest per (b, id, col) via d keys
                var seen = {};
                for (var i = existing.changes.length - 1; i >= 0; i--) {
                  var c = existing.changes[i];
                  var cols = c.d ? Object.keys(c.d) : [];
                  cols.forEach(function(col) {
                    var key = c.b + '|' + c.id + '|' + col;
                    if (seen[key]) { delete c.d[col]; } else { seen[key] = true; }
                  });
                  if (c.d && !Object.keys(c.d).length) existing.changes.splice(i, 1);
                }
                return DriveHelpers.uploadFile(tableFolderId, siteId + '.json', JSON.stringify(existing));
              });
          });
        });
      }, Promise.resolve());
    });
  }

  function pullChangesets(excludeSiteId) {
    // Folder listings + changeset downloads run CONCURRENTLY (they were a serial promise chain —
    // one round-trip per device per table per 30s sync). Safe: reads are independent, and _fetch's
    // 401 refresh is single-flight (auth-oauth) so parallel expiry can't stack consent popups.
    return DriveHelpers.getOrCreateFolder(_folderId, 'sync').then(function(syncId) {
      return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + syncId + '\' in parents and mimeType=\'application/vnd.google-apps.folder\' and trashed=false&fields=files(id,name)')
        .then(function(r) { return r.json(); });
    }).then(function(d) {
      return Promise.all((d.files || []).map(function(folder) {
        return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + folder.id + '\' in parents and trashed=false&fields=files(id,name)')
          .then(function(r) { return r.json(); }).then(function(fd) {
            var files = (fd.files || []).filter(function(f) { return f.name !== excludeSiteId + '.json'; });
            return Promise.all(files.map(function(f) {
              return _downloadFile(f.id).then(function(text) {
                try { return JSON.parse(text); } catch(e) { return null; }
              });
            }));
          });
      })).then(function(nested) {
        var results = [];
        nested.forEach(function(arr) { arr.forEach(function(x) { if (x) results.push(x); }); });
        return results;
      });
    });
  }

  function _readJson(name) {
    return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + _folderId + '\' in parents and name=\'' + DriveHelpers.q(name) + '\' and trashed=false&fields=files(id)')
      .then(function(r) { return r.json(); }).then(function(d) {
        if (!d.files || !d.files.length) return null;
        return _downloadFile(d.files[0].id).then(function(t) { try { return JSON.parse(t); } catch(e) { return null; } });
      });
  }

  function _deleteFile(name) {
    return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + _folderId + '\' in parents and name=\'' + DriveHelpers.q(name) + '\' and trashed=false&fields=files(id)')
      .then(function(r) { return r.json(); }).then(function(d) {
        if (!d.files || !d.files.length) return;
        return _fetch('https://www.googleapis.com/drive/v3/files/' + d.files[0].id, 'DELETE');
      });
  }

  return {
    setFolder: setFolder,
    validateFolder: function(id) {
      return _fetch('https://www.googleapis.com/drive/v3/files/' + id + '?fields=name').then(function(res) {
        if (res.ok) return res.json().then(function(d) { return { valid: true, name: d.name }; });
        return { valid: false, name: null };
      });
    },
    readJson: function(name) { return _readJson(name); },
    writeJson: function(name, data) { return DriveHelpers.uploadFile(_folderId, name, JSON.stringify(data)); },
    deleteFile: function(name) { return _deleteFile(name); },
    pushChangesets: pushChangesets,
    pullChangesets: pullChangesets
  };
})();
