// Shared Drive API helpers — used by backend-oauth.js AND transport-drive.js.
// Depends on _fetch (from auth-oauth.js) being available as a global.
var DriveHelpers = {
  // Escape a value for a single-quoted Drive API `q` string literal (backslash, then quote). Names
  // interpolated into queries come from schema/user data (table names, language codes) — an unescaped
  // quote breaks the query and stalls sync for that file.
  q: function(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); },
  getOrCreateFolder: function(parentId, name) {
    return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + parentId + '\' in parents and name=\'' + DriveHelpers.q(name) + '\' and mimeType=\'application/vnd.google-apps.folder\' and trashed=false&fields=files(id)')
      .then(function(r) { return r.json(); }).then(function(d) {
        if (d.files && d.files.length) return d.files[0].id;
        return _fetch('https://www.googleapis.com/drive/v3/files', 'POST', { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
          .then(function(r) { return r.json(); }).then(function(f) { return f.id; });
      });
  },
  uploadFile: function(folderId, name, content) {
    return _fetch('https://www.googleapis.com/drive/v3/files?q=\'' + folderId + '\' in parents and name=\'' + DriveHelpers.q(name) + '\' and trashed=false&fields=files(id)')
      .then(function(r) { return r.json(); }).then(function(d) {
        var fileId = d.files && d.files[0] ? d.files[0].id : null;
        var metadata = { name: name }; if (!fileId) metadata.parents = [folderId];
        var form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', new Blob([content], { type: 'application/json' }));
        var url = fileId
          ? 'https://www.googleapis.com/upload/drive/v3/files/' + fileId + '?uploadType=multipart'
          : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
        return fetch(url, { method: fileId ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + _token }, body: form });
      });
  }
};
