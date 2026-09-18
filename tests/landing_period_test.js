#!/usr/bin/env node
/* The landing view is TODAY, and it has to be today from the FIRST frame.
 *
 * Until v2.572 the app booted on the month, loaded the month, rendered the month, and only then —
 * at the very end of loadAllStores, after every store had answered — flipped the selection to today
 * and re-rendered. Sky, 2026-09-06: "why does it load the month first then switch over to the
 * current day once things have been loaded? this is visually confusing." It is: a month figure
 * finishes loading and is immediately replaced by a much smaller day figure, with the period label,
 * the goal, the pace line and the chart all changing underneath it. Neither number was wrong. They
 * answer different questions, and the app asked the second one only after showing the answer to the
 * first.
 *
 * Nothing about the FETCHING changed and this test pins that too: sales are pulled a whole month at
 * a time either way (fetchMonthData keys on year+month, _liveDataKey with it), so the day is a
 * slice of what was already on its way. Only the moment of choosing moved.
 *
 * Reads and EXECUTES the shipped index.html, not a copy.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

function grab(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let d = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') d++;
    else if (HTML[j] === '}' && --d === 0) return HTML.slice(start, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

console.log('\n1. the choice happens before the first paint, not after the last store');
{
  const initIdx  = HTML.indexOf('selectDefaultPeriod_();');
  const navIdx   = HTML.indexOf('\nbuildTimeNav();');
  ok('selectDefaultPeriod_ is called from the top-level init block', initIdx > 0);
  ok('...before buildTimeNav(), so the period bar is built for the day it will show',
     initIdx > 0 && navIdx > initIdx);

  // The boot block starts the data load. The selection must already be made by then, or the first
  // fetch and the first render are for a period the app is about to leave.
  const bootIdx = HTML.indexOf('if (GC_SALES_AUTH.isAuthed())');
  ok('...and before the boot block that calls loadAllStores', bootIdx > initIdx);
}

console.log('\n2. selectDefaultPeriod_ is EXECUTED, both ways');
{
  const src = grab('selectDefaultPeriod_') + '\n' +
              grab('toDateStr') + '\n' + grab('getUserWeek') + '\n' + grab('getISOWeek');
  const t = new Date();

  const cur = { activeYear: t.getFullYear(), activeMonth: t.getMonth() + 1, activeWeek: null, activeDay: null };
  vm.createContext(cur); vm.runInContext(src, cur);
  ok('the current month takes today', cur.selectDefaultPeriod_() === true);
  ok('...activeDay is today, in the app\'s own YYYY-MM-DD text form',
     cur.activeDay === cur.toDateStr(t) && /^\d{4}-\d{2}-\d{2}$/.test(cur.activeDay));
  ok('...and the week is set with it, so the week grain is not left stale',
     cur.activeWeek === cur.getUserWeek(t));

  // A deep link or a restored view into another period keeps what it asked for — auto-selecting a
  // day inside a month the reader chose deliberately is the same confusion pointing the other way.
  const past = { activeYear: t.getFullYear() - 1, activeMonth: 3, activeWeek: null, activeDay: null };
  vm.createContext(past); vm.runInContext(src, past);
  ok('a past period is left exactly as it was', past.selectDefaultPeriod_() === false);
  ok('...activeDay untouched', past.activeDay === null);
  ok('...activeWeek untouched', past.activeWeek === null);

  const otherMo = { activeYear: t.getFullYear(), activeMonth: (t.getMonth() + 1) % 12 + 1, activeWeek: null, activeDay: null };
  vm.createContext(otherMo); vm.runInContext(src, otherMo);
  ok('another month of the SAME year is left alone too', otherMo.selectDefaultPeriod_() === false && otherMo.activeDay === null);
}

console.log('\n3. the end-of-load block no longer re-selects or re-renders');
{
  const load = grab('loadAllStores');
  const i = load.indexOf('if (isInitialLoad)');
  ok('the isInitialLoad block is still there', i > 0);
  // Brace-balanced, not a fixed window: a slice that overruns the block reads the catch handler's
  // render() as this block's and the assertion below passes for the wrong reason.
  let d = 0, end = i;
  for (let j = load.indexOf('{', i); j < load.length; j++) {
    if (load[j] === '{') d++;
    else if (load[j] === '}' && --d === 0) { end = j + 1; break; }
  }
  const blk = load.slice(i, end);

  ok('...it assigns neither activeDay nor activeWeek', !/active(Day|Week)\s*=/.test(blk));
  ok('...it does not rebuild the period bar', !/buildTimeNav\(\)/.test(blk));
  ok('...and it does not re-render', !/\brender\(\)/.test(blk));
  // The two day-scoped loads the month path does not make stay: both re-render, so they belong
  // after the stores have landed.
  ok('...but the day-scoped goal load stays', /loadPeriodGoals\(activeDay\)/.test(blk));
  ok('...and the pace fractions with it', /loadPaceFracs\(\)/.test(blk));
  // refreshCompare already ran above; the flip used to redo it purely because it moved the period.
  ok('...refreshCompare is no longer redone here', !/refreshCompare\(\)/.test(blk));
}

console.log('\n4. the fetch is still a MONTH — the day is a slice of it, not a second load');
{
  ok('fetchMonthData still keys on year and month only',
     // `preset` (2026-09-17) hands in halves from the opening snapshot; it adds no key.
     /async function fetchMonthData\(store, year, month, _retry(, onSettled(, preset)?)?\)/.test(HTML));
  ok('...and liveData is still keyed by year:month, so a day change reloads nothing',
     /const loadKey = activeYear \+ ':' \+ activeMonth;/.test(HTML));
}

console.log('\n5. a day view of TODAY still polls');
{
  const sched = grab('scheduleAutoRefresh');
  ok('the poll is not disabled by the day grain',
     /activeDay && activeDay !== toDateStr\(new Date\(\)\)/.test(sched));
}

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
