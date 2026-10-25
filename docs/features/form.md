# Form

A `form` view writes one new row into `form.table`. Fields are listed in `columns`; `required` and `rules` must hold before the submit button commits. `submitColumn`/`submitValue` stamp the row as sent.

![Buying a membership (membership_buy, gym)](../screenshots/form.png)

*Buying a membership (`membership_buy`, gym)*

## Schema

Membership purchase:

```json
{
  "name": "membership_buy",
  "kind": "form",
  "icon": "mdi-card-account-details",
  "form": {
    "table": "memberships",
    "columns": ["plan", "start_on", "valid_until"],
    "required": ["plan", "start_on"],
    "once": false,
    "submitColumn": "order_state",
    "submitValue": "submitted",
    "startLabel": "text.choose_plan",
    "submitLabel": "text.buy",
    "compute": [
      {
        "name": "latest_end",
        "computed": {
          "lookup": {"view": "membership_ends", "match": "owner", "on": "owner", "field": "last_end"}
        }
      }
    ],
    "rules": [
      {
        "require": {"$or": [{"latest_end": {"empty": true}}, {"start_on": {"gt": {"col": "latest_end"}}}]},
        "message": "text.membership_overlap"
      }
    ]
  }
}
```

- `once: true` allows a single submission per member; `startLabel` / `submitLabel` name the buttons.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✅ |

## Reference

- [SCHEMA.md → form](../../SCHEMA.md#form-eighth-view-kind)

[← All features](../README.md)
