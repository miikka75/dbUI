// csp-report — CSP violation collector as a Supabase Edge Function.
//
// The Firebase-native collector (functions/index.js) needs the Blaze plan, because Cloud Functions and
// Secret Manager both do. This is the same collector on a free Supabase project, so a deployment can
// soak its Content-Security-Policy without enabling billing anywhere.
//
// It is independent of which backend the app uses. On Firestore, point the policy's `report-uri` at
// this function's URL and nothing else changes; the reports simply land in a Supabase table instead.
//
// Deploy:
//   supabase functions deploy csp-report --no-verify-jwt
//   supabase secrets set DBUI_CSP_REPORT_TOKEN=<long random string>
//
// `--no-verify-jwt` is REQUIRED and is not a loosening: the browser posts violation reports with no
// credentials of any kind and ignores the response, so a function that demands a JWT receives nothing
// and reports nothing. Writes are append-only counters keyed by the violation itself, and the only
// read is gated on the token below.
//
// Storage: public.csp_reports (supabase/csp-reports.sql) — RLS on with no policies, so it is
// unreachable by anon/authenticated; this function reaches it with the service role.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TOKEN = Deno.env.get('DBUI_CSP_REPORT_TOKEN') ?? '';

const MAX_BODY = 64 * 1024;   // a report is a few hundred bytes; anything larger is not one

type Row = { directive: string; blockedURI: string; document: string };

// Both browser report shapes -> flat records. Kept in step with functions/index.js and
// dev/csp-report-collector.js, whose shared test fixtures pin these field names; a copy rather than an
// import because an Edge Function is bundled from this directory alone.
export function normalize(body: string): Row[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  const rows: Row[] = [];
  const push = (r: Record<string, unknown> | undefined | null) => {
    if (!r) return;
    rows.push({
      directive: String(r['violated-directive'] ?? r['effective-directive'] ?? r.effectiveDirective ?? '?'),
      blockedURI: String(r['blocked-uri'] ?? r.blockedURL ?? '?'),
      document: String(r['document-uri'] ?? r.documentURL ?? '?')
    });
  };
  const p = parsed as Record<string, unknown> | unknown[] | null;
  if (p && !Array.isArray(p) && p['csp-report']) push(p['csp-report'] as Record<string, unknown>);
  else if (Array.isArray(p)) p.forEach((x) => push((x as Record<string, unknown>)?.body as Record<string, unknown>));
  return rows;
}

// One row per distinct violation. Bounded, because a directive/URI pair is unbounded in principle
// (a blocked URI can carry a path) and a primary key is not the place to discover that.
export function reportId(r: Row): string {
  return ('v_' + encodeURIComponent(r.directive + ' ' + r.blockedURI)).slice(0, 400);
}

const rest = (path: string, init: RequestInit = {}) =>
  fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  });

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === 'POST') {
    // Content-Type is application/csp-report or application/reports+json, so read the raw text
    // rather than asking for JSON.
    const raw = (await req.text()).slice(0, MAX_BODY);
    const rows = normalize(raw);
    // 204 regardless: browsers ignore the response, and a collector that 500s at a browser teaches
    // it nothing while making the failure invisible. A storage problem is the operator's to find in
    // the function logs, not the reporting page's.
    try {
      await Promise.all(rows.map((r) => rest('rpc/csp_report_record', {
        method: 'POST',
        body: JSON.stringify({ p_id: reportId(r), p_directive: r.directive, p_blocked: r.blockedURI, p_doc: r.document })
      })));
    } catch (e) {
      console.error('csp-report: storing failed', e);
    }
    return new Response(null, { status: 204 });
  }

  if (req.method === 'GET') {
    // Constant-time-ish equality is overkill here (the token gates a violation list, not data), but an
    // EMPTY token must never be a valid one -- an unset secret would otherwise publish the log.
    if (!TOKEN || url.searchParams.get('token') !== TOKEN) {
      return new Response('Forbidden', { status: 403 });
    }
    const res = await rest('csp_reports?select=directive,blocked_uri,sample_document,count,last_seen&order=count.desc');
    if (!res.ok) return new Response('Storage error', { status: 502 });
    const violations = await res.json() as Array<{ count: number }>;
    const total = violations.reduce((n, v) => n + Number(v.count || 0), 0);
    return new Response(JSON.stringify({ total, violations }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(null, { status: 405 });
});
