#!/usr/bin/env node
/* ─── writeGuard_ — tests ─────────────────────────────────────────────────────────────────────────
 *
 *   RUN:  node tests/write_guard_test.js     (from the repo root; no deps, no network, no credentials)
 *
 * WHY THIS FUNCTION
 * It is the only thing standing between a signed-in user and this app's writes, it is LIVE in
 * `enforce`, and it FAILS CLOSED — including on a GX Core error. That last part is deliberate
 * (failing open on an auth check is no check) but it means a Core hiccup and a revoked grant are the
 * same observable event: writes stop. So the cases below care as much about WHEN it refuses as that
 * it refuses, because a guard that over-refuses looks exactly like an outage.
 *
 * SINCE SLICE 6 (2026-11-25) the grant comes from GX Core's LIVE verify route over POST, not from the
 * pinned library — so a role fix in Core reaches Sales without a re-pin. These cases fake that route
 * at UrlFetchApp, the real boundary, so the shipped gxCorePost_ and coreRoleForSession_ run too.
 *
 * Loads the real dutchie_proxy.gs with Apps Script globals stubbed, so it tests shipped source.
 * Excluded from the clasp push by .claspignore.
 */
'use strict';
const fs = require('fs');

let PROPS = {};
let CORE = null;            // per case: body -> Core's answer (object), a raw string, or an Error to throw
let CALLS = [];
let CACHE_MAP = null;       // null = a cache that never hits; {} = a working cache
const base = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null),
    setProperty: (k, v) => { PROPS[k] = String(v); },
  })},
  SpreadsheetApp:{}, DriveApp:{}, HtmlService:{}, ContentService:{},
  UrlFetchApp: { fetch(url, opts) {
    CALLS.push({ url, opts });
    const ans = CORE(JSON.parse(opts.payload));
    if (ans instanceof Error) throw ans;
    return { getContentText: () => (typeof ans === 'string' ? ans : JSON.stringify(ans)), getResponseCode: () => 200 };
  }},
  // formatDate is NOT optional. recordGuard_ calls it, and the whole ring write sits inside a
  // try/catch — so an incomplete Utilities stub throws, gets swallowed, and the ring silently stays
  // empty while every other assertion passes.
  Utilities:{ formatDate: () => '2026-08-22T12:00:00', sleep(){},
              DigestAlgorithm: { SHA_256: 'sha256' },
              computeDigest: (alg, s) => Array.from(require('crypto').createHash('sha256').update(String(s)).digest()) },
  CacheService:{ getScriptCache: () => ({
    get: k => (CACHE_MAP && k in CACHE_MAP ? CACHE_MAP[k] : null),
    put: (k, v) => { if (CACHE_MAP) CACHE_MAP[k] = v; },
    putAll: o => { if (CACHE_MAP) Object.assign(CACHE_MAP, o); },
    getAll: ks => { const o = {}; ks.forEach(k => { if (CACHE_MAP && k in CACHE_MAP) o[k] = CACHE_MAP[k]; }); return o; },
    remove(){},
  }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  GXCore: { roleForApp() { throw new Error('the pinned library must not be asked any more'); },
            roleCanEdit() { throw new Error('the pinned library must not be asked any more'); } },
};

function load() {
  const names = Object.keys(base);
  try {
    return new Function(...names, fs.readFileSync(__dirname + '/../dutchie_proxy.gs','utf8') +
      '\n; return { writeGuard_ };')(...names.map(n => base[n]));
  } catch (e) {
    console.error('LOAD FAILED: dutchie_proxy.gs did not evaluate under stubs — ' + e.message);
    console.error('Add the missing global to `base`. Do not let this pass quietly.');
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const reset = mode => { PROPS = {}; CALLS = []; CACHE_MAP = null; if (mode) PROPS['GX_WRITE_GUARD'] = mode; };
// What GX Core's verify answers. canEdit is CORE's roleCanEdit — mirrored here only to build fixtures.
const EDIT_ROLES = { editor: 1, admin: 1, director: 1, manager: 1 };
const canEditFn = r => Object.prototype.hasOwnProperty.call(EDIT_ROLES, String(r || '').toLowerCase());
const coreFrom = table => b => {
  if (b.action !== 'verify') return { ok: false, error: 'unexpected action ' + b.action };
  const u = String(b.token || '').replace(/^tok:/, '');
  const role = b.app === 'sales' && Object.prototype.hasOwnProperty.call(table, u) ? table[u] : null;
  return role ? { ok: true, user: u, app: 'sales', role, canEdit: canEditFn(role) }
              : { ok: false, error: 'No access to sales', code: 'no_access', user: u };
};
const A = u => ({ ok: true, user: u, token: 'tok:' + u });   // requireAuth_'s answer
const S = load();

console.log('\n1. enforce — a granted user writes, an ungranted one does not');
{
  reset('enforce'); CORE = coreFrom({ shawn: 'editor', sky: 'admin' });
  const granted = S.writeGuard_(A('shawn'), 'save_expense_mapping');
  ok(granted.ok === true, 'a granted non-superadmin is admitted');
  ok(granted.role === 'editor', 'and its role is reported');
  const nobody = S.writeGuard_(A('nobody'), 'set_revenue');
  ok(nobody.ok === false, 'an ungranted user is refused');
  ok(nobody.code === 'no_access', 'with a machine-readable code');
  ok(/No access/.test(nobody.error), 'and a message naming the reason');
}

console.log('\n2. Core is asked with the SESSION, by POST, and nothing secret is in the URL');
{
  reset('enforce'); CORE = coreFrom({ shawn: 'editor' });
  S.writeGuard_(A('shawn'), 'set_revenue');
  const c = CALLS[0] || { url: '', opts: {} };
  const body = c.opts.payload ? JSON.parse(c.opts.payload) : {};
  ok(c.opts.method === 'post', 'a POST');
  ok(body.action === 'verify' && body.app === 'sales' && body.token === 'tok:shawn', 'verify, for sales, with the session itself');
  ok(!/tok:shawn|token=|secret=/.test(c.url), 'the URL carries neither the session nor a secret');
  ok(!('secret' in body), 'and verify is sent without the deploy secret — the session is the credential');
}

console.log('\n2b. enforce — a VIEWER grant is refused (bug: any role used to admit every write)');
{
  reset('enforce'); CORE = coreFrom({ vic: 'viewer', odd: 'constructor', mgr: 'manager', sky: 'admin' });
  const v = S.writeGuard_(A('vic'), 'set_revenue');
  ok(v.ok === false, 'a viewer is refused a write');
  ok(v.code === 'read_only', 'with code read_only — not no_access, the grant is real');
  ok(/read-only/i.test(v.error), 'and a message saying the access is read-only');
  ok(S.writeGuard_(A('odd'), 'set_recon').ok === false, 'an unknown role fails safe to read-only');
  ok(S.writeGuard_(A('mgr'), 'apply_budget').ok === true, 'a manager is admitted');
  ok(S.writeGuard_(A('sky'), 'apply_budget').ok === true, 'the superadmin (admin) is admitted');

  // Core's canEdit is the ONLY edit test. A fixture where Core names an edit role but does not say
  // canEdit:true fails any version that re-derives it locally or reads it as merely truthy.
  reset('enforce'); CORE = () => ({ ok: true, user: 'shawn', role: 'editor', canEdit: 'true' });
  ok(S.writeGuard_(A('shawn'), 'set_revenue').ok === false, 'canEdit must be Core\'s boolean true, not a truthy string');
  reset('enforce'); CORE = () => ({ ok: true, user: 'shawn', role: 'editor' });
  ok(S.writeGuard_(A('shawn'), 'set_revenue').ok === false, 'a verify answer with no canEdit does not admit');

  reset('log'); CORE = coreFrom({ vic: 'viewer' });
  const L = S.writeGuard_(A('vic'), 'set_revenue');
  ok(L.ok === true && L.would_refuse === true, 'log mode admits a viewer but records would_refuse');
  const tally = JSON.parse(PROPS['GX_WRITE_GUARD_TALLY'] || '{}');
  ok(tally.refused_read_only === 1 && !tally.admitted, 'the tally counts it as refused_read_only, never admitted');
}

console.log('\n3. enforce — a GX Core ERROR refuses, and says something different');
{
  const cases = [
    ['Core unreachable (throws)',               () => new Error('Address unavailable')],
    ['Core answers HTML, not JSON',             () => '<html>Sorry</html>'],
    ['Core rejects the session this app accepted', () => ({ ok: false, error: 'Invalid session', code: 'invalid_session' })],
    ['Core says ok but names no role',          () => ({ ok: true, user: 'shawn' })],
  ];
  cases.forEach(([label, core]) => {
    reset('enforce'); CORE = core;
    const r = S.writeGuard_(A('shawn'), 'set_revenue');
    ok(r.ok === false && /unavailable/i.test(r.error) && !/No access/.test(r.error),
       label + ' => refused as "unavailable", never as "no access"');
  });
  const ring = JSON.parse(PROPS['GX_WRITE_GUARD_LOG'] || '[]');
  ok(ring.length && ring[ring.length - 1].err, 'and the error is in the ring, so an outage is visible as one');
}

console.log('\n4. the pinned library is not asked at all');
{
  reset('enforce'); CORE = coreFrom({ shawn: 'editor' });
  // base.GXCore throws on every call; reaching it would turn this admit into an error.
  ok(S.writeGuard_(A('shawn'), 'set_revenue').ok === true, 'admitted with a GXCore whose role functions throw');
  const src = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  ok(!/GXCore\.(roleForApp|roleCanEdit|login|gxIngestBug)\s*\(/.test(src.replace(/if \(params\.action === 'authprobe'\)[\s\S]*?return jsonOut_\(out\);\s*\}/, '')),
     'no sign-in, role or bug-filing call to the library is left (authprobe\'s diagnostic aside)');
}

console.log('\n5. log — records the decision WITHOUT acting on it');
{
  reset('log'); CORE = coreFrom({ shawn: 'editor' });
  const refused = S.writeGuard_(A('nobody'), 'set_revenue');
  ok(refused.ok === true, 'an ungranted user is still ALLOWED through in log mode');
  ok(refused.would_refuse === true, 'but the decision is recorded as would_refuse');
  const admitted = S.writeGuard_(A('shawn'), 'set_revenue');
  ok(admitted.would_refuse === false, 'and an admit is recorded as would_refuse:false');
  ok(admitted.role === 'editor', 'with the resolved role — the evidence that licenses enforcing');
}

console.log('\n6. log is the DEFAULT when the property is unset');
{
  reset(null); CORE = coreFrom({});
  const r = S.writeGuard_(A('nobody'), 'set_revenue');
  ok(r.mode === 'log', 'no GX_WRITE_GUARD set => log');
  ok(r.ok === true, 'so an unset property cannot accidentally lock everyone out');
}

console.log('\n7. off — short-circuits before Core is consulted at all');
{
  reset('off'); CORE = () => { throw new Error('must not be called'); };
  const r = S.writeGuard_(A('nobody'), 'set_revenue');
  ok(r.ok === true, 'off admits everyone');
  ok(CALLS.length === 0, 'and never calls Core — so a Core outage cannot make "off" fail');
}

console.log('\n8. the answer is cached per session for a minute; an error never is');
{
  reset('enforce'); CACHE_MAP = {}; CORE = coreFrom({ shawn: 'editor' });
  S.writeGuard_(A('shawn'), 'set_revenue'); S.writeGuard_(A('shawn'), 'set_recon');
  ok(CALLS.length === 1, 'two saves in a row cost one call to Core');
  ok(!Object.keys(CACHE_MAP).some(k => /tok:shawn/.test(k) || /tok:shawn/.test(CACHE_MAP[k])), 'the cache key and value hold a hash, never the session');
  S.writeGuard_(A('vic'), 'set_revenue');
  ok(CALLS.length === 2, 'a different session is asked about separately');

  reset('enforce'); CACHE_MAP = {}; CORE = () => new Error('down');
  S.writeGuard_(A('shawn'), 'set_revenue');
  const n = CALLS.length;
  CORE = coreFrom({ shawn: 'editor' });
  ok(S.writeGuard_(A('shawn'), 'set_revenue').ok === true && CALLS.length === n + 1, 'after an outage the next save asks again and is admitted');
}

console.log('\n9. decisions are written to the log ring');
{
  reset('enforce'); CORE = coreFrom({ shawn: 'editor' });
  S.writeGuard_(A('shawn'), 'save_expense_mapping');
  S.writeGuard_(A('nobody'), 'set_revenue');
  const ring = JSON.parse(PROPS['GX_WRITE_GUARD_LOG'] || '[]');
  ok(ring.length >= 2, 'both decisions recorded');
  ok(ring.some(e => e.role === 'editor' && e.user === 'shawn'), 'the ADMIT is in the ring, with the user, not just refusals');
  ok(ring.some(e => e.role === null), 'and the refusal too');
  ok(ring.length <= 25, 'the ring stays capped');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
