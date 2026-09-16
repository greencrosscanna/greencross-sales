#!/usr/bin/env node
/* THE OVERNIGHT PAUSE MUST NOT OUTLAST A FAILED LOAD.
 *
 * MEASURED on Sky's phone 2026-09-15 at 23:36, Safari Web Inspector attached: five of six stores
 * logged `today pending: timed out after 25000ms` — River, Hillsboro, Portland Rd, Commercial,
 * Bend — and Center did not, which is exactly the "only Center has loaded" he reported. Every
 * store was in liveData (the settled halves landed), _loadAllStoresInFlight was false and the
 * poll timer was alive, so from the inside nothing was wrong. The landing view is TODAY, so the
 * five stores with no today figure shimmered.
 *
 * The 60-second poll that recovers exactly that sleeps from 22:15 to 08:00. It ticked every
 * minute, hit the quiet gate and returned: six minutes of dead dashboard over an empty network
 * panel, and it would have held until morning.
 *
 * So the gate now skips a tick only when there is nothing incomplete to recover, capped so an
 * unreachable store cannot be hammered until dawn.
 *
 * EXECUTES the shipped scheduleAutoRefresh tick and the shipped quietRecoveryNeeded_ /
 * storeNotCurrent_ out of index.html — never a copy. Mutation-verified; see the footer.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
// ok(MESSAGE, CONDITION) — that order, deliberately. This repo has shipped a test written
// ok(cond, label) into a file whose ok is ok(label, cond); it passed unconditionally against a
// source broken on purpose. Keep the argument order in mind when adding an assertion here.
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

/* The cap is read OUT OF THE SOURCE, never retyped. A copy here is a second hand-maintained
   number that agrees with the app right up until someone tunes one of them. */
const capM = HTML.match(/const\s+QUIET_RECOVERY_MAX_\s*=\s*(\d+)\s*;/);
if (!capM) { console.log('  FAIL QUIET_RECOVERY_MAX_ not found in index.html'); process.exit(1); }
const CAP = Number(capM[1]);

/* Build a context holding the real tick plus the minimum around it. Everything the gate decides on
   is a knob here (quiet, incomplete, hidden, in-flight); everything it calls is counted. */
function mk(opts) {
  const o = Object.assign({ quiet: true, incomplete: true, hidden: false, inFlight: false, day: null }, opts);
  const now = new Date();
  const ctx = {
    console,
    Date,
    AUTO_REFRESH_MS: 60000,
    _autoRefreshTimer: null,
    _quietRecoveryTries: 0,
    QUIET_RECOVERY_MAX_: CAP,
    activeYear: now.getFullYear(),
    activeMonth: now.getMonth() + 1,
    activeDay: o.day,
    document: { get hidden() { return o.hidden; } },
    get _loadAllStoresInFlight() { return o.inFlight; },
    clearAutoRefresh() {},
    toDateStr: d => d.toISOString().slice(0, 10),
    inQuietHours: () => o.quiet,
    quietRecoveryNeeded_: () => o.incomplete,
    fetches: 0,
    paused: 0,
    refreshLiveData() { ctx.fetches++; },
    paintQuietPill() { ctx.paused++; },
    setInterval(fn) { ctx.tick = fn; return 1; },
  };
  vm.createContext(ctx);
  vm.runInContext(grab('scheduleAutoRefresh'), ctx);
  vm.runInContext('scheduleAutoRefresh();', ctx);
  ctx.opts = o;
  return ctx;
}

console.log('\n1. the bug: a quiet-hours tick with work outstanding must FETCH');
{
  const c = mk({ quiet: true, incomplete: true });
  ok('the tick was installed', typeof c.tick === 'function');
  c.tick();
  ok('an incomplete store during quiet hours triggers a refresh', c.fetches === 1);
  ok('...and it does not paint the paused pill instead', c.paused === 0);
}

console.log('\n2. the pause it must NOT break: nothing outstanding stays asleep');
{
  const c = mk({ quiet: true, incomplete: false });
  c.tick(); c.tick(); c.tick();
  ok('a complete dashboard never fetches during quiet hours', c.fetches === 0);
  ok('...and says so on the pill every tick', c.paused === 3);
}

console.log('\n3. recovery is CAPPED — an unreachable store is not hammered until dawn');
{
  const c = mk({ quiet: true, incomplete: true });
  for (let i = 0; i < CAP + 25; i++) c.tick();
  ok('it retries exactly QUIET_RECOVERY_MAX_ (' + CAP + ') times', c.fetches === CAP);
  ok('...then falls back to the paused pill', c.paused === 25);
  ok('...and the counter stops at the cap', c._quietRecoveryTries === CAP);
}

console.log('\n4. the cap SELF-LIMITS the moment the load succeeds');
{
  const c = mk({ quiet: true, incomplete: true });
  c.tick(); c.tick();                 // two recovery attempts
  ok('two attempts spent', c.fetches === 2 && c._quietRecoveryTries === 2);
  c.opts.incomplete = false;          // the retry worked
  c.tick();
  ok('a complete dashboard stops fetching at once', c.fetches === 2);
  ok('...and hands the whole allowance back', c._quietRecoveryTries === 0);
  c.opts.incomplete = true;           // a later store falls over
  for (let i = 0; i < CAP; i++) c.tick();
  ok('...so a fresh failure gets a fresh allowance', c.fetches === 2 + CAP);
}

console.log('\n5. daytime is untouched, and it resets the allowance');
{
  const c = mk({ quiet: false, incomplete: false });
  c.tick(); c.tick();
  ok('outside quiet hours the poll fetches as it always did', c.fetches === 2);
  ok('...and never paints the paused pill', c.paused === 0);

  const d = mk({ quiet: true, incomplete: true });
  for (let i = 0; i < CAP; i++) d.tick();
  ok('allowance spent overnight', d._quietRecoveryTries === CAP && d.fetches === CAP);
  d.opts.quiet = false;
  d.tick();
  ok('...the next morning clears it', d._quietRecoveryTries === 0);
  ok('...and that tick fetched', d.fetches === CAP + 1);
}

console.log('\n6. the gates ABOVE the quiet check still win');
{
  const a = mk({ inFlight: true, quiet: true, incomplete: true });
  a.tick();
  ok('a load already running blocks the recovery tick', a.fetches === 0 && a.paused === 0);

  const b = mk({ hidden: true, quiet: true, incomplete: true });
  b.tick();
  ok('a backgrounded tab blocks it', b.fetches === 0 && b.paused === 0);

  const h = mk({ quiet: true, incomplete: true, day: '2001-01-01' });
  h.tick();
  ok('a historical day stays static', h.fetches === 0 && h.paused === 0);
}

console.log('\n7. "incomplete" is storeNotCurrent_ — ONE definition, not a second one');
{
  const src = grab('quietRecoveryNeeded_');
  ok('quietRecoveryNeeded_ delegates to storeNotCurrent_', /storeNotCurrent_\s*\(/.test(src));
  // The hazard is a parallel rule that drifts: a row blinking "not current" while the poll has
  // independently decided all is well. Re-deriving pending-ness here is exactly that.
  ok('...and does not re-derive pending-ness itself', !/_todayPending|liveData/.test(src));

  // EXECUTE it against the real predicate, on the shape actually measured on the phone.
  const ctx = {
    STORES: ['River', 'Center', 'Bend', 'Hillsboro', 'Commercial', 'Portland Rd'].map(n => ({ name: n })),
    _storeStateMap: {},
    _todayPending: new Set(),
    periodRange: () => ({ from: new Date('2026-09-15T00:00:00Z'), to: new Date('2026-09-15T00:00:00Z') }),
    laDay: () => '2026-09-15',
    toDateStr: d => d.toISOString().slice(0, 10),
  };
  vm.createContext(ctx);
  vm.runInContext(grab('viewIncludesToday_'), ctx);
  vm.runInContext(grab('storeNotCurrent_'), ctx);
  vm.runInContext(grab('quietRecoveryNeeded_'), ctx);

  ok('all six current → nothing to recover', vm.runInContext('quietRecoveryNeeded_()', ctx) === false);

  // The measured state: five stores today-pending, Center fine.
  ['River', 'Hillsboro', 'Portland Rd', 'Commercial', 'Bend'].forEach(n => ctx._todayPending.add(n));
  ok("Sky's actual 23:36 state IS recoverable", vm.runInContext('quietRecoveryNeeded_()', ctx) === true);

  ctx._todayPending.clear();
  ctx._storeStateMap = { Bend: 'err' };
  ok('a store whose fetch errored counts as incomplete', vm.runInContext('quietRecoveryNeeded_()', ctx) === true);

  ctx._storeStateMap = {};
  ctx._todayPending.add('Bend');
  ctx.periodRange = () => ({ from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-08-31T00:00:00Z') });
  ok('a today-pending store does NOT count while viewing another month',
     vm.runInContext('quietRecoveryNeeded_()', ctx) === false);
}

console.log('\n8. the quiet window itself is unchanged');
{
  const ctx = { THRESHOLDS: { QUIET_START_HOUR: 22.25, STORE_OPEN_HOUR: 8 } };
  vm.createContext(ctx);
  vm.runInContext(grab('inQuietHours'), ctx);
  const at = (h, m) => { const d = new Date(2026, 8, 15, h, m || 0); return vm.runInContext('inQuietHours', ctx)(d); };
  ok('23:36 — the measured moment — is quiet', at(23, 36) === true);
  ok('22:14 is not yet', at(22, 14) === false);
  ok('22:16 is', at(22, 16) === true);
  ok('07:59 still is', at(7, 59) === true);
  ok('08:00 is not', at(8, 0) === false);
  ok('midday is not', at(12, 0) === false);
}

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed\n');

/* MUTATION-VERIFIED against index.html — counts below are MEASURED, not predicted. Each reverts a
   distinct guard and must fail the named assertions, not merely "something":
     1. quiet gate reverted to `if (inQuietHours()) { paintQuietPill(); return; }`  → 10 fail
          The original bug. §1 both, §3 all three, §4 three, §5 two. §2 STILL PASSES, which is the
          assertion that matters here: the mutation restores the old behavior, and the overnight
          pause this fix had to preserve is provably still preserved.
     2. the cap check deleted                                                      → 3 fail
          §3 all three, and nothing else moves.
     3. `_quietRecoveryTries = 0` dropped from the complete branch                 → 2 fail
          §4 "hands the whole allowance back" and "fresh allowance".
     4. the daytime `else` reset dropped                                           → 1 fail
          §5 "the next morning clears it".
     5. quietRecoveryNeeded_ tests _todayPending directly instead of delegating    → 4 fail
          §7 both source assertions, plus "a store whose fetch errored" and the other-month case —
          the two that show the delegation is load-bearing rather than stylistic.
     6. storeNotCurrent_'s viewIncludesToday_ conjunct removed                     → 1 fail
          §7 "does NOT count while viewing another month" alone. */
process.exit(fail ? 1 : 0);
