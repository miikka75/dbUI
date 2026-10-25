# Public tables (visitors)

`public: true` makes a table readable by signed-out visitors. The app lets a visitor in and shows only views whose tables are public; writes still need a grant. Also readable: those tables' lists, the schema and translations — not users, config or other tables.

![The gym timetable for a signed-out visitor](../screenshots/public-visitor.png)

*The gym timetable for a signed-out visitor*

## Schema

Public table:

```json
{"classes": {"public": true, "columns": ["…"]}}
```

- A public table may not have an owner column or reference a non-public table.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✅ |

## Reference

- [SCHEMA.md → public](../../SCHEMA.md#public-readable-with-no-account)

[← All features](../README.md)
