#!/usr/bin/env node
/* THE LAST GOOD COPY IS ON DISK AND THE SCREEN SAYS SOMETHING CONFIDENT INSTEAD.
 *
 * readCache returns null the instant an entry passes its TTL and — unlike Inventory's cacheGet —
 * deliberately does NOT delete it. So for every non-history key the bytes survive, unread, while a
 * failed re-fetch leaves the caller with nothing. Two callers turn that nothing into a statement:
 *
 *   expbudgets — fetched once per session on first entry to the Expenses tab, over the slowest
 *     route in the app (8.8s, measured 2026-09-06), through a bare fetch with no ceiling. Miss it
 *     and every category's budget is 0: `expected to date` is `—` everywhere, the off-pace tile
 *     reads `0 of N`, and the rail announces "Nothing is running ahead of its budget." over no data
 *     at all — the Inventory tile's green 0. The desktop said "No budget set for this period",
 *     which is a VERDICT on a question nobody answered, and the PHONE said nothing whatsoever: the
 *     bar and its sub-line simply vanish and the tab renders as a budget-free view of spend.
 *   otherrev — the Income hero computes `net = dutchieNet + otherRevTotal`, and computeOtherRev
 *     returns 0 for a payload that never arrived exactly as it does for a month that took nothing.
 *     So the company figure went short the ATM take under a confident live dot, and the section
 *     that would have shown the missing rows returned '' instead. The River shape.
 *
 * This suite EXECUTES the shipped readCache / readStaleCache / fmtCacheAgo_ / loadExpBudgets /
 * loadOtherRevenue / expBudgetOrigin_ / _expKpis / renderExpenses / renderExpensesMobile /
 * computeOtherRev / _incomeOtherRevHtml out of index.html against a scripted clock, a counting
 * localStorage and a scripted transport. Nothing here restates the logic.
 *
 * WHAT FIXTURE MAKES EACH ASSERTION FAIL (asked of every one, per the hub's rule):
 *
 *   §1 the helper
 *   - "readCache still refuses a stale entry"      fails if the TTL is relaxed instead of a second
 *                                                  tier added. Fixture: a 25h expbudgets entry.
 *   - "readStaleCache returns it"                  fails at HEAD — the function does not exist.
 *   - "the age is the ENTRY'S, not the clock"      fails on any age taken at the moment the failure
 *                                                  was noticed. Fixture: a 60-minute-old entry read
 *                                                  after 61s of retry ladder — the bug Leaderboard
 *                                                  shipped as "1 min ago" on an hour-old board.
 *   - "past the paint ceiling it is refused"       fails if there is no ceiling: fixture is 72h+1m.
 *   - "a backwards clock is not a fresh entry"     fails on a bare `Date.now() - ts` with no floor:
 *                                                  fixture writes ts one hour in the FUTURE, which
 *                                                  reads as "just now" on an arbitrarily old value.
 *   - "it never deletes"                           fails on Inventory's shape. Fixture: read an
 *                                                  entry past the ceiling, then count removeItem.
 *   - "fmtCacheAgo_ never says 0"                  fails on Math.round/bare division: 59s would
 *                                                  print "0 min ago", which reads as live.
 *
 *   §2 expbudgets
 *   - "a failed fetch serves the cached budgets"   fails at HEAD, which sets expBudgets = null.
 *   - "...and records its age"                     fails if the fallback is a boolean.
 *   - "...and overlaid/bills_once come with it"    fails on a hand-repacked object literal that
 *                                                  loses a field — the screenshot bug's shape.
 *   - "origin says stale and names the age"        fails at HEAD — expBudgetOrigin_ does not exist.
 *   - "the desktop tile prints the age"            fails if the caption is left off the hero.
 *   - "no entry at all is NOT 'no budget set'"     fails at HEAD, which prints that verdict.
 *   - "a load in flight is neither verdict"        fails if the state is derived from expBudgets
 *                                                  alone: during boot that is null and innocent.
 *   - "the rail's all-clear is withheld"           fails at HEAD — the literal is unconditional.
 *   - "the phone says it too"                      fails at HEAD, which renders nothing at all.
 *   - "an Apply cannot be undone by the fallback"  fails if the stale read ignores that the Apply
 *                                                  path removes the entry: the fixture applies,
 *                                                  then fails the refetch, and a resurrected
 *                                                  pre-apply budget would be a WRONG number
 *                                                  labeled merely old.
 *   - "a healthy load carries no age"              fails if the age flag is not cleared on success —
 *                                                  a permanent "cached copy" caption is a lie in
 *                                                  the other direction.
 *
 *   §3 otherrev
 *   - "a failed fetch keeps ATM in net"            fails at HEAD: computeOtherRev returns 0 and the
 *                                                  hero total is short by the whole ATM take.
 *   - "the section prints the age"                 fails if the rows are restored unlabeled — a
 *                                                  stale number shown as live is the one outcome
 *                                                  this whole change exists to prevent.
 *   - "nothing cached, asked and answered: say so" fails at HEAD, which returns '' and leaves the
 *                                                  hero short with no marker anywhere.
 *   - "nothing cached, NOT yet asked: say nothing" fails if the notice is gated on !otherRevData
 *                                                  instead of on otherRevTried — every cold boot
 *                                                  would then accuse a load still in flight.
 *   - "a successful load carries no age"           fails if otherRevAgeMs is not cleared.
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
/* A subject that does not exist yet must REPORT, not kill the run: proving this gate against the
   bug means running it at the commit BEFORE the fix, where half these names are absent. A suite
   that throws on the first one prints a stack trace where you need the list. */
function grabOr(name) {
  try { return grab(name); } catch (e) { missing.push(name); return 'function ' + name + '(){ throw new Error("' + name + ' is not in index.html"); }'; }
}
const missing = [];

/* Read as TEXT, not grabbed: if the constant is gone the behavior assertions below still run, with
   no ceiling, and fail the way an unbounded stale read actually fails. */
const mCap = /\n(?:const|var)\s+CACHE_STALE_MAX\s*=\s*([^;]+);/.exec(HTML);
const CAP  = mCap ? Function('return (' + mCap[1] + ')')() : Infinity;

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '\n       ' + detail : '')); }
}
function section(title, body) {
  console.log('\n' + title);
  try { body(); }
  catch (e) { fail++; console.log('  FAIL the section could not run at all\n       ' + String((e && e.message) || e)); }
}
/* AWAITED, ONE AT A TIME. Fired off in parallel these print their results after the summary — or,
   if one never settles, not at all, which is indistinguishable from a clean pass. */
async function asection(title, body) {
  console.log('\n' + title);
  try { await body(); }
  catch (e) { fail++; console.log('  FAIL the section could not run at all\n       ' + String((e && e.message) || e)); }
}
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

const HOUR = 3600000, MIN = 60000;

/* ── the scripted world ───────────────────────────────────────────────────────────────────────── */
function makeWorld() {
  const store = Object.create(null);
  let removed = [];
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { removed.push(k); delete store[k]; },
  };
  // Object.keys(localStorage) is how clearAllCache and the sweeps enumerate; mirror that by making
  // the backing object itself enumerable through a Proxy-free shim the shipped code never uses here.
  const w = {
    _store: store,
    _removed: removed,
    clock: Date.parse('2026-09-16T09:30:00Z'),
    fetches: [],
    console: { log() {}, warn() {}, error() {} },
    localStorage,
    MONTHS: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    MONTH_YTD: 0,
    SESSION_MEM_KEYS: new Set(['costs', 'velocity']),
    sessionMemCache: {},
    CACHE_TTL: { expbudgets: 24 * HOUR, otherrev: 24 * HOUR, goals: 24 * HOUR },
    // Declared in index.html outside any function, so it has to be put into the context; the VALUE
    // is the shipped one, read out of the source above, never a number typed here.
    CACHE_STALE_MAX: CAP,
    getPeriodLabel: () => 'Sep 2026',
    getProxyUrl: () => 'https://proxy.invalid/exec',
    getToken: () => 'tok',
    encodeURIComponent,
    JSON, Math, Object, Set, Array, String, Number, Boolean, isFinite, parseInt, parseFloat,
    requestAnimationFrame: () => {},
    // state the shipped loaders own
    expBudgets: null, expBudgetsOverlaid: new Set(), expBillsOnce: new Set(), expBudgetsAgeMs: null,
    otherRevData: null, otherRevAgeMs: null, otherRevTried: false,
    hiddenOtherRevs: new Set(),
    activeDay: null, activeWeek: null, activeMonth: 9, activeYear: 2026,
    _expBudgetsTried: false, _expBudgetsLoading: false,
  };
  w.Date = function FakeDate(a) { return arguments.length ? new Date(a) : new Date(w.clock); };
  w.Date.now = () => w.clock;
  w.Date.parse = Date.parse;
  w.Date.UTC = Date.UTC;
  w.globalThis = w;
  return w;
}

const SRC = [
  grabOr('readCache'), grabOr('writeCache'), grabOr('readStaleCache'), grabOr('fmtCacheAgo_'),
  grabOr('applyExpBudgets_'), grabOr('loadExpBudgets'), grabOr('expBudgetOrigin_'),
  grabOr('loadOtherRevenue'), grabOr('computeOtherRev'), grabOr('_incomeOtherRevHtml'),
  grabOr('_expKpis'), grabOr('escHtml'), grabOr('fmtK'), grabOr('fmtSigned'),
].join('\n');

function boot(w) {
  const ctx = vm.createContext(w);
  vm.runInContext(SRC, ctx);
  return ctx;
}

/* Seed a cache entry AS writeCache writes it, at a chosen age. Written through the real shape, not
   a hand-built one, so a change to the envelope breaks this loudly rather than silently. */
function seed(w, key, data, ageMs) {
  w.localStorage.setItem('gc_cache_' + key, JSON.stringify({ data, ts: w.clock - ageMs }));
}

const BUDGETS = {
  'Rent Expense':     { Jan: 62000, Sep: 62000 },
  'Payroll Expenses': { Jan: 240000, Sep: 251000 },
  'Advertising & Promotion': { Jan: 9000, Sep: 9000 },
};
const OTHERREV = { atm: { Aug: 9200, Sep: 9493 }, sublet: { Aug: 0, Sep: 1500 } };

/* ═══ §1 — the helper itself ═══════════════════════════════════════════════════════════════════ */
section('1. an expired entry is refused by readCache and still readable as STALE', () => {
  const w = makeWorld(); const c = boot(w);
  seed(w, 'expbudgets', { budgets: BUDGETS }, 25 * HOUR);

  ok('readCache still refuses it — the TTL is not relaxed', c.readCache('expbudgets') === null,
     'readCache returned an entry 25h past a 24h TTL; the fix must ADD a tier, not widen one');

  const s = c.readStaleCache('expbudgets');
  ok('readStaleCache returns it', !!s && !!s.data && !!s.data.budgets,
     'got ' + JSON.stringify(s) + ' — at HEAD this function does not exist');
  ok('...with the entry\'s own timestamp', !!s && s.ts === w.clock - 25 * HOUR,
     'ts=' + (s && s.ts));
  ok('...and an age derived from it', !!s && s.ageMs === 25 * HOUR, 'ageMs=' + (s && s.ageMs));
});

section('2. the age is the ENTRY\'S, never the clock at the moment of failure', () => {
  const w = makeWorld(); const c = boot(w);
  seed(w, 'otherrev', OTHERREV, 60 * MIN);
  // A retry ladder runs for 61 seconds before anyone gives up. An age measured HERE says "1 min".
  w.clock += 61000;
  const s = c.readStaleCache('otherrev');
  ok('an hour-old entry read after a 61s ladder reports ~61 min, not 1',
     !!s && Math.round(s.ageMs / MIN) === 61,
     'ageMs=' + (s && s.ageMs) + ' — this is exactly the "1 min ago" on an hour-old board');
  ok('and it renders as an hour, not a minute', c.fmtCacheAgo_(s.ageMs) === '1 hour ago',
     'got ' + c.fmtCacheAgo_(s.ageMs));
});

section('3. there is a ceiling, a floor, and no deletion', () => {
  const w = makeWorld(); const c = boot(w);
  ok('index.html declares CACHE_STALE_MAX', !!mCap, 'absent — a stale read with no ceiling is unbounded');
  /* `!!mCap &&`, not CAP alone: with the constant absent CAP is Infinity, which satisfies `>= 72h`
     and passes for the wrong reason — a check that cannot fail looks exactly like one that passed. */
  ok('the ceiling is above one long weekend away (72h)', !!mCap && CAP >= 72 * HOUR,
     'CACHE_STALE_MAX=' + CAP);

  seed(w, 'expbudgets', { budgets: BUDGETS }, CAP + MIN);
  ok('an entry past the ceiling is refused', c.readStaleCache('expbudgets') === null,
     'a days-old budget under a variance someone acts on is not worth the instant answer');
  ok('...and refusing it did NOT delete it', w._removed.length === 0 &&
     ('gc_cache_expbudgets' in w._store),
     'removed=' + JSON.stringify(w._removed) + ' — destroying the fallback on read is the Inventory bug');

  // A clock that moved backwards (device clock corrected, timezone change) writes a FUTURE ts.
  const w2 = makeWorld(); const c2 = boot(w2);
  seed(w2, 'otherrev', OTHERREV, -1 * HOUR);
  ok('a future timestamp is refused, not read as "just now"', c2.readStaleCache('otherrev') === null,
     'a backwards clock would otherwise put a live label on an arbitrarily old payload');
});

section('4. fmtCacheAgo_ never claims liveness it cannot support', () => {
  const w = makeWorld(); const c = boot(w);
  ok('59 seconds is "just now", never "0 min ago"', c.fmtCacheAgo_(59000) === 'just now',
     'got ' + c.fmtCacheAgo_(59000) + ' — "0 min ago" reads as a live figure');
  ok('90 minutes rounds DOWN to 1 hour', c.fmtCacheAgo_(90 * MIN) === '1 hour ago',
     'got ' + c.fmtCacheAgo_(90 * MIN));
  ok('25 hours is "1 day ago"', c.fmtCacheAgo_(25 * HOUR) === '1 day ago',
     'got ' + c.fmtCacheAgo_(25 * HOUR));
  ok('50 hours is "2 days ago"', c.fmtCacheAgo_(50 * HOUR) === '2 days ago',
     'got ' + c.fmtCacheAgo_(50 * HOUR));
});

/* ═══ §2 — the Expenses tab ════════════════════════════════════════════════════════════════════ */
function failingFetch() { return () => Promise.reject(new Error('Load failed')); }

async function runExpBudgets(opts) {
  const w = makeWorld();
  if (opts.seedAge != null) {
    seed(w, 'expbudgets', { budgets: BUDGETS, overlaid: ['Rent Expense'], bills_once: ['Rent Expense'] },
         opts.seedAge);
  }
  w.fetch = opts.fetch || failingFetch();
  const c = boot(w);
  await c.loadExpBudgets();
  return { w, c };
}

const S5 = () => asection('5. a failed budgets fetch serves the last good copy, labeled', async () => {
  {
    const { w, c } = await runExpBudgets({ seedAge: 25 * HOUR });
    ok('the budgets are on screen rather than null',
       !!w.expBudgets && w.expBudgets['Payroll Expenses'] &&
       w.expBudgets['Payroll Expenses'].Sep === 251000,
       'expBudgets=' + JSON.stringify(w.expBudgets) + ' — at HEAD this is null and every variance is —');
    ok('their age is recorded, in ms, off the entry', w.expBudgetsAgeMs === 25 * HOUR,
       'expBudgetsAgeMs=' + w.expBudgetsAgeMs);
    ok('the smart-budget badges come with them', w.expBudgetsOverlaid.has('Rent Expense'),
       'a hand-repacked literal loses a field every time the payload grows one');
    ok('the bills-once flags come with them', w.expBillsOnce.has('Rent Expense'),
       'dropping this silently starts pacing rent again and the tab looks identical');

    const o = c.expBudgetOrigin_();
    ok('the origin reads stale', o.state === 'stale', 'state=' + o.state);
    ok('...and its sentence names the age', /1 day ago/.test(o.text), 'text=' + o.text);

    const tile = c._expKpis(500000, 322000, 161000, 339000, 4000000, 0, 3, 0, 3, 50, () => 40);
    ok('the desktop hero prints it under the bar', /cached copy from 1 day ago/.test(tile),
       'a stale number shown as live is the one outcome this change exists to prevent');
  }
});

const S6 = () => asection('6. with nothing cached, "no budget set" is a verdict and is withheld', async () => {
  {
    const { w, c } = await runExpBudgets({ seedAge: null });
    ok('expBudgets is null, as before', w.expBudgets === null);
    const o = c.expBudgetOrigin_();
    ok('the origin reads missing, not ok', o.state === 'missing', 'state=' + o.state);
    const tile = c._expKpis(500000, 0, 0, 500000, 4000000, 0, 3, 0, 0, 50, () => 0);
    ok('the hero does NOT say "No budget set for this period"',
       !/No budget set for this period/.test(tile),
       'at HEAD it says exactly that — a verdict on a question nobody answered');
    ok('...it says the budgets did not load', /did not load/.test(tile), 'tile sub-line: ' + tile);
  }
});

section('7. a fetch still in flight is neither verdict', () => {
  const w = makeWorld(); const c = boot(w);
  w._expBudgetsLoading = true;   // ensureExpBudgets has fired; nothing has answered
  const o = c.expBudgetOrigin_();
  ok('the origin reads loading', o.state === 'loading', 'state=' + o.state +
     ' — derived from expBudgets alone, a cold boot accuses a load that is still running');
  const tile = c._expKpis(500000, 0, 0, 500000, 4000000, 0, 3, 0, 0, 50, () => 0);
  ok('the hero says neither "no budget set" nor "did not load"',
     !/No budget set for this period/.test(tile) && !/did not load/.test(tile), tile);
});

const S8 = () => asection('8. an Apply removes the entry, so the fallback cannot resurrect a superseded budget', async () => {
  const w = makeWorld();
  seed(w, 'expbudgets', { budgets: BUDGETS }, 25 * HOUR);
  // What applyBudget / revertBudget / the bills-once save all do before re-loading.
  w.localStorage.removeItem('gc_cache_expbudgets');
  w.expBudgets = null; w.expBudgetsAgeMs = null;
  w.fetch = failingFetch();
  const c = boot(w);
  await c.loadExpBudgets();
  ok('the pre-apply budget is NOT served back', w.expBudgets === null,
     'expBudgets=' + JSON.stringify(w.expBudgets) +
     ' — a superseded budget is a WRONG number, not merely an old one');
  ok('and it is reported as missing', c.expBudgetOrigin_().state === 'missing');
});

const S9 = () => asection('9. a healthy load carries no age and no caption', async () => {
  const ok200 = () => Promise.resolve({ json: () => Promise.resolve(
    { budgets: BUDGETS, overlaid: [], bills_once: [] }) });
  {
    const { w, c } = await runExpBudgets({ seedAge: null, fetch: ok200 });
    ok('the budgets landed', !!w.expBudgets && !!w.expBudgets['Rent Expense']);
    ok('no age is recorded', w.expBudgetsAgeMs == null, 'expBudgetsAgeMs=' + w.expBudgetsAgeMs);
    ok('the origin reads ok', c.expBudgetOrigin_().state === 'ok');
    const tile = c._expKpis(500000, 322000, 161000, 339000, 4000000, 1, 3, 17000, 2, 50, () => 40);
    ok('the hero carries no cached-copy caption', !/cached copy/.test(tile),
       'a permanent staleness caption is a lie in the other direction');
  }
});

section('10. the rail withholds its all-clear when there was nothing to compare', () => {
  /* Source-read, and deliberately: the rail is one expression inside renderExpenses, which paints
     through the DOM. What has to be true is that the reassuring sentence is REACHED only when a
     budget exists — so the assertion is that the literal is not emitted unconditionally. Verified
     by mutation: restoring the bare string fails this. */
  const render = grabOr('renderExpenses');
  const m = /Nothing is running ahead of its budget\./.exec(render);
  ok('the sentence is still in renderExpenses', !!m,
     'it should still be shown when a budget was actually there to beat');
  const around = m ? render.slice(Math.max(0, m.index - 400), m.index) : '';
  ok('...and it is guarded by expBudgetOrigin_', /expBudgetOrigin_\(\)/.test(around),
     'unconditional at HEAD — an empty list reads as an all-clear when every variance is null ' +
     'for want of a budget, which is the Inventory tile\'s green 0');
});

section('11. the PHONE says it too — it is the device every report comes from', () => {
  const m = /function renderExpensesMobile/.exec(HTML);
  ok('renderExpensesMobile still exists', !!m);
  const body = grabOr('renderExpensesMobile');
  ok('it reads the shared origin rather than a second sentence of its own',
     /expBudgetOrigin_\(\)/.test(body),
     'at HEAD the phone renders NOTHING when totalBudget is 0 — the bar and its sub-line just vanish');
  ok('and it renders that text', /budgetOrigin\.text/.test(body),
     'the phone reads the origin but never prints it — a state nobody is shown is not a state');
  ok('there is exactly ONE definition of the sentence', (HTML.match(/did not load — nothing on this tab/g) || []).length === 1,
     'two renderings by matchMedia, one definition, or they drift within a release');
});

/* ═══ §3 — the Income hero's other revenue ═════════════════════════════════════════════════════ */
async function runOtherRev(opts) {
  const w = makeWorld();
  if (opts.seedAge != null) seed(w, 'otherrev', OTHERREV, opts.seedAge);
  w.fetch = opts.fetch || failingFetch();
  const c = boot(w);
  await c.loadOtherRevenue();
  return { w, c };
}

const S12 = () => asection('12. a failed otherrev fetch keeps ATM and sublet IN the net figure', async () => {
  {
    const { w, c } = await runOtherRev({ seedAge: 30 * HOUR });
    ok('the payload is restored', !!w.otherRevData && !!w.otherRevData.atm);
    ok('computeOtherRev returns the real ATM take, not 0', c.computeOtherRev('atm') === 9493,
       'got ' + c.computeOtherRev('atm') + ' — at HEAD this is 0 and the hero total is short by it, ' +
       'under a confident live dot, with nothing on screen saying so');
    ok('the age is recorded off the entry', w.otherRevAgeMs === 30 * HOUR, 'otherRevAgeMs=' + w.otherRevAgeMs);
    const html = c._incomeOtherRevHtml();
    ok('the section renders the rows', /ATM/.test(html) && /Sublet/.test(html));
    ok('...and says how old they are', /Cached copy from 1 day ago/.test(html),
       'restoring them unlabeled would show a stale number as live');
  }
});

const S13 = () => asection('13. nothing cached — asked and answered means say so', async () => {
  {
    const { w, c } = await runOtherRev({ seedAge: null });
    ok('otherRevData is null', w.otherRevData === null);
    ok('the attempt is recorded', w.otherRevTried === true,
       'without this the hero cannot tell "did not load" from "not asked yet"');
    const html = c._incomeOtherRevHtml();
    ok('the section is rendered, not dropped', html !== '',
       'at HEAD it returns \'\' and the hero is silently short');
    ok('...and it says the figures are NOT in the total above', /not<\/b> included in the net sales/.test(html),
       'html=' + html.slice(0, 240));
  }
});

section('14. nothing cached and NOT yet asked — say nothing', () => {
  const w = makeWorld(); const c = boot(w);
  w.otherRevData = null; w.otherRevTried = false;   // the boot wave, still in flight
  ok('the section stays empty during a load', c._incomeOtherRevHtml() === '',
     'accusing a load that is still running is the "No data available" verdict again');
});

const S15 = () => asection('15. a healthy otherrev load carries no age', async () => {
  const ok200 = () => Promise.resolve({ json: () => Promise.resolve(OTHERREV) });
  {
    const { w, c } = await runOtherRev({ seedAge: null, fetch: ok200 });
    ok('the payload landed', !!w.otherRevData && w.otherRevData.atm.Sep === 9493);
    ok('no age is recorded', w.otherRevAgeMs == null, 'otherRevAgeMs=' + w.otherRevAgeMs);
    ok('the section carries no cached-copy line', !/Cached copy/.test(c._incomeOtherRevHtml()));
  }
});

(async () => {
  await S5(); await S6(); await S8(); await S9(); await S12(); await S13(); await S15();
  if (missing.length) console.log('\nabsent from index.html: ' + missing.join(', '));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  finished = true;
  if (fail) process.exitCode = 1;
})();
