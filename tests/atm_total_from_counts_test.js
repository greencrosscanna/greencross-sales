#!/usr/bin/env node
/* NET SALES CARRIES THE ATM TOTAL DERIVED FROM THE MACHINE COUNTS.
 *
 * Sky, 2026-11-06: August's ATM counts were entered and saved, and net sales still carried $0 ATM
 * for August — "I'm not seeing it showing up". ATM lived in two records that never spoke: the
 * per-machine counts (`rev_atm_<year>`, Revenue tab) and a hand-typed monthly total
 * (`otherrev_data.atm`, the Income pencil), and only the second reached net sales. July had sat at
 * $0 the same way since its counts went in. Jan–Jun's typed totals were measured equal to
 * counts × 1.75 to the cent, so deriving changes no past figure.
 *
 * Load-bearing, each a way the fix could quietly regress:
 *   1. A month WITH counts reports counts × rate, overriding a stale typed total (incl. 0).
 *   2. A month WITHOUT counts keeps its typed total — never a confident 0 over a real figure.
 *   3. Unreadable counts serve the typed totals unchanged — never blank the ATM line.
 *   4. A typed ATM total for a month with counts is REFUSED (it would be stored and overruled).
 *   5. Saving counts drops the server cache, schedules a snapshot rebuild, and sends the new totals
 *      back — and the page applies them to what Income renders.
 *   6. An open prefers the snapshot's answer over this device's own cached copy.
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
const body = out => JSON.parse(out.getContent());

const M12 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const YEAR = '2026';
const zeros = () => Object.fromEntries(M12.map(m => [m, 0]));

function backend(props, opts) {
  opts = opts || {};
  const calls = { cacheDelete: [], kicks: 0, setProps: [] };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { calls.setProps.push(k); props[k] = v; },
    }) },
    Utilities: { formatDate: () => YEAR },
    Logger: { log: () => {} },
    MONTHS_12_: M12,
    OTHERREV_PROP: 'otherrev_data',
    jsonOut_: o => ({ getContent: () => JSON.stringify(o) }),
    errText_: e => String(e && e.message || e),
    cacheDelete_: k => calls.cacheDelete.push(k),
    bundleKick_: () => { calls.kicks++; return true; },
    getRevConfig_: () => ({ atm_rate: 1.75 }),
    JSON, String, Number, Math, Object, Array,
  };
  vm.createContext(ctx);
  ctx.getRevYearData_ = opts.countsThrow
    ? () => { throw new Error('property read failed'); }
    : (type, year) => { const raw = props['rev_' + type + '_' + year]; return raw ? JSON.parse(raw) : {}; };
  vm.runInContext([gs('getOtherRevData_'), gs('otherRevWithAtmCounts_'), gs('otherRevChanged_'),
                   gs('setOtherRevenue'), gs('setRevenueLine')].join('\n'), ctx);
  return { ctx, calls, props };
}

// Real August 2026 counts as Sky gave them, and July's as stored.
const COUNTS = {
  Jul: { Bend: { 'ATM 1': 768, 'ATM 2': 494 }, Center: { 'ATM 1': 438 }, Commercial: { 'ATM 1': 409, 'ATM 2': 1027 },
         Hillsboro: { 'ATM 1': 305, 'ATM 2': 397 }, 'Portland Rd': { 'ATM 1': 1073 }, River: { 'ATM 1': 647, 'ATM 2': 350 } },
  Aug: { Bend: { 'ATM 1': 0, 'ATM 2': 0 } },   // reported-as-zero month: NOT derived
};
// July carries a STALE typed total on purpose: with a 0 there, "keep the typed figure if any" would
// pass every check, and that is exactly the regression rule 1 exists to catch (measured by mutation).
const stored = () => { const a = zeros(); a.Jun = 9794.75; a.Mar = 10195.5; a.Jul = 5000; return { atm: a, sublet: zeros() }; };

console.log('derivation');
{
  const b = backend({ otherrev_data: JSON.stringify(stored()), ['rev_atm_' + YEAR]: JSON.stringify(COUNTS) });
  const d = b.ctx.otherRevWithAtmCounts_(stored());
  ok('July with counts reports counts x rate ($10,339), over a stale typed $5,000', d.atm.Jul === 10339);
  ok('a month with no counts keeps its typed total (Jun $9,794.75)', d.atm.Jun === 9794.75);
  ok('a month whose counts are all zero keeps its typed total, not derived', d.atm.Aug === 0 && !d.atm_from_counts.includes('Aug'));
  ok('atm_from_counts names exactly the derived months', JSON.stringify(d.atm_from_counts) === '["Jul"]');
  ok('sublet passes through untouched', JSON.stringify(d.sublet) === JSON.stringify(zeros()));
  ok('the payload keeps all twelve ATM months', M12.every(m => typeof d.atm[m] === 'number'));
}
{
  const b = backend({}, { countsThrow: true });
  const d = b.ctx.otherRevWithAtmCounts_(stored());
  ok('unreadable counts serve the typed totals unchanged (never blank ATM)', d.atm.Jun === 9794.75 && d.atm.Mar === 10195.5);
}

console.log('getOtherRevenue serves the derived figure');
{
  const src = gs('getOtherRevenue');
  ok('getOtherRevenue builds its reply through otherRevWithAtmCounts_', /otherRevWithAtmCounts_\(\s*getOtherRevData_\(\)\s*\)/.test(src));
  // The snapshot's otherrev part must come from the same route function, so both readers agree.
  ok('the snapshot part is built by getOtherRevenue', /parts\.otherrev\s*=\s*bundlePart_\('otherrev'[^;]*getOtherRevenue\(\)/.test(GS));
}

console.log('saving counts');
{
  const b = backend({ otherrev_data: JSON.stringify(stored()), ['rev_atm_' + YEAR]: JSON.stringify(COUNTS) });
  const r = body(b.ctx.setRevenueLine({ year: YEAR, month: 'Aug', type: 'atm', store: 'Bend', item: 'ATM 1', value: '772' }));
  ok('the save succeeds', r.ok === true);
  ok('the reply carries the new net-sales totals (Aug = 772 x 1.75)', r.otherrev && r.otherrev.atm.Aug === 1351);
  ok('the server cache is dropped', b.calls.cacheDelete.includes('otherrev'));
  ok('a snapshot rebuild is scheduled', b.calls.kicks === 1);
}

console.log('typed totals');
{
  const b = backend({ otherrev_data: JSON.stringify(stored()), ['rev_atm_' + YEAR]: JSON.stringify(COUNTS) });
  const r = body(b.ctx.setOtherRevenue({ type: 'atm', month: 'Jul', value: '5' }));
  ok('a typed ATM total for a month with counts is refused', r.ok === false && /Revenue tab/.test(r.error));
  ok('and nothing was written', !b.calls.setProps.includes('otherrev_data'));
  const r2 = body(b.ctx.setOtherRevenue({ type: 'atm', month: 'Sep', value: '100' }));
  ok('a typed ATM total for a month with no counts still saves', r2.ok === true && r2.data.atm.Sep === 100);
  ok('its reply is the derived view (July still from counts)', r2.data.atm.Jul === 10339);
  ok('and it also schedules a snapshot rebuild', b.calls.kicks === 1);
  const r3 = body(b.ctx.setOtherRevenue({ type: 'sublet', month: 'Jul', value: '50' }));
  ok('sublet is never refused for ATM counts', r3.ok === true && r3.data.sublet.Jul === 50);
}

console.log('the page');
{
  const save = html('saveRevModal');
  ok('saveRevModal applies the returned totals to otherRevData', /otherRevData\s*=\s*data\.otherrev/.test(save));
  ok('saveRevModal rewrites the local otherrev cache', /writeCache\('otherrev',\s*data\.otherrev\)/.test(save));

  // Execute loadOtherRevenue: a cached copy must not beat the snapshot answer handed in.
  const ctx = { otherRevData: null, otherRevAgeMs: 1, otherRevTried: false, console: { log() {}, warn() {} },
                readCache: () => ({ atm: { Aug: 0 } }), writeCache: () => {}, readStaleCache: () => null,
                getProxyUrl: () => 'x', getToken: () => 't', gasFetchJson: async () => { throw new Error('no fetch expected'); },
                AUX_READ_CAPS_: [], GAS_PRIO: { SCREEN: 0 }, encodeURIComponent };
  vm.createContext(ctx);
  // grabFrom starts at `function`, so the `async` keyword in front of it has to be put back.
  vm.runInContext('async ' + html('loadOtherRevenue') + '\nthis.run = loadOtherRevenue;', ctx);
  ctx.run({ atm: { Aug: 10447.5 }, sublet: {} }).then(() => {
    ok('an open prefers the snapshot answer over this device\'s cached copy', ctx.otherRevData.atm.Aug === 10447.5);
    return (async () => {
      ctx.otherRevData = null;
      await ctx.run();
      ok('with no snapshot answer the cached copy is still used', ctx.otherRevData.atm.Aug === 0);
    })();
  }).then(() => {
    const ttl = /otherrev:\s*([^,]+),/.exec(HTML.slice(HTML.indexOf('const CACHE_TTL')));
    ok('the local otherrev copy lives at most an hour (was 24h)', ttl && vm.runInNewContext(ttl[1]) <= 3600000);

    const inc = html('_incomeOtherRevHtml');
    ok('the Income pencil is withheld for a month derived from counts', /atm_from_counts/.test(inc) && /fromCounts\(type\)/.test(inc));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }).catch(e => { console.log('  FAIL threw: ' + e.message); process.exit(1); });
}
