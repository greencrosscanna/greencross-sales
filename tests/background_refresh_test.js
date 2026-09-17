#!/usr/bin/env node
/* Two things reported by Sky on 2026-09-03, both about the app throwing away something it already
 * had rather than about the thing it was fetching.
 *
 * 1. "the page should do the initial load, then quietly update in the background. right now it is
 *    taking previously loaded data and changing to the shimmer load state while it updates."
 *    loadAllStores opened with an unconditional `liveData = {}`, so every 60-second poll blanked
 *    six stores that were already on screen and correct. Shimmer means "we have nothing yet"; a
 *    poll always has something. The wipe still has to happen on a PERIOD change — without it the
 *    old month's figure survives under the new month's header, the July-736k trap — so the fix is a
 *    period key, not deleting the wipe.
 *
 * 2. "repeat error, tried to submit this bug but it didn't go thru", and "it takes 5-10s to log in".
 *    Both were bare fetches to this app's Apps Script /exec with no retry. That endpoint 302s to
 *    script.googleusercontent.com and the second hop intermittently bounces, returning an HTML page;
 *    r.json() threw and the user saw a failure for a request the server never refused. Measured on
 *    the live deployment the same day: three routes returned Google "Page Not Found" HTML inside one
 *    minute, while ?action=login and ?action=ping both answered in ~1.8s median when they did not
 *    bounce — so the login is not slow, it is occasionally retried by hand.
 *
 * Runs against the shipped index.html. The retry helper is EXECUTED against a stubbed fetch, because
 * "retries a bounce but never re-sends a refusal" is a behavior, not a shape.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

/* THE REQUEST QUEUE IS STUBBED OUT IN THIS FILE, DELIBERATELY.
 *
 * gasFetchJson takes a lane from gasSlot_ before each attempt (see GAS_MAX_INFLIGHT in
 * index.html). The contexts below fake setTimeout so that EVERY timer fires the instant it is
 * armed — which is what makes the retry-ladder assertions deterministic, and which would also fire
 * the queue's 90-second stuck-slot watchdog before the request it is guarding had started. The
 * in-flight count would then drift and these assertions would be measuring the fake, not the
 * ladder.
 *
 * So the lane is a no-op here and the queue has its own suite (tests/boot_concurrency_test.js),
 * which executes the real gasSlot_/_gasPump against a real clock. This file keeps its subject: how
 * many attempts, at which ceilings, in what order. Splitting them is what keeps either readable.
 *
 * It is a stub of a REAL function, so it still proves gasFetchJson CALLS one — delete gasSlot_ from
 * index.html and the app breaks while this file keeps passing, which is exactly why the other suite
 * asserts the call site rather than this one. */
function gasQueueStub() {
  return 'function gasSlot_() { return Promise.resolve(function () {}); }';
}

/** Code with comments removed. Several of these functions describe the very pattern they must not
 *  contain, and a test that reads prose as code fails the correct implementation for documenting
 *  itself — which teaches the next person to delete the explanation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/* A SUITE THAT NEVER REACHES ITS OWN SUMMARY MUST NOT EXIT 0.
 *
 * The body is an async IIFE, so an await that never settles ends the process quietly with exit 0
 * and nothing on stdout — indistinguishable, to the push gate, from a clean pass. That is the
 * failure this file already warns about one line above its exitCode, from a cause it did not
 * anticipate. Belt and braces: if the summary never printed, say so and fail. */
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// ── 1. The poll must not blank what is already on screen ─────────────────────
{
  const load = stripComments(grab('loadAllStores'));

  ok(/_liveDataKey\s*!==\s*loadKey/.test(load),
     'loadAllStores wipes liveData only when the period key changed');
  ok(/const loadKey = activeYear \+ ':' \+ activeMonth/.test(load),
     'the period key is year:month — the granularity liveData is actually fetched at');

  // An unconditional wipe anywhere in the function is the regression. The only `liveData = {}` left
  // must be the one inside the guard, on the same line as it.
  const wipes = load.split('\n').filter(l => /(^|[^.\w])liveData\s*=\s*\{\s*\}/.test(l));
  eq(wipes.length, 1, 'exactly one liveData wipe survives in loadAllStores');
  ok(/_liveDataKey/.test(wipes[0] || ''),
     'that wipe is guarded by the period key, not unconditional');

  // The guard is only safe because a period change routes through here. If periodApply ever stops
  // reloading on a year/month change, the stale period would survive on screen.
  const apply = grab('periodApply');
  ok(/o\.year !== activeYear \|\| o\.month !== activeMonth/.test(apply) && /loadAllStores\(\)/.test(apply),
     'a year/month change still reaches loadAllStores, so the key can do its job');

  // The explicit clears are a different intent — "forget what you have" — and must still blank it.
  for (const fn of ['clearAllCache', 'clearDutchieCache', 'hardReset']) {
    ok(/clearLiveData\(\)/.test(grab(fn)), fn + ' still clears liveData outright');
  }

  // THE ONE THAT ACTUALLY CAUSED THE FLICKER. refreshLiveData is not just the Refresh button — the
  // 60-second auto-refresh tick calls it. Clearing there defeats the period key entirely, because
  // clearLiveData() also nulls it, so loadAllStores wipes on the very next line. v2.560 fixed the
  // guard and left this path blanking; the screen looked exactly as it had before.
  // Strip comments first: this function EXPLAINS at length why it must not clear, and matching that
  // prose would fail a correct implementation for saying so.
  const refresh = stripComments(grab('refreshLiveData'));
  ok(!/clearLiveData\(\)/.test(refresh),
     'refreshLiveData does NOT blank liveData — it is the polling path, not a "forget everything"');
  ok(!/(^|[^.\w])liveData\s*=\s*\{\s*\}/.test(refresh),
     'refreshLiveData does not blank liveData by hand either');
  ok(/localStorage\.removeItem\(salesCacheKey/.test(refresh),
     'it still busts the localStorage cache — that, not blanking, is what forces the re-fetch');

  // And the poll really does route through it, which is why the above matters.
  const sched = grab('scheduleAutoRefresh');
  ok(/refreshLiveData\(\)/.test(sched),
     'the auto-refresh tick calls refreshLiveData — so that path must never blank the screen');
  ok(/liveData = \{\};\s*_liveDataKey = null;/.test(grab('clearLiveData')),
     'clearLiveData resets the key too — a wipe the loader cannot see is worse than no wipe');
}

// ── 2. The retry: bounces are retried, refusals are not ──────────────────────
function runFetchCase(responses) {
  const calls = [];
  const ctx = {
    console, Math, JSON, Error, Promise, setTimeout: (f) => f(),   // no real waiting in a test
    fetch: (url) => {
      calls.push(url);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r.throw) return Promise.reject(new Error(r.throw));
      return Promise.resolve({ ok: r.ok !== false, status: r.status || 200,
                               text: () => Promise.resolve(r.body) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(gasQueueStub() + '\n' + grab('gasFetchJson'), ctx);
  return { calls, run: ctx.gasFetchJson('https://example.test/exec?action=x', 3) };
}

const HTML_BOUNCE = '<!DOCTYPE html><html><head><title>Page Not Found</title></head><body></body></html>';

(async () => {
  // A clean answer is returned on the first call — no retry, no extra request.
  {
    const c = runFetchCase([{ body: '{"ok":true,"token":"t"}' }]);
    const out = await c.run;
    eq(out.ok, true, 'a clean JSON answer comes straight back');
    eq(c.calls.length, 1, 'a clean answer costs exactly one request');
  }

  // A bounce returns HTML. That is the ~6% flake and must be retried, not surfaced.
  {
    const c = runFetchCase([{ body: HTML_BOUNCE }, { body: '{"ok":true,"token":"t"}' }]);
    const out = await c.run;
    eq(out.ok, true, 'an HTML bounce is retried and the retry answer is used');
    eq(c.calls.length, 2, 'the bounce cost one retry, not more');
  }

  // A body truncated mid-string is the same flake wearing a JSON error.
  {
    const c = runFetchCase([{ body: '{"ok":true,"perio' }, { body: '{"ok":true}' }]);
    const out = await c.run;
    eq(out.ok, true, 'a truncated body is retried rather than reported as a server fault');
  }

  // THE ONE THAT MATTERS FOR A WRITE. A parsed {ok:false} is the server's ANSWER. Retrying it would
  // be wrong for a login (it is a wrong password) and dangerous for a bug report (gxIngestBug has no
  // dedupe, so a re-send files the report twice).
  {
    const c = runFetchCase([{ body: '{"ok":false,"error":"Invalid username or password"}' }]);
    const out = await c.run;
    eq(out.ok, false, 'a refusal is returned, not swallowed');
    eq(out.error, 'Invalid username or password', 'the refusal keeps its own message');
    eq(c.calls.length, 1, 'a REFUSAL IS NEVER RETRIED — re-sending a write is how one becomes two');
  }

  // Exhausting the retries still fails, rather than returning something invented.
  {
    const c = runFetchCase([{ body: HTML_BOUNCE }]);
    let threw = null;
    try { await c.run; } catch (e) { threw = e; }
    ok(threw !== null, 'a request that never parses ends up throwing, not resolving');
    eq(c.calls.length, 3, 'it gave up after the requested number of attempts');
  }

  // A network reject and an HTTP error are transport failures too.
  {
    const c = runFetchCase([{ throw: 'network down' }, { body: '{"ok":true}' }]);
    eq((await c.run).ok, true, 'a network reject is retried');
  }
  {
    const c = runFetchCase([{ ok: false, status: 500, body: 'boom' }, { body: '{"ok":true}' }]);
    eq((await c.run).ok, true, 'an HTTP error is retried');
  }

  // ── 2b. A request that never comes back must not wait forever ─────────────
  // The bare fetch had no timeout at all, so a bounced /exec left the request unresolved: no error,
  // no state change, just a store row shimmering while the other five filled in. That is a STALL,
  // and it is invisible to a retry — you cannot retry a request that has not finished.
  {
    const src = grab('gasFetchJson');
    ok(/AbortController/.test(src), 'gasFetchJson bounds the wait with an AbortController');
    ok(/clearTimeout\(timer\)/.test(src) && /finally/.test(src),
       'the timer is cleared in a finally — a resolved request must not leave one armed');
    ok(/AbortError/.test(src), 'an abort is reported as a timeout, not as a mystery failure');

    // Executed: a request that never settles is abandoned and retried, and eventually throws.
    const calls = [];
    const ctx = {
      console, Math, JSON, Error, Promise, clearTimeout: () => {},
      /* FIRE EVERY TIMER IMMEDIATELY. This used to fire only ms >= 1000 — "fire the abort, skip the
       * backoff" — but the two cannot be told apart by duration: the abort is scheduled at `cap`
       * (1000 here) and gasFetchJson's retry backoff at 700 + Math.random() * 500, i.e. 700-1200.
       * When the random landed under 1000 the backoff promise never resolved, this suite hung on
       * its own await, and Node emptied the event loop and exited 0 WITH NO OUTPUT — which
       * gx-preflight.sh reads as a pass. Measured 2026-09-11: 6 silent runs in 12, so roughly half
       * of all pushes were gated on 43 assertions that never ran. Firing everything at once is
       * still no real waiting, and it is deterministic. */
      setTimeout: (f) => { f(); return 1; },
      AbortController: function () {
        this.signal = { aborted: false };
        this.abort = () => { this.signal.aborted = true; if (this._onabort) this._onabort(); };
      },
      fetch: (url, opts) => {
        calls.push(url);
        // Never settles on its own — only the abort can end it. This is the hung /exec.
        return new Promise((_res, rej) => {
          const s = opts && opts.signal;
          if (s && s.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          const iv = setInterval(() => {
            if (s && s.aborted) { clearInterval(iv); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
          }, 1);
        });
      },
    };
    vm.createContext(ctx);
    vm.runInContext(gasQueueStub() + '\n' + grab('gasFetchJson'), ctx);
    let msg = null;
    try { await ctx.gasFetchJson('https://example.test/exec', 2, 1000); }
    catch (e) { msg = e.message; }
    ok(msg !== null && /timed out/.test(msg || ''),
       'a hung request ends in a timeout, not an unresolved promise (got ' + msg + ')');
    eq(calls.length, 2, 'the hung request was abandoned and retried, not waited on');
  }

  /* ── 2b-ii. EACH ATTEMPT GETS ITS OWN CEILING ────────────────────────────────
   *
   * Sky, 2026-09-15: "still taking 60+sec to load on mobile." A stalled /exec never answers and a
   * slow Dutchie hop answers late, and one flat ceiling has to be wrong for one of them — set for
   * the hop (28s), it let every stall hold the load for 56 seconds. Measured that day: 6 of 174
   * six-wide requests stalled 11-60s while their siblings answered in 3.1s median. So the first
   * attempt is short and the later ones patient. (Corrected 2026-09-17 from "8 of 234" — the 234
   * pooled four concurrency widths; CLAUDE.md, v2.597 section, has the ledger.)
   *
   * EXECUTED, not read: the assertion is on the DELAY each abort timer is armed with, in order,
   * which is the only thing that decides when a stalled request is abandoned. */
  {
    const delays = [];
    const calls  = [];
    const ctx = {
      console, Math, JSON, Error, Promise, clearTimeout: () => {},
      setTimeout: (f, ms) => { delays.push(ms); f(); return 1; },
      AbortController: function () {
        this.signal = { aborted: false };
        this.abort = () => { this.signal.aborted = true; };
      },
      fetch: (url, opts) => {
        calls.push(url);
        return new Promise((_res, rej) => {
          const s = opts && opts.signal;
          if (s && s.aborted) return rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          const iv = setInterval(() => {
            if (s && s.aborted) { clearInterval(iv); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }
          }, 1);
        });
      },
    };
    vm.createContext(ctx);
    vm.runInContext(gasQueueStub() + '\n' + grab('gasFetchJson'), ctx);

    try { await ctx.gasFetchJson('https://example.test/exec', null, [10000, 14000, 20000]); } catch (e) {}
    // Abort timers are armed at attempt start; the backoff timer sits between two of them.
    const caps = delays.filter((_, i) => i % 2 === 0);
    eq(calls.length, 3, 'the list sets the attempt count — three ceilings, three attempts');
    eq(caps.join(','), '10000,14000,20000',
       'each attempt was abandoned at ITS OWN ceiling, escalating (got ' + caps.join(',') + ')');
    ok(delays.length === 5 && delays[1] >= 700 && delays[1] <= 1200 && delays[3] >= 1400 && delays[3] <= 1900,
       'the jittered backoff still sits between attempts (got ' + delays.join(',') + ')');

    // A number still means what it always meant — every existing call site depends on it.
    delays.length = 0; calls.length = 0;
    try { await ctx.gasFetchJson('https://example.test/exec', 2, 15000); } catch (e) {}
    eq(calls.length, 2, 'the plain number form is unchanged: attempts x one flat ceiling');
    eq(delays.filter((_, i) => i % 2 === 0).join(','), '15000,15000',
       'and every attempt gets that same ceiling');

    // A first attempt that answers must not pay for the later ceilings.
    delays.length = 0; calls.length = 0;
    ctx.fetch = () => { calls.push(1); return Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }); };
    const good = await ctx.gasFetchJson('https://example.test/exec', null, [10000, 14000, 20000]);
    eq(calls.length, 1, 'a healthy call still costs exactly one request');
    ok(good && good.ok === true, 'and its body comes back parsed');
  }

  // ── 2c. The per-store load uses it too — that is where the stall was seen ──
  {
    const load = stripComments(grab('loadAllStores'));
    ok(/gasFetchJson\(url, null, phase === 'live' \? LIVE_PHASE_CAPS_ : SETTLED_PHASE_CAPS_\)/.test(load),
       'each store fetch is bounded and retried — one hung store must not shimmer forever');
    /* THE BUDGET IS THE SUM OF THE ATTEMPTS NOW, NOT attempts x ceiling. Read from the shipped
     * constants rather than re-typed here: the whole point of a per-attempt list is that the count
     * and the ceilings move together, and a test carrying its own copy of either would go green on
     * a budget the app no longer has. The constraint is unchanged — the retry chain has to finish
     * inside one 60s poll, because _loadAllStoresInFlight blocks the poll that would recover the
     * store. Backoff is counted too: it is wall clock the reader waits through like any other. */
    const capsOf = name => {
      const m = new RegExp('const ' + name + '\\s*=\\s*\\[([^\\]]*)\\]').exec(SRC);
      return m ? m[1].split(',').map(x => Number(x.trim())).filter(n => n > 0) : null;
    };
    for (const name of ['LIVE_PHASE_CAPS_', 'SETTLED_PHASE_CAPS_']) {
      const caps = capsOf(name);
      ok(caps && caps.length >= 2, name + ' is a list of per-attempt ceilings (' + caps + ')');
      // 700 + 1400 + … of jittered backoff, plus up to 500ms of jitter each — the worst case.
      const backoff = caps.slice(1).reduce((a, _, i) => a + 700 * (i + 1) + 500, 0);
      const total   = caps.reduce((a, b) => a + b, 0) + backoff;
      ok(total < 60000,
         name + ': the whole retry chain fits inside the 60s poll (' + total + 'ms)');
      /* The FIRST attempt is the one that decides how long a stall costs, and the measurement it
       * is set from (2026-09-15) put a healthy call at 4.1s by p95. Below that it would start
       * cutting short calls that were going to answer; far above it and a stall is free to hold
       * the load, which is the bug this replaced. */
      ok(caps[0] >= 6000 && caps[0] <= 12000,
         name + ': the first attempt sits above a healthy call and well below a stall (' +
         caps[0] + 'ms)');
      ok(caps[caps.length - 1] > caps[0],
         name + ': later attempts are more patient than the first, not less');
    }
    ok(!/const res = await fetch\(url\);/.test(load),
       'the unbounded per-store fetch is gone');
    ok(/timed out after/.test(load),
       'a timed-out store is NOT re-tried by the outer retry as well — the wait stays bounded');
  }

  // ── 3. The two reported paths actually use it ──────────────────────────────
  ok(/gasFetchJson\(url, 3\)/.test(grab('doSalesLogin')),
     'sign-in goes through the retry — a bounced login must not read as a wrong password');
  ok(!/await fetch\(url\)/.test(grab('doSalesLogin')),
     'the bare login fetch is gone, not merely wrapped');

  const bugSubmit = /submit: function \(payload\) \{[\s\S]*?\n    \},/.exec(SRC);
  ok(bugSubmit && /gasFetchJson\(/.test(bugSubmit[0]),
     'the bug reporter submits through the retry — it is the one form you cannot file a bug about');
  ok(bugSubmit && !/fetch\(getProxyUrl\(\) \+ '\?' \+ params\)\.then/.test(bugSubmit[0]),
     'the bare bug-report fetch is gone');

  // ── 4. Prewarm is free or it is not worth having ───────────────────────────
  {
    const pw = grab('prewarmSalesProxy');
    ok(/action=libversion/.test(pw), 'prewarm knocks on a PUBLIC route — the login screen holds no token');
    ok(/\.catch\(/.test(pw) && /try \{/.test(pw),
       'prewarm can neither throw nor reject into the login path');
    ok(!/await/.test(pw), 'nothing waits on the prewarm');
    ok(/prewarmSalesProxy\(\);/.test(grab('showLoginScreen')),
       'the prewarm actually fires when the sign-in form appears');
    // A read the app performs must be declared, or it works live and breaks only on localhost.
    ok(/'libversion'/.test(SRC), 'libversion is declared in GX_DEV_READS');
  }

  finished = true;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  // exitCode, not process.exit(): exit() can cut off a buffered stdout write, and a suite that
// prints NOTHING while exiting 0 reads as a pass to gx-preflight.sh. A silent green is worse
// than a red one.
  process.exitCode = fail ? 1 : 0;
})();
