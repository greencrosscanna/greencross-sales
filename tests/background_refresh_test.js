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
  vm.runInContext(grab('gasFetchJson'), ctx);
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
    vm.runInContext(grab('gasFetchJson'), ctx);
    let msg = null;
    try { await ctx.gasFetchJson('https://example.test/exec', 2, 1000); }
    catch (e) { msg = e.message; }
    ok(msg !== null && /timed out/.test(msg || ''),
       'a hung request ends in a timeout, not an unresolved promise (got ' + msg + ')');
    eq(calls.length, 2, 'the hung request was abandoned and retried, not waited on');
  }

  // ── 2c. The per-store load uses it too — that is where the stall was seen ──
  {
    const load = stripComments(grab('loadAllStores'));
    ok(/gasFetchJson\(url, 2, 15000\)/.test(load),
       'each store fetch is bounded and retried — one hung store must not shimmer forever');
    // The budget has to stay inside one poll interval, or the in-flight guard blocks the very
    // retry that would have recovered the store.
    const m = /gasFetchJson\(url, (\d+), (\d+)\)/.exec(load);
    ok(m && Number(m[1]) * Number(m[2]) < 60000,
       'the whole per-store retry budget fits inside the 60s poll (' +
       (m ? m[1] + ' x ' + m[2] + 'ms' : 'not found') + ')');
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
