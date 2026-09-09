#!/usr/bin/env node
/* EVERY BUG FILED FROM SALES CARRIED NO STATE, and nothing failed to say so.
 *
 * gx-bugreport.js (gx-theme, shared by five apps) sends exactly ONE state field:
 *   { action, title, desc, priority, reporter, appVer, context }
 * `context` is a JSON snapshot — browser, screen size, online flag, a Pacific timestamp, RECENT JS
 * ERRORS, plus this app's own { tab: section }. There is no top-level `tab`, `appTab` or `appStore`
 * in that payload and there never has been.
 *
 * reportBug_ read `appVer`, `appStore` and `appTab`, and forwarded no context at all. Two of those
 * three fields are not sent, and the one field that IS sent was dropped on the floor before GX Core
 * ever saw it.
 *
 * MEASURED 2026-09-09 over all 19 bugs Sales has ever filed: `tab` populated on the four filed
 * 2026-08-14..17, on NONE of the fourteen since 2026-08-25; `context` on ZERO of nineteen. The break
 * is the form migration (index.html:917), not a Core pin — this repo re-pinned to v213 precisely so
 * gxIngestBug would self-install the bug_reports.context header, and that column has been storing an
 * empty string ever since because nothing was handed to it. The v213 verification checked
 * reporter/tab/app_version — three fields that were fine — and context was not among them. That is
 * how this survived three weeks: the check looked at everything except the thing that broke.
 *
 * WHAT IT COST. Three of those fourteen read "App stalls on connecting", "the page still hangs on
 * loading" and "loading" — the v2.559 `defer` bug, filed three times across v2.557..v2.559 before it
 * was diagnosed. One ReferenceError during boot, no UI, an app that looked slow. `recentErrors` is in
 * the snapshot; all three would have arrived carrying it.
 *
 * So this executes the SHIPPED reportBug_ against the payload the SHARED FORM actually sends, and
 * asserts on what reaches gxIngestBug. A test that restated the call would keep passing after the
 * real one regressed, which is the failure mode this whole suite is built against.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(src, name) {
  const re = new RegExp('\\nfunction ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = src.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

// ── harness: run the shipped reportBug_ with gxIngestBug and jsonOut_ captured ──────────────────
function run(params, opts) {
  opts = opts || {};
  const seen = { payload: null, app: null, reporter: null, out: null, threw: null };
  const ctx = {
    console,
    GXCore: { gxIngestBug: function (app, reporter, payload) {
      seen.app = app; seen.reporter = reporter; seen.payload = payload;
      if (opts.ingestThrows) throw new Error('core exploded');
      return opts.ingestResult || { ok: true, id: 'bug_test' };
    } },
    jsonOut_: function (o) { seen.out = o; return o; }
  };
  vm.createContext(ctx);
  vm.runInContext(grab(GS, 'reportBug_'), ctx);
  try { ctx.reportBug_(params, opts.reporter === undefined ? 'sky' : opts.reporter); }
  catch (e) { seen.threw = e; }
  return seen;
}

// The payload gx-bugreport.js ACTUALLY builds (gx-bugreport.js:393-401). Nothing top-level named
// tab/appTab/appStore — that absence is the point of the fixture.
const SNAP = { browser: 'Chrome', screen: '1512x982', online: true,
               at: '9/9/2026, 1:58:40 PM', ua: 'Mozilla/5.0 …',
               errors: ['ReferenceError: GXClient is not defined'], tab: 'expenses' };
const sharedFormPayload = (over) => Object.assign({
  action: 'reportbug', title: 'test bug', desc: 'no action required',
  priority: 'low', reporter: 'sky', appVer: 'v2.583',
  context: JSON.stringify(SNAP)
}, over || {});

console.log('\n── the shared form\'s real payload ──');
{
  const s = run(sharedFormPayload());
  ok('files under app "sales"',                    s.app === 'sales');
  ok('reporter is the session user, not the form', s.reporter === 'sky');
  ok('returns ok',                                 s.out && s.out.ok === true);
  ok('context REACHES gxIngestBug',                !!(s.payload && s.payload.context));
  ok('context is forwarded VERBATIM',              s.payload.context === JSON.stringify(SNAP));
  ok('the captured JS error survives',             /GXClient is not defined/.test(s.payload.context));
  ok('tab is recovered from the snapshot',         s.payload.tab === 'expenses');
  ok('appVer still forwarded',                     s.payload.appVer === 'v2.583');
  ok('title forwarded',                            s.payload.title === 'test bug');
  ok('desc forwarded',                             s.payload.desc === 'no action required');
  ok('priority forwarded as sent',                 s.payload.priority === 'low');
}

console.log('\n── the parse must never sink the report ──');
{
  const s = run(sharedFormPayload({ context: '{not json at all' }));
  ok('a malformed snapshot still files',           s.out && s.out.ok === true);
  ok('  …and does not throw',                      !s.threw);
  ok('  …tab degrades to empty, not undefined',    s.payload.tab === '');
  ok('  …the RAW snapshot still goes up',          s.payload.context === '{not json at all');
}
{
  const s = run(sharedFormPayload({ context: 'null' }));
  ok('a literal null snapshot still files',        s.out && s.out.ok === true);
  ok('  …tab empty',                               s.payload.tab === '');
}
{
  const s = run(sharedFormPayload({ context: '"a string"' }));
  ok('a non-object snapshot still files',          s.out && s.out.ok === true);
  ok('  …tab empty',                               s.payload.tab === '');
}
{
  const s = run(sharedFormPayload({ context: JSON.stringify({ browser: 'Chrome' }) }));
  ok('a snapshot with no tab key still files',     s.out && s.out.ok === true);
  ok('  …tab empty',                               s.payload.tab === '');
  ok('  …context still forwarded',                 /Chrome/.test(s.payload.context));
}
{
  const p = sharedFormPayload(); delete p.context;
  const s = run(p);
  ok('no context at all still files',              s.out && s.out.ok === true);
  ok('  …context is "" not undefined',             s.payload.context === '');
  ok('  …tab is "" not undefined',                 s.payload.tab === '');
}

console.log('\n── a top-level tab still wins if one ever arrives ──');
{
  const s = run(sharedFormPayload({ context: JSON.stringify({ browser: 'X' }), appTab: 'income' }));
  ok('appTab fills tab when the snapshot has none', s.payload.tab === 'income');
}
{
  const s = run(sharedFormPayload({ appTab: 'income' }));
  ok('the snapshot wins over appTab when both set', s.payload.tab === 'expenses');
}

console.log('\n── the refusals that were already load-bearing ──');
{
  const p = sharedFormPayload({ desc: '' }); delete p.title;
  const s = run(p);
  ok('an empty report is refused',                 s.out && s.out.ok === false);
  ok('  …and never reaches Core',                  s.payload === null);
}
{
  const p = sharedFormPayload({ desc: 'the store filter is stuck\nand it stays stuck' });
  delete p.title;
  const s = run(p);
  ok('a missing title falls back to line one',     s.payload.title === 'the store filter is stuck');
}
{
  const s = run(sharedFormPayload(), { ingestResult: { ok: false, error: 'title required' } });
  ok('a Core refusal is NOT reported as success',  s.out && s.out.ok === false);
  ok('  …and carries Core\'s reason',              /title required/.test(s.out.error));
}
{
  const s = run(sharedFormPayload(), { ingestThrows: true });
  ok('a Core throw is caught and reported',        s.out && s.out.ok === false);
  ok('  …not rethrown at the router',              !s.threw);
}

console.log('\n── the source itself ──');
{
  const src = grab(GS, 'reportBug_');
  ok('reportBug_ forwards a context field',        /context:\s*ctx/.test(src));
  ok('the parse is guarded by try/catch',          /try\s*\{[^}]*JSON\.parse/.test(src));
  ok('tab is passed to gxIngestBug',               /\btab:\s*ctxTab/.test(src));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
