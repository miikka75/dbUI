#!/bin/bash
# Update vendor/ files and all version references from vendor/versions
set -e
cd "$(dirname "$0")"
source vendor/versions

# Download vendor files
cd vendor
curl -sfo vue.js "https://cdn.jsdelivr.net/npm/vue@${VUE}/dist/vue.global.prod.js"
curl -sfo vuetify.js "https://cdn.jsdelivr.net/npm/vuetify@${VUETIFY}/dist/vuetify.min.js"
curl -sfo vuetify.css "https://cdn.jsdelivr.net/npm/vuetify@${VUETIFY}/dist/vuetify.min.css"
curl -sfo mdi.css "https://cdn.jsdelivr.net/npm/@mdi/font@${MDI}/css/materialdesignicons.min.css"
# The npm/CDN mdi css lives under css/ and points at ../fonts/. We flatten it to /vendor/mdi.css, so
# rewrite the font ref to ./fonts/ — otherwise ../fonts/ resolves to /fonts/ (404) and the icon glyphs
# never load. (Keep this in sync with .claude/hooks/session-start.sh, which materialises vendor/ in CI.)
sed -i 's#\.\./fonts/#./fonts/#g' mdi.css
mkdir -p fonts
curl -sfo fonts/materialdesignicons-webfont.woff2 "https://cdn.jsdelivr.net/npm/@mdi/font@${MDI}/fonts/materialdesignicons-webfont.woff2"
cd ..

# PGlite (the browser-local Postgres backend) is a DIRECTORY of interdependent files — an ESM entry, its
# content-hashed chunks and three binaries it loads by relative URL — so it comes from npm rather than a
# per-file curl, and the copy list lives in one script the deploy workflow and the CI hook share.
bash scripts/vendor-pglite.sh --force

# Update CDN fallback URLs in index.html
sed -i "s|vue@[0-9.]*|vue@${VUE}|g" index.html
sed -i "s|vuetify@[0-9.]*|vuetify@${VUETIFY}|g" index.html style.html
sed -i "s|@mdi/font@[0-9.]*|@mdi/font@${MDI}|g" style.html
# The PGlite CDN fallback lives in the backend rather than index.html (it is a dynamic import, reached
# only when /vendor/pglite is missing). deploy-config.test.js fails if this drifts from vendor/versions.
sed -i "s|pglite@[0-9.]*|pglite@${PGLITE}|g" backend-local-pglite.js

# Refresh the SRI hashes on the CDN fallbacks (index.html pins integrity for vue.js/vuetify.js;
# jsdelivr /npm/ serves the npm-package bytes verbatim, so hash the downloaded files). Without this,
# a version bump would leave a stale hash and the fallback would always fail the integrity check.
VUE_SRI=$(openssl dgst -sha384 -binary vendor/vue.js | openssl base64 -A)
VUETIFY_SRI=$(openssl dgst -sha384 -binary vendor/vuetify.js | openssl base64 -A)
sed -i "s|vue.global.prod.js', 'sha384-[^']*'|vue.global.prod.js', 'sha384-${VUE_SRI}'|" index.html
sed -i "s|vuetify.min.js', 'sha384-[^']*'|vuetify.min.js', 'sha384-${VUETIFY_SRI}'|" index.html

echo "✓ Updated to Vue ${VUE}, Vuetify ${VUETIFY}, MDI ${MDI}"
