#!/usr/bin/env node
/* AN ATM MONTH'S FIGURES ARE THE VENDOR'S REPORT. THE MONEY ARRIVES THREE OR MORE WEEKS LATER.
 *
 * Sky, 2026-09-21: "I get a report from the vendor, but then the payment follows 3+ weeks later,
 * and I want to make sure that just numbers populated into the app doesn't signify that it has
 * been paid. for example i just got paid for July, which prompted me to ask the vendor where
 * August's payment is."
 *
 * The app held every figure for July and August and could not distinguish reported from paid, so
 * the only record of an unpaid month was his memory of it. v2.613 adds the mark — a toggle, his
 * call, not an amount — and the year-wide outstanding line that is the part which would actually
 * have caught August.
 *
 * Three rules are load-bearing and each is a way this feature could be simplified into a lie:
 *
 *   1. UNPAID IS THE ABSENCE OF A MARK. Un-marking deletes rather than storing paid:false, so
 *      there is one representation of unpaid and no stale residue to disagree with it.
 *   2. A MONTH WITH NO FIGURES IS NOT OUTSTANDING. It is unreported, which is a different
 *      question. Listing every unpaid month would name all twelve in January.
 *   3. `paid=false` ARRIVES AS A STRING, AND 'false' IS TRUTHY. A truthy read of the query
 *      parameter would make "mark unpaid" mark paid — the failure would be silent and would
 *      write the opposite of what was clicked.
 *
 * Reads and EXECUTES the shipped dutchie_proxy.gs and index.html, not copies.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const GS   = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  PASS ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

/** Pull a named top-level function out of a source by brace balance. */
function grabFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('not found: ' + name);
  let d = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const gs   = n => grabFrom(GS, n);
const html = n => grabFrom(HTML, n);

// ── The backend, run against a fake ScriptProperties ──────────────────────────────────────────
function backend(initialProps) {
  const props = Object.assign({}, initialProps);
  const replies = [];
  const ctx = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: k => { delete props[k]; },
      }),
    },
    MONTHS_12_: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    jsonOut_: o => { replies.push(o); return o; },
    errText_: e => 'scrubbed: ' + e.message,
    JSON, String, Number, Date, Object,
  };
  vm.createContext(ctx);
  vm.runInContext([gs('atmPaidProp_'), gs('getAtmPaidData_'), gs('setAtmPaid_')].join('\n'), ctx);
  return { ctx, props, replies };
}

console.log('\n1. marking a month paid, and the mark surviving as data');
{
  const b = backend({});
  const r = b.ctx.setAtmPaid_({ year: '2026', month: 'Jul', paid: '1', _user: 'sky' });
  ok('the write reports ok', r.ok === true && r.paid === true);
  const stored = JSON.parse(b.props['rev_atmpaid_2026']);
  ok('stored under the year, keyed by month', !!stored.Jul && stored.Jul.paid === true);
  ok('who marked it is recorded', stored.Jul.by === 'sky');
  ok('and when', /^\d{4}-\d{2}-\d{2}T/.test(stored.Jul.at || ''));
  ok('a DIFFERENT month is untouched', stored.Aug === undefined);
  ok('the figures property is not written by a paid mark', b.props['rev_atm_2026'] === undefined);
}

console.log('\n2. unpaid is the ABSENCE of a mark, not a stored false');
{
  const b = backend({ 'rev_atmpaid_2026': JSON.stringify({ Jul: { paid: true, by: 'sky' }, Aug: { paid: true } }) });
  const r = b.ctx.setAtmPaid_({ year: '2026', month: 'Aug', paid: '0', _user: 'sky' });
  ok('the write reports ok and paid:false', r.ok === true && r.paid === false);
  const stored = JSON.parse(b.props['rev_atmpaid_2026']);
  ok('the un-marked month is GONE, not stored as false', !('Aug' in stored));
  ok('...and July is still marked', stored.Jul.paid === true);
}

console.log('\n3. `paid=false` is a STRING, and a truthy read would mark it PAID');
{
  // The exact failure: 'false' and '0' are both truthy strings in JS. A `!!params.paid` read
  // would store paid:true for a click that said unpaid — silently writing the opposite.
  const b = backend({ 'rev_atmpaid_2026': JSON.stringify({ Sep: { paid: true } }) });
  ok("the string 'false' un-marks",
     b.ctx.setAtmPaid_({ year: '2026', month: 'Sep', paid: 'false' }).paid === false);
  ok('...and the month is actually gone from the store',
     !('Sep' in JSON.parse(b.props['rev_atmpaid_2026'])));
  const b2 = backend({});
  ok("the string 'true' marks",
     b2.ctx.setAtmPaid_({ year: '2026', month: 'Sep', paid: 'true' }).paid === true);
}

console.log('\n4. everything else is refused rather than guessed');
{
  const b = backend({});
  ok('a bad year',    b.ctx.setAtmPaid_({ year: '26', month: 'Jul', paid: '1' }).error === 'invalid year');
  ok('a bad month',   b.ctx.setAtmPaid_({ year: '2026', month: 'July', paid: '1' }).error === 'invalid month');
  ok('a missing paid',b.ctx.setAtmPaid_({ year: '2026', month: 'Jul' }).error === 'invalid paid');
  ok('a junk paid',   b.ctx.setAtmPaid_({ year: '2026', month: 'Jul', paid: 'yes' }).error === 'invalid paid');
  ok('nothing was written by any refusal', b.props['rev_atmpaid_2026'] === undefined);
}

console.log('\n5. a corrupt flag costs the flag, never the figures');
{
  const b = backend({ 'rev_atmpaid_2026': '{not json' });
  ok('a half-written property reads as no marks', JSON.stringify(b.ctx.getAtmPaidData_('2026')) === '{}');
  ok('...and a later write still succeeds',
     b.ctx.setAtmPaid_({ year: '2026', month: 'Jul', paid: '1' }).ok === true);
}

console.log('\n6. the route is write-guarded and carries the user');
{
  ok('set_atm_paid goes through writeGuard_',
     /action === 'set_atm_paid'\)\s*\{ const g = writeGuard_\(auth\.user, 'set_atm_paid'\)/.test(GS));
  ok('...and refuses before reaching the handler',
     /'set_atm_paid'\); if \(!g\.ok\) return jsonOut_\(g\); params\._user = auth\.user; return setAtmPaid_/.test(GS));
  ok('revenue_detail carries the paid map, so the tab needs no second call',
     /jsonOut_\(\{ ok: true, year, cfg, atm, sub, paid: getAtmPaidData_\(year\) \}\)/.test(GS));
}

// ── The frontend helpers, run against the real payload shape ──────────────────────────────────
function frontend(detail) {
  const ctx = {
    revenueDetail: detail,
    STORES: [{ name: 'Bend' }, { name: 'Center' }],
    Number, Math, Object, JSON, Array,
  };
  vm.createContext(ctx);
  const months = /const REV_MONTHS_ = \[[^\]]*\];/.exec(HTML)[0];
  vm.runInContext([months, html('atmMonthRev_'), html('atmMonthPaid_'), html('atmPaidSupported_'),
                   html('atmOutstanding_')].join('\n'), ctx);
  return ctx;
}

const DETAIL = {
  cfg: { atm_rate: 1.75, machines: { 'Bend': ['ATM 1', 'ATM 2'], 'Center': ['ATM 1'] } },
  atm: {
    Jul: { 'Bend': { 'ATM 1': 1000, 'ATM 2': 200 }, 'Center': { 'ATM 1': 800 } },  // 2000 txns
    Aug: { 'Bend': { 'ATM 1': 1000 } },                                            // 1000 txns
    Sep: { 'Bend': { 'ATM 1': 400 } },                                             //  400 txns
  },
  paid: { Jul: { paid: true, by: 'sky' } },
};

console.log('\n7. the outstanding list — the part that would have caught August');
{
  const f = frontend(DETAIL);
  const owed = f.atmOutstanding_();
  ok('July is paid and is NOT listed', !owed.some(o => o.month === 'Jul'));
  ok('August is reported and unpaid, so it is listed', owed.some(o => o.month === 'Aug'));
  ok('September too — the current month is not exempt', owed.some(o => o.month === 'Sep'));
  ok('exactly the two, in calendar order', owed.map(o => o.month).join(',') === 'Aug,Sep');
  ok('each carries its revenue at the configured rate', owed[0].rev === 1750);
  ok('the total is the sum of the outstanding months',
     owed.reduce((t, o) => t + o.rev, 0) === 1750 + 700);
}

console.log('\n8. a month with NO figures is unreported, which is a different question');
{
  const f = frontend(DETAIL);
  ok('an empty month is worth nothing', f.atmMonthRev_('Jan') === 0);
  ok('...and is not called outstanding', !f.atmOutstanding_().some(o => o.month === 'Jan'));
  ok('all twelve are not listed in an empty year',
     frontend({ cfg: DETAIL.cfg, atm: {}, paid: {} }).atmOutstanding_().length === 0);
}

console.log('\n9. NO paid map at all is a different answer from "nothing paid"');
{
  /* The page and the engine deploy separately, so this page can run against an engine that has
   * never heard of `paid` — and an old cached payload has the same shape. Reading absent as
   * unpaid would invent an outstanding payment for every reported month: amber markers and a
   * total owed, fabricated from a missing field. It must claim nothing instead. */
  const f = frontend({ cfg: DETAIL.cfg, atm: DETAIL.atm });
  ok('the feature reports itself unsupported', f.atmPaidSupported_() === false);
  ok('no month is claimed paid', f.atmMonthPaid_('Jul') === false);
  ok('...and NOTHING is claimed outstanding either', f.atmOutstanding_().length === 0);
  const empty = frontend({ cfg: DETAIL.cfg, atm: DETAIL.atm, paid: {} });
  ok('an EMPTY map is a real answer — supported, nothing marked', empty.atmPaidSupported_() === true);
  ok('...so it reports all three reported months as outstanding', empty.atmOutstanding_().length === 3);
  ok('the chip is withheld when the engine cannot answer', /!atmPaidSupported_\(\)\) \? '' :/.test(HTML));
  ok('the pill markers are too', /const marked = atmPaidSupported_\(\) && rev > 0;/.test(HTML));
  ok('and the cache key was bumped so a pre-v2.613 entry is not trusted',
     /rev_detail_v2_/.test(HTML) && !/writeCache\('rev_detail_' \+ year/.test(HTML));
}

console.log('\n10. the UI states it where the question is asked, and writes once');
{
  ok('the chip is withheld when the month has no figures',
     /atmGrandRev <= 0 \|\| !atmPaidSupported_\(\)\) \? '' : \(monthPaid/.test(HTML));
  ok('the outstanding line renders only when something is outstanding',
     /const atmOwedLine = !owed\.length \? '' :/.test(HTML));
  ok('the month pills carry the year-wide state',
     /rev-mo-paid/.test(HTML) && /rev-mo-owed/.test(HTML));
  ok('a month with no figures gets no pill marker',
     /const marked = atmPaidSupported_\(\) && rev > 0;/.test(HTML));
  const t = html('toggleAtmPaid');
  ok('the mark is a WRITE — one attempt, never re-sent', /WRITE_CAPS_/.test(t));
  ok('local state comes from the RESULT, not from what was asked',
     /revenueDetail\.paid = data\.data \|\| \{\}/.test(t));
  ok('a refusal names read-only rather than "save failed"', /read_only/.test(t));
  ok('a failure is reported in the block, not in the Settings drawer',
     /rev-paid-err/.test(t) && !/showErr\(/.test(t));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
