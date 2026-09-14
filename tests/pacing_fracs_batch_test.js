#!/usr/bin/env node
/* getPacingFracs_ must cost NO GX Core call for the fraction, and ONE a day for the curve.
 *
 * HISTORY, because it explains why the shape of this file keeps changing. It first looped over six
 * stores and made a separate /exec round trip for each. GX Core's telemetry measured the bill on
 * 2026-09-03: expected_frac was 46% of ALL traffic reaching Core, the single largest caller of
 * anything, and this loop plus Leaderboard's was most of it. Batching six trips into one fixed that
 * and is preserved in the comments of the shipped function.
 *
 * IT WAS NOT ENOUGH. Over a full day to 2026-09-07 the same telemetry put expected_frac at 59.7% of
 * ALL calls and 55% of Core's execution time — still the largest single load on the shared brain,
 * because one call per refresh is still a call per refresh.
 *
 * So the fraction is no longer fetched at all. Core's expectedSalesFrac is ten lines of arithmetic
 * over the store's hourly SHAPE — same-DOW revenue weights, stable for the whole day — so this app
 * mirrors the shape once a day and does the arithmetic itself. One source of truth is preserved
 * exactly: the shape is the truth, and it still comes from Core.
 *
 * What must stay true:
 *   · NO round trip prices the fraction, however often the route is called;
 *   · the curve is fetched from Core, once, batched — that call is the shared truth and must not
 *     follow the fraction out the door;
 *   · the local answer EQUALS Core's own, asserted against a verbatim copy of the shipped function
 *     rather than assumed;
 *   · the response is keyed by the SALES label, unchanged, because that is what the app renders;
 *   · a store with no curve is SKIPPED, not zeroed — a zero tells the dashboard the day expects no
 *     sales, which reads as "you are massively ahead" on a pacing bar;
 *   · GX Core being unreachable degrades to an empty map, exactly as it always did.
 *
 * Per this repo's pattern the test extracts the SHIPPED functions and runs them. The ONE copy it
 * carries is Core's expectedSalesFrac, and that is deliberate: the point is to compare two
 * independent implementations, so the reference has to be independent.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(src, name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = src.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(m.index, j + 1);
}
function grabConst(src, name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=\\s*([^;]+);').exec(src);
  if (!m) throw new Error('could not locate const ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

/* A realistic curve: quiet morning, afternoon peak, tapering close. Weights sum to 1 over 8..22,
   which is what makes the fraction a fraction. */
const CURVE = { 8: 0.031, 9: 0.039, 10: 0.049, 11: 0.056, 12: 0.071, 13: 0.087, 14: 0.097,
                15: 0.101, 16: 0.102, 17: 0.097, 18: 0.079, 19: 0.069, 20: 0.065, 21: 0.057 };
const IDS = ['bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd'];
const SHAPES = {}; IDS.forEach(id => { SHAPES[id] = CURVE; });

const TODAY = '2026-09-07';

/* `route` stands in for GX Core; every call is recorded, so "how many round trips did one pacing row
   cost" is the thing under test. `store` is the Script-Properties mirror, so a warm day and a cold
   one are both reachable. */
function makeCtx(route, seededStore, now) {
  const calls = [];
  const store = Object.assign({}, seededStore || {});
  const ctx = {
    console, _out: null, calls, store,
    Logger: { log() {} },
    Utilities: { formatDate: () => TODAY },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in store ? store[k] : null),
      setProperty: (k, v) => { store[k] = v; },
    }) },
    Date: class extends Date {
      constructor(...a) { super(...(a.length ? a : [(now || '2026-09-07T13:30:00')])); }
    },
    jsonOut_: (o) => { ctx._out = o; return o; },
    gxCoreRoute_: (action, params) => { calls.push({ action, params }); return route(action, params); },
    salesStores_: () => [{core:'bend',dutchie:'Bend',sales:'Bend'},{core:'center',dutchie:'Center',sales:'Center'},{core:'commercial',dutchie:'Commercial',sales:'Commercial'},{core:'hillsboro',dutchie:'Hillsboro',sales:'Hillsboro'},{core:'portland-rd',dutchie:'Portland Rd',sales:'Portland Rd'},{core:'river-rd',dutchie:'River Rd',sales:'River'}],   // the registry-driven list; its own test is store_list_test
  };
  vm.createContext(ctx);
  vm.runInContext(grabConst(GS, 'PACE_OPEN_HOUR'), ctx);
  vm.runInContext(grabConst(GS, 'PACE_CLOSE_HOUR'), ctx);
  vm.runInContext(grabConst(GS, 'GC_PACE_SHAPES_KEY'), ctx);
  vm.runInContext('var _PACE_SHAPES_MEMO = null;', ctx);
  vm.runInContext(grab(GS, 'paceFracFromShape_'), ctx);
  vm.runInContext(grab(GS, 'paceShapesToday_'), ctx);
  vm.runInContext(grab(GS, 'getPacingFracs_'), ctx);
  return ctx;
}
const okRoute = () => ({ ok: true, shapes: SHAPES });

console.log('\ngetPacingFracs_ — no call for the fraction, one a day for the curve');

/* THE POINT OF THE CHANGE. */
{
  const ctx = makeCtx(okRoute);
  ctx.getPacingFracs_();
  const fracCalls = ctx.calls.filter(c => c.action === 'expected_frac');
  ok(`the fraction costs ZERO GX Core calls (made ${fracCalls.length})`, fracCalls.length === 0);
  const shapeCalls = ctx.calls.filter(c => c.action === 'hourly_shape');
  ok(`the curve costs ONE, batched (made ${shapeCalls.length})`, shapeCalls.length === 1);
  ok('asking for every store in one parameter', /,/.test(String(shapeCalls[0].params.stores || '')));
  ok('and by canonical store_id', /river-rd/.test(String(shapeCalls[0].params.stores || '')));
}

/* REPEATED CALLS IN ONE EXECUTION ARE FREE. The route is hit on every dashboard refresh. */
{
  const ctx = makeCtx(okRoute);
  for (let i = 0; i < 25; i++) ctx.getPacingFracs_();
  ok(`25 pacing rows still cost ONE curve call (made ${ctx.calls.length})`, ctx.calls.length === 1);
}

/* A WARM MIRROR COSTS NOTHING AT ALL — the day after the first call of the day. */
{
  const seeded = {};
  const cache = {}; IDS.forEach(id => { cache[id + ':' + TODAY] = CURVE; });
  seeded['GC_PACE_SHAPES'] = JSON.stringify(cache);
  const ctx = makeCtx(okRoute, seeded);
  const out = ctx.getPacingFracs_();
  ok(`a warm mirror makes NO call at all (made ${ctx.calls.length})`, ctx.calls.length === 0);
  ok('and still prices every store', Object.keys(out.fracs).length === 6);
}

/* YESTERDAY'S CURVE IS NOT TODAY'S. The cache key carries the date; a stale curve would paint the
   wrong weighting with full confidence and nothing downstream could tell. */
{
  const seeded = {};
  const cache = {}; IDS.forEach(id => { cache[id + ':2026-09-06'] = CURVE; });
  seeded['GC_PACE_SHAPES'] = JSON.stringify(cache);
  const ctx = makeCtx(okRoute, seeded);
  ctx.getPacingFracs_();
  ok('a curve cached under yesterday is re-fetched, not reused',
     ctx.calls.filter(c => c.action === 'hourly_shape').length === 1);
  const stored = JSON.parse(ctx.store['GC_PACE_SHAPES'] || '{}');
  ok('and yesterday is pruned on write rather than accumulating',
     Object.keys(stored).every(k => k.slice(-10) === TODAY));
}

/* ── THE EQUIVALENCE THE WHOLE CHANGE RESTS ON ────────────────────────────────────────────────── */
{
  // GX Core's expectedSalesFrac, gx_dutchie.gs:949 — the shipped source, pasted.
  const OPEN = 8, CLOSE = 22;
  function coreExpectedSalesFrac(dist, nowHour, nowMinute, dayFrac) {
    if (!dist) return dayFrac;
    let ef = 0;
    for (let h = OPEN; h < CLOSE; h++) {
      if (h < nowHour)        ef += (dist[h] || 0);
      else if (h === nowHour) ef += (dist[h] || 0) * (nowMinute / 60);
    }
    return ef > 0 ? ef : dayFrac;
  }
  let same = 0, checked = 0;
  const ctx = makeCtx(okRoute);
  for (const [h, m] of [[8, 0], [9, 15], [11, 30], [13, 0], [16, 45], [19, 59], [21, 59]]) {
    const mine = ctx.paceFracFromShape_(CURVE, h, m);
    const theirs = coreExpectedSalesFrac(CURVE, h, m, null);
    checked++;
    if (mine !== null && theirs !== null && Math.abs(mine - theirs) < 1e-12) same++;
    else if (mine === null && (theirs === null || theirs === 0)) same++;
  }
  ok(`the local answer matches GX Core's own arithmetic at every hour tested (${same}/${checked})`,
     same === checked);
  /* Read the constants by EVALUATING them in the sandbox, not off the context object: `const`
     inside vm.runInContext is script-scoped and never becomes a property of the context, so
     ctx.PACE_OPEN_HOUR is undefined and the check would fail for a reason unrelated to the window. */
  ok('the window matches Core exactly — 8 to 22',
     vm.runInContext('PACE_OPEN_HOUR', ctx) === OPEN && vm.runInContext('PACE_CLOSE_HOUR', ctx) === CLOSE);
}

/* THE RENDERED SHAPE MUST NOT MOVE — the app keys its pacing row off these labels. */
{
  const ctx = makeCtx(okRoute);
  const out = ctx.getPacingFracs_();
  ok('response is still { ok, fracs, hour, minute }',
     out.ok === true && out.fracs && typeof out.hour === 'number' && typeof out.minute === 'number');
  const labels = Object.keys(out.fracs).sort();
  ok(`keyed by the SALES labels, not store_ids (${labels.join(', ')})`,
     labels.join(',') === ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'].sort().join(','));
  ok('River maps from river-rd, the one label that differs from its id', typeof out.fracs.River === 'number');
  ok('Portland Rd maps from portland-rd', typeof out.fracs['Portland Rd'] === 'number');
  ok('and the values are a real weighted fraction, not the linear ramp',
     out.fracs.Bend > 0 && out.fracs.Bend < 1);
}

/* A STORE WITH NO CURVE IS SKIPPED, NOT ZEROED. A zero says the day expects no sales, which on a
   pacing bar reads as wildly ahead — the opposite of the truth. This is the one behavior in this
   file that must survive every rewrite of it. */
{
  const partial = Object.assign({}, SHAPES); delete partial.commercial;
  const ctx = makeCtx(() => ({ ok: true, shapes: partial }));
  const out = ctx.getPacingFracs_();
  ok('a store missing from the batch is absent, not 0', out.fracs.Commercial === undefined);
  ok('and the other five are unaffected', Object.keys(out.fracs).length === 5);
}
{
  const nulled = Object.assign({}, SHAPES, { commercial: null });
  const ctx = makeCtx(() => ({ ok: true, shapes: nulled }));
  const out = ctx.getPacingFracs_();
  ok('an explicit null (cold store) is skipped too', out.fracs.Commercial === undefined);
}
{
  // A curve that is present but empty sums to zero. Zero is not a fraction, it is a missing curve.
  const empty = Object.assign({}, SHAPES, { commercial: {} });
  const ctx = makeCtx(() => ({ ok: true, shapes: empty }));
  const out = ctx.getPacingFracs_();
  ok('an all-zero curve is skipped rather than rendered as 0', out.fracs.Commercial === undefined);
}

/* GX CORE DOWN degrades exactly as it always did: an empty map, not a throw. */
{
  const ctx = makeCtx(() => { throw new Error('GX Core unreachable'); });
  let threw = null, out = null;
  try { out = ctx.getPacingFracs_(); } catch (e) { threw = e; }
  ok('an unreachable GX Core does not throw out of the route', !threw);
  ok('it returns ok with an empty fracs map', out && out.ok === true && Object.keys(out.fracs).length === 0);
  ok('and it only tried once', ctx.calls.length === 1);
}
{
  // The retry storm this memo exists to prevent: gxCoreRoute_ retries with sleeps, so a Core outage
  // must not cost every refresh a full cycle.
  const ctx = makeCtx(() => { throw new Error('GX Core unreachable'); });
  for (let i = 0; i < 10; i++) { try { ctx.getPacingFracs_(); } catch (e) {} }
  ok(`10 refreshes during an outage still cost ONE attempt (made ${ctx.calls.length})`,
     ctx.calls.length === 1);
}
{
  const ctx = makeCtx(() => ({ ok: true }));                 // malformed: no shapes at all
  const out = ctx.getPacingFracs_();
  ok('a response with no shapes yields an empty map rather than NaN values',
     out.ok === true && Object.keys(out.fracs).length === 0);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
