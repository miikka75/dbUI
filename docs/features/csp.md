# Content-Security-Policy & reports

The app ships one policy from `csp.js`: an enforcing `<meta>` tag on static hosts, a header on Firebase Hosting and in every E2E run. Violations can be posted to a collector (a Supabase Edge Function, a Cloud Function or a self-hosted script) and read in Settings → Security policy reports.

- Reporting is off until a collector is configured.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ✅ | ✅ | ✅ | ✅ |

## Reference

- [README → Content-Security-Policy](../../README.md#content-security-policy)

[← All features](../README.md)
