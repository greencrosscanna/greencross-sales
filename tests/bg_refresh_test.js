#!/usr/bin/env node
/* The background refresh keeps today's figure warm so opening the app reads a snapshot instead of
 * waiting on the Dutchie hop (Sky, 2026-09-17). Every way of getting it wrong looks fine on screen:
 *
 *   - pulling six stores one after another spends hours of the account's shared daily trigger quota;
 *   - writing to a different key, or without as_of, leaves the app pulling live anyway;
 *   - running overnight re-pulls closed stores all night;
 *   - a failed store that leaves its in-flight marker makes every viewer wait 25s for nothing.
 *
 * So this EXECUTES the shipped bgRefreshToday_ against fakes and then serves its output through the
 * shipped dutchieTodayFetch_ — the path a viewer actually takes. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grab(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(SRC);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs — renamed or removed?');
  let i = SRC.indexOf('{', m.index + 1), depth = 0, j = i;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (!depth) break; }
  }
  return SRC.slice(m.index, j + 1);
}
const constLine = n => { const m = new RegExp('\\nconst ' + n + '\\s*=\\s*[^;]+;').exec(SRC); if (!m) throw new Error('no const ' + n); return m[0]; };

let pass = 0, fail = 0;
function check(desc, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${desc}` + (ok ? '' : `  — got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`));
}

const STORES = ['Bend', 'Center', 'River'];
const TODAY = '2026-09-17';
let cache, nowMs, hourPT, fetchAllCalls, fetchCalls, fetchAllImpl, props, liveCalls, apiUrls, fetchImpl;

function reset() {
  cache = new Map(); nowMs = 1789000000000; hourPT = 12; fetchAllCalls = []; fetchCalls = 0;
  props = {}; liveCalls = 0; apiUrls = [];
  // Switch off (the default): the only single fetch allowed is none at all.
  fetchImpl = () => { throw new Error('bg refresh must not use single fetch'); };
  fetchAllImpl = reqs => reqs.map(r => {
    const store = decodeURIComponent(/store=([^&]*)/.exec(r.url)[1]);
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, rows: [{ store }] }) };
  });
}
reset();

const CACHE = {
  get(k) { const e = cache.get(k); return e ? e.v : null; },
  put(k, v) { cache.set(k, { v }); },
  putAll(o) { Object.keys(o).forEach(k => cache.set(k, { v: o[k] })); },
  remove(k) { cache.delete(k); },
};
const ctx = {
  console, CACHE, JSON, Math, Number, String, Array, Object, isFinite,
  Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(nowMs); } static now() { return nowMs; } },
  GXCORE_EXEC_: 'https://core.example/exec',
  Utilities: {
    formatDate(d, tz, fmt) {
      if (fmt === 'H') return String(Math.floor(hourPT));
      if (fmt === 'm') return String(Math.round((hourPT % 1) * 60));
      return TODAY;
    },
    sleep() {},
  },
  UrlFetchApp: {
    fetchAll(reqs) { fetchAllCalls.push(reqs); return fetchAllImpl(reqs); },
    fetch(url, o) { fetchCalls++; return fetchImpl(url, o); },
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k === 'GX_DEPLOY_SECRET' ? 's3cret' : (props[k] || null)),
    setProperty: (k, v) => { props[k] = v; },
  }) },
  salesStores_: () => STORES.map(s => ({ sales: s })),
  // The revenue math is Core's and tested elsewhere; here it only has to be recognizable.
  dtodayFromRows_: rows => ({ netSales: 10 * rows.length, store: rows[0] && rows[0].store }),
  dutchieTodayFetchLive_: () => { liveCalls++; return { netSales: -1 }; },
  errText_: e => (e && e.message) || String(e),
  probeMark_() {},
};
vm.createContext(ctx);
vm.runInContext([
  'const DTODAY_WAIT_MS_ = 0;', constLine('DTODAY_FLIGHT_TTL_'), constLine('DTODAY_FRESH_S_'),
  constLine('DTODAY_SNAPSHOT_S_'), constLine('DTODAY_KEEP_S_'), constLine('DTODAY_PATH_'),
  constLine('BG_REFRESH_STALE_S_'), constLine('BG_OPEN_HOUR_'), constLine('BG_QUIET_HOUR_'),
  constLine('BG_REFRESH_LAST_KEY_'), constLine('SALES_DATA_SOURCE_PROP_'), constLine('GX_API_'),
  constLine('GX_API_TODAY_MIN_AGE_S_'),
  grab('salesDataSource_'), grab('todayViaApi_'), grab('todayApiRefusal_'),
  grab('cacheGet_'), grab('cacheSet_'), grab('gxDeploySecret_'), grab('gxDutchieQs_'), grab('dtodayQuery_'),
  grab('dtodayKey_'), grab('dtodayAgeS_'), grab('bgInStoreHours_'), grab('bgRefreshToday_'), grab('bgRecord_'),
  grab('dtodayMaxAge_'), grab('dutchieTodayFetch_'), grab('dtodayAwaitFlight_'),
].join('\n'), ctx);

const run = force => vm.runInContext('bgRefreshToday_(' + (force ? 'true' : 'false') + ')', ctx);
const key = s => vm.runInContext(`dtodayKey_(${JSON.stringify(s)}, '${TODAY}')`, ctx);
const viewerOpen = s => vm.runInContext(`dutchieTodayFetch_(${JSON.stringify(s)}, '${TODAY}', 'x', null, dtodayMaxAge_('600'))`, ctx);

console.log('\nall due stores in ONE parallel batch — the trigger quota is shared and daily');
reset();
let r = run(false);
check('one fetchAll', fetchAllCalls.length, 1);
check('carrying every store', fetchAllCalls[0].length, STORES.length);
check('no single-request fetches', fetchCalls, 0);
check('every store pulled', r.pulled, STORES.length);

console.log('\nit writes the entry a viewer reads — same key, stamped, kept');
const ent = JSON.parse(cache.get(key('Bend')).v);
check('as_of is the run time', ent.as_of, nowMs);
nowMs += 5 * 60 * 1000;   // a viewer opens the app five minutes later
check('an open five minutes later is served the snapshot', viewerOpen('Bend').store, 'Bend');
check('...with no live pull of its own', liveCalls, 0);

console.log('\nit asks Dutchie the SAME question the on-demand pull does');
const u = fetchAllCalls[0][0].url;
check('dutchie_get on the transactions path', /action=dutchie_get/.test(u) && /path=%2Freporting%2Ftransactions/.test(u), true);
check('with the lastModified window', /fromLastModifiedDateUTC=2026-09-17T07%3A00%3A00Z/.test(u), true);
/* Dutchie's name for "include line items" is IncludeDetail. It silently ignores anything else, and
 * for as long as this sent `includeItems` every row came back with items:[] — today's COGS summed to
 * $0 and Gross Profit read "—" on the Today view (measured 2026-09-17). */
check('asks for line items by Dutchie\'s real name, IncludeDetail', /IncludeDetail=true/.test(u), true);
check('...and not by the name Dutchie ignores', /includeItems/i.test(u), false);
check('errors are not raised as HTTP exceptions (muteHttpExceptions)', fetchAllCalls[0][0].muteHttpExceptions, true);

console.log('\na fresh entry is left alone; a stale or missing one is pulled');
reset();
cache.set(key('Bend'), { v: JSON.stringify({ netSales: 1, as_of: nowMs - 60 * 1000 }) });      // 1 min old
cache.set(key('Center'), { v: JSON.stringify({ netSales: 1, as_of: nowMs - 10 * 60 * 1000 }) }); // 10 min old
r = run(false);
check('only the stale and missing stores are fetched', fetchAllCalls[0].map(q => decodeURIComponent(/store=([^&]*)/.exec(q.url)[1])), ['Center', 'River']);
check('the fresh one is reported, not pulled', r.stores.Bend.pulled, false);

console.log('\nnothing to do costs nothing');
reset();
STORES.forEach(s => cache.set(key(s), { v: JSON.stringify({ as_of: nowMs }) }));
run(false);
check('no fetch at all when every entry is fresh', fetchAllCalls.length, 0);

console.log('\na store a viewer is already pulling is skipped');
reset();
cache.set(key('River') + '__inflight', { v: String(nowMs) });
r = run(false);
check('River is not in the batch', fetchAllCalls[0].some(q => /store=River/.test(q.url)), false);
check('...and the summary says why', r.stores.River.note, 'a viewer is pulling it');

console.log('\nstore hours — closed stores are not re-pulled all night');
reset(); hourPT = 23;
r = run(false);
check('23:00 fetches nothing', fetchAllCalls.length, 0);
check('...and says so', r.skipped, 'outside store hours');
reset(); hourPT = 7.9;
run(false);
check('07:54 fetches nothing', fetchAllCalls.length, 0);
reset(); hourPT = 22.5;
run(false);
check('22:30 fetches nothing (the client pauses at 22:15 too)', fetchAllCalls.length, 0);
reset(); hourPT = 8;
run(false);
check('08:00 fetches', fetchAllCalls.length, 1);
reset(); hourPT = 23;
run(true);
check('force=1 runs outside store hours, for verifying', fetchAllCalls.length, 1);
check('the pause matches the client (22.25)', vm.runInContext('BG_QUIET_HOUR_', ctx), 22.25);

console.log('\none store failing does not cost the others, and never leaves a marker behind');
reset();
fetchAllImpl = reqs => reqs.map(q => /store=Center/.test(q.url)
  ? { getResponseCode: () => 404, getContentText: () => '<html>not found</html>' }
  : { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, rows: [{}] }) });
r = run(false);
check('two pulled', r.pulled, 2);
check('Center reports its error', /404/.test(r.stores.Center.error || ''), true);
check('Center got no entry (so a viewer pulls it live)', cache.has(key('Center')), false);
check('no in-flight marker survives', STORES.some(s => cache.has(key(s) + '__inflight')), false);

console.log('\na refusal from GX Core is reported, not cached');
reset();
fetchAllImpl = reqs => reqs.map(() => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: false, error: 'path not allowed' }) }));
r = run(false);
check('nothing pulled', r.pulled, 0);
check('the refusal text is kept', r.stores.Bend.error, 'path not allowed');

console.log('\nthe whole batch throwing still clears every marker');
reset();
fetchAllImpl = () => { throw new Error('Address unavailable'); };
r = run(false);
check('every store reports the failure', STORES.every(s => /Address unavailable/.test(r.stores[s].error || '')), true);
check('no marker survives', STORES.some(s => cache.has(key(s) + '__inflight')), false);

console.log('\nthe last run is recorded for ?action=bgrefresh&op=status');
check('summary persisted', JSON.parse(props.BG_REFRESH_LAST).stores.Bend.error !== undefined, true);

console.log('\nthe real parser on Dutchie-shaped rows: cost flows, nameless items do not become "Unknown"');
{
  const c2 = { GXCore: { salesFromTxns: txns => ({
    net: txns.reduce((s, t) => s + t.totalBeforeTax, 0), gross: 0, discount: 0, tax: 0, orders: txns.length,
    cogs: txns.reduce((s, t) => s + t.items.reduce((a, it) => a + it.unitCost * it.quantity, 0), 0) }) } };
  vm.createContext(c2);
  vm.runInContext(grab('dtodayFromRows_'), c2);
  // Exactly the item keys Dutchie returned 2026-09-17 with IncludeDetail=true: no productName.
  const tx = (id, cost) => ({ transactionId: id, transactionType: 'Retail', isVoid: false, totalBeforeTax: 20,
    transactionDateLocalTime: '2026-09-17T12:00:00',
    items: [{ productId: 7, sku: 'A1', quantity: 2, unitCost: cost, unitPrice: 10, totalPrice: 20 }] });
  c2.rows = [tx(1, 3), tx(2, 4)];
  const out = vm.runInContext("dtodayFromRows_(rows, '2026-09-17')", c2);
  check('line-item cost reaches the day\'s COGS', out.cost, 14);
  check('...and the per-day row', out.daily[0].cogs, 14);
  check('nameless items produce no "Unknown" top-product row', out.topProducts.length, 0);
  c2.rows[0].items[0].productName = 'Blue Dream 3.5g';
  const named = vm.runInContext("dtodayFromRows_(rows, '2026-09-17')", c2);
  check('a named item still ranks', named.topProducts.map(p => p.name), ['Blue Dream 3.5g']);
}

/* ── Switch on (SALES_DATA_SOURCE = api, roadmap [5] slice 4) ────────────────────────────────────
 * Each check names the fixture that would make it FAIL. */
console.log('\nswitch on: ONE gx-api call for the due stores; what it cannot vouch for goes to GX Core');
const apiRow = (store, over) => Object.assign({ date: TODAY, store, net: 1234.56, gross: 1300, discount: 65.44,
  tax: 222.22, cogs: 500.5, orders: 42, updated_at: new Date(nowMs - 60 * 1000).toISOString() }, over || {});
function apiOn(stores) {
  props.SALES_DATA_SOURCE = 'api';
  fetchImpl = (url, o) => {
    apiUrls.push({ url, headers: (o && o.headers) || {} });
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, stores: stores() }) };
  };
}
reset();
apiOn(() => ({ Bend: { ok: true, row: apiRow('bend'), age_s: 60 }, Center: { ok: true, row: apiRow('center'), age_s: 60 },
               River: { ok: true, row: apiRow('river-rd'), age_s: 60 } }));
r = run(false);
// Fails if the run asks gx-api once per store (three fetches) or not at all.
check('one gx-api request for all three', apiUrls.length, 1);
check('...naming every due store and the refresh age', /\/v1\/sales\/today\?stores=Bend%2CCenter%2CRiver&maxage=240$/.test(apiUrls[0].url), true);
// Fails if the secret is put in the URL, where it lands in logs.
check('...secret in a header, not the URL', apiUrls[0].headers['x-gx-secret'] === 's3cret' && !/s3cret/.test(apiUrls[0].url), true);
// Fails if gx-api's answers do not satisfy the run and GX Core is still asked.
check('GX Core not asked when gx-api vouched for every store', fetchAllCalls.length, 0);
check('all three pulled, via gx-api', [r.pulled, r.stores.Bend.via], [3, 'gx-api']);
const apiEnt = JSON.parse(cache.get(key('Bend')).v);
// Fails if the entry is stamped with OUR clock instead of gx-api's pull time (an old figure called new).
check('the cached entry carries gx-api\'s pull time, not ours', apiEnt.as_of, nowMs - 60 * 1000);
check('...in the shape the viewer reads', [apiEnt.netSales, apiEnt.cost, apiEnt.orders, apiEnt.daily[0].date, apiEnt.daily[0].tax], [1234.56, 500.5, 42, TODAY, 222.22]);
check('no in-flight marker survives', STORES.some(s => cache.has(key(s) + '__inflight')), false);

reset();
apiOn(() => ({
  Bend:   { ok: true, row: apiRow('bend'), age_s: 60 },
  Center: { ok: true, row: apiRow('center', { updated_at: new Date(nowMs - 30 * 60 * 1000).toISOString() }), age_s: 1800, stale: true, error: 'dutchie_http_429' },
  River:  { ok: true, row: apiRow('river-rd', { orders: 0, net: 0, gross: 0, discount: 0, tax: 0, cogs: 0 }), age_s: 60 },
}));
r = run(false);
// Fails if a stale copy or a zero day mid-afternoon is accepted: that is a LOW figure on screen.
check('stale and zero-day stores go to GX Core', fetchAllCalls[0].map(q => decodeURIComponent(/store=([^&]*)/.exec(q.url)[1])), ['Center', 'River']);
check('...the good one does not', r.stores.Bend.via, 'gx-api');
check('...and the fallbacks are pulled the old way', [r.stores.Center.pulled, r.stores.River.pulled, r.stores.River.via], [true, true, undefined]);

reset();
props.SALES_DATA_SOURCE = 'api';
fetchImpl = () => ({ getResponseCode: () => 503, getContentText: () => '{"ok":false}' });
r = run(false);
// Fails if a gx-api outage costs a store its figure instead of falling back.
check('gx-api down: every store still pulled through GX Core', [fetchAllCalls.length, fetchAllCalls[0].length, r.pulled], [1, 3, 3]);

reset();
props.SALES_DATA_SOURCE = 'api';
fetchImpl = () => { throw new Error('Address unavailable'); };
r = run(false);
check('gx-api unreachable: same', r.pulled, 3);

reset();   // switch off again: not one byte to gx-api
r = run(false);
check('switch off: gx-api never called', fetchCalls, 0);

console.log('\nthe trigger is wired');
check('the handler name is a real public function',
  new RegExp('\\nfunction ' + /const BG_REFRESH_HANDLER_\s*=\s*'([^']+)'/.exec(SRC)[1] + '\\s*\\(').test(SRC), true);
check('the handler is not private (a trigger cannot call name_)', /const BG_REFRESH_HANDLER_\s*=\s*'[^']*[^_]'/.test(SRC), true);
check('the route exists and is secret-gated',
  /params\.action === 'bgrefresh'\) \{\s*const secret = PropertiesService[^\n]*\n\s*if \(!secret \|\| params\.secret !== secret\) return jsonOut_\(\{ ok: false, error: 'Forbidden' \}\)/.test(SRC), true);
check('the snapshot a run writes lives longer than the gap between runs',
  vm.runInContext('DTODAY_KEEP_S_', ctx) > Number(/const BG_REFRESH_EVERY_MIN_\s*=\s*(\d+)/.exec(SRC)[1]) * 60 * 2, true);
check('a run refreshes before an open would refuse the entry',
  vm.runInContext('BG_REFRESH_STALE_S_ < DTODAY_SNAPSHOT_S_', ctx), true);

console.log('\n──────────────────────────────');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
