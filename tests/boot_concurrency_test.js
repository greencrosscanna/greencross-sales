#!/usr/bin/env node
/* THE COLD LOAD FIRED ITS WHOLE BOOT WAVE AT ONCE, AND THE WAVE WAS NINETEEN REQUESTS WIDE.
 *
 * Sky has reported the phone's cold load as slow for weeks. Three previous fixes each looked at
 * ONE request — the Dutchie hop (v2.592), the /exec stall (v2.597), the overnight pause (v2.601) —
 * and each was right about the request it looked at. None of them counted how many were in the air
 * at the same moment.
 *
 * MEASURED 2026-09-17, headless Chrome at a 390x844 mobile viewport, empty profile (cold HTTP
 * cache AND cold localStorage), dev-viewer session, local serve.py against the LIVE backend, with
 * CDP Network events rather than Resource Timing — Resource Timing publishes an entry only once a
 * request COMPLETES, so it cannot see the in-flight set, and a harness built on it declared the
 * load finished at 16s with twelve requests still open:
 *
 *   35 requests · peak 19 SIMULTANEOUS · 19 of them started inside the first 500ms · last at 47.1s
 *
 * The controlled comparison is inside that single load. The same routes were fetched twice, once
 * inside the 19-wide burst and once outside it: GX Core `config` 8.36s -> 2.23s, `published_goals`
 * 8.23s -> 2.90s, a store's settled MONTH 7.4-8.0s while a store's whole YEAR — strictly more work
 * — came back in 2.04-2.46s at 8-wide. The requests did not get slower; the queue in front of them
 * got longer. Apps Script caps SIMULTANEOUS EXECUTIONS PER USER at 30 across every GX app and
 * trigger, and one phone opening Sales was taking 19 of them in one instant.
 *
 * WHAT THIS FILE PINS. A width, a priority order, and the two places the fix could quietly undo
 * itself: a lane held across a retry ladder (which would serialize the pool), and an abort ceiling
 * armed before the queue wait (which would spend a measured ceiling standing in line and weaken
 * every one of them — the v2.597 work, undone from the other direction).
 *
 * EXECUTES the shipped gasSlot_ / _gasPump / gasGate_ / gasFetchJson out of index.html. Nothing
 * here is a reimplementation; §1 §8 §9 read the source, and their reasons are given where they sit.
 *
 * Point it at another revision to prove it discriminates:
 *   git show HEAD:index.html > /tmp/head.html && GX_INDEX_HTML=/tmp/head.html node tests/boot_concurrency_test.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC_PATH = process.env.GX_INDEX_HTML || path.join(__dirname, '..', 'index.html');
const HTML = fs.readFileSync(SRC_PATH, 'utf8');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
};
function section(title, body) {
  console.log('\n' + title);
  try { body(); }
  catch (e) { fail++; console.log('  FAIL the section could not run at all\n       ' + String((e && e.message) || e)); }
}
async function asection(title, body) {
  console.log('\n' + title);
  try { await body(); }
  catch (e) { fail++; console.log('  FAIL the section could not run at all\n       ' + String((e && e.message) || e)); }
}
/* A suite that exits before its summary reports 0 failed and reads as a pass. This repo has been
 * bitten by exactly that (background_refresh_test, 2026-09-11, six silent runs in twelve). */
let finished = false;
process.on('exit', code => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not locate ' + name + ' in ' + path.basename(SRC_PATH));
  let i = HTML.indexOf('{', m.index + m[0].indexOf('(')), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

/* The queue's declarations, lifted whole. Slice runs from the first constant to gasFetchJson,
 * which sits immediately after it — so the CONSTANTS this file asserts on are the same characters
 * the app runs, never a copy. */
function gasQueueSrc() {
  const a = HTML.indexOf('const GAS_MAX_INFLIGHT');
  const b = HTML.indexOf('async function gasFetchJson');
  if (a < 0 || b < 0 || b < a) throw new Error('the request queue is not in ' + path.basename(SRC_PATH));
  return HTML.slice(a, b);
}

/* `const`/`let` at the top level of a vm script live in the context's LEXICAL scope and never
 * become properties of the sandbox object, so GAS_PRIO and _gasInflight are invisible to ctx.X and
 * would read `undefined` — which is a passing comparison against another undefined, i.e. a check
 * that cannot fail. Evaluate them in the context instead. */
function peek(ctx, expr) { return vm.runInContext(expr, ctx); }
function PRIO(ctx) { return peek(ctx, 'GAS_PRIO'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
function deferred() { let r; const p = new Promise(res => { r = res; }); return { p, resolve: r }; }

/* A fresh context per section: _gasInflight and _gasQueue are module state, and a section that
 * inherited another's leftovers would be measuring the previous test. */
function bootQueue(extra) {
  const ctx = Object.assign({
    console: { warn() {}, log() {}, error() {} },
    Promise, Number, Math, JSON, Error, Array, Object, String,
    setTimeout, clearTimeout,
  }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(gasQueueSrc(), ctx);
  return ctx;
}

/* ══ 1. THE WIDTH ═════════════════════════════════════════════════════════════════════════════
 * Read, not executed, and the band is HARDCODED HERE ON PURPOSE. It is a floor and a ceiling that
 * the implementation cannot reach, so narrowing or widening the app moves the number out of a band
 * a human has to come back and re-argue — the same reason secret_scrub_test's §7 floor is typed
 * rather than derived. A test that took the band from the constant would go green for any value. */
let N = null;
section('1. the cap is a real constant, and it sits in the band the measurement supports', () => {
  const m = /\n\s*const GAS_MAX_INFLIGHT\s*=\s*(\d+)\s*;/.exec(HTML);
  ok('GAS_MAX_INFLIGHT is declared', !!m);
  N = m ? Number(m[1]) : null;

  /* UPPER BOUND — 19-wide measured 7.4-8.4s a request against 2.0-2.5s at 8-wide for a strictly
     larger one, and the 30-execution ceiling is SHARED with Inventory, the Leaderboard kiosk and
     every trigger. Anything past 12 is extrapolating into the band where the only data says 7.5s,
     and is antisocial even when Sales itself is fast. */
  ok('...and is not wide enough to congest the shared 30-execution ceiling again (<= 12)',
     N !== null && N <= 12, 'GAS_MAX_INFLIGHT = ' + N);

  /* LOWER BOUND — and this is the half that stops this becoming SPIFF's number. SPIFF lanes 6
     calls of ~9s. Sales fires ~31 of ~2.5s, so PULL_LANES = 2 here would serialize the load into
     ~45s and make the GOOD case far worse than the 9.5s it can already reach. 16 of the opening
     19 are first-paint work: at N=8 that is two waves, at N=6 three, at N=4 four. */
  ok('...and not so narrow that it serializes the load it exists to speed up (>= 6)',
     N !== null && N >= 6,
     'GAS_MAX_INFLIGHT = ' + N + ' — at ~2.5s a request this is ceil(16/N) waves before first paint');

  const wd = /\n\s*const GAS_SLOT_MAX_MS\s*=\s*(\d+)\s*;/.exec(HTML);
  ok('a stuck slot has a deadline as well as a release', !!wd);
  /* Above the longest legitimate holder — a live half's 25s second attempt — so the watchdog can
     only ever fire on something genuinely lost. Below anything a reader would sit through. */
  ok('...and it outlasts the longest legitimate holder (25s) without outlasting the reader',
     !!wd && Number(wd[1]) > 25000 && Number(wd[1]) <= 120000,
     wd ? 'GAS_SLOT_MAX_MS = ' + wd[1] : '');
});

/* ══ 2. THE CAP IS ENFORCED, not merely declared ══════════════════════════════════════════════ */
const S2 = () => asection('2. the cap actually bounds what is in flight (EXECUTED)', async () => {
  const ctx = bootQueue();
  let live = 0, peak = 0;
  const gates = [];
  const jobs = [];
  for (let i = 0; i < 20; i++) {
    const d = deferred();
    gates.push(d);
    jobs.push(ctx.gasGate_(0, async () => { live++; peak = Math.max(peak, live); await d.p; live--; }));
  }
  await sleep(30);
  ok('a burst of 20 never exceeds the cap', peak === N, 'peak in flight was ' + peak + ', cap is ' + N);
  ok('...and it fills the pool rather than trickling', live === N, 'live = ' + live);
  gates.forEach(g => g.resolve());
  await Promise.all(jobs);
  ok('every queued job still ran — a cap must not drop work', peak === N && live === 0);
  ok('...and the pool empties afterwards, so the next load starts from zero', peek(ctx, '_gasInflight') === 0,
     '_gasInflight = ' + peek(ctx, '_gasInflight'));
});

/* ══ 3. ORDERING — what the screen is waiting on goes first ═══════════════════════════════════
 * The pool is SATURATED before either lane is queued, deliberately. Strict priority is a statement
 * about what is WAITING; a queue that is never contended would pass a priority test by accident and
 * prove nothing. This is the shape the 2026-09-17 measurement actually showed: at t=22.1s the four
 * backfill year-pulls, cogs_dutchie, velocity, period_goals and pace all went out in one instant,
 * and cogs_dutchie burned its whole 25s ceiling. */
const S3 = () => asection('3. a SCREEN request queued LAST still beats a BACKGROUND one queued first (EXECUTED)', async () => {
  const ctx = bootQueue();
  const order = [];
  const block = deferred();
  const fill = [];
  for (let i = 0; i < N; i++) fill.push(ctx.gasGate_(0, () => block.p));
  await sleep(20);

  const queued = [];
  for (const tag of ['bg1', 'bg2', 'bg3']) queued.push(ctx.gasGate_(PRIO(ctx).BACKGROUND, async () => { order.push(tag); }));
  for (const tag of ['sec1'])             queued.push(ctx.gasGate_(PRIO(ctx).SECONDARY,  async () => { order.push(tag); }));
  for (const tag of ['scr1', 'scr2'])     queued.push(ctx.gasGate_(PRIO(ctx).SCREEN,     async () => { order.push(tag); }));
  await sleep(20);
  ok('nothing queued jumps the saturated pool', order.length === 0, 'ran early: ' + order.join(','));

  block.resolve();
  await Promise.all(fill.concat(queued));

  ok('the two SCREEN requests ran first, though they were queued last',
     order.slice(0, 2).join(',') === 'scr1,scr2', 'order was ' + order.join(','));
  ok('...then SECONDARY', order[2] === 'sec1', 'order was ' + order.join(','));
  ok('...and BACKGROUND last, in the order it was asked (FIFO inside a lane)',
     order.slice(3).join(',') === 'bg1,bg2,bg3', 'order was ' + order.join(','));

  /* THE DEFAULT MATTERS AS MUCH AS THE ORDER. A call site that says nothing must behave exactly as
     it did before this queue existed — front of the queue — so that forgetting an annotation on a
     new route cannot silently starve it. Failing safe in the other direction is invisible. */
  ok('SCREEN is 0, so an un-annotated call site defaults to the front', PRIO(ctx).SCREEN === 0);
});

/* ══ 4. THE LANE IS PER ATTEMPT, NOT PER CALL ═════════════════════════════════════════════════
 * A live half is 12s + backoff + 25s. Held across the whole ladder, one of those occupies a lane
 * for ~38 seconds while doing nothing for most of it — the retry ladder would eat the pool it is
 * queueing in, and the fix would have bought its width back at the price of the recovery v2.597
 * exists for. Saturate with N failing calls and assert an N+1th gets in while they are in backoff. */
const S4 = () => asection('4. a retrying request gives its lane back between attempts (EXECUTED)', async () => {
  const events = [];
  const ctx = bootQueue({
    AbortController: function () { this.signal = { aborted: false }; this.abort = () => { this.signal.aborted = true; }; },
    fetch: (url) => {
      const tag = /tag=([a-z0-9]+)/.exec(url)[1];
      events.push('fetch:' + tag);
      if (tag === 'late') return Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') });
      // Every saturating call fails its first attempt, then succeeds on the second.
      const nth = events.filter(e => e === 'fetch:' + tag).length;
      if (nth === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') });
    },
  });
  vm.runInContext(grab('gasFetchJson'), ctx);

  const busy = [];
  for (let i = 0; i < N; i++) busy.push(ctx.gasFetchJson('https://x.invalid/exec?tag=s' + i, 2, 5000));
  // Queued only after the pool is full, so it can only run once a lane is genuinely released.
  await sleep(5);
  const late = ctx.gasFetchJson('https://x.invalid/exec?tag=late', 1, 5000);
  await Promise.all(busy.concat([late]));

  const lateAt   = events.indexOf('fetch:late');
  const firstRe  = events.findIndex((e, i) => e.startsWith('fetch:s') && events.indexOf(e) !== i);
  ok('the N+1th request went out at all', lateAt >= 0, events.join(' '));
  ok('...and it went out DURING the backoff, ahead of any second attempt',
     lateAt >= 0 && firstRe >= 0 && lateAt < firstRe,
     'late at ' + lateAt + ', first retry at ' + firstRe + ' — ' + events.join(' '));
  ok('no lane was leaked by the ladder', peek(ctx, '_gasInflight') === 0, '_gasInflight = ' + peek(ctx, '_gasInflight'));
});

/* ══ 5. THE CEILING IS ARMED AFTER THE WAIT, NEVER BEFORE IT ══════════════════════════════════
 * This is the one way the change could quietly undo v2.597. PHASE_CAPS_ are measurements of how
 * long a REQUEST may take on the wire; start their clock while the request is still queued and
 * every one of them is silently shortened by the queue wait — which on the load that motivated
 * this fix was several seconds. Executed with a real clock and a real ceiling: the queued call is
 * given a 400ms ceiling and made to wait 900ms for a lane. If the timer were armed at call time it
 * would abort before it was ever sent. */
const S5 = () => asection('5. queue time is not attempt time (EXECUTED, real clock)', async () => {
  let sent = 0;
  const ctx = bootQueue({
    AbortController,
    fetch: (url, opts) => {
      sent++;
      const s = opts && opts.signal;
      /* AN ALREADY-ABORTED SIGNAL REJECTS IMMEDIATELY, exactly as the real fetch does — and this
         line is the whole test. Without it the fake only listens for FUTURE aborts, so a ceiling
         armed before the queue wait fires harmlessly while the request is still queued and the
         fake then answers normally: the assertion below passes against the very mutation it
         exists to catch. Found by mutating it (M2), not by reading it. */
      if (s && s.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return new Promise((res, rej) => {
        const t = setTimeout(() => res({ ok: true, text: () => Promise.resolve('{"ok":true}') }), 80);
        if (s) s.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    },
  });
  vm.runInContext(grab('gasFetchJson'), ctx);

  const block = deferred();
  const fill = [];
  for (let i = 0; i < N; i++) fill.push(ctx.gasGate_(PRIO(ctx).SCREEN, () => block.p));
  await sleep(20);

  const queued = ctx.gasFetchJson('https://x.invalid/exec?tag=q', null, [400]);
  await sleep(900);                       // three times its own ceiling, spent waiting for a lane
  ok('the queued request has not been sent yet', sent === 0, 'sent = ' + sent);
  block.resolve();

  let res = null, err = null;
  try { res = await queued; } catch (e) { err = e; }
  await Promise.all(fill);

  ok('...and when its lane came it got its FULL ceiling, not the remains of one',
     !!res && res.ok === true,
     err ? 'it failed with: ' + err.message + ' — the abort timer is being armed before the wait'
         : 'no result and no error');
  ok('and the lane is given back', peek(ctx, '_gasInflight') === 0, '_gasInflight = ' + peek(ctx, '_gasInflight'));
});

/* ══ 6. A LOST SLOT IS RECOVERED ══════════════════════════════════════════════════════════════
 * A lane that depends on somebody remembering to give it back is a lane that eventually is not
 * given back, and a permanently narrowed pool is strictly worse than never having had one — the
 * same reasoning that makes `_serverBypassUntil` a timestamp rather than a flag, and bugMailOnce_
 * fail open. Executed against a controllable timer so the 90 seconds do not have to be waited. */
const S6 = () => asection('6. a slot held past the deadline is released (EXECUTED, controlled timer)', async () => {
  const timers = [];
  const ctx = bootQueue({
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  let ran = 0;
  const stuck = [];
  for (let i = 0; i < N; i++) stuck.push(ctx.gasGate_(0, () => new Promise(() => {})));   // never settles
  await sleep(10);
  ctx.gasGate_(0, async () => { ran++; });
  await sleep(10);
  ok('a pool of never-settling holders blocks the queue, as it must', ran === 0);

  const wd = timers.filter(t => t.ms === Number(/const GAS_SLOT_MAX_MS\s*=\s*(\d+)/.exec(HTML)[1]));
  ok('every holder armed a watchdog at the deadline', wd.length === N, 'armed ' + wd.length + ' of ' + N);
  wd[0].f();                                   // the deadline passes on exactly one of them
  await sleep(10);
  ok('...and firing one hands its lane to the waiting request', ran === 1, 'ran = ' + ran);

  /* And the ordinary path must NOT leave a watchdog armed behind it — a timer per request that is
     never cleared is a leak that only shows up on a long-lived tab, which is every tab here. */
  const ctx2 = bootQueue({
    setTimeout: (f, ms) => { timers.push({ f, ms, id: timers.length + 1 }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
  });
  const before = timers.length;
  await ctx2.gasGate_(0, async () => {});
  const armed = timers.slice(before);
  ok('a normal release clears its own watchdog', armed.length === 1 && armed[0].cleared === true,
     JSON.stringify(armed.map(t => ({ ms: t.ms, cleared: !!t.cleared }))));
});

/* ══ 7. THE BOOT PATH — what is on it, and what is no longer on it ════════════════════════════ */
section('7. the boot wave', () => {
  const load = grab('loadAllStores');

  /* loadVelocity was paid by EVERY load and read by the INVENTORY TAB ONLY — the same sentence
     that moved expbudgets/expenses off this line on v2.571, still true one call further down. Its
     own comment said "inventory loads last — lowest priority" while it was being fired on every
     boot by everyone who never opens that tab. */
  ok('loadVelocity() is off the boot path', !/\n\s*loadVelocity\(\);/.test(load),
     'it is Inventory-tab data on every Income-tab load');

  /* AND THE CHECK THAT IT WAS MOVED RATHER THAN DELETED. Without this the assertion above passes
     for a version of the app that simply lost its sales-speed data — which is the green-0 failure
     velocity_via_core_test exists for, reintroduced by a performance fix. */
  ok('...because renderInventory asks for it when the tab is first drawn',
     /loadVelocity\(\)\.then/.test(grab('renderInventory')));
  ok('...guarded by tried-not-loading, so the render it triggers does not re-fire it',
     /_velocityTriedAt/.test(grab('renderInventory')));

  ok('expbudgets is still off the boot path (v2.571 — do not let it back)',
     !/loadExpBudgets\(\)/.test(load));

  // The three bare-fetch loaders on the boot path take a lane, or the cap is a number that is not
  // true: a request outside the pool is a request the pool cannot count.
  ok('otherrev goes through the queue', /gasGate_\(GAS_PRIO\.SCREEN/.test(grab('loadOtherRevenue')));
  ok('period_goals goes through the queue', /gasGate_\(GAS_PRIO\.SCREEN/.test(grab('loadPeriodGoals')));
  ok('cogs_dutchie goes through the queue, in the SECONDARY lane',
     /gasGate_\(GAS_PRIO\.SECONDARY/.test(grab('loadInvGmData')));
  ok('...and its own 25s ceiling is armed INSIDE the lane, not before it',
     /gasGate_\(GAS_PRIO\.SECONDARY[\s\S]{0,200}?setTimeout\(\(\) => ac\.abort\(\), 25000\)/.test(grab('loadInvGmData')));

  ok('the day-of-week backfill is in the BACKGROUND lane',
     /gasFetchJson\(url, 2, 15000, GAS_PRIO\.BACKGROUND\)/.test(grab('backfillDailyHistory')),
     'a pool of 4 bounds how many of these run, not whether they run ahead of the pace line');

  ok('loadAllStores itself opens no un-queued request', !/await fetch\(/.test(load));
});

/* ══ 8. THE WIN WAS NOT BOUGHT BY RELAXING THE CEILINGS ═══════════════════════════════════════
 * HARDCODED, and unreachable from the implementation, for the same reason as §1's band. These four
 * numbers are v2.597's measurement — 12s first because a stall has to be called early, 25s second
 * because it must outlast DTODAY_WAIT_MS_, three settled attempts because a failed settled half
 * drops the store out of the company total. A concurrency fix that "also" widened them would be
 * trading a measured guarantee for a number nobody measured. */
section('8. the measured per-attempt ceilings are untouched', () => {
  const live = /const LIVE_PHASE_CAPS_\s*=\s*\[([^\]]*)\]/.exec(HTML);
  const settled = /const SETTLED_PHASE_CAPS_\s*=\s*\[([^\]]*)\]/.exec(HTML);
  ok('LIVE_PHASE_CAPS_ is still [12000, 25000]',
     !!live && live[1].replace(/\s/g, '') === '12000,25000', live ? live[1] : 'not found');
  ok('SETTLED_PHASE_CAPS_ is still [8000, 12000, 16000]',
     !!settled && settled[1].replace(/\s/g, '') === '8000,12000,16000', settled ? settled[1] : 'not found');
  ok('and the store fetch still passes them per phase',
     /gasFetchJson\(url, null, phase === 'live' \? LIVE_PHASE_CAPS_ : SETTLED_PHASE_CAPS_/.test(grab('loadAllStores')));
});

(async () => {
  await S2(); await S3(); await S4(); await S5(); await S6();
  finished = true;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
