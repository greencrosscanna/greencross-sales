#!/usr/bin/env node
/* The intraday Dutchie pull is the only expensive read this app makes that every open tab was
 * paying for separately. Settled days, expenses, deposits, goals and budgets all come out of
 * CacheService, which lives on the SCRIPT and is therefore shared by every viewer; today's sales
 * did not, so six live transaction pulls (includeItems, one per store) fired per tab per 60-second
 * poll for figures that are identical by construction. Three tabs on the same six stores was
 * eighteen pulls a minute.
 *
 * Every way of getting this wrong produces a CORRECT-LOOKING dashboard, which is why it needs a
 * test rather than a read-through:
 *
 *   - fold the live `to` timestamp into the cache key and it can never hit. Numbers stay right,
 *     the congestion is untouched, and nothing anywhere says so.
 *   - forget the nocache bypass and Settings → "clear cache" silently stops meaning it — the proxy
 *     hands back the copy it just gave the tab next door.
 *   - let a corrupt entry throw and a store's whole row dies for a cache miss.
 *
 * So this EXECUTES the shipped dutchieTodayFetch_ out of dutchie_proxy.gs against a counting fake
 * of CacheService, and asserts on the number of live pulls. A restatement of the logic here would
 * keep passing after the real one regressed.
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

// A cache that can EXPIRE, so the TTL is a real assertion and not decoration.
const store = new Map();
let clock = 0;
const CACHE = {
  get(k) {
    const e = store.get(k);
    if (!e) return null;
    if (clock >= e.until) { store.delete(k); return null; }
    return e.v;
  },
  put(k, v, ttl) { store.set(k, { v, until: clock + ttl }); },
  putAll(entries, ttl) { Object.keys(entries).forEach(k => CACHE.put(k, entries[k], ttl)); },
};

let liveCalls = [];
const ctx = {
  console, CACHE,
  // The real live fetch is replaced; what is under test is the caching wrapper around it, and the
  // wrapper is the part that was missing. Returns a distinguishable payload per call so a served
  // copy is tellable from a fresh one.
  dutchieTodayFetchLive_(store_, todayPT, toISO) {
    liveCalls.push({ store: store_, todayPT, toISO });
    return { netSales: 100 * liveCalls.length, orders: liveCalls.length, at: toISO };
  },
};
vm.createContext(ctx);
vm.runInContext([grab('cacheGet_'), grab('cacheSet_'), grab('dutchieTodayFetch_')].join('\n'), ctx);

const call = (s, day, toISO, nocache) =>
  vm.runInContext('dutchieTodayFetch_(' + JSON.stringify([s, day, toISO, nocache]).slice(1, -1) + ')', ctx);

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}
function reset() { store.clear(); liveCalls = []; clock = 0; }

console.log('\nmany tabs, one pull — the whole point');
reset();
// Three tabs asking for the same store, seconds apart. Each sends its OWN live `to` timestamp,
// which is exactly the thing that must not reach the key.
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
clock += 5;  call('River Rd', '2026-09-03', '2026-09-03T18:00:05Z');
clock += 20; call('River Rd', '2026-09-03', '2026-09-03T18:00:25Z');
check('three tabs within the TTL cost ONE live pull', liveCalls.length, 1);
check('and the later tabs get the same figure', call('River Rd', '2026-09-03', '2026-09-03T18:00:31Z').netSales, 100);

console.log('\nthe key is store + day — not the caller\'s clock, and not shared across stores');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
call('Bend',     '2026-09-03', '2026-09-03T18:00:01Z');
check('a second STORE is its own pull, never served River\'s numbers', liveCalls.length, 2);
check('Bend got Bend\'s payload', liveCalls[1].store, 'Bend');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
call('River Rd', '2026-09-04', '2026-09-04T02:00:00Z');
check('a new DAY is its own pull — yesterday cannot be served as today', liveCalls.length, 2);

console.log('\nthe TTL is real: 90 seconds, and it expires');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
clock += 89; call('River Rd', '2026-09-03', '2026-09-03T18:01:29Z');
check('at 89s it is still served', liveCalls.length, 1);
clock += 2;  call('River Rd', '2026-09-03', '2026-09-03T18:01:31Z');
check('past 90s it re-pulls — "Live" must not become a lie', liveCalls.length, 2);
// The client polls every 60s (AUTO_REFRESH_MS). A TTL at or under that leaves nearly every poll
// paying full price, which is the silent way this change accomplishes nothing.
const ttl = /cacheSet_\(liveCacheKey, JSON\.stringify\(out\), (\d+)\)/.exec(SRC);
check('the TTL outlives the 60s poll interval', ttl && Number(ttl[1]) > 60, true);

console.log('\nnocache bypasses — the escape hatch that makes the cache safe to add');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
call('River Rd', '2026-09-03', '2026-09-03T18:00:02Z', '1');
check('nocache forces a fresh pull past a warm entry', liveCalls.length, 2);
check('...and REFRESHES the shared copy rather than leaving the stale one', call('River Rd', '2026-09-03', '2026-09-03T18:00:03Z').netSales, 200);
check('...and does not turn into a permanent bypass', liveCalls.length, 2);

console.log('\na broken cache entry costs a fetch, never the store\'s row');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
store.set('dtoday_v1_River Rd_2026-09-03', { v: '{"netSales":', until: 1e9 }); // truncated body
let survived = true, got = null;
try { got = call('River Rd', '2026-09-03', '2026-09-03T18:00:04Z'); } catch (e) { survived = false; }
check('unparseable JSON does not throw out of the fetch', survived, true);
check('it falls through to a live pull', liveCalls.length, 2);
check('and returns real numbers', got && got.netSales, 200);

console.log('\nthe wrapper is wired into the sales path, not merely defined');
check('getStoreSales_ passes its nocache through to the live fetch',
  /dutchieTodayFetch_\(store, todayPT, to, nocache\)/.test(SRC), true);
// nocache has to be the FOURTH argument, which is what this pins. Arity is deliberately left
// open: `phase` was added after this test and pinning the exact call shape made an unrelated
// change fail here, which teaches the next person to loosen the assertion rather than read it.
check('the route hands params.nocache to getStoreSales_',
  /getStoreSales_\(store, from, to, params\.nocache\b/.test(SRC), true);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
