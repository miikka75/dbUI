# Examples

Databases you can install from the app (Settings → Examples, or the offer an empty database makes).
Structure lives here in git; rows live in whichever backend you connect.

| Example | What it is |
|---|---|
| `bishopric` | A congregation's meeting and administration tool: join and union views, doc pages with embeds, a board laned by a lookup, rotations, computed columns, user-linked lists. |
| `chores` | A household chore tracker: self-service logging, approvals, points leaderboards, rewards, a weekly rota, a shopping list. |
| `gym` | A gym's member app: public timetable, open sign-up, class booking with places and walk-ins, check-in by changing code, memberships with pauses, a training log, rewards, staff boards, statistics. |
| `demo` | The widest one, and the one the test suite runs against. |

## Files

Each example is a set of files named so `scripts/examples-manifest.js` can place them:

| File | Contents |
|---|---|
| `<id>-schema.json` | Tables, columns, views, nav, list names, and the lookup rows the schema depends on. |
| `<id>-lang-<code>.json` | Labels for that schema: `tab.*`, `field.*`, `view.*`, `list.*`, `text.*`. |
| `<id>-data.json` | Optional sample rows, in the shape Export writes. |
| `<id>-about.json` | A one-line description and a note per revision. |
| `<id>-favicon.svg`, `<id>-icon-512.png` | The example's own tab and install icons (`schema.icons`). |
| `app-lang-<code>.json` | The app's own UI text, for any schema. |
| `index.json` | Generated: every file with a hash and the example's revision. |

## Changing an example

1. Edit the files.
2. `node scripts/examples-manifest.js`: the revision becomes N. A test fails if you skip this.
3. Add `"N": "<what changed>"` to `<id>-about.json` and run the generator again (the revision stays N).

Installed databases then see in Settings that their example has an update, with the notes since their
revision. Reinstalling replaces the schema and merges the labels; lists that already have values are left
alone. Export first if the schema was edited in the app.

## Rows a bundle ships

An import merges rows by `id`, so shipped ids are a contract with every database that installed them:

- **Never renumber** a shipped row; a reinstall would add a second one. `dev/test/lookup-row-ids.test.js`
  catches it.
- Give a new row a content-derived id: `Examples.lookupRowId('rc', [organization, calling])` →
  `rc-primary-secretary`.
- Leave gaps in `position` (10, 20, 30).
- A rename is an add plus an orphan: an import never deletes.
- **No users in a bundle.** Accounts, grants, profiles and list links are per-deployment security data;
  the importer ignores them. `npm run seed:import -- <id>` seeds an example's demo people on the dev
  server only.

## Values a schema names are part of it

A lookup table, and the list values a view's filter names, ship with the schema; rosters do not.

- `bishopric` ships its role slots (`bishop`, `counselor1`, `counselor2`), the 14 `ref_statuses` rows its
  board lanes by, and the 99-row `ref_callings` catalogue. Stored values are codes
  (`under_discussion`, `relief_society`); the words come from `list.<table>.<code>` translations.
- Every other list starts empty (`members`, `hymns`, …).

## Names

Identifiers are domain-prefixed, so alphabetical order is logical order: `meeting_`, `duty_`, `admin_`,
`doc_` (doc pages), `ref_` (lookups). Views and tables are separate namespaces (`view.*`, `tab.*`).
Column labels are global: `field.date` serves every `date` column.

## Notes on `chores`

- `chore_log` and `reward_claim` have an `owner` column: members log their own rows without a table
  grant. `ownerWritable` keeps `status` out of their hands, so a parent approves.
- `members` is a `userlink` list: link each value to an account in the Lookup tab, so *My chores* and
  `@me` follow the signed-in person.
- Suggested access: parents `admin`; others `editor` with view-only `ref_chores` / `ref_rewards`, edit on
  `home_shopping`, and no grant on the owner tables.
- The sample data's dates are fixed, so the week and month leaderboards age out; step back with ‹ ›.
- Not expressible yet: recurring chores, and "not done for three weeks".
