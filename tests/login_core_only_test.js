#!/usr/bin/env node
/* ─── loginUser / pingSession_ — sign-in goes through GX Core only ───────────────────────────────
 *
 *   RUN:  node tests/login_core_only_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Until 2026-09-14 a refusal from GXCore.login fell through to this app's own password store
 * (gc_sales_users), so an old Sales password for `sky` kept working after the Command Center password
 * changed. And the 10-minute ping minted a fresh 7-day token from a signature alone, so someone removed
 * in the Command Center stayed signed in for as long as their tab was open.
 *
 * The cases hold BOTH halves: the removed person is refused, AND a Core hiccup does not sign everyone
 * out of a renewal. A fix that only asserted the first would read green while logging the office out
 * every time GX Core bounced.
 *
 * Loads the real dutchie_proxy.gs with Apps Script globals stubbed, so it tests shipped source.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');

let PROPS = {};
const SECRET = 'test-session-secret';
const base = {
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => (k in PROPS ? PROPS[k] : null),
    setProperty: (k, v) => { PROPS[k] = String(v); },
  })},
  SpreadsheetApp:{}, DriveApp:{}, UrlFetchApp:{}, HtmlService:{}, ContentService:{},
  Utilities: {
    formatDate: () => '2026-09-14T12:00:00',
    getUuid: () => 'uuid',
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(String(s)).digest()],
    computeHmacSha256Signature: (payload, key) => [...crypto.createHmac('sha256', key).update(payload).digest()],
    base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  },
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
};

function load(gxcore) {
  const stubs = Object.assign({}, base, { GXCore: gxcore });
  const names = Object.keys(stubs);
  try {
    return new Function(...names, fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8') +
      '\n; return { loginUser, pingSession_, signSession_ };')(...names.map(n => stubs[n]));
  } catch (e) {
    console.error('LOAD FAILED: dutchie_proxy.gs did not evaluate under stubs — ' + e.message);
    process.exit(2);
  }
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const reset = () => {
  PROPS = { GC_SESSION_SECRET: SECRET };
  // The old local store, holding sky's OLD password — present on the live script today.
  PROPS['gc_sales_users'] = JSON.stringify({ sky: sha('old-sales-password') });
};
const token = (S, user, expMs) => { const p = user + ':' + expMs; return p + ':' + S.signSession_(p); };

// ── 1. The local store no longer signs anyone in ─────────────────────────────
console.log('\n1. a refusal from GX Core is final — the old local password does not get in');
{
  const S = load({ login: () => ({ ok: false, error: 'Invalid username or password', code: 'bad_credentials' }) });
  reset();
  const r = S.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(r.ok === false, "sky's old Sales password is refused when Core says bad_credentials");
  ok(!r.token, 'and no token is issued');
  ok(r.code === 'bad_credentials', "Core's own answer is returned, not replaced");

  const S2 = load({ login: () => ({ ok: false, error: 'No access to sales', code: 'no_access' }) });
  reset();
  ok(S2.loginUser({ user: 'sky', pass: 'old-sales-password' }).ok === false, 'a no_access answer is final too');
}

console.log('\n2. a GX Core outage refuses sign-in — it does not fall back to the local store');
{
  const S = load({ login: () => { throw new Error('Core exploded'); } });
  reset();
  const r = S.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(r.ok === false && !r.token, 'a throwing Core does not sign anyone in');
  ok(r.code === 'unavailable', 'and says unavailable, not a wrong password');

  const U = load(null);
  reset();
  const u = U.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(u.ok === false && !u.token && u.code === 'unavailable', 'an unbound GXCore refuses the same way');
}

console.log('\n3. a good GX Core sign-in passes through untouched');
{
  const good = { ok: true, user: 'shawn', role: 'editor', token: 'core-token', displayName: 'Shawn' };
  let args = null;
  const S = load({ login: (u, p, a) => { args = [u, p, a]; return good; } });
  reset();
  const r = S.loginUser({ user: 'shawn', pass: 'pw' });
  ok(r === good, "Core's response is returned as-is (displayName, avatar, token)");
  ok(args && args[2] === 'sales', "and Core is asked about the 'sales' app");
}

// ── 4. Renewal re-checks the grant ───────────────────────────────────────────
console.log('\n4. ping — a removed user is refused a renewal');
{
  const S = load({ roleForApp: (u, app) => (app === 'sales' && u === 'shawn' ? 'editor' : null) });
  reset();
  const future = Date.now() + 3600e3;
  const gone = S.pingSession_({ token: token(S, 'removed', future) });
  ok(gone.ok === false, 'a valid token for someone with no Sales role is NOT renewed');
  ok(!gone.token, 'and no new token is minted');
  ok(gone.code === 'no_access', 'with code no_access, so the client signs out');

  const kept = S.pingSession_({ token: token(S, 'shawn', future) });
  ok(kept.ok === true && typeof kept.token === 'string', 'a user who still has access is renewed');
  ok(kept.token.split(':')[0] === 'shawn', 'for the same user');
}

console.log('\n5. ping — a GX Core hiccup still renews (writes are failed closed elsewhere)');
{
  const S = load({ roleForApp: () => { throw new Error('Core exploded'); } });
  reset();
  const r = S.pingSession_({ token: token(S, 'shawn', Date.now() + 3600e3) });
  ok(r.ok === true && !!r.token, 'a throwing roleForApp does not sign the office out');
}

console.log('\n6. ping — a bad or expired token is still refused before Core is asked');
{
  let called = false;
  const S = load({ roleForApp: () => { called = true; return 'editor'; } });
  reset();
  ok(S.pingSession_({ token: 'shawn:9999999999999:forged' }).ok === false, 'a forged token is refused');
  ok(S.pingSession_({ token: token(S, 'shawn', Date.now() - 1000) }).ok === false, 'an expired token is refused');
  ok(called === false, 'and Core is never consulted for either');
}

console.log('\n7. the local password store is gone from the source, not merely skipped');
{
  const src = fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8');
  ok(!/_loginUserLocal_/.test(src), 'no _loginUserLocal_');
  ok(!/function hashPass_/.test(src), 'no password hashing helper to grow a new fallback on');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
