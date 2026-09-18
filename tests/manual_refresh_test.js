#!/usr/bin/env node
/* Phones stop polling; opening the app reads the server's snapshot; asking for new numbers does not.
 * Sky, 2026-09-17: "when i open the sales app it shows me the latest details, which might be a few
 * minutes old... remove the polling on mobile and replace it with the option to refresh, either with a
 * pull down haptic or by clicking the top right status indicator."
 *
 * The failure modes all look fine on screen:
 *   - a Refresh that still sends maxage hands him the same old figure he was trying to replace;
 *   - an open that never sends it pays the Dutchie hop every time, which is the whole complaint;
 *   - a hero clock stamped with render time claims a 9-minute-old snapshot is current;
 *   - a fresh flag that is not cleared makes every later open a live pull.
 * So the pieces that decide these are EXECUTED from the shipped index.html. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in index.html — renamed or removed?');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}

console.log('\n1. refreshLiveData: a person asking is fresh; only an explicit {fresh:false} is not');
{
  const ctx = {
    _loadAllStoresInFlight: false, _nextLoadFresh: false,
    STORES: [], activeMonth: 9, activeYear: 2026,
    localStorage: { removeItem() {} }, salesCacheKey: () => '',
    _invalidateDerivedCaches() {}, loadPaceFracs() {},
    loads: 0, loadAllStores() { ctx.loads++; },
  };
  vm.createContext(ctx);
  vm.runInContext(grab('refreshLiveData'), ctx);
  vm.runInContext('refreshLiveData()', ctx);
  check('no argument (the poll, the desktop pill) is fresh', ctx._nextLoadFresh, true);
  vm.runInContext('_nextLoadFresh = false; refreshLiveData({ type: "click" })', ctx);
  check('bound as a click handler (an Event) is fresh', ctx._nextLoadFresh, true);
  vm.runInContext('_nextLoadFresh = true; refreshLiveData({ fresh: false })', ctx);
  check('{fresh:false} (returning to the app) takes the snapshot', ctx._nextLoadFresh, false);
  vm.runInContext('_nextLoadFresh = false; _loadAllStoresInFlight = true; refreshLiveData()', ctx);
  check('a refresh that bails on the in-flight guard does not leave the flag set', ctx._nextLoadFresh, false);
}

console.log('\n2. loadAllStores reads the flag ONCE and clears it, and only the live half carries maxage');
{
  const load = grab('loadAllStores');
  check('it captures the flag before anything awaits', /const wantFresh = _nextLoadFresh;[^\n]*\n\s*_nextLoadFresh = false;/.test(load), true);
  check('...after the in-flight guard, so a bailed call cannot consume it',
    load.indexOf('if (_loadAllStoresInFlight) return;') < load.indexOf('const wantFresh'), true);
  check('maxage is sent only on the live phase, and only when not fresh',
    /phase === 'live' && !wantFresh \? `&maxage=\$\{LIVE_SNAPSHOT_MAXAGE_S\}`/.test(load), true);
  const cap = /const LIVE_SNAPSHOT_MAXAGE_S = (\d+);/.exec(SRC);
  const proxy = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
  const srv = /const DTODAY_SNAPSHOT_S_ = (\d+);/.exec(proxy);
  check('the client asks for exactly what the proxy allows (two files, one number)',
    cap && srv && cap[1] === srv[1], true);
  check('today\'s pull time is carried on the month, so a cached month keeps it',
    /merged\.liveAsOf = Number\(lRes\.value\.liveAsOf\) \|\| Date\.now\(\);/.test(load), true);
}

console.log('\n3. the hero clock is when the data was PULLED, oldest store first');
{
  const ctx = { liveData: {}, today: true, shown: ['Bend', 'Center', 'River'] };
  vm.createContext(ctx);
  vm.runInContext('function viewIncludesToday_() { return today; } function getActiveStores() { return shown; }\n' + grab('liveAsOf_'), ctx);
  ctx.liveData = { Bend: { liveAsOf: 5000 }, Center: { liveAsOf: 3000 }, River: { liveAsOf: 9000 } };
  check('the oldest store decides — the total is only as current as its stalest part', vm.runInContext('liveAsOf_()', ctx), 3000);
  ctx.shown = ['Bend', 'River'];
  check('a filtered view only counts the stores it shows', vm.runInContext('liveAsOf_()', ctx), 5000);
  ctx.today = false;
  check('a view without today has no live figure to date', vm.runInContext('liveAsOf_()', ctx), null);
  ctx.today = true; ctx.liveData = {};
  check('nothing landed yet gives null (the caller shows now)', vm.runInContext('liveAsOf_()', ctx), null);
  check('the hero uses it', /const syncTime\s*=\s*new Date\(liveAsOf_\(\) \|\| today\)/.test(SRC), true);
}

console.log('\n4. the ways to ask');
{
  const hero = grab('_heroLiveHtml_');
  check('the hero status is a button that refreshes', /<button type="button" class="ic-hero-live\$\{cls\}" onclick="manualRefresh_\(\)"/.test(hero), true);
  const mr = grab('manualRefresh_');
  check('a tap refreshes FRESH (no {fresh:false})', /refreshLiveData\(\)/.test(mr) && !/fresh:\s*false/.test(mr), true);
  check('...with a haptic', /haptic_\(\)/.test(mr), true);
  check('pull-to-refresh fires manualRefresh_ past the threshold',
    /p\.dy >= PTR_ARM_PX_ && !_loadAllStoresInFlight\) \{ _ptrPulled = true; manualRefresh_\(\); \}/.test(SRC), true);
  check('pull-to-refresh is phones only', /addEventListener\('touchstart', e => \{\s*_ptr = null;\s*if \(!manualRefreshMode_\(\)/.test(SRC), true);
  check('pull-to-refresh never blocks the native scroll (passive, no preventDefault)',
    !/_ptr[\s\S]{0,400}preventDefault/.test(SRC.slice(SRC.indexOf('const PTR_ARM_PX_'), SRC.indexOf('const PTR_ARM_PX_') + 3500)), true);
  check('the indicator element exists', /<div id="ptr"/.test(SRC), true);
}

console.log('\n5. coming back to the app on a phone is an OPEN, not a Refresh');
{
  const vis = SRC.slice(SRC.indexOf("document.addEventListener('visibilitychange'"), SRC.indexOf("document.addEventListener('visibilitychange'") + 900);
  check('a phone returning after the window re-reads the snapshot',
    /manualRefreshMode_\(\)\) \{\s*if \(Date\.now\(\) - _lastLoadAt > RESUME_RELOAD_MS_\) refreshLiveData\(\{ fresh: false \}\);/.test(vis), true);
  check('the desktop still catches up with a fresh refresh', /else refreshLiveData\(\);/.test(vis), true);
  check('the last load time is recorded', /_lastLoadAt = Date\.now\(\);/.test(grab('loadAllStores')), true);
  check('manualRefreshMode_ is the file\'s one phone predicate', /function manualRefreshMode_\(\) \{ return _pSwipeNarrow\(\); \}/.test(SRC), true);
}

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
