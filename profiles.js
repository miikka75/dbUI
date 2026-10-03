// profiles.js — The rules for showing a person: their name, their face, and what saving a profile writes.
// Framework-agnostic + Node-tested, mirroring reorder.js / brand.js.
//   Browser: <script src="/profiles.js">, then Profiles.label(byEmail, email, isAdmin). Node: const Profiles = require('../profiles').
//
// WHY THIS EXISTS: `userLabel` is a PRIVACY rule, not a formatting one. A user who has not shared a
// profile is shown to an admin by their email and to everybody else as nobody at all, because a member
// list that falls back to the address hands every member everyone's email. It is the single source of that
// rule for user-avatar, user-ref and the rsvp roster, and it had no test below the full UI suite. The same
// goes for the rule that sharing needs a name: an unnamed shared profile surfaces as a blank entry in every
// user-backed list.
//
// WHAT IS NOT HERE: loading and saving. Those call backend_users and stay in app-core; this module only
// decides what a profile reads as, and what a save would write.
(function(root) {
  // Picture cap, in characters of the data URL. firestore.rules and supabase-schema.sql both refuse a
  // larger `picture`, so a client that sent one would only find out from a failed save.
  var PICTURE_CAP = 350000;

  function key(email) { return String(email || '').toLowerCase(); }

  // A stored profile in the shape the app holds: every field present, so a template never reads undefined.
  function normalize(p) {
    return { name: (p && p.name) || '', shared: !!(p && p.shared), picture: (p && p.picture) || '' };
  }

  // Opted-in display name for an email, or ''. Callers pick their own fallback.
  function name(byEmail, email) { return ((byEmail || {})[key(email)] || {}).name || ''; }

  // Avatar for an email, or ''. `me` ({ email, picture }) short-circuits your own face, so it renders
  // everywhere at once -- before (or without) sharing, and fresher than any copy in byEmail.
  function picture(byEmail, email, me) {
    var e = key(email);
    if (e && me && e === key(me.email)) return me.picture || '';
    return ((byEmail || {})[e] || {}).picture || '';
  }

  // The DISPLAY label: their shared name, else the raw email ONLY for an admin, else ''.
  function label(byEmail, email, isAdmin) { return name(byEmail, email) || (isAdmin ? (email || '') : ''); }

  // What saving `draft` would write, and whether it differs from `saved` (the last thing written). Sharing
  // requires a name, so clearing the name also drops the opt-in; the caller mirrors `shared` back into its
  // model so the toggle shows the real state. `changed` is false for a plain focus-out, so a blur does not
  // churn the backend and every user-backed list behind it.
  function toSave(draft, saved) {
    var n = String((draft && draft.name) || '').trim();
    var out = { name: n, shared: !!(draft && draft.shared) && !!n, picture: (draft && draft.picture) || '' };
    out.changed = !(saved && saved.name === out.name && saved.shared === out.shared && saved.picture === out.picture);
    return out;
  }

  var M = { PICTURE_CAP: PICTURE_CAP, normalize: normalize, name: name, picture: picture, label: label, toSave: toSave };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else root.Profiles = M;
})(typeof self !== 'undefined' ? self : this);
