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
  remove(k) { store.delete(k); },
};

// Wall time for the in-flight wait, separate from the TTL clock. Utilities.sleep advances it and runs
// whatever the "other execution" was scheduled to do at that moment.
// Entries carry an as_of stamped from Date.now() and are judged by it, so the cache clock (seconds)
// has to move Date.now() too — otherwise an age check could never see time pass.
let wallMs = 0, sleeps = 0, onSleep = null;
const BASE_MS = 1789000000000;
const nowMs = () => BASE_MS + wallMs + clock * 1000;
const FakeDate = class extends Date { static now() { return nowMs(); } };

let liveCalls = [];
const ctx = {
  console, CACHE,
  // The real live fetch is replaced; what is under test is the caching wrapper around it, and the
  // wrapper is the part that was missing. Returns a distinguishable payload per call so a served
  // copy is tellable from a fresh one.
  Date: FakeDate,
  Utilities: { sleep(ms) { wallMs += ms; sleeps++; if (onSleep) onSleep(wallMs); } },
  probeMark_() {},
  dutchieTodayFetchLive_(store_, todayPT, toISO) {
    if (ctx.__liveThrows) throw new Error('dutchie_get unreachable');
    liveCalls.push({ store: store_, todayPT, toISO });
    return { netSales: 100 * liveCalls.length, orders: liveCalls.length, at: toISO };
  },
};
vm.createContext(ctx);
const constLine = n => { const m = new RegExp('\\nconst ' + n + '\\s*=\\s*[^;]+;').exec(SRC); if (!m) throw new Error('no const ' + n); return m[0]; };
vm.runInContext([constLine('DTODAY_WAIT_MS_'), constLine('DTODAY_FLIGHT_TTL_'),
  constLine('DTODAY_FRESH_S_'), constLine('DTODAY_SNAPSHOT_S_'), constLine('DTODAY_KEEP_S_'),
  grab('cacheGet_'), grab('cacheSet_'), grab('dtodayMaxAge_'), grab('dutchieTodayFetch_'), grab('dtodayAwaitFlight_')].join('\n'), ctx);

// maxage goes through the shipped clamp, exactly as getStoreSales_ hands it over.
const call = (s, day, toISO, nocache, maxage) =>
  vm.runInContext('dutchieTodayFetch_(' + JSON.stringify([s, day, toISO, nocache == null ? null : nocache]).slice(1, -1)
    + ', dtodayMaxAge_(' + JSON.stringify(maxage == null ? null : maxage) + '))', ctx);
const KEY = (s, d) => 'dtoday_v2_' + s + '_' + d;
const entry = (obj, asOf) => JSON.stringify(Object.assign({}, obj, { as_of: asOf }));

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}
function reset() { store.clear(); liveCalls = []; clock = 0; wallMs = 0; sleeps = 0; onSleep = null; ctx.__liveThrows = false; }

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

console.log('\nthe default freshness is real: 90 seconds, and it expires');
reset();
call('River Rd', '2026-09-03', '2026-09-03T18:00:00Z');
clock += 89; call('River Rd', '2026-09-03', '2026-09-03T18:01:29Z');
check('at 89s it is still served', liveCalls.length, 1);
clock += 2;  call('River Rd', '2026-09-03', '2026-09-03T18:01:31Z');
check('past 90s it re-pulls — "Live" must not become a lie', liveCalls.length, 2);
// The desktop polls every 60s (AUTO_REFRESH_MS). A window at or under that leaves nearly every
// poll paying full price, which is the silent way this change accomplishes nothing.
check('the default window outlives the 60s poll interval', vm.runInContext('DTODAY_FRESH_S_', ctx) > 60, true);

/* ── OPENING THE APP READS THE BACKGROUND SNAPSHOT ────────────────────────────────────────────────
 * Sky, 2026-09-17: "when i open the sales app it shows me the latest details, which might be a few
 * minutes old". The background refresh keeps an entry warm; an open asks with maxage=600 and must be
 * served it, while a poll/Refresh asking the default must NOT be handed that same old figure. */
console.log('\nmaxage: an open takes a minutes-old snapshot, a Refresh does not');
reset();
store.set(KEY('Bend', '2026-09-03'), { v: entry({ netSales: 555 }, nowMs()), until: 1e9 });
clock += 300;   // five minutes later
check('an open (maxage=600) is served the 5-minute-old snapshot', call('Bend', '2026-09-03', 'x', null, 600).netSales, 555);
check('...without a live pull', liveCalls.length, 0);
check('a Refresh (default) re-pulls instead of taking it', call('Bend', '2026-09-03', 'x').netSales, 100);
check('...and the fresh pull is what the next open sees', call('Bend', '2026-09-03', 'x', null, 600).netSales, 100);
reset();
store.set(KEY('Bend', '2026-09-03'), { v: entry({ netSales: 555 }, nowMs()), until: 1e9 });
clock += 601;
check('past 600s even an open re-pulls', call('Bend', '2026-09-03', 'x', null, 600).netSales, 100);
reset();
store.set(KEY('Bend', '2026-09-03'), { v: entry({ netSales: 555 }, nowMs()), until: 1e9 });
clock += 900;
check('a caller cannot widen the window past 600 (maxage=99999 is clamped)', call('Bend', '2026-09-03', 'x', null, 99999).netSales, 100);
check('garbage maxage means the default', vm.runInContext("dtodayMaxAge_('abc')", ctx), 90);
check('negative maxage means the default', vm.runInContext("dtodayMaxAge_('-5')", ctx), 90);
check('maxage=0 is honored — always pull', vm.runInContext("dtodayMaxAge_('0')", ctx), 0);
check('every pull is stamped with as_of', JSON.parse(store.get(KEY('Bend', '2026-09-03')).v).as_of > 0, true);
check('an entry is KEPT past the widest window, or the snapshot has nothing to serve',
  vm.runInContext('DTODAY_KEEP_S_ > DTODAY_SNAPSHOT_S_', ctx), true);
reset();
store.set(KEY('Bend', '2026-09-03'), { v: JSON.stringify({ netSales: 555 }), until: 1e9 });  // no as_of
check('an entry with no as_of has an unknown age and is not served', call('Bend', '2026-09-03', 'x', null, 600).netSales, 100);

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
store.set(KEY('River Rd', '2026-09-03'), { v: '{"netSales":', until: 1e9 }); // truncated body
let survived = true, got = null;
try { got = call('River Rd', '2026-09-03', '2026-09-03T18:00:04Z'); } catch (e) { survived = false; }
check('unparseable JSON does not throw out of the fetch', survived, true);
check('it falls through to a live pull', liveCalls.length, 2);
check('and returns real numbers', got && got.netSales, 200);

/* ── A SECOND ASKER JOINS THE PULL ALREADY RUNNING ─────────────────────────────────────────────────
 * Sky, 2026-09-13: "it took 60+ seconds to load on mobile." The browser abandons a live half at 15s;
 * Apps Script does not, so the retry used to start a second identical 20s pull and lose it too. */
const FLIGHT = KEY('River Rd', '2026-09-03') + '__inflight';
const ENTRY  = KEY('River Rd', '2026-09-03');

console.log('\na request arriving mid-pull is served that pull\'s answer');
reset();
let pullStart = nowMs();
store.set(FLIGHT, { v: String(pullStart), until: 1e9 });           // another execution is pulling
onSleep = t => { if (t >= 6000 && !store.has(ENTRY)) {             // …and lands 6s later
  store.set(ENTRY, { v: entry({ netSales: 777 }, pullStart), until: 1e9 }); store.delete(FLIGHT); } };
got = call('River Rd', '2026-09-03', '2026-09-03T18:00:10Z');
check('no second pull', liveCalls.length, 0);
check('it returns the in-flight pull\'s figure', got && got.netSales, 777);
check('and it waited for it rather than giving up at once', wallMs >= 6000, true);

/* Entries are kept 20 minutes now, so during a pull the cache usually still holds the OLDER figure
 * the caller just turned down. "Any hit" would hand that straight back as if it were the new one. */
console.log('\nmid-pull, the OLD entry still sitting in the cache is not the answer');
reset();
store.set(ENTRY, { v: entry({ netSales: 111 }, nowMs()), until: 1e9 });   // old figure
clock += 200;                                                              // too old for a Refresh
pullStart = nowMs();
store.set(FLIGHT, { v: String(pullStart), until: 1e9 });
onSleep = t => { if (t >= 4000 && store.has(FLIGHT)) {
  store.set(ENTRY, { v: entry({ netSales: 999 }, pullStart), until: 1e9 }); store.delete(FLIGHT); } };
got = call('River Rd', '2026-09-03', 'x');
check('it waited for the new figure instead of returning the old one at once', got && got.netSales, 999);
check('...and still made no pull of its own', liveCalls.length, 0);

console.log('\nthe other pull FAILED: the waiter pulls at once, not after the whole wait');
reset();
store.set(FLIGHT, { v: '1', until: 1e9 });
onSleep = t => { if (t >= 2000) store.delete(FLIGHT); };            // gone, and no answer left behind
got = call('River Rd', '2026-09-03', '2026-09-03T18:00:10Z');
check('it did its own pull', liveCalls.length, 1);
check('within moments of the marker clearing, not the full wait', wallMs < 3000, true);

console.log('\na stuck marker blocks nobody past the wait');
reset();
store.set(FLIGHT, { v: '1', until: 1e9 });
got = call('River Rd', '2026-09-03', '2026-09-03T18:00:10Z');
check('it pulled for itself', liveCalls.length, 1);
check('after the wait ran out', wallMs >= 25000 && wallMs < 26000, true);
check('the wait is shorter than one browser attempt at the live ceiling (28s)',
  Number(/const DTODAY_WAIT_MS_\s*=\s*(\d+)/.exec(SRC)[1]) < 28000, true);

console.log('\nnocache ignores the marker — "go and look again" is not "wait for an older look"');
reset();
store.set(FLIGHT, { v: '1', until: 1e9 });
call('River Rd', '2026-09-03', '2026-09-03T18:00:10Z', '1');
check('pulls immediately', liveCalls.length === 1 && sleeps === 0, true);

console.log('\nthe marker is set during a pull and cleared after it — even when the pull throws');
reset();
let sawMarker = false;
ctx.dutchieTodayFetchLive_ = (function (orig) { return function () { sawMarker = store.has(FLIGHT); return orig.apply(this, arguments); }; })(ctx.dutchieTodayFetchLive_);
call('River Rd', '2026-09-03', '2026-09-03T18:00:10Z');
check('marked while pulling', sawMarker, true);
check('cleared afterwards', store.has(FLIGHT), false);
ctx.__liveThrows = true; clock += 100;
let threw = false; try { call('River Rd', '2026-09-03', '2026-09-03T18:02:00Z'); } catch (e) { threw = true; }
check('a failed pull still throws to its caller', threw, true);
check('and still clears the marker, so nobody waits on a dead pull', store.has(FLIGHT), false);

console.log('\nthe wrapper is wired into the sales path, not merely defined');
check('getStoreSales_ passes its nocache through to the live fetch',
  /dutchieTodayFetch_\(store, todayPT, to, nocache\b/.test(SRC), true);
check('...and its maxage, through the clamp',
  /dutchieTodayFetch_\(store, todayPT, to, nocache, dtodayMaxAge_\(maxage\)\)/.test(SRC), true);
check('the route hands params.maxage to getStoreSales_',
  /getStoreSales_\(store, from, to, params\.nocache, params\.phase, params\.maxage\)/.test(SRC), true);
// nocache has to be the FOURTH argument, which is what this pins. Arity is deliberately left
// open: `phase` was added after this test and pinning the exact call shape made an unrelated
// change fail here, which teaches the next person to loosen the assertion rather than read it.
check('the route hands params.nocache to getStoreSales_',
  /getStoreSales_\(store, from, to, params\.nocache\b/.test(SRC), true);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
