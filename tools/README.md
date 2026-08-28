# One-shot tools

Not part of the app, and not run by CI. Each of these existed to move one deployment once; they live on
this branch so they are findable later without cluttering `main`.

## `bishopric-fi-to-en.js`

Converts an export of the **Finnish original** of the bishopric schema into the vocabulary
`examples/bishopric-schema.json` ships in. The example IS that schema, renamed to English, which is what
makes a mechanical conversion possible — and worth doing, since a database speaking the example's
vocabulary can then be kept up to date from the example.

```bash
node tools/bishopric-fi-to-en.js <export.json> [-o converted.json]
node --test tools/bishopric-fi-to-en.test.js      # 15 tests, run it first
```

It emits **data only** — tables, lists, doc-view bodies and rotation config. Not the schema (install the
example instead, so the two cannot silently diverge) and not the translations
(`examples/bishopric-lang-fi.json` already is that ward's Finnish, re-keyed); it prints the two strings
that name a particular ward for pasting back by hand.

It **refuses to write** anything it could not map, listing exactly what it did not recognise — the
output is imported over a live database, and a silently dropped column is a column of data lost.

The test resolves the current `examples/bishopric-schema.json`, so run it before converting: it fails if
the example has moved on from the mapping.
