#!/usr/bin/env node
/* Stores are shut 22:00–08:00, so the 60s auto-refresh spent every night re-fetching six stores to
 * learn nothing had sold. This pauses it 22:15–08:00.
 *
 * A pause is easy to get wrong in ways that are invisible until a morning goes bad, so this asserts
 * the boundaries AND the three properties the fix rests on:
 *
 *   1. The window WRAPS MIDNIGHT. Written as an AND it is never true and the gate silently does
 *      nothing — the failure mode is "no change", which no smoke test would catch.
 *   2. It never swallows a MANUAL refresh or a page load. Sky checking numbers at 2am must get data;
 *      only the unattended poll sleeps.
 *   3. It resumes on its own at 08:00 because the timer keeps ticking. If the fix ever changes to
 *      clearAutoRefresh(), nothing restarts it and the dashboard is dead until a reload.
 *
 * AMENDED 2026-09-16: the pause now has ONE exception — a tick still fetches when a store is
 * incomplete, because the pause was outlasting a FAILED load. Measured on Sky's phone at 23:36:
 * five of six stores timed out on today's half and the poll that recovers them was asleep, so the
 * dashboard sat dead and would have until 08:00. The exception lives in quiet_recovery_test.js;
 * what stays HERE is that the pause itself still happens and still resumes on its own.
 *
 * The assertion below therefore stopped pinning the gate's exact SPELLING and pins its property
 * instead — paints the pill and returns, never clears the timer. It failed on the shape change
 * while property 3 was fully intact, which is a test describing one implementation rather than the
 * invariant it was written to protect.
 *
 * Runs the REAL inQuietHours + the REAL tick callback grabbed out of index.html.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + '() in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const THRESHOLDS_SRC = /const THRESHOLDS = Object\.freeze\(\{[\s\S]*?\}\);/.exec(SRC)[0];

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${got}, wanted ${want}`));
}

// ── The window itself ────────────────────────────────────────────────────────
const ctx = { console, Date, pill: () => {}, document: { hidden: false } };
vm.createContext(ctx);
vm.runInContext([THRESHOLDS_SRC, grab('inQuietHours')].join('\n'), ctx);

const quiet = (h, m) => vm.runInContext(
  `inQuietHours(new Date(2026, 7, 24, ${h}, ${m || 0}))`, ctx);

console.log('\nthe window is 22:15 → 08:00');
check('22:00 — doors locked, but late tickets still land', quiet(22, 0), false);
check('22:14 — still inside the tail', quiet(22, 14), false);
check('22:15 — the tail is over, sleep', quiet(22, 15), true);
check('23:59', quiet(23, 59), true);
check('00:00 — the window survives midnight', quiet(0, 0), true);
check('03:00', quiet(3, 0), true);
check('07:59 — still shut', quiet(7, 59), true);
check('08:00 — doors open, poll', quiet(8, 0), false);
check('12:00 — the middle of trading is never quiet', quiet(12, 0), false);
check('17:14 — the hour from the pacing screenshots', quiet(17, 14), false);

console.log('\nthe window wraps midnight — an AND here is never true');
// Written `h >= 22.25 && h < 8` the gate is dead: this is the one assertion that catches it.
const anyQuiet = [0, 1, 2, 3, 4, 5, 6, 7, 22.5, 23].some(h => quiet(Math.floor(h), (h % 1) * 60));
check('some hour of the night IS quiet (the gate is not dead code)', anyQuiet, true);
check('and some hour of the day is NOT', [9, 12, 15, 20].some(h => !quiet(h, 0)), true);

console.log('\nthe boundaries come from THRESHOLDS, not from magic numbers in the gate');
const T = vm.runInContext('THRESHOLDS', ctx);
check('QUIET_START_HOUR is declared', T.QUIET_START_HOUR, 22.25);
check('it resumes at STORE_OPEN_HOUR, so the two cannot drift apart', T.STORE_OPEN_HOUR, 8);
check('quiet starts AFTER close, never before it', T.QUIET_START_HOUR > T.STORE_CLOSE_HOUR, true);

// ── The tick: what actually gets skipped ─────────────────────────────────────
console.log('\nthe gate is in the auto-refresh TICK, not in refreshLiveData');
const SCHED = grab('scheduleAutoRefresh');
const tick = /setInterval\(function\(\) \{([\s\S]*?)\}, AUTO_REFRESH_MS\)/.exec(SCHED);
if (!tick) { console.log('  FAIL  could not find the tick body'); fail++; }
else {
  check('the tick consults inQuietHours', /inQuietHours\(\)/.test(tick[1]), true);
  check('and paints the paused pill rather than going silent',
        /paintQuietPill\(\)/.test(tick[1]), true);
  // The whole point: a human asking for data always gets it.
  check('refreshLiveData itself is NOT gated (2am Refresh still fetches)',
        /inQuietHours/.test(grab('refreshLiveData')), false);
  check('loadAllStores is NOT gated (an 11pm page load still loads)',
        /inQuietHours/.test(SRC.slice(SRC.indexOf('async function loadAllStores'),
                                      SRC.indexOf('async function loadAllStores') + 6000)), false);
}

console.log('\nit resumes by itself — the timer must keep ticking through the night');
// The quiet branch must END a tick by painting the pill and returning. Bounded to the branch (no
// intervening `}` closing it) so this cannot be satisfied by a paintQuietPill sitting elsewhere.
check('the tick RETURNS on a quiet minute, it does not clearAutoRefresh',
      /inQuietHours\(\)\s*\)\s*\{[^}]*paintQuietPill\(\);\s*return;/.test(tick ? tick[1] : ''), true);
// ...and the recovery exception is genuinely conditional: an unconditional fetch would defeat the
// pause this whole file exists to protect.
check('a quiet tick only fetches when something is incomplete',
      /if\s*\(\s*!\s*quietRecoveryNeeded_\(\)\s*\)/.test(tick ? tick[1] : ''), true);
check('clearAutoRefresh is never called from inside the tick',
      /clearAutoRefresh/.test(tick ? tick[1] : ''), false);

console.log('\nthe auth heartbeat is left alone — pausing it signs out every overnight tab');
const HB = grab('startSalesHeartbeat');
check('the 10-minute session heartbeat does not consult the gate',
      /inQuietHours/.test(HB), false);

console.log('\na paused poll says so — the pill stops claiming the data is live');
const PQ = grab('paintQuietPill');
check('it repaints the pill', /pill\(/.test(PQ), true);
check('muted, not red — nothing is broken', /pill\('muted'/.test(PQ), true);
check('it names the resume time so the reader need not know the rule',
      /STORE_OPEN_HOUR/.test(PQ), true);
check('the pill no longer reads "Live"', /Live/.test(PQ), false);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
