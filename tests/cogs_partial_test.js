#!/usr/bin/env node
/* THE GROSS PROFIT SWEEP ASKS GX CORE SIX TIMES IN A ROW, AND SIX LEGAL CALLS ARE NOT A LEGAL LOOP.
 *
 * GXCORE_RETRY_BUDGET_MS (shipped earlier the same day) bounds ONE call at 60s. getCogsDutchie makes
 * six of them in sequence, one per store, and six times sixty is not sixty — measured 2026-09-12,
 * 7.5% of round trips to GX Core bounce at an average of 46.6s, worst single round trip 628.8s.
 * Apps Script kills a script at 360s. So a bad spell could still take the whole request down with
 * nothing to show, and the only thing standing between the reader and that was luck: each store is
 * individually caught, so a dead one degraded into a SMALLER COGS rather than an error.
 *
 * A smaller COGS is the worst shape this particular bug can have. Less cost subtracted means Gross
 * Profit and Margin read HIGH, both stay perfectly plausible, and the answer was then frozen into a
 * cache for ten minutes — six hours on a settled window — under a freshness claim. This screen
 * gates a bank-deposit reconciliation. A flattering wrong number that persists past the blip that
 * caused it is worse than no number at all.
 *
 * So this EXECUTES the shipped getCogsDutchie out of dutchie_proxy.gs — with the REAL gxCoreRoute_
 * and the REAL retry budget underneath it, against a scripted clock and transport — and the shipped
 * frontend functions out of index.html. Nothing here restates the logic.
 *
 * WHAT FIXTURE MAKES EACH ASSERTION FAIL (asked of every one, per the hub's rule):
 *
 *   backend
 *   - "six 130s bounces stay inside the cap"  fails with no loop deadline: 6 x 130s = 780s, and the
 *                                             script is dead at 360s. Measured at the commit before
 *                                             this fix: 780s.
 *   - "a slow but WORKING sweep keeps all 6"  fails if the deadline is set at or under ~130s, which
 *                                             is six of the 21.6s worst healthy round trip measured
 *                                             2026-09-12. This is the other end of the number.
 *   - "the partial names who is missing"      fails on any payload that does not carry the list —
 *                                             the fixture leaves four stores unasked, and rows
 *                                             alone cannot distinguish that from a store that had
 *                                             no COGS.
 *   - "a partial is not cached"               fails on the shipped-before code, which cached every
 *                                             answer it built. Counted on the cache fake's puts.
 *   - "a partial does not satisfy a read"     fails if the read guard goes: the fixture SEEDS a
 *                                             partial into the cache under both the old and the
 *                                             new key, so a function that trusts it makes zero
 *                                             fetches and returns the seeded rows.
 *   - "the next load completes it"            fails if the partial is cached — call two is then
 *                                             served the bad afternoon back and never re-asks.
 *   - "a today-half failure counts missing"   fails if only the settled half is checked. COGS short
 *                                             one store-day still reads high.
 *   - "a complete answer caches as before"    fails if the !partial guard swallows the healthy path
 *                                             or the TTLs move.
 *   - "the arithmetic is untouched"           fails on any change to what the answered stores sum
 *                                             to — the rows are compared value for value.
 *
 *   frontend
 *   - "a short month view is marked"          fails on the shipped-before builders, which had no
 *                                             partial parameter at all.
 *   - "a filtered-out store does not mark"    fails if the missing list is not intersected with the
 *                                             stores in view — a permanently amber card is a card
 *                                             nobody reads.
 *   - "a day from allDailyData is not marked" fails if the flag is set before the branch that never
 *                                             touches invGmData. Marking a correct figure is also
 *                                             a lie.
 *   - "the mark names the store"              fails on a bare "partial" with no store in it.
 *   - "the unmarked sub is gone when short"   fails if the margin line is left beside the warning —
 *                                             the margin is the same short COGS and is wrong too.
 *   - "a complete card renders as before"     fails if the marker leaks into the healthy path.
 *   - "a partial is not written to the tab"   fails on the shipped-before loadInvGmData, which
 *                                             wrote every answer to a 2-hour localStorage entry.
 *   - "an old-key entry is not trusted"       fails if the cache key is not bumped: an entry from
 *                                             the previous version carries no `missing` field and
 *                                             an absent field reads as "nothing missing".
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const GS   = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grabFrom(src, file, name) {
  const re = new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in ' + file + ' — renamed or removed?');
  let i = src.indexOf('{', m.index + m[0].indexOf('(')), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(m.index, j + 1);
}
const gs   = n => grabFrom(GS,   'dutchie_proxy.gs', n);
const html = n => grabFrom(HTML, 'index.html',       n);

/* A section whose subject does not exist yet must REPORT, not die. Proving a gate against the bug
   means running it at the commit BEFORE the fix, where half these functions are absent — and a
   suite that throws on the first missing name prints one stack trace instead of the list of things
   that are wrong, which is exactly the output you need at that commit. */
function section(title, body) {
  console.log('\n' + title);
  try { body(); }
  catch (e) { fail++; console.log('  FAIL the section could not run at all\n       ' + String(e && e.message || e)); }
}

/* An async body that never settles ends this process quietly at exit 0 with nothing printed, which
   gx-preflight.sh cannot tell from a clean pass. Same guard phase_split_test.js carries. */
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}

/* ═══ PART A — the backend sweep ═══════════════════════════════════════════════════════════════ */

const TODAY = '2026-09-12';
const YDAY  = '2026-09-11';
const STORE_SALES = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];

/* The shipped numbers, read out of the file. Read as TEXT on purpose: if a constant is gone the
   behavior assertions below still run — with no deadline — and fail the way the unbounded loop
   actually failed. A grab() would throw instead, and a suite that dies is harder to read than one
   that reports. */
const mDeadline = /\n(?:const|var)\s+COGS_LOOP_DEADLINE_MS\s*=\s*(\d+)/.exec(GS);
const mBudget   = /\n(?:const|var)\s+GXCORE_RETRY_BUDGET_MS\s*=\s*(\d+)/.exec(GS);
const DEADLINE  = mDeadline ? Number(mDeadline[1]) : Infinity;
const BUDGET    = mBudget   ? Number(mBudget[1])   : Infinity;

console.log('1. the loop has a deadline of its own, and it is not the per-call budget');
ok('dutchie_proxy.gs declares COGS_LOOP_DEADLINE_MS', !!mDeadline,
   'absent — the loop is bounded only by Google killing the script');
/* The two ends the number has to sit between. Both measured 2026-09-11/12, neither invented here. */
ok('the deadline is above a slow-but-working six-store sweep (6 x the 21.6s worst healthy trip)',
   DEADLINE > 129600,
   'deadline=' + DEADLINE + 'ms — at or under 129600 it drops stores on a day nothing is broken');
ok('deadline + one whole store (60s budget + the 130s bounce top) stays inside the 360s cap',
   DEADLINE + BUDGET + 130000 <= 360000,
   'deadline=' + DEADLINE + 'ms budget=' + BUDGET + 'ms — the check runs BEFORE a store, never mid-store');
ok('it is NOT the per-call retry budget wearing a second name', DEADLINE !== BUDGET,
   'a loop deadline and a per-call budget are different questions measured against different things');

/* ── the scripted world ───────────────────────────────────────────────────────────────────────── */
let clock = 0;
let fetches = [];          // one entry per UrlFetchApp.fetch the REAL gxCoreRoute_ makes
let crScript = {};         // dutchie store name → [{ms, body}], last entry repeats forever
let salesDailyFail = {};   // dutchie store name → message to throw from GXCore.getSalesDaily
const cacheStore = new Map();
let puts = [];             // every cacheSet_ that actually reached the cache

const HTMLBOUNCE = '<!DOCTYPE html><html><body>Sorry, unable to open the file at this time.</body></html>';
const bounce = ms => ({ ms, body: HTMLBOUNCE });
const refuse = (ms, msg) => ({ ms, body: JSON.stringify({ ok: false, error: msg }) });
const answer = (ms, cost) => ({ ms, body: JSON.stringify({ ok: true, data: { cost } }) });

const RealDate = Date;
function FakeDate(a) { return arguments.length ? new RealDate(a) : new RealDate(TODAY + 'T12:00:00'); }
FakeDate.now = () => clock;
FakeDate.UTC = RealDate.UTC;

function storeFromUrl(url) {
  const m = /[?&]store=([^&]*)/.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

const gctx = {
  console,
  GXCORE_EXEC_: 'https://script.example.invalid/macros/s/FAKE/exec',
  Date: FakeDate,
  Logger: { log() {} },
  probeMark_() {},
  Utilities: {
    sleep(ms) { clock += ms; },
    // Every date this path formats is built at local noon, so a local format is the LA day.
    formatDate(d, tz, fmt) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
  },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: k => (k === 'GX_DEPLOY_SECRET' ? 'test-secret' : null) }),
  },
  UrlFetchApp: {
    fetch(url) {
      const store = storeFromUrl(url);
      const steps = crScript[store] || [bounce(130000)];
      const nForStore = fetches.filter(f => f.store === store).length;
      const step = steps[Math.min(nForStore, steps.length - 1)];
      fetches.push({ store, at: clock });
      clock += step.ms;
      return { getResponseCode: () => 200, getContentText: () => step.body };
    },
  },
  // The settled half is a LIBRARY call, in-process, with no /exec hop in it — that asymmetry is
  // the whole reason the two halves have different odds (see phase_split_test.js). Fast on purpose.
  GXCore: {
    getSalesDaily(store, from, to) {
      if (salesDailyFail[store]) throw new Error(salesDailyFail[store]);
      clock += 60;
      return [{ date: YDAY, cogs: 1000 }];
    },
  },
  // A cache that can EXPIRE, so the TTL is a real assertion rather than decoration.
  CACHE: {
    get(k) {
      const e = cacheStore.get(k);
      if (!e) return null;
      if (clock >= e.until) { cacheStore.delete(k); return null; }
      return e.v;
    },
    put(k, v, ttl) { puts.push({ k, ttl, v }); cacheStore.set(k, { v, until: clock + ttl }); },
    putAll(entries, ttl) { Object.keys(entries).forEach(k => gctx.CACHE.put(k, entries[k], ttl)); },
  },
};
vm.createContext(gctx);
vm.runInContext(
  (mDeadline ? mDeadline[0].trim() + '\n' : '') +
  (mBudget   ? mBudget[0].trim()   + '\n' : '') +
  [gs('gxDeploySecret_'), gs('gxRetryHold_'), gs('gxCoreRoute_'),
   gs('cacheGet_'), gs('cacheSet_'), gs('dayBefore_'), gs('getCogsDutchie')].join('\n'),
  gctx);

function sweep(opts) {
  opts = opts || {};
  if (!opts.keepClock) clock = 0;
  fetches = []; puts = [];
  crScript = opts.cr || {};
  salesDailyFail = opts.salesFail || {};
  if (opts.freshCache) cacheStore.clear();
  const t0 = clock;
  let out = null, threw = null;
  try { out = gctx.getCogsDutchie(opts.params || { from: '2026-08-16', to: '' }); }
  catch (e) { threw = e; }
  return { out, threw, elapsed: clock - t0, fetches: fetches.slice(), puts: puts.slice() };
}

const allStoresCr = step => ({ Bend: [step], Center: [step], Commercial: [step],
                               Hillsboro: [step], 'Portland Rd': [step], 'River Rd': [step] });

section('2. six bouncing stores return a partial instead of killing the script', () => {
  cacheStore.clear();
  const r = sweep({ cr: allStoresCr(bounce(130000)), freshCache: true });
  ok('the sweep stays inside the 360s execution cap', r.elapsed < 360000,
     'elapsed=' + Math.round(r.elapsed / 1000) + 's across ' + r.fetches.length + ' fetches');
  ok('...and returns rather than throwing', r.threw === null && !!r.out,
     r.threw ? String(r.threw.message) : 'returned nothing');
  ok('...marked partial', !!(r.out && r.out.partial === true),
     'partial=' + JSON.stringify(r.out && r.out.partial));
  const missing = (r.out && r.out.stores_missing) || [];
  ok('...naming every store that did not answer', missing.length > 0 && missing.length <= 6,
     'stores_missing=' + JSON.stringify(missing));
  /* `.length &&` FIRST on both. `[].every(...)` is true, so without it an answer carrying NO list
     at all — which is precisely the bug — satisfied two assertions written to catch it. */
  ok('...and the names are the ones the screen uses, not Dutchie\'s',
     missing.length > 0 && missing.every(n => STORE_SALES.indexOf(n) !== -1), JSON.stringify(missing));
  ok('...with a reason per missing store, so the log is not the only record',
     missing.length > 0 && missing.every(n => r.out.missing_reason && r.out.missing_reason[n]),
     JSON.stringify(r.out && r.out.missing_reason));
  ok('at least one store was never asked at all — the deadline stopped the loop, not just the calls',
     r.out && (r.out.stores_answered || []).length + missing.length === 6 &&
     new Set(r.fetches.map(f => f.store)).size < 6,
     'asked ' + new Set(r.fetches.map(f => f.store)).size + ' of 6');
  ok('NOTHING was written to the cache', r.puts.length === 0,
     'puts=' + JSON.stringify(r.puts.map(p => p.k + ' ttl=' + p.ttl)));
});

section('3. a slow but WORKING sweep still returns all six', () => {
  // 21.6s is the worst SINGLE healthy round trip measured on 2026-09-12 across 49 live samples
  // (3.4s average). Six of those back to back is the day the deadline must not clip.
  const r = sweep({ cr: allStoresCr(answer(21600, 500)), freshCache: true });
  ok('all six stores answered', r.out && r.out.stores_answered.length === 6,
     'answered=' + JSON.stringify(r.out && r.out.stores_answered));
  ok('...the answer is not marked partial', r.out && r.out.partial === false);
  ok('...and it took the ~130s it was always going to take', r.elapsed > 129000 && r.elapsed < 132000,
     'elapsed=' + Math.round(r.elapsed / 1000) + 's');
  ok('...and IS cached', r.puts.length === 1, 'puts=' + r.puts.length);
});

section('4. a store whose TODAY failed is missing too — short COGS reads HIGH', () => {
  const cr = allStoresCr(answer(1200, 500));
  cr['River Rd'] = [refuse(600, 'closing report unavailable')];   // a refusal is final: one fetch
  const r = sweep({ cr, freshCache: true });
  ok('the store is named missing even though its settled month arrived',
     r.out && r.out.stores_missing.indexOf('River') === 0 && r.out.stores_missing.length === 1,
     'stores_missing=' + JSON.stringify(r.out && r.out.stores_missing));
  ok('...the answer is marked partial', r.out && r.out.partial === true);
  ok('...its settled rows are still RETURNED, because they are real',
     r.out.data.some(x => x.store === 'River' && x.date === YDAY && x.cogs === 1000));
  ok('...but today\'s row is absent rather than zero — a fabricated 0 is the bug, not the fix',
     !r.out.data.some(x => x.store === 'River' && x.date === TODAY));
  ok('...and NOTHING was cached', r.puts.length === 0,
     'puts=' + JSON.stringify(r.puts.map(p => p.k + ' ttl=' + p.ttl)));
  ok('the refusal was not retried — the {ok:false} rule is untouched',
     r.fetches.filter(f => f.store === 'River Rd').length === 1,
     'fetches for River Rd = ' + r.fetches.filter(f => f.store === 'River Rd').length);
});

section('5. a settled-half failure is missing too', () => {
  const r = sweep({ cr: allStoresCr(answer(1200, 500)),
                    salesFail: { Center: 'sales_daily unreachable' }, freshCache: true });
  ok('the store is named', r.out && r.out.stores_missing.indexOf('Center') !== -1,
     JSON.stringify(r.out && r.out.stores_missing));
  ok('...the reason says which half broke', /settled days/.test((r.out.missing_reason || {}).Center || ''),
     JSON.stringify(r.out && r.out.missing_reason));
  ok('...and nothing was cached', r.puts.length === 0);
});

section('6. a partial never satisfies a later cache read', () => {
  cacheStore.clear();
  clock = 0;
  const params = { from: '2026-08-16', to: '' };
  const poison = JSON.stringify({ data: [{ date: YDAY, store: 'Bend', cogs: 999999 }], partial: true,
                                  stores_answered: ['Bend'], stores_missing: ['Center'] });
  // Seeded under BOTH the old key and the new one, so this assertion is equally meaningful run
  // against the commit before the fix — where the old key is the one that would be read.
  gctx.CACHE.put('cogsd_2026-08-16_now_v1', poison, 600);
  gctx.CACHE.put('cogsd_2026-08-16_now_v2', poison, 600);
  puts = [];
  const r = sweep({ cr: allStoresCr(answer(1200, 500)), params, keepClock: true });
  ok('the sweep re-asked GX Core instead of serving the poisoned entry', r.fetches.length > 0,
     'made ' + r.fetches.length + ' fetches');
  ok('...and the poisoned figure never reached the caller',
     !r.out.data.some(x => x.cogs === 999999),
     JSON.stringify(r.out.data.slice(0, 3)));
  ok('...the fresh answer is complete', r.out.partial === false && r.out.stores_answered.length === 6);
});

section('7. the next load COMPLETES a partial — the whole point of not caching it', () => {
  cacheStore.clear();
  clock = 0;
  // Load one: the first two stores burn 130s each, so the last four are never asked.
  const slow = allStoresCr(answer(1200, 500));
  slow.Bend   = [bounce(130000)];
  slow.Center = [bounce(130000)];
  const first = sweep({ cr: slow, keepClock: true });
  ok('load one is partial and short at least three stores',
     first.out.partial === true && first.out.stores_missing.length >= 3,
     'stores_missing=' + JSON.stringify(first.out.stores_missing));
  const askedFirst = new Set(first.fetches.map(f => f.store));

  // Load two, moments later, everything healthy. It must re-ask — including the ones never reached.
  const second = sweep({ cr: allStoresCr(answer(1200, 500)), keepClock: true });
  const askedSecond = new Set(second.fetches.map(f => f.store));
  ok('load two re-asks every store, including the ones load one never reached',
     askedSecond.size === 6, 'asked=' + JSON.stringify([...askedSecond]));
  ok('...specifically the ones that were missing', first.out.stores_missing.length > 0 &&
     [...askedSecond].length === 6 && askedFirst.size < 6);
  ok('...and now answers complete', second.out.partial === false &&
     second.out.stores_answered.length === 6);
  ok('...and only NOW writes the cache', second.puts.length === 1 && first.puts.length === 0,
     'first=' + first.puts.length + ' second=' + second.puts.length);
});

section('8. a complete answer caches exactly as it did before', () => {
  cacheStore.clear();
  const live = sweep({ cr: allStoresCr(answer(1200, 500)),
                       params: { from: '2026-08-16', to: '' }, freshCache: true });
  ok('a window that reaches today caches for 10 minutes',
     live.puts.length === 1 && live.puts[0].ttl === 600,
     JSON.stringify(live.puts.map(p => p.ttl)));
  cacheStore.clear();
  const past = sweep({ cr: allStoresCr(answer(1200, 500)),
                       params: { from: '2026-07-01', to: '2026-07-31' }, freshCache: true });
  ok('a fully settled window caches for 6 hours',
     past.puts.length === 1 && past.puts[0].ttl === 21600,
     JSON.stringify(past.puts.map(p => p.ttl)));
  ok('...and a settled window makes no live closing-report calls at all', past.fetches.length === 0);

  // And the SECOND call is served from it, so the caching still actually saves the sweep.
  const again = sweep({ cr: allStoresCr(answer(1200, 500)),
                        params: { from: '2026-07-01', to: '2026-07-31' }, keepClock: true });
  ok('a complete entry is served back on the next call', again.fetches.length === 0 &&
     JSON.stringify(again.out.data) === JSON.stringify(past.out.data));
});

section('9. the arithmetic for the stores that DID answer is untouched', () => {
  const r = sweep({ cr: allStoresCr(answer(1200, 137.456)), freshCache: true });
  const bendYday = r.out.data.filter(x => x.store === 'Bend' && x.date === YDAY);
  const bendTday = r.out.data.filter(x => x.store === 'Bend' && x.date === TODAY);
  ok('one settled row per store per day, carried through as-is',
     bendYday.length === 1 && bendYday[0].cogs === 1000);
  ok('today\'s cost is still rounded to the cent, the same way',
     bendTday.length === 1 && bendTday[0].cogs === 137.46,
     'got ' + JSON.stringify(bendTday));
  ok('twelve rows for six stores over one settled day plus today',
     r.out.data.length === 12, 'got ' + r.out.data.length);
  // The partial fixture must not change what the answered stores sum to.
  const cr = allStoresCr(answer(1200, 137.456));
  cr['River Rd'] = [refuse(600, 'down')];
  const p = sweep({ cr, freshCache: true });
  const sumOf = (rows, store) => rows.filter(x => x.store === store).reduce((a, x) => a + x.cogs, 0);
  ok('Bend sums identically whether or not River answered',
     sumOf(r.out.data, 'Bend') === sumOf(p.out.data, 'Bend'),
     sumOf(r.out.data, 'Bend') + ' vs ' + sumOf(p.out.data, 'Bend'));
});

/* ═══ PART B — what the screen does with it ════════════════════════════════════════════════════ */

section('10. computeInvCost says whether the number it just returned is short', () => {
  const fctx = {
    console,
    invGmData: null, _cogsMissing: [], _invCostPartial: false,
    activeDay: null, activeWeek: null, activeMonth: 9, activeYear: 2026,
    allDailyData: {},
    getDaysOfISOWeek: () => [], toDateStr: d => d,
  };
  vm.createContext(fctx);
  vm.runInContext(html('computeInvCost'), fctx);

  fctx.invGmData = { byDay: { [TODAY]: { Bend: 10, River: 20 } },
                     byMonth: { '2026-09': { Bend: 100, River: 200 } }, cogs: {} };

  fctx._cogsMissing = [];
  const whole = fctx.computeInvCost(['Bend', 'River']);
  ok('a complete month is not marked', fctx._invCostPartial === false);

  fctx._cogsMissing = ['River'];
  const short = fctx.computeInvCost(['Bend', 'River']);
  ok('a month view missing a store in view IS marked', fctx._invCostPartial === true);
  ok('...and the figure itself is unchanged — the arithmetic is not in scope', short === whole,
     short + ' vs ' + whole);

  fctx._cogsMissing = ['River'];
  fctx.computeInvCost(['Bend']);
  ok('a missing store the reader has filtered OUT does not mark the card',
     fctx._invCostPartial === false);

  // A day served straight out of the per-store sales fetch never touched invGmData.
  fctx.activeDay = TODAY;
  fctx.allDailyData = { Bend: { [TODAY]: { cogs: 55 } } };
  fctx._cogsMissing = ['River'];
  const fromDaily = fctx.computeInvCost(['Bend', 'River']);
  ok('a day served from the per-store fetch is NOT marked', fctx._invCostPartial === false,
     'cost=' + fromDaily);
  ok('...because it genuinely came from the other source', fromDaily === 55);

  // ...but a day that falls back to invGmData is.
  fctx.allDailyData = {};
  fctx.computeInvCost(['Bend', 'River']);
  ok('a day that falls back to invGmData IS marked', fctx._invCostPartial === true);

  // No data at all is the existing "—" path and must not claim to be a marked partial.
  fctx.invGmData = null;
  fctx._cogsMissing = ['River'];
  ok('no COGS data at all returns 0 and is not marked', fctx.computeInvCost(['Bend']) === 0 &&
     fctx._invCostPartial === false);
});

section('11. the Gross profit card says it is partial, and names the store', () => {
  const kctx = {
    console,
    invGmData: { byDay: {}, byMonth: {}, cogs: {} },
    compareTotals: null,
    _cogsMissing: ['River'],
    THRESHOLDS: Object.freeze({ DISCOUNT_FLAG_PCT: 0.2 }),
    _KPI_SKEL: '<span class="val-skel"></span>',
    // Compare mode OFF: it is a whole second feature with its own suite, and leaving it on here
    // would mean every sub-line assertion below was really testing compareSub's delta branch.
    compareMode: 'none', compareLoading: false,
  };
  vm.createContext(kctx);
  vm.runInContext([html('_kpiSkelHtml'), html('fmtK'), html('fmtAov'), html('pct'),
                   html('compareOn'), html('compareLabel'), html('compareDelta'),
                   html('compareSub'), html('_cogsShortSub'),
                   html('_incomeKpiMobHtml'), html('_incomeKpiDskHtml')].join('\n'), kctx);

  const ARGS = [400000, 500000, 3000, 20000, 250000, 42.5, 400000, 250000];
  const mobShort = kctx._incomeKpiMobHtml(...ARGS, false, true);
  const dskShort = kctx._incomeKpiDskHtml(...ARGS, false, true);
  const mobWhole = kctx._incomeKpiMobHtml(...ARGS, false, false);
  const dskWhole = kctx._incomeKpiDskHtml(...ARGS, false, false);

  [['mobile', mobShort], ['desktop', dskShort]].forEach(([which, out]) => {
    ok(which + ': the Gross profit card carries the partial marker',
       /id="ic-(mob|dsk)-kpi-gp"/.test(out) && /ic-kpi-partial[^"]*"[^>]*id="ic-(mob|dsk)-kpi-gp"/.test(out.replace(/\n/g, '')),
       out.slice(0, 240));
    ok(which + ': ...it says COGS is pending, in the same vocabulary as "today pending"',
       /COGS pending:/.test(out), out.slice(0, 240));
    ok(which + ': ...and names the store', /COGS pending:[^<]*River/.test(out), out.slice(0, 240));
    ok(which + ': ...and says which way the number is wrong',
       /reads high/i.test(out), out.slice(0, 240));
  });

  ok('desktop: the Margin card is marked too — it divides the SAME short COGS',
     (dskShort.match(/ic-kpi-partial/g) || []).length === 2 &&
     /id="ic-dsk-kpi-margin"/.test(dskShort),
     'markers=' + (dskShort.match(/ic-kpi-partial/g) || []).length);
  ok('desktop: the unmarked "COGS $…" sub-line is GONE while short',
     !/COGS \$/.test(dskShort) || /COGS pending/.test(dskShort));
  ok('mobile: the margin sub-line is replaced, not printed beside the warning',
     !/% margin/.test(mobShort), mobShort.slice(0, 240));

  ok('a complete answer renders with no marker at all',
     !/ic-kpi-partial/.test(mobWhole) && !/ic-kpi-partial/.test(dskWhole) &&
     !/COGS pending/.test(mobWhole) && !/COGS pending/.test(dskWhole));
  ok('...and still shows the margin and the COGS figure it always did',
     /% margin/.test(mobWhole) && /COGS \$/.test(dskWhole));
  ok('the value itself is still shown while partial — marked, not hidden',
     /ic-kpi-val">\$150/.test(mobShort.replace(/\s+/g, '')) || /\$1?\d/.test(mobShort));

  // The flag alone must not mark a card that has no figure to be wrong about.
  const noData = kctx._incomeKpiDskHtml(400000, 500000, 3000, 20000, 0, 42.5, 400000, 0, false, true);
  ok('a card with no COGS at all shows "—" and is not marked partial',
     !/ic-kpi-partial/.test(noData), noData.slice(0, 200));

  ok('the marker never appears while the whole section is still shimmering',
     !/ic-kpi-partial/.test(kctx._incomeKpiDskHtml(...ARGS, true, true)));
});

console.log('\n12. the tab never stores a partial, and never trusts an old entry as whole');
(async () => {
 try {
  const cacheFake = new Map();
  let reads = [], writes = [];
  let payload = null, fetched = 0;

  const lctx = {
    console,
    invGmData: null, _cogsMissing: [], _invGmLoading: false,
    laDay: () => TODAY,
    laDaysAgo: () => '2026-08-15',
    getProxyUrl: () => 'https://proxy.example.invalid/exec',
    getToken: () => 'tok',
    // readCache/writeCache are faked because WHETHER THEY ARE CALLED is the subject — a real
    // localStorage would hide the one fact this section exists to assert. The fake is keyed, so
    // the cache-key bump is a real assertion and not decoration.
    readCache: k => { reads.push(k); return cacheFake.has(k) ? cacheFake.get(k) : null; },
    writeCache: (k, v) => { writes.push({ k, v }); cacheFake.set(k, v); },
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    setTimeout: () => 0, clearTimeout: () => {},
    fetch: async () => { fetched++; return { json: async () => payload }; },
  };
  vm.createContext(lctx);
  vm.runInContext(html('loadInvGmData'), lctx);

  const ROWS = [{ date: YDAY, store: 'Bend', cogs: 10 }, { date: YDAY, store: 'River', cogs: 20 }];

  // (a) a partial answer
  cacheFake.clear(); reads = []; writes = []; fetched = 0;
  payload = { data: ROWS, partial: true, stores_answered: ['Bend'], stores_missing: ['River'] };
  await lctx.loadInvGmData();
  ok('a partial answer is NOT written to the tab\'s 2-hour cache', writes.length === 0,
     'wrote ' + JSON.stringify(writes.map(w => w.k)));
  ok('...but IS shown — the reader asked and some stores answered',
     !!lctx.invGmData && lctx.invGmData.byDay[YDAY].Bend === 10);
  ok('...and the missing store is recorded for the card to name',
     JSON.stringify(lctx._cogsMissing) === '["River"]',
     JSON.stringify(lctx._cogsMissing));

  // (b) the next load re-asks, because nothing was cached
  const beforeSecond = fetched;
  payload = { data: ROWS, partial: false, stores_answered: ['Bend', 'River'], stores_missing: [] };
  lctx._invGmLoading = false;
  await lctx.loadInvGmData();
  ok('the next load re-asks rather than serving the partial back', fetched === beforeSecond + 1);
  ok('...a complete answer IS cached', writes.length === 1, JSON.stringify(writes.map(w => w.k)));
  ok('...and the missing list is cleared', lctx._cogsMissing.length === 0);

  // (c) an entry written by the PREVIOUS version, which carries no `missing` field
  cacheFake.clear(); reads = []; writes = []; fetched = 0;
  cacheFake.set('inv_gm2_2026-08-15', { cogs: {}, byDay: { [YDAY]: { Bend: 999999 } }, byMonth: {} });
  payload = { data: ROWS, partial: false, stores_answered: ['Bend', 'River'], stores_missing: [] };
  lctx._invGmLoading = false;
  lctx.invGmData = null; lctx._cogsMissing = [];
  await lctx.loadInvGmData();
  ok('an entry under the OLD key is not read as a complete answer', fetched === 1,
     'reads=' + JSON.stringify(reads));
  ok('...and its figure never reaches the screen',
     lctx.invGmData.byDay[YDAY].Bend === 10, JSON.stringify(lctx.invGmData.byDay));

  // (d) a cached COMPLETE entry under the new key still short-circuits, and restores the (empty)
  //     missing list rather than leaving whatever the last load put there.
  fetched = 0; lctx._invGmLoading = false; lctx._cogsMissing = ['River'];
  await lctx.loadInvGmData();
  ok('a cached complete entry still saves the round trip', fetched === 0);
  ok('...and resets the missing list rather than inheriting a stale one',
     lctx._cogsMissing.length === 0, JSON.stringify(lctx._cogsMissing));
 } catch (e) {
  fail++; console.log('  FAIL the section could not run at all\n       ' + String(e && e.message || e));
 }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finished = true;
  process.exit(fail ? 1 : 0);
})();
