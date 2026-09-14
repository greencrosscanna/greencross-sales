#!/usr/bin/env node
/* THE STRETCH IS PART OF THE GOAL — Sales and Leaderboard must measure against the same number.
 *
 * Reported by Sky 2026-09-07, looking at two screens at once: Leaderboard said +398.96 ahead of
 * pace, Sales said +470 over pace. Same six stores, same moment.
 *
 * It was NOT the pacing fraction. Both apps compute that identically — verified live that day against
 * GX Core's own curve to five decimal places. It was the GOAL underneath it. The period_goals ledger
 * carries a `stretch` per row, the growth target sitting on top of the trend. Leaderboard applies it
 * (`goal = trend x (1 + stretch)`); Sales returned dow_targets raw and summed them raw. So Sales
 * measured against $21,785 where the kiosk measured against $21,975, and a lower bar reads as further
 * ahead. $53 of the $71 gap was exactly that; the rest was Sales holding its fraction for 5 minutes.
 *
 * Sky's call: Sales adopts the stretch. The kiosk is what staff watch all day.
 *
 * WHAT THESE PROTECT:
 *   1. THE PER-ROW STRETCH, NEVER A CONSTANT — because MANUAL goals carry stretch 0. Leaderboard's
 *      resolveEffectiveGoal_ returns `stretch: 0` whenever a manual override is in play: the number
 *      Sky typed into the Settings tab IS the target, and a growth multiplier on top would override
 *      his choice. On the day, that was Portland Rd (`source=manual, period_total=41500`), whose
 *      unrounded targets are that 41,500 spread across the period. Any store hand-set tomorrow lands
 *      here the same way, so a hardcoded 1% would inflate every manual goal in the suite.
 *   2. THE SAME ROUNDING as Leaderboard. Two dashboards that disagree by a rounding mode still
 *      disagree on screen, and "why is it a dollar out" costs the same attention as fifty.
 *   3. THE STRETCH IS APPLIED AT THE READ, EXACTLY ONCE. pgLoadPeriod_ feeds both the range route and
 *      the client, so it stretches there and the raw ledger figure never leaves it. The first cut did
 *      it at the consumer and dropped `stretch` from the loader's payload, which made the multiply
 *      read undefined and change nothing — the fix would have looked applied while the numbers stayed
 *      raw. §3 also asserts attainProbe_ does NOT stretch again, because that is the mirror-image
 *      failure and a comment is not a constraint.
 *   4. THE REAL NUMBERS FROM THE INCIDENT. Anchored to production values, so a future change that
 *      re-breaks this fails against the case that was actually observed rather than a synthetic one.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(GS);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = GS.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < GS.length; j++) {
    if (GS[j] === '{') depth++;
    else if (GS[j] === '}') { depth--; if (!depth) break; }
  }
  return GS.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

/* The six rows exactly as the ledger held them on 2026-09-07, and the goals Leaderboard displayed
   from them. dow_targets[1] is the Monday column (the range route indexes with getUTCDay(), 0=Sun). */
const LEDGER = {
  baseline:   { dow: 2936,    stretch: 0.01, lbShowed: 2965 },
  center:     { dow: 1591,    stretch: 0.01, lbShowed: 1607 },
  century:    { dow: 4514,    stretch: 0.01, lbShowed: 4559 },
  commercial: { dow: 5868,    stretch: 0.01, lbShowed: 5927 },
  portland:   { dow: 2798.42, stretch: 0,    lbShowed: 2798 },   // source=manual → stretch 0
  river:      { dow: 4078,    stretch: 0.01, lbShowed: 4119 },
};

function ctxWith(fns, extra) {
  const ctx = Object.assign({ console, jsonOut_: o => o }, extra || {});
  vm.createContext(ctx);
  fns.forEach(n => vm.runInContext(grab(n), ctx));
  return ctx;
}

console.log('\n1. the stretch is applied per row, and rounded like Leaderboard');
{
  const ctx = ctxWith(['pgStretchDaily_', 'pgStretchTargets_']);
  let matched = 0;
  for (const [store, r] of Object.entries(LEDGER)) {
    const got = ctx.pgStretchDaily_(r.dow, r.stretch);
    if (got === r.lbShowed) matched++;
    else console.log(`       ${store}: got ${got}, Leaderboard showed ${r.lbShowed}`);
  }
  ok(`all six stores now match the goal Leaderboard displayed (${matched}/6)`, matched === 6);

  // The one that a hardcoded 1% would break: every hand-set goal in the suite.
  ok('a stretch of 0 leaves the target alone — a MANUAL goal is already the chosen number',
     ctx.pgStretchDaily_(2798.42, 0) === 2798);
  ok('and a missing stretch is treated as none, not as a default',
     ctx.pgStretchDaily_(1000, null) === 1000 && ctx.pgStretchDaily_(1000, undefined) === 1000);
  ok('a non-numeric target does not become NaN on a dashboard', ctx.pgStretchDaily_('x', 0.01) === 0);
  ok('the whole week is stretched, not just today',
     JSON.stringify(ctx.pgStretchTargets_([100, 200, 300, 400, 500, 600, 700], 0.01))
       === JSON.stringify([101, 202, 303, 404, 505, 606, 707]));
  ok('a non-array is handed back untouched rather than throwing',
     ctx.pgStretchTargets_(null, 0.01) === null);
}

console.log('\n2. the single-date route returns stretched targets');
{
  const rows = {
    Bend:          { period_start: 'a', period_end: 'b', period_total: 45140, dow_targets: [1, 4514, 1, 1, 1, 1, 1], stretch: 0.01 },
    'Portland Rd': { period_start: 'a', period_end: 'b', period_total: 27984, dow_targets: [1, 2798.42, 1, 1, 1, 1, 1], stretch: 0 },
  };
  const ctx = ctxWith(['pgStretchDaily_', 'pgStretchTargets_', 'getPeriodGoalsForDate_'], {
    salesStores_: () => [{core:'bend',dutchie:'Bend',sales:'Bend'},{core:'center',dutchie:'Center',sales:'Center'},{core:'commercial',dutchie:'Commercial',sales:'Commercial'},{core:'hillsboro',dutchie:'Hillsboro',sales:'Hillsboro'},{core:'portland-rd',dutchie:'Portland Rd',sales:'Portland Rd'},{core:'river-rd',dutchie:'River Rd',sales:'River'}],
    GXCore: { getPeriodGoals: (dutchie) => rows[dutchie === 'River Rd' ? 'River' : dutchie] || null },
  });
  const out = ctx.getPeriodGoalsForDate_('2026-09-07');
  ok('the route still answers ok', out.ok === true);
  ok('a stretched store comes back stretched', out.goals.Bend.dow_targets[1] === 4559);
  ok('the period total is stretched too, the same way',
     out.goals.Bend.period_total === Math.round(45140 * 1.01));
  ok('a zero-stretch store is unchanged', out.goals['Portland Rd'].dow_targets[1] === 2798);
  ok('and `stretch` rides along so a reader can see WHY a target differs from the raw ledger',
     out.goals.Bend.stretch === 0.01 && out.goals['Portland Rd'].stretch === 0);
}

console.log('\n3. the loader stretches at the READ — both paths, applied exactly once');
{
  /* pgLoadPeriod_ feeds the range route AND the client, so the stretch is applied HERE, where the
     ledger is read, and the raw figure never leaves. The first cut applied it at the consumer
     instead and dropped `stretch` from this payload, which made the multiply read undefined and
     change nothing — the fix would have looked applied while the numbers stayed raw. Doing it at the
     read also removes the double-apply the moment a third consumer appears. Both paths are
     exercised, because only one runs on a given call. */
  const picked = [{ store_id: 'bend', period_start: 'a', period_end: 'b', period_total: 1,
                    dow_targets: [1, 4514, 1, 1, 1, 1, 1], stretch: 0.01 }];
  const byId = { bend: 'Bend' };

  const fast = ctxWith(['pgStretchDaily_', 'pgStretchTargets_', 'pgLoadPeriod_'], {
    salesStores_: () => [{ core: 'bend', dutchie: 'Bend', sales: 'Bend' }],
    GXCore: { getPeriodGoals: () => ({ picked }) },
  });
  const a = fast.pgLoadPeriod_('2026-09-07', byId);
  ok('the batched path returns STRETCHED targets', a.goals.Bend && a.goals.Bend.dow_targets[1] === 4559);
  ok('and keeps stretch alongside them, for visibility only', a.goals.Bend.stretch === 0.01);

  const slow = ctxWith(['pgStretchDaily_', 'pgStretchTargets_', 'pgLoadPeriod_'], {
    salesStores_: () => [{ core: 'bend', dutchie: 'Bend', sales: 'Bend' }],
    GXCore: { getPeriodGoals: (store) => (store === '' ? { picked: null }
              : { period_start: 'a', period_end: 'b', period_total: 1,
                  dow_targets: [1, 4514, 1, 1, 1, 1, 1], stretch: 0.01 }) },
  });
  const b = slow.pgLoadPeriod_('2026-09-07', byId);
  ok('the per-store fallback path stretches too', b.goals.Bend && b.goals.Bend.dow_targets[1] === 4559);
  ok('and it also keeps stretch', b.goals.Bend.stretch === 0.01);

  /* THE DOUBLE-APPLY GUARD. attainProbe_ consumes these targets; if it multiplied by g.stretch as
     well, 4514 would become 4605 instead of 4559. Read the shipped source and require that it does
     not — a comment is not a constraint. */
  const probe = require('fs').readFileSync(require('path').join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
  const body = probe.slice(probe.indexOf('function attainProbe_'), probe.indexOf('function attainProbe_') + 6000);
  ok('attainProbe_ does not stretch again on top of the loader',
     !/pgStretchDaily_\(g\.dow_targets/.test(body));
}

console.log('\n4. the incident itself, end to end');
{
  /* The numbers Sky saw. With every store stretched by its own row, Sales’ pace target lands on
     Leaderboard’s to the dollar, and the $53 of the $71 gap that came from the goal is gone. The
     remainder was Sales holding its fraction for up to five minutes, which is a different fix. */
  const ctx = ctxWith(['pgStretchDaily_']);
  const FRAC = { baseline: 0.2621, center: 0.2838, century: 0.2469,
                 commercial: 0.2841, portland: 0.2251, river: 0.3061 };
  let before = 0, after = 0, lb = 0;
  for (const [store, r] of Object.entries(LEDGER)) {
    before += r.dow * FRAC[store];
    after  += ctx.pgStretchDaily_(r.dow, r.stretch) * FRAC[store];
    lb     += r.lbShowed * FRAC[store];
  }
  ok(`Sales' pace target now equals Leaderboard's (${after.toFixed(2)} vs ${lb.toFixed(2)})`,
     Math.abs(after - lb) < 0.5);
  ok(`and it moved by the ~$53 the goal gap accounted for (${(after - before).toFixed(2)})`,
     Math.abs((after - before) - 52.56) < 1);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
