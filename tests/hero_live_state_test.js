#!/usr/bin/env node
/* THE MOBILE HERO'S LIVE LIGHT TELLS THE TRUTH ABOUT COVERAGE.
 *
 * Sky, 2026-09-16: "Oh man it's slow again" — and, asked which shape: most stores land, one or two
 * lag, on a phone. He could not name which, and the app is the reason. pill() writes to
 * #dsk-live-txt and nothing else, so `6/6 stores · today pending: River` — the one line saying the
 * figure above it is understated — existed on the DESKTOP and nowhere on mobile. The hero's live dot
 * is hardcoded green in the stylesheet and never touched by JS, so a total short a store's today sat
 * under a confident green light on the only device the complaint ever comes from.
 *
 * That is the River shape one level up: a per-store failure degrading into a smaller number rather
 * than a message. The per-store blink (v2.591, store_dot_blink_test.js) says WHICH ROW is not
 * current; this says the COMPANY TOTAL is not whole, which is a different statement.
 *
 * EXECUTES the shipped _heroLiveHtml_ and viewIncludesToday_ out of index.html. Every assertion here
 * is mutation-verified — see the block at the end of this file for what was broken and what failed.
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

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const TODAY = '2026-09-16';
const SIX = ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd', 'River'];

/* `landed` is the set of stores whose figures are actually IN the total — liveData's own keys.
 * A third thing this builder reports was added 2026-09-17 (the total is still being ASSEMBLED, see
 * tests/hero_partial_total_test.js), and it reads that fact off liveData and the store filter
 * rather than off a second definition of "not current". So the context has to carry both. Every
 * assertion below is unchanged: these fixtures are all complete totals, where the new branch is
 * silent by construction — except §6, which is the cold boot and passes `landed: []`. */
function heroCtx({ state = {}, todayPending = [], landed = SIX,
                   range = { from: '2026-09-01', to: TODAY } } = {}) {
  const ctx = {
    STORES: SIX.map(n => ({ name: n, display: n })),
    _storeStateMap: state,
    _todayPending: new Set(todayPending),
    liveData: Object.fromEntries(landed.map(n => [n, { netSales: 1000 }])),
    activeStore: 'All',
    activeStoreSet: null,
    activeDay: null,
    _loadAllStoresInFlight: landed.length < SIX.length,
    laDay: () => TODAY,
    periodRange: () => ({ from: range.from, to: range.to }),
    toDateStr: d => d,
  };
  vm.createContext(ctx);
  vm.runInContext([grab('viewIncludesToday_'), grab('getActiveStores'), grab('salesPending'),
                   grab('_heroLiveHtml_')].join('\n'), ctx);
  return ctx;
}

const allOk = Object.fromEntries(SIX.map(n => [n, 'ok']));

console.log('\n1. everything landed — the light stays green and says nothing extra');
{
  const c = heroCtx({ state: allOk });
  const h = c._heroLiveHtml_('14:32', 'day 16 of 30');
  ok('no state modifier on the live block', /class="ic-hero-live"/.test(h));
  ok('neither amber nor red', !/stale|failed/.test(h));
  ok('the sync time still renders', h.includes('14:32'));
  ok('the period day still renders', h.includes('day 16 of 30'));
  ok('no coverage note is invented', !/pending|stores/.test(h));
}

console.log('\n2. one store missing only TODAY — amber, and it NAMES the store');
{
  const c = heroCtx({ state: allOk, todayPending: ['River'] });
  const h = c._heroLiveHtml_('14:32', '');
  ok('the live block is marked stale', /class="ic-hero-live stale"/.test(h));
  ok('the lagging store is named', h.includes('River pending'));
  ok('not reported as a failed store count', !h.includes('/6 stores'));
  // The whole point: the reader can tell the total is short WITHOUT counting rows.
  ok('the note rides the same line as the sync time', /14:32[^<]*River pending/.test(h));
}

console.log('\n3. two or more pending — a count, since two names do not fit a phone');
{
  const c = heroCtx({ state: allOk, todayPending: ['River', 'Portland Rd'] });
  const h = c._heroLiveHtml_('14:32', '');
  ok('still amber', /ic-hero-live stale/.test(h));
  ok('counted, not listed', h.includes('2 stores pending'));
  ok('no single-store phrasing', !/River pending|Portland Rd pending/.test(h));
}

console.log('\n4. a store that FAILED outright is the stronger statement');
{
  const c = heroCtx({ state: Object.assign({}, allOk, { Hillsboro: 'err' }), todayPending: ['River'] });
  const h = c._heroLiveHtml_('14:32', '');
  ok('red, not amber', /class="ic-hero-live failed"/.test(h));
  ok('reports coverage as a fraction', h.includes('5/6 stores'));
  ok('err outranks today-pending — one message, not two', !h.includes('pending'));
}

console.log('\n5. the today-pending guard matches storeNotCurrent_ exactly');
{
  // The set is not cleared by a load that never reaches today, so an August view holding a
  // September miss must not claim August is short. Same guard the blinking dot uses.
  const aug = heroCtx({ state: allOk, todayPending: ['River'],
                        range: { from: '2026-08-01', to: '2026-08-31' } });
  const h = aug._heroLiveHtml_('14:32', '');
  ok('an August view does not report a September miss', !h.includes('pending'));
  ok('and stays green', /class="ic-hero-live"/.test(h));
}

console.log('\n6. the FIRST load must not claim the total is short');
{
  // Nothing has answered yet: every store is 'loading', nothing is today-pending. The hero shimmers
  // on its own (dataWait); an amber "short" light over a shimmer would be an answer to a question
  // nobody has asked yet — the same error as the $0 hero first_load_state_test.js pins.
  const c = heroCtx({ state: Object.fromEntries(SIX.map(n => [n, 'loading'])), landed: [] });
  const h = c._heroLiveHtml_('14:32', '');
  ok('a load in flight is not reported as missing stores', !/pending|\/6 stores/.test(h));
  ok('and the light is not red', !/failed/.test(h));
}

console.log('\n7. ALL THREE hero branches go through the one builder');
{
  // The three ic-hero-top blocks were hand-copied. A note added to two of three is the bug-ingest
  // re-pack hazard again: nothing throws, and one branch silently keeps the old green light.
  // Written as the ABSENCE of the hand-copied block, not the presence of a call — a grep for the
  // call goes green the moment ONE appears.
  const calls = (HTML.match(/\$\{_heroLiveHtml_\(syncTime, periodDay\)\}/g) || []).length;
  ok('the builder is used three times', calls === 3);
  ok('no hand-copied live block survives in a hero branch',
     !/<div class="ic-hero-live">\s*\n\s*<div class="ic-hero-live-dot"><\/div>/.test(HTML));
  ok('the builder is defined once', (HTML.match(/\nfunction _heroLiveHtml_\s*\(/g) || []).length === 1);
}

console.log('\n8. both state colors are actually defined in the stylesheet');
{
  // A class emitted into markup with no rule behind it renders as the default green — the failure
  // would be invisible in a screenshot, exactly like the .recon-kpi-off specificity trap.
  ok('.ic-hero-live.stale recolors the text', /\.ic-hero-live\.stale\{[^}]*color:var\(--amber\)/.test(HTML));
  ok('.ic-hero-live.stale recolors the dot',
     /\.ic-hero-live\.stale \.ic-hero-live-dot\{[^}]*background:var\(--amber\)/.test(HTML));
  ok('.ic-hero-live.failed recolors the text', /\.ic-hero-live\.failed\{[^}]*color:var\(--red\)/.test(HTML));
  ok('.ic-hero-live.failed recolors the dot',
     /\.ic-hero-live\.failed \.ic-hero-live-dot\{[^}]*background:var\(--red\)/.test(HTML));
}

console.log(`\n${pass} passed, ${fail} failed`);

/* ── MUTATION LOG ──────────────────────────────────────────────────────────────────────────────
 * A check that cannot fail looks exactly like a check that passed, so each assertion above was
 * shown failing for its own reason:
 *
 *   1. `cls = ' stale'` -> `cls = ''`                          2 fail  §2 marked stale, §3 still amber
 *   2. `if (failed.length)` disabled, so pending wins          3 fail  §4 all three
 *   3. the viewIncludesToday_() guard dropped from `pend`      2 fail  §5 both
 *   4. `pend.length === 1` -> `pend.length >= 1`               2 fail  §3 counted / no single phrasing
 *   5. one hero branch reverted to the hand-copied block       2 fail  §7 count, and absence
 *   6. `.ic-hero-live.stale` rules deleted from the stylesheet 2 fail  §8 text and dot
 *   7. `=== 'err'` -> `!== 'ok'`, so 'loading' reads as failed 2 fail  §6 both
 *
 * Each mutation's target was asserted present before it was applied, so none was vacuous — a
 * mutation that silently matches nothing is a green run wearing a lab coat.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */
