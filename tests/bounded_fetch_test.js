#!/usr/bin/env node
/* NINETEEN CALL SITES ASKED THIS APP'S /exec A QUESTION WITH NO DEADLINE ON THE ANSWER.
 *
 * A browser `fetch` has no timeout. The v2.592/v2.597 work gave the twelve STORE halves a measured
 * retry ladder and gave nothing to anything else — so expenses, budgets, other revenue, P&L,
 * inventory, reconcile's writes, the smart-budget planner and the ten-minute session heartbeat were
 * all bare. Against a hop measured stalling 3.4% of the time six-wide (CLAUDE.md, v2.597), a bare
 * fetch does not fail: it never comes back. The `catch` never runs, the card never renders, and the
 * spinner spins until the tab is closed. The River shape again — a failure that reads as progress.
 *
 * WHAT THIS FILE PINS, and it is three different things:
 *
 *   1. THE INVARIANT. Every `fetch(` in index.html passes an AbortSignal. Stated as a property of
 *      the source rather than a list of blessed line numbers, because a list is a thing a new call
 *      site is simply not added to. A twentieth bare fetch fails this file on the line it is on.
 *
 *   2. THE NO-RETRY RULE FOR WRITES, EXECUTED. An abandoned request runs to completion on Apps
 *      Script anyway — that is WHY attempt two of a store half is a cheap cache read. The same fact
 *      makes a retried WRITE a second write: the client cannot tell a timeout from a success. So
 *      WRITE_CAPS_ is one element long, and §3 proves by execution that one element means exactly
 *      one request reaches the wire. A comment saying "do not retry" is not a guarantee; a count is.
 *
 *   3. THE DOUBLE-LANE HAZARD. gasFetchJson takes a pool lane per ATTEMPT. Two call sites used to
 *      wrap a bare fetch in gasGate_, which takes a lane too — converting those in place would have
 *      held one lane while queueing for a second, and with eight lanes the holders are the waiters.
 *      §4 fails if a gasFetchJson ever reappears inside a gasGate_.
 *
 * §1 and §4 read the source; §2 and §3 EXECUTE the shipped gasFetchJson. Point it at another
 * revision to prove it discriminates:
 *   git show HEAD:index.html > /tmp/h.html && GX_INDEX_HTML=/tmp/h.html node tests/bounded_fetch_test.js
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
/* A suite that exits before its summary reports 0 failed and reads as a pass — this repo has been
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

/* Comments AND string bodies are BLANKED, not deleted, so a reported line number is the line number
 * in index.html. Deleting them reported ~350 short in a 10,000-line file (secret_scrub_test, same
 * lesson).
 *
 * STRINGS HAVE TO GO TOO, and finding that out is why this is not a grep. The first version of this
 * file reported an unbounded fetch at index.html:1936, which is
 * `console.warn('[lb-goals] served by DIRECT Leaderboard fetch (GX Core path unavailable)')` — the
 * word "fetch", a space and a bracket, inside a log message. A checker that cannot tell code from
 * prose reports the wrong line and, worse, would accept a real bare fetch hidden the same way.
 * Blanking keeps every quote character and every newline, so offsets and paren balance still hold. */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}
const CODE = codeOnly(HTML);

/* Is the match at `idx` inside a string literal? Counted along ITS OWN LINE rather than by lexing
 * the document, and that is a deliberate retreat from something cleverer that did not work: a
 * whole-file quote-pairing pass blanked enormous regions, because one apostrophe in ordinary HTML
 * prose pairs with a quote thousands of lines away. It took the fetch count from 4 to 1 and the
 * gasGate_ count to 0 — both checks passing themselves into uselessness. Line-local is not a
 * JavaScript lexer and does not pretend to be; it answers the one question asked of it, on the one
 * line that can answer it, and it is wrong only for a string that both spans lines AND contains the
 * word fetch followed by a bracket. */
function insideString(idx) {
  const lineStart = CODE.lastIndexOf('\n', idx) + 1;
  const before = CODE.slice(lineStart, idx);
  for (const q of ["'", '"', '`']) {
    let n = 0;
    for (let i = 0; i < before.length; i++) {
      if (before[i] === '\\') { i++; continue; }
      if (before[i] === q) n++;
    }
    if (n % 2 === 1) return true;
  }
  return false;
}

/* ══ 1. EVERY fetch IS BOUNDED ════════════════════════════════════════════════════════════════
 *
 * The call and its options can straddle a line break, so each site is read as the balanced
 * argument list starting at its `fetch(` — not as the one line it begins on. A `signal:` anywhere
 * in those arguments is the bound. */
function fetchSites() {
  const sites = [];
  const re = /(^|[^.\w$])fetch\s*\(/g;
  let m;
  while ((m = re.exec(CODE))) {
    const at = m.index + m[0].indexOf('fetch');
    if (insideString(at)) continue;          // a log message that says "fetch (" is not a call
    const open = CODE.indexOf('(', at);
    let depth = 0, j = open;
    for (; j < CODE.length; j++) {
      if (CODE[j] === '(') depth++;
      else if (CODE[j] === ')') { depth--; if (!depth) break; }
    }
    const args = CODE.slice(open, j + 1);
    sites.push({ line: CODE.slice(0, m.index).split('\n').length, args });
  }
  return sites;
}

const SECTION_1 = () => section('1. EVERY fetch IN index.html PASSES AN AbortSignal', () => {
  const sites = fetchSites();
  ok('there are fetch call sites to check at all — a regex that matches nothing passes vacuously',
     sites.length >= 3, 'found ' + sites.length);

  const bare = sites.filter(s => !/signal\s*:/.test(s.args));
  ok('no bare fetch — every call site carries a signal',
     bare.length === 0,
     bare.length
       ? 'unbounded fetch at index.html:' + bare.map(s => s.line).join(', index.html:') +
         '\n       Route it through gasFetchJson (AUX_READ_CAPS_ to read, WRITE_CAPS_ to write),' +
         '\n       or give it its own AbortController if it must stay outside the pool.'
       : '');

  /* The three that legitimately hold a raw fetch, named so the count is a decision rather than
     whatever the file happens to contain: gasFetchJson itself, the cogs_dutchie call that arms its
     own ceiling inside a lane, and the login prewarm that is deliberately outside the pool. */
  ok('exactly three raw fetch sites, the ones this file knows about',
     sites.length === 3, 'found ' + sites.length + ' at lines ' + sites.map(s => s.line).join(', ') +
     ' — a new one is not necessarily wrong, but it is a decision, so say so here.');
});

/* ══ 2. THE CEILINGS ARE DECLARED, AND WRITE IS ONE ATTEMPT ═══════════════════════════════════ */
function capsCtx() {
  const a = HTML.indexOf('const LIVE_PHASE_CAPS_');
  const b = HTML.indexOf('const WRITE_CAPS_');
  if (a < 0 || b < 0) throw new Error('the cap constants are not in ' + path.basename(SRC_PATH));
  const end = HTML.indexOf('\n', b);
  const ctx = { Object, Array };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, end), ctx);
  return ctx;
}

const SECTION_2 = () => section('2. THE CAP CONSTANTS SAY WHAT THEY MEAN', () => {
  const ctx = capsCtx();
  const read  = vm.runInContext('AUX_READ_CAPS_', ctx);
  const write = vm.runInContext('WRITE_CAPS_', ctx);
  const live  = vm.runInContext('LIVE_PHASE_CAPS_', ctx);

  ok('AUX_READ_CAPS_ is a ladder, so a stalled read is re-asked',
     Array.isArray(read) && read.length === 2, JSON.stringify(read));
  ok('...and it is the measured live ladder, not a number somebody picked',
     JSON.stringify(read) === JSON.stringify(live),
     JSON.stringify(read) + ' vs LIVE_PHASE_CAPS_ ' + JSON.stringify(live));

  /* THE ONE THAT MATTERS. Hardcoded, not derived from the source, so DELETING the rule fails here
     loudly instead of quietly agreeing with whatever the file now says. */
  ok('WRITE_CAPS_ is exactly ONE attempt — a write is never re-sent',
     Array.isArray(write) && write.length === 1,
     JSON.stringify(write) + ' — an abandoned request still runs to completion on Apps Script, so a' +
     ' second attempt is a second write.');
  ok('...and its one ceiling outlasts the 25s wait the server may already be honoring',
     write[0] >= 25000, String(write[0]));
});

/* ══ 3. ONE ELEMENT MEANS ONE REQUEST — EXECUTED ══════════════════════════════════════════════
 *
 * §2 asserts the shape of a constant. This asserts what the shipped function DOES with it, which
 * is the actual guarantee: a write that times out reaches the wire once. */
function bootFetcher(fetchImpl) {
  const a = HTML.indexOf('const GAS_MAX_INFLIGHT');
  const b = HTML.indexOf('async function gasFetchJson');
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    Promise, Number, Math, JSON, Error, Array, Object, String,
    setTimeout, clearTimeout,
    fetch: fetchImpl,
    AbortController: function () {
      this.signal = { aborted: false };
      this.abort = () => { this.signal.aborted = true; if (this.signal.onabort) this.signal.onabort(); };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(a, b) + '\n' + grab('gasFetchJson'), ctx);
  return ctx;
}

const SECTION_3 = () => asection('3. A WRITE THAT TIMES OUT IS SENT ONCE, A READ IS RE-ASKED', async () => {
  // A fetch that never settles unless aborted — the stall this whole change exists for.
  let calls = 0;
  const stalling = (url, opts) => {
    calls++;
    return new Promise((_res, rej) => {
      const sig = opts && opts.signal;
      if (sig) sig.onabort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
    });
  };

  {
    const ctx = bootFetcher(stalling);
    calls = 0;
    let msg = '';
    try { await vm.runInContext('gasFetchJson("u", null, [40])', ctx); }
    catch (e) { msg = e.message; }
    ok('a stalled WRITE reaches the wire exactly once', calls === 1, 'sent ' + calls + ' times');
    ok('...and it reports the timeout rather than resolving', /timed out/.test(msg), msg);
  }

  {
    const ctx = bootFetcher(stalling);
    calls = 0;
    try { await vm.runInContext('gasFetchJson("u", null, [40, 40])', ctx); } catch (e) {}
    ok('a two-element ladder DOES re-ask — so the single element above is the cause, not the harness',
       calls === 2, 'sent ' + calls + ' times');
  }

  {
    // And a healthy write still returns its parsed body.
    const good = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"saved":1}') });
    const ctx = bootFetcher(good);
    const out = await vm.runInContext('gasFetchJson("u", null, [25000])', ctx);
    ok('a write that answers returns the parsed body, unchanged', out && out.ok === true && out.saved === 1,
       JSON.stringify(out));
  }
});

/* ══ 4. NO gasFetchJson INSIDE A gasGate_ ═════════════════════════════════════════════════════ */
const SECTION_4 = () => section('4. NOTHING HOLDS A LANE WHILE QUEUEING FOR ONE', () => {
  const gates = [];
  const re = /gasGate_\s*\(/g;
  let m;
  while ((m = re.exec(CODE))) {
    if (insideString(m.index)) continue;
    let depth = 0, j = CODE.indexOf('(', m.index);
    const start = j;
    for (; j < CODE.length; j++) {
      if (CODE[j] === '(') depth++;
      else if (CODE[j] === ')') { depth--; if (!depth) break; }
    }
    gates.push({ line: CODE.slice(0, m.index).split('\n').length, body: CODE.slice(start, j + 1) });
  }
  ok('gasGate_ is still used somewhere — otherwise this check is vacuous', gates.length >= 1,
     'found ' + gates.length);

  const nested = gates.filter(g => /gasFetchJson\s*\(/.test(g.body));
  ok('no gasGate_ wraps a gasFetchJson',
     nested.length === 0,
     nested.length
       ? 'at index.html:' + nested.map(g => g.line).join(', index.html:') +
         '\n       gasFetchJson takes a lane per attempt; wrapping it holds one while waiting for' +
         '\n       another. Pass the priority to gasFetchJson instead of gating around it.'
       : '');
});

/* AWAITED IN ORDER, and the summary only after all four. The first version fired section 3 without
 * awaiting it, so the totals printed BEFORE its four assertions ran and the line read "7 passed, 2
 * failed" above four more PASSes. A suite whose summary does not describe its own output is worse
 * than one that fails. */
(async () => {
  SECTION_1();
  SECTION_2();
  await SECTION_3();
  SECTION_4();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finished = true;
  process.exitCode = fail ? 1 : 0;
})();
