/* GX Sales bundle cache — a Cloudflare Worker that stands between the dashboard and Apps Script.
 *
 * WHY THIS EXISTS. Opening Sales is already ONE read of a snapshot the 5-minute trigger built
 * (v2.611) — the app is not doing extra work. The cost is the HOP: Apps Script's /exec fails to
 * return on 30-70% of requests during degraded windows that last hours and clear on their own.
 * Measured across both apps and days (tools/stall-log/): 38/45/31% on 09-25, 40% on 09-29, 31% on
 * 09-30 at 09:35 and 0% the same morning at 11:15, with Crew at 70% and GX Core at 50% on 09-25
 * and every one of them at 0% five days later. It is not one app and it is not the app's code —
 * it is the shared Google account's /exec hop, and nothing in this repo can fix it.
 *
 * So: never make a person wait on that hop. A cron pulls the snapshot every 5 minutes and parks it
 * here; the dashboard reads THIS. A stall now lands on a scheduled job at 03:00 with nobody
 * watching, and the next tick picks it up.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   * It does not hold GC_SESSION_SECRET. Verifying a token's signature locally would be faster,
 *     but that secret signs sessions for the whole suite and this is a brand-new attack surface.
 *     Viewer tokens are verified by ASKING Sales, and the verdict is cached for 10 minutes — the
 *     same cadence the client's own pingSession_ already re-checks the grant on, so this adds no
 *     revocation lag that did not already exist.
 *   * It serves READS only. Expenses, budgets and approvals still POST straight to Apps Script.
 *     A write path through here would need the write guard, the audit log and roleCanEdit, none of
 *     which belong in a cache.
 *   * It never BUILDS a bundle. Same rule as ?action=bundle itself: this reads what the trigger
 *     made. A miss is a miss and says so, rather than triggering a build that belongs to nobody.
 */

const SALES_EXEC = 'https://script.google.com/macros/s/AKfycbzju5HeWTGq_5uND_o6M-Gzdcy-lRQw7flOwzI013Me03SumhV8lYV_O_Z4-cIBn-lp/exec';
const GXCORE_EXEC = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

const KV_BUNDLE   = 'bundle:v1';       // the cached snapshot + when it was fetched
const KV_SESSION  = 'service_session'; // the Worker's own read-only viewer token
const KV_LAST_RUN = 'last_run';        // what the last cron actually DID, not merely that it ran
const AUTH_TTL_S  = 600;               // 10 min — matches the client's own pingSession_ cadence
const BUNDLE_MAX_AGE_S = 3600;         // refuse to serve a snapshot older than this; say so instead

/* Growing timeouts, not a flat one, for the reason gxdevlogin.sh spells out: the two-hop /exec has
 * a cheap fast bounce AND a cold-instance stall of tens of seconds. One number cannot serve both.
 * These run on the CRON, where a long wait costs nobody anything. */
const CRON_TIMEOUTS_MS = [20000, 35000, 50000, 65000];
/* On the REQUEST path a person is waiting, so the budget is short and failure is graceful. */
const AUTH_TIMEOUT_MS = 8000;

async function fetchJson(url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return { ok: false, error: 'http_' + r.status };
    const text = await r.text();
    /* Apps Script answers an error page as HTML, not JSON. Parsing it as JSON throws a message that
     * names neither the app nor the cause, so check the shape first. */
    if (!text.startsWith('{')) return { ok: false, error: 'not_json' };
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/* The Worker's own identity: a READ-ONLY viewer session minted from GX Core with the deploy secret,
 * exactly as gxdevlogin.sh does. Viewer fails roleCanEdit, so even a total compromise of this Worker
 * cannot write to anything. Tokens last 7 days; this re-mints on a miss or a 401. */
async function serviceToken(env, force, trace) {
  if (!force) {
    const held = await env.GX.get(KV_SESSION, 'json');
    /* Re-mint an hour BEFORE expiry, not at it: a token that dies mid-cron costs a whole tick. */
    if (held && held.token && held.expires_ms > Date.now() + 3600000) return held.token;
  }
  if (!env.GX_DEPLOY_SECRET) {
    if (trace) trace.push('mint:no_secret_bound');
    return null;
  }
  const url = `${GXCORE_EXEC}?action=dev_session&secret=${encodeURIComponent(env.GX_DEPLOY_SECRET)}&app=sales`;
  for (const ms of CRON_TIMEOUTS_MS) {
    const r = await fetchJson(url, ms);
    if (trace && !(r && r.ok)) trace.push('mint@' + ms + ':' + ((r && (r.error || r.code)) || 'unknown'));
    if (r && r.ok && r.token) {
      /* dev_session returns `expiresAt` as a STRING, not an epoch. An unparseable one must not
       * become NaN — NaN > anything is false, which would re-mint on every single tick forever.
       * Fall back to 6 days, comfortably inside the 7-day token life. */
      const parsed = Date.parse(r.expiresAt || '');
      await env.GX.put(KV_SESSION, JSON.stringify({
        token: r.token,
        expires_ms: Number.isFinite(parsed) ? parsed : Date.now() + 6 * 86400000,
      }));
      return r.token;
    }
  }
  return null;
}

/* THE CRON. Pull the snapshot, park it. Runs every 5 minutes, which is the cadence the Apps Script
 * trigger rebuilds the bundle on — no point asking faster than it changes. */
/* EVERY OUTCOME IS RECORDED, because "the cron ran" and "the cron worked" are different facts and
 * the platform only reports the first. The first deploy of this Worker fired on schedule, logged
 * `Ok`, and cached nothing for 20 minutes — the handler had not thrown, so nothing anywhere said
 * otherwise. A scheduled job that fails silently is worse than one that never runs: it looks
 * healthy on every dashboard that exists. /health reads this back. */
async function record(env, result) {
  try { await env.GX.put(KV_LAST_RUN, JSON.stringify({ ...result, at: Date.now() })); } catch (e) {}
  return result;
}

async function refresh(env) {
  const trace = [];
  let token = await serviceToken(env, false, trace);
  if (!token) return record(env, { ok: false, error: 'no_session', trace });

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const ms of CRON_TIMEOUTS_MS) {
      const r = await fetchJson(`${SALES_EXEC}?action=bundle&token=${encodeURIComponent(token)}`, ms);
      if (r && r.ok) {
        await env.GX.put(KV_BUNDLE, JSON.stringify({ fetched_at: Date.now(), payload: r }));
        return record(env, { ok: true, bytes: JSON.stringify(r).length, trace });
      }
      trace.push('bundle@' + ms + ':' + ((r && (r.error || r.code)) || 'unknown'));
      /* A 401 means the token died early (revoked, or Core rotated). Re-mint ONCE and retry the
       * whole ladder; do not re-mint per timeout or a bad secret becomes a mint storm. */
      if (r && (r.code === 401 || r.error === 'Auth required')) {
        token = await serviceToken(env, true, trace);
        break;
      }
    }
    if (!token) return record(env, { ok: false, error: 'no_session', trace });
  }
  /* Deliberately leaves the previous snapshot in place. A failed pull is not a reason to blank a
   * good answer — the served payload carries its own age and the client can see it. */
  return record(env, { ok: false, error: 'pull_failed', trace });
}

/* Verify a VIEWER's token by asking Sales, with the verdict cached for AUTH_TTL_S.
 * ?action=ping is the cheapest authenticated route and is what the client already calls every
 * 10 minutes, so this reuses a path that is known to work rather than inventing a check. */
async function authorized(env, token) {
  if (!token) return false;
  /* Key on a hash, never the token itself: KV keys show up in dashboards and logs. */
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const key = 'auth:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');

  const cached = await env.GX.get(key);
  if (cached === 'ok') return true;

  const r = await fetchJson(`${SALES_EXEC}?action=ping&token=${encodeURIComponent(token)}`, AUTH_TIMEOUT_MS);
  if (r && r.ok) {
    await env.GX.put(key, 'ok', { expirationTtl: AUTH_TTL_S });
    return true;
  }
  /* A timeout is NOT a refusal, and must not be cached as one. During a degraded window every
   * verification would fail and this would lock everyone out of the very cache built to survive
   * that window. Unverified means "ask again next time", not "denied forever". */
  return false;
}

/* CORS echoes the caller's origin rather than naming one.
 *
 * That is not laxness, it is the correct boundary here: this endpoint is authorized by a BEARER
 * TOKEN, never by a cookie, so a hostile page that lacks the token learns nothing by being allowed
 * to ask — and a page that HAS the token is already the dashboard. Pinning one origin would
 * meanwhile break three legitimate callers the app genuinely runs as: GitHub Pages, the /exec HTML
 * (which executes in a sandboxed googleusercontent origin, not script.google.com), and localhost
 * under serve.py. */
function jsonWith(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': origin || '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-max-age': '86400',
    },
  });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin') || '*';
    const json = (body, status) => jsonWith(body, status, origin);

    if (request.method === 'OPTIONS') return json({ ok: true });

    /* Liveness, unauthenticated on purpose: it reveals only whether a snapshot exists and how old
     * it is, which is what a monitor needs and what a stranger learns nothing from. */
    if (url.pathname === '/health') {
      const held = await env.GX.get(KV_BUNDLE, 'json');
      const last = await env.GX.get(KV_LAST_RUN, 'json');
      return json({
        ok: true,
        has_bundle: !!held,
        age_s: held ? Math.round((Date.now() - held.fetched_at) / 1000) : null,
        secret_bound: !!env.GX_DEPLOY_SECRET,
        last_run: last,
      });
    }

    /* Run the cron NOW. Deploy-secret gated, the same credential Sales' own ?action=bgrefresh uses.
     * It exists because waiting five minutes to learn whether a one-character fix worked is how a
     * ten-minute diagnosis becomes an hour. */
    if (url.pathname === '/refresh') {
      const given = url.searchParams.get('secret') || '';
      if (!env.GX_DEPLOY_SECRET || given !== env.GX_DEPLOY_SECRET) {
        return json({ ok: false, error: 'Forbidden' }, 403);
      }
      return json(await refresh(env));
    }

    if (url.pathname === '/bundle') {
      const token = (request.headers.get('authorization') || '').replace(/^Bearer /i, '') || url.searchParams.get('t');
      if (!(await authorized(env, token))) return json({ ok: false, error: 'Unauthorized', code: 401 }, 401);

      const held = await env.GX.get(KV_BUNDLE, 'json');
      if (!held) return json({ ok: false, error: 'bundle_missing' }, 503);

      const age = Math.round((Date.now() - held.fetched_at) / 1000);
      if (age > BUNDLE_MAX_AGE_S) {
        /* Say it is stale rather than pretending. The client decides whether an hour-old cashflow
         * figure is usable; this Worker does not get to make that call silently. */
        return json({ ...held.payload, cache_age_s: age, cache_stale: true });
      }
      return json({ ...held.payload, cache_age_s: age });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  },
};
