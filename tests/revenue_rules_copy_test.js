#!/usr/bin/env node
/* ─── Sales' revenue rules are a VERBATIM copy of GX Core's — byte for byte, answer for answer ────
 *
 *   RUN:  node tests/revenue_rules_copy_test.js     (from the repo root; no deps, no network)
 *
 * WHY. Today's figure on the GX Core fallback path is net/gross/discount/tax/COGS summed from Dutchie
 * transactions by salesFromTxns. Until slice 7 that was a library call to Core's own function. The
 * library is unbound, Core has no route for a pure sum, so revenue_rules.gs carries Core's functions.
 * This app's history is a copy of exactly these rules drifting (returns counted as sales, truthy tax)
 * under a comment that said "keep in sync". This test is the mechanism that comment never was.
 *
 *   1. every function in revenue_rules.gs is byte-identical to the one of the same name in the hub's
 *      gx_dutchie.gs (a whitespace change counts — re-copy, never edit in place);
 *   2. both give the same answer on Dutchie-shaped transactions, including the shapes that separate
 *      plausible rules (returns flagged and unflagged, voids, non-retail, $0 tax, line items);
 *   3. dtodayFromRows_ uses the copy, and nothing else in Sales defines the rules;
 *   4. a deliberate one-character break in the copy is caught by (1) AND (2).
 *
 * SKIPS (does not fail) when greencross-command-center is not a sibling checkout — the hub's own
 * revenue_rules_contract_test covers the same ground from the other side when it does run.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const HUB_DUTCHIE = path.join(__dirname, '..', '..', 'greencross-command-center', 'gx_dutchie.gs');
const COPY = fs.readFileSync(path.join(__dirname, '..', 'revenue_rules.gs'), 'utf8');
const PROXY = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const NAMES = ['gxNum_', 'gxTxItems_', 'txNet', 'txDiscount', 'txGross', 'txTax', 'txCogs', 'gxIsRetail_', 'salesFromTxns'];

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(src, name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(src);
  if (!m) return null;
  let i = src.indexOf('{', m.index + 1), d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(m.index + 1, j + 1);
}
function load(src) { const c = {}; vm.createContext(c); vm.runInContext(src, c); return c; }

console.log('\n3. Sales uses the copy, and has only the one');
{
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const fn = strip(grab(PROXY, 'dtodayFromRows_') || '');
  ok(/= salesFromTxns\(sales\)/.test(fn) && /= salesFromTxns\(byDay\[d\]\)/.test(fn), 'dtodayFromRows_ sums the day and each date with salesFromTxns');
  // Fails if someone "fixes" a rule locally instead of re-copying: two definitions, one of them wrong.
  ok(NAMES.every(n => !grab(PROXY, n)), 'dutchie_proxy.gs defines none of the nine rule functions');
  ok(!/\bGXCore\s*\.\s*\w+\s*\(/.test(strip(PROXY)), 'and no code anywhere still calls the GXCore library');
  ok(NAMES.every(n => !!grab(COPY, n)), 'revenue_rules.gs holds all nine');
}

if (!fs.existsSync(HUB_DUTCHIE)) {
  console.log('\nSKIP sections 1, 2 and 4 — greencross-command-center is not a sibling checkout.');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
const CORE = fs.readFileSync(HUB_DUTCHIE, 'utf8');

/* Dutchie-shaped: the item keys Dutchie returned 2026-09-17 with IncludeDetail=true, plus every shape
   that tells two plausible rule sets apart. Arrays of transactions, as dtodayFromRows_ passes them. */
const tx = o => Object.assign({ transactionType: 'Retail', isVoid: false, transactionDateLocalTime: '2026-11-25T12:00:00' }, o);
const DAYS = [
  ['an ordinary day', [
    tx({ totalBeforeTax: 42.5, totalDiscount: 7.5, tax: 8.5, items: [{ productId: 7, sku: 'A1', quantity: 2, unitCost: 6.25, unitPrice: 25, totalPrice: 50 }] }),
    tx({ totalBeforeTax: 18, totalDiscount: 0, tax: 3.6, items: [{ productId: 9, quantity: 1, unitCost: 5.1 }] }),
  ]],
  ['a flagged return', [tx({ totalBeforeTax: 100, totalDiscount: 10, tax: 20, items: [{ costOfGoods: 30, quantity: 1 }] }),
                        tx({ totalBeforeTax: -20, totalDiscount: 0, tax: -4, isReturn: true, items: [] })]],
  ['an UNFLAGGED negative (Dutchie does not always set isReturn)', [tx({ totalBeforeTax: 60, tax: 12 }), tx({ totalBeforeTax: -15, tax: -3 })]],
  ['a void and a non-retail row', [tx({ totalBeforeTax: 30, tax: 6 }), tx({ totalBeforeTax: 999, isVoid: true }), tx({ totalBeforeTax: 500, transactionType: 'Transfer' })]],
  ['$0 tax that must NOT fall through to taxAmount', [tx({ totalBeforeTax: 40, tax: 0, taxAmount: 6 })]],
  ['older field names: subtotal, discountTotal, lineItems, cost/qty', [tx({ subtotal: 25, discountTotal: 5, taxAmount: 2, lineItems: [{ cost: 3, qty: 4 }, { cost: 1, qty: 1, isReturned: true }] })]],
  ['string money and a zero quantity', [tx({ totalBeforeTax: '12.34', totalDiscount: '1.00', tax: '0.99', items: [{ unitCost: '2.5', quantity: 0 }] })]],
  ['penny rounding across many rows', Array.from({ length: 37 }, (_, i) => tx({ totalBeforeTax: 9.99 + i * 0.01, totalDiscount: 0.333, tax: 1.999 }))],
  ['an empty day', []],
];

function sameAnswers(copyCtx, coreCtx) {
  const diffs = [];
  for (const [label, txns] of DAYS) {
    const a = JSON.stringify(copyCtx.salesFromTxns(JSON.parse(JSON.stringify(txns))));
    const b = JSON.stringify(coreCtx.salesFromTxns(JSON.parse(JSON.stringify(txns))));
    if (a !== b) diffs.push(label + ': copy ' + a + ' vs Core ' + b);
  }
  return diffs;
}
const coreCtx = load(NAMES.map(n => grab(CORE, n)).join('\n'));

console.log('\n1. byte-identical to Core, function by function');
for (const n of NAMES) {
  const a = grab(COPY, n), b = grab(CORE, n);
  ok(!!b && a === b, '`' + n + '` is byte-identical to gx_dutchie.gs' + (b ? '' : ' (Core no longer has it — re-copy)'));
}

console.log('\n2. and gives Core\'s answer on every Dutchie-shaped day');
{
  const diffs = sameAnswers(load(COPY), coreCtx);
  diffs.forEach(d => console.log('        ' + d));
  ok(diffs.length === 0, 'the copy equals Core on all ' + DAYS.length + ' days');
  const r = coreCtx.salesFromTxns(DAYS[1][1]);
  ok(r.net === 80 && r.gross === 110 && r.orders === 1 && r.returned === 20, 'not vacuous: a return nets out of revenue but not gross or orders');
}

console.log('\n4. a one-character break in the copy is caught, by both checks');
{
  const mutants = [
    ['tax read with || instead of != null', s => s.replace('tx.tax != null ? tx.tax : tx.taxAmount', 'tx.tax || tx.taxAmount')],
    ['returns counted as orders', s => s.replace('if (tx.isReturn === true || n < 0) {', 'if (tx.isReturn === true) {')],
    ['voids let through', s => s.replace("=== 'retail' && !tx.isVoid", "=== 'retail'")],
  ];
  for (const [label, mutate] of mutants) {
    const bad = mutate(COPY);
    if (bad === COPY) { ok(false, 'mutant did not apply (the copy changed shape): ' + label); continue; }
    const textCaught = NAMES.some(n => grab(bad, n) !== grab(CORE, n));
    const answerCaught = sameAnswers(load(bad), coreCtx).length > 0;
    ok(textCaught && answerCaught, 'caught: ' + label + ' (text ' + textCaught + ', answers ' + answerCaught + ')');
  }
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
