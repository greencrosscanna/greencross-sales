#!/usr/bin/env node
/* The boot block at the bottom of <body> is what starts a RETURNING session's data load, and for
 * months it could not survive a throw from anything it ran first.
 *
 * What happened: gx-client.js carried `defer`. A deferred script runs only after the whole document
 * is parsed — but this app is a monolith with INLINE js, so every line of its own startup code runs
 * DURING parsing, ahead of the deferred file. paintSalesUserTray() builds the avatar-editor config
 * with an eager GXClient(GXCORE) call, that threw ReferenceError, and because the boot block was a
 * bare sequence the exception took the two statements after it with it. loadAllStores() never ran.
 *
 * The app then sat on "Connecting…" indefinitely — the console error was the only evidence — and
 * pressing "Load live data" in Settings fixed it every time, because that button calls the exact
 * statement the throw had skipped. Reported three times before anyone caught it, because it only
 * bit a returning session: a fresh login happens seconds later, by which point the deferred script
 * has long since run, so it looked intermittent.
 *
 * Three independent guards, each asserted here, because any one of them alone would have hidden the
 * bug rather than prevented the class:
 *
 *   1. gx-client.js loads SYNCHRONOUSLY, so GXClient is a real dependency by the time inline code
 *      runs. This is the cause.
 *   2. The boot block starts the data load first and wraps each decoration in its own try/catch, so
 *      the NEXT decoration to throw cannot take the dashboard down. This is the class.
 *   3. avatarEdit tests for GXClient instead of letting an eager call throw out of an object
 *      literal, so a gx-theme outage costs the avatar row and not the app.
 *
 * Reads the shipped index.html, not a copy, so deleting a guard fails the suite.
 */
'use strict';
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (m, c) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m); } };

console.log('\n1. gx-client.js must not be deferred past the inline boot code');
{
  const tag = /<script([^>]*)src="[^"]*gx-client\.js"[^>]*>/.exec(HTML);
  ok('the gx-client.js tag is present', !!tag);
  ok('...and carries neither defer nor async', !!tag && !/\b(defer|async)\b/.test(tag[1]));

  // Position matters as much as the attribute: a synchronous tag placed AFTER the boot block is
  // exactly as useless as a deferred one.
  const tagIdx  = HTML.indexOf('gx-client.js');
  const bootIdx = HTML.indexOf('if (GC_SALES_AUTH.isAuthed())');
  ok('...and it is loaded before the boot block that uses it', tagIdx > 0 && bootIdx > tagIdx);

  ok('a comment warns the next reader off re-adding defer',
     /DO NOT put `defer` back on this tag/.test(HTML));
}

// Slice the boot block: from the isAuthed() test to the end of its else branch.
const bootStart = HTML.indexOf('if (GC_SALES_AUTH.isAuthed())');
const boot = HTML.slice(bootStart, HTML.indexOf('showLoginScreen();', bootStart) + 40);

console.log('\n2. the data load must not sit behind anything that can throw');
{
  const loadIdx = boot.indexOf('loadAllStores()');
  const trayIdx = boot.indexOf('paintSalesUserTray()');
  const wnIdx   = boot.indexOf('loadWhatsNewSales()');
  const hbIdx   = boot.indexOf('startSalesHeartbeat()');

  ok('loadAllStores() is called on boot at all', loadIdx > 0);
  ok('...before the user tray paints',       trayIdx > loadIdx);
  ok('...before the heartbeat starts',       hbIdx   > loadIdx);
  ok('...before the what\'s-new fetch',      wnIdx   > loadIdx);
}

console.log('\n3. every decoration is individually guarded');
{
  ok('loadAllStores() itself is wrapped, so even a synchronous throw is logged not swallowed',
     // The promise is kept (2026-09-17) so what's-new can wait for the first load; still wrapped.
     /try\s*\{\s*(?:_bootLoad\s*=\s*)?loadAllStores\(\);\s*\}\s*catch/.test(boot));
  ok('the user chrome (tray, bug fab, revenue visibility) is wrapped',
     /paintSalesUserTray\(\)[\s\S]{0,400}?\}\s*catch\s*\([\s\S]{0,120}?\[boot\] user chrome/.test(boot));
  ok('the heartbeat is wrapped', /try\s*\{\s*startSalesHeartbeat\(\);\s*\}\s*catch/.test(boot));
  ok('what\'s-new is wrapped',   /try\s*\{\s*loadWhatsNewSales\(\);\s*\}\s*catch/.test(boot));

  // A catch that does nothing is how this becomes invisible a second time.
  const catches = boot.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/g) || [];
  ok('no boot catch is silent — every one logs',
     catches.length >= 4 && catches.every(c => /console\.error/.test(c)));
}

console.log('\n4. avatarEdit must not build a client that may not exist');
{
  const m = /avatarEdit:\s*\(([^)]*)\)\s*\?/.exec(HTML);
  ok('avatarEdit is still conditional', !!m);
  ok('...and the condition tests for GXClient before the eager GXClient(GXCORE) call below it',
     !!m && /typeof\s+GXClient\s*===\s*'function'/.test(m[1]));
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
