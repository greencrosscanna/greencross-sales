#!/usr/bin/env node
/* ─── Today from gx-api — behind the same switch, and never a lower or blank figure ──────────────
 *
 *   RUN:  node tests/gx_api_today_test.js     (from the repo root; no deps, no network)
 *
 * Roadmap [5] slice 4. With SALES_DATA_SOURCE = 'api', today's figure comes from gx-api's
 * /v1/sales/today (Dutchie's Closing Report, pulled by the Worker) instead of a transaction pull
 * through GX Core's /exec hop. The property under test is the FALLBACK: any store gx-api cannot
 * vouch for — missing, stale, not today, too old, a non-number, a zero day in store hours, an
 * outage — takes the old GX Core path, so gx-api having a gap can never show as a smaller number.
 *
 * EXECUTES the shipped todayViaApi_, todayApiRefusal_ and dutchieTodayFetchLive_. Every check says
 * which fixture would make it FAIL.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const GS = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const SCRUB_DECLS = (/const AUTH_PARAM_NAMES_[\s\S]*?'gi'\);/.exec(GS) || [''])[0];

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(GS);
  if (!m) { console.log('  FAIL  function ' + name + ' not found'); process.exit(1); }
  let i = GS.indexOf('{', m.index), d = 0;
  for (let j = i; j < GS.length; j++) { if (GS[j] === '{') d++; else if (GS[j] === '}' && --d === 0) return GS.slice(m.index, j + 1); }
}
const constLine = n => { const m = new RegExp('\\nconst ' + n + '\\s*=\\s*[^;]+;').exec(GS); if (!m) throw new Error('no const ' + n); return m[0]; };

const TODAY = '2026-11-25';
const NOW = Date.parse('2026-11-25T22:00:00Z');   // 2 PM PT
const row = (over) => Object.assign({ date: TODAY, store: 'bend', net: 3859.46, gross: 4092.38, discount: 205.42,
  tax: 724.37, cogs: 1672.76, orders: 139, updated_at: new Date(NOW - 60000).toISOString(), source: 'closing_report' }, over || {});

function world(opts) {
  const w = { fetches: [], marks: [], coreCalls: 0 };
  const ctx = {
    Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(NOW); } static now() { return NOW; } },
    JSON, Math, Number, String, Array, Object, isFinite,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'GX_DEPLOY_SECRET' ? 'test-secret' : (k === 'SALES_DATA_SOURCE' ? opts.source : null) }) },
    Utilities: { formatDate: (d, tz, f) => (f === 'H' ? String(opts.hour == null ? 14 : opts.hour) : f === 'm' ? '0' : TODAY) },
    UrlFetchApp: { fetch: (url, o) => {
      w.fetches.push({ url, headers: (o && o.headers) || {} });
      if (opts.throws) throw new Error('Address unavailable: ' + url);
      return { getResponseCode: () => opts.code || 200, getContentText: () => (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) };
    } },
    probeMark_: (label, ms, extra) => w.marks.push({ label, extra }),
    gxDutchieGet_: () => { w.coreCalls++; return [{ core: true }]; },
    dtodayFromRows_: rows => ({ netSales: 9999, via: 'core', rows: rows.length }),
    dtodayQuery_: () => ({}),
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;', ctx);
  vm.runInContext([SCRUB_DECLS, grab('gxScrub_'), grab('errText_'), grab('gxDeploySecret_'),
    constLine('GX_API_'), constLine('SALES_DATA_SOURCE_PROP_'), constLine('GX_API_TODAY_MIN_AGE_S_'),
    constLine('DTODAY_PATH_'), constLine('BG_OPEN_HOUR_'), constLine('BG_QUIET_HOUR_'),
    grab('salesDataSource_'), grab('bgInStoreHours_'), grab('todayViaApi_'), grab('todayApiRefusal_'),
    grab('dutchieTodayFetchLive_'),
    'this.api = (l, m) => todayViaApi_(l, m, "' + TODAY + '"); this.live = (s, m) => dutchieTodayFetchLive_(s, "' + TODAY + '", "x", m);',
  ].join('\n'), ctx);
  w.api = ctx.api; w.live = ctx.live;
  return w;
}
const okBody = (stores) => ({ ok: true, source: 'gx-api', today: TODAY, stores });
const why = w => (w.marks.find(m => m.label === 'today_api_fallback') || { extra: {} }).extra.why;

console.log('\n1. switch off (the default): nothing goes to gx-api, today is pulled exactly as before');
{
  const w = world({ source: null, body: okBody({ Bend: { ok: true, row: row(), age_s: 60 } }) });
  const out = w.live('Bend', 90);
  // Fails if the switch is ignored: gx-api would be called with the switch off.
  ok(w.fetches.length === 0, 'no request to gx-api');
  ok(out.via === 'core' && w.coreCalls === 1, 'the old GX Core pull, once');
  ok(world({ source: 'sheets' }).api(['Bend'], 90).Bend === undefined, "'sheets' returns nothing, so every caller keeps its old path");
}

console.log('\n2. switch on, a good answer: used, in the shape every caller already reads');
{
  const w = world({ source: 'api', body: okBody({ Bend: { ok: true, row: row(), age_s: 60 } }) });
  const out = w.live('Bend', 90);
  // Fails if the Core pull still runs alongside (the point is to skip the slow hop).
  ok(w.coreCalls === 0, 'GX Core not asked');
  ok(/^https:\/\/gx-api\.greencross\.workers\.dev\/v1\/sales\/today\?stores=Bend&maxage=90$/.test(w.fetches[0].url), 'asks for that store and the caller\'s age');
  ok(w.fetches[0].headers['x-gx-secret'] === 'test-secret' && !/secret/.test(w.fetches[0].url), 'secret in a header, never the URL');
  // Fails if a field is mapped to the wrong name (net into gross, cogs into cost missing, ...).
  ok(out.netSales === 3859.46 && out.grossSales === 4092.38 && out.discounts === 205.42 && out.cost === 1672.76
     && out.tax === 724.37 && out.orders === 139, 'every money field lands under the name the screen reads');
  ok(out.daily.length === 1 && out.daily[0].date === TODAY && out.daily[0].cogs === 1672.76 && out.daily[0].tax === 724.37, 'one daily row, today, with COGS and tax');
  // Fails if as_of is our clock: a 60s-old figure would be labeled as brand new.
  ok(out.as_of === NOW - 60000, 'as_of is when gx-api pulled it');
  ok(Array.isArray(out.topProducts) && out.topProducts.length === 0, 'topProducts empty, as on the old path');
  ok(w.marks.some(m => m.label === 'today_source_api'), 'leaves a mark saying where the figure came from');
  // Fails if a caller can force gx-api below its floor (maxage=0 → every request a Dutchie pull).
  const z = world({ source: 'api', body: okBody({ Bend: { ok: true, row: row(), age_s: 60 } }) });
  z.live('Bend', 0);
  ok(/maxage=30$/.test(z.fetches[0].url), "'clear cache' asks for 30s, gx-api's floor, not 0");
}

console.log('\n3. switch on, any doubt: that store takes the GX Core path — never a lower or blank figure');
const refusals = [
  ['a stale copy (gx-api\'s own pull failed)', { ok: true, row: row({ updated_at: new Date(NOW - 1800e3).toISOString() }), age_s: 1800, stale: true, error: 'dutchie_http_429' }, /^stale/],
  ['yesterday\'s row', { ok: true, row: row({ date: '2026-11-24' }), age_s: 60 }, /^not_today$/],
  ['older than asked, even if gx-api did not say stale', { ok: true, row: row({ updated_at: new Date(NOW - 300e3).toISOString() }), age_s: 300 }, /^too_old$/],
  ['no pull time', { ok: true, row: row({ updated_at: '' }), age_s: 0 }, /^no_pull_time$/],
  ['a non-number in a money field', { ok: true, row: row({ cogs: 'n/a' }), age_s: 60 }, /^bad_cogs$/],
  ['a missing money field', { ok: true, row: row({ tax: null }), age_s: 60 }, /^bad_tax$/],
  ['zero orders at 2 PM', { ok: true, row: row({ orders: 0, net: 0, gross: 0, discount: 0, tax: 0, cogs: 0 }), age_s: 60 }, /^zero_orders_in_store_hours$/],
  ['ok:false for the store', { ok: false, error: 'no_row_for_today' }, /^no_row_for_today$/],
  ['the store missing from the answer', undefined, /^no_answer$/],
];
for (const [label, entry, re] of refusals) {
  const w = world({ source: 'api', body: okBody(entry === undefined ? {} : { Bend: entry }) });
  const out = w.live('Bend', 90);
  // Each fails if that answer is accepted: the screen would show gx-api's number instead of Core's.
  ok(out.via === 'core' && w.coreCalls === 1 && re.test(why(w) || ''), label + ' → GX Core (' + (why(w) || '?') + ')');
}
for (const [label, opts] of [['a 503', { code: 503, body: { ok: false } }], ['a 401', { code: 401, body: { ok: false } }],
                             ['an HTML error page', { body: '<html>oops</html>' }], ['ok:false', { body: { ok: false, error: 'x' } }],
                             ['no stores object', { body: { ok: true } }], ['a network error', { throws: true }]]) {
  const w = world(Object.assign({ source: 'api' }, opts));
  const out = w.live('Bend', 90);
  ok(out.via === 'core' && w.coreCalls === 1, label + ' → GX Core');
}
{
  const w = world({ source: 'api', throws: true });
  w.live('Bend', 90);
  // Fails if the error text carried the secret into the probe marks.
  ok(!/test-secret/.test(JSON.stringify(w.marks)), 'a network error\'s mark carries no secret');
  // Overnight a zero day is real (nothing sold yet), so it is NOT refused outside store hours.
  const night = world({ source: 'api', hour: 6, body: okBody({ Bend: { ok: true, row: row({ orders: 0, net: 0, gross: 0, discount: 0, tax: 0, cogs: 0 }), age_s: 60 } }) });
  ok(night.live('Bend', 90).source === 'gx-api', 'zero orders at 6 AM is accepted (store not open yet)');
}

console.log('\n4. several stores in one call: each judged alone');
{
  const w = world({ source: 'api', body: okBody({ Bend: { ok: true, row: row(), age_s: 60 }, River: { ok: true, row: row({ date: '2026-11-24' }), age_s: 60 } }) });
  const out = w.api(['Bend', 'River', 'Center'], 600);
  // Fails if one bad store poisons the batch, or a bad one slips through with the good.
  ok(Object.keys(out).join() === 'Bend', 'only the good store comes back; River and Center are left to the old path');
  ok(w.fetches.length === 1 && /stores=Bend%2CRiver%2CCenter&maxage=600$/.test(w.fetches[0].url), 'one request for all three');
}

console.log('\n5. every today read is wired through it');
{
  const fetch = grab('dutchieTodayFetch_');
  ok(/dutchieTodayFetchLive_\(store, todayPT, toISO, nocache \? 0 : maxAgeMs \/ 1000\)/.test(fetch), 'the viewer path passes its age through');
  // Fails if gx-api's honest pull time is overwritten with our start time.
  ok(/if \(!out\.as_of\) out\.as_of = t0;/.test(fetch), "...and keeps gx-api's as_of");
  ok(/todayViaApi_\(due\.map\(function \(d\) \{ return d\.store; \}\), BG_REFRESH_STALE_S_, todayPT\)/.test(grab('bgRefreshToday_')), 'the background refresh asks gx-api first');
  const cogs = grab('getCogsDutchie');
  ok(/todayViaApi_\(STORES\.map\(function \(s\) \{ return s\.dutchie; \}\), DTODAY_SNAPSHOT_S_, todayPT\)/.test(cogs), "today's COGS asks gx-api first");
  ok(/if \(includesToday && todayApi\[dutchie\]\) \{[\s\S]*?\} else if \(includesToday\) \{[\s\S]*?gxCoreRoute_\('dutchie_closing_report'/.test(cogs), '...and falls back to the GX Core closing report per store');
  ok((GS.match(/'\/v1\/sales\/today/g) || []).length === 1, 'one place builds the gx-api today URL');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
