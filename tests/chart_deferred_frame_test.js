#!/usr/bin/env node
/* THE CHART IS CREATED INSIDE A FRAME, AND A BACKGROUNDED TAB HAS NO FRAMES.
 *
 * renderIncome's full mount replaces #main-content and then creates both Chart.js instances inside
 * a requestAnimationFrame. Until that frame runs, `charts.week` and `charts.dskWeek` do not exist.
 * Every subsequent render takes the PATCH branch, which updates the chart behind
 * `if (charts.week) { charts.week.data = weekly; … }` — so any render landing in that gap updates
 * nothing at all, and the pending frame then paints whatever `weekly` it closed over at mount time.
 *
 * A few milliseconds of gap is harmless. A BACKGROUNDED TAB SUSPENDS rAF INDEFINITELY, which turns
 * the gap into "until the reader looks back at the phone". Verified on the live deployment
 * 2026-09-12: mount with the year absent, deliver it, then let the frame run — 0 chart instances at
 * mount, 0 when the backfill's render arrived (both patch guards false), and the frame painted the
 * empty build over 255 days per store of real data. Nothing heals it: the 60-second poll takes the
 * same patch branch, and in day view it is paused.
 *
 * The symptom is a blank all-Saturdays chart that never fills — indistinguishable from "still
 * loading", which is how it reaches Sky as "taking a long time to load".
 *
 * The fix is that the frame draws the LATEST build (_weeklyLatest) rather than its own closure.
 * What makes that assertable is the ORDER, not the value: this suite mounts with one dataset and
 * delivers another BEFORE releasing the frame, so a build that reads its closure paints the first
 * and a build that reads the latest paints the second. Run against the commit before the fix, the
 * frame paints the empty mount-time build — which is the bug, exactly.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const eq = (m, got, want) => {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) { pass++; console.log('  PASS ' + m); }
  else      { fail++; console.log('  FAIL ' + m + '  — got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want)); }
};

/* ── 1. the wiring, read off the shipped source ───────────────────────────────────────────────── */
console.log('\n1. the mount frame does not draw its own closure');
{
  const raf = /requestAnimationFrame\(\(\) => \{ drawWeekChart\((\w+)\);/.exec(HTML);
  ok('the mount still schedules the draw in a frame', !!raf);
  eq('...and the frame draws the latest build, not the one it was scheduled with',
     raf && raf[1], '_weeklyLatest');
  ok('_weeklyLatest is declared', /\blet _weeklyLatest\b/.test(HTML));
  ok('...and assigned every time renderIncome builds the chart data',
     /_weeklyLatest\s*=\s*weekly;/.test(HTML));
}

/* ── 2. the order it actually protects, executed ──────────────────────────────────────────────── */
console.log('\n2. a render that lands before the frame still reaches the chart');
{
  /* A miniature of the real control flow: mount schedules a frame, a later render arrives while the
   * chart instances still do not exist, then the frame finally runs. `latestWired` is whether the
   * shipped source reads _weeklyLatest in that frame — so this replays the REAL decision rather
   * than a hand-written copy of it. */
  function replay(frameReadsLatest) {
    let charts = {};
    let _weeklyLatest = null;
    let pendingFrame = null;
    const rAF = fn => { pendingFrame = fn; };
    const drawWeekChart = w => { charts.week = { data: w }; charts.dskWeek = { data: w }; };

    const renderIncome = (weekly, fullMount) => {
      _weeklyLatest = weekly;
      if (fullMount) {
        charts = {};                       // the mount replaces #main-content
        const closure = weekly;
        rAF(() => drawWeekChart(frameReadsLatest ? _weeklyLatest : closure));
      } else {
        if (charts.week)    charts.week.data    = weekly;
        if (charts.dskWeek) charts.dskWeek.data = weekly;
      }
    };

    renderIncome('mount: current month only', true);   // t=2s, tab goes to the background here
    const atMount = Object.keys(charts).length;
    renderIncome('backfill: the whole year', false);   // t=7s, the backfill lands
    const atBackfill = Object.keys(charts).length;
    pendingFrame();                                    // the reader looks back at the phone
    return { atMount, atBackfill, painted: charts.dskWeek.data };
  }

  const frameReadsLatest = /requestAnimationFrame\(\(\) => \{ drawWeekChart\(_weeklyLatest\);/.test(HTML);
  const r = replay(frameReadsLatest);

  eq('no chart instance exists at mount — this is the gap', r.atMount, 0);
  eq('...and still none when the backfill render arrives, so both patch guards are false', r.atBackfill, 0);
  eq('the frame paints the backfill data, not the mount data', r.painted, 'backfill: the whole year');
}

/* ── 3. the ordinary path is unchanged ────────────────────────────────────────────────────────── */
console.log('\n3. when the frame runs on time, nothing about the behavior moves');
{
  let charts = {}, _weeklyLatest = null, pending = null;
  const draw = w => { charts.week = { data: w }; charts.dskWeek = { data: w }; };
  const mount = w => { _weeklyLatest = w; charts = {}; pending = () => draw(_weeklyLatest); };
  const patch = w => { _weeklyLatest = w; if (charts.week) charts.week.data = w; if (charts.dskWeek) charts.dskWeek.data = w; };

  mount('A'); pending();                 // visible tab: the frame runs immediately
  eq('the mount paints its own data', charts.dskWeek.data, 'A');
  patch('B');
  eq('and a later render patches the live instance as before', charts.dskWeek.data, 'B');
}

/* ── 4. the patch branch is NOT given a re-create fallback ────────────────────────────────────── */
console.log('\n4. the gap is closed by the frame, not by a second creator racing it');
{
  // Two code paths creating Chart instances for the same canvas is how you get an orphaned chart
  // holding the canvas — drawWeekChart destroys the instances it knows about, and one created
  // behind a patch-branch guard would not be among them on the next mount.
  const callers = (HTML.match(/\bdrawWeekChart\(/g) || []).length;
  eq('drawWeekChart has exactly one definition and one caller', callers, 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
