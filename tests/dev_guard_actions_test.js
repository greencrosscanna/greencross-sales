#!/usr/bin/env node
/* gx-dev.js guards the fetch layer on localhost: any request carrying an `action` that is not in
 * window.GX_DEV_READS is BLOCKED until writes are armed. That is the right default — it is what
 * stops a dev session writing to the live backend by accident — but it has a failure mode that
 * only ever bites the person building the next feature:
 *
 *   you add a READ, forget to declare it, and the tab fails on localhost ONLY.
 *
 * It works in production, so nothing in CI or the push gate notices. Worse, the failure surfaces as
 * whatever error message that tab prints, which will happily blame the backend. That is not
 * hypothetical: the Reconcile tab shipped with `deposits` undeclared and reported "GX Core hasn't
 * shipped qb_deposits yet" at a moment when GX Core had, in fact, shipped it.
 *
 * So: every action this page can request must be ACCOUNTED FOR — declared as a read, or named here
 * as a deliberate write. A write left out of GX_DEV_READS is correct and expected; an action in
 * NEITHER list is the bug this file exists to catch.
 *
 * Actions are collected two ways, because the app requests them two ways: literal `action=NAME` in
 * a URL, and the reconPost(action, …) helper that builds the query string. Grepping only for the
 * literal form would have missed all three reconciliation writes.
 */
'use strict';
const fs = require('fs'), path = require('path');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (msg, cond) => { if (cond) { pass++; console.log('  ok   ' + msg); }
                            else      { fail++; console.log('  FAIL ' + msg); } };

// ── The declared reads, lifted from the page ──────────────────────────────────────────────────
const READS_SRC = /window\.GX_DEV_READS = \[([\s\S]*?)\];/.exec(HTML);
if (!READS_SRC) { console.log('window.GX_DEV_READS is gone from index.html — the dev guard has no list');
                  console.log('\n0 passed, 1 failed'); process.exit(1); }
const READS = new Set((READS_SRC[1].match(/'[a-z_]+'/g) || []).map(s => s.slice(1, -1)));
ok('GX_DEV_READS is present and non-empty', READS.size > 0);

// ── Writes, declared here on purpose ──────────────────────────────────────────────────────────
// These MUST NOT be in GX_DEV_READS. Every one mutates something, and the whole point of the guard
// is that a dev session cannot fire them at the live backend without arming first.
const WRITES = new Set([
  'reportbug', 'save_expense_mapping', 'set_otherrev', 'set_revenue',
  'set_recon', 'set_recon_assign', 'set_recon_config',
  // Smart budget. apply_budget stores the overlay, clear_budget drops it — both mutate, both are
  // write-guarded in the proxy, and neither may be declared a read.
  'apply_budget', 'clear_budget',
  // The bills-once flag is written from the budget planner and READ by the Expenses tab to decide
  // whether to pace a category. It mutates a script property, so it is a write like any other.
  'set_bills_once',
  // Marking an ATM month's vendor payment as received. Writes a script property, is
  // write-guarded in the proxy, and must never be armed by default on localhost.
  'set_atm_paid',
]);

// ── Every action the page can request ─────────────────────────────────────────────────────────
const requested = new Set();
for (const m of HTML.matchAll(/[?&]action=([a-z_]+)/g)) requested.add(m[1]);
// The reconciliation writes go through a helper, so they never appear as a literal action=NAME.
for (const m of HTML.matchAll(/reconPost\(\s*'([a-z_]+)'/g)) requested.add(m[1]);
ok('found the actions this page requests', requested.size >= 15);
ok('...including ones built by the reconPost helper, not just literals',
   requested.has('set_recon') && requested.has('set_recon_config') && requested.has('set_recon_assign'));

// ── The invariant ─────────────────────────────────────────────────────────────────────────────
const orphans = [...requested].filter(a => !READS.has(a) && !WRITES.has(a)).sort();
ok('every requested action is either a declared read or a known write'
   + (orphans.length ? ' — MISSING: ' + orphans.join(', ') : ''),
   orphans.length === 0);

// A write must never be quietly declared as a read; that would disarm the guard for it.
const leaked = [...WRITES].filter(w => READS.has(w)).sort();
ok('no write is listed as a read' + (leaked.length ? ' — LEAKED: ' + leaked.join(', ') : ''),
   leaked.length === 0);

// ── The specific regression ───────────────────────────────────────────────────────────────────
ok('deposits is declared — the Reconcile tab reads it on every load', READS.has('deposits'));
for (const w of ['set_recon', 'set_recon_assign', 'set_recon_config']) {
  ok(`${w} stays guarded, so reconciling on localhost needs ARM WRITES`, !READS.has(w));
}

// ── The list stays sorted, so the next person can see what is there ───────────────────────────
const listed = (READS_SRC[1].match(/'[a-z_]+'/g) || []).map(s => s.slice(1, -1));
const sorted = [...listed].sort();
ok('GX_DEV_READS is in alphabetical order', listed.join(',') === sorted.join(','));
ok('GX_DEV_READS has no duplicates', new Set(listed).size === listed.length);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
