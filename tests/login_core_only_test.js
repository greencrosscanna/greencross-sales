#!/usr/bin/env node
/* ─── loginUser / pingSession_ — sign-in goes through GX Core only ───────────────────────────────
 *
 *   RUN:  node tests/login_core_only_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Until 2026-09-14 a refusal from GXCore.login fell through to this app's own password store
 * (gc_sales_users), so an old Sales password for `sky` kept working after the Command Center password
 * changed. And the 10-minute ping minted a fresh token from a signature alone, so someone removed
 * in the Command Center stayed signed in for as long as their tab was open.
 *
 * SINCE SLICE 6 (2026-11-25) both ask GX Core's LIVE routes (login, verify) over POST instead of the
 * pinned library, so a sign-in fix in Core reaches Sales without a re-pin. The fake Core sits at
 * UrlFetchApp — the real boundary — so the shipped gxCorePost_ runs too.
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
let CORE = null;            // body -> answer object | raw string | Error
let CALLS = [];
const SECRET = 'test-session-secret';
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
  Utilities: {
    formatDate: () => '2026-09-14T12:00:00',
    getUuid: () => 'uuid', sleep() {},
    DigestAlgorithm: { SHA_256: 'sha256' },
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(String(s)).digest()],
    computeHmacSha256Signature: (payload, key) => [...crypto.createHmac('sha256', key).update(payload).digest()],
    base64EncodeWebSafe: bytes => Buffer.from(bytes.map(b => b & 255)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
  },
  CacheService:{ getScriptCache: () => ({ get: () => null, put(){}, putAll(){}, getAll: () => ({}), remove(){} }) },
  MailApp:{}, GmailApp:{}, ScriptApp:{}, Session:{}, Logger:{log(){}},
  LockService:{ getScriptLock: () => ({ waitLock(){}, releaseLock(){} }) },
  // The pinned library must not be asked: every call throws, so reaching it fails the case.
  GXCore: { login() { throw new Error('library login must not be called'); },
            roleForApp() { throw new Error('library roleForApp must not be called'); } },
};

let S;
try {
  const names = Object.keys(base);
  S = new Function(...names, fs.readFileSync(__dirname + '/../dutchie_proxy.gs', 'utf8') +
    '\n; return { loginUser, pingSession_, signSession_ };')(...names.map(n => base[n]));
} catch (e) {
  console.error('LOAD FAILED: dutchie_proxy.gs did not evaluate under stubs — ' + e.message);
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const reset = core => {
  PROPS = { GC_SESSION_SECRET: SECRET };
  // The old local store, holding sky's OLD password — present on the live script today.
  PROPS['gc_sales_users'] = JSON.stringify({ sky: sha('old-sales-password') });
  CALLS = []; CORE = core;
};
const token = (user, expMs) => { const p = user + ':' + expMs; return p + ':' + S.signSession_(p); };
const body = i => (CALLS[i] ? JSON.parse(CALLS[i].opts.payload) : {});

console.log('\n1. a refusal from GX Core is final — the old local password does not get in');
{
  reset(() => ({ ok: false, error: 'Invalid username or password', code: 'bad_credentials' }));
  const r = S.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(r.ok === false, "sky's old Sales password is refused when Core says bad_credentials");
  ok(!r.token, 'and no token is issued');
  ok(r.code === 'bad_credentials', "Core's own answer is returned, not replaced");
  ok(CALLS.length === 1, 'a refusal is an answer — it is not retried');

  reset(() => ({ ok: false, error: 'No access to sales', code: 'no_access' }));
  ok(S.loginUser({ user: 'sky', pass: 'old-sales-password' }).ok === false, 'a no_access answer is final too');
}

console.log('\n2. a GX Core outage refuses sign-in — it does not fall back to the local store');
{
  reset(() => new Error('Core exploded'));
  const r = S.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(r.ok === false && !r.token, 'an unreachable Core does not sign anyone in');
  ok(r.code === 'unavailable', 'and says unavailable, not a wrong password');
  reset(() => '<html>Sorry, unable to open the file at this time.</html>');
  const h = S.loginUser({ user: 'sky', pass: 'old-sales-password' });
  ok(h.ok === false && !h.token && h.code === 'unavailable', 'an HTML page from Core refuses the same way');
}

console.log('\n3. a good GX Core sign-in passes through untouched, and the password is never in a URL');
{
  const good = { ok: true, user: 'shawn', role: 'editor', token: 'core-token', displayName: 'Shawn' };
  reset(() => good);
  const r = S.loginUser({ user: 'shawn', pass: 'pw-123' });
  ok(JSON.stringify(r) === JSON.stringify(good), "Core's response is returned as-is (displayName, avatar, token)");
  const b = body(0);
  ok(b.action === 'login' && b.app === 'sales' && b.user === 'shawn', "and Core's login route is asked about the 'sales' app");
  ok(CALLS[0].opts.method === 'post' && b.pass === 'pw-123', 'the password travels in a POST body');
  ok(!/pw-123/.test(CALLS[0].url), 'and not in the URL');
}

console.log('\n4. ping — a removed user is refused a renewal');
{
  const future = Date.now() + 3600e3;
  reset(b => (b.action === 'verify' && b.app === 'sales' && /^shawn:/.test(b.token)
    ? { ok: true, user: 'shawn', app: 'sales', role: 'editor', canEdit: true }
    : { ok: false, error: 'No access to sales', code: 'no_access' }));
  const gone = S.pingSession_({ token: token('removed', future) });
  ok(gone.ok === false, 'a valid token for someone with no Sales role is NOT renewed');
  ok(!gone.token, 'and no new token is minted');
  ok(gone.code === 'no_access', 'with code no_access, so the client signs out');

  const kept = S.pingSession_({ token: token('shawn', future) });
  ok(kept.ok === true && typeof kept.token === 'string', 'a user who still has access is renewed');
  ok(kept.token.split(':')[0] === 'shawn', 'for the same user');
}

console.log('\n5. ping — a GX Core hiccup still renews (writes are failed closed elsewhere)');
{
  const t = token('shawn', Date.now() + 3600e3);
  [['unreachable', () => new Error('Core exploded')],
   ['an HTML page', () => '<html>x</html>'],
   ['rejecting a session this app accepted', () => ({ ok: false, error: 'Invalid session', code: 'invalid_session' })]]
    .forEach(([label, core]) => {
      reset(core);
      const r = S.pingSession_({ token: t });
      ok(r.ok === true && !!r.token, 'Core ' + label + ' does not sign the office out');
    });
}

console.log('\n6. ping — a bad or expired token is still refused before Core is asked');
{
  reset(() => ({ ok: true, user: 'shawn', role: 'editor', canEdit: true }));
  ok(S.pingSession_({ token: 'shawn:9999999999999:forged' }).ok === false, 'a forged token is refused');
  ok(S.pingSession_({ token: token('shawn', Date.now() - 1000) }).ok === false, 'an expired token is refused');
  ok(CALLS.length === 0, 'and Core is never consulted for either');
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
