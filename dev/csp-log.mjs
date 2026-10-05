#!/usr/bin/env node
// csp-log.mjs — print the CSP violation log, the way Settings -> Security policy reports shows it.
//
//   DBUI_CSP_REPORT_TOKEN=<token> npm run csp:log [-- endpoint]
//
// The endpoint defaults to the one index.html carries (written there by `npm run csp:sync`). Reports
// from browser extensions are counted apart, as on the panel: the page cannot act on them.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CspClient = require('../csp-client.js');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const meta = /<meta name="csp-report-endpoint" content="([^"]*)">/.exec(html);
const endpoint = process.argv[2] || (meta && meta[1]) || '';
const token = process.env.DBUI_CSP_REPORT_TOKEN || '';
if (!endpoint) { console.error('No endpoint: reporting is off in index.html, and none was given.'); process.exit(1); }
if (!token) { console.error('Set DBUI_CSP_REPORT_TOKEN.'); process.exit(1); }

try {
  const log = await CspClient.readLog(endpoint, token, fetch);
  if (!log.site.length) console.log('No violations from the site.');
  log.site.forEach((r) => console.log(`${String(r.count).padStart(6)}  ${r.directive.padEnd(16)} ${r.blockedURI}  (last ${r.lastSeen.slice(0, 10)}, on ${r.document})`));
  const ext = log.extensions.reduce((n, r) => n + r.count, 0);
  if (ext) console.log(`\n${ext} more from browser extensions (${log.extensions.length} distinct).`);
} catch (e) {
  console.error(e.status === 403 ? 'The collector refused the token.' : `The collector could not be read: ${e.message}`);
  process.exit(1);
}
