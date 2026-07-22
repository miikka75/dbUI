// dev-client.js -- Shared dev-server client helpers (_post + backend_users).
// Loaded before backend-local-client.js and backend-crdt-local.js. Dev-server only.
function _post(route, body) {
  var user = (new URLSearchParams(location.search)).get('user') || localStorage.getItem('test_user') || 'local@dev';
  return fetch('/api/' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: JSON.stringify(body)
  }).then(function(r) { if (!r.ok) return r.json().then(function(e) { return Promise.reject(e); }); return r.json(); });
}

// Image-column upload for the dev backends: read the file as base64 and POST it to the dev server, which
// stores it under dev/uploads/ and returns a same-origin URL (saved on the row). The dev backend entry
// files attach this as `backend.uploadFile` (this helper loads before `backend` exists). Its presence is
// what turns on the in-cell upload button; backends without it fall back to a paste-a-URL field.
function _devUploadFile(file, opts) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onerror = function() { reject(new Error('Could not read file')); };
    reader.onload = function() {
      var b64 = String(reader.result || '').split(',')[1] || '';
      _post('uploadFile', { name: file.name, contentType: file.type, base64: b64 })
        .then(function(r) { r && r.url ? resolve(r.url) : reject(new Error((r && r.error) || 'Upload failed')); })
        .catch(function(e) { reject(new Error((e && e.error) || (e && e.message) || 'Upload failed')); });
    };
    reader.readAsDataURL(file);
  });
}

var backend_users = {
  getUsers: function() { return _post('getUsers', {}); },
  getMyAccess: function() { return _post('getMyAccess', {}); },
  setUserRole: function(uid, role, user, tables) { return _post('setUserRole', { uid: uid, role: role, user: user, tables: tables }); },
  removeUser: function(uid) { return _post('removeUser', { uid: uid }); },
  requestAccess: function(name, note) { return _post('requestAccess', { name: name, note: note }); },
  getAccessRequests: function() { return _post('getAccessRequests', {}); },
  removeAccessRequest: function(email) { return _post('removeAccessRequest', { email: email }); },
  getMyProfile: function() { return _post('getMyProfile', {}); },
  setMyProfile: function(name, shared, picture) { return _post('setMyProfile', { name: name, shared: shared, picture: picture }); },
  getSharedNames: function() { return _post('getSharedNames', {}); },
  setProfileName: function(email, name) { return _post('setProfileName', { email: email, name: name }); },
  getProfiles: function() { return _post('getProfiles', {}); }
};
