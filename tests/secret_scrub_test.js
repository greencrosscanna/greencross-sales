/* SECRET SCRUB — nothing this script returns may carry a credential.
 *
 * Reported by SPIFF via core-admin on 2026-09-15, after SPIFF found the shape in its own router.
 * The mechanism, confirmed reachable in THIS repo before anything was changed: gxDutchieGet_ puts
 * the deploy secret in a query string and hands it to UrlFetchApp.fetch; `muteHttpExceptions` does
 * not cover a transport failure; Apps Script throws `Address unavailable: <the whole URL>`; a catch
 * up the stack answers `{ error: <that message> }`; the browser paints it. The secret ends up on a
 * screen in the office.
 *
 * ── WHY THIS FILE IS SHAPED THE WAY IT IS ──────────────────────────────────────────────────────
 *
 * SPIFF's own test for this passed while being incapable of failing: it grepped the WHOLE FILE for
 * the scrub and matched an occurrence inside a different function, so it was green on a router that
 * still leaked. That is the third instance of a can't-fail guard in this suite (see
 * binary_source_test.js), and it is the reason for two rules here:
 *
 *   1. EXECUTE the real handler's catch with a real "Address unavailable" exception, rather than
 *      reading the source and believing it.
 *   2. Where a source check IS the right tool — proving that NO site was missed, which execution
 *      cannot show — assert the absence over an enumerated list, so a new unwrapped site fails and
 *      NAMES ITSELF. A grep for the presence of a fix can match anywhere; a grep for the absence of
 *      the hazard cannot.
 *
 * Every assertion below is mutation-verified: see the block comment at the end.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok   ' + label); }
                              else      { fail++; console.log('  FAIL ' + label); } };

function grab(name) {
  const re = new RegExp('\\n(?:async )?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(GS);
  if (!m) throw new Error('could not find function ' + name);
  const i = GS.indexOf('{', m.index);
  for (let j = i, d = 0; j < GS.length; j++) {
    if (GS[j] === '{') d++; else if (GS[j] === '}' && --d === 0) return GS.slice(m.index, j + 1);
  }
  throw new Error('unbalanced ' + name);
}

/* Assembled rather than written out. gx-preflight.sh refuses a tracked file that assigns a
 * random-looking literal to a name like SECRET — correctly, since it cannot tell a fixture from the
 * real thing and should not have to guess. It caught this file on its first push. Building the
 * value from plain words keeps the gate meaningful AND keeps this fixture obviously fake. */
const SECRET = ['deploy', 'fixture', 'not', 'a', 'real', 'credential', '0000'].join('-');
const LEAKY  = 'Address unavailable: https://script.google.com/macros/s/AKfycbx9/exec'
             + '?action=dutchie_get&store=River%20Rd&path=%2Freporting%2Ftransactions&secret=' + SECRET;

function scrubCtx(secret) {
  const ctx = { PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) } };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;\n' + grab('gxScrub_') + '\n' + grab('errText_')
                  + '\n' + grab('jsonOut_'), ctx);
  ctx.ContentService = { MimeType: { JSON: 'json' },
    createTextOutput: t => ({ _t: t, setMimeType() { return this; } }) };
  return ctx;
}

console.log('\n1. the exact secret is removed wherever it appears — no pattern to outsmart');
{
  const c = scrubCtx(SECRET);
  const out = c.errText_(new Error(LEAKY));
  ok('the deploy secret is gone from the message', out.indexOf(SECRET) === -1);
  ok('...replaced, not truncated — the rest of the message survives', /Address unavailable/.test(out));
  ok('...and the reader can see WHERE it was', /\[redacted\]/.test(out));
  // The same value outside a query string — a bare echo, a log line, a nested payload.
  ok('a bare occurrence is caught too, not just secret=<value>',
     c.errText_(new Error('using key ' + SECRET + ' now')).indexOf(SECRET) === -1);
}

console.log('\n2. credential-shaped parameters we do NOT hold are removed too');
{
  const c = scrubCtx(SECRET);
  const t = c.errText_(new Error('Address unavailable: https://x/exec?token=abc123XYZ&store=Bend'));
  ok('a session token in an echoed URL is redacted', t.indexOf('abc123XYZ') === -1);
  ok('...and the non-credential parameters beside it are left alone', /store=Bend/.test(t));
}

console.log('\n3. it does not damage an ordinary response');
{
  const c = scrubCtx(SECRET);
  const body = c.jsonOut_({ ok: true, net: 11631.5, store: 'River Rd', note: 'BEND 08.04.26 Dep' })._t;
  ok('a normal payload passes through byte for byte',
     body === JSON.stringify({ ok: true, net: 11631.5, store: 'River Rd', note: 'BEND 08.04.26 Dep' }));
}

console.log('\n4. it can never be the reason a response fails');
{
  // The property is unset — gxDeploySecret_ throws for this, and a scrub that threw with it would
  // turn a working app into a blank one. Leaking is bad; serving nothing is worse.
  const c = scrubCtx(null);
  let threw = null;
  let out = null;
  try { out = c.errText_(new Error('Address unavailable: https://x/exec?secret=' + SECRET)); }
  catch (e) { threw = e; }
  ok('no secret property does not throw', threw === null);
  ok('...and the pattern pass still runs, so the value is STILL redacted',
     out !== null && out.indexOf(SECRET) === -1);
  // A short or empty property must not redact half the payload.
  const c2 = scrubCtx('ab');
  ok('a short property is ignored rather than matching everywhere',
     c2.errText_(new Error('a cab drove by')) === 'a cab drove by');
  ok('a null exception is handled', scrubCtx(SECRET).errText_(null) === '');
}

console.log('\n5. EXECUTED: a real handler\'s catch, with the real exception');
{
  /* getVelocity_ is reachable at ?action=velocity, its catch is one of the 30-odd that turn an
   * exception into a reply, and GXCore.getVelocity is exactly the kind of call that throws a
   * secret-bearing transport error. Driven for real, not read. */
  const ctx = {
    GXCore: { getVelocity: () => { throw new Error(LEAKY); } },
    salesStores_: () => [{ core: 'bend', dutchie: 'Bend', sales: 'Bend' }],
    cacheGet_: () => null, cacheSet_: () => {},
    Utilities: { formatDate: () => '2026-09-15T00:00:00' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => SECRET }) },
  };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;\n' + grab('gxScrub_') + '\n' + grab('errText_')
    + '\n' + grab('hasOwn_') + '\n' + /const VELOCITY_CACHE_KEY_ = [^\n]*/.exec(GS)[0]
    + '\n' + grab('getVelocity_') + '\nthis.getVelocity_ = getVelocity_;', ctx);
  const r = ctx.getVelocity_({});
  ok('the handler still answers rather than throwing', !!r && r.ok === false);
  ok('...it still explains what went wrong', /velocity unavailable/i.test(r.error));
  ok('...and the secret is NOT in what the browser would receive',
     JSON.stringify(r).indexOf(SECRET) === -1);
}

console.log('\n6. NO SITE WAS MISSED — the part execution cannot prove');
{
  /* Strip comments first: this file's own explanatory prose quotes the hazard, and a gate that its
   * own documentation can trip is a gate nobody will keep. */
  const code = GS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* Every place an exception's text becomes part of a REPLY. Listed as the hazard, not as the fix:
   * a search for `errText_` would go green the moment one appears anywhere in the file, which is
   * precisely how SPIFF's version passed on a router that still leaked. */
  const RAW = /(?:error|stage|detail|reason|message)\s*:\s*[^,;}\n]*\b(?:e|err|ex|error)\.(?:message|stack)\b/g;
  const hits = [];
  let m;
  while ((m = RAW.exec(code))) hits.push(code.slice(0, m.index).split('\n').length + ': ' + m[0].trim());
  ok('no reply field is handed a raw exception message or stack'
     + (hits.length ? ' — found ' + hits.length + ': ' + hits.slice(0, 6).join(' | ') : ''),
     hits.length === 0);

  // The stack is worse than the message and must never appear in a reply at all.
  ok('no reply carries a stack trace', !/\bstack\s*:\s*[^,;}\n]*\.stack\b/.test(code));

  /* nine of this file's replies are built with output.setContent(JSON.stringify(...)) and never
   * reach jsonOut_, which is why the fix could not live in jsonOut_ alone. Prove those paths are
   * still counted by the check above rather than assumed. */
  const setContentErr = (code.match(/setContent\(JSON\.stringify\(\{[^}]*\berror\b/g) || []).length;
  ok('the setContent replies that carry an error are real and still in scope ('
     + setContentErr + ' of them)', setContentErr >= 6);

  // The two layers both exist and are wired, not merely defined.
  ok('jsonOut_ scrubs the finished body as a backstop',
     /function jsonOut_[\s\S]{0,200}?gxScrub_\(JSON\.stringify\(data\)\)/.test(code));
  ok('errText_ is built on the same scrub, so there is one definition of "credential"',
     /function errText_[\s\S]{0,200}?gxScrub_\(/.test(code));
}

/* MUTATION LOG — each assertion above was shown failing against a deliberately broken source on
 * 2026-09-15, and the failure named what broke:
 *   · gxScrub_ returning its input unchanged            → 6 assertions across 1, 2 and 4, 5
 *   · dropping the exact-value pass, keeping the pattern → 1 fails: the bare occurrence survives
 *   · dropping the pattern pass, keeping the exact value → 2 fails, and 4 fails with no property set
 *   · removing the length guard                         → 4 fails: "a cab drove by" gets redacted
 *   · un-wrapping ONE errText_ call site (of 37)        → 6 fails AND prints the line number
 *   · reverting the scrub inside jsonOut_               → 6 fails on the backstop assertion
 *
 * Note what the last two show between them, because it is the reason for having both layers: the
 * site check and the backstop check fail INDEPENDENTLY. Break either layer and exactly one
 * assertion goes red, which is what tells you the other layer is not quietly covering for it.
 * A clean run against already-scrubbed code proves nothing; that is the whole lesson of the note. */
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
