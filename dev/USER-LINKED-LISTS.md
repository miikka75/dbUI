# User-linked lists (Option C) — design

Link registered users to the string values of *any* people-list, so that wherever
a list value is shown (a `select`/`multiselect` cell, an aggregate group header, the
`piispakunta` view, meeting programs, tasks, discussions…) it can render the linked
user's **avatar** — while the displayed **name stays the curated list value**.

This is the chosen approach ("Option C") over a user-typed column or an auto
name-populated `listSources:"users"` list, because it maps *any* list, is per-list
opt-in, stores a stable identity (email), and needs **no new table**.

## Locked decisions

1. **Display name = the list value.** A cell keeps storing/showing the curated list
   value (e.g. `"Miikka Tuppurainen"`, `"piispa"`). The link only adds an avatar; it
   never overrides the shown name. This keeps naming authority with the org and
   avoids the rename-orphaning a user-typed column would suffer.
2. **The link stores an email** (stable). Avatars/identity re-resolve from the live
   profile, so a photo change propagates automatically.
3. **The value→email link is admin-only data.** Non-admins never receive it. They get
   a privacy-safe projection (`value → picture`, for *shared* linked users only). This
   mirrors `getProfiles` (admin) vs `getSharedProfiles` (all).
4. **`getSharedProfiles` stays keyed by email** (status quo). Option C's projection
   adds no new email exposure; strict re-keying by opaque id is a separate future task.

## Data model

Lists stay arrays of strings. A parallel per-list link map is added:

```json
"listUsers": {
  "seurakuntalaiset": { "Miikka Tuppurainen": "miikka75@gmail.com" },
  "piispakunta":      { "piispa": "a@x.com", "1na": "b@x.com", "2na": "c@x.com" }
}
```

- Key = list **value** (what cells store). Value = linked account **email**.
- 1 value → 1 email. (A list is a set, so a value is one identity; same-named people
  and multi-holder roles are out of scope — pre-existing string-list limits.)

## Enabling it per list

A list opts in via `listSources[name] === 'userlink'` in the schema (distinct from `'users'`,
which auto-populates a list from shared display names). Only `userlink` lists show the admin
"link user" picker in the Lookup editor; a list's curated values are otherwise untouched. This
is how you choose *which* list(s) to map (e.g. `seurakuntalaiset` and/or `piispakunta`). Rendering
is not gated by the flag — any existing link projects an avatar — the flag only governs the editor.

## Behavior / correctness

| Concern | Behavior |
|---|---|
| **Avatar change** | ✅ Resolved live from the profile; never stored. Updates everywhere instantly. |
| **User renames their profile** | ✅ No effect on the roster — display is the list value; only the avatar follows the account. |
| **`@me` on a linked list** | ✅ Resolves to the caller's linked value, not their profile name — so a filter like `{"person": "@me"}` and a `defaultFrom: "@me"` column both work when the two differ. Linked to nothing → fail-closed sentinel, matching no rows. |
| **List value renamed** | ⚠️ The one fragile case: the link (and existing data cells) are keyed by the old string. The list-value rename handler must migrate the `listUsers` key (and data cells) atomically. |
| **Linked user un-shares** | Non-admins lose the avatar (name-only); admins still see the link. |
| **Linked account deleted** | Avatar doesn't resolve → name-only; editor flags "linked user missing". |
| **List value deleted** | Its link is removed in the same edit. |

## Permissions

- **Editing a link:** admin-only (needs the user roster, which non-admins can't read).
  The Lookup editor's "linked user" picker is shown to admins only.
- **Reading the email link:** admin-only for the *whole* map; non-admins receive only
  `value → picture` for shared linked users. No email ever reaches a non-admin —
  **except their own**: `getMyListValues()` returns `{ list: myValue }` for the links that
  name the caller, which is how `@me` resolves to a curated value. It is a rules-provable
  equality query on the caller's own email (`.where('email','==',me)`), the same property
  that makes the shared-only query safe, and it discloses nothing they didn't already know.
- **Seeing the avatar:** a non-admin sees it only when the linked profile is readable
  (the user shared, or the viewer is admin). Otherwise the cell is name-only. The
  **name** is list data, already gated by table access — never by profile sharing.

Backends:
- **Dev server:** `getLists` returns the full `listUsers` to admins and the projected
  `value→picture` to everyone else, computed per request from the caller's role.
- **Firebase:** email links live in an **admin-only** doc; a **world-readable derived
  projection** (`value→picture` for shared linked users) is maintained on write — the
  same derived-public-doc pattern already used for the public roster.

## Build plan (phased, one PR per slice)

1. **Foundation (dev backend + client helpers).** Persist `listUsers`; role-based
   projection in `getLists`; a `setListUser` route + dev-client method; client state
   (`listUsersByList`) + gated resolver `listUserPicture(list, value)`. Unit/e2e tests.
2. **Rendering.** Draw `user-avatar` in list-backed data-view cells (list/table/card
   layouts) and aggregate group headers when a readable link exists. Lights up
   `piispakunta`, meeting programs, tasks, discussions at once.
3. **Lookup editor.** Per-value "linked user" picker (admin-only), name+email options.
4. **Firebase parity.** Admin-only link doc + derived public projection + Firestore
   rules; conformance/emulator tests.
5. **Rename migration.** Carry the link (and cells) on a list-value rename.

Reuses the existing `user-avatar` component, `profilePicture()`, and the
shared/admin profile split shipped in #71/#72/#76.
