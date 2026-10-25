# Pages & embeds (documents)

A view with `markdown` is a page. `{{view:x}}` and `{{table:x}}` embed live data that edits in place; `{{self}}` places the view's own grid; a trailing `?` hides an empty embed; `@archive` / `@both` show the archive. The body is stored in the database, so an admin edits it with the pencil without touching the schema. `access` restricts a page to some users.

![A page mixing prose and an editable embedded grid (showcase, demo)](../screenshots/document.png)

*A page mixing prose and an editable embedded grid (`showcase`, demo)*

## Schema

Page with embeds:

```json
{
  "name": "home",
  "kind": "page",
  "markdown": "# Welcome\n\nOpen items:\n\n{{view:open_tasks?}}\n\nAll tasks:\n\n{{table:tasks@both}}"
}
```

Restricted page:

```json
{"name": "doc_internal", "kind": "page", "access": ["admin"], "markdown": "…"}
```

- `{{t:key}}` inserts a translation; `filters` on a page add reader filters above its embeds.
- Every embed kind renders as itself: calendar, board, stats, form, timeline, RSVP…

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✅ |

## Reference

- [SCHEMA.md → markdown (documents)](../../SCHEMA.md#markdown-documents)
- [SCHEMA.md → restricting a page](../../SCHEMA.md#restricting-a-page-to-some-users-access)

[← All features](../README.md)
