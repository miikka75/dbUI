// auth-oauth.js — shared OAuth authentication for Drive/Sheets backends
var _token = sessionStorage.getItem('oauth_token');
var _oauthClient = null;
var CLIENT_ID = localStorage.getItem('oauth_client_id');
var SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets';

// Single-flight token refresh: concurrent 401s (parallel Drive requests after expiry) share ONE
// requestAccessToken() instead of each opening its own consent popup.
var _tokenRefresh = null;
function _refreshToken() {
  if (!_tokenRefresh) {
    _tokenRefresh = new Promise(function(resolve) {
      _oauthClient.callback = function(response) { if (response.access_token) { _token = response.access_token; sessionStorage.setItem('oauth_token', _token); } resolve(); };
      _oauthClient.requestAccessToken();
    }).then(function() { _tokenRefresh = null; }, function() { _tokenRefresh = null; });
  }
  return _tokenRefresh;
}

function _fetch(url, method, body) {
  method = method || 'GET';
  var opts = { method: method, headers: { Authorization: 'Bearer ' + _token } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function(res) {
    if (res.status === 401 && _oauthClient) {
      return _refreshToken().then(function() { opts.headers.Authorization = 'Bearer ' + _token; return fetch(url, opts); });
    }
    return res;
  });
}

function initOAuth() {
  if (typeof google === 'undefined' || !google.accounts) return;
  if (!CLIENT_ID) return; // no client id entered yet -> defer until the user signs in
  _oauthClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: SCOPES,
    callback: function(response) { if (response.access_token) { _token = response.access_token; sessionStorage.setItem('oauth_token', _token); init(); } }
  });
  // If token exists from session, init() will be called by index.html after backend loads
}

function triggerOAuth() {
  if (!_oauthClient) { CLIENT_ID = localStorage.getItem('oauth_client_id'); initOAuth(); } // lazy init once the id is saved
  if (_oauthClient) _oauthClient.requestAccessToken();
}

initOAuth();
