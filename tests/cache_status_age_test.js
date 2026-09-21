#!/usr/bin/env node
/* ONE CACHED ENTRY WITH NO `ts` MADE THE WHOLE AGE READOUT `oldest NaNh ago`.
 *
 * Settings' cache line reported the age of the oldest cached entry by folding every matching
 * localStorage key through Math.min on its `ts`. v2.611 added `gc_sales_open_bundle` — the
 * server-built opening snapshot, stored exactly as it arrived — and it has no top-level `ts`
 * at all: its ages are per-part `as_of`. The key matches `isSalesCacheKey_` (deliberately, so
 * "Clear cache" sweeps it), the JSON parses fine so the try/catch never fires, and
 * `Math.min(x, undefined)` is NaN. NaN then survives every later Math.min, so ONE ts-less
 * entry poisoned a figure summarizing nineteen.
 *
 * Measured in the browser against the live app on 2026-09-21, before the fix:
 *   "19 items cached (13 sales months) · oldest NaNh ago"   ← gc_sales_open_bundle present
 * and after: "19 items cached (13 sales months) · oldest 98h ago".
 *
 * Two rules, both pinned below. Skip an entry that cannot answer rather than letting it answer
 * wrongly, and when NOTHING can answer say nothing — an absent clause beats a nonsense one,
 * the same rule as the hero refusing to claim a figure it does not have.
 *
 * Reads and EXECUTES the shipped index.html, not a copy.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

/** Pull a named top-level function out of the shipped source by brace balance. */
function grab(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let d = 0, i = HTML.indexOf('{', start);
  for (let j = i; j < HTML.length; j++) {
    if (HTML[j] === '{') d++;
    else if (HTML[j] === '}' && --d === 0) return HTML.slice(start, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

/** Run the SHIPPED updateCacheStatus over a fake localStorage and return what it painted. */
function paint(store) {
  const el = { textContent: '' };
  const ctx = {
    localStorage: { getItem: k => (k in store ? store[k] : null) },
    Object,
    JSON,
    Math,
    Date,
    isFinite,
    isSalesCacheKey_: k => k.startsWith('gc_sales_') && k !== 'gc_sales_token',
    document: { getElementById: id => (id === 'cache-status' ? el : null) },
  };
  // Object.keys(localStorage) must enumerate the fake store's keys, as it does on the real one.
  ctx.localStorage = new Proxy(ctx.localStorage, {
    ownKeys: () => Object.keys(store),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
  vm.createContext(ctx);
  vm.runInContext(grab('updateCacheStatus') + '\nupdateCacheStatus();', ctx);
  return el.textContent;
}

const HOUR = 3600 * 1000;
const now = Date.now();

console.log('\n1. the shape that was live: a ts-less snapshot beside real cached months');
{
  const out = paint({
    'gc_sales_token': '{"token":"x"}',                              // never counted — not a cache entry
    'gc_sales_v2_Bend_2026_8': JSON.stringify({ ts: now - 98 * HOUR, days: [] }),
    'gc_sales_v2_Bend_2026_9': JSON.stringify({ ts: now - 2 * HOUR, days: [] }),
    'gc_sales_open_bundle': JSON.stringify({ stores: {}, pace: { as_of: '2026-09-21T21:00:00Z' } }),
    'gc_cache_expbudgets': JSON.stringify({ ts: now - 30 * HOUR, data: {} }),
  });
  console.log('     ' + out);
  ok('no NaN anywhere in the line', !/NaN/.test(out));
  ok('the oldest entry that CAN answer is the one reported (98h)', /oldest 98h ago/.test(out));
  ok('the ts-less snapshot is still COUNTED as a cached item', /^4 items cached/.test(out));
  ok('the session token is not counted', !/^5 items/.test(out));
  // The "sales months" count is every gc_sales_ key, so it includes the snapshot: 2 months + the
  // bundle = 3. Pre-existing and left alone deliberately — asserted here so the number is a
  // recorded fact rather than something the next reader has to re-derive from the label.
  ok('sales months counts the two months plus the snapshot key', /\(3 sales months\)/.test(out));
}

console.log('\n2. when NOTHING can answer, the clause is absent — not NaN, and not a fake zero');
{
  const out = paint({
    'gc_sales_open_bundle': JSON.stringify({ stores: {} }),
    'gc_cache_meta': JSON.stringify({ data: {} }),
  });
  console.log('     ' + out);
  ok('no age clause at all', !/oldest/.test(out));
  ok('no NaN', !/NaN/.test(out));
  ok('...and it does not claim 0m, which would read as "just cached"', !/0m ago/.test(out));
  ok('the count is still reported', /^2 items cached/.test(out));
}

console.log('\n3. a ts that is present but not a usable number is skipped too');
{
  // A half-written or older-format entry. `null` and a date STRING both parse and both break
  // Math.min in their own way — null coerces to 0 and would report a 1970 age, which is worse
  // than NaN because it looks like an answer.
  const out = paint({
    'gc_sales_v2_Bend_2026_9': JSON.stringify({ ts: null, days: [] }),
    'gc_sales_v2_River_2026_9': JSON.stringify({ ts: '2026-09-21T00:00:00Z', days: [] }),
    'gc_cache_goals': JSON.stringify({ ts: now - 3 * HOUR, data: {} }),
  });
  console.log('     ' + out);
  ok('the numeric ts wins and no 1970 age appears', /oldest 3h ago/.test(out));
  ok('no NaN', !/NaN/.test(out));
}

console.log('\n4. unchanged behavior the fix had to preserve');
{
  ok('no keys at all still reads "No cache"', paint({}) === 'No cache');
  const one = paint({ 'gc_cache_goals': JSON.stringify({ ts: now - 10 * 60000, data: {} }) });
  console.log('     ' + one);
  ok('a single item is singular, and minutes render as minutes', /^1 item cached \(0 sales months\) · oldest 10m ago$/.test(one));
  const corrupt = paint({
    'gc_sales_v2_Bend_2026_9': '{not json',
    'gc_cache_goals': JSON.stringify({ ts: now - 5 * HOUR, data: {} }),
  });
  ok('a corrupt entry is still skipped by the catch, not fatal', /oldest 5h ago/.test(corrupt));
}

console.log('\n5. the source itself keeps the guard rather than re-deriving the hazard');
{
  const src = grab('updateCacheStatus');
  ok('the ts is type-checked before it reaches Math.min',
     /typeof t === 'number' && isFinite\(t\)/.test(src));
  ok('the age clause is conditional on a finite answer', /if \(isFinite\(oldest\)\)/.test(src));
  ok('Math.min is never handed a raw parsed field again',
     !/Math\.min\(min, JSON\.parse/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
