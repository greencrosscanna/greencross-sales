#!/usr/bin/env node
/* Pacing is the one number on this dashboard built from TWO clocks: net sales come from the poll,
 * "% of day elapsed" comes from GXCore's shaped curve — a snapshot of the SERVER clock taken when
 * ?action=pace was fetched. Nothing forces those two to advance together, and for a while nothing did:
 * paceFracs memoized on first success and never re-fetched. A tab left open kept a morning frac while
 * the poll recorded evening sales, so Est. end of day (net / frac) inflated without bound, and the hero
 * printed "+$1,147 over pace" beside "92% of goal" on a day that finished under.
 *
 * The failure is silent by construction — a frozen frac produces a plausible number, not an error — so
 * it is only catchable by asserting the clock relationship directly. This runs the REAL getPacingPct
 * extracted from index.html against a controlled clock; it does not model it.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull the real function bodies out of the monolith rather than restating them here — a copy would
// keep passing after the shipped code regressed, which is the only way this test could lie.
function grab(name, kind) {
  const re = kind === 'fn'
    ? new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{')
    : new RegExp('\\n(?:const|let) ' + name + '\\b');
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
const STALE_SRC      = /const PACE_FRACS_TTL_MS[\s\S]*?\n/.exec(SRC)?.[0] || '';
const STALEFN_SRC    = /function paceFracsStale\(\)[^\n]*\n/.exec(SRC)?.[0] || '';

if (!STALE_SRC || !STALEFN_SRC) {
  console.log('paceFracs has no freshness stamp — the frozen-clock bug is back.');
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

const ctx = {
  console,
  paceFracs: null, paceFracsAt: 0,
  activeYear: 2026, activeMonth: 8, activeWeek: null, activeDay: null,
  Date: null, // installed per-case
  getDailyGoal: () => 1000,
  getDaysOfISOWeek: () => [],
  toDateStr: d => d.toLocaleDateString('en-CA'),
};
vm.createContext(ctx);

// Returns the epoch ms of the fixed clock. Stamps MUST be derived from this, never from the host's
// real Date.now() — mixing the two makes a stale frac look fresh and the test silently vacuous.
function atClock(iso) {
  const t = new Date(iso).getTime(); // local time: no Z, and getHours() is what pacing reads
  class FakeDate extends Date {
    constructor(...a) { return a.length ? new Date(...a) : new Date(t); }
    static now() { return t; }
  }
  ctx.Date = FakeDate;
  return t;
}

vm.runInContext([THRESHOLDS_SRC, STALE_SRC, STALEFN_SRC, grab('getPacingPct', 'fn')].join('\n'), ctx);

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${got}, wanted ${want}`));
}

const STORES = ['Commercial', 'Century', 'River'];
function pacing() { return vm.runInContext('getPacingPct(' + JSON.stringify(STORES) + ')', ctx); }

console.log('\nafter close, the day is over — no projection may outrun it');
// The exact shape of the screenshotted bug: 10:16 pm, a frac left over from ~9:30.
let now = atClock('2026-08-23T22:16:00');
ctx.activeDay = '2026-08-23';
ctx.paceFracs = { Commercial: 0.86, Century: 0.86, River: 0.86 };
ctx.paceFracsAt = now;                              // FRESH — still must not extrapolate
check('22:16 with a fresh 86% frac still reads 100%', pacing(), 100);

now = atClock('2026-08-23T22:00:00');
ctx.paceFracsAt = now;
check('exactly 22:00 (close) reads 100%', pacing(), 100);

console.log('\nbefore close, a FRESH frac is honored');
now = atClock('2026-08-23T15:00:00');
ctx.paceFracs = { Commercial: 0.50, Century: 0.50, River: 0.50 };
ctx.paceFracsAt = now;
check('15:00 with a fresh 50% frac reads 50%', pacing(), 50);

console.log('\nbefore close, a STALE frac is discarded, not frozen');
// The "left it open for an hour" case: frac fetched at 14:00, read at 20:00.
now = atClock('2026-08-23T20:00:00');
ctx.paceFracs = { Commercial: 0.50, Century: 0.50, River: 0.50 };
ctx.paceFracsAt = now - (6 * 60 * 60 * 1000);  // fetched at 14:00, read at 20:00
const stalePct = pacing();
check('a 6h-old 50% frac does NOT still read 50%', stalePct === 50, false);
// It falls through to the live 8am–10pm ramp: 12h of 14h elapsed → 86%.
check('it falls through to the live clock ramp (86%)', stalePct, 86);

console.log('\nthe projection that inflated: Est. end of day = net / pacing');
// net climbed to 19,058 by 20:00 while the frac stayed at 14:00's 50%.
const frozenEOD = Math.round(19058 / (50 / 100));
const livedEOD  = Math.round(19058 / (stalePct / 100));
console.log(`  frozen frac would project ${frozenEOD.toLocaleString()}; live ramp projects ${livedEOD.toLocaleString()}`);
check('the frozen projection was almost double the lived one', frozenEOD > livedEOD * 1.6, true);

console.log('\npast days never pace');
now = atClock('2026-08-24T12:00:00');
ctx.activeDay = '2026-08-23';
ctx.paceFracs = { Commercial: 0.50, Century: 0.50, River: 0.50 };
ctx.paceFracsAt = now;
check('yesterday reads 100%', pacing(), 100);

/* ── The TTL is an ABANDONMENT threshold, not a refresh interval ───────────────────────────────
 *
 * Asserted against the shipped source because getting this backwards produced a whole Asana to-do:
 * "Sales pace refreshes every 5 minutes, so it lags the kiosk by up to ~150 dollars". It does not.
 * refreshLiveData — which IS the 60-second tick and the visibilitychange catch-up — calls
 * loadPaceFracs(true), and `force` skips the staleness guard entirely. A healthy tab re-fetches the
 * frac every minute; PACE_FRACS_TTL_MS only decides when a frac that could NOT be refreshed stops
 * being trusted.
 *
 * The old comment on the constant claimed the opposite ("well under the 60 s poll, so a poll
 * re-fetches"), which is wrong in both directions and is what the to-do was written from. These
 * pin the real relationship so the next reader cannot inherit the same wrong model. */
console.log('\nthe TTL governs the BROKEN case, not the healthy one');
const POLL = /const AUTO_REFRESH_MS = ([^;]+);/.exec(SRC);
check('the auto-refresh tick is 60 seconds', POLL && eval(POLL[1]), 60 * 1000);
const TTL = /const PACE_FRACS_TTL_MS = ([^;]+);/.exec(SRC);
check('the TTL is longer than the poll, so it is not what schedules a refresh',
      !!(TTL && eval(TTL[1]) > eval(POLL[1])), true);
check('refreshLiveData forces a pace re-fetch, bypassing the TTL',
      /function refreshLiveData\([^)]*\)\s*\{[\s\S]*?loadPaceFracs\(true\)/.test(SRC), true);
check('the 60-second tick goes through refreshLiveData',
      /_autoRefreshTimer = setInterval\([\s\S]*?refreshLiveData\(\)[\s\S]*?AUTO_REFRESH_MS\)/.test(SRC), true);
check('returning to a hidden tab also forces a catch-up',
      /visibilitychange[\s\S]{0,600}refreshLiveData\(\)/.test(SRC), true);
// And the guard the threshold actually exists for: past it, callers drop the curve for the ramp.
check('a stale frac is abandoned rather than trusted',
      /!paceFracsStale\(\)\s*&&\s*paceFracs\[s\]/.test(SRC), true);
// Scoped to the DECLARATION LINE: the prose above the constant quotes the old wording in order to
// explain why it was wrong, and a whole-file search would match that quotation and fail on itself.
check('the declaration carries no trailing claim about the poll',
      /well under/.test(/const PACE_FRACS_TTL_MS = .*/.exec(SRC)[0]), false);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
