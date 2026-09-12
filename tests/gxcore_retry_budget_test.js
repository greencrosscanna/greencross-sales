#!/usr/bin/env node
/* Every GX Core call this backend makes goes through a retry loop, and all four of them used to
 * retry on a stopwatch nobody was holding.
 *
 * WHY A BUDGET AND NOT A SHORTER LOOP. The retry is right and must keep working: measured on the
 * live app 2026-09-11 (see v2.585), Hillsboro spent 32.3s on an HTTP 404 whose IMMEDIATE retry then
 * succeeded in 2.5s. That is the whole case these loops exist for, and any guard that kills it is
 * worse than no guard. What was missing is the other end — the same night Center and River were
 * "dead at 60s", and GX Core's own /exec self-probe (?action=request_stats, read 2026-09-12) puts a
 * bounced round trip at 46.6s on average across 11 of 147 probes and 628.8s at worst. Five of those
 * in sequence outruns the 360s Apps Script execution cap, and a killed script gives the caller a
 * dead request instead of the loop's own clean "unreachable" error. A retry that converts a clean
 * failure into a timeout is worse than no retry.
 *
 * So this EXECUTES all four shipped loops out of dutchie_proxy.gs against a scripted clock and a
 * scripted transport, and asserts on the NUMBER OF FETCHES and the ELAPSED TIME. It counts fetches
 * rather than probe marks: the marks are a diagnostic that is off by default, and asserting on them
 * would let a loop that stopped emitting them read as a loop that stopped retrying.
 *
 * WHAT FIXTURE MAKES EACH ASSERTION FAIL (asked of every one of them, per the hub's rule):
 *   - "slow bounces stop early"      fails on any loop with no budget — 5 x 130s = 651s, past 360s.
 *   - "a fast failure still gets 5"  fails if the budget is tightened under the fast lane's cost,
 *                                    or under the measured 32.3s stall-then-recover.
 *   - "a refusal is returned first"  fails if the "{ok:false} is final" rule is ever removed —
 *                                    the fixture answers a refusal on every attempt, so a loop that
 *                                    retries it fetches 5 times instead of once.
 *   - "the message says what broke"  fails on a budget bail that throws a bare timeout with no path,
 *                                    no try count and no reason.
 *   - "a stall that recovers still   fails at any budget <= 32300 — the fixture is the real 2026-09-11
 *      recovers"                     measurement, 32.3s then 2.5s, and a tighter budget kills it.
 *   - "the happy path is untouched"  fails if the budget check is placed before the first attempt.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs — renamed or removed?');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

const isErr = e => !!e && typeof e.message === 'string';

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

/* ── The shipped budget, read out of the file rather than restated here ───────────────────────────
   Read as text on purpose: if the constant is gone the behavior assertions below still run, with
   an infinite budget, and fail the way the unbudgeted loop actually failed. A `grab` would throw
   instead, and a suite that dies is harder to read than a suite that reports. */
const mBudget = /\n(?:const|var)\s+GXCORE_RETRY_BUDGET_MS\s*=\s*(\d+)/.exec(SRC);
ok(!!mBudget, 'dutchie_proxy.gs declares GXCORE_RETRY_BUDGET_MS');
const BUDGET = mBudget ? Number(mBudget[1]) : Infinity;

/* The two ends the number has to sit between, both measured, neither invented here. */
ok(BUDGET > 32300,
   'the budget is above the 32.3s stall that recovered on the next attempt (2026-09-11)',
   'budget=' + BUDGET + 'ms — at or below 32300 the retry this loop exists for never fires');
ok(BUDGET + 130000 <= 300000,
   'budget + the worst measured bounce (130s) leaves 60s of the 360s execution cap',
   'budget=' + BUDGET + 'ms — the guard is checked BEFORE re-asking, so one more attempt is always possible');

/* ── A scripted clock and a scripted transport ────────────────────────────────────────────────────
   `Date` is replaced wholesale: these four functions read Date.now() and never construct a date, so
   a stub with one method is the whole surface and cannot silence anything else. */
let clock = 0, fetches = [];
let script = [];   // one entry per attempt: { ms, code, body } — the last entry repeats forever

function transport(url) {
  const step = script[Math.min(fetches.length, script.length - 1)];
  fetches.push({ url: url, at: clock });
  clock += step.ms;
  return {
    getResponseCode: function () { return step.code; },
    getContentText:  function () { return step.body; },
  };
}

const ctx = {
  console: console,
  GXCORE_EXEC_: 'https://script.example.invalid/macros/s/FAKE/exec',
  Date: { now: function () { return clock; } },
  Utilities: { sleep: function (ms) { clock += ms; } },
  UrlFetchApp: { fetch: transport },
  PropertiesService: {
    getScriptProperties: function () {
      return { getProperty: function (k) { return k === 'GX_DEPLOY_SECRET' ? 'test-secret' : null; } };
    },
  },
  // Not the subject, and deliberately not asserted on: attempts are counted from the transport.
  probeMark_: function () {},
  Logger: { log: function () {} },
};
vm.createContext(ctx);
vm.runInContext(
  (mBudget ? mBudget[0].trim() + '\n' : '') +
  [grab('gxDeploySecret_'), grab('gxRetryHold_'), grab('gxDutchieGet_'), grab('gxCoreRoute_'),
   grab('qbReportViaGXCore_'), grab('qbDepositsViaGXCore_')].join('\n'),
  ctx);

/* Each loop, with a call that reaches its retry path. The point of running all four is that they
   are the same defect four times over against the same endpoint — fixing one and leaving three is
   how the next bad spell still kills a script, just on a different tab. */
const LOOPS = [
  { name: 'gxDutchieGet_',        call: "gxDutchieGet_('River Rd', '/reporting/transactions', { includeItems: 'true' })",
    attempts: 5, names: '/reporting/transactions' },
  { name: 'gxCoreRoute_',         call: "gxCoreRoute_('hourly_shape', { stores: 'River Rd' })",
    attempts: 3, names: 'hourly_shape' },
  { name: 'qbReportViaGXCore_',   call: "qbReportViaGXCore_('2026-09-01', '2026-09-30', 'Month')",
    attempts: 5, names: 'qb_pnl' },
  { name: 'qbDepositsViaGXCore_', call: "qbDepositsViaGXCore_('2026-09-01', '2026-09-30')",
    attempts: 5, names: 'qb_deposits' },
];

function run(loop, scriptSteps) {
  clock = 0; fetches = []; script = scriptSteps;
  let threw = null, value = null;
  try { value = vm.runInContext(loop.call, ctx); } catch (e) { threw = e; }
  return { attempts: fetches.length, elapsed: clock, threw: threw, value: value };
}

// The bounce is a Google HTML error page arriving as a perfectly ordinary 200 — not a JSON refusal.
const HTML = '<!DOCTYPE html><html><body>Sorry, unable to open the file at this time.</body></html>';
const bounce = ms => ({ ms: ms, code: 200, body: HTML });
const refuse = (ms, msg) => ({ ms: ms, code: 200, body: JSON.stringify({ ok: false, error: msg }) });
const answer = (ms, obj) => ({ ms: ms, code: 200, body: JSON.stringify(obj) });

console.log('GX Core retry budget — budget in the shipped file: ' +
            (mBudget ? BUDGET + 'ms' : 'ABSENT'));

LOOPS.forEach(function (loop) {
  console.log('\n' + loop.name);

  /* 1. SLOW BOUNCES STOP EARLY. 130s is the top of the band measured 2026-09-11/12; unbudgeted,
        this loop's own attempt count multiplies it straight past the 360s script cap. */
  let r = run(loop, [bounce(130000)]);
  ok(r.elapsed < 300000,
     '  a run of 130s bounces stays inside the 360s execution cap',
     'elapsed=' + Math.round(r.elapsed / 1000) + 's over ' + r.attempts + ' attempts');
  ok(r.attempts < loop.attempts,
     '  a run of 130s bounces stops before spending every attempt',
     'used all ' + r.attempts + ' of ' + loop.attempts);
  // NOT `instanceof Error`: the vm realm has its own Error constructor, so a throw from the
  // shipped code is never an instance of this file's. Checking for a message is the real question.
  ok(isErr(r.threw), '  ...and still throws rather than returning nothing');

  /* 2. THE ERROR STILL SAYS WHAT WENT WRONG. A budget bail that throws a bare timeout hands the
        reader less than the loop did before the guard existed. */
  const msg = r.threw ? String(r.threw.message) : '';
  ok(msg.indexOf(loop.names) !== -1,
     '  the error names the route that failed', 'message: ' + msg);
  ok(/unreachable/i.test(msg),
     '  the error still says unreachable', 'message: ' + msg);
  ok(/\b\d+\s*tr(y|ies)\b/.test(msg) || /attempt/i.test(msg),
     '  the error says how many attempts it actually made', 'message: ' + msg);
  ok(/limit|budget|stopped/i.test(msg),
     '  the error says it stopped early rather than exhausting the loop', 'message: ' + msg);

  /* 3. A FAST FAILURE STILL GETS EVERY ATTEMPT. This is the lane the retry was written for: the
        ~6% second-hop miss that answers quickly. A budget that clips it is a regression. */
  r = run(loop, [bounce(800)]);
  ok(r.attempts === loop.attempts,
     '  a fast bounce still spends all ' + loop.attempts + ' attempts',
     'made ' + r.attempts + ' in ' + r.elapsed + 'ms');

  /* 4. THE 2026-09-11 RECOVERY. A 32.3s stall whose immediate retry succeeded in 2.5s. If the
        budget is ever tightened under that, this is the measurement it breaks. */
  r = run(loop, [bounce(32300), answer(2500, { ok: true, rows: [{ id: 1 }], data: { x: 1 },
                                               report: { Rows: [] }, deposits: [] })]);
  ok(r.threw === null,
     '  a 32.3s stall whose next attempt answers still succeeds',
     r.threw ? String(r.threw.message) : '');
  ok(r.attempts === 2, '  ...on the second attempt, not later', 'attempts=' + r.attempts);

  /* 5. A REFUSAL IS STILL FINAL. The fixture refuses on EVERY attempt, so a loop that retried a
        parsed {ok:false} would show up here as 3-5 fetches instead of 1. */
  r = run(loop, [refuse(600, 'bad secret')]);
  ok(r.attempts === 1,
     '  a parsed {ok:false} refusal is returned on the first call, not retried',
     'attempts=' + r.attempts);
  ok(isErr(r.threw) && /bad secret/.test(String(r.threw.message)),
     '  ...and the refusal\'s own message survives',
     r.threw ? String(r.threw.message) : 'did not throw');

  /* 6. THE HAPPY PATH IS UNTOUCHED. Fails if the budget check is ever placed before attempt 1. */
  r = run(loop, [answer(3400, { ok: true, rows: [{ id: 1 }], data: { x: 1 },
                                report: { Rows: [] }, deposits: [] })]);
  ok(r.threw === null && r.attempts === 1,
     '  a healthy answer costs exactly one attempt',
     'attempts=' + r.attempts + (r.threw ? ' threw ' + r.threw.message : ''));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
