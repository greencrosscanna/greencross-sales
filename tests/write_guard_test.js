#!/usr/bin/env node
/* ─── writeGuard_ — tests ─────────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/write_guard_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THIS FUNCTION
 * It is the only thing standing between a signed-in user and this app's four writes, it is LIVE in
 * `enforce`, and it FAILS CLOSED — including on a GX Core error. That last part is deliberate
 * (failing open on an auth check is no check) but it means a Core hiccup and a revoked grant are the
 * same observable event: writes stop. So the cases below care as much about WHEN it refuses as that
 * it refuses, because a guard that over-refuses looks exactly like an outage.
 *
 * The three modes are not decoration either. `log` shipped first precisely so a real non-superadmin
 * admit could be observed before anything was enforced, and `off` is the rollback. A regression that
 * silently collapsed them would be invisible until someone was locked out.
 *
 * Loads the real dutchie_proxy.gs with Apps Script globals stubbed, so it tests shipped source.
 * Excluded from the clasp push by .claspignore.
 */
'use strict';
const fs = require('fs');

let PROPS = {};
let GXCORE = null;                       // set per-case: null = unbound, {} = bound without roleForApp
const base = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null),
    setProperty: (k, v) => { PROPS[k] = String(v); },
  })},
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  // formatDate is NOT optional. recordGuard_ calls it, and the whole ring write sits inside a
  // try/catch — so an incomplete Utilities stub throws, gets swallowed, and the ring silently stays
  // empty while every other assertion passes. That is the same swallowed-exception shape as the
  // Leaderboard cache bug this suite exists to catch; it briefly looked like a product bug here too.
  Utilities:{ formatDate: () => '2026-08-22T12:00:00' },
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
};

function load(gxcore) {
  const stubs = Object.assign({}, base, { GXCore: gxcore });
  const names = Object.keys(stubs);
  try {
    return new Function(...names, fs.readFileSync(__dirname + '/../dutchie_proxy.gs','utf8') +
      '\n; return { writeGuard_ };')(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: dutchie_proxy.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `base`. Do not let this pass quietly.');
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const reset = mode => { PROPS = {}; if (mode) PROPS['GX_WRITE_GUARD'] = mode; };
// roleCanEdit mirrors GX Core's GX_EDIT_ROLES allowlist (gx_core.gs) — own-key, unknown roles read-only.
const EDIT_ROLES = { editor: 1, admin: 1, director: 1, manager: 1 };
const canEditFn = r => Object.prototype.hasOwnProperty.call(EDIT_ROLES, String(r || '').toLowerCase());
const roleFn = table => ({ roleForApp: (u, app) => (app === 'sales' ? (table[u] || null) : null), roleCanEdit: canEditFn });

// ── 1. enforce: the live configuration ───────────────────────────────────────
console.log('\n1. enforce — a granted user writes, an ungranted one does not');
{
  const S = load(roleFn({ shawn: 'editor', sky: 'admin' }));
  reset('enforce');
  const granted = S.writeGuard_('shawn', 'save_expense_mapping');
  ok(granted.ok === true, 'a granted non-superadmin is admitted');
  ok(granted.role === 'editor', 'and its role is reported');

  const nobody = S.writeGuard_('nobody', 'set_revenue');
  ok(nobody.ok === false, 'an ungranted user is refused');
  ok(nobody.code === 'no_access', 'with a machine-readable code');
  ok(/No access/.test(nobody.error), 'and a message naming the reason');
}

console.log('\n2. enforce — case and whitespace must not decide access');
{
  const S = load(roleFn({ shawn: 'editor' }));
  reset('enforce');
  ok(S.writeGuard_('  SHAWN  ', 'set_revenue').ok === true, '"  SHAWN  " resolves to shawn');
  ok(S.writeGuard_('Shawn', 'set_revenue').ok === true, 'mixed case resolves');
}

// ── 2b. THE BUG: a role is not permission to write ─────────────────────────────
console.log('\n2b. enforce — a VIEWER grant is refused (bug: any role used to admit every write)');
{
  const S = load(roleFn({ vic: 'viewer', odd: 'constructor', mgr: 'manager', sky: 'admin' }));
  reset('enforce');
  const v = S.writeGuard_('vic', 'set_revenue');
  ok(v.ok === false, 'a viewer is refused a write');
  ok(v.code === 'read_only', 'with code read_only — not no_access, the grant is real');
  ok(/read-only/i.test(v.error), 'and a message saying the access is read-only');
  ok(S.writeGuard_('odd', 'set_recon').ok === false, 'an unknown role fails safe to read-only');
  ok(S.writeGuard_('mgr', 'apply_budget').ok === true, 'a manager is admitted');
  ok(S.writeGuard_('sky', 'apply_budget').ok === true, 'the superadmin (admin) is admitted');

  const M = load({ roleForApp: () => 'editor' });   // pin without roleCanEdit
  reset('enforce');
  const m = M.writeGuard_('shawn', 'set_revenue');
  ok(m.ok === false, 'a pin without roleCanEdit refuses rather than trusting the role');
  ok(/unavailable/i.test(m.error), 'and says the check is unavailable');

  const T = load({ roleForApp: () => 'editor', roleCanEdit: () => { throw new Error('boom'); } });
  reset('enforce');
  ok(T.writeGuard_('shawn', 'set_revenue').ok === false, 'a throwing roleCanEdit fails closed');

  reset('log');
  const L = S.writeGuard_('vic', 'set_revenue');
  ok(L.ok === true && L.would_refuse === true, 'log mode admits a viewer but records would_refuse');
  const tally = JSON.parse(PROPS['GX_WRITE_GUARD_TALLY'] || '{}');
  ok(tally.refused_read_only === 1 && !tally.admitted, 'the tally counts it as refused_read_only, never admitted');
}

// ── 3. THE fail-closed case ──────────────────────────────────────────────────
console.log('\n3. enforce — a GX Core ERROR refuses, and says something different');
{
  const S = load({ roleForApp: () => { throw new Error('Core exploded'); } });
  reset('enforce');
  const r = S.writeGuard_('shawn', 'set_revenue');
  ok(r.ok === false, 'a throwing Core refuses the write — fail CLOSED, deliberately');
  ok(/unavailable/i.test(r.error), 'and reports "unavailable", NOT "no access"');
  ok(!/No access/.test(r.error),
     'the two are distinguishable — a Core outage must not read as a revoked grant');
}

console.log('\n4. enforce — an unbound or wrong-pin GXCore also refuses');
{
  let S = load(null);
  reset('enforce');
  ok(S.writeGuard_('shawn', 'set_revenue').ok === false, 'GXCore unbound refuses');
  S = load({});                                   // bound, but the pin predates roleForApp
  reset('enforce');
  const r = S.writeGuard_('shawn', 'set_revenue');
  ok(r.ok === false, 'a pin with no roleForApp refuses rather than assuming access');
}

// ── 5. log mode — the state that licensed enforcing ─────────────────────────
console.log('\n5. log — records the decision WITHOUT acting on it');
{
  const S = load(roleFn({ shawn: 'editor' }));
  reset('log');
  const refused = S.writeGuard_('nobody', 'set_revenue');
  ok(refused.ok === true, 'an ungranted user is still ALLOWED through in log mode');
  ok(refused.would_refuse === true, 'but the decision is recorded as would_refuse');
  const admitted = S.writeGuard_('shawn', 'set_revenue');
  ok(admitted.would_refuse === false, 'and an admit is recorded as would_refuse:false');
  ok(admitted.role === 'editor', 'with the resolved role — the evidence that licenses enforcing');
}

console.log('\n6. log is the DEFAULT when the property is unset');
{
  const S = load(roleFn({}));
  reset(null);
  const r = S.writeGuard_('nobody', 'set_revenue');
  ok(r.mode === 'log', 'no GX_WRITE_GUARD set => log');
  ok(r.ok === true, 'so an unset property cannot accidentally lock everyone out');
}

// ── 7. off — the rollback ────────────────────────────────────────────────────
console.log('\n7. off — short-circuits before Core is consulted at all');
{
  let called = false;
  const S = load({ roleForApp: () => { called = true; return null; } });
  reset('off');
  const r = S.writeGuard_('nobody', 'set_revenue');
  ok(r.ok === true, 'off admits everyone');
  ok(called === false, 'and never calls Core — so a Core outage cannot make "off" fail');
}

// ── 8. the guard ring ────────────────────────────────────────────────────────
console.log('\n8. decisions are written to the log ring');
{
  const S = load(roleFn({ shawn: 'editor' }));
  reset('enforce');
  S.writeGuard_('shawn', 'save_expense_mapping');
  S.writeGuard_('nobody', 'set_revenue');
  const ring = JSON.parse(PROPS['GX_WRITE_GUARD_LOG'] || '[]');
  ok(ring.length >= 2, 'both decisions recorded');
  ok(ring.some(e => e.role === 'editor'), 'the ADMIT is in the ring, not just refusals');
  ok(ring.some(e => e.role === null), 'and the refusal too');
  ok(ring.length <= 25, 'the ring stays capped');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
