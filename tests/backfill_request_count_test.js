#!/usr/bin/env node
/* THE DAY-OF-WEEK CHART'S COST IS ROUND TRIPS, NOT DATA — AND IT WAS PAYING 48 OF THEM.
 *
 * Sky, 2026-09-12, from an iPhone on the Income tab: "the all saturdays data is taking a long time
 * to load. I thought we were caching this and would expect it to load very quickly."
 *
 * Measured on the live deployment that morning, proxy cache warm and zero failures: the backfill
 * that feeds that chart fired 48 requests — 8 prior months x 6 stores — through a pool of 4, at
 * 2.1s min / 3.0s median / 8.6s max apiece, for 44.6 SECONDS of wall clock before the chart was
 * complete. In the same window `?action=loadprobe` reported 31-55ms of SERVER work per store for
 * the whole Jan-Aug range, and a sequential whole-year request measured 2.3-3.2s against 2.5-3.4s
 * for a single month. Asking for 243 days costs what asking for 31 does; asking 48 times does not.
 *
 * So this suite asserts on the NUMBER OF REQUESTS the shipped function makes, because that is the
 * quantity the bug was made of. It executes backfillDailyHistory itself rather than reading the
 * source for a pattern: every wrong way to do this still produces a chart full of plausible bars.
 *
 *   - one request per month is the bug, and it renders identically to the fix, only later.
 *   - widening the span past the months actually missing re-reads days already in hand.
 *   - narrowing it to the FIRST missing month drops the rest of the year silently — the chart just
 *     has fewer bars, which looks like a store that opened late.
 *   - letting a localStorage hit still fire its request makes the cache decorative: the numbers are
 *     right, the wait is unchanged, and that is exactly what Sky was reporting.
 *   - raising BACKFILL_POOL "fixes" the wall clock by taking the throughput back off the 60-second
 *     poll — the 2026-09-06 failure this pool exists to prevent.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not locate ' + name + ' in index.html — renamed or removed?');
  let i = HTML.indexOf('{', m.index + m[0].indexOf('(')), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

/* An async suite that never settles exits 0 with nothing printed, which gx-preflight.sh cannot tell
 * from a clean pass. Same guard the other executing suites carry. */
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else      { fail++; console.log('  FAIL ' + label); }
}
function eq(label, got, want) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  PASS ' + label); }
  else      { fail++; console.log('  FAIL ' + label + '  — got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
}

const STORES = [
  { name: 'Bend' }, { name: 'Center' }, { name: 'Commercial' },
  { name: 'Hillsboro' }, { name: 'Portland Rd' }, { name: 'River' },
];
const PROXY = 'https://example.test/exec';

// Sept 12 2026 at midday PT — the day of the report. maxMo = 8, so Jan..Aug are in scope.
const NOW = new Date(2026, 8, 12, 12, 0, 0);

function daysOf(year, month) {
  const last = new Date(year, month, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    out.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      netSales: 1000 + d, grossSales: 1200 + d, orders: 40, discounts: 5, cogs: 500, tax: 90,
    });
  }
  return out;
}

/** Run the SHIPPED backfill against fakes, returning what it asked the network for. */
function run({ cachedMonths = {}, activeYear = 2026, stores = STORES, seeded = {}, fetchFails = new Set() } = {}) {
  const requests = [];       // every URL handed to gasFetchJson
  const cacheReads = [];     // every (store, year, month) asked of localStorage
  const cacheWrites = [];
  const allDailyData = JSON.parse(JSON.stringify(seeded));
  let renders = 0, statusGrids = 0;
  let inflight = 0, peakInflight = 0;

  const ctx = {
    STORES: stores,
    activeYear,
    allDailyData,
    Date: class extends Date {
      constructor(...a) { if (!a.length) super(NOW.getTime()); else super(...a); }
      static now() { return NOW.getTime(); }
    },
    console,
    encodeURIComponent,
    Object, Array, String, Number, JSON, Math, Promise, setTimeout,

    getToken: () => 'tok',
    serverBypassParam: () => '',
    readSalesCache: (store, year, month) => {
      cacheReads.push(`${store}|${year}|${month}`);
      const d = (cachedMonths[store] || {})[month];
      return d ? { daily: d, netSales: 1, phase: 'both' } : null;
    },
    writeSalesCache: (store, year, month) => { cacheWrites.push(`${store}|${year}|${month}`); },
    mergeDailyData: (storeName, arr) => {
      if (!allDailyData[storeName]) allDailyData[storeName] = {};
      for (const d of (arr || [])) allDailyData[storeName][d.date] = d;
    },
    monthRange: (m, year) => {
      const p = n => String(n).padStart(2, '0');
      const last = new Date(year, m, 0).getDate();
      return { from: `${year}-${p(m)}-01`, to: `${year}-${p(m)}-${p(last)}` };
    },
    gasFetchJson: async (url, attempts, timeoutMs) => {
      requests.push({ url, attempts, timeoutMs });
      inflight++; peakInflight = Math.max(peakInflight, inflight);
      await new Promise(r => setTimeout(r, 5));
      inflight--;
      const store = decodeURIComponent(/[?&]store=([^&]*)/.exec(url)[1]);
      if (fetchFails.has(store)) throw new Error('timed out after 15000ms');
      const from = /[?&]from=([^&]*)/.exec(url)[1];
      const to   = /[?&]to=([^&]*)/.exec(url)[1];
      const lo = Number(from.slice(5, 7)), hi = Number(to.slice(5, 7));
      let daily = [];
      for (let m = lo; m <= hi; m++) daily = daily.concat(daysOf(Number(from.slice(0, 4)), m));
      return { daily, phase: 'both' };
    },
    render: () => { renders++; },
    buildStatusGrid: () => { statusGrids++; },
    _storeStateMap: {},
  };
  ctx.decodeURIComponent = decodeURIComponent;
  vm.createContext(ctx);
  vm.runInContext(grab('backfillDailyHistory'), ctx);
  return ctx.backfillDailyHistory(PROXY).then(() => ({
    requests, cacheReads, cacheWrites, allDailyData, renders, statusGrids, peakInflight,
  }));
}

const spanOf = r => {
  const from = /[?&]from=([^&]*)/.exec(r.url)[1], to = /[?&]to=([^&]*)/.exec(r.url)[1];
  return from + '..' + to;
};
const storeOf = r => decodeURIComponent(/[?&]store=([^&]*)/.exec(r.url)[1]);

(async () => {

/* ── 1. a cold load is one request per store, not one per month ───────────────────────────────── */
console.log('\n1. cold load: six stores, eight missing months each');
{
  const r = await run();
  eq('one request per store, not one per month', r.requests.length, 6);
  eq('each store asked exactly once',
     [...new Set(r.requests.map(storeOf))].sort(), ['Bend','Center','Commercial','Hillsboro','Portland Rd','River']);
  eq('the span is Jan 1 through the end of August', [...new Set(r.requests.map(spanOf))], ['2026-01-01..2026-08-31']);
  ok('never more than BACKFILL_POOL requests in flight at once', r.peakInflight <= 4);
  eq('every prior day of the year landed for every store',
     [...new Set(STORES.map(s => Object.keys(r.allDailyData[s.name] || {}).length))], [243]);
  ok('the chart is redrawn once the data is in', r.renders === 1 && r.statusGrids === 1);
}

/* ── 2. the request count is what changed, stated as the bug ──────────────────────────────────── */
console.log('\n2. the old shape — one request per (store, month) — would be 48');
{
  const r = await run();
  ok('48 round trips became 6', r.requests.length === 6);
  ok('a per-month shape would have asked 48 times', 6 * 8 === 48 && r.requests.length < 48);
}

/* ── 3. localStorage is load-bearing, not decorative ──────────────────────────────────────────── */
console.log('\n3. a month already in localStorage costs no request and still reaches the chart');
{
  const cachedMonths = {};
  for (const s of STORES) { cachedMonths[s.name] = {}; for (let m = 1; m <= 8; m++) cachedMonths[s.name][m] = daysOf(2026, m); }
  const r = await run({ cachedMonths });
  eq('a fully cached year asks the network for nothing', r.requests.length, 0);
  eq('and the chart still gets all 243 days',
     [...new Set(STORES.map(s => Object.keys(r.allDailyData[s.name] || {}).length))], [243]);
  eq('every month was actually offered to the cache', r.cacheReads.length, 48);
}

/* ── 4. the fetched span covers the months MISSING, not the whole year by reflex ───────────────── */
console.log('\n4. a partly cached year narrows the request to the missing span');
{
  const cachedMonths = {};
  for (const s of STORES) { cachedMonths[s.name] = {}; for (let m = 1; m <= 5; m++) cachedMonths[s.name][m] = daysOf(2026, m); }
  const r = await run({ cachedMonths });
  eq('still one request per store', r.requests.length, 6);
  eq('and it starts at June, not January', [...new Set(r.requests.map(spanOf))], ['2026-06-01..2026-08-31']);
  eq('the cached months are in the chart too',
     [...new Set(STORES.map(s => Object.keys(r.allDailyData[s.name] || {}).length))], [243]);
}

/* ── 5. months already in memory are not re-fetched ───────────────────────────────────────────── */
console.log('\n5. allDailyData is checked before localStorage and before the network');
{
  const seeded = {};
  for (const s of STORES) {
    seeded[s.name] = {};
    for (const d of daysOf(2026, 1).concat(daysOf(2026, 2))) seeded[s.name][d.date] = d;
  }
  const r = await run({ seeded });
  eq('the span skips the months already in memory', [...new Set(r.requests.map(spanOf))], ['2026-03-01..2026-08-31']);
  ok('and January/February were never offered to localStorage either',
     !r.cacheReads.some(k => k.endsWith('|1') || k.endsWith('|2')));
}

/* ── 6. a store with nothing missing drops out entirely ───────────────────────────────────────── */
console.log('\n6. one store fully cached, five cold');
{
  const cachedMonths = { Center: {} };
  for (let m = 1; m <= 8; m++) cachedMonths.Center[m] = daysOf(2026, m);
  const r = await run({ cachedMonths });
  eq('five requests, not six', r.requests.length, 5);
  ok('and Center is not one of them', !r.requests.some(x => storeOf(x) === 'Center'));
  eq('Center still has its full year', Object.keys(r.allDailyData.Center).length, 243);
}

/* ── 7. one store failing costs that store only ───────────────────────────────────────────────── */
console.log('\n7. a lost request does not take the other five with it');
{
  const r = await run({ fetchFails: new Set(['River']) });
  eq('the other five still landed',
     STORES.filter(s => s.name !== 'River').map(s => Object.keys(r.allDailyData[s.name] || {}).length),
     [243, 243, 243, 243, 243]);
  eq('the failed store has no bars rather than wrong ones', Object.keys(r.allDailyData.River || {}).length, 0);
  ok('the chart is still redrawn for the five that worked', r.renders === 1);
}

/* ── 8. the request is bounded, and retried the way the foreground is ─────────────────────────── */
console.log('\n8. one request now carries a store\'s whole year, so it gets the foreground\'s budget');
{
  const r = await run();
  eq('two attempts', [...new Set(r.requests.map(x => x.attempts))], [2]);
  eq('15s ceiling each, matching fetchPhase', [...new Set(r.requests.map(x => x.timeoutMs))], [15000]);
  ok('worst case is bounded well inside one 60s poll', 2 * 15000 + 2000 < 60000);
}

/* ── 9. nothing is written back to the month cache from a multi-month answer ──────────────────── */
console.log('\n9. a multi-month answer is not a month payload and is not cached as one');
{
  const r = await run();
  eq('no synthesized month entries', r.cacheWrites, []);
}

/* ── 10. a past year still walks all twelve months, in one request ────────────────────────────── */
console.log('\n10. viewing 2025 asks for the whole of 2025');
{
  const r = await run({ activeYear: 2025 });
  eq('one request per store', r.requests.length, 6);
  eq('January through December', [...new Set(r.requests.map(spanOf))], ['2025-01-01..2025-12-31']);
  eq('365 days per store', [...new Set(STORES.map(s => Object.keys(r.allDailyData[s.name] || {}).length))], [365]);
}

/* ── 11. January of the current year has no prior month and must ask for nothing ──────────────── */
console.log('\n11. the current month is never in the backfill\'s range');
{
  const r = await run();
  ok('the span stops at the end of August, never touching September',
     r.requests.every(x => spanOf(x).split('..')[1] < '2026-09-01'));
}

/* ── 12. the pool is unchanged — the fix is the request count, not the concurrency ────────────── */
console.log('\n12. BACKFILL_POOL stays at 4');
{
  const src = grab('backfillDailyHistory');
  const m = /BACKFILL_POOL\s*=\s*(\d+)/.exec(src);
  ok('the constant is still there', !!m);
  eq('and still 4 — raising it steals throughput from the 60s poll', m && Number(m[1]), 4);
}

/* ── 13. the comment that sent Sky looking for a cache that "was not written" is gone ─────────── */
console.log('\n13. the source no longer claims historical months are never persisted');
{
  const src = grab('backfillDailyHistory');
  ok('no "never written to localStorage" claim contradicting the code',
     !/never written (back )?to localStorage/i.test(src) && !/kept in-memory only/i.test(src));
  // The rationale block sits immediately above the function; grab() returns only the body.
  const at = HTML.indexOf(src);
  const preamble = HTML.slice(Math.max(0, at - 4000), at);
  ok('the live measurement that justifies this shape is recorded above it',
     /44\.6 SECONDS/.test(preamble) && /48 requests/.test(preamble));
  ok('and so is the reason the pool is not the lever', /2026-09-06/.test(preamble));
}

console.log(`\n${pass} passed, ${fail} failed`);
finished = true;
process.exitCode = fail ? 1 : 0;
})();
