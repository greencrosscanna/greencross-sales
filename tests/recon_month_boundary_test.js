#!/usr/bin/env node
/* A store-week is not a calendar month, and the Reconcile tab used to lose the week where the two
 * cross.
 *
 * Sky, 2026-09-07: "default Reconcile date selection to Current week. currently when i click on
 * WK35 it's not showing deposits that were make on 8/31, which is WK35, but it does show them on
 * WK34."
 *
 * Both halves are one rule. Three facts compose into the hole:
 *
 *   1. WK35 runs Mon 2026-08-31 -> Sun 2026-09-06, so it STRADDLES the month boundary.
 *   2. periodGoWeek takes the month from the week's THURSDAY (day[3] = 09-03), so clicking WK35
 *      moves the entire tab to SEPTEMBER — while the deposit the reader is looking for is dated in
 *      August. Nothing on screen says the month moved.
 *   3. reconWindows listed only windows STARTING inside the period. The 08-31 deposit pays for
 *      River's 08-26 -> 09-01 window, which starts in August. Listed in August, not in September.
 *      September's own windows (09-01, 09-02) had not finished running, so the tab came up EMPTY.
 *
 * The money never moved and no total was ever wrong — the week simply became unreachable from the
 * month you were standing in when you went looking for it. That is the worst shape this tab has:
 * it does not read as an error, it reads as "nothing was banked".
 *
 * This file executes the SHIPPED functions over the real calendar of that complaint. It is verified
 * to fail against the pre-fix index.html.
 */
'use strict';

// The window arithmetic is timezone-sensitive by nature, so pin it rather than inherit the runner's.
if (process.env.TZ !== 'America/Los_Angeles') {
  const r = require('child_process').spawnSync(process.execPath, [__filename],
    { stdio: 'inherit', env: { ...process.env, TZ: 'America/Los_Angeles' } });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Lift the real function out of the page. A copy restated here would keep passing after the shipped
// one regressed, which is the only way a test like this can lie.
function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not locate ' + name + ' in index.html');
  let i = HTML.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

const ctx = { console };
vm.createContext(ctx);

for (const decl of ['RECON_WEEK_START_FALLBACK', 'RECON_SALES_MEMOS']) {
  const re = new RegExp('const ' + decl + ' = Object\\.freeze\\([\\s\\S]*?\\);');
  const m = re.exec(HTML);
  if (!m) { console.log(decl + ' is gone from index.html'); console.log('\n0 passed, 1 failed'); process.exit(1); }
  vm.runInContext(m[0], ctx);
}
for (const fn of ['getISOWeek', 'getUserWeek', 'getDaysOfISOWeek', 'monthRange',
                  'reconAddDays', 'reconDow', 'reconWindowStart', 'reconWindows',
                  'reconIsEmptyWindow', 'reconWeekStartFor', 'reconWindowForDeposit', 'reconCoversFrom_',
                  'reconExpectedFor', 'reconBuildRow', 'reconStateKey', 'reconIsDone',
                  'reconIsSalesDeposit', 'reconSplitStrays', 'reconIsPending']) {
  vm.runInContext(grab(fn), ctx);
}
vm.runInContext('var activeYear = 2026, activeMonth = 8, reconData = null, allDailyData = {};', ctx);
const C = ctx;

const SALES_MEMO = 'Med Sales · Rec Sales · Non MJ Sales · Sales 3% Tax · Sales 17% Tax';

console.log('\nthe calendar of the complaint');
// ── 1. WK35 straddles the month, and clicking it lands you in September ────────────────────────
const wk35 = C.getDaysOfISOWeek(2026, 35).map(d => d.toISOString().slice(0, 10));
ok('WK35 runs 2026-08-31 .. 2026-09-06', wk35[0] === '2026-08-31' && wk35[6] === '2026-09-06');
ok('so 08-31 really is in WK35, as Sky said',
   C.getUserWeek(new Date(2026, 7, 31)) === 35);
ok('and 08-30 is the last day of WK34 — the two weeks are adjacent, not overlapping',
   C.getUserWeek(new Date(2026, 7, 30)) === 34);
// periodGoWeek: periodApply({ month: getDaysOfISOWeek(yr, wk)[3].getMonth() + 1 })
ok('clicking WK35 sets the month from its THURSDAY, so the tab jumps to SEPTEMBER',
   C.getDaysOfISOWeek(2026, 35)[3].getMonth() + 1 === 9);
ok('clicking WK34 stays in AUGUST — which is why one worked and the other did not',
   C.getDaysOfISOWeek(2026, 34)[3].getMonth() + 1 === 8);

console.log('\nthe 08-31 deposit pays for a window that STARTS in August');
// ── 2. Attribution is unchanged by this fix; pin it so the cause stays legible ─────────────────
C.reconData = { config: {}, assign: {} };
ok('River (Wed weeks): 08-31 pays for 08-26 .. 09-01',
   C.reconWindowForDeposit('River', { id: 'd', date: '2026-08-31' }) === '2026-08-26');
ok('Bend (Tue weeks): 08-31 pays for 08-25 .. 08-31',
   C.reconWindowForDeposit('Bend', { id: 'd', date: '2026-08-31' }) === '2026-08-25');
ok('both of those windows start in AUGUST, not September',
   C.reconWindowForDeposit('River', { id: 'd', date: '2026-08-31' }) < '2026-09-01' &&
   C.reconWindowForDeposit('Bend',  { id: 'd', date: '2026-08-31' }) < '2026-09-01');

console.log('\nSEPTEMBER must list that window — this is the fix');
// ── 3. The regression itself ──────────────────────────────────────────────────────────────────
const sepFrom = '2026-09-01', sepTo = '2026-09-07';
const SEP_RIVER = C.reconWindows('River', sepFrom, sepTo);
const SEP_BEND  = C.reconWindows('Bend',  sepFrom, sepTo);
ok('River: the straddling 08-26 window is listed in September',
   SEP_RIVER.some(w => w.start === '2026-08-26' && w.end === '2026-09-01'));
ok('Bend: the straddling 08-25 window is listed in September',
   SEP_BEND.some(w => w.start === '2026-08-25' && w.end === '2026-08-31'));
ok('it sorts FIRST, so it is the oldest open week — where the work belongs',
   SEP_RIVER[0].start === '2026-08-26');
ok('exactly one window reaches back before the month — not a second one',
   SEP_RIVER.filter(w => w.start < sepFrom).length === 1);
ok('September still lists its own running week too',
   SEP_RIVER.some(w => w.start === '2026-09-02'));

console.log('\nAUGUST keeps it as well — the week is reachable from BOTH months');
// A week of work must not be findable from only one side of the boundary. State is keyed on
// (store, window start), so appearing twice can never mean reconciling twice.
const AUG_RIVER = C.reconWindows('River', '2026-08-01', '2026-08-31');
ok('August lists 08-26 (it starts there)', AUG_RIVER.some(w => w.start === '2026-08-26'));
ok('and the same window carries the SAME identity in both months',
   C.reconStateKey('River', { start: '2026-08-26' }) === 'River|2026-08-26');
C.reconData = { config: {}, assign: {}, state: { 'River|2026-08-26': 1 } };
ok('so ticking it off in August shows it ticked in September — never twice',
   C.reconIsDone('River', { start: '2026-08-26' }) === true);

console.log('\nend to end: the deposit lands on a card, in September');
// ── 4. The whole path — window list -> attribution -> row — over the real complaint ────────────
C.allDailyData = { River: {} };
for (let d = '2026-08-26'; d <= '2026-09-01'; d = C.reconAddDays(d, 1)) {
  C.allDailyData.River[d] = { netSales: 1000, tax: 200 };
}
C.reconData = {
  config: {}, assign: {}, state: {},
  deposits: { River: [{ id: 'dep831', date: '2026-08-31', amount: 8400, memo: SALES_MEMO }] },
};
const sepRows = C.reconWindows('River', sepFrom, sepTo).map(w => C.reconBuildRow('River', w));
const carrier = sepRows.find(r => r.deps.some(d => d.id === 'dep831'));
ok('the 08-31 deposit appears on a September card at all', !!carrier);
ok('...on the 08-26 .. 09-01 week, which is the week it pays for',
   carrier && carrier.win.start === '2026-08-26' && carrier.win.end === '2026-09-01');
ok('...with the money on it', carrier && carrier.deposited === 8400);
ok('...priced against seven days of sales, not a partial week',
   carrier && carrier.missing.length === 0 && carrier.expected === 8400);
ok('...and it ties, so it is ready to reconcile',
   carrier && carrier.ties === true && carrier.reconcilable === true);

console.log('\na window we know NOTHING about is still dropped');
// ── 5. The reason the old rule existed, kept working ──────────────────────────────────────────
// backfillDailyHistory walks the ACTIVE YEAR only, so a January view straddles back into a December
// that was never fetched. That window must not become the permanent "Incomplete" card at the top of
// the board — the exact failure starts-inside was written to avoid.
C.allDailyData = { River: {} };
C.reconData = { config: {}, assign: {}, state: {}, deposits: { River: [] } };
const janStraddle = C.reconWindows('River', '2026-01-01', '2026-01-31')[0];
ok('a January view does reach back into last December', janStraddle.start < '2026-01-01');
const janRow = C.reconBuildRow('River', janStraddle);
ok('with no sales loaded, all seven days are missing', janRow.missing.length === 7);
ok('and with no money either way it is dropped, not drawn', C.reconIsEmptyWindow(janRow) === true);

// But "no sales" plus "money banked" is a real question and must survive.
C.reconData.deposits.River = [{ id: 'dx', date: C.reconAddDays(janStraddle.end, 1),
                                amount: 5000, memo: SALES_MEMO }];
const janPaid = C.reconBuildRow('River', janStraddle);
ok('money banked for a week we cannot price is NOT dropped',
   janPaid.deps.length === 1 && C.reconIsEmptyWindow(janPaid) === false);
ok('...and it reports incomplete rather than a shortfall',
   janPaid.missing.length === 7 && janPaid.reconcilable === false);

// A fully-populated week is never dropped, however quiet.
C.allDailyData = { River: {} };
for (let d = '2026-08-26'; d <= '2026-09-01'; d = C.reconAddDays(d, 1)) {
  C.allDailyData.River[d] = { netSales: 0, tax: 0 };
}
C.reconData = { config: {}, assign: {}, state: {}, deposits: { River: [] } };
const zeroRow = C.reconBuildRow('River', { start: '2026-08-26', end: '2026-09-01' });
ok('a week with real zero sales is kept — that is data, not absence',
   C.reconIsEmptyWindow(zeroRow) === false);

console.log('\na month-end split booked ON a week-start day joins the week it covers');
// ── 6. Sky, 2026-10-09: "This weeks deposits (for last weeks sales) spans a month" ─────────────
// The live memos and booking dates from reconprobe 2026-09-22..10-11. 09-30 is a Wednesday, so for
// the Wed-start stores the September half is one day, booked on the first day of its own week.
C.reconData = { config: {}, assign: {} };
const W = (store, date, note) => C.reconWindowForDeposit(store, { id: 'm', date, note });
ok('Center: the 09-30 one-day half pays for 09-30 .. 10-06, not the week before',
   W('Center', '2026-09-30', 'CENTER 10.07.26 Dep (9/30/26)') === '2026-09-30');
ok('Center: the October half lands on the same week',
   W('Center', '2026-10-06', 'CENTER 10.07.26 Dep (10/1/26 - 10/6/26)') === '2026-09-30');
ok('Commercial (memo says SOUTH): same, the store name in the memo is not read',
   W('Commercial', '2026-09-30', 'SOUTH 10.07.26 Dep (9/30/26)') === '2026-09-30');
ok('Bend (Tue weeks): both halves were already on 09-29 .. 10-05 and still are',
   W('Bend', '2026-09-30', 'BEND 10.06.26 Dep (9/29/26 - 9/30/26)') === '2026-09-29' &&
   W('Bend', '2026-10-05', 'BEND 10.06.26 Dep (10/1/26 - 10/5/26)') === '2026-09-29');
ok('the ordinary week before it is untouched',
   W('Center', '2026-09-29', 'CENTER 09.30.26 Dep (9/23/26 - 9/29/26)') === '2026-09-23');
// The other reading of a week-start date: an ordinary deposit booked the day AFTER its week closed.
ok('a week-start booking whose memo covers the CLOSED week stays on the closed week',
   W('Center', '2026-09-30', 'CENTER 09.30.26 Dep (9/23/26 - 9/29/26)') === '2026-09-23');
ok('no memo: the date rule, exactly as before',
   W('Center', '2026-09-30', '') === '2026-09-23' &&
   C.reconWindowForDeposit('Center', { id: 'm', date: '2026-09-30' }) === '2026-09-23');
ok('an unreadable period falls back to the date rule',
   W('Center', '2026-09-30', 'CENTER 10.07.26 Dep (0/0/26)') === '2026-09-23' &&
   W('Center', '2026-09-30', 'Order Correction (refund') === '2026-09-23');
ok('a period starting AFTER the booking date is a typo, not a fact',
   W('Center', '2026-09-30', 'CENTER 10.07.26 Dep (10/3/26)') === '2026-09-23');
ok('the typed year is ignored — `.25` in 2026 still reads as this year',
   C.reconCoversFrom_({ date: '2026-09-30', note: 'CENTER 10.07.25 Dep (9/30/25)' }) === '2026-09-30');
ok('a January booking can cover late December',
   C.reconCoversFrom_({ date: '2027-01-02', note: 'BEND 01.05.27 Dep (12/29/26 - 1/2/27)' }) === '2026-12-29');
ok('a manual move still wins over the memo',
   (C.reconData.assign = { m: '2026-09-23' }) &&
   W('Center', '2026-09-30', 'CENTER 10.07.26 Dep (9/30/26)') === '2026-09-23');
C.reconData.assign = {};
ok('October lists the window the 09-30 half now lands on',
   C.reconWindows('Center', '2026-10-01', '2026-10-31').some(w => w.start === '2026-09-30'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
