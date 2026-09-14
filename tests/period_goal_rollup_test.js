#!/usr/bin/env node
/* Until v2.541 only the DAY view read GX Core's frozen pay-period goals. Week, month and YTD read
 * the budget spreadsheet, so the SAME past period showed two different goals depending on which
 * view you were standing in — and neither said which one it was.
 *
 * Measured against the live goalprobe route over all eighteen pay periods from 2025-12-22 to
 * 2026-08-30, rolled up per calendar month and compared to the budget rows getGoals() returns:
 *
 *     Jan–Jul 2026, all six stores:  budget $4,679,904   period goals $5,017,051   +7.2%
 *     Portland Rd, every month:      +39% to +49%
 *
 * Sky's call (2026-08-29): the frozen period goals are authoritative — they are the targets staff
 * were actually held to and what the Leaderboard publishes — with the budget kept only as the
 * fallback for dates GX Core has no period for.
 *
 * The fixture below is REAL data from that probe, not invented: the four periods covering March
 * 2026, with each store's actual dow_targets. So the expected March totals are the numbers the app
 * must now show, and a regression prints a figure Sky can recognize.
 *
 * Runs the real functions out of index.html; a modeled copy would keep passing after the shipped
 * code regressed, which is the only way this could lie.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT  = path.join(__dirname, '..');
const SRC   = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PROXY = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html — renamed?');
  let depth = 0, j = SRC.indexOf('{', m.index + 1);
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const MONTHS_SRC = /const MONTHS = \[[^\]]*\];/.exec(SRC)[0];
const YTD_SRC    = /const MONTH_YTD = 0;/.exec(SRC)[0];

const STORES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];

// ── Real periods from ?action=goalprobe, covering all of March 2026 ──────────
// dow_targets are indexed 0=Sun. Every one of these was read off the live route.
const PERIODS = [
  { period_start: '2026-02-16', period_end: '2026-03-01', goals: {
    'Bend':        { dow_targets: [3878, 4366, 4300, 5264, 4483, 5328, 4283] },
    'Center':      { dow_targets: [1489, 1442, 1494, 1745, 1690, 1927, 1735] },
    'Commercial':  { dow_targets: [5868, 5622, 5639, 7332, 5696, 7478, 6852] },
    'Hillsboro':   { dow_targets: [2380, 2386, 2373, 2630, 2522, 3127, 2877] },
    'Portland Rd': { dow_targets: [2947.9355448743204, 2802.419037112915, 2737.0183594673395, 2861.279646993933, 2957.7456465211567, 3310.9093058072654, 3132.6924592230716] },
    'River':       { dow_targets: [4558, 4499, 4408, 5566, 4760, 6185, 5313] } } },
  { period_start: '2026-03-02', period_end: '2026-03-15', goals: {
    'Bend':        { dow_targets: [3820, 4310, 4254, 5189, 4442, 5313, 4275] },
    'Center':      { dow_targets: [1380, 1574, 1510, 1840, 1745, 1845, 1717] },
    'Commercial':  { dow_targets: [5835, 5653, 5637, 7302, 5721, 7552, 6889] },
    'Hillsboro':   { dow_targets: [2354, 2414, 2402, 2610, 2537, 3111, 2902] },
    'Portland Rd': { dow_targets: [2943.9998504169625, 2785.7036012116223, 2709.6593246325865, 2821.397853483415, 2996.7652668187425, 3335.0847013948614, 3156.6134400358997] },
    'River':       { dow_targets: [4555, 4463, 4387, 5593, 4962, 6060, 5334] } } },
  { period_start: '2026-03-16', period_end: '2026-03-29', goals: {
    'Bend':        { dow_targets: [5321, 4333, 4219, 5108, 4355, 5320, 4262] },
    'Center':      { dow_targets: [2048, 1487, 1532, 1817, 1708, 1965, 1761] },
    'Commercial':  { dow_targets: [8209, 5704, 5683, 7359, 5781, 7468, 6983] },
    'Hillsboro':   { dow_targets: [3356, 2416, 2371, 2682, 2532, 3124, 2915] },
    'Portland Rd': { dow_targets: [3837.4869321822416, 2608.7073820524065, 2619.9035510740905, 2729.066199035511, 2821.434593464405, 3112.534988028193, 3020.1665935992987] },
    'River':       { dow_targets: [5556, 4407, 4459, 5574, 4982, 5911, 5168] } } },
  { period_start: '2026-03-30', period_end: '2026-04-12', goals: {
    'Bend':        { dow_targets: [5254, 4297, 4115, 5070, 4317, 5284, 4139] },
    'Center':      { dow_targets: [2053, 1489, 1541, 1798, 1691, 1995, 1764] },
    'Commercial':  { dow_targets: [8297, 5762, 5653, 7360, 5781, 7548, 6935] },
    'Hillsboro':   { dow_targets: [3402, 2438, 2308, 2721, 2536, 3132, 2929] },
    'Portland Rd': { dow_targets: [3818.1404125187064, 2666.487735051077, 2647.586049840588, 2767.746762964409, 2775.847485197475, 3114.7276986140932, 2959.4638558136508] },
    'River':       { dow_targets: [5150, 4305, 4382, 5440, 5008, 5823, 5125] } } },
];


// Expand exactly as loadPeriodGoalRange does, so the fixture and the shipped loader agree on which
// day-of-week a date is. UTC noon throughout: these are date-only strings and a midnight anchor in
// a Pacific runtime lands on the day before.
const pgDaily = {};
for (const p of PERIODS) {
  const end = Date.parse(p.period_end + 'T12:00:00Z');
  for (let t = Date.parse(p.period_start + 'T12:00:00Z'); t <= end; t += 86400000) {
    const d = new Date(t);
    for (const [store, g] of Object.entries(p.goals)) {
      (pgDaily[store] ??= {})[d.toISOString().slice(0, 10)] = g.dow_targets[d.getUTCDay()];
    }
  }
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// The real budget rows, so the "these two genuinely disagree" assertions use production numbers.
const BUDGET = {
  'Bend':        [143823, 130172, 144416, 140045, 145011, 140623, 145609, 145909, 141494, 146511, 142077, 147115],
  'Center':      [ 50631,  45826,  50840,  49301,  51050,  49505,  51260,  51366,  49811,  51578,  50017,  51790],
  'Commercial':  [197205, 178487, 198018, 192025, 198834, 192817, 199654, 200066, 194011, 200891, 194811, 201719],
  'Hillsboro':   [ 80279,  72659,  80610,  78170,  80942,  78492,  81276,  81443,  78978,  81779,  79304,  82116],
  'Portland Rd': [ 65100,  58921,  65368,  63390,  65638,  63652,  65909,  66044,  64046,  66317,  64310,  66590],
  'River':       [143045, 129468, 143635, 139287, 144227, 139862, 144822, 145120, 140728, 145718, 141308, 146319],
};
const goals = Object.fromEntries(Object.entries(BUDGET).map(([s, v]) =>
  [s, Object.fromEntries(MONTH_NAMES.map((m, i) => [m, v[i]]))]));

class FakeDate extends Date {
  constructor(...a) { return a.length ? new Date(...a) : new Date('2026-08-29T12:00:00'); }
  static now() { return new Date('2026-08-29T12:00:00').getTime(); }
}

const ctx = {
  console, goals, goalsYear: 2026, activeYear: 2026,
  pgDaily, _pgTotalMemo: new Map(),
  lbGoals: null, periodGoalsCache: {},
  getDOWWeights: () => Array(7).fill(1 / 7),
  Date: FakeDate,
};
vm.createContext(ctx);
vm.runInContext([
  MONTHS_SRC, YTD_SRC,
  grab('getGoal'), grab('monthBounds'), grab('ytdBounds'), grab('pgTotal'),
  grab('getMonthlyGoal'), grab('getWeeklyGoal'), grab('getDailyGoal'),
].join('\n'), ctx);

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✓' : '✗'} ${desc}` + (ok ? '' : `\n      got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
  ok ? pass++ : fail++;
}
// Independent of the shipped pgTotal: sum the fixture directly, so a bug in pgTotal cannot define
// its own expected answer.
function expectMonth(store, y, m) {
  let sum = 0;
  const dim = new Date(y, m, 0).getDate();
  for (let d = 1; d <= dim; d++) {
    sum += pgDaily[store][`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`];
  }
  return sum;
}

console.log('a fully covered month rolls up from the frozen periods, not the budget');
for (const s of STORES) {
  const want = expectMonth(s, 2026, 3);
  // Portland Rd's frozen targets are fractional, so compare to the cent rather than bit-exactly.
  check(`${s} March 2026 = ${Math.round(want).toLocaleString()}`,
    Math.abs(ctx.getMonthlyGoal(s, 3, 2026) - want) < 0.01, true);
  check(`${s} March is NOT the budget row (${BUDGET[s][2].toLocaleString()})`,
    ctx.getMonthlyGoal(s, 3, 2026) !== BUDGET[s][2], true);
}

console.log('\nthe gap this change exists to close, in production numbers');
const pgMar = STORES.reduce((a, s) => a + ctx.getMonthlyGoal(s, 3, 2026), 0);
const bdMar = STORES.reduce((a, s) => a + BUDGET[s][2], 0);
console.log(`  March 2026 — budget ${bdMar.toLocaleString()} · period goals ${Math.round(pgMar).toLocaleString()} ` +
            `(${((pgMar / bdMar - 1) * 100).toFixed(1)}%)`);
check('the two sources genuinely disagree for March', Math.abs(pgMar - bdMar) > 20000, true);
// Portland Rd's period goal is a FLAT $41,500 every period while its budget moves monthly. Sky
// confirmed that is intentional, so the ~40% gap is the correct answer and must not be "fixed".
const pr = ctx.getMonthlyGoal('Portland Rd', 3, 2026) / BUDGET['Portland Rd'][2];
check('Portland Rd lands ~40% above its budget line, as intended', pr > 1.35 && pr < 1.45, true);

console.log('\na PARTIAL window refuses rather than understating');
// February is only half covered by the fixture (the 2026-02-16 period), and a sum over half a month
// would render exactly like a whole one — the same silent-wrong-answer shape as the past-year bug.
check('Feb 2026 is not fully covered → falls back to the budget',
  ctx.getMonthlyGoal('Bend', 2, 2026), BUDGET['Bend'][1]);
check('pgTotal says null rather than a partial sum',
  ctx.pgTotal('Bend', '2026-02-01', '2026-02-28'), null);
check('an entirely uncovered window also falls back',
  ctx.getMonthlyGoal('Bend', 7, 2026), BUDGET['Bend'][6]);

console.log('\nthe week target now reflects WHICH week, not the month average');
// Both weeks are inside March and fully covered, but they sit in different pay periods, so a real
// week target must differ between them. The budget fallback returns the same number for every week
// in the month — that is the behavior being replaced.
const w1 = ctx.getWeeklyGoal('Bend', 3, 2026, 31, '2026-03-02', '2026-03-08');
const w3 = ctx.getWeeklyGoal('Bend', 3, 2026, 31, '2026-03-16', '2026-03-22');
const flat = BUDGET['Bend'][2] * 7 / 31;
check('week of Mar 2 is the frozen sum, not the flat average', w1 !== Math.round(flat), true);
check('two different weeks get two different targets', w1 !== w3, true);
check('with no bounds supplied it still falls back to the flat budget week',
  Math.round(ctx.getWeeklyGoal('Bend', 3, 2026, 31)), Math.round(flat));

console.log('\nthe day view keeps its answer, and now shares one source with the rest');
// getDailyGoal's own periodGoalsCache path still wins; the new pgDaily path only widens WHEN the
// frozen target is in hand. Both must give the identical number for the identical date.
const thu = '2026-03-05';                       // a Thursday, dow 4
check('day view reads the frozen target for Mar 5',
  ctx.getDailyGoal('Bend', 4, 3, 2026, 31, thu), pgDaily['Bend'][thu]);
ctx.periodGoalsCache = { [thu]: { 'Bend': { dow_targets: PERIODS[1].goals['Bend'].dow_targets } } };
check('the pre-existing periodGoalsCache path agrees with it',
  ctx.getDailyGoal('Bend', 4, 3, 2026, 31, thu), pgDaily['Bend'][thu]);
ctx.periodGoalsCache = {};
check('a date with no frozen target still uses the DOW-weighted budget',
  Math.round(ctx.getDailyGoal('Bend', 4, 7, 2026, 31, '2026-07-02')),
  Math.round(BUDGET['Bend'][6] * 7 / 31 / 7));

console.log('\nthe memo cannot outlive the data it summarized');
// pgTotal memoizes, including its nulls. If the cache were not cleared when pgDaily grows, a window
// that missed before the fetch landed would stay missing for the life of the page.
check('a null is memoized', ctx.pgTotal('Bend', '2026-07-01', '2026-07-31'), null);
check('loadPeriodGoalRange clears the memo when pgDaily grows',
  /_pgTotalMemo\.clear\(\)/.test(SRC), true);

console.log('\nthe backend half');
check('period_goals_range is routed', /params\.action === 'period_goals_range'/.test(PROXY), true);
check('it is declared as a dev read', /'period_goals_range'/.test(SRC), true);
check('each frozen period is cached under every date it covers',
  /cacheSet_\('pgp_' \+ iso\(t\)/.test(PROXY), true);
check('a miss streak stops the walk instead of probing a year day by day',
  /MISS_LIMIT/.test(PROXY), true);
check('period boundaries come from GXCore, never from a 14-day stride',
  /GXCore\.getPeriodGoals\(s\.dutchie, date\)/.test(PROXY), true);
// getPeriodGoals re-reads the whole period_goals tab per call, so asking per store cost six full
// tab reads per period — 42s for a cold YTD, measured on the deployed route. The store-less form
// returns `picked`, one row per store, in one read.
check('one store-less call per period, not six per-store ones',
  /GXCore\.getPeriodGoals\(''\, date\)/.test(PROXY) || /GXCore\.getPeriodGoals\('', date\)/.test(PROXY), true);
check('picked rows join on canonical store_id, not the tab\'s aliases',
  /byStoreId\[String\(r\.store_id/.test(PROXY), true);
// Since 2026-09-14 the ids come off the registry rows themselves (salesStores_ reads GXCore.getStores),
// which is the same guarantee with no per-store resolveStore round trip.
check('the store_id map is resolved through the registry, not hardcoded',
  /function pgStoreIdMap_\(\) \{[\s\S]{0,120}salesStores_\(\)/.test(PROXY) && /gxStoreRegistry_\(\)/.test(PROXY), true);
check('a row describing a different window is skipped, not folded in',
  /r\.period_start !== out\.window\.start/.test(PROXY), true);
check('the per-store path survives as a fallback',
  /fall through to the per-store path/.test(PROXY), true);
// A miss is where the walk spends its whole probe budget, so it is the one case that must not pay
// for both paths. An empty `picked` is Core answering, not Core failing.
check('an authoritative empty answer does NOT trigger the fallback',
  /if \(Array\.isArray\(picked\) && !picked\.length\) return out;/.test(PROXY), true);
check('the ledger is learned once, as INTERVALS not a min/max span',
  /function pgLedgerIntervals_/.test(PROXY) && /function pgIntervalFor_/.test(PROXY), true);
// A span is not merely coarser, it is wrong here: the tab holds a sentinel row dated 2000-01-01, so
// min/max reported twenty-six years as findable and a 2024 range still took 17.8s proving otherwise.
check('membership is exact, not a span comparison',
  /!pgIntervalFor_\(intervals, date\)/.test(PROXY) && !/bounds\.min/.test(PROXY), true);
check('intervals read only period dates — never a goal value, never a tie-break',
  !/pgLedgerIntervals_[\s\S]{0,900}dow_targets/.test(PROXY), true);
check('overlapping orphan intervals cost a lookup, never a wrong goal',
  /ANSWER still comes from Core's own tie-break/.test(PROXY), true);
// cacheGet_ is two CacheService round-trips. Skipping the probe but still doing the lookup left a
// 182-day out-of-range walk at 12-22s in pure cache reads.
check('a date in no interval skips the cache lookup too, not just the probe',
  /!pgIntervalFor_\(intervals, date\)\) \{[\s\S]{0,80}uncovered\+\+;[\s\S]{0,60}cursor \+= dayMs;/.test(PROXY), true);
check('an exact miss does not spend probe budget or set truncated',
  !/!pgIntervalFor_\(intervals, date\)\) \{[\s\S]{0,200}everTruncated/.test(PROXY), true);
check('an unreadable ledger falls back to probing rather than to silence',
  /if \(intervals && !pgIntervalFor_/.test(PROXY), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
