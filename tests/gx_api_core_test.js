#!/usr/bin/env node
/* ─── GX Core's other data from gx-api — one helper, the same switch, never a worse answer ────────
 *
 *   RUN:  node tests/gx_api_core_test.js     (from the repo root; no deps, no network)
 *
 * Roadmap [5] slice 5. coreData_ routes the store registry, store resolution, period goals, pace
 * curves and velocity to gx-api when SALES_DATA_SOURCE = 'api', and to the GXCore library otherwise.
 * The property under test is the FALLBACK: any answer gx-api cannot vouch for goes to the old call.
 *
 * EXECUTES the shipped coreData_/coreDataApi_ (via tests/_core_data_src.js) and the shipped browser
 * function lbGoalsFromApi_. Every check says which fixture would make it FAIL.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const GS = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const CORE_SRC = require('./_core_data_src');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

const STORES = [{ store_id: 'bend', dutchie_name: 'Bend', display_name: 'Century', sort_order: 1 },
                { store_id: 'river-rd', dutchie_name: 'River Rd', display_name: 'River', sort_order: 2 }];
const LIB = { stores: [{ store_id: 'lib', dutchie_name: 'Lib' }], goal: { dow_targets: [9], from: 'lib' } };

/* `api(path)` answers each gx-api GET; null = network error. */
function world(source, api) {
  const w = { gets: [], lib: [], marks: [] };
  const ctx = {
    Date, JSON, Math, Number, String, Array, Object, isFinite, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'GX_DEPLOY_SECRET' ? 'test-secret' : (k === 'SALES_DATA_SOURCE' ? source : null) }) },
    Utilities: { formatDate: () => '2026-11-25' },
    UrlFetchApp: { fetch: (url, o) => {
      w.gets.push({ url, headers: (o && o.headers) || {} });
      const r = api(url.replace('https://gx-api.greencross.workers.dev', ''));
      if (r === null) throw new Error('Address unavailable: ' + url);
      return { getResponseCode: () => r.code || 200, getContentText: () => JSON.stringify(r.body) };
    } },
    // GX Core's live routes (slice 7 — the library is gone). w.lib logs each route asked.
    ...require('./_core_routes_stub').coreRoutesFrom({
      getStores: () => LIB.stores,
      getPeriodGoals: (s, d) => (s ? LIB.goal : { ok: true, rows: [], picked: [{ from: 'lib' }] }),
      getVelocity: s => [{ store: s }],
    }, w.lib),
    ...(function () { const c = require('./_core_routes_stub').memCache(); return { cacheGet_: c.cacheGet_, cacheSet_: c.cacheSet_ }; })(),
    gxCoreRoute_: (a, p) => { w.lib.push('route:' + a); return { ok: true, shapes: { from: 'lib' } }; },
    gxDeploySecret_: () => 'test-secret',
    probeMark_: (label, ms, extra) => w.marks.push({ label, extra }),
    errText_: e => (e && e.message) || String(e),
  };
  vm.createContext(ctx);
  vm.runInContext(CORE_SRC + '\nthis.cd = coreData_;', ctx);
  w.cd = ctx.cd;
  return w;
}
const mirror = (key, part) => ({ body: { ok: true, source: 'gx-api', parts: { [key]: part } } });
const why = w => w.marks.filter(m => m.label === 'core_api_fallback').map(m => m.extra.why).join('|');

console.log('\n1. switch off: GX Core\'s own routes, and not one request to gx-api');
{
  const w = world(null, () => { throw new Error('must not be called'); });
  ok(w.cd('stores') === LIB.stores && w.cd('velocity', '')[0].store === 'lib' && w.cd('periodGoals', 'Bend', '2026-11-25') === LIB.goal,
     'stores, velocity and goals come from GX Core');
  ok(w.cd('resolveStore', 'LIB').store_id === 'lib' && w.cd('resolveStore', 'Salem') === null,
     'resolution is Core\'s resolver over Core\'s registry (unknown name: null)');
  ok(w.cd('hourlyShape', 'bend').shapes.from === 'lib', 'pace curves from the GX Core route');
  // Fails if the switch is ignored.
  ok(w.gets.length === 0, 'no gx-api request');
}

console.log('\n2. switch on, good answers: gx-api, library untouched');
{
  const w = world('api', p => {
    if (p === '/v1/core/mirror?keys=stores') return mirror('stores', { age_s: 60, body: { ok: true, stores: STORES } });
    if (p.startsWith('/v1/core/resolve_store?name=River')) return { body: { ok: true, age_s: 60, store: STORES[1] } };
    if (p.startsWith('/v1/core/period_goals?store=Bend&date=2026-11-25')) return { body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: { dow_targets: [1, 2, 3, 4, 5, 6, 7], from: 'api' } } };
    if (p.startsWith('/v1/core/period_goals?store=&date=2026-11-25')) return { body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: { ok: true, rows: [{}], picked: [{ from: 'api' }] } } };
    if (p === '/v1/core/mirror?keys=velocity%3A*') return { body: { ok: true, parts: {
      'velocity:bend': { age_s: 60, body: { ok: true, store: 'bend', rows: [{ store: 'bend', vel7: 1 }] } },
      'velocity:river-rd': { age_s: 60, body: { ok: true, store: 'river-rd', rows: [{ store: 'river-rd', vel7: 2 }] } } } } };
    if (p === '/v1/core/mirror?keys=hourly_shape%3A2026-11-25') return mirror('hourly_shape:2026-11-25', { age_s: 60, body: { ok: true, shapes: { bend: { 10: 0.1 }, 'river-rd': { 11: 0.2 } } } });
    return { code: 404, body: { ok: false } };
  });
  ok(w.cd('stores') === undefined ? false : w.cd('stores')[1].store_id === 'river-rd', 'stores from the copy');
  ok(w.cd('resolveStore', 'River').store_id === 'river-rd', 'resolution from the copy');
  ok(w.cd('periodGoals', 'Bend', '2026-11-25').from === 'api', "one store's goal from the copy");
  ok(w.cd('periodGoals', '', '2026-11-25').picked[0].from === 'api', 'every store\'s goals for a period from the copy');
  const v = w.cd('velocity', '');
  // Fails if one store's rows are dropped while concatenating.
  ok(v.length === 2 && v[1].store === 'river-rd', 'velocity: every store\'s rows, joined');
  ok(w.cd('hourlyShape', 'bend,river-rd').shapes['river-rd'][11] === 0.2, 'pace curves from the copy');
  ok(w.lib.length === 0, 'GX Core was never asked');
  ok(w.gets.every(g => g.headers['x-gx-secret'] === 'test-secret' && !/secret/.test(g.url)), 'secret in a header on every request, never the URL');
}

console.log('\n3. switch on, any doubt: GX Core itself answers — each FAILS if gx-api\'s answer were used');
const cases = [
  ['stores: copy too old (3h)', 'stores', [], p => mirror('stores', { age_s: 3 * 3600, body: { ok: true, stores: STORES } }), 'too_old', 'stores'],
  ['stores: no copy yet', 'stores', [], p => mirror('stores', null), 'no_copy', 'stores'],
  ['stores: a row without dutchie_name', 'stores', [], p => mirror('stores', { age_s: 60, body: { ok: true, stores: [{ store_id: 'bend' }] } }), 'bad_rows', 'stores'],
  ['stores: gx-api down (503)', 'stores', [], p => ({ code: 503, body: { ok: false } }), 'http_503', 'stores'],
  ['stores: network error', 'stores', [], p => null, 'Address unavailable', 'stores'],
  ['resolve: unknown to the copy', 'resolveStore', ['Salem'], p => ({ body: { ok: true, age_s: 60, store: null } }), 'unknown_to_copy', 'stores'],
  ['goal: none, date past the copied ledger', 'periodGoals', ['Bend', '2026-12-10'], p => ({ body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: null } }), 'no_goal_past_copy', 'period_goals'],
  ['goal: copy too old', 'periodGoals', ['Bend', '2026-11-25'], p => ({ body: { ok: true, age_s: 7200, stores_age_s: 60, ledger_end: '2026-12-06', result: { dow_targets: [1] } } }), 'too_old', 'period_goals'],
  ['period: nothing picked past the copy', 'periodGoals', ['', '2026-12-10'], p => ({ body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: { ok: true, rows: [], picked: [] } } }), 'nothing_past_copy', 'period_goals'],
  ['velocity: one store has no copy', 'velocity', [''], p => ({ body: { ok: true, parts: { 'velocity:bend': { age_s: 60, body: { ok: true, rows: [{}] } }, 'velocity:river-rd': null } } }), 'missing velocity:river-rd', 'velocity_rows'],
  ['velocity: one store empty', 'velocity', [''], p => ({ body: { ok: true, parts: { 'velocity:bend': { age_s: 60, body: { ok: true, rows: [] } } } } }), 'empty velocity:bend', 'velocity_rows'],
  ['velocity: one store 9h old', 'velocity', [''], p => ({ body: { ok: true, parts: { 'velocity:bend': { age_s: 9 * 3600, body: { ok: true, rows: [{}] } } } } }), 'too_old velocity:bend', 'velocity_rows'],
  ['pace: one store\'s curve missing', 'hourlyShape', ['bend,river-rd'], p => mirror('hourly_shape:2026-11-25', { age_s: 60, body: { ok: true, shapes: { bend: { 10: 0.1 }, 'river-rd': null } } }), 'missing river-rd', 'route:hourly_shape'],
  ['pace: no curve for today yet', 'hourlyShape', ['bend'], p => mirror('hourly_shape:2026-11-25', null), 'no_copy', 'route:hourly_shape'],
];
for (const [label, what, args, api, reason, libFn] of cases) {
  const w = world('api', api);
  w.cd(what, ...args);
  ok(w.lib.indexOf(libFn) !== -1 && why(w).indexOf(reason) !== -1, label + ' → ' + libFn + ' (' + why(w) + ')');
}
{
  // Inside the copied ledger, "no goal" IS the answer — asking Core again would only cost time.
  // Fails if every miss in the range walk paid for both paths (the 39s case pgLoadPeriod_ records).
  const w = world('api', p => ({ body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: null } }));
  ok(w.cd('periodGoals', 'Bend', '2024-01-01') === null && w.lib.length === 0, 'no goal for a date inside the copied ledger: null, library not asked');
  const w2 = world('api', p => ({ body: { ok: true, age_s: 60, stores_age_s: 60, ledger_end: '2026-12-06', result: { ok: true, rows: [], picked: [] } } }));
  ok(w2.cd('periodGoals', '', '2024-01-01').picked.length === 0 && w2.lib.length === 0, '...same for a store-less period miss');
}

console.log('\n4. it is the ONLY door to GX Core data');
{
  // Code only: comments are allowed to NAME the old calls (the helper's header table does).
  const code = GS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  // Slice 7: there is no library at all any more — not inside the helper, not anywhere.
  // Fails if any GXCore.x( call is added back, which would also need the binding back.
  ok(!/\bGXCore\s*\.\s*\w+\s*\(/.test(code), 'no GXCore.x() library call anywhere in the engine');
  const coreFn = /function coreDataCore_\([\s\S]*?\n\}/.exec(GS)[0];
  const rest = code.replace(coreFn, '');
  // Fails if a call site reaches Core's data routes without going through the switch.
  ok(!/gxCoreRoute_\('hourly_shape'/.test(rest), 'no hourly_shape route call outside coreDataCore_');
  for (const r of ['stores', 'period_goals', 'velocity_rows']) {
    ok(!new RegExp("gxCoreData(All)?_\\('" + r + "'").test(rest.replace(/function core(StoresLive|PeriodGoalsLive|VelocityLive)_\([\s\S]*?\n\}/g, '')),
       "Core's " + r + ' route is asked only by the helper behind coreData_');
  }
  ok(/rows = coreData_\('stores'\)/.test(GS) && /coreData_\('resolveStore', s\)/.test(GS) && /coreData_\('velocity', ''\)/.test(GS) && /coreData_\('hourlyShape', missing\.join/.test(GS),
     'the registry, the store gate, velocity and pace call the helper');
  ok(/o\.data_source = salesDataSource_\(\)/.test(GS), 'the stores reply tells the browser the switch');
}

console.log('\n5. the browser: Leaderboard\'s published goals from gx-api first, only with the switch on');
{
  const m = /\nasync function lbGoalsFromApi_\([\s\S]*?\n\}/.exec(HTML);
  ok(!!m, 'lbGoalsFromApi_ found in index.html');
  const run = async (src, resp, month) => {
    const calls = [];
    const ctx = { console: { log() {}, warn() {} }, setTimeout, clearTimeout, AbortController, Number, isFinite, Math,
      getToken: () => 'tok', LB_GOALS_MAX_AGE_MIN: 1800,
      lbGoalsIsCurrentMonth: (p, mo, yr) => !!(p && p.stores && p.year === yr && p.month === mo),
      fetch: async (url, o) => { calls.push({ url, auth: o.headers.Authorization }); if (resp === null) throw new Error('offline'); return { ok: resp.code ? false : true, status: resp.code || 200, json: async () => resp.body }; } };
    vm.createContext(ctx);
    vm.runInContext('let _salesDataSource = ' + JSON.stringify(src) + "; const GX_API_URL = 'https://gx-api.greencross.workers.dev';\n" + m[0] + '\nthis.f = lbGoalsFromApi_;', ctx);
    const out = await ctx.f(month || 'Nov', 2026);
    return { out, calls };
  };
  const payload = { month: 'Nov', year: 2026, stores: { Bend: {} } };
  const good = { body: { ok: true, parts: { 'published_goals:performance': { age_s: 600, body: { ok: true, payload, age_minutes: 30, published_at: 'x' } } } } };
  (async () => {
    let r = await run('sheets', good);
    // Fails if the browser talks to gx-api with the switch off.
    ok(r.out === null && r.calls.length === 0, 'switch off: no request, null (Core path runs)');
    r = await run('api', good);
    ok(r.out === payload && r.calls[0].auth === 'Bearer tok' && /keys=published_goals:performance$/.test(r.calls[0].url), 'switch on: the copied payload, signed in');
    // Fails if the copy's own age is not ADDED: 1790 + 20 min reads as 1790 and passes.
    const old = JSON.parse(JSON.stringify(good)); old.body.parts['published_goals:performance'].age_s = 1200; old.body.parts['published_goals:performance'].body.age_minutes = 1790;
    r = await run('api', old); ok(r.out === null, 'payload age + copy age over 30h → null');
    r = await run('api', good, 'Dec'); ok(r.out === null, 'last month\'s payload → null');
    r = await run('api', { code: 503 }); ok(r.out === null, 'gx-api 503 → null');
    r = await run('api', null); ok(r.out === null, 'gx-api unreachable → null, never a throw');
    r = await run('api', { body: { ok: true, parts: { 'published_goals:performance': null } } }); ok(r.out === null, 'no copy yet → null');
    ok(/const viaApi = await lbGoalsFromApi_\(curMonth, curYear\);\s*\n\s*if \(viaApi\) return viaApi;/.test(HTML), 'fetchPublishedGoals asks gx-api first and falls through');
    console.log('\n──────────────────────────────');
    console.log(pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  })().catch(e => { console.log('  FAIL  crashed: ' + e.message); process.exit(1); });
}
