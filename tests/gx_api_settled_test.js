#!/usr/bin/env node
/* ─── Past days from gx-api — behind a switch, and never a smaller number ───────────────────────
 *
 *   RUN:  node tests/gx_api_settled_test.js     (from the repo root; no deps, no network)
 *
 * Roadmap [5]: gx-api (greencross-command-center/api/) keeps the same Closing Report numbers GX Core
 * keeps, in a real database on Cloudflare. settledSalesRows_ reads past days from it when the
 * SALES_DATA_SOURCE switch says 'api', and from GXCore.getSalesDaily otherwise.
 *
 * These numbers are checked against bank deposits. The property under test is the FALLBACK: any
 * answer that is not a complete 200 goes back to the Sheets cache, so a gap in the new database can
 * never show up as a store-month that reads short.
 *
 * EXECUTES the shipped settledSalesRows_ and its switch.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const GS = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const SCRUB_DECLS = (/const AUTH_PARAM_NAMES_[\s\S]*?'gi'\);/.exec(GS) || [''])[0];

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) { console.log('  FAIL  function ' + name + ' not found'); process.exit(1); }
  let i = src.indexOf('{', m.index), d = 0;
  for (let j = i; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(m.index, j + 1); }
}
const a = GS.indexOf('const GX_API_ ='), b = GS.indexOf('function getStoreSales_(');
ok(a > 0 && b > a, 'the gx-api block sits just above getStoreSales_');
const SETTLED_SRC = GS.slice(a, b);

const SHEET = [{ date: '2026-11-21', store: 'bend', net: '3859.46' }, { date: '2026-11-22', store: 'bend', net: '3551.42' }];
const apiRows = n => Array.from({ length: n }, (_, i) => ({ date: '2026-11-2' + (1 + i), store: 'bend', net: 1, source: 'closing_report' }));

function world(opts) {
  const w = { sheetCalls: 0, fetches: [], marks: [] };
  const ctx = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'GX_DEPLOY_SECRET' ? 'test-secret' : (k === 'SALES_DATA_SOURCE' ? opts.source : null) }) },
    GXCore: { getSalesDaily: () => { w.sheetCalls++; return SHEET; } },
    UrlFetchApp: { fetch: (url, o) => {
      w.fetches.push({ url, headers: (o && o.headers) || {} });
      if (opts.throws) throw new Error('Address unavailable: ' + url);
      return { getResponseCode: () => opts.code || 200, getContentText: () => JSON.stringify(opts.body) };
    } },
    probeMark_: (label, ms, extra) => w.marks.push({ label, extra }),
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;', ctx);
  vm.runInContext(SCRUB_DECLS + '\n' + grab(GS, 'gxScrub_') + '\n' + grab(GS, 'errText_') + '\n' + grab(GS, 'gxDeploySecret_') + '\n' + SETTLED_SRC
    + '\nthis.run = (s, f, t) => settledSalesRows_(s, f, t); this.src = () => salesDataSource_();', ctx);
  w.run = ctx.run; w.src = ctx.src;
  return w;
}

console.log('\n1. the switch is off by default — exactly the old behavior');
{
  const w = world({ source: null });
  const r = w.run('Bend', '2026-11-21', '2026-11-22');
  ok(r === SHEET && w.sheetCalls === 1, 'no switch: GXCore.getSalesDaily, once');
  ok(w.fetches.length === 0, 'and nothing is sent to gx-api');
  ok(world({ source: 'cloudflare' }).src() === 'sheets', 'an unrecognized value is the safe default');
  ok(world({ source: ' API ' }).src() === 'api', 'case and spaces do not matter');
}

console.log('\n2. switch on, complete answer: gx-api rows are used');
{
  const w = world({ source: 'api', body: { ok: true, rows: apiRows(2) } });
  const r = w.run('River Rd', '2026-11-21', '2026-11-22');
  ok(r.length === 2 && r[0].source === 'closing_report' && w.sheetCalls === 0, 'gx-api answered every day: used, Sheets not read');
  const f = w.fetches[0];
  ok(/^https:\/\/gx-api\.greencross\.workers\.dev\/v1\/sales\/daily\?store=River%20Rd&from=2026-11-21&to=2026-11-22$/.test(f.url), 'asks for one store and the exact days');
  ok(f.headers['x-gx-secret'] === 'test-secret' && !/secret/.test(f.url), 'the secret goes in a header, never the URL');
  ok(w.marks.some(m => m.label === 'settled_source_api'), 'and leaves a mark saying where the numbers came from');
}

console.log('\n3. switch on, any doubt: back to Sheets, never a short month');
{
  const short = world({ source: 'api', body: { ok: true, rows: apiRows(1) } });
  ok(short.run('Bend', '2026-11-21', '2026-11-22') === SHEET && short.sheetCalls === 1, 'a missing day falls back (the new database is never allowed to read short)');
  ok(short.marks.some(m => m.label === 'settled_api_fallback' && m.extra.want === 2 && m.extra.got === 1), '...and the mark says how short');
  const down = world({ source: 'api', code: 503, body: { ok: false } });
  ok(down.run('Bend', '2026-11-21', '2026-11-22') === SHEET, 'a 503 falls back');
  ok(down.marks.some(m => m.extra && m.extra.why === 'http_503'), '...named');
  const refused = world({ source: 'api', body: { ok: false, error: 'Auth required' } });
  ok(refused.run('Bend', '2026-11-21', '2026-11-22') === SHEET, 'a refusal falls back');
  const dead = world({ source: 'api', throws: true });
  ok(dead.run('Bend', '2026-11-21', '2026-11-22') === SHEET && dead.sheetCalls === 1, 'a network error falls back');
  const deadMark = dead.marks.find(m => m.label === 'settled_api_fallback');
  ok(deadMark && !/test-secret/.test(deadMark.extra.why), '...and the error text carries no secret');
  const all = world({ source: 'api', body: { ok: true, rows: apiRows(12) } });
  ok(all.run('', '2026-11-21', '2026-11-22') === SHEET && all.fetches.length === 0, 'an all-stores read stays on Sheets (no simple completeness check)');
}

console.log('\n4. every settled read goes through the switch, and the switch is an operator route');
{
  ok(!/GXCore\.getSalesDaily\(/.test(GS.replace(SETTLED_SRC, '')), 'no GXCore.getSalesDaily call is left outside settledSalesRows_');
  const route = /if \(params\.action === 'datasource'\) \{[\s\S]*?\n  \}/.exec(GS);
  ok(!!route, 'the datasource route exists');
  ok(route && /params\.secret !== secret\) return jsonOut_\(\{ ok: false, error: 'Forbidden' \}\)/.test(route[0]), '...gated by the deploy secret');
  ok(route && /SALES_DATA_SOURCES_\.indexOf\(want\) === -1/.test(route[0]), '...and refuses a value that is not a known source');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
