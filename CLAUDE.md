# dbUI — working notes

## UI conventions

Before adding any UI element, find the same kind of element already in the app and reuse it. If nothing
fits, make a shared component, not a one-off. `dev/test/ui-conventions.test.js` fails on the hand-made
versions of the elements below.

| Element | Use |
|---|---|
| One-line value to copy (a link, an address) | `<copy-field :value="…">`: read-only field, copy icon inside |
| Multi-line block to copy (setup dialog's rules) | `<pre>` with an icon copy button over its corner |
| Two-press row action: delete or archive | `<confirm-x :armed="isArmed(key)" @click="handler">` (`action="archive"`, `dense` in data grids). The handler arms with `armConfirm(key)` and acts on the second press |
| Two-press action that needs its words (unsubscribe, stop publishing, reset) | `<confirm-btn :armed="isArmed(key)" icon="…" :label="…" @click="handler">`, armed the same way. Row role by default; `section` for a section action, `full` to keep the label on a phone |
| Collapsible Settings section | `<section-toggle flag="_collapseX" :title="…">`. Collapse when long or rarely used; keep anything urgent (a pending request, an update notice) outside the fold |
| Expanding a row in place | The row's name as a chevron toggle (Settings → Calendars) |

**Buttons** take one of four roles, documented at the top of `settings-view-tpl` in `ui.html`:

| Role | Look |
|---|---|
| Section action (stands alone) | `variant="outlined" size="small"`, icon + text |
| Row action (inside a list row) | `variant="text" size="small"`, icon + text; icon only on a phone (`d-none d-sm-inline` label, kept as `title` and `aria-label`) |
| Icon-only | `variant="text" size="small"`, with `title` and `aria-label` |
| Commit (a form or dialog) | `variant="flat" color="primary"`, normal size; Cancel beside it matches the size |

Destructive buttons keep their role's look and only change colour (`error` / `warning`). Segmented
choices (`v-btn-toggle`) are controls, not buttons.

**Saving.** A form or table row saves on change once it is complete: a user row once it has an email,
a calendar once it has a name and something to show. A new row is a local draft until then. An action
whose effect leaves the app (publishing a link, unsubscribing) is a deliberate button on the row, not a
field that saves as it changes.

**Icons.** The same action uses the same icon everywhere. Calendars: export `mdi-calendar-export`,
subscribe `mdi-calendar-sync`, unsubscribe `mdi-calendar-remove`, publish `mdi-rss`.

**Texts.** One translation key per meaning. Reuse the `btn.*` keys (`btn.delete`, `btn.confirm_delete`,
`btn.edit`, `btn.cancel`, …) instead of minting a per-screen copy. Never build a label from two keys
("Add" + "calendar"); word order belongs to the translator. A tooltip that only repeats the button's
label is the label, not a second key.

**No explanatory sentences by default.** A control's label and its state carry the meaning (an armed
two-press button shows the check mark). Add a sentence only where the screen would otherwise mislead,
e.g. why a link is not there yet.

## Workflow

- Proposals go into `ROADMAP.md` before they are implemented.
- Tests: `cd dev && npm test` (Node), `npx playwright test --config=playwright.config.js` (UI),
  `npm run typecheck`.
- After changing anything under `examples/`, run `node scripts/examples-manifest.js`; it bumps the
  bundle's revision. Then add a release note for that revision in `examples/<id>-about.json`.
