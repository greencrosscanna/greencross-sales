#!/usr/bin/env node
/* TODAY'S FIGURE AND THE MONTH BEHIND IT TRAVEL DIFFERENT ROADS, AND ONLY ONE OF THEM STALLS.
 *
 * The settled days come back through GXCore.getSalesDaily — an Apps Script LIBRARY call, in-process,
 * with no /exec hop in it anywhere. Today's figure comes back through gxDutchieGet_, which is an
 * /exec round trip to GX Core. Measured on the live app 2026-09-11, cold, spaced 20s apart so the
 * load was not self-inflicted: three of six stores blew the client's 15s x 2 budget — Hillsboro on a
 * 32.3s HTTP 404 whose immediate retry then succeeded in 2.5s, Center and River dead at 60s. In the
 * same window Sales' own /exec answered 25 of 25 in ~2s and GX Core's /exec answered 0 of 6, hanging
 * the full 45s with a 302 every time. The two halves really do have different odds.
 *
 * Bundled into one answer, the 57ms half waited on the 32s half and the browser discarded BOTH — so
 * a Google-side hiccup on today's number cost the reader that store's whole month, and the company
 * total silently read short until the next poll. A per-store failure degrading into a smaller number
 * instead of an error is the River Rd shape this app has been bitten by before.
 *
 * EVERY WAY OF GETTING THE SPLIT WRONG YIELDS A PLAUSIBLE NUMBER RATHER THAN A VISIBLE BREAK, which
 * is why this executes the shipped code instead of reading it:
 *
 *   - sum aov or margin across the two halves and you get an average of averages: wrong, and it
 *     looks exactly like a right one.
 *   - REPLACE weekly buckets instead of adding them and the current week silently loses Monday
 *     through yesterday, because today shares its ISO week with settled days.
 *   - CONCATENATE daily instead of keying by date and any overlap doubles a day.
 *   - cache a settled-only answer and one stalled hop costs today's sales for the whole TTL rather
 *     than until the next poll — a self-healing miss turned sticky.
 *   - report a today-pending store as loaded and the status pill says 6/6 over an understated total,
 *     which is the exact invisibility this change exists to remove.
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

/* ── 1. the backend actually skips the half it was not asked for ───────────────────────────────── */
console.log('\n1. phase decides which halves are FETCHED, not merely which are returned');
{
  function runPhase(phase) {
    let settledReads = 0, liveReads = 0;
    const ctx = {
      Utilities: { formatDate: () => '2026-09-11' },
      GXCore: { getSalesDaily: () => { settledReads++; return [{ date: '2026-09-10', net: 100, gross: 120, orders: 4, discount: 1, tax: 9, cogs: 50 }]; } },
      dutchieTodayFetch_: () => { liveReads++; return { netSales: 40, grossSales: 44, orders: 2, discounts: 0, cost: 20, tax: 3, daily: [{ date: '2026-09-11', netSales: 40, grossSales: 44, orders: 2, discounts: 0, cogs: 20, tax: 3 }], topProducts: [{ name: 'x' }] }; },
      cacheGet_: () => null, cacheSet_: () => {},
      dayBefore_: () => '2026-09-10',
      probeMark_: () => {},
      getISOWeek: () => 38,
      Logger: { log: () => {} },
      jsonOut_: o => ({ getContent: () => JSON.stringify(o), _o: o }),
    };
    vm.createContext(ctx);
    vm.runInContext(gs('getStoreSales_'), ctx);
    const out = ctx.getStoreSales_('Bend', '2026-09-01', '2026-09-11', undefined, phase)._o;
    return { out, settledReads, liveReads };
  }

  const s = runPhase('settled');
  eq('phase=settled reads the settled source once', s.settledReads, 1);
  eq('phase=settled makes NO live Dutchie call — the whole point', s.liveReads, 0);
  eq('...and says so, so the client can tell the halves apart', s.out.phase, 'settled');

  const l = runPhase('live');
  eq('phase=live makes NO settled read', l.settledReads, 0);
  eq('phase=live does make the live call', l.liveReads, 1);
  eq('...and labels itself', l.out.phase, 'live');

  const b = runPhase(undefined);
  eq('no phase still does BOTH — every existing caller keeps its contract', [b.settledReads, b.liveReads], [1, 1]);
  eq('...and labels itself both', b.out.phase, 'both');

  // The halves have to actually add up to the unsplit answer, or the split changed the numbers.
  eq('settled + live net equals the unsplit net',
     Math.round((s.out.netSales + l.out.netSales) * 100) / 100, b.out.netSales);
  eq('settled alone is genuinely SHORT of the whole — otherwise this proves nothing',
     s.out.netSales < b.out.netSales, true);
}

/* ── 2. the merge — where a wrong answer would look right ──────────────────────────────────────── */
console.log('\n2. merging the two halves back into one store');
const ctx2 = {};
vm.createContext(ctx2);
vm.runInContext(html('round2_'), ctx2);
vm.runInContext(html('mergeStorePhases_'), ctx2);
const merge = ctx2.mergeStorePhases_;
{
  const settled = {
    store: 'Bend', orders: 100, netSales: 10000, grossSales: 12000, discounts: 500,
    cost: 6000, tax: 900, profit: 4000, aov: 100, margin: 40,
    weekly: [{ label: 'WK36', amount: 4000 }, { label: 'WK37', amount: 6000 }],
    daily: [{ date: '2026-09-09', netSales: 5000 }, { date: '2026-09-10', netSales: 5000 }],
    topProducts: [], cacheRows: 2, liveOrders: 0, phase: 'settled',
  };
  const live = {
    store: 'Bend', orders: 20, netSales: 1000, grossSales: 1200, discounts: 50,
    cost: 400, tax: 90, profit: 600, aov: 50, margin: 60,
    weekly: [{ label: 'WK37', amount: 1000 }],
    daily: [{ date: '2026-09-11', netSales: 1000 }],
    topProducts: [{ name: 'Blue Dream', revenue: 300 }], cacheRows: 0, liveOrders: 20, phase: 'live',
  };
  const m = merge(settled, live);

  eq('net adds', m.netSales, 11000);
  eq('orders add', m.orders, 120);
  eq('tax adds', m.tax, 990);
  eq('profit is net minus cost, recomputed', m.profit, 4600);

  /* THE ONE THAT LOOKS RIGHT WHEN IT IS WRONG. Summing gives 150; averaging the two gives 75;
   * only 11000/120 is the actual order value. All three are plausible on screen. */
  eq('aov is recomputed from merged totals, not summed (150) and not averaged (75)',
     m.aov, round2(11000 / 120));
  eq('margin is recomputed, not summed (100%) and not averaged (50%)',
     m.margin, Math.round((11000 - 6400) / 11000 * 10000) / 100);
  ok('a summed margin would have been an impossible 100%', 40 + 60 === 100 && m.margin !== 100);

  /* weekly OVERLAPS — today sits in the same ISO week as the settled days before it. */
  eq('the shared week is ADDED, not replaced',
     m.weekly.find(w => w.label === 'WK37').amount, 7000);
  eq('the untouched week is left alone', m.weekly.find(w => w.label === 'WK36').amount, 4000);
  eq('weeks stay in order', m.weekly.map(w => w.label), ['WK36', 'WK37']);

  /* daily is DISJOINT — opposite rule, on purpose. */
  eq('daily holds all three days once each', m.daily.map(d => d.date),
     ['2026-09-09', '2026-09-10', '2026-09-11']);

  eq("today's product mix survives the merge", m.topProducts.length, 1);
  eq('the merged answer calls itself complete', m.phase, 'both');
}
function round2(n) { return Math.round(n * 100) / 100; }

console.log('\n2b. an overlapping day cannot be counted twice');
{
  const a = { netSales: 100, orders: 1, daily: [{ date: '2026-09-11', netSales: 100 }], weekly: [] };
  const b = { netSales: 100, orders: 1, daily: [{ date: '2026-09-11', netSales: 100 }], weekly: [] };
  const m = merge(a, b);
  eq('the same date appears once, not twice', m.daily.length, 1);
}

console.log('\n2c. a missing half is returned whole, never merged with nothing');
{
  const settled = { netSales: 500, orders: 5, weekly: [{ label: 'WK37', amount: 500 }], daily: [] };
  eq('no live half → the settled month is the answer', merge(settled, null).netSales, 500);
  eq('no settled half → the live day is the answer', merge(null, { netSales: 9 }).netSales, 9);
  eq('neither → null, so the caller can tell', merge(null, null), null);
}

/* ── 3. the client wiring, on the shipped source ───────────────────────────────────────────────── */
/* EXECUTED, not pattern-matched. The first version of this section asserted on the POSITION of the
 * cache write inside the function text, and a mutation that added a second write before the branch
 * did not fail it — the anchor string it searched for also occurs a line earlier, in the merge call,
 * so the stray write landed "after" it and read as correct. A check that cannot fail is
 * indistinguishable from a check that passed, so this runs the real thing and counts what it did. */
function harness(live) {
  const cacheWrites = [];
  const ctx = {
    console: { warn() {} },
    setTimeout: fn => fn(),
    Promise, Set, Object, Math, String, Number, JSON, Error,
    laDay: () => '2026-09-11',
    monthRange: () => ({ from: '2026-09-01', to: '2026-09-30' }),
    readSalesCache: () => null,
    writeSalesCache: (store, y, m, data) => cacheWrites.push({ store, data }),
    stateMap: {},
    _todayPending: new Set(),
    salesLogout: () => {},
    fetchPhase: async (store, from, to, phase) => {
      if (phase === 'settled') {
        if (live === 'settled-fails') throw new Error('Unknown store: ' + store.name);
        return { store: store.name, netSales: 10000, orders: 100, cost: 6000,
                 weekly: [], daily: [{ date: '2026-09-10', netSales: 10000 }], phase: 'settled' };
      }
      if (live === 'fail') throw new Error('timed out after 15000ms');
      return { store: store.name, netSales: 1000, orders: 20, cost: 400,
               weekly: [], daily: [{ date: '2026-09-11', netSales: 1000 }], liveOrders: 20, phase: 'live' };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(html('round2_'), ctx);
  vm.runInContext(html('mergeStorePhases_'), ctx);
  vm.runInContext(html('fetchMonthData'), ctx);
  return { ctx, cacheWrites };
}

(async () => {
  console.log('\n3. how the client treats a half that never arrived');

  {
    const h = harness('ok');
    const d = await h.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9);
    eq('a complete month totals both halves', d.netSales, 11000);
    eq('...and is written to the cache', h.cacheWrites.length, 1);
    eq('...and leaves nothing pending', h.ctx._todayPending.size, 0);
    eq('...and the store counts as loaded', h.ctx.stateMap['Bend'], 'ok');
  }

  {
    const h = harness('fail');
    const d = await h.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9);
    eq('today missing → the settled month still comes back', d.netSales, 10000);
    eq('...the store still counts as loaded, because its month is real', h.ctx.stateMap['Bend'], 'ok');
    eq('...it is marked today-pending', [...h.ctx._todayPending], ['Bend']);
    /* THE CACHE RULE, AS BEHAVIOR. A settled-only answer written here is served back for the whole
     * TTL, so one stalled hop costs today's sales for ten minutes instead of until the next poll —
     * a self-healing miss turned sticky. */
    eq('...and NOTHING is cached, so the next poll tries again', h.cacheWrites.length, 0);
  }

  {
    const h = harness('settled-fails');
    let threw = false;
    try { await h.ctx.fetchMonthData({ name: 'Bend' }, 2026, 9); } catch (e) { threw = true; }
    ok('a failed settled half throws — a day billed as a month is worse than an error', threw);
    eq('...and nothing is cached', h.cacheWrites.length, 0);
    eq('...and it is not ALSO reported as merely today-pending', h.ctx._todayPending.size, 0);
  }

  {
    const fmd = html('fetchMonthData');
    ok('both halves are fired at once, not one after the other', /Promise\.allSettled\(/.test(fmd));
    ok('a range that does not reach today stays ONE request',
       /reachesToday/.test(fmd) && /fetchPhase\(store, from, to, ''\)/.test(fmd));
  }

  console.log('\n4. the status pill stops saying 6/6 over an understated total');
  {
    const las = HTML.slice(HTML.indexOf('async function loadAllStores'));
    ok('the pill names the stores whose today is missing', /today pending: \$\{pend\.join/.test(las));
    ok('...and goes amber rather than green while any are',
       /pill\(pend\.length \? 'amber' : 'green'/.test(las));
  }

  console.log('\n──────────────────────────────');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
