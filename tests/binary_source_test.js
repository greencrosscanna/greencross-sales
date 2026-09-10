#!/usr/bin/env node
/* A SHIPPED SOURCE FILE MUST NOT CONTAIN A NUL BYTE.
 *
 * grep decides whether a file is BINARY, and on a binary file it prints nothing useful and can exit
 * 1 — a result indistinguishable from "no match". `file(1)` still reports "UTF-8 text", the file is
 * valid UTF-8, every editor renders it normally, and nothing anywhere says a word.
 *
 * THIS IS NOT HYPOTHETICAL. Commit edc075d shipped exactly two raw NULs into dutchie_proxy.gs at
 * offsets 196535 and 196563 — the delimiter in bugMailOnce_'s cache key, where an escape got written
 * to disk as the byte itself.
 *
 * WHAT IT ACTUALLY COST, MEASURED — narrower than it first looked, so read both halves before
 * repeating the alarming version:
 *
 *   · EVERY AGENT-FACING GREP WENT BLIND. The `grep` a Claude Code session runs wraps ugrep, which
 *     scans the WHOLE file and refuses a binary one wherever the NUL sits. The entire Sales backend
 *     became invisible to every grep-based check an agent makes. A peer session spent several minutes
 *     concluding this implementation did not exist, because every grep came back empty while the code
 *     sat right there. That part is real and is the reason for this test.
 *
 *   · THE PUSH GATE WAS NOT DISABLED. gx-preflight.sh runs as a git hook under /bin/sh, where `grep`
 *     resolves to /usr/bin/grep — BSD grep, which classifies a file from its FIRST BLOCK only. These
 *     NULs sat at ~196KB, far past that window, so the gate read the file as ordinary text. VERIFIED
 *     by running the real gx-preflight.sh against the real NUL-bearing backend with a genuine
 *     `debugger;` and a real localhost URL appended: it caught BOTH, with correct line numbers, and
 *     printed PUSH BLOCKED. An earlier read of this incident — mine and a peer's, independently —
 *     said the gate had gone dark. Both of us had measured with the agent wrapper rather than with
 *     the grep the hook actually runs.
 *
 * SO THE INVARIANT IS ABOUT LUCK, NOT ABOUT DAMAGE DONE. Position decides whether /usr/bin/grep
 * calls the file binary — demonstrated below: the same NUL at byte 22 does, at byte ~260000 it does
 * not — and nothing chose the position.
 *
 * WHAT AN EARLY NUL WOULD ACTUALLY HAVE COST, MEASURED — and this corrects a claim I made in the
 * first version of this header. I wrote that the hook "would have gone silent across every check it
 * runs". IT WOULD NOT, and core-admin measured that before I did. Re-measured here: real
 * gx-preflight.sh, NUL at byte 1 of the real proxy, a genuine `USE_FIXTURES = true` and a real
 * `debug`+`ger;` appended —
 *
 *     leftover present -> both checks FIRED, "Binary file dutchie_proxy.gs matches", PUSH BLOCKED
 *     clean file       -> passed, no false positive
 *
 * `hits` stays non-empty because grep still answers, and the comment filter does not strip that
 * line, so a hard check still sets FAIL. What an early NUL destroys is the REPORT: a filename with
 * no line number and no offending text, on a 240KB proxy. A blocked push nobody can act on is a real
 * defect — just not the silent gate I claimed it was.
 *
 * THE ESCAPE IS THE FIX, NOT THE DELIMITER. The escaped form yields the identical runtime string —
 * verified by executing bugMailOnce_ and reading the digest input back, a real NUL at both joins — so
 * the cache key's collision resistance is unchanged. Do not "simplify" the escape back to a literal
 * byte, and do not switch the delimiter to a printable character on this test's account: a printable
 * delimiter is a real, if small, collision risk in a key built from user-supplied text.
 *
 * The suite-wide half belongs in gx-theme: `grep -a` in gx-preflight.sh makes the gate immune by
 * position rather than by luck. That is core-admin's file and it has been asked for. This test is the
 * half Sales owns, and it runs inside the same push gate.
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

// Exactly the set gx-preflight.sh greps, minus the dev files it exempts by name — so this test's
// coverage cannot quietly diverge from the gate it is protecting.
const EXEMPT = new Set(['gx-dev.js', 'gx-preflight.sh', 'serve.py', 'serve.js']);
const files = cp.execSync("git ls-files '*.html' '*.js' '*.css' '*.gs'", { cwd: ROOT })
  .toString().split('\n').filter((f) => f && !EXEMPT.has(f));

ok('there are shipped files to check', files.length > 0);

console.log('\nno shipped source may contain a NUL byte (' + files.length + ' files)');
for (const f of files) {
  const buf = fs.readFileSync(path.join(ROOT, f));
  const n = buf.indexOf(0);
  /* Log SEPARATELY from the assertion. The first cut of this folded the report into the condition as
     `n === -1 || !console.log(...)` — console.log returns undefined, `!undefined` is true, so the
     check could never fail. It printed the offending offset and said "0 failed" in the same breath:
     the exact failure this file exists to catch, committed inside the catcher. Found only by running
     it against the known-bad file instead of trusting a green run. */
  if (n !== -1) console.log('       first NUL at byte offset ' + n);
  ok(f + ' has no NUL byte', n === -1);
}

/* WHY THE INVARIANT NEEDS A TEST RATHER THAN A COMMENT: the hazard is real but position-dependent,
 * which is the worst combination — a clean run proves nothing about the next NUL.
 *
 * This pins the MECHANISM against the grep the hook actually runs (/bin/sh -> /usr/bin/grep, never
 * the agent wrapper). If a future grep classifies the whole file instead of the first block, the
 * second assertion flips and this comment explains why. Either way the invariant above is what
 * protects the repo; this block only justifies it.
 */
console.log('\nwhy position must not be relied on — measured with the hook\'s own grep');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-nul-'));
  const filler = Buffer.from('// filler\n'.repeat(26000));       // ~260KB, well past any first block
  // A neutral token on purpose: this file is itself grepped by gx-preflight.sh, and planting a
  // real `debug` + `ger;` here would trip the gate on the test that protects the gate.
  const lead   = Buffer.from('GXNULPROBE;\n');
  const bad    = Buffer.concat([Buffer.from('const x = "a'), Buffer.from([0]), Buffer.from('b";\n')]);
  fs.writeFileSync(path.join(dir, 'early.gs'), Buffer.concat([lead, bad, filler]));
  fs.writeFileSync(path.join(dir, 'late.gs'),  Buffer.concat([lead, filler, bad]));

  const seesText = (f) => {
    try {
      const out = cp.execSync('/usr/bin/grep -HnE "GXNULPROBE" ' + JSON.stringify(path.join(dir, f)),
                              { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return /:1:GXNULPROBE;/.test(out);     // a real line hit, not "Binary file ... matches"
    } catch (e) { return false; }
  };
  ok('a NUL in the first block DOES blind the hook\'s grep', !seesText('early.gs'));
  ok('the same NUL late in the file does not — so this was luck, not safety', seesText('late.gs'));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
