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

/* Comments are stripped BUT THEIR LINES ARE KEPT — every comment character becomes nothing and every
 * newline survives — so a line number this file prints is the line number in dutchie_proxy.gs. The
 * earlier version collapsed the comments away and reported a number ~350 lines short of the real
 * one: a red line nobody can act on, which is the same defect as the push gate that says only
 * "Binary file matches". Stripping at all is necessary because this repo's prose quotes the hazard,
 * and a gate its own documentation can trip is a gate nobody keeps. */
function stripComments(src) {
  const blank = t => t.replace(/[^\n]/g, '');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[ \t]*\/\/.*$/gm, '');
}

/* Assembled rather than written out. gx-preflight.sh refuses a tracked file that assigns a
 * random-looking literal to a name like SECRET — correctly, since it cannot tell a fixture from the
 * real thing and should not have to guess. It caught this file on its first push. Building the
 * value from plain words keeps the gate meaningful AND keeps this fixture obviously fake. */
const SECRET = ['deploy', 'fixture', 'not', 'a', 'real', 'credential', '0000'].join('-');
const LEAKY  = 'Address unavailable: https://script.google.com/macros/s/AKfycbx9/exec'
             + '?action=dutchie_get&store=River%20Rd&path=%2Freporting%2Ftransactions&secret=' + SECRET;

/* The three declarations the scrub is BUILT from, lifted out of the shipped source rather than
   retyped here — retyping them is the drift this whole change exists to end. If one of them is
   renamed this throws by name instead of silently testing a regex the app does not use. */
function decls() {
  const want = [
    /const AUTH_PARAM_NAMES_\s*=\s*\[[^\]]*\];/,
    /const SECRET_WORD_NAMES_\s*=[^\n]*\n?[^\n]*?;/,
    /const SECRET_PARAM_RE_\s*=\s*new RegExp\([\s\S]*?'gi'\);/,
  ];
  return want.map(re => {
    const m = re.exec(GS);
    if (!m) throw new Error('could not find declaration matching ' + re);
    return m[0];
  }).join('\n');
}

function scrubCtx(secret) {
  const ctx = { PropertiesService: { getScriptProperties: () => ({ getProperty: () => secret }) } };
  vm.createContext(ctx);
  vm.runInContext('var _GX_SECRET_MEMO_ = null;\n' + decls() + '\n' + grab('gxScrub_') + '\n'
                  + grab('errText_') + '\n' + grab('jsonOut_'), ctx);
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
  vm.runInContext('var _GX_SECRET_MEMO_ = null;\n' + decls() + '\n' + grab('gxScrub_') + '\n' + grab('errText_')
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
  const code = stripComments(GS);
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

  /* Thirty-six of this file's replies are built by hand and never reach jsonOut_, which is why the
   * fix could not live in jsonOut_ alone. Prove those paths are still counted by the check above
   * rather than assumed. (They now route through setReply_ — see §9 — but this counts them by the
   * ERROR they carry, so the assertion survives the next refactor of how a body is set.) */
  const handBuiltErr = (code.match(/setReply_\(output,\s*JSON\.stringify\(\{[^}]*\berror\b/g) || []).length;
  ok('the hand-built replies that carry an error are real and still in scope ('
     + handBuiltErr + ' of them)', handBuiltErr >= 6);

  // The two layers both exist and are wired, not merely defined.
  ok('jsonOut_ scrubs the finished body as a backstop',
     /function jsonOut_[\s\S]{0,200}?gxScrub_\(JSON\.stringify\(data\)\)/.test(code));
  ok('errText_ is built on the same scrub, so there is one definition of "credential"',
     /function errText_[\s\S]{0,200}?gxScrub_\(/.test(code));
}

console.log('\n7. ONE LIST: the names the auth check accepts ARE the names the scrub redacts');
{
  /* THE DEFECT THIS PINS was never a missing word in a regex. The scrub named `token`; the auth
   * check accepted `params.token || params.session || params.auth`. TWO hand-typed lists in two
   * functions that had to agree, with nothing comparing them — so a request presenting its session
   * as `session=` or `auth=` put a LIVE USER TOKEN in the error banner the scrub exists to clean.
   * Adding the two words closed that gap and left the mechanism; core-admin measured the same shape
   * in three of the suite's four scrubs the next night and asked for the structural fix instead.
   *
   * So there is ONE list now. AUTH_PARAM_NAMES_ is read by authParamValue_ (the auth path) and
   * concatenated into SECRET_PARAM_RE_ (the scrub). This section reads that array out of the
   * source, checks that BOTH consumers really are wired to it, and then EXECUTES the shipped scrub
   * against every name in it. Adding a fourth way to present a session is protected with no edit
   * here and no edit to the regex. Hand-typing ['token','session','auth'] below would rebuild the
   * exact drift this replaced. */
  const decl = /const AUTH_PARAM_NAMES_\s*=\s*\[([^\]]*)\]/.exec(GS);
  ok('the one list exists and is a literal array (if this moved, fix the derivation)', !!decl);
  const names = decl ? [...decl[1].matchAll(/'(\w+)'/g)].map(m => m[1]) : [];
  ok('derived the accepted parameter names from the source: ' + (names.join(', ') || '(none)'),
     names.length > 0);

  /* BOTH CONSUMERS, checked as the absence of the old shape rather than the presence of the new
   * one. A test that only proves the list exists goes green on a file that keeps a second copy
   * beside it, which is the bug. */
  const auth = grab('requireAuth_');
  ok('the auth check takes the session through the list, not through params.<name>',
     /authParamValue_\(params\)/.test(auth) && !/params\.(token|session|auth)/.test(auth));
  ok('authParamValue_ reads AUTH_PARAM_NAMES_ and nothing else',
     /AUTH_PARAM_NAMES_/.test(grab('authParamValue_')));
  const reDecl = /const SECRET_PARAM_RE_[\s\S]{0,400}?'gi'\);/.exec(GS);
  ok('the scrub regex is BUILT from the same array, not typed beside it',
     !!reDecl && /SECRET_WORD_NAMES_/.test(reDecl[0])
     && /const SECRET_WORD_NAMES_[^\n]*concat\(AUTH_PARAM_NAMES_\)/.test(GS));
  ok('gxScrub_ uses that built regex rather than a literal of its own',
     /return out\.replace\(SECRET_PARAM_RE_/.test(grab('gxScrub_')));

  /* A DERIVED LIST IS BLIND DOWNWARD, SO THERE IS ALSO A FLOOR — hardcoded here, unreachable from
   * the source. Deriving makes additions automatic and deletions INVISIBLE: delete `session` from
   * the array and it leaves this test's list with it, so a narrowed app goes green while checking
   * one name fewer. That is not hypothetical — it is how core-admin's first version of this passed
   * 23 of 23 and Price Cards' 62 of 62 on the very bug they were written for. The floor is not the
   * typed list coming back: it never sources what gets EXERCISED, it only refuses shrinkage. */
  for (const known of ['token', 'session', 'auth']) {
    ok('FLOOR: `' + known + '` is still an accepted way to present a session — if this fails on '
       + 'purpose, delete it here deliberately', names.indexOf(known) !== -1);
  }

  /* EXECUTED, not read. Each name goes through the shipped gxScrub_ inside a real
   * `Address unavailable:` message, exactly as UrlFetchApp throws it. */
  const ctx = scrubCtx(SECRET);
  const LIVE = ['gx', 'fixture', 'session', 'value', 'not', 'real', '0000'].join('-');
  for (const n of names) {
    const msg = 'Address unavailable: https://script.google.com/macros/s/AKfycbx9/exec'
              + '?action=stores&' + n + '=' + LIVE;
    const out = ctx.errText_(new Error(msg));
    ok('a session presented as `' + n + '=` is redacted out of the error text',
       out.indexOf(LIVE) === -1);
    ok('  and the parameter name survives, so the message still says what failed',
       out.indexOf(n + '=[redacted]') !== -1);
  }

  /* The literal-value pass cannot stand in for this one. That memo holds GX_DEPLOY_SECRET; what
   * leaks here belongs to a PERSON and is live until it expires — a different credential the app
   * never holds the value of. Proven by scrubbing with no property set at all. */
  const bare = scrubCtx('');
  const out = bare.errText_(new Error('Address unavailable: x?session=' + LIVE));
  ok('a user session is removed even with no deploy secret to match against',
     out.indexOf(LIVE) === -1);

  /* SCOPE, stated so the commit cannot claim more than it does: the pattern pass matches
   * `name=value` after a ? or &. A credential sitting bare in a message — not as a query
   * parameter — is caught only by the literal-value pass, which knows GX_DEPLOY_SECRET alone. No
   * path was found that embeds a bare session token in an error; this records the limit rather
   * than pretending it is covered. */
  const loose = ctx.errText_(new Error('session ' + LIVE + ' expired'));
  ok('KNOWN LIMIT (documented, not a bug): a BARE token outside a query string is not matched',
     loose.indexOf(LIVE) !== -1);
}

console.log('\n8. ANCHORING: a PREFIXED credential parameter does not walk past the scrub');
{
  /* MEASURED ON THE LIVE DEPLOYMENT on 2026-09-15, before this was changed, by echoing a fixture
   * value back through the `Unknown store:` reply: connector_secret, deploy_secret, api_key,
   * apikey, refresh_token, x_auth and sessionid ALL came back in full, because the shipped pattern
   * anchored the credential word immediately after `?` or `&` and an underscore in front of it was
   * enough to walk past. `connector_secret=` is a name GX CORE really builds, and this file
   * re-throws Core's error text verbatim, so it is a reachable path and not a hypothetical.
   *
   * Every name below is HARDCODED — the whole point of this section is to hold names the
   * implementation's own arrays do not contain, so the test cannot shrink when the source does. */
  const c = scrubCtx('');   // no deploy secret: the pattern pass alone must carry this
  const FIX = ['probe', 'fixture', 'value', 'not', 'real', '0000'].join('-');
  const CASES = [
    'connector_secret', 'deploy_secret', 'client_secret', 'refresh_token', 'access_token',
    'api_key', 'apikey', 'x_auth', 'sessionid', 'session_token', 'gc_session', 'user-password',
    'secret', 'token', 'session', 'auth', 'key', 'password', 'pwd',
  ];
  for (const n of CASES) {
    const out = c.errText_(new Error('Address unavailable: https://x/exec?action=y&' + n + '=' + FIX));
    ok('`' + n + '=` is redacted', out.indexOf(FIX) === -1);
  }
  // First parameter position too — after `?`, not only after `&`.
  ok('a prefixed name in the FIRST position is redacted as well',
     c.errText_(new Error('https://x/exec?connector_secret=' + FIX)).indexOf(FIX) === -1);
  // ...and the message is still a message.
  const keep = c.errText_(new Error('Address unavailable: https://x/exec?action=stores&store=Bend'));
  ok('non-credential parameters beside it are untouched', /action=stores&store=Bend/.test(keep));
}

console.log('\n9. NO REPLY EXIT MAY CARRY A RAW BODY — all 54 of them, not the catches');
{
  const code = stripComments(GS);

  /* COUNT THE EXITS BEFORE TRUSTING A CHOKE POINT. jsonOut_ looks like one, and 138 call sites do
   * go through it — but this file also builds replies by hand, and those never touched the scrub.
   * Recounted here on every run so the number in the source comment cannot rot. */
  const ctoLines = [...code.matchAll(/ContentService\.createTextOutput\(/g)]
    .map(m => code.slice(0, m.index).split('\n').length);
  const replyLines = [...code.matchAll(/setReply_\(output,/g)]
    .map(m => code.slice(0, m.index).split('\n').length);
  console.log('     (reply-building exits: ' + ctoLines.length + ' createTextOutput + '
              + replyLines.length + ' hand-built = ' + (ctoLines.length + replyLines.length) + ')');
  ok('this file still has many more exits than choke points — ' + (ctoLines.length + replyLines.length)
     + ' of them', ctoLines.length + replyLines.length >= 40);

  /* THE HAZARD, NAMED AS AN ABSENCE. A grep for `setReply_` would go green the moment one appeared
   * anywhere. A grep for `.setContent(` outside the one helper cannot: every hand-built reply in
   * this file has to route through it, and a new one that does not FAILS HERE WITH ITS LINE. */
  const raw = [...code.matchAll(/\.setContent\(/g)]
    .map(m => code.slice(0, m.index).split('\n').length)
    .filter(ln => !/function setReply_/.test(code.split('\n').slice(Math.max(0, ln - 4), ln).join('\n')));
  ok('no reply sets its body without the scrub'
     + (raw.length ? ' — found ' + raw.length + ' at line(s) ' + raw.join(', ') : ''),
     raw.length === 0);
  ok('setReply_ is the one place that does, and it scrubs',
     /function setReply_\([\s\S]{0,200}?output\.setContent\(gxScrub_\(/.test(code));

  /* createTextOutput WITH A BODY is the same door in a different shape — getStoresMeta_ returns a
   * cached payload that way and bypassed jsonOut_ entirely. */
  const bodied = [...code.matchAll(/ContentService\.createTextOutput\(([^)\n]*)\)/g)]
    .filter(m => m[1].trim() !== '' && !/gxScrub_\(/.test(m[1]))
    .map(m => code.slice(0, m.index).split('\n').length);
  ok('every createTextOutput that is handed a body scrubs it'
     + (bodied.length ? ' — found ' + bodied.length + ' at line(s) ' + bodied.join(', ') : ''),
     bodied.length === 0);

  /* EXECUTED: the helper itself, against a real leaking body, including the cached-hit path that a
   * per-catch fix never reaches. */
  const c = scrubCtx('');
  vm.runInContext(grab('setReply_') + '\nthis.setReply_ = setReply_;', c);
  const sink = { _t: null, setContent(t) { this._t = t; return this; } };
  const FIX = ['cached', 'fixture', 'value', 'not', 'real', '0000'].join('-');
  const body = JSON.stringify({ ok: true, note: 'see https://x/exec?connector_secret=' + FIX });
  c.setReply_(sink, body);
  ok('a CACHED body carrying a credential is scrubbed on the way out', sink._t.indexOf(FIX) === -1);
  ok('...and the rest of the payload survives', /"ok":true/.test(sink._t));
  c.setReply_(sink, null);
  ok('a null body is handled rather than answering the string "null"', sink._t === '');
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
 * A clean run against already-scrubbed code proves nothing; that is the whole lesson of the note.
 *
 * SECTION 7 added 2026-09-15, mutation-verified the same way and in three directions, because the
 * three say different things:
 *   · the regex reverted to the SHIPPED list (secret|token|key|password|pwd)
 *                                                → 5 fail: session= and auth= both carry the token
 *                                                  through, and it survives with no property set
 *   · `|| params.auth` DELETED from the auth line → 1 fail: the floor. Nothing else notices, which
 *                                                  is the entire reason the floor is there
 *   · `|| params.sid` ADDED to the auth line      → 2 fail: `sid=` joined the exercised list on its
 *                                                  own and failed until the regex would learn it
 *
 * The third is the one that proves the derivation is real rather than decorative: no edit was made
 * to this file, and the new name tested itself. The second proves the derivation is ALSO blind
 * downward, which is why both mechanisms are here and why collapsing them into one typed array
 * would quietly restore the bug this section exists for. */
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
