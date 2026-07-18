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
mkdir -p fonts
curl -sfo fonts/materialdesignicons-webfont.woff2 "https://cdn.jsdelivr.net/npm/@mdi/font@${MDI}/fonts/materialdesignicons-webfont.woff2"
cd ..

# Update CDN fallback URLs in index.html
sed -i "s|vue@[0-9.]*|vue@${VUE}|g" index.html
sed -i "s|vuetify@[0-9.]*|vuetify@${VUETIFY}|g" index.html style.html
sed -i "s|@mdi/font@[0-9.]*|@mdi/font@${MDI}|g" style.html

# Refresh the SRI hashes on the CDN fallbacks (index.html pins integrity for vue.js/vuetify.js;
# jsdelivr /npm/ serves the npm-package bytes verbatim, so hash the downloaded files). Without this,
# a version bump would leave a stale hash and the fallback would always fail the integrity check.
VUE_SRI=$(openssl dgst -sha384 -binary vendor/vue.js | openssl base64 -A)
VUETIFY_SRI=$(openssl dgst -sha384 -binary vendor/vuetify.js | openssl base64 -A)
sed -i "s|vue.global.prod.js', 'sha384-[^']*'|vue.global.prod.js', 'sha384-${VUE_SRI}'|" index.html
sed -i "s|vuetify.min.js', 'sha384-[^']*'|vuetify.min.js', 'sha384-${VUETIFY_SRI}'|" index.html

echo "✓ Updated to Vue ${VUE}, Vuetify ${VUETIFY}, MDI ${MDI}"
