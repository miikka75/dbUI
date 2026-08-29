// list-users.js — Pure logic for user-linked lists (Option C): map a list VALUE to a registered user's
// EMAIL, so a list-backed cell can show that user's AVATAR (and, where the schema asks for it, their
// display NAME) while the value stored in the row stays the curated list value.
//
// The value→email link is admin-only data; this module also derives the privacy-safe projection shipped to
// non-admins (value→picture, for SHARED linked users only — never an email). Shared between the dev server
// and the browser app, like list-access.js:
//   Node:    const LU = require('../list-users')
//   Browser: <script src="/list-users.js">  -> window.ListUsers
//
// Link map shape: { listName: { listValue: email } }.
(function(root) {
  // Build the viewer-facing link projection: { listName: { value: { picture, name } } }.
  //   listUsers: the raw admin-only link map { list: { value: email } }.
  //   profiles:  { email: { shared, picture, name } } — dev: every profile; firebase: the shared set.
  //   isAdmin:   non-admins see only SHARED linked users; admins see every linked user.
  // An entry is emitted when the linked profile offers a picture OR a name; a linked account with
  // neither contributes nothing, so the cell renders the list value alone. No email is ever included.
  //
  // This carries the name as well as the picture because a `userlink-name` list DISPLAYS the linked
  // account's name, and the join it needs cannot happen on the client: the value -> email map is
  // admin-only by design. It discloses nothing further -- every member can already read the shared
  // links and the shared profiles, which is exactly what this joins.
  function buildLinkProjection(listUsers, profiles, isAdmin) {
    var records = [];
    Object.keys(listUsers || {}).forEach(function(list) {
      var links = listUsers[list] || {};
      Object.keys(links).forEach(function(val) {
        var p = (profiles || {})[String(links[val] || '').toLowerCase()];
        if (!p) return;                        // linked account unknown/deregistered -> value only
        if (!isAdmin && !p.shared) return;     // non-admins can't see an unshared profile
        records.push({ list: list, value: val, email: links[val] });
      });
    });
    return projectLinks(records, profiles);
  }

  // THE join, over a FLAT list of link records [{ list, value, email }] rather than the nested map
  // above. Same output, same disclosure rule -- picture and name only, never an email -- and
  // buildLinkProjection is now this function plus the shared/isAdmin gate it has to apply itself.
  //
  // It takes records because that is the shape a STORE hands back: a Firestore query snapshot
  // (backend-firebase) and a kv row list (backend-kv) are both a flat sequence of link documents, and
  // both re-implemented this join inline rather than reshape into the nested map. Three copies of one
  // privacy projection is three places to edit when the disclosure rule changes -- and the two inline
  // ones had drifted already, in that neither applied a shared/isAdmin gate at all.
  //
  // That last part is not a bug there and is not fixed by moving the code: a backend's records have
  // been filtered by Firestore rules or by RLS before they arrive, so the gate has already been
  // applied by something that cannot be talked out of it. The gate stays in buildLinkProjection
  // because the DEV SERVER holds the whole map in process and has no policy layer under it.
  function projectLinks(records, profiles) {
    profiles = profiles || {};
    var out = {};
    (records || []).forEach(function(r) {
      if (!r || !r.list) return;
      var p = profiles[String(r.email || '').toLowerCase()] || {}, entry = {};
      if (p.picture) entry.picture = p.picture;
      if (p.name) entry.name = p.name;         // `userlink-name` lists display this instead of the value
      if (entry.picture || entry.name) (out[r.list] || (out[r.list] = {}))[r.value] = entry;
    });
    return out;
  }

  // The document id a value's link is stored under: 'list~value', both halves percent-encoded so a
  // value containing the separator (or a slash, which Firestore refuses in a doc id) cannot collide
  // with another list's. Byte-identical in both backends before it lived here.
  function linkDocId(listName, value) {
    return encodeURIComponent(String(listName)) + '~' + encodeURIComponent(String(value));
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

  // A value's avatar in a projection, or '' when none. Tolerates the pre-`userlink-name` shape, where
  // the entry WAS the picture string: a client can hold a cached response from before the upgrade.
  function pictureFor(projection, list, value) {
    var entry = ((projection || {})[list] || {})[value];
    if (!entry) return '';
    return typeof entry === 'string' ? entry : (entry.picture || '');
  }

  // A value's linked display name, or '' when the link offers none. Never falls back to the value --
  // the caller decides what to show instead, because that differs by list kind.
  function nameFor(projection, list, value) {
    var entry = ((projection || {})[list] || {})[value];
    return (entry && typeof entry === 'object' && entry.name) || '';
  }

  var M = { buildLinkProjection: buildLinkProjection, projectLinks: projectLinks, linkDocId: linkDocId,
            setLink: setLink, renameValue: renameValue, pictureFor: pictureFor, nameFor: nameFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.ListUsers = M;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
