#!/usr/bin/env node
/* OPENING THE APP IS ONE READ OF A SNAPSHOT A TRIGGER BUILT — NOT ~30 BUILDS INSIDE THE REQUEST.
 *
 * Measured 2026-09-17 on the live backend with a cold browser cache: an open fired 30-31 /exec calls
 * (twelve store halves, stores, goals, the goal range, other revenue, pace, the day's period goals,
 * a year of history per store, Gross Profit and GX Core's own), and on a phone the last one landed at
 * 42s. The /exec hop's failures come in outage WINDOWS that take everything in flight with them, so
 * every request in the opening wave is a separate exposure. The proxy now keeps the whole landing view
 * in one snapshot (bundleBuild_) rebuilt by the five-minute trigger, and an open reads it with
 * ?action=bundle.
 *
 * This suite EXECUTES the shipped code on both sides. Every wrong way to build this still paints
 * plausible numbers, so the assertions are about what could go wrong without anyone seeing it:
 *
 *   - the snapshot's today half drifting from the route's own shape (two builders of one answer);
 *   - a failed part blanking a good one, or being carried forward wearing a NEW age;
 *   - a pace fraction or a day's goal from YESTERDAY carried into today as a "stale copy";
 *   - an empty settled month (GX Core hiccup, degraded to zero rows by design on the live path)
 *     stored as data and served for hours;
 *   - the route BUILDING when there is nothing to read — the synchronous build this exists to end;
 *   - a half-failed snapshot written to disk and painted tomorrow as whole;
 *   - a today figure older than an open accepts painted as current;
 *   - a Refresh being handed the snapshot instead of fresh numbers;
 *   - and the headline number: how many requests an open actually fires.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const GS   = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grabFrom(src, file, name) {
  const re = new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in ' + file + ' — renamed or removed?');
  let i = src.indexOf('{', m.index + m[0].indexOf('(')), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(m.index, j + 1);
}
const gs   = n => grabFrom(GS,   'dutchie_proxy.gs', n);
const html = n => grabFrom(HTML, 'index.html',       n);
const constFrom = (src, name) => {
  const m = new RegExp('\\nconst ' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('constant ' + name + ' not found');
  return 'const ' + name + ' = ' + m[1] + ';';
};

let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else      { fail++; console.log('  FAIL ' + label); }
}
function eq(label, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  PASS ' + label); }
  else      { fail++; console.log('  FAIL ' + label + '  — got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
}

const TODAY = '2026-09-17';
const SIX = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];

/* ════════════════════════════════ SERVER ════════════════════════════════ */

function fakeCache() {
  const m = new Map();
  return {
    _m: m,
    get: k => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)); },
    putAll: o => { Object.keys(o).forEach(k => m.set(k, String(o[k]))); },
    getAll: ks => { const o = {}; ks.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; },
    remove: k => { m.delete(k); },
    removeAll: ks => ks.forEach(k => m.delete(k)),
  };
}

const TODAY_ENTRY = {
  netSales: 1234.56, grossSales: 1400.1, discounts: 50.25, cost: 600.3, tax: 150.07, orders: 21,
  daily: [{ date: TODAY, netSales: 1234.56, grossSales: 1400.1, orders: 21, discounts: 50.25, cogs: 600.3, tax: 150.07 }],
  topProducts: [], as_of: 0,
};

/* Everything the snapshot's builders touch, with the ROUTE functions it calls replaced by counters
 * that answer the way the real routes do (a ContentService-shaped { getContent }). */
function serverCtx(opts = {}) {
  const calls = { settled: 0, stores: 0, goals: 0, otherrev: 0, pg_range: 0, pg_day: 0, pace: 0, triggers: 0, liveFetch: 0 };
  const CACHE = opts.cache || fakeCache();
  const props = new Map();
  const out = o => ({ getContent: () => JSON.stringify(o) });
  const fails = opts.fails || {};
  const nowMs = opts.now || Date.parse(TODAY + 'T20:00:00Z');
  const ctx = {
    console, JSON, Math, Object, Array, String, Number, Error, parseInt, isFinite,
    Date: class extends Date {
      constructor(...a) { if (!a.length) super(nowMs); else super(...a); }
      static now() { return nowMs; }
    },
    CACHE,
    Logger: { log: () => {} },
    Utilities: { formatDate: () => opts.today || TODAY },
    LockService: { getUserLock: () => ({ tryLock: () => !opts.locked, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    ScriptApp: {
      newTrigger: () => ({ timeBased: () => ({ after: () => ({ create: () => { calls.triggers++; } }) }) }),
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
    },
    errText_: e => (e && e.message) || String(e),
    bgInStoreHours_: () => opts.inHours !== false,
    salesStores_: () => (opts.stores || SIX).map(n => ({ sales: n })),
    getStoresMeta_: () => { calls.stores++; if (fails.stores) throw new Error('registry down'); return out({ stores: [{ store_id: 'bend', dutchie_name: 'Bend' }] }); },
    getGoals: () => { calls.goals++; return fails.goals ? out({ error: 'no frozen goals' }) : out({ goals: { Bend: [1] }, year: 2026 }); },
    getOtherRevenue: () => { calls.otherrev++; return out({ atm: { Sep: 10 }, sublet: { Sep: 5 } }); },
    getPeriodGoalsRange_: () => { calls.pg_range++; return fails.pg_range ? out({ ok: false, error: 'range down' }) : out({ ok: true, periods: [] }); },
    getPeriodGoalsForDate_: () => { calls.pg_day++; return out({ ok: true, date: TODAY, goals: { Bend: { dow_targets: [1, 2, 3, 4, 5, 6, 7] } } }); },
    getPacingFracs_: () => { calls.pace++; if (fails.pace) throw new Error('curve down'); return out({ ok: true, fracs: { Bend: 0.6 } }); },
    getStoreSales_: (store, from, to, nocache, phase) => {
      calls.settled++;
      if (phase !== 'settled') throw new Error('the snapshot asked for a live half from the route');
      if ((fails.settledFor || []).includes(store)) return out({ error: 'GX Core unreachable' });
      const rows = (opts.emptySettled || []).includes(store) ? 0 : 16;
      return out({ store, netSales: 10000, orders: 100, cost: 5000, daily: [], weekly: [], cacheRows: rows, phase: 'settled' });
    },
    dutchieTodayFetch_: () => { calls.liveFetch++; return null; },
    gxDutchieGet_: () => { calls.liveFetch++; throw new Error('the snapshot must never pull from Dutchie'); },
  };
  vm.createContext(ctx);
  vm.runInContext([
    constFrom(GS, 'BUNDLE_KEY_'), constFrom(GS, 'BUNDLE_TTL_S_'), constFrom(GS, 'BUNDLE_CHUNK_'),
    constFrom(GS, 'BUNDLE_OFFHOURS_S_'), constFrom(GS, 'BUNDLE_KICK_KEY_'), constFrom(GS, 'BUNDLE_KICK_S_'),
    constFrom(GS, 'BUNDLE_KICK_HANDLER_'), constFrom(GS, 'BUNDLE_LAST_KEY_'),
    gs('cacheGet_'), gs('cacheSet_'), gs('dtodayKey_'), gs('getISOWeek'),
    gs('bundleCacheSave_'), gs('bundleCacheRead_'), gs('bundleLiveHalf_'), gs('bundlePart_'), gs('bundleBody_'),
    gs('bundleBuild_'), gs('bundleRefresh_'), gs('bundleKick_'), gs('getBundle_'),
  ].join('\n'), ctx);
  ctx._calls = calls;
  ctx._props = props;
  ctx._now = nowMs;
  return ctx;
}
function seedToday(ctx, stores, ageS) {
  stores.forEach(s => {
    const e = Object.assign({}, TODAY_ENTRY, { as_of: ctx._now - ageS * 1000 });
    ctx.CACHE.put('dtoday_v3_' + s + '_' + TODAY, JSON.stringify(e));
  });
}

console.log('\n1. the snapshot\'s today half is the ROUTE\'s phase=live answer, byte for byte');
{
  /* Two builders of one answer is the drift this file exists to catch. Run the shipped route over a
   * cache entry and the snapshot over the same entry, and require them to be identical. */
  const entry = Object.assign({}, TODAY_ENTRY, { as_of: 1789700000000 });
  const rctx = {
    Utilities: { formatDate: () => TODAY },
    GXCore: { getSalesDaily: () => { throw new Error('phase=live must not read settled days'); } },
    dutchieTodayFetch_: () => JSON.parse(JSON.stringify(entry)),
    cacheGet_: () => null, cacheSet_: () => {}, dtodayMaxAge_: () => 600, dayBefore_: () => '2026-09-16',
    probeMark_: () => {}, Logger: { log: () => {} }, errText_: e => e.message,
    jsonOut_: o => ({ _o: o }),
  };
  vm.createContext(rctx);
  vm.runInContext(gs('getISOWeek') + '\n' + gs('getStoreSales_'), rctx);
  const route = rctx.getStoreSales_('Bend', '2026-09-01', TODAY + 'T23:00:00Z', false, 'live', '600')._o;

  const s = serverCtx();
  s.CACHE.put('dtoday_v3_Bend_' + TODAY, JSON.stringify(entry));
  const snap = s.bundleLiveHalf_('Bend', TODAY);
  eq('identical to getStoreSales_(…, "live") over the same entry', JSON.parse(JSON.stringify(snap)), JSON.parse(JSON.stringify(route)));
  eq('...and it carries the pull time, which is what the hero clock prints', snap.liveAsOf, entry.as_of);

  const s2 = serverCtx();
  eq('no entry → no today half (the snapshot never pulls)', s2.bundleLiveHalf_('Bend', TODAY), null);
  s2.CACHE.put('dtoday_v3_Bend_' + TODAY, JSON.stringify(Object.assign({}, entry, { as_of: 0 })));
  eq('an entry with no age is not current → no today half', s2.bundleLiveHalf_('Bend', TODAY), null);
  eq('...and no Dutchie pull was attempted for either', s2._calls.liveFetch, 0);
}

console.log('\n2. a full build: every part present, every store both halves');
{
  const s = serverCtx();
  seedToday(s, SIX, 60);
  const snap = s.bundleBuild_(null);
  eq('all seven parts built', Object.keys(snap.parts).sort(), ['goals', 'otherrev', 'pace', 'pg_day', 'pg_range', 'sales', 'stores']);
  ok('every part ok', Object.values(snap.parts).every(p => p.ok === true));
  ok('every part carries its own as_of', Object.values(snap.parts).every(p => typeof p.as_of === 'number' && p.as_of > 0));
  eq('six stores in the sales part', Object.keys(snap.parts.sales.data.stores).sort(), SIX.slice().sort());
  ok('each with a settled half AND a today half',
     SIX.every(n => snap.parts.sales.data.stores[n].settled.phase === 'settled' && snap.parts.sales.data.stores[n].live.phase === 'live'));
  eq('the settled half was asked six times, once per store, phase=settled only', s._calls.settled, 6);
  eq('the build never pulled from Dutchie', s._calls.liveFetch, 0);
  eq('today and month are stamped for the client to match against', [snap.today_pt, snap.month], [TODAY, '2026-09']);
}

console.log('\n3. a failed part keeps its LAST GOOD copy with its ORIGINAL age — siblings untouched');
{
  const s1 = serverCtx();
  seedToday(s1, SIX, 60);
  const first = s1.bundleBuild_(null);

  const s2 = serverCtx({ fails: { pace: true, goals: true }, now: s1._now + 300000 });
  seedToday(s2, SIX, 30);
  const second = s2.bundleBuild_(JSON.parse(JSON.stringify(first)));
  ok('pace failed, and is carried rather than blanked', second.parts.pace.ok === true && second.parts.pace.stale === true);
  eq('...with the age it was BUILT at, not this build\'s', second.parts.pace.as_of, first.parts.pace.as_of);
  ok('...and says why', /curve down/.test(second.parts.pace.error));
  ok('a route answering {error} with a 200 is a failure too, not data', second.parts.goals.stale === true && /no frozen goals/.test(second.parts.goals.error));
  ok('the siblings were rebuilt fresh, not carried', second.parts.stores.stale !== true && second.parts.stores.as_of === s2._now);

  const s3 = serverCtx({ fails: { pace: true } });
  seedToday(s3, SIX, 60);
  const cold = s3.bundleBuild_(null);
  eq('a failure with nothing to carry is ok:false IN ITS SLOT', [cold.parts.pace.ok, /curve down/.test(cold.parts.pace.error)], [false, true]);
  ok('...and the rest of the snapshot still built', cold.parts.sales.ok && cold.parts.stores.ok && cold.parts.goals.ok);
}

console.log('\n4. yesterday\'s day-scoped answers are NOT a stale copy of today\'s');
{
  const s1 = serverCtx({ today: '2026-09-16' });
  const y = s1.bundleBuild_(null);
  const s2 = serverCtx({ fails: { pace: true, pg_range: true, stores: true } });
  seedToday(s2, SIX, 60);
  const t = s2.bundleBuild_(JSON.parse(JSON.stringify(y)));
  eq('pace from yesterday is not carried into today', t.parts.pace.ok, false);
  eq('nor is yesterday\'s period-goal range', t.parts.pg_range.ok, false);
  ok('but the store list, a whole-month fact, IS carried across the day line', t.parts.stores.ok && t.parts.stores.stale === true);
}

console.log('\n5. an EMPTY settled month is a failure here, not data');
{
  /* getStoreSales_ turns a GX Core failure into zero settled rows so a live request can still show
   * today. Cached in a snapshot, that is a confident near-$0 month served for hours. */
  const s = serverCtx({ emptySettled: ['River'] });
  seedToday(s, SIX, 60);
  const snap = s.bundleBuild_(null);
  ok('River is missing, not stored as an empty month', !snap.parts.sales.data.stores.River);
  eq('...and named', snap.parts.sales.data.missing, ['River']);
  eq('...which makes the sales part ok:false, so the client will not write it to disk', snap.parts.sales.ok, false);
  eq('the other five are still there', Object.keys(snap.parts.sales.data.stores).length, 5);

  const s1 = serverCtx({ today: '2026-09-01' , emptySettled: SIX });
  const first = s1.bundleBuild_(null);
  eq('on the 1st there ARE no settled days, and an empty month is correct', first.parts.sales.ok, true);

  const s2 = serverCtx({ fails: { settledFor: ['Bend'] } });
  seedToday(s2, SIX, 60);
  const prev = serverCtx(); seedToday(prev, SIX, 60);
  const p = prev.bundleBuild_(null);
  const again = s2.bundleBuild_(JSON.parse(JSON.stringify(p)));
  ok('a store whose settled read fails keeps its last good month, marked stale',
     again.parts.sales.data.stores.Bend && again.parts.sales.data.stores.Bend.stale === true);
  eq('...with its ORIGINAL age', again.parts.sales.data.stores.Bend.settled_as_of, p.parts.sales.data.stores.Bend.settled_as_of);
}

console.log('\n6. the route READS; it never builds');
{
  const s = serverCtx();
  const r = s.getBundle_();
  eq('nothing stored → bundle_missing', [r.ok, r.error], [false, 'bundle_missing']);
  eq('...and NOT ONE builder ran inside the request',
     [s._calls.settled, s._calls.stores, s._calls.goals, s._calls.pace, s._calls.pg_range, s._calls.otherrev], [0, 0, 0, 0, 0, 0]);
  eq('...a build was SCHEDULED instead', [r.refreshScheduled, s._calls.triggers], [true, 1]);
  const r2 = s.getBundle_();
  eq('a second asker inside the throttle schedules nothing more', [r2.refreshScheduled, s._calls.triggers], [false, 1]);

  const b = serverCtx();
  seedToday(b, SIX, 60);
  b.bundleRefresh_(true);
  const before = b._calls.settled;
  const got = b.getBundle_();
  eq('a stored snapshot is returned whole', [got.today_pt, Object.keys(got.parts).length], [TODAY, 7]);
  eq('...with no builder called by the read', b._calls.settled, before);
  ok('...and its age', typeof got.age_s === 'number');
}

console.log('\n7. chunked storage: over the per-entry cap, and a lost chunk is a miss, not half a payload');
{
  const s = serverCtx();
  const big = { ok: true, pad: 'x'.repeat(250000) };
  s.bundleCacheSave_(JSON.stringify(big));
  ok('stored in more than one chunk', Number(s.CACHE.get('sbundle_v1_meta')) >= 3);
  ok('...and every chunk is under CacheService\'s 100KB', [...s.CACHE._m.entries()].every(([, v]) => v.length <= 100000));
  eq('read back whole', s.bundleCacheRead_().pad.length, 250000);
  s.CACHE.remove('sbundle_v1_1');
  eq('one chunk evicted → null, never a truncated snapshot', s.bundleCacheRead_(), null);

  // The crossover cacheSet_ has — a small value written after a big one — cannot bite here.
  const t = serverCtx();
  t.bundleCacheSave_(JSON.stringify({ v: 'big', pad: 'y'.repeat(200000) }));
  t.bundleCacheSave_(JSON.stringify({ v: 'small' }));
  eq('a smaller snapshot written after a larger one is the one read back', t.bundleCacheRead_().v, 'small');
}

console.log('\n8. the trigger: today first, then the snapshot; either can fail alone');
{
  const tick = gs('bgRefreshTodayTick');
  ok('the today refresh runs BEFORE the snapshot build', tick.indexOf('bgRefreshToday_(') < tick.indexOf('bundleRefresh_('));
  const order = [];
  const c = { errText_: e => e.message, Logger: { log: () => {} },
              bgRefreshToday_: () => { order.push('today'); return { pulled: 6 }; },
              bundleRefresh_: () => { order.push('bundle'); throw new Error('boom'); } };
  vm.createContext(c);
  vm.runInContext(tick, c);
  const r = c.bgRefreshTodayTick();
  eq('a snapshot that throws does not cost the today refresh its result', [order, r && r.pulled], [['today', 'bundle'], 6]);

  const off = serverCtx({ inHours: false });
  seedToday(off, SIX, 60);
  off.bundleRefresh_(true);
  const n = off._calls.settled;
  eq('outside store hours a recent snapshot is not rebuilt every five minutes', off.bundleRefresh_(false).skipped, 'outside store hours, snapshot is recent');
  eq('...and nothing was read', off._calls.settled, n);
  eq('a build already running is not doubled', serverCtx({ locked: true }).bundleRefresh_(true).skipped, 'a build is already running');
}

console.log('\n9. the route sits behind the auth gate and writes nothing');
{
  const doGet = gs('doGet');
  const gate = doGet.indexOf('const auth = requireAuth_(params);');
  const route = doGet.indexOf("params.action === 'bundle'");
  ok('?action=bundle exists', route > 0);
  ok('...AFTER the session gate, like every data route', gate > 0 && route > gate);
  const line = doGet.slice(route, doGet.indexOf('\n', route));
  ok('...and goes through no write guard, because it writes nothing', !/writeGuard_/.test(line) && /getBundle_\(\)/.test(line));
  const body = gs('getBundle_') + gs('bundleBuild_') + gs('bundleLiveHalf_');
  ok('no Sales write function is reachable from the snapshot',
     !/set(Recon|OtherRevenue|RevenueLine|BillsOnce|ReconConfig|ReconAssign)_?\(|applyBudget_|clearBudget_|saveExpenseMapping_/.test(body));
}

/* ════════════════════════════════ CLIENT ════════════════════════════════ */

function snapshot(over = {}) {
  const now = Date.now();
  const stores = {};
  SIX.forEach(n => {
    stores[n] = {
      settled: { store: n, netSales: 10000, orders: 100, cost: 5000, weekly: [], daily: [{ date: '2026-09-16', netSales: 10000 }], phase: 'settled' },
      settled_as_of: now,
      live: { store: n, netSales: 1000, orders: 20, cost: 400, weekly: [], daily: [{ date: TODAY, netSales: 1000 }], liveAsOf: now - 60000, phase: 'live' },
    };
  });
  const part = data => ({ ok: true, as_of: now, data });
  return Object.assign({
    ok: true, v: 1, built_at: now, today_pt: TODAY, month: '2026-09',
    parts: {
      sales: part({ stores }), stores: part({ stores: [] }), goals: part({ goals: {}, year: 2026 }),
      otherrev: part({ atm: {}, sublet: {} }), pg_range: part({ ok: true, periods: [] }),
      pg_day: part({ ok: true, goals: { Bend: { dow_targets: [1] } } }), pace: part({ ok: true, fracs: { Bend: 0.5 } }),
    },
  }, over);
}

function clientCtx(extra = {}) {
  const ls = new Map();
  const ctx = Object.assign({
    console: { log() {}, warn() {}, error() {} }, JSON, Math, Object, Array, String, Number, Promise, Set, Date, encodeURIComponent,
    localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
    laDay: () => TODAY, activeYear: 2026, activeMonth: 9,
    getProxyUrl: () => 'https://x.test/exec', getToken: () => 'tok',
    AUX_READ_CAPS_: [12000, 25000], GAS_PRIO: { SCREEN: 0 },
    salesLogout: () => {},
    periodGoalsCache: {}, paceFracs: null, paceFracsAt: 0,
  }, extra);
  vm.createContext(ctx);
  vm.runInContext([
    constFrom(HTML, 'LIVE_SNAPSHOT_MAXAGE_S'), constFrom(HTML, 'OPEN_BUNDLE_LS_'),
    html('bundleIsErrorPayload_'), html('bundleFitsView_'), html('bundlePartData_'),
    html('bundleStorePreset_'), html('fetchOpenBundle_'), html('applyBundleDayParts_'),
  ].join('\n'), ctx);
  ctx._ls = ls;
  return ctx;
}

(async () => {
  console.log('\n10. the disk gate: a snapshot with ANY failed part is used but never saved');
  {
    const c = clientCtx();
    eq('a whole snapshot is not an error payload', c.bundleIsErrorPayload_(snapshot()), false);
    const bad = snapshot(); bad.parts.pace = { ok: false, error: 'curve down' };
    eq('one failed part makes it one', c.bundleIsErrorPayload_(bad), true);
    const carried = snapshot(); carried.parts.pace.stale = true;
    eq('a CARRIED part is whole (it is ok:true with its own honest age)', c.bundleIsErrorPayload_(carried), false);

    c.gasFetchJson = async () => bad;
    const got = await c.fetchOpenBundle_();
    ok('the half-failed snapshot is still RETURNED for this load', got && got.parts.sales.ok);
    eq('...and NOT written to disk', c._ls.has('gc_sales_open_bundle'), false);
    c.gasFetchJson = async () => snapshot();
    await c.fetchOpenBundle_();
    eq('a whole one is', c._ls.has('gc_sales_open_bundle'), true);

    const c2 = clientCtx();
    c2.gasFetchJson = async () => snapshot({ today_pt: '2026-09-16' });
    eq('yesterday\'s snapshot is not used for today', await c2.fetchOpenBundle_(), null);
    c2.gasFetchJson = async () => ({ ok: false, error: 'bundle_missing', refreshScheduled: true });
    eq('a missing snapshot falls back (null), it does not throw', await c2.fetchOpenBundle_(), null);
    c2.gasFetchJson = async () => { throw new Error('timed out after 12000ms'); };
    eq('an unreachable one falls back too', await c2.fetchOpenBundle_(), null);
    const c3 = clientCtx({ activeMonth: 8 });
    eq('a view of another month does not use it', c3.bundleFitsView_(snapshot()), false);
  }

  console.log('\n11. a today figure older than an open accepts is dropped, not painted as current');
  {
    const c = clientCtx();
    const LIVE = Number(/const LIVE_SNAPSHOT_MAXAGE_S\s*=\s*(\d+)/.exec(HTML)[1]);
    const SERVER = Number(/const DTODAY_SNAPSHOT_S_\s*=\s*(\d+)/.exec(GS)[1]);
    eq('the client\'s cut-off IS the server\'s maxage clamp', LIVE, SERVER);
    const b = snapshot();
    b.parts.sales.data.stores.Bend.live.liveAsOf = Date.now() - (LIVE + 30) * 1000;
    b.parts.sales.data.stores.Center.live.liveAsOf = Date.now() - (LIVE - 30) * 1000;
    eq('older than the cut-off → that store asks for today itself', c.bundleStorePreset_(b, 'Bend').live, null);
    ok('inside it → used', !!c.bundleStorePreset_(b, 'Center').live);
    ok('the settled half is used either way', c.bundleStorePreset_(b, 'Bend').settled.phase === 'settled');
    eq('a store the snapshot lacks gets no preset', c.bundleStorePreset_(b, 'Nowhere'), null);
    eq('no snapshot → no preset', c.bundleStorePreset_(null, 'Bend'), null);
  }

  console.log('\n12. fetchMonthData: a preset half REPLACES its request, a missing one does not');
  {
    function harness({ monthCache = true } = {}) {
      const asked = [];
      const ctx = {
        console: { warn() {} }, setTimeout: fn => fn(), Promise, Set, Object, Math, String, Number, JSON, Error, Date,
        laDay: () => TODAY,
        monthRange: () => ({ from: '2026-09-01', to: TODAY + 'T23:00:00Z' }),
        readSalesCache: () => (monthCache ? { netSales: 1, phase: 'both', stale: 'the month cache' } : null),
        writeSalesCache: () => {}, stateMap: {}, _todayPending: new Set(), salesLogout: () => {},
        fetchPhase: async (store, from, to, phase) => {
          asked.push(phase);
          return phase === 'settled'
            ? { store: store.name, netSales: 10000, orders: 100, cost: 5000, weekly: [], daily: [], phase: 'settled' }
            : { store: store.name, netSales: 1000, orders: 20, cost: 400, weekly: [], daily: [], liveAsOf: 5, phase: 'live' };
        },
      };
      vm.createContext(ctx);
      vm.runInContext(html('round2_') + '\n' + html('mergeStorePhases_') + '\n' + html('fetchMonthData'), ctx);
      return { ctx, asked };
    }
    const b = snapshot();
    const c = clientCtx();
    const both = c.bundleStorePreset_(b, 'Bend');
    const h1 = harness();
    const d1 = await h1.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9, false, null, both);
    eq('both halves in the snapshot → ZERO requests for this store', h1.asked, []);
    eq('...merged exactly as the network halves would be', [d1.netSales, d1.orders, d1.phase], [11000, 120, 'both']);
    ok('...a complete snapshot outranks the (older) 10-minute month cache', d1.stale === undefined);
    eq('...and the store is loaded, nothing pending', [h1.ctx.stateMap.Bend, h1.ctx._todayPending.size], ['ok', 0]);

    b.parts.sales.data.stores.Bend.live.liveAsOf = Date.now() - 3600 * 1000;
    const settledOnly = c.bundleStorePreset_(b, 'Bend');
    const h2 = harness({ monthCache: false });
    const d2 = await h2.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9, false, null, settledOnly);
    eq('today too old → exactly ONE request, for today', h2.asked, ['live']);
    eq('...and the month still totals both', d2.netSales, 11000);
    const h2b = harness();
    await h2b.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9, false, null, settledOnly);
    eq('...unless a complete month under 10 minutes old is already cached, which serves as before', h2b.asked, []);

    const h3 = harness();
    await h3.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9, false, null, null);
    eq('no preset → the month cache, as before this change', h3.asked, []);
  }

  console.log('\n13. how many requests an OPEN fires — the number this change exists for');
  {
    /* loadAllStores, EXECUTED, with every loader it calls also the shipped one. The network is a
     * counter that answers each route the way the proxy does. What is counted is every request to
     * THIS app's /exec made before the load settles, split from the work it defers afterwards. */
    function loadCtx({ bundleAnswer, fresh = false }) {
      const reqs = [];
      const deferred = [];
      const settle = [];
      const net = async (url) => {
        const u = new URL(url);
        const a = u.searchParams.get('action') || ('store:' + u.searchParams.get('phase'));
        reqs.push(a);
        if (a === 'bundle') { if (bundleAnswer instanceof Error) throw bundleAnswer; return JSON.parse(JSON.stringify(bundleAnswer)); }
        if (a === 'stores') return { stores: [] };
        if (a === 'goals') return { goals: {}, year: 2026 };
        if (a === 'otherrev') return { atm: {}, sublet: {} };
        if (a === 'period_goals_range') return { ok: true, periods: [] };
        if (a === 'store:settled') return { store: u.searchParams.get('store'), netSales: 10, orders: 1, cost: 1, weekly: [], daily: [], phase: 'settled' };
        if (a === 'store:live') return { store: u.searchParams.get('store'), netSales: 1, orders: 1, cost: 0, weekly: [], daily: [], liveAsOf: 1, phase: 'live' };
        return {};
      };
      const el = () => ({ style: {}, classList: { toggle() {}, add() {}, remove() {} }, disabled: false, innerHTML: '', textContent: '' });
      const ctx = {
        console: { log() {}, warn() {}, error() {} }, JSON, Math, Object, Array, String, Number, Promise, Set, Date, Error, URL, encodeURIComponent,
        setTimeout: (fn) => { settle.push(fn); fn(); return 0; }, clearTimeout: () => {},
        window: { scrollY: 0, addEventListener() {}, removeEventListener() {}, scrollTo() {} },
        document: { getElementById: el },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        STORES: SIX.map(n => ({ name: n })),
        activeYear: new Date().getFullYear(), activeMonth: new Date().getMonth() + 1, activeDay: null, activeWeek: null,
        laDay: () => (fresh === 'x' ? '' : new Date().toISOString().slice(0, 10)),
        _loadAllStoresInFlight: false, _nextLoadFresh: fresh, _liveDataKey: null, liveData: {}, _bdHoldOrder: false,
        _todayPending: new Set(), _diskStores: new Set(), isInitialLoad: false, section: 'income',
        periodGoalsCache: {}, paceFracs: null, paceFracsAt: 0,
        pgLoaded: new Set(), pgResolved: new Set(), _pgTotalMemo: new Map(), pgDaily: {},
        goals: null, goalsYear: null, otherRevData: null, otherRevAgeMs: null, otherRevTried: false,
        getProxyUrl: () => 'https://x.test/exec', getToken: () => 'tok', serverBypassParam: () => '',
        gasFetchJson: net, AUX_READ_CAPS_: [12000, 25000], LIVE_PHASE_CAPS_: [1], SETTLED_PHASE_CAPS_: [1],
        GAS_PRIO: { SCREEN: 0, SECONDARY: 1, BACKGROUND: 2 },
        setLiveBusy() {}, evictHistoricalSalesCache() {}, buildStatusGrid() {}, pill() {}, render() {},
        buildStoreTabs() {}, addOrUpdateStore_() {}, rebuildLiveDateMap() {}, mergeDailyData() {},
        readCache: () => null, writeCache() {}, readStaleCache: () => null, readSalesCache: () => null, writeSalesCache() {},
        loadLeaderboardGoals: async () => { deferred.push('gxcore:published_goals'); },
        showErr() {}, openSettings() {}, closeSettings() {}, updateCacheStatus() {}, refreshCompare() {}, scheduleAutoRefresh() {},
        backfillDailyHistory: () => { deferred.push('backfill'); }, loadInvGmData: () => { deferred.push('invgm'); return Promise.resolve(); },
        renderIncome() {}, loadPeriodGoals() {}, loadPaceFracs() {}, salesLogout() {},
        monthRange: () => ({ from: '2026-09-01', to: '2999-01-01T00:00:00Z' }),
      };
      // The landing view is TODAY (selectDefaultPeriod_), so the goal window is one day — the day the
      // snapshot's pg_range was built for.
      const t = new Date().toISOString().slice(0, 10);
      ctx.activeGoalRange = () => [t, t];
      vm.createContext(ctx);
      vm.runInContext([
        constFrom(HTML, 'LIVE_SNAPSHOT_MAXAGE_S'), constFrom(HTML, 'OPEN_BUNDLE_LS_'),
        html('bundleIsErrorPayload_'), html('bundleFitsView_'), html('bundlePartData_'), html('bundleStorePreset_'),
        html('fetchOpenBundle_'), html('applyBundleDayParts_'),
        html('fetchStoresMeta'), html('loadGoals'), html('loadPeriodGoalRange'), html('loadOtherRevenue'),
        html('round2_'), html('mergeStorePhases_'), html('loadAllStores'),
      ].join('\n'), ctx);
      return { ctx, reqs, deferred };
    }
    const liveSnap = () => {
      const b = snapshot({ today_pt: new Date().toISOString().slice(0, 10),
                           month: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}` });
      return b;
    };

    const open = loadCtx({ bundleAnswer: liveSnap() });
    await open.ctx.loadAllStores();
    eq('an open with a whole snapshot fires ONE request to this app', open.reqs, ['bundle']);
    eq('...and all six stores are on screen from it', Object.keys(open.ctx.liveData).sort(), SIX.slice().sort());
    ok('...with nothing today-pending', open.ctx._todayPending.size === 0);
    eq('the deferred work still runs, AFTER the load', open.deferred.filter(x => x !== 'gxcore:published_goals'), ['backfill', 'invgm']);

    const none = loadCtx({ bundleAnswer: new Error('timed out after 12000ms') });
    await none.ctx.loadAllStores();
    const byKind = none.reqs.reduce((o, a) => (o[a] = (o[a] || 0) + 1, o), {});
    eq('no snapshot → every piece asks for itself: the old opening wave, plus the one failed read',
       byKind, { bundle: 1, stores: 1, goals: 1, period_goals_range: 1, otherrev: 1, 'store:settled': 6, 'store:live': 6 });
    eq('...and the six stores still land', Object.keys(none.ctx.liveData).length, 6);

    const stale = liveSnap();
    Object.values(stale.parts.sales.data.stores).forEach(e => { e.live.liveAsOf = Date.now() - 3600 * 1000; });
    const st = loadCtx({ bundleAnswer: stale });
    await st.ctx.loadAllStores();
    eq('a snapshot whose today figures are an hour old → the snapshot plus six TODAY requests, nothing else',
       st.reqs.slice().sort(), ['bundle', 'store:live', 'store:live', 'store:live', 'store:live', 'store:live', 'store:live']);

    const refresh = loadCtx({ bundleAnswer: liveSnap(), fresh: true });
    await refresh.ctx.loadAllStores();
    ok('a REFRESH never asks for the snapshot — a person who asked for new numbers gets new numbers',
       !refresh.reqs.includes('bundle') && refresh.reqs.filter(a => a === 'store:live').length === 6);
  }

  console.log('\n14. the saved copy says it is one');
  {
    const ctxFor = (disk) => {
      const ctx = {
        STORES: SIX.map(n => ({ name: n })), _storeStateMap: {}, _todayPending: new Set(),
        _diskStores: new Set(disk), liveData: Object.fromEntries(SIX.map(n => [n, { netSales: 1, liveAsOf: Date.now() - 2 * 3600 * 1000 }])),
        activeStore: 'All', activeStoreSet: null, activeDay: null, _loadAllStoresInFlight: true,
        laDay: () => TODAY, periodRange: () => ({ from: '2026-09-01', to: TODAY }), toDateStr: d => d, Date, Math,
      };
      vm.createContext(ctx);
      vm.runInContext([html('viewIncludesToday_'), html('getActiveStores'), html('salesPending'), html('liveAsOf_'),
                       html('fmtCacheAgo_'), html('_heroLiveHtml_')].join('\n'), ctx);
      return ctx;
    };
    const h = ctxFor(SIX)._heroLiveHtml_('3:02 PM', '');
    ok('painted from disk → amber', /ic-hero-live stale/.test(h));
    ok('...and it says "saved copy" with the snapshot\'s real age', /saved copy, 2 hours ago/.test(h));
    const g = ctxFor([])._heroLiveHtml_('3:02 PM', '');
    ok('once the load has replaced every store, it says nothing', !/saved copy/.test(g) && !/stale/.test(g));
    const failed = ctxFor(SIX); failed._storeStateMap.Bend = 'err';
    ok('a FAILED store still outranks it (red is the stronger statement)', /failed/.test(failed._heroLiveHtml_('3:02 PM', '')));

    const las = html('loadAllStores');
    ok('a store the load lands is no longer counted as a saved copy', /_diskStores\.delete\(store\.name\)/.test(las));
    ok('a period change forgets the saved copy', /_liveDataKey = loadKey; _diskStores\.clear\(\);/.test(las));
    const boot = HTML.slice(HTML.lastIndexOf('if (GC_SALES_AUTH.isAuthed()) {'));
    ok('the boot paints the saved copy BEFORE the load starts, guarded',
       /try\s*\{\s*paintSavedBundle_\(\);\s*\}\s*catch/.test(boot) && boot.indexOf('paintSavedBundle_()') < boot.indexOf('loadAllStores()'));
    const psb = html('paintSavedBundle_');
    ok('only a WHOLE snapshot for TODAY\'s view is painted from disk', /bundleFitsView_\(b\)/.test(psb) && /bundleIsErrorPayload_\(b\)/.test(psb));
    ok('...each store painted from it is marked as such', /_diskStores\.add\(s\.name\)/.test(psb));
  }

  finished = true;
  console.log('\n──────────────────────────────');
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
