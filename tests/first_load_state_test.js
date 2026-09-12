#!/usr/bin/env node
/* Two faults that shared one symptom: "it spins, then says there is no data, then it loads."
 *
 * 1. THE DEAD END. loadAllStores paints progressively — render() runs after EVERY store settles,
 *    including the first one to FAIL. render() then found liveData empty and replaced the whole
 *    dashboard with the flat text "No data loaded yet.", which reads as a verdict when it is only
 *    the app saying it has not been told yet. Measured against the live app on 2026-09-06: that
 *    text appeared 1.3s into a cold load and held for 8.7 SECONDS before the first store's numbers
 *    arrived. On a phone, where the first answer is slower still, it is most of the load.
 *
 *    The fix is the rule this app already follows everywhere else — shimmer means "we have nothing
 *    YET" and belongs to the first load. While a load is genuinely in flight the income view mounts
 *    for real with skeletons, so the numbers land in place instead of replacing a block of text.
 *    The empty state survives for the case it was written for: nothing running, nothing on screen.
 *
 *    The $0 hero is the other half and is why the skeleton is not optional. `net` is 0 for want of
 *    asking, and a confident $0 next to a live dot is a worse answer than a shimmer.
 *
 * 2. THE CACHE CLEAR THAT SIGNED YOU OUT. `gc_sales_token` — the session — shares the `gc_sales_`
 *    prefix with the cached sales months, so both "Clear cache" buttons deleted it. The next
 *    request came back "Auth required", one store's failure called salesLogout(), and the login
 *    card appeared over a dashboard that had been working a second earlier. evictHistoricalSalesCache
 *    already guarded the key by name — it runs on every load, so the app would have logged itself
 *    out constantly otherwise — but the guard never reached the two functions whose whole job is
 *    deleting things. Confirmed by running that exact filter against the live app's localStorage.
 *
 * 3. THE BACKFILL BURST. backfillDailyHistory fired every (store, month) pair at once with a bare
 *    fetch(): 48 simultaneous Apps Script executions, measured, landing the instant the dashboard
 *    became usable. Apps Script caps simultaneous executions per user at 30, and a bare fetch has
 *    no timeout — the same defect fetchMonthData was fixed for on v2.560.
 *
 * Reads and EXECUTES the shipped index.html, not a copy.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

/** Pull a named top-level function out of the shipped source by brace balance. */
function grab(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let d = 0, i = HTML.indexOf('{', start);
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') d++;
    else if (HTML[j] === '}' && --d === 0) return HTML.slice(start, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

console.log('\n1. render() tells "nothing yet" apart from "nothing, and nothing is coming"');
{
  const r = grab('render');
  ok('the empty state is gated on salesPending()',
     /Object\.keys\(liveData\)\.length === 0 && !salesPending\(\)/.test(r));
  ok('...and the dead-end text is still there for the case it was written for',
     /No data loaded yet\./.test(r));

  const p = grab('salesPending');
  ok('salesPending means: a load is running and no store has answered',
     /_loadAllStoresInFlight/.test(p) && /Object\.keys\(liveData\)\.length === 0/.test(p));
}

console.log('\n2. salesPending is EXECUTED, not just present');
{
  // salesPending also answers the today-scoped question now, so the context has to carry the state
  // that question is about: which day is selected, what today is, and who is missing today.
  const TODAY = '2026-09-11';
  const ctx = {
    liveData: {}, _loadAllStoresInFlight: false,
    activeDay: null, _todayPending: new Set(), laDay: () => TODAY,
  };
  vm.createContext(ctx);
  vm.runInContext(grab('salesPending'), ctx);

  ok('idle with no data → not pending (the empty state is right)', ctx.salesPending() === false);
  ctx._loadAllStoresInFlight = true;
  ok('loading with no data → pending (shimmer, not a verdict)', ctx.salesPending() === true);
  ctx.liveData = { Bend: { netSales: 1 } };
  ok('loading with one store landed → NOT pending', ctx.salesPending() === false);
  ctx._loadAllStoresInFlight = false;
  ok('idle with data → not pending', ctx.salesPending() === false);
}

console.log("\n2b. a today view with no today figure shimmers instead of printing $0");
{
  const TODAY = '2026-09-11';
  const ctx = {
    liveData: { Bend: {}, River: {} }, _loadAllStoresInFlight: false,
    activeDay: TODAY, _todayPending: new Set(['Bend', 'River']), laDay: () => TODAY,
  };
  vm.createContext(ctx);
  vm.runInContext(grab('salesPending'), ctx);

  ok('today selected, today missing everywhere → pending',
     ctx.salesPending() === true);

  // The half that is easy to get wrong: SOME stores having today is not the same as none having it.
  ctx._todayPending = new Set(['Bend']);
  ok('one store short of today → NOT pending, the view paints what it has',
     ctx.salesPending() === false);

  // ...and the same missing figure must not blank a month, which is mostly settled data.
  ctx._todayPending = new Set(['Bend', 'River']);
  ctx.activeDay = null;
  ok('a month view is never blanked by a missing today', ctx.salesPending() === false);

  ctx.activeDay = '2026-09-04';
  ok('a PAST day never waits on today', ctx.salesPending() === false);

  ctx.activeDay = TODAY;
  ctx.liveData = {};
  ok('no stores at all falls back to the load-in-flight rule, not this one',
     ctx.salesPending() === false);
}

console.log('\n3. the hero shimmers rather than printing a $0 it never measured');
{
  const hero = grab('_incomeHeroInnerHtml');
  const i = hero.indexOf('if (o.dataWait)');
  ok('the hero has a dataWait branch', i > 0);
  ok('...and it comes BEFORE the goalWait branch, which prints the value',
     i > 0 && i < hero.indexOf('if (o.goalWait)'));

  const branch = hero.slice(i, hero.indexOf('  }', i));
  ok('...the net-sales figure is a skeleton, not fmtK(net)',
     /ic-hero-val"><span class="val-skel/.test(branch) && !/ic-hero-val">\$\{fmtK\(net\)\}/.test(branch));

  ok('dataWait is computed in renderIncome from salesPending()',
     /const dataWait\s*=\s*salesPending\(\)/.test(HTML));

  const heroCalls = (HTML.match(/(?<!function )_incomeHeroInnerHtml\(net, periodGoal/g) || []).length;
  const heroWith  = (HTML.match(/(?<!function )_incomeHeroInnerHtml\(net, periodGoal[^)]*dataWait/g) || []).length;
  ok(`all ${heroCalls} hero call sites pass dataWait`, heroCalls > 0 && heroCalls === heroWith);

  const projWith = (HTML.match(/(?<!function )_incomeProjCardHtml\(net, periodGoal[^)]*dataWait/g) || []).length;
  ok('both projection call sites shim on it too', projWith === 2);
}

console.log('\n4. the KPI skeleton keeps the SAME cards, so the numbers patch in place');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('_kpiSkelHtml') + '\nconst _KPI_SKEL = \'<span class="val-skel"></span>\';', ctx);

  const mob = ctx._kpiSkelHtml('mob', [['gp','Gross profit'], ['txns','Transactions'],
                                       ['disc','Discounts'], ['gross','Gross sales']]);
  ok('the mobile skeleton renders 4 cards', (mob.match(/class="ic-kpi"/g) || []).length === 4);
  // The ids are what patchEl targets. A skeleton with different ids would remount the whole
  // section under the reader the moment data landed — the tear this change exists to remove.
  ['ic-mob-kpi-gp','ic-mob-kpi-txns','ic-mob-kpi-disc','ic-mob-kpi-gross'].forEach(id =>
    ok('...carrying the real id ' + id, mob.includes('id="' + id + '"')));
  ok('...and every value is a shimmer', (mob.match(/val-skel/g) || []).length === 4);
  ok('...with no fabricated $0 anywhere in it', !/\$0/.test(mob));

  const dsk = ctx._kpiSkelHtml('dsk', [['gp','a'],['margin','b'],['txns','c'],['aov','d'],['disc','e'],['gross','f']]);
  ok('the desktop skeleton renders 6 cards', (dsk.match(/class="ic-kpi"/g) || []).length === 6);

  // Both real builders must actually take the flag and return early on it.
  ok('_incomeKpiMobHtml takes wait and returns the skeleton first',
     /function _incomeKpiMobHtml\([^)]*wait\)\s*\{\s*if \(wait\) return _kpiSkelHtml/.test(grab('_incomeKpiMobHtml')));
  ok('_incomeKpiDskHtml takes wait and returns the skeleton first',
     /function _incomeKpiDskHtml\([^)]*wait\)\s*\{\s*if \(wait\) return _kpiSkelHtml/.test(grab('_incomeKpiDskHtml')));
}

console.log('\n5. the phone\'s sticky mini-hero follows the same rule');
{
  const m = grab('updateMobHero');
  ok('it shimmers while pending instead of printing fmtK(0)',
     /if \(salesPending\(\)\)[\s\S]{0,80}val-skel/.test(m));
}

console.log('\n6. clearing the cache must not clear the SESSION');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('isSalesCacheKey_'), ctx);

  ok('a cached sales month IS a cache key', ctx.isSalesCacheKey_('gc_sales_v2_Bend_2026_9') === true);
  ok('the session token is NOT', ctx.isSalesCacheKey_('gc_sales_token') === false);
  ok('an unrelated key is not swept either', ctx.isSalesCacheKey_('gc_cache_goals_v2') === false);

  // The two delete paths and the two read paths all go through it — a raw prefix test anywhere
  // over `gc_sales_` is the bug coming back.
  ['clearDutchieCache', 'clearAllCache', 'updateCacheStatus'].forEach(fn => {
    const src = grab(fn);
    ok(fn + ' has no raw gc_sales_ prefix test left', !/startsWith\('gc_sales_'\)/.test(src));
    ok(fn + ' goes through isSalesCacheKey_', /isSalesCacheKey_/.test(src));
  });

  // evictHistoricalSalesCache guards the key by name and runs on every load; leave it alone.
  ok('evictHistoricalSalesCache still excludes the token',
     /k === 'gc_sales_token'/.test(grab('evictHistoricalSalesCache')));
}

console.log('\n7. the backfill is bounded — in flight count AND in wait');
{
  const bf = grab('backfillDailyHistory');
  ok('there is a concurrency pool', /BACKFILL_POOL/.test(bf));
  ok('...it is small enough to lose every race against the foreground load',
     (Number((/const BACKFILL_POOL = (\d+)/.exec(bf) || [])[1]) || 99) <= 6);
  ok('...and the pool is what drives the tasks, not a bare map over all of them',
     /Array\.from\(\{ length: Math\.min\(BACKFILL_POOL/.test(bf) && !/Promise\.all\(tasks\.map/.test(bf));
  ok('every request is bounded by gasFetchJson, not a bare fetch',
     /gasFetchJson\(url,/.test(bf) && !/await fetch\(url\)/.test(bf));
}

console.log('\n8. Expenses-only aux no longer competes with the first paint');
{
  const load = grab('loadAllStores');
  ok('loadExpBudgets is off the boot path', !/loadExpBudgets\(\)/.test(load));
  ok('loadExpenses is off the boot path',   !/loadExpenses\(\)/.test(load));
  // otherRevenue stays: the Income hero folds ATM and sublet into net sales, so it IS this tab's.
  ok('loadOtherRevenue stays on it', /loadOtherRevenue\(\)/.test(load));

  ok('the Expenses tab loads its own budgets on entry',
     /function renderExpenses\(\)\s*\{\s*ensureExpBudgets\(\);/.test(HTML));

  const ens = grab('ensureExpBudgets');
  // Guarded by "tried", not "loading": a failed fetch leaves expBudgets null and re-renders the
  // tab, so a liveness check alone would re-fire forever against a broken backend.
  ok('...guarded so a failed fetch cannot loop', /_expBudgetsTried/.test(ens));
  ok('...and a refresh can retry it', /_expBudgetsTried = false/.test(grab('reloadExpenses')));
  ok('...as can clearing the cache', /_expBudgetsTried = false/.test(grab('clearAllCache')));
}

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
