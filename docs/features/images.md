# Images & links

An `image` cell stores a reference, never the bytes: a URL, or `asset:<id>`. Upload re-encodes the picture in the browser (dropping GPS metadata) and sends it to the backend's file storage; without storage it is stored in the database, downscaled to fit. A `url` cell is an editable link.

![Gallery over an image column (demo)](../screenshots/data-view-gallery.png)

*Gallery over an image column (demo)*

## Schema

Image and link columns:

```json
[{"name": "photo", "type": "image"}, {"name": "link", "type": "url"}]
```

- SVG is never accepted as an image (it can carry script).
- View backgrounds and menu tiles (Settings → Appearance) always store in the database.

## Backends

| In this browser | Supabase | Firebase | Dev server |
|---|---|---|---|
| ⚠️ stored in the database | ✅ | ⚠️ Storage needs Blaze; else in the database | ✅ |

## Reference

- [SCHEMA.md → column types](../../SCHEMA.md#column-types)
- [SCHEMA.md → where the bytes live](../../SCHEMA.md#where-the-bytes-live)

[← All features](../README.md)
