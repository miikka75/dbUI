// list-users.js — Pure logic for user-linked lists (Option C): map a list VALUE to a registered user's
// EMAIL so a list-backed cell can show that user's AVATAR while the displayed name stays the list value.
//
// The value→email link is admin-only data; this module also derives the privacy-safe projection shipped to
// non-admins (value→picture, for SHARED linked users only — never an email). Shared between the dev server
// and the browser app, like list-access.js:
//   Node:    const LU = require('../list-users')
//   Browser: <script src="/list-users.js">  -> window.ListUsers
//
// Link map shape: { listName: { listValue: email } }.
(function(root) {
  // Build the viewer-facing avatar projection: { listName: { value: pictureDataUrl } }.
  //   listUsers: the raw admin-only link map { list: { value: email } }.
  //   profiles:  { email: { shared, picture } } — dev: every profile; firebase: the shared set.
  //   isAdmin:   non-admins see only SHARED linked users; admins see every linked user.
  // Only entries with an actual picture are emitted: no picture -> the cell renders name-only, AND a
  // non-admin never even learns a value is linked. No email is ever included in the output.
  function buildAvatarProjection(listUsers, profiles, isAdmin) {
    profiles = profiles || {};
    var out = {};
    Object.keys(listUsers || {}).forEach(function(list) {
      var links = listUsers[list] || {}, o = {};
      Object.keys(links).forEach(function(val) {
        var p = profiles[String(links[val] || '').toLowerCase()];
        if (!p) return;                       // linked account unknown/deregistered -> name-only
        if (!isAdmin && !p.shared) return;     // non-admins can't see an unshared profile
        if (p.picture) o[val] = p.picture;     // avatar only when there's actually a picture
      });
      if (Object.keys(o).length) out[list] = o;
    });
    return out;
  }

  // Set (email truthy) or clear (falsy) a value's link, returning a NEW map (no mutation). Prunes a list
  // that becomes empty so the stored map stays tidy.
  function setLink(listUsers, list, value, email) {
    var next = {};
    Object.keys(listUsers || {}).forEach(function(k) { next[k] = Object.assign({}, listUsers[k]); });
    if (!next[list]) next[list] = {};
    if (email) next[list][value] = String(email).toLowerCase(); else delete next[list][value];
    if (!Object.keys(next[list]).length) delete next[list];
    return next;
  }

  // Migrate a link when a list value is renamed (oldValue -> newValue), returning a NEW map. A no-op (same
  // reference-shape) when nothing was linked to oldValue.
  function renameValue(listUsers, list, oldValue, newValue) {
    var m = (listUsers || {})[list];
    if (!m || !(oldValue in m) || oldValue === newValue) return listUsers || {};
    var email = m[oldValue];
    return setLink(setLink(listUsers, list, oldValue, ''), list, newValue, email);
  }

  // A value's avatar in a projection, or '' when none.
  function pictureFor(projection, list, value) {
    return ((projection || {})[list] || {})[value] || '';
  }

  var M = { buildAvatarProjection: buildAvatarProjection, setLink: setLink, renameValue: renameValue, pictureFor: pictureFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.ListUsers = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
