// functions/index.js — CSP report collector as a Cloud Function behind the Hosting rewrite
// /csp-report (firebase.json). Same-origin with the app, so csp.js can use a relative report-uri —
// no separate collector host, reverse proxy, or certificate.
//
// REQUIRES the Blaze (pay-as-you-go) plan (Cloud Functions). Cost is bounded: maxInstances 1,
// aggregate-at-write (one small doc per distinct violation, incremented — reads stay tiny and the
// collection can't grow per-report).
//
// Storage: Firestore collection `_csp_reports`. Leading underscore => the client catch-all rule in
// firestore.rules denies all client access; only this function (Admin SDK, bypasses rules) touches it.
//
// Reading: GET /csp-report?token=<DBUI_CSP_REPORT_TOKEN> returns { total, violations: [...] } sorted by
// count. Set the secret once: firebase functions:secrets:set DBUI_CSP_REPORT_TOKEN
//
// NOTE: normalize() is intentionally a self-contained copy of dev/csp-report-collector.js's —
// Cloud Functions deploys ONLY this directory, so requiring across the repo root won't package.
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();
const TOKEN = defineSecret('DBUI_CSP_REPORT_TOKEN');

// Both browser report shapes -> flat records (classic {"csp-report": {...}} and report-to array).
function normalize(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { return []; }
  const rows = [];
  const push = (r) => { if (r) rows.push({
    directive: r['violated-directive'] || r['effective-directive'] || r.effectiveDirective || '?',
    blockedURI: r['blocked-uri'] || r.blockedURL || '?',
    document: r['document-uri'] || r.documentURL || '?'
  }); };
  if (parsed && parsed['csp-report']) push(parsed['csp-report']);
  else if (Array.isArray(parsed)) parsed.forEach(x => push(x && x.body));
  return rows;
}

// Firestore doc id for a violation key: encode (no '/') and bound the length.
function docId(r) { return ('v_' + encodeURIComponent(r.directive + ' ' + r.blockedURI)).slice(0, 400); }

exports.cspReport = onRequest({ secrets: [TOKEN], maxInstances: 1, cors: false }, async (req, res) => {
  const db = admin.firestore();
  if (req.method === 'POST') {
    // Content-Type is application/csp-report or application/reports+json -> use the raw body.
    const body = (req.rawBody || Buffer.alloc(0)).toString('utf8').slice(0, 64 * 1024);
    const rows = normalize(body);
    await Promise.all(rows.map((r) => db.collection('_csp_reports').doc(docId(r)).set({
      directive: r.directive, blockedURI: r.blockedURI, sampleDocument: r.document,
      count: admin.firestore.FieldValue.increment(1),
      lastSeen: new Date().toISOString()
    }, { merge: true })));
    return res.status(204).end();   // browsers ignore the response either way
  }
  if (req.method === 'GET') {
    if (!TOKEN.value() || req.query.token !== TOKEN.value()) return res.status(403).send('Forbidden');
    const snap = await db.collection('_csp_reports').get();
    const violations = [];
    let total = 0;
    snap.forEach((d) => { const v = d.data(); violations.push(v); total += v.count || 0; });
    violations.sort((a, b) => (b.count || 0) - (a.count || 0));
    return res.status(200).json({ total, violations });
  }
  return res.status(405).end();
});
