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
// That secret is only the FIRST token. `POST ?rotate&token=<current>` swaps it for a fresh one kept in
// public.csp_report_token (Settings -> Security policy reports has the button), after which the
// environment value opens nothing.
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

// CORS. A report posted by the PAGE (csp-client.js) is cross-origin, and only three Content-Type
// values are CORS-safelisted; anything else preflights. csp-client.js sends text/plain precisely so it
// does not, but a preflight must still be answered rather than 405'd -- otherwise a collector that
// looks reachable drops every report from any client that sends a real `application/csp-report`,
// silently, because a browser never surfaces a failed beacon.
//
// `*` is the right origin here: a violation report carries no credentials and no secrets, the endpoint
// is necessarily public (a browser cannot authenticate one), and the interesting clients are exactly
// the origins we cannot enumerate. The token-gated GET is what actually protects anything.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Max-Age': '86400'
};

// Is `token` the read token? The stored one once a rotation has happened, else the environment's --
// decided in SQL (csp_report_token_ok), so the rule is in one place and tested there.
//
// The ONE fallback is a 404: the function does not exist, so csp-reports.sql predates rotation and no
// row can exist either, and the environment token is still the token. Any other failure denies. Falling
// back on a 5xx would let a token rotated BECAUSE it leaked open the log again whenever storage hiccups.
async function tokenOk(token: string): Promise<boolean> {
  const res = await rest('rpc/csp_report_token_ok', { method: 'POST', body: JSON.stringify({ p_token: token, p_env: TOKEN }) });
  if (res.status === 404) return !!TOKEN && token === TOKEN;
  if (!res.ok) return false;
  return (await res.json()) === true;
}

function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Rotation, before the report branch: a report is a POST with no query at all. Authorised by the
  // token being rotated, and the new one is answered ONCE -- nothing reads it back afterwards.
  if (req.method === 'POST' && url.searchParams.has('rotate')) {
    const next = newToken();
    const res = await rest('rpc/csp_report_rotate', {
      method: 'POST',
      body: JSON.stringify({ p_current: url.searchParams.get('token') ?? '', p_env: TOKEN, p_new: next })
    });
    if (res.status === 404) return new Response('Apply supabase/csp-reports.sql again', { status: 501, headers: CORS });
    if (!res.ok) return new Response('Storage error', { status: 502, headers: CORS });
    if ((await res.json()) !== true) return new Response('Forbidden', { status: 403, headers: CORS });
    return new Response(JSON.stringify({ token: next }), {
      status: 200, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)
    });
  }

  if (req.method === 'POST') {
    // Content-Type is application/csp-report or application/reports+json, so read the raw text
    // rather than asking for JSON.
    const raw = (await req.text()).slice(0, MAX_BODY);
    const rows = normalize(raw);
    // 204 regardless: browsers ignore the response, and a collector that 500s at a browser teaches
    // it nothing while making the failure invisible. A storage problem is the operator's to find in
    // the function logs, not the reporting page's.
    //
    // res.ok IS CHECKED, and that is not defensive tidiness -- it is the difference between the
    // sentence above being true and being a lie. `fetch` rejects only on a NETWORK failure; an HTTP
    // 404 (the RPC missing, or PostgREST's schema cache still stale after the SQL ran) or a 401 (a
    // service key that is unset or disabled) resolves perfectly happily. So the original
    // try/catch caught nothing, logged nothing, and returned 204: every report was dropped in
    // complete silence, with no exception, no log line, and an empty table that looks exactly like a
    // healthy site. That cost an afternoon of looking in the wrong place.
    try {
      const results = await Promise.all(rows.map((r) => rest('rpc/csp_report_record', {
        method: 'POST',
        body: JSON.stringify({ p_id: reportId(r), p_directive: r.directive, p_blocked: r.blockedURI, p_doc: r.document })
      })));
      for (const res of results) {
        if (res.ok) continue;
        // The body carries PostgREST's actual complaint ("Could not find the function", a permission
        // denial, a schema-cache miss), which is the whole value of logging at all.
        const detail = await res.text().catch(() => '');
        console.error('csp-report: storing failed', res.status, detail.slice(0, 500));
      }
    } catch (e) {
      console.error('csp-report: storing failed (network)', e);
    }
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method === 'GET') {
    // Constant-time-ish equality is overkill here (the token gates a violation list, not data), but an
    // EMPTY token must never be a valid one -- an unset secret would otherwise publish the log. Both are
    // csp_report_token_ok's to decide.
    if (!(await tokenOk(url.searchParams.get('token') ?? ''))) {
      return new Response('Forbidden', { status: 403, headers: CORS });
    }
    const res = await rest('csp_reports?select=directive,blocked_uri,sample_document,count,last_seen&order=count.desc');
    if (!res.ok) return new Response('Storage error', { status: 502, headers: CORS });
    const violations = await res.json() as Array<{ count: number }>;
    const total = violations.reduce((n, v) => n + Number(v.count || 0), 0);
    // CORS on the READ too, not just the write. Without it the log is curl-only: a browser fetch is
    // refused for want of Access-Control-Allow-Origin, which is exactly how the Settings panel proposed
    // in ROADMAP.md would fail, and how reading it from the app's own console fails today.
    return new Response(JSON.stringify({ total, violations }), {
      status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
    });
  }

  return new Response(null, { status: 405 });
});
