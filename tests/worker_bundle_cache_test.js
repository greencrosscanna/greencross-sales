#!/usr/bin/env node
/* THE CLOUDFLARE BUNDLE CACHE — the failure modes that would be invisible in production.
 *
 * This Worker exists so nobody waits on Apps Script's /exec hop, which stalls 30-70% of requests
 * during degraded windows lasting hours (tools/stall-log/). Every bug below paints a plausible
 * screen, which is why they are asserted rather than eyeballed:
 *
 *   - a VERIFICATION TIMEOUT cached as a refusal. During the exact window this Worker exists for,
 *     every auth check times out; caching that as "denied" locks the whole company out of the cache
 *     built to survive the window. The most expensive possible bug in this file.
 *   - a FAILED PULL blanking the last good snapshot. A cache that empties itself when the source is
 *     unreachable is worse than no cache: it fails at precisely the moment it is needed.
 *   - an UNPARSEABLE expiresAt becoming NaN. `NaN > anything` is false, so the Worker would re-mint
 *     a session on every single tick, forever, silently — a mint storm nobody would notice.
 *   - a STALE snapshot served as though it were current. An hour-old cashflow number that does not
 *     say it is an hour old is a wrong number.
 *   - the AUTH PARAM NAME drifting. dutchie_proxy.gs reads `token`/`session`/`auth` and nothing
 *     else, so a `t=` would authenticate as nobody and 401 every user.
 *
 * Executes the shipped worker/src/index.js — not a copy of its logic.
 */
'use strict';
const path = require('path');
const assert = require('assert');

const WORKER = path.join(__dirname, '..', 'worker', 'src', 'index.js');

let passed = 0;
function ok(what, cond) {
  assert.ok(cond, 'FAILED: ' + what);
  passed++;
}

/* A KV stand-in with the three methods the Worker uses, plus a record of every write so a test can
 * assert what was NOT written — which is where most of these bugs live. */
function fakeKV(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  return {
    writes,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { writes.push(key); store.set(key, value); },
    _raw: store,
  };
}

/* Drives global.fetch from a script: each entry answers one call, in order, and the calls made are
 * recorded so the URL contract can be asserted. */
function scriptedFetch(answers) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    const a = answers.shift();
    if (!a) throw new Error('unexpected extra fetch: ' + url);
    if (a === 'timeout') {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    return {
      ok: a.httpOk !== false,
      status: a.status || 200,
      async text() { return typeof a.body === 'string' ? a.body : JSON.stringify(a.body); },
    };
  };
  return calls;
}


/* `scheduled` hands its work to ctx.waitUntil and returns IMMEDIATELY — awaiting the call itself
 * resolves before the job has done anything, so assertions about what it wrote pass vacuously. The
 * first version of section 11 did exactly that and reported three green "zero writes" checks
 * against a job that had not run. Capture the promise and await THAT. */
async function runScheduled(worker, env) {
  let pending = null;
  await worker.scheduled({}, env, { waitUntil: p => { pending = p; } });
  if (pending) await pending;
}

async function main() {
  const mod = await import('file://' + WORKER);
  const worker = mod.default;

  const GOOD_BUNDLE = { ok: true, stores: [{ id: 'river-rd', net: 1234 }] };
  const TOKEN = 'sky:9999999999999:sig';

  /* ── 1. A timeout on verification is not a denial, and is never cached as one ───────────────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now(), payload: GOOD_BUNDLE }) });
    scriptedFetch(['timeout']);
    const res = await worker.fetch(
      new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    ok('a verification timeout refuses this request', res.status === 401);
    ok('a verification timeout writes NO auth verdict to KV',
      !kv.writes.some(k => k.startsWith('auth:')));
  }

  /* ── 2. A successful verification is cached, and the second read makes no network call ──────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now(), payload: GOOD_BUNDLE }) });
    const calls = scriptedFetch([{ body: { ok: true, token: 'renewed' } }]);
    const env = { GX: kv, GX_DEPLOY_SECRET: 's' };
    const a = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), env, {});
    ok('a verified read succeeds', a.status === 200);
    ok('the verdict is cached under a hashed key',
      kv.writes.some(k => /^auth:[0-9a-f]{64}$/.test(k)));
    ok('the token is NEVER the KV key itself', !kv.writes.some(k => k.includes(TOKEN)));

    const b = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), env, {});
    ok('the second read succeeds', b.status === 200);
    ok('the second read makes no further network call', calls.length === 1);
  }

  /* ── 3. The auth param the proxy actually reads ─────────────────────────────────────────────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now(), payload: GOOD_BUNDLE }) });
    const calls = scriptedFetch([{ body: { ok: true } }]);
    await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    /* AUTH_PARAM_NAMES_ in dutchie_proxy.gs is ['token','session','auth']. Anything else
     * authenticates as nobody. */
    ok('the verify call sends token=, the name the proxy reads',
      /[?&]token=/.test(calls[0]) && !/[?&]t=/.test(calls[0]));
  }

  /* ── 4. An unauthorized caller never sees the payload ───────────────────────────────────────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now(), payload: GOOD_BUNDLE }) });
    scriptedFetch([{ body: { ok: false, error: 'Invalid session' } }]);
    const res = await worker.fetch(new Request('https://w/bundle?t=bogus'), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    const text = await res.text();
    ok('a rejected token gets 401', res.status === 401);
    ok('a rejected token sees no cashflow data', !text.includes('1234'));
  }

  /* ── 5. A missing token is refused before any network call is made ──────────────────────────── */
  {
    const kv = fakeKV({});
    const calls = scriptedFetch([]);
    const res = await worker.fetch(new Request('https://w/bundle'), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    ok('no token is a 401', res.status === 401);
    ok('no token costs no network call', calls.length === 0);
  }

  /* ── 6. A stale snapshot says so rather than passing as current ─────────────────────────────── */
  {
    const old = Date.now() - 4000 * 1000; // well past BUNDLE_MAX_AGE_S
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: old, payload: GOOD_BUNDLE }) });
    scriptedFetch([{ body: { ok: true } }]);
    const res = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    const body = JSON.parse(await res.text());
    ok('an hour-old snapshot is flagged stale', body.cache_stale === true);
    ok('it still carries its real age', body.cache_age_s > 3600);
  }

  /* ── 7. A fresh snapshot carries its age and is NOT flagged stale ───────────────────────────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now() - 60000, payload: GOOD_BUNDLE }) });
    scriptedFetch([{ body: { ok: true } }]);
    const res = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    const body = JSON.parse(await res.text());
    ok('a one-minute-old snapshot is not flagged stale', !body.cache_stale);
    ok('a fresh snapshot still reports its age', body.cache_age_s >= 59 && body.cache_age_s <= 62);
    ok('the payload survives the round trip', body.stores[0].net === 1234);
  }

  /* ── 8. A missing snapshot is 503, never an empty-looking success ───────────────────────────── */
  {
    const kv = fakeKV({});
    scriptedFetch([{ body: { ok: true } }]);
    const res = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    const body = JSON.parse(await res.text());
    ok('no snapshot yet is a 503', res.status === 503);
    ok('and says which of the two problems it is', body.error === 'bundle_missing');
  }

  /* ── 9. /health is honest about an empty cache and needs no token ───────────────────────────── */
  {
    const kv = fakeKV({});
    scriptedFetch([]);
    const res = await worker.fetch(new Request('https://w/health'), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    const body = JSON.parse(await res.text());
    ok('/health answers without a token', res.status === 200);
    ok('/health reports the empty cache truthfully', body.has_bundle === false && body.age_s === null);
  }

  /* ── 10. Apps Script's HTML error page is not parsed as data ────────────────────────────────── */
  {
    const kv = fakeKV({ [ 'bundle:v1' ]: JSON.stringify({ fetched_at: Date.now(), payload: GOOD_BUNDLE }) });
    scriptedFetch([{ body: '<!DOCTYPE html><title>Error</title>' }]);
    const res = await worker.fetch(new Request('https://w/bundle?t=' + TOKEN), { GX: kv, GX_DEPLOY_SECRET: 's' }, {});
    ok('an HTML error page is a refusal, not a crash and not a pass', res.status === 401);
  }

  /* ── 11. THE WRITE BUDGET — the scarce resource is writes, not reads ────────────────────────── */
  {
    /* Workers KV free tier: 1,000 writes a day against 100,000 reads. Two writes per tick on a
     * 5-minute cron is 576/day, and Cloudflare emailed Sky at 50% on 2026-10-02 — one day in.
     * Exceeding it does not fail loudly: `put` errors, the cache quietly stops refreshing, and it
     * degrades to stale and then to refusing. A cache that silently stops caching is the exact
     * failure this file already exists to catch one instance of. */
    const BUNDLE = { ok: true, stores: [{ id: 'river-rd', net: 1234 }] };

    // An identical payload must not be written back.
    const kv = fakeKV({
      'service_session': JSON.stringify({ token: 'svc', expires_ms: Date.now() + 7 * 86400000 }),
      'bundle:v1': JSON.stringify({ fetched_at: Date.now() - 60000, payload: BUNDLE }),
      'last_run': JSON.stringify({ ok: true, at: Date.now() - 60000 }),
    });
    scriptedFetch([{ body: BUNDLE }]);
    await runScheduled(worker, { GX: kv, GX_DEPLOY_SECRET: 's' });
    ok('an unchanged snapshot is not written back', !kv.writes.includes('bundle:v1'));
    ok('...and an unchanged OUTCOME is not recorded either', !kv.writes.includes('last_run'));
    ok('so a quiet tick costs ZERO writes', kv.writes.length === 0);
  }

  {
    const BUNDLE = { ok: true, stores: [{ id: 'river-rd', net: 1234 }] };
    const MOVED = { ok: true, stores: [{ id: 'river-rd', net: 9999 }] };
    const kv = fakeKV({
      'service_session': JSON.stringify({ token: 'svc', expires_ms: Date.now() + 7 * 86400000 }),
      'bundle:v1': JSON.stringify({ fetched_at: Date.now() - 60000, payload: BUNDLE }),
      'last_run': JSON.stringify({ ok: true, at: Date.now() - 60000 }),
    });
    scriptedFetch([{ body: MOVED }]);
    await runScheduled(worker, { GX: kv, GX_DEPLOY_SECRET: 's' });
    ok('a CHANGED snapshot is written', kv.writes.includes('bundle:v1'));
  }

  {
    /* A failure is always recorded, even when the previous run also failed in some other way —
     * losing the reason is how a silent job stays silent. */
    const kv = fakeKV({
      'service_session': JSON.stringify({ token: 'svc', expires_ms: Date.now() + 7 * 86400000 }),
      'bundle:v1': JSON.stringify({ fetched_at: Date.now() - 60000, payload: { ok: true } }),
      'last_run': JSON.stringify({ ok: true, at: Date.now() - 60000 }),
    });
    scriptedFetch(['timeout', 'timeout', 'timeout', 'timeout', 'timeout', 'timeout', 'timeout', 'timeout']);
    await runScheduled(worker, { GX: kv, GX_DEPLOY_SECRET: 's' });
    ok('a failing run IS recorded even though the last record was recent',
      kv.writes.includes('last_run'));
    const last = await kv.get('last_run', 'json');
    ok('...and it says it failed', last && last.ok === false);
    ok('a failed pull leaves the last good snapshot in place', !kv.writes.includes('bundle:v1'));
  }

  console.log(passed + ' assertions passed');
}

main().catch(e => { console.error(e.message); process.exit(1); });
