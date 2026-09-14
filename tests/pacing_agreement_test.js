#!/usr/bin/env node
/* The headline and the six store rows must never disagree about pace.
 *
 * Reported by Sky 2026-09-03: "these don't jive. the daily total at the top says we're behind pace
 * yet each store says we're exceeding pace." Same period, same sales, one screen, two answers.
 *
 * The cause was two independent derivations of the SAME quantity — expected-to-date. The hero built
 * one (inline, three branches) and _storeBreakdownRows built another (inline, three branches), and
 * they had drifted:
 *
 *   - the hero guarded its intraday fraction with paceFracsStale() and fell back to the live clock
 *     ramp when the frac went cold; the rows read paceFracs[s] with NO staleness check, so past the
 *     5-minute TTL every row was still measured against a MORNING target — a small expected — while
 *     the hero had advanced to the real time of day. Every row reads ahead, the total reads behind;
 *   - in the current month the hero summed DOW-weighted DAILY goals (which, called without a date,
 *     never see the frozen period goals at all) while the rows took a flat calendar fraction of the
 *     frozen MONTHLY goal. Different clock AND different goal source.
 *
 * This test does not check either formula. It checks the only thing that can never be allowed to be
 * false: THE TOTAL IS THE TOTAL OF THE ROWS. That invariant survives any future change to how pace
 * is shaped, which a test of the arithmetic itself would not.
 *
 * It runs the SHIPPED functions out of index.html — storePeriodGoal, storePacedGoal and the real
 * _storeBreakdownRows — never a restatement of them. A copy would keep passing after the shipped
 * code regressed, which is the only way this test could lie.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const THRESHOLDS_SRC = /const THRESHOLDS = Object\.freeze\(\{[\s\S]*?\}\);/.exec(SRC)[0];
const PACE_TTL_SRC   = /const PACE_FRACS_TTL_MS[^\n]*\n/.exec(SRC)[0];
const PACE_GREEN_SRC = /const PACE_GREEN[^\n]*\n/.exec(SRC)?.[0] || 'const PACE_GREEN = 97;\n';
const PACE_AMBER_SRC = /const PACE_AMBER[^\n]*\n/.exec(SRC)?.[0] || 'const PACE_AMBER = 85;\n';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + a + ', want ' + b + ')'); }

const STORE_NAMES = ['River Rd', 'Bend', 'Hillsboro', 'Portland Rd', 'Center', 'Commercial'];

// Deliberately UNEVEN across stores in both directions. An even fixture makes the weighted-average
// bug invisible: with identical fracs and proportional goals the two old formulas agree by accident.
const MONTH_GOAL = { 'River Rd': 141000, 'Bend': 126000, 'Hillsboro': 73000,
                     'Portland Rd': 83000, 'Center': 46000, 'Commercial': 178000 };
// Portland Rd is the store whose frozen period goal sits ~45% above its budget line (CLAUDE.md), so
// it is the one that exposes a goal-source mismatch. Its intraday frac is also the odd one out.
const DAY_GOAL   = { 'River Rd': 4700, 'Bend': 4200, 'Hillsboro': 2400,
                     'Portland Rd': 2950, 'Center': 1550, 'Commercial': 5900 };
const BUDGET_DAY = { 'River Rd': 4600, 'Bend': 4100, 'Hillsboro': 2300,
                     'Portland Rd': 2050, 'Center': 1500, 'Commercial': 5800 };
const FRACS      = { 'River Rd': 0.42, 'Bend': 0.51, 'Hillsboro': 0.37,
                     'Portland Rd': 0.19, 'Center': 0.61, 'Commercial': 0.45 };
const NETS       = { 'River Rd': 2600, 'Bend': 2500, 'Hillsboro': 1300,
                     'Portland Rd': 1400, 'Center': 1000, 'Commercial': 3400 };

function makeCtx(clockIso) {
  const t = new Date(clockIso).getTime();   // local, not Z: pacing reads getHours()
  class FakeDate extends Date {
    constructor(...a) { return a.length ? new Date(...a) : new Date(t); }
    static now() { return t; }
  }
  const ctx = {
    console, Date: FakeDate, Math, Object, Number, isFinite, String, Array,
    STORES: STORE_NAMES.map(n => ({ name: n })),
    STORE_MAP: new Map(STORE_NAMES.map(n => [n, { display: n, color: '#111' }])),
    liveData: Object.fromEntries(STORE_NAMES.map(n => [n, { netSales: NETS[n] }])),
    MONTH_YTD: 0,
    activeYear: 2026, activeMonth: 9, activeWeek: null, activeDay: null,
    activeStore: 'All', activeStoreSet: null,
    paceFracs: null, paceFracsAt: 0,
    _bdOrder: null,
    toDateStr: d => d.toLocaleDateString('en-CA'),
    laDay: () => '2026-09-13', _todayPending: new Set(),
    activeWeekBounds: () => ['2026-09-01', '2026-09-07'],
    // WITH a date this is the frozen period target; WITHOUT one it is the budget fallback. The two
    // differ, which is precisely what the old hero/rows split let leak into the answer.
    getDailyGoal: (s, dow, mo, yr, dim, forDate) => forDate ? DAY_GOAL[s] : BUDGET_DAY[s],
    getMonthlyGoal: s => MONTH_GOAL[s],
    getWeeklyGoal: s => Math.round(MONTH_GOAL[s] * 7 / 30),
    getDaysOfISOWeek: () => [],
    getDOWWeights: () => [1, 1, 1, 1, 1, 1, 1],
    getGoal: s => MONTH_GOAL[s],
  };
  ctx.getActiveStores = () => STORE_NAMES.slice();
  vm.createContext(ctx);
  vm.runInContext([
    THRESHOLDS_SRC, PACE_TTL_SRC, PACE_GREEN_SRC, PACE_AMBER_SRC,
    grab('paceFracsStale'), grab('monthGoalFrac'), grab('getPacingPct'), grab('getGoalPacingPct'),
    grab('storePeriodGoal'), grab('storePacedGoal'),
    grab('_storeBreakdownRows'), grab('_bdApplyOrder'),
  ].join('\n'), ctx);
  return ctx;
}

/* The hero's own arithmetic, lifted verbatim from renderIncome. Kept in step by construction: it
 * calls the SAME two shipped functions the rows call, which is the whole design. */
function hero(ctx) {
  const stores = STORE_NAMES;
  const yr = ctx.activeYear;
  const daysInMo = ctx.activeMonth > 0 ? new Date(yr, ctx.activeMonth, 0).getDate() : 365;
  const sPeriodGoals = Object.fromEntries(stores.map(s => [s, ctx.storePeriodGoal(s, yr, daysInMo)]));
  const periodGoal = Math.round(stores.reduce((a, s) => a + sPeriodGoals[s], 0));
  const elapsedPct = ctx.getGoalPacingPct(stores);
  const isClosed = elapsedPct >= 100;
  const pacedGoal = stores.reduce(
    (a, s) => a + ctx.storePacedGoal(s, sPeriodGoals[s], isClosed, elapsedPct, yr, daysInMo), 0);
  return { periodGoal, elapsedPct, isClosed, pacedGoal, daysInMo, yr };
}

function rowsOf(ctx, h) {
  const storeNets = Object.fromEntries(STORE_NAMES.map(s => [s, NETS[s]]));
  return ctx._storeBreakdownRows(STORE_NAMES, storeNets, h.isClosed, h.elapsedPct, h.yr, h.daysInMo);
}

// ── The invariant, across every view the tab can be in ────────────────────────
const CASES = [
  // Today, frac FRESH. The per-store fractions are what make the rows legitimately differ from
  // each other; the total still has to be their total.
  { name: 'today, paceFracs fresh',  clock: '2026-09-03T14:30:00', day: '2026-09-03', mo: 9, stale: false },
  // Today, frac STALE. This is Sky's bug. Before the fix the rows kept the frozen morning frac
  // while the hero moved to the clock ramp, so the two answers pointed opposite ways.
  { name: 'today, paceFracs STALE',  clock: '2026-09-03T14:30:00', day: '2026-09-03', mo: 9, stale: true },
  // Today, no fracs ever fetched — both sides must land on the clock ramp.
  { name: 'today, no paceFracs',     clock: '2026-09-03T14:30:00', day: '2026-09-03', mo: 9, none: true },
  // After close: everything is expected in full.
  { name: 'today, after close',      clock: '2026-09-03T23:10:00', day: '2026-09-03', mo: 9, stale: false },
  { name: 'a past day',              clock: '2026-09-03T14:30:00', day: '2026-08-12', mo: 8, stale: false },
  { name: 'current month',           clock: '2026-09-03T14:30:00', day: null, mo: 9 },
  { name: 'current month, late',     clock: '2026-09-26T19:00:00', day: null, mo: 9 },
  { name: 'a closed month',          clock: '2026-09-03T14:30:00', day: null, mo: 7 },
  { name: 'a future month',          clock: '2026-09-03T14:30:00', day: null, mo: 11 },
  { name: 'YTD',                     clock: '2026-09-03T14:30:00', day: null, mo: 0 },
  { name: 'a week',                  clock: '2026-09-03T14:30:00', day: null, mo: 9, week: 36 },
];

for (const c of CASES) {
  const ctx = makeCtx(c.clock);
  ctx.activeDay = c.day;
  ctx.activeMonth = c.mo;
  ctx.activeWeek = c.week || null;
  if (!c.none) {
    ctx.paceFracs = Object.assign({}, FRACS);
    // Stamps MUST come off the fixed clock. Mixing in the host's real Date.now() is what makes a
    // stale frac look fresh and the whole case silently vacuous.
    ctx.paceFracsAt = c.stale
      ? new Date(c.clock).getTime() - (ctx.PACE_FRACS_TTL_MS + 60000)
      : new Date(c.clock).getTime() - 30000;
  }

  const h = hero(ctx);
  const rows = rowsOf(ctx, h);
  const rowSum = rows.reduce((a, r) => a + r.sCompareGoal, 0);
  const goalSum = rows.reduce((a, r) => a + r.sPeriodGoal, 0);

  eq(rowSum, h.pacedGoal, c.name + ': headline expected-to-date == sum of the rows');
  eq(Math.round(goalSum), h.periodGoal, c.name + ': headline goal == sum of the row goals');

  // The direction each side reports must match too — a total that says "behind" over six rows that
  // all say "ahead" is the actual complaint, and equal numbers are what rule it out.
  const net = STORE_NAMES.reduce((a, s) => a + NETS[s], 0);
  const heroUnder = h.pacedGoal - net;
  const rowUnder = -rows.reduce((a, r) => a + r.diff, 0);
  eq(rowUnder, heroUnder, c.name + ': headline behind/over == sum of the row deltas');
}

// ── The staleness rule itself, stated directly ────────────────────────────────
// The invariant above holds even if BOTH sides freeze together, so assert the fix, not just the
// agreement: a stale frac must be abandoned, exactly as the hero has always abandoned it.
{
  const fresh = makeCtx('2026-09-03T14:30:00');
  fresh.activeDay = '2026-09-03'; fresh.activeMonth = 9;
  fresh.paceFracs = Object.assign({}, FRACS);
  fresh.paceFracsAt = new Date('2026-09-03T14:30:00').getTime() - 30000;

  const stale = makeCtx('2026-09-03T14:30:00');
  stale.activeDay = '2026-09-03'; stale.activeMonth = 9;
  stale.paceFracs = Object.assign({}, FRACS);
  stale.paceFracsAt = new Date('2026-09-03T14:30:00').getTime() - (stale.PACE_FRACS_TTL_MS + 60000);

  const g = DAY_GOAL['Portland Rd'];
  const vFresh = fresh.storePacedGoal('Portland Rd', g, false, fresh.getGoalPacingPct(STORE_NAMES), 2026, 30);
  const vStale = stale.storePacedGoal('Portland Rd', g, false, stale.getGoalPacingPct(STORE_NAMES), 2026, 30);

  eq(vFresh, Math.round(g * FRACS['Portland Rd']), 'a FRESH frac is used for the store');
  ok(vStale !== Math.round(g * FRACS['Portland Rd']),
     'a STALE frac is abandoned, not frozen into the row (got ' + vStale + ')');
  // 14:30 on an 8am–10pm ramp is well past Portland Rd's frozen 19%, so the fallback must be higher.
  ok(vStale > vFresh, 'the stale fallback advances with the clock instead of holding the morning');
}

// ── A signed number must never render as "$-273" ─────────────────────────────
// fmtK puts the $ before the sign, and every one of these sites prepended a '+' by hand — which
// fixes only the positive half. Live on Sky's screen 2026-09-03: "Center $-7", "Portland $-273".
// CLAUDE.md already carried this rule from the Expenses redesign; the income rows never got it.
{
  const both = grab('_incomeBreakdownMobHtml') + grab('_incomeBreakdownDskHtml');
  ok(/fmtSigned\(diff\)/.test(both), 'store breakdown deltas use fmtSigned');
  ok(!/fmtK\(diff\)/.test(both), 'no signed value is formatted with fmtK');
  ok(!/diff>=0\?'\+':''/.test(both),
     "no hand-prepended '+' — that idiom is what left the negative half broken");

  // And the formatter itself, executed.
  const ctx = { Math, Number, console };
  vm.createContext(ctx);
  vm.runInContext(grab('fmtSigned'), ctx);
  eq(ctx.fmtSigned(273), '+$273', 'a positive keeps its plus');
  eq(ctx.fmtSigned(-273), '\u2212$273', 'a negative puts the sign BEFORE the dollar');
  eq(ctx.fmtSigned(-7), '\u2212$7', 'the exact figure from the screen renders correctly');
  eq(ctx.fmtSigned(0), '$0', 'zero is neither over nor under');
  eq(ctx.fmtSigned(-1234567), '\u2212$1,234,567', 'thousands separators survive the sign');
}

// ── Neither side may re-derive expected-to-date on its own ────────────────────
// The defect was two copies of the arithmetic, so pin that there is one. If a future edit inlines
// the math back into either place, this fails while the numbers may still happen to agree.
{
  const rowsSrc = grab('_storeBreakdownRows');
  ok(/storePacedGoal\(/.test(rowsSrc),
     'the store rows get expected-to-date from storePacedGoal, not their own copy');
  ok(/storePeriodGoal\(/.test(rowsSrc),
     'the store rows get the period goal from storePeriodGoal, not their own copy');
  ok(!/paceFracs\s*\?\.\[|paceFracs\[/.test(rowsSrc),
     'the store rows do not touch paceFracs directly — that is what skipped the staleness guard');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
// exitCode, not process.exit(): exit() can cut off a buffered stdout write, and a suite that
// prints NOTHING while exiting 0 reads as a pass to gx-preflight.sh. A silent green is worse
// than a red one.
  process.exitCode = fail ? 1 : 0;
