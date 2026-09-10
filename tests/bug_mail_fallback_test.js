#!/usr/bin/env node
/* A BUG CAN REACH THE BOARD, THE EMAIL CAN DIE, AND NOTHING ANYWHERE RECORDS IT.
 *
 * Since GX Core v310 Core's send is the only send — this app has no MailApp call of its own on the
 * success path and must not grow one, because two sends is the three-emails bug wearing a fix. But
 * gxIngestBug SWALLOWS its own mail failure on purpose: a filed report has succeeded, and mail must
 * never be what stops it. So the row lands, nobody is told, and the absence of an email is not an
 * event anyone observes. v312 added `mailed` / `mail_error` / `mail_skipped` so a spoke can tell the
 * three apart, and reading them is why this app is pinned to v315.
 *
 * THE TRAP THIS SUITE EXISTS FOR is the fix re-creating the bug it fixes. gxIngestBug returns at its
 * dedupe check ABOVE the send, so a repeat filed inside three minutes carries NO mail field at all —
 * and this app's submit retries transport flakes up to three times (index.html, `gasFetchJson(url, 3)`,
 * because a bug reporter that dies on a flake is the one thing you cannot report a bug about). Read
 * "no `mailed` field" as a failure and one redirect chain becomes three copies of the very email that
 * exists because nobody was told once. Case 4 below is that assertion and it is the point.
 *
 * There is deliberately NO notice for a REFUSED report. Leaderboard needs one because it answers
 * ok:true regardless; this app returns the refusal to the browser and the shared form shows it
 * (gx-bugreport.js treats a resolved {ok:false} as failure), so the person who filed it already knows
 * and can re-file. Case 10 pins that the refusal path stays quiet AND stays honest.
 *
 * Everything here EXECUTES the shipped reportBug_ / bugNotify_ / bugMailOnce_ out of dutchie_proxy.gs.
 * A test that restated the call would keep passing after the real one regressed.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

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

/* Name the cause rather than throwing a stack trace out of the first grab. Deleting either helper is
   a regression this suite is here to catch, and "could not locate bugNotify_" nine frames deep reads
   as a broken test rather than as the finding it is. */
for (const fn of ['reportBug_', 'bugNotify_', 'bugMailOnce_']) {
  if (!new RegExp('\\nfunction ' + fn + '\\s*\\(').test(GS)) {
    console.log('  FAIL ' + fn + ' is gone from dutchie_proxy.gs — a filed bug whose email dies is '
              + 'silent again');
    console.log('\n0 passed, 1 failed');
    process.exit(1);
  }
}

/* ── harness ──────────────────────────────────────────────────────────────────────────────────────
 * One context per `session()` so the cache fake persists across calls within a session — which is
 * what lets case 5 and 6 assert on the MARK rather than on a single call. The cache counts and can be
 * made to throw; the lock can be made busy. Both are how "fails open" gets measured instead of read.
 */
function session(opts) {
  opts = opts || {};
  const sent = [];
  const store = new Map();
  const ctx = {
    console,
    MailApp: { sendEmail: function (o) {
      if (opts.mailThrows) throw new Error('quota exhausted');
      sent.push(o);
    } },
    LockService: { getScriptLock: function () {
      return {
        waitLock: function () { if (opts.lockBusy) throw new Error('could not obtain lock'); },
        releaseLock: function () {}
      };
    } },
    CacheService: { getScriptCache: function () {
      if (opts.cacheThrows) throw new Error('cache unavailable');
      return { get: (k) => (store.has(k) ? store.get(k) : null),
               put: (k, v) => { store.set(k, v); } };
    } },
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8' },
      // Content-sensitive by construction: the mark must distinguish two different reports, so a
      // constant here would make case 6 pass for the wrong reason.
      computeDigest: (alg, s) => Array.from(String(s)).map((c) => c.charCodeAt(0)),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/[+/=]/g, ''),
      formatDate: () => '9/9/26 2:15 PM'
    },
    jsonOut_: function (o) { return o; }
  };
  vm.createContext(ctx);
  vm.runInContext(grab(GS, 'bugNotify_') + '\n' + grab(GS, 'bugMailOnce_') + '\n'
                + grab(GS, 'reportBug_'), ctx);

  return {
    sent: sent,
    /* `ingest` is what gxIngestBug returns for THIS call — the whole surface under test. */
    file: function (ingest, over) {
      let seenPayload = null;
      ctx.GXCore = { gxIngestBug: function (app, reporter, payload) {
        seenPayload = payload;
        if (ingest instanceof Error) throw ingest;
        return ingest;
      } };
      const out = ctx.reportBug_(payload(over), 'sky');
      return { out: out, payload: seenPayload };
    }
  };
}

// The payload gx-bugreport.js actually builds. No top-level tab/appTab/appStore — state rides in
// `context`, which is where the captured JS errors live too.
const SNAP = { url: 'https://greencrosscanna.github.io/greencross-sales/#expenses',
               screen: '1512x982', online: true, at: '9/9/2026, 2:15:03 PM',
               errors: ['ReferenceError: GXClient is not defined @index.html:8934'],
               tab: 'expenses' };
const payload = (over) => Object.assign({
  action: 'reportbug', title: 'Expenses tab shows no data', desc: 'opened it and it was blank',
  priority: 'high', reporter: 'sky', appVer: 'v2.585', context: JSON.stringify(SNAP)
}, over || {});

const body = (m) => String(m.body || '');

// ── 1. the ordinary case: filed AND announced sends nothing ──────────────────────────────────────
console.log('\nfiled and announced — Core mailed, so this app must not');
{
  const s = session();
  const r = s.file({ ok: true, id: 'bug_1', mailed: 'sky@greencrosscanna.com' });
  ok('no fallback email', s.sent.length === 0);
  ok('report still reports success', r.out.ok === true);
}

// ── 2. mail_error: the row is down and nobody was told ───────────────────────────────────────────
console.log('\nmail_error — the row is on the board, the email died');
{
  const s = session();
  const r = s.file({ ok: true, id: 'bug_2', mail_error: 'MailApp threw: quota' });
  ok('exactly one email', s.sent.length === 1);
  ok('subject names it unannounced', /UNANNOUNCED/.test(s.sent[0].subject));
  ok('subject carries the priority', /\[high\]/.test(s.sent[0].subject));
  ok('subject carries the title', /Expenses tab shows no data/.test(s.sent[0].subject));
  ok('goes to Sky', s.sent[0].to === 'sky@greencrosscanna.com');
  // The instruction is the opposite of the refusal case's, and getting it backwards duplicates a
  // report that is already filed. It has to be unmissable in the body.
  ok('says do NOT re-file', /do NOT re-file/.test(body(s.sent[0])));
  ok('carries the bug id to go and look at', /bug_2/.test(body(s.sent[0])));
  ok('names why the mail failed', /quota/.test(body(s.sent[0])));
  ok('says failed, not skipped', /Mail failed/.test(body(s.sent[0])));
  ok('the reporter is still told it worked', r.out.ok === true);
}

// ── 3. mail_skipped: nothing failed, and nobody was mailed ───────────────────────────────────────
console.log('\nmail_skipped — reads as fine, is still a silent report');
{
  const s = session();
  s.file({ ok: true, id: 'bug_3', mail_skipped: 'no recipient configured' });
  ok('still emails', s.sent.length === 1);
  ok('says skipped, not failed', /Mail skipped/.test(body(s.sent[0])));
  ok('names why', /no recipient configured/.test(body(s.sent[0])));
}

// ── 4. THE TRAP: a deduped repeat carries no mail field and must stay quiet ──────────────────────
console.log('\ndeduped repeat — no mail field at all, because Core returned above its send');
{
  const s = session();
  s.file({ ok: true, id: 'bug_2', deduped: true });
  ok('sends nothing', s.sent.length === 0);
}
{
  // The same shape one level meaner: the retry chain this app's own submit can produce. Three
  // executions, none carrying a mail field. Reading the ABSENCE of `mailed` as failure is how this
  // becomes three emails.
  const s = session();
  s.file({ ok: true, id: 'bug_2', mailed: 'sky@greencrosscanna.com' });
  s.file({ ok: true, id: 'bug_2', deduped: true });
  s.file({ ok: true, id: 'bug_2', deduped: true });
  ok('a three-deep redirect chain sends nothing', s.sent.length === 0);
}

// ── 5. the mark: one report, one email ───────────────────────────────────────────────────────────
console.log('\nthe mark — the same report cannot mail twice inside the window');
{
  const s = session();
  s.file({ ok: true, id: 'bug_5', mail_error: 'boom' });
  s.file({ ok: true, id: 'bug_5', mail_error: 'boom' });
  s.file({ ok: true, id: 'bug_5', mail_error: 'boom' });
  ok('three concurrent filings, one email', s.sent.length === 1);
}

// ── 6. …and it must not over-suppress ────────────────────────────────────────────────────────────
console.log('\nthe mark is per-report, not global');
{
  const s = session();
  s.file({ ok: true, id: 'bug_6a', mail_error: 'boom' });
  s.file({ ok: true, id: 'bug_6b', mail_error: 'boom' }, { title: 'Something else entirely' });
  ok('a different report gets its own email', s.sent.length === 2);
}
{
  const s = session();
  s.file({ ok: true, id: 'bug_6c', mail_error: 'boom' });
  s.file({ ok: true, id: 'bug_6d', mail_error: 'boom' }, { desc: 'different details, same title' });
  ok('a different description is a different report', s.sent.length === 2);
}

// ── 7/8. fails open — an unavailable cache or lock must never silence a bug ──────────────────────
console.log('\nfails open — infrastructure must not be the reason nobody hears about a bug');
{
  const s = session({ cacheThrows: true });
  s.file({ ok: true, id: 'bug_7', mail_error: 'boom' });
  s.file({ ok: true, id: 'bug_7', mail_error: 'boom' });
  ok('a dead cache duplicates rather than swallows', s.sent.length === 2);
}
{
  const s = session({ lockBusy: true });
  s.file({ ok: true, id: 'bug_8', mail_error: 'boom' });
  ok('a busy lock still sends', s.sent.length === 1);
}

// ── 9. the notice must never sink the report ─────────────────────────────────────────────────────
console.log('\nmail is the enhancement, the row is the thing');
{
  const s = session({ mailThrows: true });
  const r = s.file({ ok: true, id: 'bug_9', mail_error: 'boom' });
  ok('a throwing MailApp does not reach the reporter', r.out.ok === true);
  ok('and does not throw out of reportBug_', r.out.error === undefined);
}

// ── 10. a REFUSED report stays quiet here, because the reporter is told directly ─────────────────
console.log('\nrefused — no email, and the browser gets the reason');
{
  const s = session();
  const r = s.file({ ok: false, error: 'title or detail required' });
  ok('sends no email', s.sent.length === 0);
  ok('returns not-ok', r.out.ok === false);
  ok('surfaces the reason to the reporter', /title or detail required/.test(r.out.error));
}
{
  const s = session();
  const r = s.file(new Error('core unreachable'));
  ok('an unreachable Core sends no email either', s.sent.length === 0);
  ok('and is reported to the browser', r.out.ok === false);
}

// ── 11. the email carries what the defer bug needed ──────────────────────────────────────────────
console.log('\nthe body carries the evidence — captured JS errors are why context is forwarded');
{
  const s = session();
  s.file({ ok: true, id: 'bug_11', mail_error: 'boom' });
  const b = body(s.sent[0]);
  ok('quotes the captured error', /ReferenceError: GXClient is not defined/.test(b));
  ok('counts them', /JS errors captured before submit \(1\)/.test(b));
  ok('names the screen', /Screen   : expenses/.test(b));
  ok('carries the route', /#expenses/.test(b));
  ok('carries the app version', /v2\.585/.test(b));
  ok('carries the reporter', /Reporter : sky/.test(b));
  ok('ends with what the person actually wrote', /opened it and it was blank/.test(b));
}
{
  const s = session();
  s.file({ ok: true, id: 'bug_11b', mail_error: 'boom' },
         { context: JSON.stringify({ tab: 'income' }) });
  ok('no errors captured means no empty header', !/JS errors captured/.test(body(s.sent[0])));
}

// ── 12. a malformed context costs the extras, never the report or the notice ─────────────────────
console.log('\na malformed context is still evidence');
{
  const s = session();
  const r = s.file({ ok: true, id: 'bug_12', mail_error: 'boom' }, { context: '{not json' });
  ok('the report still files', r.out.ok === true);
  ok('the raw context still goes up', r.payload.context === '{not json');
  ok('the notice still sends', s.sent.length === 1);
  ok('it just carries no screen', /Screen   : \n/.test(body(s.sent[0]) + '\n'));
}

// ── 13. the guard reads the POSITIVE fields — a source-level pin on the trap ─────────────────────
console.log('\nsource shape — the check must not be written against `mailed`');
{
  const src = grab(GS, 'reportBug_');
  ok('reads mail_error and mail_skipped', /mail_error/.test(src) && /mail_skipped/.test(src));
  // `!r.mailed` is the exact expression that turns a redirect chain into three emails.
  ok('never branches on the absence of `mailed`', !/!\s*r\.mailed/.test(src));
  ok('the notice runs AFTER the ok check',
     src.indexOf("error: (r && r.error)") < src.indexOf('mail_error'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
