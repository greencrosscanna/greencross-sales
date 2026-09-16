#!/usr/bin/env node
/* ─── Sales speed for the Inventory tab comes through GX Core — and "nothing" is never a green 0 ───
 *
 *   RUN:  node tests/velocity_via_core_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Until 2026-09-14 the browser fetched velocity straight from a hardcoded Inventory /exec that no
 * other repo referenced. Measured that day, it answered {"stores":{},"lastSynced":"2026-08-11…"}: a
 * valid, EMPTY map. loadVelocity accepted it, so the Critical tile ("under 3 days on hand") counted
 * nothing and showed a confident green 0. Apps talk through GX Core, never to each other.
 *
 * EXECUTES the shipped getVelocity_ (backend) and loadVelocity (frontend).
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const GS   = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(src, name) {
  const m = new RegExp('(async\\s+)?function ' + name + '\\s*\\(').exec(src);
  if (!m) { console.log('  FAIL  function ' + name + ' not found'); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }
  let i = src.indexOf('{', m.index), d = 0;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1); }
}
const SIX = [{core:'bend',dutchie:'Bend',sales:'Bend'},{core:'river-rd',dutchie:'River Rd',sales:'River'}];

function backend(getVelocity, cache) {
  const store = cache || {};
  const ctx = {
    GXCore: { getVelocity },
    salesStores_: () => SIX,
    cacheGet_: k => store[k] || null,
    cacheSet_: (k, v) => { store[k] = v; },
    Utilities: { formatDate: () => '2026-09-14T12:00:00' },
    _cache: store,
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;', ctx);
  /* The REAL scrub, not a stub: every exception this suite drives now also proves the
     credential scrub runs on the way out. See gxScrub_ in dutchie_proxy.gs. */
  vm.runInContext(grab(GS, 'gxScrub_') + '\n' + grab(GS, 'errText_'), ctx);
  vm.runInContext([grab(GS, 'hasOwn_'), /const VELOCITY_CACHE_KEY_ = [^\n]*/.exec(GS)[0], grab(GS, 'getVelocity_'),
                   'this.getVelocity_ = getVelocity_;'].join('\n'), ctx);
  return ctx;
}
const row = (store, name, v) => Object.assign({ store, product_name: name, sku: 12345, vel7: 0, vel14: 0, vel30: 0 }, v);

console.log('\n1. backend — reads GX Core and keys by the Dutchie name the client maps to');
{
  let asked = null;
  const B = backend(s => { asked = s; return [
    row('bend', 'Gummy', { vel14: 3 }), row('river-rd', 'Joint', { vel30: 0.5 }),
    row('bend', 'Dead SKU', {}), row('bend', 'Unknown', { vel7: 9 }), row('salem', 'Elsewhere', { vel7: 1 }),
  ]; });
  const r = B.getVelocity_({});
  ok(asked === '', 'asks GX Core for all stores in one call');
  ok(r.ok === true && r.source === 'gxcore', 'answers ok, sourced from GX Core');
  ok(r.stores.Bend && r.stores.Bend.Gummy.vel14 === 3, 'Bend keyed by its Dutchie name');
  ok(r.stores['River Rd'] && r.stores['River Rd'].Joint.vel30 === 0.5, "River keyed 'River Rd' — what STORE_TO_VEL maps River to");
  ok(r.stores.Bend.Gummy.sku === '12345', 'sku is a string, so the client can compare it to inventory skus');
  ok(!r.stores.Bend['Dead SKU'] && !r.stores.Bend.Unknown, 'non-selling and Unknown products are not sent');
  ok(!r.stores.Elsewhere && r.kept === 2 && r.rows === 5, 'a store Sales does not know is dropped, and the counts say so');
  ok(!!B._cache.velocity_v1, 'a good answer is cached');
}

console.log('\n2. backend — an empty or failed answer is an ERROR, and is not cached');
{
  const E = backend(() => []);
  const e = E.getVelocity_({});
  ok(e.ok === false && /no selling products/.test(e.error), 'no velocity rows => ok:false with a reason, never an empty map');
  ok(!E._cache.velocity_v1, 'and nothing is cached');
  const Z = backend(() => [row('bend', 'Dead', {})]);
  ok(Z.getVelocity_({}).ok === false, 'rows that are all non-selling => still an error');
  const T = backend(() => { throw new Error('Core exploded'); });
  const t = T.getVelocity_({});
  ok(t.ok === false && /GX Core velocity unavailable/.test(t.error) && !T._cache.velocity_v1, 'a throwing Core => named error, not cached');
}

console.log('\n3. backend — cache served, nocache bypasses, a corrupt entry costs a read');
{
  let calls = 0;
  const B = backend(() => { calls++; return [row('bend', 'Gummy', { vel7: 1 })]; });
  B.getVelocity_({}); B.getVelocity_({});
  ok(calls === 1, 'second call served from cache');
  B.getVelocity_({ nocache: '1' });
  ok(calls === 2, 'nocache re-reads GX Core');
  B._cache.velocity_v1 = '{not json';
  ok(B.getVelocity_({}).ok === true && calls === 3, 'a corrupt cache entry falls through to a read');
}

console.log('\n4. routing — no app-to-app call is left');
{
  ok(!/VEL_PROXY_URL/.test(HTML), 'VEL_PROXY_URL is gone');
  const execs = [...new Set((HTML.match(/https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/g) || []))];
  const core = /const GXCORE = '([^']+)'/.exec(HTML)[1];
  const proxy = /DEFAULT_PROXY\s*=\s*'([^']+)'/.exec(HTML);
  // The ONE sanctioned exception: fetchLeaderboardGoalsDirect, the documented goal fallback used only when
  // GX Core's published_goals cannot answer, whose URL comes from GX Core config (lbGoals). It is named
  // here rather than pattern-allowed, so a third address anywhere fails this test.
  const lb = /let LEADERBOARD_GAS = '([^']+)'/.exec(HTML);
  const allowed = new Set([core, proxy && proxy[1], lb && lb[1]].filter(Boolean));
  const foreign = execs.filter(u => !allowed.has(u));
  ok(foreign.length === 0, 'index.html reaches only GX Core, its own backend, and the documented Leaderboard goal fallback' + (foreign.length ? ' — found ' + foreign.join(', ') : ''));
  ok(/params\.action === 'velocity'\)\s+return jsonOut_\(getVelocity_\(params\)\)/.test(GS), 'the backend serves ?action=velocity');
  const gateAt = GS.indexOf('const auth = requireAuth_(params);');
  ok(gateAt > 0 && GS.indexOf("params.action === 'velocity'") > gateAt, 'and only behind the sign-in gate');
}

// ── Frontend ─────────────────────────────────────────────────────────────────
async function frontend(answer, cached) {
  const ctx = {
    console: { warn() {} }, Date, Object, encodeURIComponent,
    readCache: () => cached || null, writeCache: (k, v) => { ctx._written = v; },
    getProxyUrl: () => 'https://proxy', getToken: () => 'tok',
    gasFetchJson: async (url) => { ctx._url = url; if (answer instanceof Error) throw answer; return answer; },
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;', ctx);
  /* The REAL scrub, not a stub: every exception this suite drives now also proves the
     credential scrub runs on the way out. See gxScrub_ in dutchie_proxy.gs. */
  vm.runInContext(grab(GS, 'gxScrub_') + '\n' + grab(GS, 'errText_'), ctx);
  vm.runInContext(['let velocityError = null; let _velocityTriedAt = 0; let velocityData = null;',
                   grab(HTML, 'loadVelocity'),
                   'this.run = async () => { await loadVelocity(); return { velocityData, velocityError, _velocityTriedAt }; };'].join('\n'), ctx);
  const r = await ctx.run();
  return Object.assign(r, { url: ctx._url, written: ctx._written });
}

(async () => {
  console.log('\n5. frontend — the empty map that caused the green 0 is refused');
  {
    const r = await frontend({ stores: {}, lastSynced: '2026-08-11T23:29:55.461Z' });
    ok(r.velocityData === null, 'an empty store map does NOT count as loaded');
    ok(!!r.velocityError, 'it is recorded as unavailable');
    ok(!r.written, 'and not cached');
    ok(r._velocityTriedAt > 0, 'the attempt is stamped, so the render it triggers does not re-fire it');
  }
  console.log('\n6. frontend — a real answer loads, through this app\'s backend');
  {
    const good = { ok: true, stores: { Bend: { Gummy: { vel14: 3 } } } };
    const r = await frontend(good);
    ok(r.velocityData === good && r.velocityError === null && r.written === good, 'loaded, cached, no error');
    ok(/^https:\/\/proxy\?action=velocity&token=tok$/.test(r.url), 'asked its own backend with the session token');
    const f = await frontend(new Error('timed out'));
    ok(f.velocityData === null && f.velocityError === 'timed out', 'a network failure is recorded, not swallowed');
    const c = await frontend(good, { stores: {} });
    ok(c.velocityData === good, 'an empty CACHED copy is ignored and re-asked');
  }
  console.log('\n7. frontend — the tile says unavailable, and the re-ask is rate-limited');
  {
    ok(/velocityError \? 'sales speed unavailable'/.test(HTML), 'Critical tile names the failure instead of a number');
    ok(/!velocityData && Date\.now\(\) - _velocityTriedAt > 5 \* 60 \* 1000/.test(HTML), 'renderInventory re-asks at most every 5 minutes');
  }
  console.log('\n──────────────────────────────');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
