/* ─── THE REVENUE RULES — A VERBATIM COPY OF GX CORE'S (roadmap [5] slice 7) ─────────────────────
 *
 * Net, gross, discount, tax and COGS for today's figure on the GX Core fallback path
 * (dtodayFromRows_). Until slice 7 this was one call to GXCore.salesFromTxns through the pinned
 * library. Sales no longer binds the library, so a Core fix never again waits on a Sales re-pin, and
 * Core has no route that does this sum (it is a pure function over transactions Sales already holds),
 * so the functions live here.
 *
 * THIS IS A COPY, AND A COPY IS ONLY SAFE WHILE SOMETHING PROVES IT IS STILL ONE. Two tests do:
 *   tests/revenue_rules_copy_test.js            every function below is BYTE-IDENTICAL to the one of
 *                                                the same name in greencross-command-center/gx_dutchie.gs,
 *                                                and both give the same answer on every fixture
 *   greencross-command-center/tests/revenue_rules_contract_test.js   the hub's own suite-wide check
 * Both run in this repo's push gate. Change these only by copying Core's again — never edit in place.
 *
 * The names are Core's own, on purpose: identical text is the strongest proof of identical rules,
 * and a rename would make the test compare something weaker. Nothing else in Sales defines them. */

function gxNum_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
function gxTxItems_(tx) { return Array.isArray(tx.items) ? tx.items : (Array.isArray(tx.lineItems) ? tx.lineItems : []); }
function txNet(tx)      { return gxNum_(tx.totalBeforeTax != null ? tx.totalBeforeTax : (tx.subtotal != null ? tx.subtotal : tx.total)); }
function txDiscount(tx) { return gxNum_(tx.totalDiscount != null ? tx.totalDiscount : tx.discountTotal); }
function txGross(tx)    { return txNet(tx) + txDiscount(tx); }
function txTax(tx)      { return gxNum_(tx.tax != null ? tx.tax : tx.taxAmount); }
function txCogs(tx)     { // Dutchie line-item cost × qty (the canonical COGS)
  return gxTxItems_(tx).reduce(function (s, it) {
    if (!it || it.isReturned) return s;
    var unit = gxNum_(it.costOfGoods != null ? it.costOfGoods : (it.cost != null ? it.cost : it.unitCost));
    var qty  = gxNum_(it.quantity != null ? it.quantity : (it.qty != null ? it.qty : 1)) || 1;
    return s + unit * qty;
  }, 0);
}
function gxIsRetail_(tx) { return String(tx.transactionType || '').toLowerCase() === 'retail' && !tx.isVoid; }
function salesFromTxns(txns) {
  var net = 0, disc = 0, tax = 0, gross = 0, returned = 0, cogs = 0, orders = 0, items = 0;
  (txns || []).forEach(function (tx) {
    if (!gxIsRetail_(tx)) return;
    var n = txNet(tx);
    net += n; disc += txDiscount(tx); tax += txTax(tx);
    if (tx.isReturn === true || n < 0) {
      returned += -n;                 // refund magnitude → Dutchie "Returned Amount"
    } else {
      gross += n + txDiscount(tx);    // pre-return gross → Dutchie "Gross Sales"
      orders += 1;                    // sale orders only → Dutchie "Total Orders"
      cogs += txCogs(tx);
      items += gxTxItems_(tx).filter(function (it) { return it && !it.isReturned; }).length;
    }
  });
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  return { net: r2(net), gross: r2(gross), discount: r2(disc), tax: r2(tax), returned: r2(returned),
    cogs: r2(cogs), orders: orders, items: items, aov: orders ? r2(net / orders) : 0,
    margin: net ? r2((net - cogs) / net * 100) : 0, discountRate: gross ? r2(disc / gross) : 0 };
}
