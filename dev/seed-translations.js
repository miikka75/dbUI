#!/usr/bin/env node
// Seed the demo's {{t:}} page-prose translations into the running local dev server.
// Usage: start the server (npm start) + create the local DB, then: node seed-translations.js
const PORT = process.env.PORT || 3000;
const T = {
  'view.combined.header': '# Tasks & Notes',
  'view.combined.footer': '_Tasks are synced from notes._',
  'view.progress_report.header': '# Progress Report',
  'embed.open.title': 'Open',
  'embed.ip.title': 'In Progress',
  'embed.ip.attention': '_Items above need attention._',
  'view.progress_report.footer': '_End of report._'
};
const post = (action, body) => fetch('http://127.0.0.1:' + PORT + '/api/' + action, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());
(async () => {
  await post('createLanguage', { folderId: 'local', code: 'en', name: 'English', keys: Object.keys(T) });
  await post('updateTranslations', { folderId: 'local', langCode: 'en', updates: T });
  console.log('Seeded ' + Object.keys(T).length + ' demo translations into "en".');
})().catch(e => { console.error('Seed failed (is the server running on :' + PORT + '?):', e.message); process.exit(1); });
