#!/usr/bin/env node
/* THE GATE MUST ACCEPT THE NAMES THE FRONTEND ACTUALLY SENDS.
 *
 * index.html asks the proxy for one store at a time — `?store=River` — using its own internal
 * names. dutchie_proxy.gs decides whether that name is a store at all, in knownStore_, and anything
 * it refuses comes back as "Unknown store: X". A refused store is not an error the reader sees: the
 * status grid marks it red, the pill says 5/6, and every figure on every tab is quietly short one
 * store. The company reads a smaller number and nothing says why.
 *
 * That is exactly what happened on 2026-08-31. The store vocabulary used to be the KEYS of this
 * app's own Dutchie credential map — Sales' internal names, `River` among them. Moving the keys
 * into GX Core replaced the list with the registry's `dutchie_name` values. Five of six stores are
 * spelled identically in both, so five kept working; River Rd is the one store whose two names
 * differ, and it went blank on every load.
 *
 * The lesson is not "remember River". It is that the two lists are maintained in different repos by
 * different people and NOTHING compared them. This test compares them: every name in index.html's
 * STORES array is run through the SHIPPED knownStore_ against a registry that spells things the way
 * GX Core does. It executes the real function rather than restating the rule, so renaming or
 * re-tightening the gate fails here instead of in production.
 *
 * The prototype guard is asserted alongside, because the fix widens the gate and that is precisely
 * when an inherited name ('constructor', 'toString') sneaks back through — the reason the exact
 * array test replaced `if (MAP[store])` in the first place.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const GS   = fs.readFileSync(path.join(ROOT, 'dutchie_proxy.gs'), 'utf8');

/* gxScrub_'s pattern is BUILT from AUTH_PARAM_NAMES_ — the same array the auth check reads — so the
 * declarations have to come into the context with it. Lifted from the source, never retyped: a copy
 * here would be a third hand-maintained list of the names, which is the defect that made this. */
const SCRUB_DECLS = (/const AUTH_PARAM_NAMES_[\s\S]*?'gi'\);/.exec(GS) || [''])[0];

const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

// ── The frontend's side: the names index.html will actually put on the wire ────────────────────
const STORES_SRC = /const STORES = \[[\s\S]*?\];/.exec(HTML);
if (!STORES_SRC) { console.log('STORES is gone from index.html'); console.log('\n0 passed, 1 failed'); process.exit(1); }
const fctx = {}; vm.createContext(fctx);
vm.runInContext(STORES_SRC[0] + '; var NAMES = STORES.map(function(s){return s.name;});', fctx);
const FRONTEND = fctx.NAMES;

ok('index.html still declares six stores', FRONTEND.length === 6);

// ── The registry's side: GX Core's `dutchie_name` spellings, and how it folds a name to a store_id.
// Measured 2026-08-31 from the live app (?action=storekeys) and from GX Core's own dutchie_get,
// which resolved BOTH `River` and `River Rd` to store_id `river-rd`.
// The registry ROWS, the shape GXCore.getStores() actually returns — store_id and dutchie_name on
// the same row. That pairing is the point: gxStoreIds_ reads the ids off these rows rather than
// asking resolveStore for each one, so the id list cannot lose a store to a transient.
const ROWS = [
  { store_id: 'bend',        dutchie_name: 'Bend' },
  { store_id: 'center',      dutchie_name: 'Center' },
  { store_id: 'commercial',  dutchie_name: 'Commercial' },
  { store_id: 'hillsboro',   dutchie_name: 'Hillsboro' },
  { store_id: 'portland-rd', dutchie_name: 'Portland Rd' },
  { store_id: 'river-rd',    dutchie_name: 'River Rd' },
];
const REGISTRY = ROWS.map(r => r.dutchie_name);
const FOLD = {              // what GXCore.resolveStore answers, for the names this test asks about
  'bend': 'bend', 'center': 'center', 'commercial': 'commercial', 'hillsboro': 'hillsboro',
  'portland rd': 'portland-rd', 'portland': 'portland-rd',
  'river rd': 'river-rd', 'river': 'river-rd',
};

let resolveCalls = 0;       // how many times the gate reaches the registry's folding
let resolveThrows = false;  // simulate a GX Core hiccup on the second chance

function buildCtx() {
  const store = {};
  const ctx = {
    console,
    // The script cache, faked with a plain map. Real CacheService is shared across executions and
    // viewers, which is exactly why the memo belongs there and not in a module variable.
    cacheGet_: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    cacheSet_: (k, v) => { store[k] = String(v); },
    _cacheStore: store,
    GXCore: {
      getStores() { return ROWS.map(r => ({ store_id: r.store_id, dutchie_name: r.dutchie_name })); },
      resolveStore(name) {
        resolveCalls++;
        if (resolveThrows) throw new Error('GX Core hiccup');
        // Deliberately a null-prototype lookup with an own-property check: the real registry cannot
        // answer for an inherited name either, and a plain object here would hand the gate a
        // function and hide the very regression this test exists to catch.
        const k = String(name).trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(FOLD, k)) return null;
        return { store_id: FOLD[k], dutchie_name: name };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;', ctx);
  /* The REAL scrub, not a stub: every exception this suite drives now also proves the
     credential scrub runs on the way out. See gxScrub_ in dutchie_proxy.gs. */
  vm.runInContext(SCRUB_DECLS + '\n' + grab(GS, 'gxScrub_') + '\n' + grab(GS, 'errText_'), ctx);
  vm.runInContext('let _gxStoreRegistry_ = null; let _gxStoreNames_ = null; let _gxStoreIds_ = null;', ctx);
  vm.runInContext(grab(GS, 'gxStoreRegistry_'), ctx);
  vm.runInContext(grab(GS, 'gxStoreNames_'), ctx);
  vm.runInContext(grab(GS, 'gxStoreIds_'), ctx);
  vm.runInContext(grab(GS, 'storeGate_'), ctx);
  vm.runInContext(grab(GS, 'knownStore_'), ctx);
  return ctx;
}
const ctx = buildCtx();

// ── Every store the frontend asks for must pass ────────────────────────────────────────────────
FRONTEND.forEach(name => {
  ok('the gate accepts "' + name + '" — the name index.html sends', ctx.knownStore_(name) === true);
});

// The specific one that broke, called out so a future rename cannot quietly retire the coverage.
ok('"River" passes even though the registry spells it "River Rd"', ctx.knownStore_('River') === true);
ok('"River Rd" — the registry spelling — still passes too', ctx.knownStore_('River Rd') === true);
ok('the two spellings are NOT the same string, which is the whole hazard',
   FRONTEND.indexOf('River') !== -1 && REGISTRY.indexOf('River') === -1);

// ── and nothing else may ───────────────────────────────────────────────────────────────────────
['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'].forEach(n => {
  ok('an inherited name is refused: ' + n, ctx.knownStore_(n) === false);
});
ok('an unknown store is refused', ctx.knownStore_('Springfield') === false);
ok('an empty name is refused', ctx.knownStore_('') === false);

// An alias the registry folds onto one of our six is fine — that is the whole point of asking the
// registry instead of matching strings. What must not pass is a name that folds to a store_id the
// registry does not list, which is the direction a widened gate goes wrong.
ok('a registry ALIAS of a real store is accepted ("Portland" → portland-rd)',
   ctx.knownStore_('Portland') === true);


// ── The asymmetry itself: what River pays that the other five do not ──────────────────────────
// Five names match the registry list by string on the gate's first line and never reach the
// registry's folding at all. `River` reaches it on every request. That is not a fairness
// complaint — every call it makes is a call that can fail, and each one is a way for this store
// alone to come back "Unknown store" while its neighbors are fine.
{
  const c = buildCtx();
  resolveCalls = 0;
  ['Bend', 'Center', 'Commercial', 'Hillsboro', 'Portland Rd'].forEach(n => c.knownStore_(n));
  ok('the five exact names never reach resolveStore at all', resolveCalls === 0);

  resolveCalls = 0;
  c.knownStore_('River');
  ok('"River" reaches it exactly once — not once per store in the registry', resolveCalls === 1);
}

// The regression this rewrite is for: gxStoreIds_ used to call resolveStore once PER STORE and
// swallow each failure, so one hiccup dropped an id — and knownStore_ accepts a resolved name only
// when its id is in that list. Reading the ids off the registry rows makes the list unloseable.
{
  const c = buildCtx();
  ok('the id list is the registry\'s own, complete', c.gxStoreIds_().length === ROWS.length);
  ok('...and it contains river-rd, the id "River" has to match', c.gxStoreIds_().indexOf('river-rd') !== -1);
}

// ── A hiccup is not a vocabulary error ────────────────────────────────────────────────────────
// This is the whole point of storeGate_. Returning false here is what made a transient GX Core
// failure render as "Unknown store: River" — permanent-sounding, and indistinguishable from the
// real 2026-08-31 outage. It must THROW, so the caller retries it the way it retries any other
// transport failure, which is what already happens to the other five stores.
{
  const c = buildCtx();
  resolveThrows = true;
  let threw = false, msg = '';
  try { c.knownStore_('River'); } catch (e) { threw = true; msg = e.message; }
  resolveThrows = false;
  ok('a registry hiccup THROWS rather than answering "unknown"', threw === true);
  ok('...and the message names the registry, not the store', /registry unreachable/i.test(msg));
}

// ...and a real miss still answers cleanly rather than throwing, or every typo becomes an outage.
{
  const c = buildCtx();
  let threw = false;
  try { ok('a genuinely unknown name is still just false', c.knownStore_('Springfield') === false); }
  catch (e) { threw = true; }
  ok('...without throwing', threw === false);
}

// ── The memo: one lookup per name per TTL, shared across viewers ──────────────────────────────
{
  const c = buildCtx();
  resolveCalls = 0;
  c.knownStore_('River'); c.knownStore_('River'); c.knownStore_('River');
  ok('three requests for "River" cost ONE resolveStore', resolveCalls === 1);
  ok('...and the memo lives in the script cache, not a module variable',
     Object.keys(c._cacheStore).some(k => k.indexOf('storeid_v1_River') === 0));
}

// A throw must never be cached — nothing was learned, and a cached failure would outlive the hiccup.
{
  const c = buildCtx();
  resolveThrows = true;
  try { c.knownStore_('River'); } catch (e) {}
  resolveThrows = false;
  ok('a hiccup writes nothing to the memo', Object.keys(c._cacheStore).length === 0);
  ok('...so the very next request resolves normally', c.knownStore_('River') === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
