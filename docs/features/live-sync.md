# Live sync

When a backend can push changes, the app subscribes to the tables of the screen being viewed and applies each change as it arrives. A change to a cell you are editing waits until you leave the cell. Two people editing different columns of one row do not overwrite each other: writes send only the changed column.

- No UI of its own and no schema.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| — one tab, nothing to sync | ✅ | ✅ | ✅ |

## Reference

- [BACKEND_API.md → Live sync](../../BACKEND_API.md#live-sync-subscribetable)

[← All features](../README.md)
