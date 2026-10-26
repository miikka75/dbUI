# Share links & multiple databases

Connection details live in the browser, so one hosted copy of the app serves any number of Firebase or Supabase projects. Settings → Users shows the address to share; a link with `?mode=firebase&config=…` or `?mode=supabase&url=…&key=…` connects on open, and `?db=` keeps several databases apart in one browser.

![The share address in Settings → Users](../screenshots/settings-users.png)

*The share address in Settings → Users*

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ❌ data stays in one browser | ✅ | ✅ | — |

## Reference

- [README → Shareable Links](../../README.md#shareable-links-url-params)

[← All features](../README.md)
