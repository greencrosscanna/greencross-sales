#!/usr/bin/env node
/* THE HEADLINE ADMITS WHEN IT IS STILL BEING ASSEMBLED.
 *
 * Sky, 2026-09-17: Sales' net sales disagreed with Leaderboard's, and "they eventually updated
 * correctly after a few minutes". Both backends were checked and both were right — River $855 on
 * Sales, $854.81 from Leaderboard's storetoday. What he read was the hero MID-ASSEMBLY:
 * loadAllStores paints after every store settles, so until the last one lands NET SALES is the sum
 * of however many have arrived. It reads low, then climbs, under a confident green light.
 *
 * The store ROWS already say this (storeNotCurrent_ blinks their dot, v2.591) and the hero says it
 * for a FAILED store and for a store whose TODAY is missing (_heroLiveHtml_, v2.600). What no part
 * of the hero said is the case in front of Sky: a store that has not been added in YET.
 *
 * EXECUTES the shipped _heroLiveHtml_, viewIncludesToday_, getActiveStores and getPeriodTotals out
 * of index.html. Verified to FAIL against HEAD:index.html — see the VERIFICATION block at the end
 * for the counts, and the MUTATION LOG for what was broken to prove each assertion can fail.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = process.env.HERO_SRC || path.join(__dirname, '..', 'index.html');
const HTML = fs.readFileSync(SRC, 'utf8');

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

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const TODAY = '2026-09-17';
const SIX   = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];
const allOk = Object.fromEntries(SIX.map(n => [n, 'ok']));

/* One store-month payload, shaped the way fetchMonthData returns one. The figures are the live
 * ones from 2026-09-17 rounded, so the sums below are recognisable rather than invented. */
function payload(net) {
  return { netSales: net, grossSales: Math.round(net * 1.18), orders: Math.round(net / 62),
           discounts: Math.round(net * 0.12), cost: Math.round(net * 0.55), daily: {} };
}
const NETS = { Bend: 1120, Center: 980, Commercial: 1340, Hillsboro: 760, 'Portland Rd': 1010, River: 855 };

/* The context the two hero functions actually read: the state map, the today-pending set, the
 * period range, STORES, the store filter and liveData itself. */
function ctxFor({ state = {}, todayPending = [], landed = [], filter = null,
                  range = { from: '2026-09-01', to: TODAY } } = {}) {
  const ctx = {
    STORES: SIX.map(n => ({ name: n, display: n })),
    _storeStateMap: state,
    _todayPending: new Set(todayPending),
    liveData: Object.fromEntries(landed.map(n => [n, payload(NETS[n])])),
    liveDateMaps: {},
    allDailyData: {},
    activeStore: 'All',
    activeStoreSet: filter ? new Set(filter) : null,
    activeWeek: null,
    activeDay: null,
    laDay: () => TODAY,
    periodRange: () => ({ from: range.from, to: range.to }),
    toDateStr: d => d,
  };
  vm.createContext(ctx);
  vm.runInContext([grab('viewIncludesToday_'), grab('getActiveStores'),
                   grab('getPeriodTotals'), grab('_heroLiveHtml_')].join('\n'), ctx);
  return ctx;
}

/* ── 1 ────────────────────────────────────────────────────────────────────────────────────────
 * ESTABLISHING THE PREMISE: it is not only net sales. Fixture — four of the six stores landed
 * (Bend, Center, Commercial, Hillsboro), Portland Rd and River still in flight. */
console.log('\n1. every headline figure is the same partial sum, so the signal belongs to the hero once');
{
  const four = ['Bend', 'Center', 'Commercial', 'Hillsboro'];
  const c = ctxFor({ state: Object.assign({}, allOk, { 'Portland Rd': 'loading', River: 'loading' }),
                     landed: four });
  const t = c.getPeriodTotals(SIX);
  const sum = k => four.reduce((a, n) => a + payload(NETS[n])[k], 0);
  ok('net sales is four stores, not six',   t.net === sum('netSales'));
  ok('gross understates by the same two',   t.gross === sum('grossSales'));
  ok('transactions understate too',         t.orders === sum('orders'));
  ok('discounts understate too',            t.disc === sum('discounts'));
  // AOV is net/orders — two partial figures, so it is wrong in a way no reader can predict.
  ok('a store with no entry contributes nothing at all',
     t.net < SIX.reduce((a, n) => a + NETS[n], 0));
}

/* ── 2 ────────────────────────────────────────────────────────────────────────────────────────
 * THE COMPLAINT ITSELF. Fixture — the same four-of-six mid-assembly moment. THIS IS THE
 * ASSERTION THAT FAILS ON HEAD: the hero says nothing at all here today. */
console.log('\n2. mid-assembly: the hero says how much of itself is in the number');
{
  const c = ctxFor({ state: Object.assign({}, allOk, { 'Portland Rd': 'loading', River: 'loading' }),
                     landed: ['Bend', 'Center', 'Commercial', 'Hillsboro'] });
  const h = c._heroLiveHtml_('14:32', 'day 17 of 30');
  ok('the live block is marked not-final', /class="ic-hero-live stale"/.test(h));
  ok('it counts what is in the total', h.includes('4/6 stores so far'));
  // Counted UP, not down: "4/6" is what is IN the number, the same direction the red branch counts.
  ok('the count is of stores in the total, not stores missing from it',
     h.includes('4/6') && !h.includes('2/6'));
  ok('it rides the same line as the sync time', /14:32[^<]*4\/6 stores so far/.test(h));
  ok('the figure itself is NOT hidden — nothing here blanks the hero', !/val-skel|display:none/.test(h));
}

/* ── 3 ────────────────────────────────────────────────────────────────────────────────────────
 * AND IT STOPS. Fixture — all six landed, all six 'ok', nothing today-pending. */
console.log('\n3. complete: the marker clears the moment the last store lands');
{
  const c = ctxFor({ state: allOk, landed: SIX });
  const h = c._heroLiveHtml_('14:32', 'day 17 of 30');
  ok('green again',                 /class="ic-hero-live"/.test(h));
  ok('no coverage note survives',   !/so far|pending|stores/.test(h));
  ok('the sync time still renders', h.includes('14:32'));
}

/* ── 4 ────────────────────────────────────────────────────────────────────────────────────────
 * THE BOOT CASE AND THE RE-POLL CASE ARE DIFFERENT, AND ONLY ONE IS SKY'S.
 *
 * 4a fixture — cold boot, all six 'loading', liveData empty. The hero is shimmering (salesPending)
 * and an amber "short" light over a shimmer is the $0-hero error again.
 * 4b fixture — a 60-second re-poll: all six 'loading' AND all six still in liveData, because
 * loadAllStores keeps it for a same-period load. storeNotCurrent_ is true for all six here, so a
 * verbatim reuse of that predicate would call a WHOLE total incomplete once a minute, forever. */
console.log('\n4. the first frame and the 60s poll must both stay quiet');
{
  const boot = ctxFor({ state: Object.fromEntries(SIX.map(n => [n, 'loading'])), landed: [] });
  const hb = boot._heroLiveHtml_('14:32', '');
  ok('4a cold boot claims nothing',      !/so far|pending|stores/.test(hb));
  ok('4a and is not red',                !/failed/.test(hb));

  const poll = ctxFor({ state: Object.fromEntries(SIX.map(n => [n, 'loading'])), landed: SIX });
  const hp = poll._heroLiveHtml_('14:32', '');
  ok('4b a re-poll of a WHOLE total is not called partial', !hp.includes('so far'));
  ok('4b and keeps the green light',                        /class="ic-hero-live"/.test(hp));
}

/* ── 5 ────────────────────────────────────────────────────────────────────────────────────────
 * PRECEDENCE. One message, never two. Fixture 5a — Hillsboro 'err' with no data, River still
 * loading. 5b — four landed, two loading, and Center's today is pending as well. */
console.log('\n5. one message: err outranks partial, partial outranks today-pending');
{
  const a = ctxFor({ state: Object.assign({}, allOk, { Hillsboro: 'err', River: 'loading' }),
                     landed: ['Bend', 'Center', 'Commercial', 'Portland Rd'] });
  const ha = a._heroLiveHtml_('14:32', '');
  ok('5a a failed store is still the red statement', /class="ic-hero-live failed"/.test(ha));
  ok('5a reported as coverage, not as "so far"', ha.includes('5/6 stores') && !ha.includes('so far'));

  const b = ctxFor({ state: Object.assign({}, allOk, { 'Portland Rd': 'loading', River: 'loading' }),
                     landed: ['Bend', 'Center', 'Commercial', 'Hillsboro'], todayPending: ['Center'] });
  const hb = b._heroLiveHtml_('14:32', '');
  ok('5b a wholly missing store outranks a missing today', hb.includes('4/6 stores so far'));
  ok('5b and does not say both things at once',            !hb.includes('pending'));
}

/* ── 6 ────────────────────────────────────────────────────────────────────────────────────────
 * THE COUNT DESCRIBES THE NUMBER ON SCREEN, NOT THE COMPANY. Fixture — the store filter is set to
 * Bend + River, and only Bend has landed. "1/6" would describe a total nobody is looking at. */
console.log('\n6. a filtered headline is counted against the stores it actually sums');
{
  const c = ctxFor({ state: Object.assign({}, allOk, { River: 'loading' }),
                     landed: ['Bend', 'Center', 'Commercial'], filter: ['Bend', 'River'] });
  const h = c._heroLiveHtml_('14:32', '');
  ok('counted against the filtered set', h.includes('1/2 stores so far'));
  ok('not against all six',              !h.includes('/6 stores'));
}

/* ── 7 ────────────────────────────────────────────────────────────────────────────────────────
 * IT REACHES THE PHONE. Sky hit this on his phone, and v2.600 exists because the desktop pill was
 * the only place the coverage line had ever been written. Source-level, against index.html. */
console.log('\n7. the marker reaches the mobile hero, not just the desktop one');
{
  const calls = (HTML.match(/\$\{_heroLiveHtml_\(syncTime, periodDay\)\}/g) || []).length;
  ok('all three hero branches still go through the one builder', calls === 3);
  ok('the mobile hero is built by the same inner builder',
     /id="ic-mob-hero"[\s\S]{0,200}\$\{_incomeHeroInnerHtml\(/.test(HTML));
  ok('and so is the desktop one',
     /id="ic-dsk-hero"[\s\S]{0,200}\$\{_incomeHeroInnerHtml\(/.test(HTML));
  ok('the poll patches BOTH heroes, so the marker clears on the phone too',
     /patchEl\('ic-mob-hero',\s*_incomeHeroInnerHtml/.test(HTML) &&
     /patchEl\('ic-dsk-hero',\s*_incomeHeroInnerHtml/.test(HTML));
}

/* ── 8 ────────────────────────────────────────────────────────────────────────────────────────
 * THE AMBER IT USES IS REAL CSS. A class with no rule behind it renders as the default green and
 * the failure is invisible in a screenshot. No FOURTH state class is introduced. */
console.log('\n8. the amber state is defined, and no new orphan class was invented');
{
  ok('.ic-hero-live.stale recolors the text', /\.ic-hero-live\.stale\{[^}]*color:var\(--amber\)/.test(HTML));
  ok('.ic-hero-live.stale recolors the dot',
     /\.ic-hero-live\.stale \.ic-hero-live-dot\{[^}]*background:var\(--amber\)/.test(HTML));
  const emitted = new Set((HTML.match(/cls\s*=\s*' (\w+)'/g) || []).map(m => m.split("'")[1].trim()));
  ok('only stale and failed are ever emitted', [...emitted].every(c => c === 'stale' || c === 'failed'));
}

/* ── 9 ────────────────────────────────────────────────────────────────────────────────────────
 * NOTHING SHIPPED IN THE LAST 48 HOURS WAS LOOSENED TO GET HERE. Source-level, because each of
 * these has its own suite that EXECUTES it; this file only asserts the values are untouched. */
console.log('\n9. the v2.605 wave cap and the v2.597 per-attempt ceilings are untouched');
{
  ok('GAS_MAX_INFLIGHT is still 8',        /const GAS_MAX_INFLIGHT = 8;/.test(HTML));
  ok('live phase caps still [12000, 25000]',   /LIVE_PHASE_CAPS_\s*=\s*\[\s*12000\s*,\s*25000\s*\]/.test(HTML));
  ok('settled phase caps still [8000, 12000, 16000]',
     /SETTLED_PHASE_CAPS_\s*=\s*\[\s*8000\s*,\s*12000\s*,\s*16000\s*\]/.test(HTML));
  ok('the hero builder reads state, it does not fetch',
     !/fetch\(|gasFetchJson/.test(grab('_heroLiveHtml_')));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

/* ── VERIFICATION AGAINST HEAD ────────────────────────────────────────────────
 * Run against the PRE-FIX source with the suite's own escape hatch:
 *
 *   git show HEAD:index.html > /tmp/head.html && HERO_SRC=/tmp/head.html node tests/hero_partial_total_test.js
 *
 * MEASURED, not predicted: 27 passed, 7 failed — §2's four positive assertions (the hero emits no
 * note at all mid-assembly), §5b's two (the today-pending branch answers instead of the bigger
 * hole), and §6's filtered count (there is no such branch to scope).
 *
 * §1, §3, §4, §7, §8, §9 pass on HEAD ON PURPOSE: they are the properties this change had to leave
 * standing, and a file where every line failed would prove nothing about any one of them. Three
 * assertions in the new sections are negative and therefore also pass on HEAD — §2's "the figure is
 * NOT hidden", §4a's "not red" and §6's "not against all six". They are not vacuous: each is failed
 * by a mutation below, or (for §4a's) by mutation 7 of hero_live_state_test.js, which is the file
 * that owns the red branch.
 *
 * ── MUTATION LOG ──────────────────────────────────────────────────────────
 * Counts measured by applying each edit to a copy of index.html and running this file against it.
 * Every target was asserted present first (the edit is a single exact replacement that has to
 * match), so no mutation was vacuous.
 *
 *   1. `counted.length < shown.length` -> `< 0`                  7 fail  the whole feature: §2, §5b, §6
 *   2. the `Object.keys(liveData).length > 0` guard dropped      1 fail  §4a — a cold boot claims 0/6
 *   3. membership read off _storeStateMap instead of liveData,
 *      i.e. storeNotCurrent_'s answer used verbatim              2 fail  §4b both — every poll flagged
 *   4. the `partial` branch moved ABOVE `failed`                 2 fail  §5a both
 *   5. the `partial` branch moved BELOW `pend`                   2 fail  §5b both
 *   6. `getActiveStores()` -> `names`                            2 fail  §6 both
 *   7. `stores so far` -> `stores`                               4 fail  §2 x3, §5b, §6
 *   8. `GAS_MAX_INFLIGHT = 8` -> `19`                            1 fail  §9 — the v2.605 wave cap
 * ────────────────────────────────────────────────────────────────────── */
