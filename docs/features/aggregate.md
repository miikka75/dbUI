# Aggregates & leaderboards

`groupBy` folds rows sharing a value into one; `aggregate` totals a column over each group. With `period` the reader steps back through months or weeks. `compute` adds per-row values first, e.g. points looked up from a catalogue.

![Monthly points per person (leaderboard, demo)](../screenshots/aggregate-leaderboard.png)

*Monthly points per person (`leaderboard`, demo)*

## Schema

Points per person this month:

```json
{
  "name": "leaderboard",
  "kind": "data",
  "sources": ["chore_log"],
  "mode": "union",
  "groupBy": {"column": "person", "from": ["person"]},
  "compute": [
    {
      "name": "points",
      "computed": {"lookup": {"table": "chores", "match": "chore", "on": "chore", "field": "points"}}
    }
  ],
  "aggregate": {"sum": "points", "into": "total"},
  "columns": ["person", "total"],
  "period": "month",
  "filter": {"done_on": {"within": "@month"}}
}
```

- `aggregate`: `count`, `sum`, `max`, `min`, written `into` a column.
- `groupBy.seed: true` lists every catalogue value, including those with no rows yet.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✅ |

## Reference

- [SCHEMA.md → aggregate views](../../SCHEMA.md#aggregate-views-groupby-collect)
- [SCHEMA.md → leaderboard totals](../../SCHEMA.md#leaderboard-totals-aggregate-countsummaxmin)

[← All features](../README.md)
