#!/bin/bash
# vendor-pglite.sh — materialise the PGlite (PostgreSQL-in-WASM) browser dist into vendor/pglite/.
#
# The browser-local backend (backend-local-pglite.js) imports /vendor/pglite/index.js as an ES module,
# and that module then loads pglite.wasm / pglite.data / initdb.wasm by URL RELATIVE TO ITSELF. So the
# files have to sit together under one directory the app serves; there is no single-file build to pin
# the way vue.js and vuetify.js are pinned, and no CDN fallback either — a cross-origin fallback would
# have to be allowed in connect-src, and this mode exists precisely so that nothing external is needed.
#
# Like the rest of vendor/, the output is GENERATED and gitignored. Three callers share this one script
# rather than keeping three copies of the copy list: ./update-vendor.sh (local), the Pages deploy
# workflow, and the web SessionStart hook.
#
# Usage: scripts/vendor-pglite.sh [--force]     (without --force it is a no-op when already present)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/vendor/versions"   # PGLITE

DEST="$ROOT/vendor/pglite"

if [ -f "$DEST/index.js" ] && [ "${1:-}" != "--force" ]; then
  echo "vendor/pglite already present (PGlite ${PGLITE}); pass --force to refetch."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && npm pack "@electric-sql/pglite@${PGLITE}" >/dev/null 2>&1 && tar xzf ./*.tgz )

src="$tmp/package/dist"
mkdir -p "$DEST"
# The ESM entry, the chunks it imports, and the three binaries it fetches by URL. The chunk filenames
# carry an esbuild content hash, so they are matched by pattern rather than listed — a list would rot
# silently at the next version bump, and a missing chunk is a boot failure, not a degraded mode.
# Deliberately NOT copied: the .map files (~2.5 MB of no use to a deployment), the CJS build (Node's
# copy comes from dev/node_modules), and the contrib extension tarballs (fetched on demand, and
# supabase-schema.sql uses no extension).
cp "$src/index.js" "$DEST/"
cp "$src"/chunk-*.js "$DEST/"
cp "$src/pglite.wasm" "$src/initdb.wasm" "$src/pglite.data" "$DEST/"

echo "✓ vendor/pglite — PGlite ${PGLITE} ($(du -sh "$DEST" | cut -f1))"
