#!/usr/bin/env node
/* ─── The Sales store list comes from GX Core — a new store is not silently left out ───────────────
 *
 *   RUN:  node tests/store_list_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Until 2026-09-14 the six stores were typed out in index.html and four more times in
 * dutchie_proxy.gs (goals by date, the pay-period walk, pacing, COGS), and the client's registry
 * merge SKIPPED any store it did not already know. A store added in Command Center would therefore
 * load nowhere, and every company total, goal and Gross Profit figure would read one store short —
 * a smaller number, not an error. That is the River outage's shape.
 *
 * EXECUTES the shipped salesStores_ (backend) and addOrUpdateStore_ (frontend), and checks that none
 * of the four backend copies has grown back.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');

const GS   = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
const HTML = fs.readFileSync(__dirname + '/../index.html', 'utf8');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

function grab(src, name) {
  const m = new RegExp('function ' + name.replace(/[$]/g, '\\$') + '\\s*\\(').exec(src);
  if (!m) { console.log('  FAIL  function ' + name + ' not found — renamed or removed?'); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }
  let i = src.indexOf('{', m.index), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('unbalanced ' + name);
}
function grabBlock(src, re, label) {
  const m = re.exec(src);
  if (!m) { console.log('  FAIL  ' + label + ' not found'); console.log('\n' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); }
  return m[0];
}

// ── Backend ──────────────────────────────────────────────────────────────────
function backend(registry) {
  const ctx = { gxStoreRegistry_: registry };
  vm.createContext(ctx);
  vm.runInContext([
    grabBlock(GS, /const SALES_KEY_BY_DUTCHIE_ = [^\n]*\n/, 'SALES_KEY_BY_DUTCHIE_'),
    grabBlock(GS, /const SALES_STORES_FALLBACK_ = \[[\s\S]*?\n\];/, 'SALES_STORES_FALLBACK_'),
    grab(GS, 'hasOwn_'), grab(GS, 'salesStoreKey_'), grab(GS, 'salesStores_'),
    'this.salesStores_ = salesStores_;',
  ].join('\n'), ctx);
  return ctx.salesStores_;
}
const REG = [
  { store_id: 'bend', dutchie_name: 'Bend', sort_order: 1 },
  { store_id: 'center', dutchie_name: 'Center', sort_order: 2 },
  { store_id: 'commercial', dutchie_name: 'Commercial', sort_order: 3 },
  { store_id: 'hillsboro', dutchie_name: 'Hillsboro', sort_order: 4 },
  { store_id: 'portland-rd', dutchie_name: 'Portland Rd', sort_order: 5 },
  { store_id: 'river-rd', dutchie_name: 'River Rd', sort_order: 6 },
];

console.log('\n1. backend — the registry is the list');
{
  const list = backend(() => REG.concat([{ store_id: 'salem', dutchie_name: 'Salem', sort_order: 7 }]))();
  ok(list.length === 7, 'a seventh store in the registry is a seventh store here');
  const salem = list.find(s => s.core === 'salem');
  ok(salem && salem.dutchie === 'Salem' && salem.sales === 'Salem', 'a new store keys on its dutchie_name, no edit needed');
  const river = list.find(s => s.core === 'river-rd');
  ok(river && river.dutchie === 'River Rd' && river.sales === 'River', "River keeps Sales' own key");
}

console.log('\n2. backend — a rename in Command Center updates a store, never duplicates it');
{
  const renamed = REG.map(r => r.store_id === 'river-rd' ? Object.assign({}, r, { dutchie_name: 'River Road' }) : r);
  const list = backend(() => renamed)();
  ok(list.length === 6, 'still six stores');
  const river = list.find(s => s.core === 'river-rd');
  ok(river.sales === 'River' && river.dutchie === 'River Road', 'same Sales key, new Dutchie name');
}

console.log('\n3. backend — a registry hiccup falls back to the six, and an empty or junk answer does too');
{
  const threw = backend(() => { throw new Error('GX Core store registry unreachable'); })();
  ok(threw.length === 6 && threw.map(s => s.sales).join() === 'Bend,Center,Commercial,Hillsboro,Portland Rd,River',
     'unreachable registry => the fallback six, in order');
  ok(backend(() => [])().length === 6, 'empty registry => fallback');
  ok(backend(() => [{ store_id: '', dutchie_name: '' }])().length === 6, 'rows with no id/name => fallback');
  const a = backend(() => { throw new Error('x'); })(); a[0].sales = 'MUTATED';
  ok(backend(() => { throw new Error('x'); })()[0].sales === 'Bend', 'a caller mutating the list cannot corrupt the fallback');
}

console.log('\n4. backend — the four hardcoded copies are gone');
{
  const lists = GS.match(/\{ (dutchie|core): 'Portland Rd'|\{ (dutchie|core): 'portland-rd'/g) || [];
  ok(!/PG_STORE_MAP_/.test(GS), 'PG_STORE_MAP_ removed');
  ok((GS.match(/sales: 'Portland Rd'/g) || []).length === 1, "exactly one store table left in the backend (the fallback), found " + (GS.match(/sales: 'Portland Rd'/g) || []).length);
  ['getPeriodGoalsForDate_', 'getPacingFracs_', 'getCogsDutchie', 'pgStoreIdMap_', 'attainProbe_'].forEach(fn =>
    ok(/salesStores_\(\)/.test(grab(GS, fn)), fn + ' reads salesStores_()'));
  ok(/store_id:\s*s\.store_id/.test(grab(GS, 'getStoresMeta_')), 'the stores route sends store_id to the client');
}

// ── Frontend ─────────────────────────────────────────────────────────────────
function frontend() {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext([
    grabBlock(HTML, /const STORES = \[[\s\S]*?\n\];/, 'STORES'),
    grabBlock(HTML, /const STORE_FALLBACK_COLOR = [^\n]*\n/, 'STORE_FALLBACK_COLOR'),
    'const STORE_MAP = new Map(STORES.map(s => [s.name, s]));',
    grabBlock(HTML, /const GX_DUTCHIE_TO_SALES = [^\n]*\n/, 'GX_DUTCHIE_TO_SALES'),
    'const STORE_TO_VEL = {};',
    grab(HTML, 'addOrUpdateStore_'),
    'this.t = { STORES, STORE_MAP, STORE_TO_VEL, addOrUpdateStore_ };',
  ].join('\n'), ctx);
  return ctx.t;
}

console.log('\n5. frontend — a store the table has never seen is ADDED (it used to be skipped)');
{
  const t = frontend();
  t.addOrUpdateStore_({ store_id: 'salem', dutchie_name: 'Salem', display_name: 'Salem St', color: '#10B981' });
  ok(t.STORES.length === 7, 'STORES grows to seven');
  const s = t.STORE_MAP.get('Salem');
  ok(s && s.display === 'Salem St' && s.color === '#10B981', 'with its registry name and color');
  ok(t.STORE_TO_VEL.Salem === 'Salem', 'and a velocity name, so the Inventory tab can find it');
  const bare = t.addOrUpdateStore_({ store_id: 'eugene', dutchie_name: 'Eugene' });
  ok(bare && /^#[0-9A-F]{6}$/i.test(bare.color) && bare.display === 'Eugene', 'a store with no color or display name still renders');
}

console.log('\n6. frontend — known stores update in place, on store_id and on the legacy name');
{
  const t = frontend();
  t.addOrUpdateStore_({ store_id: 'river-rd', dutchie_name: 'River Road', display_name: 'Riverside', color: '#000000' });
  ok(t.STORES.length === 6, 'a renamed River is still one store');
  ok(t.STORE_MAP.get('River').display === 'Riverside', 'matched on store_id, key unchanged');
  t.addOrUpdateStore_({ dutchie_name: 'River Rd', display_name: 'River' });   // cached payload, no store_id
  ok(t.STORES.length === 6 && t.STORE_MAP.get('River').display === 'River', 'an old cached payload with no store_id still matches');
  t.addOrUpdateStore_({ dutchie_name: 'Bend', color: '#111111' });
  ok(t.STORE_MAP.get('Bend').color === '#111111' && t.STORE_MAP.get('Bend').display === 'Century',
     'a partial row updates what it carries and leaves the rest');
  ok(t.addOrUpdateStore_({}) === null && t.addOrUpdateStore_(null) === null && t.STORES.length === 6, 'an empty row adds nothing');
  t.addOrUpdateStore_({ dutchie_name: 'constructor' });
  ok(t.STORE_MAP.get('constructor') && t.STORES.length === 7, "'constructor' is just a name, not a prototype lookup");
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
