#!/usr/bin/env node
/* attainProbe_ answers one question — did the stores reach the frozen period goals — and every way
 * it can be wrong produces a plausible percentage rather than an error. That is what this guards.
 *
 * The two failures it is built to refuse are the SAME mistake in opposite directions: comparing a
 * partial to a whole.
 *
 *   - The OPEN period holds a few settled days of sales against a full fortnight of goal. Counted,
 *     the company reads ~20% attainment and someone panics. It must be skipped and NAMED, not
 *     silently dropped — a missing period looks identical to a period that never existed.
 *   - A store-period MISSING sales days understates that store the same way. It must be reported
 *     with its day count and excluded from every total, never quietly summed.
 *
 * A percentage carries no evidence of which halves it was built from, so the totals are also
 * asserted to equal the sum of exactly the counted rows — not "close to", exactly. A test that let
 * one uncounted store leak into the aggregate would still see a believable number.
 *
 * This EXECUTES the shipped attainProbe_ out of dutchie_proxy.gs in a vm, so renaming it or changing
 * its shape fails the suite rather than falling out of coverage.
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

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

// The store list is salesStores_ now (GX Core registry, local fallback). The REAL function runs here,
// with the registry unreachable, so this exercises the fallback's six stores and their Sales keys.
const MAP_SRC = /const SALES_KEY_BY_DUTCHIE_ = [\s\S]*?\n\];/.exec(GS);
const CAP_SRC = /const PG_RANGE_MAX_DAYS_ = \d+;/.exec(GS);
if (!MAP_SRC || !CAP_SRC) {
  console.log('SALES_KEY_BY_DUTCHIE_/SALES_STORES_FALLBACK_ or PG_RANGE_MAX_DAYS_ are gone from dutchie_proxy.gs');
  console.log('\n0 passed, 1 failed'); process.exit(1);
}

// ── Fixture: two settled pay periods and one still open ───────────────────────────────────────
// "today" is 2026-08-22, so settled_through is 2026-08-21 and the 08-17..08-30 period is open.
const TODAY = '2026-08-22';
const P1 = { start: '2026-07-20', end: '2026-08-02' };
const P2 = { start: '2026-08-03', end: '2026-08-16' };
const P3 = { start: '2026-08-17', end: '2026-08-30' };   // open — must be skipped

const SALES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];
const flatGoals = per => {
  const g = {};
  SALES.forEach(s => { g[s] = { period_total: per * 14, dow_targets: [per,per,per,per,per,per,per] }; });
  return g;
};
const PERIODS = [
  { period_start: P1.start, period_end: P1.end, goals: flatGoals(1000) },
  { period_start: P2.start, period_end: P2.end, goals: flatGoals(1000) },
  { period_start: P3.start, period_end: P3.end, goals: flatGoals(1000) },
];

// Daily net per store. Bend beats the bar, Center misses it, the rest land exactly on it — and
// River is missing two days in P2, which is the row that must not reach the totals.
const DAILY = { 'Bend': 1100, 'Center': 900, 'Commercial': 1000,
                'Hillsboro': 1000, 'Portland Rd': 1000, 'River': 1000 };
const MISSING_RIVER = ['2026-08-05', '2026-08-06'];

const dayMs = 86400000;
const at  = s => new Date(s + 'T12:00:00Z').getTime();
const iso = t => new Date(t).toISOString().slice(0, 10);

function salesRows(dutchie, from, to) {
  const sales = { 'Bend':'Bend', 'Center':'Center', 'Commercial':'Commercial',
                  'Hillsboro':'Hillsboro', 'Portland Rd':'Portland Rd', 'River Rd':'River' }[dutchie];
  const rows = [];
  for (let t = at(from); t <= at(to); t += dayMs) {
    const ds = iso(t);
    if (sales === 'River' && MISSING_RIVER.indexOf(ds) !== -1) continue;
    rows.push({ date: ds, store: dutchie, net: DAILY[sales] });
  }
  return rows;
}

let capturedRanges = [];
const ctx = {
  console,
  PG_RANGE_MAX_DAYS_: null,
  gxStoreRegistry_: () => { throw new Error('registry unreachable in this test'); },
  GXCore: { getSalesDaily: (store, from, to) => { capturedRanges.push([store, from, to]); return salesRows(store, from, to); } },
  Utilities: { formatDate: () => TODAY },
  dayBefore_: ds => iso(at(ds) - dayMs),
  jsonOut_: d => d,   // the route returns a TextOutput; here the object itself is the assertion target
  getPeriodGoalsRange_: (start, end) => ({
    getContent: () => JSON.stringify({ ok: true, start, end, periods: PERIODS,
                                       uncovered_days: 0, truncated: false })
  }),
};
vm.createContext(ctx);
vm.runInContext(MAP_SRC[0] + '\n' + CAP_SRC[0] + '\n' + grab(GS, 'hasOwn_') + '\n' + grab(GS, 'salesStoreKey_') + '\n' +
                 grab(GS, 'salesStores_') + '\n' + grab(GS, 'attainProbe_'), ctx);

// ── Input validation ──────────────────────────────────────────────────────────────────────────
const bad = vm.runInContext('attainProbe_("2026-8-1", "2026-08-31")', ctx);
ok('a non-ISO start is refused', bad.ok === false && /YYYY-MM-DD/.test(bad.error));
const rev = vm.runInContext('attainProbe_("2026-08-31", "2026-08-01")', ctx);
ok('end before start is refused', rev.ok === false && /before start/.test(rev.error));
const wide = vm.runInContext('attainProbe_("2020-01-01", "2026-08-31")', ctx);
ok('a range past PG_RANGE_MAX_DAYS_ is refused', wide.ok === false && /exceeds/.test(wide.error));

// ── The real walk ─────────────────────────────────────────────────────────────────────────────
capturedRanges = [];
const r = vm.runInContext('attainProbe_("2026-07-20", "2026-08-30")', ctx);
ok('the probe answers ok', r.ok === true);

// The open period
ok('the unsettled period is NOT counted', r.periods.length === 2);
ok('the unsettled period is named in skipped_periods',
   r.skipped_periods.length === 1 && r.skipped_periods[0].period_start === P3.start);
ok('the skip says why', /not settled/.test(r.skipped_periods[0].reason));
ok('settled_through is the day before today', r.settled_through === '2026-08-21');

// One read per store, over the UNION of the kept periods — not per period, and not clipped to the
// requested range (a pay period straddles the edge, and a clipped read reads as missing days).
ok('one getSalesDaily call per store', capturedRanges.length === 6);
ok('the read spans the kept periods, not the request',
   capturedRanges.every(c => c[1] === P1.start && c[2] === P2.end));

// Arithmetic, per store
const p1 = r.periods[0];
ok('a store on the bar is 100%',   p1.stores['Commercial'].pct === 100);
ok('a store over the bar is 110%', p1.stores['Bend'].pct === 110);
ok('a store under the bar is 90%', p1.stores['Center'].pct === 90);
ok('goal is the dow_targets summed over the period', p1.stores['Bend'].goal === 14000);
ok('actual is the daily net summed over the period', p1.stores['Bend'].actual === 15400);
ok('a complete store-period is counted', p1.stores['River'].counted === true);

// The incomplete store-period
const p2 = r.periods[1];
ok('missing sales days are counted', p2.stores['River'].days_missing === 2);
ok('an incomplete store-period is NOT counted', p2.stores['River'].counted === false);
ok('an incomplete store-period reports no pct', p2.stores['River'].pct === null);
ok('an incomplete store-period still shows its partial actual', p2.stores['River'].actual === 12000);

// Totals sum EXACTLY the counted rows — the assertion that catches a leak
const sumCounted = (per, k) => SALES.reduce((a, s) => a + (per.stores[s].counted ? per.stores[s][k] : 0), 0);
ok('a period total sums only counted stores (all six)',
   p1.total.goal === sumCounted(p1, 'goal') && p1.total.actual === sumCounted(p1, 'actual'));
ok('a period total excludes the incomplete store',
   p2.total.goal === sumCounted(p2, 'goal') && p2.total.actual === sumCounted(p2, 'actual'));
ok('the incomplete store is really excluded', p2.total.goal === 70000);

// Summary
ok('a fully-present store spans both periods', r.summary.by_store['Bend'].periods === 2);
ok('the incomplete store spans only the complete one', r.summary.by_store['River'].periods === 1);
ok('the summary total is the sum of by_store',
   r.summary.total.goal === SALES.reduce((a, s) => a + r.summary.by_store[s].goal, 0) &&
   r.summary.total.actual === SALES.reduce((a, s) => a + r.summary.by_store[s].actual, 0));
ok('periods_in_range counts only settled periods', r.summary.periods_in_range === 2);
ok('no read errors on a clean run', r.read_errors.length === 0);

// ── A store whose sales read THROWS ───────────────────────────────────────────────────────────
// It must be named, and it must drop out rather than reading as a store with zero sales — a silent
// 0% is the single most alarming wrong answer this route could produce.
ctx.GXCore.getSalesDaily = (store, from, to) => {
  if (store === 'Bend') throw new Error('GX Core timeout');
  return salesRows(store, from, to);
};
const rf = vm.runInContext('attainProbe_("2026-07-20", "2026-08-30")', ctx);
ok('a failed store read is named', rf.read_errors.length === 1 && rf.read_errors[0].store === 'Bend');
ok('a failed store read does not read as 0%', rf.periods[0].stores['Bend'].pct === null);
ok('a failed store read is excluded from the total', rf.periods[0].total.goal === 70000);
ok('a failed store read is absent from by_store', rf.summary.by_store['Bend'] === undefined);

// ── An entirely unsettled range answers, rather than erroring ─────────────────────────────────
ctx.GXCore.getSalesDaily = (store, from, to) => salesRows(store, from, to);
ctx.getPeriodGoalsRange_ = (start, end) => ({
  getContent: () => JSON.stringify({ ok: true, start, end, periods: [PERIODS[2]],
                                     uncovered_days: 0, truncated: false })
});
const only = vm.runInContext('attainProbe_("2026-08-17", "2026-08-30")', ctx);
ok('an all-open range is ok, not an error', only.ok === true);
ok('an all-open range has a null summary rather than a zero one', only.summary === null);
ok('an all-open range says so', /no settled pay period/.test(only.note));

// ── A failing goal read is surfaced, not turned into 0% ───────────────────────────────────────
ctx.getPeriodGoalsRange_ = () => ({ getContent: () => JSON.stringify({ ok: false, error: 'range exceeds 400 days' }) });
const gerr = vm.runInContext('attainProbe_("2026-07-20", "2026-08-30")', ctx);
ok('a goal-side failure is reported with its stage',
   gerr.ok === false && gerr.stage === 'period_goals_range' && /400 days/.test(gerr.error));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
