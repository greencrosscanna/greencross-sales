#!/usr/bin/env node
/* ─── Sales resolves a store name EXACTLY as GX Core does — run side by side with Core's own code ─
 *
 *   RUN:  node tests/store_resolve_contract_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Until slice 7 of roadmap [5] Sales asked GXCore.resolveStore (the pinned library) which store a
 * name means: `River` → river-rd, `Century` → bend, `South` → commercial. The library is unbound now,
 * and Core has no resolve route, so Sales runs Core's resolver itself (coreResolveStore_) over Core's
 * PUBLISHED registry (?action=stores). A port is a copy, and a copy is only safe while something
 * proves it still agrees.
 *
 * HOW. Loads Core's REAL gxResolveStore_ and gxBuildPublicStores_ from the sibling hub checkout, feeds
 * both a registry shaped like Core's real sheet rows, and compares store_id answers for every name
 * below — exact ids, display and Dutchie names, sheet and default aliases, licenses (full, partial,
 * ambiguous), the folded Road/Street forms, case and whitespace, unknown and inherited names.
 * Then breaks the port on purpose and shows the comparison catches it.
 *
 * SKIPS (does not fail) when greencross-command-center is not a sibling checkout.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const HUB = path.join(__dirname, '..', '..', 'greencross-command-center');
if (!fs.existsSync(path.join(HUB, 'gx_core.gs'))) {
  console.log('SKIP store-resolve contract — greencross-command-center is not a sibling checkout.');
  process.exit(0);
}
const CORE = fs.readFileSync(path.join(HUB, 'gx_core.gs'), 'utf8');
const SALES = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(src, name) {
  const m = new RegExp('\\n(function ' + name + '\\s*\\(|const ' + name + '\\s*=)').exec(src);
  if (!m) throw new Error('could not locate ' + name);
  let i = src.indexOf('{', m.index + 1), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(m.index + 1, j + 1) + (src[j + 1] === ';' ? ';' : '');
}

/* Shaped like Core's `stores` sheet: raw cells, aliases as an unparsed pipe/comma cell (blank for some,
   so Core's built-in defaults apply), licenses printed different ways, store_id with stray case. */
const RAW = [
  { store_id: 'bend',        display_name: 'Century',    dutchie_name: 'Bend',        aliases: '',                       olcc_license: '050-13006', active: 'TRUE', sort_order: 1 },
  { store_id: 'center',      display_name: 'Center',     dutchie_name: 'Center',      aliases: '',                       olcc_license: '050 12997', active: 'TRUE', sort_order: 2 },
  { store_id: 'commercial',  display_name: 'Commercial', dutchie_name: 'Commercial',  aliases: 'South|Commercial St',    olcc_license: '05013000',  active: 'TRUE', sort_order: 3 },
  { store_id: 'Hillsboro',   display_name: 'Baseline',   dutchie_name: 'Hillsboro',   aliases: 'Baseline, Hillsboro',    olcc_license: '050-13003', active: 'TRUE', sort_order: 4 },
  { store_id: 'portland-rd', display_name: 'Portland',   dutchie_name: 'Portland Rd', aliases: '',                       olcc_license: '050-13009', active: 'TRUE', sort_order: 5 },
  { store_id: 'river-rd',    display_name: 'River',      dutchie_name: 'River Rd',    aliases: '',                       olcc_license: '050-16892', active: 'TRUE', sort_order: 6 },
  { store_id: 'salem',       display_name: 'Salem',      dutchie_name: 'Salem',       aliases: '',                       olcc_license: '',          active: 'FALSE', sort_order: 7 },
  // Hypothetical, and here for ONE reason: "River St" and "River Rd" both fold to `river`, so a name
  // like "River Street" is AMBIGUOUS and must resolve to nothing. The real six never collide, so
  // without this row the refuse-a-tie rule would be untested (the mutation check below proved it).
  { store_id: 'river-st',    display_name: 'River St',   dutchie_name: 'River St',    aliases: '',                       olcc_license: '',          active: 'TRUE', sort_order: 8 },
];

const core = { console };
vm.createContext(core);
vm.runInContext([
  grab(CORE, 'GX_STORE_ALIASES_DEFAULT'), grab(CORE, 'gxSlug_'), grab(CORE, 'gxOwn_'), grab(CORE, 'gxTruthy_'),
  // short_code is display-only and irrelevant to resolution; stubbed so the real builder runs.
  'function gxShortCode_(n) { return String(n || "").slice(0, 3).toUpperCase(); }', grab(CORE, 'gxStoreAliases_'), grab(CORE, 'gxStoreToken_'), grab(CORE, 'gxLicenseKey_'),
  grab(CORE, 'gxResolveStoreByLicense_'), grab(CORE, 'gxResolveStore_'), grab(CORE, 'gxBuildPublicStores_'),
  // Core's own getStores body: active rows, aliases parsed. Rows are fresh copies so neither side can
  // see the other's mutation.
  'function gxRead_(t) { return JSON.parse(RAW_JSON); }',
  grab(CORE, 'getStores'),
  'function gxStoresCached_() { return getStores(); }',
  'this.resolve = gxResolveStore_; this.published = () => gxBuildPublicStores_().stores;',
].join('\n').replace('RAW_JSON', JSON.stringify(JSON.stringify(RAW))), core);

const sales = {};
vm.createContext(sales);
vm.runInContext(['coreSlug_', 'coreStoreToken_', 'coreLicenseKey_', 'coreResolveStore_'].map(n => grab(SALES, n)).join('\n')
  + '\nthis.resolve = coreResolveStore_;', sales);

const PUBLISHED = core.published();
ok(PUBLISHED.length === 7 && PUBLISHED.every(s => Array.isArray(s.aliases)), 'Core publishes the seven active stores, aliases as lists (salem inactive)');

const NAMES = [
  // ids, display names, Dutchie names
  'bend', 'center', 'commercial', 'hillsboro', 'portland-rd', 'river-rd',
  'Century', 'Baseline', 'Portland', 'River', 'Bend', 'Hillsboro', 'Portland Rd', 'River Rd',
  // default aliases (blank cell) and sheet aliases (pipe and comma cells)
  'Century Dr', 'South', 'Commercial St',
  // case and whitespace
  '  RIVER  ', 'river rd', 'PORTLAND RD', 'HILLSBORO',
  // the folded fallback: Road/Street, punctuation, a trailing road word
  'River Road', 'Portland Rd.', 'Commercial Street', 'Century Drive', 'portland road', 'River-Rd',
  // an ambiguous fold (River Rd vs River St) — Core refuses it, so must Sales
  'River Street', 'river  st.', 'River St',
  // licenses: every printed form, a unique suffix, and ambiguous/too-short suffixes
  '050-13006', '05013006', 'OLCC 050 13006', '#050-16892', '16892', '13009', '0', '00', '130', '3006',
  // unknown, inactive, empty, inherited
  'Springfield', 'Salem', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty',
];

function compare(salesResolve) {
  const diffs = [];
  for (const n of NAMES) {
    const c = core.resolve(n), s = salesResolve(n, PUBLISHED);
    const cid = c && c.store_id ? String(c.store_id).toLowerCase() : null;
    const sid = s && s.store_id ? String(s.store_id).toLowerCase() : null;
    if (cid !== sid) diffs.push(JSON.stringify(n) + ': Core ' + cid + ', Sales ' + sid);
  }
  return diffs;
}

console.log('\n1. every name lands on the same store as Core\'s own resolver');
{
  const diffs = compare(sales.resolve);
  diffs.forEach(d => console.log('        ' + d));
  ok(diffs.length === 0, 'Sales\' coreResolveStore_ agrees with Core\'s gxResolveStore_ on all ' + NAMES.length + ' names');
  // Not vacuous: the set exercises every tier and both outcomes.
  const hits = NAMES.filter(n => core.resolve(n)).length;
  ok(hits >= 30 && NAMES.length - hits >= 8, 'the names cover hits (' + hits + ') and misses (' + (NAMES.length - hits) + ')');
  ok(sales.resolve('River', PUBLISHED).store_id === 'river-rd' && sales.resolve('South', PUBLISHED).store_id === 'commercial',
     'the two that matter most: River → river-rd, South → commercial');
}

console.log('\n2. a deliberate break is caught — the comparison can fail');
{
  // Each mutant is a plausible "simplification" of the port. If the comparison passed one of them,
  // this test would be proving nothing.
  const mutants = [
    ['folded fallback takes the first hit instead of refusing a tie', s => s.replace('return folded.length === 1 ? folded[0] : null;', 'return folded[0] || null;')],
    ['license suffix tier dropped', s => s.replace('if (lic.length >= 4) {', 'if (false) {')],
    ['aliases ignored', s => s.replace("return Array.isArray(s.aliases) ? s.aliases : [];", 'return [];')],
    ['no Road→Rd fold', s => s.replace(".replace(/\\broad\\b/g, 'rd')", '')],
  ];
  for (const [label, mutate] of mutants) {
    const src = ['coreSlug_', 'coreStoreToken_', 'coreLicenseKey_', 'coreResolveStore_'].map(n => grab(SALES, n)).join('\n');
    const bad = mutate(src);
    if (bad === src) { ok(false, 'mutant did not apply (the port changed shape): ' + label); continue; }
    const m = {}; vm.createContext(m); vm.runInContext(bad + '\nthis.resolve = coreResolveStore_;', m);
    const diffs = compare(m.resolve);
    ok(diffs.length > 0, 'caught: ' + label + ' (' + diffs.length + ' name(s) differ, e.g. ' + diffs[0] + ')');
  }
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
