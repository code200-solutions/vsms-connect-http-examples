#!/usr/bin/env node
// 25. Reuse an invoiceNumber for another SALE → 409 INVOICE_DUPLICATE.
//
//   node --env-file=.env examples/25-duplicate-invoice-number.mjs
//
// WHAT THIS SHOWS
//   Make a sale, then send ANOTHER sale on the same invoiceNumber (with a
//   different body). A SALE always creates a NEW invoice, so its number must be
//   unused — the server rejects the second one with 409 INVOICE_DUPLICATE and
//   names the existing invoiceId + status so you can reconcile.
//
// HOW IT WORKS
//   A fresh SALE cannot reuse a number that already identifies an invoice (an
//   invoice is always ingested fully paid, so there is nothing to extend).
//   Because this second body differs from the first, it is NOT a cached replay
//   (see 24-retry-same-body.mjs) — it reaches the handler and hits the
//   duplicate guard.
//
// CONTRAST
//   24 = identical body      → replay (silently absorbed, no error).
//   25 = different SALE body  → 409 INVOICE_DUPLICATE (a new sale can't reuse a number).
//   26 = REFUND, same number  → linked refund (reuse is valid for a refund).
//   The lesson: reusing an invoiceNumber is only ever for a REFUND of that sale.
import {
  fiscalise,
  expectFiscalised,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-DUP");
const lineItems = [vatLine("Coffee 250g", 500, 2)];
const cashPayment = () => [
  {
    amount: totalsOf(lineItems).totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (1) the original sale.
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: cashPayment(),
    ...totalsOf(lineItems),
  }),
  "original sale",
);
printReceipt(sale, "Original sale");

// (2) another SALE on the SAME number — a different body (different cashier), so
// it is not a cached replay; it reaches the handler and hits the duplicate guard.
const retry = await fiscalise({
  invoiceNumber,
  invoiceType: "NORMAL",
  transactionType: "SALE",
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "different-till",
  lineItems,
  payments: cashPayment(),
  ...totalsOf(lineItems),
});

const isDuplicate =
  retry.envelope?.error && retry.envelope.code === "INVOICE_DUPLICATE";

console.log("\nSecond SALE on the same invoiceNumber:");
if (isDuplicate) {
  console.log(`  ✓ 409 INVOICE_DUPLICATE — "${retry.envelope.message}"`);
} else {
  console.error(
    `  ✗ expected 409 INVOICE_DUPLICATE, got ${retry.status} ${retry.envelope?.code ?? "?"}`,
  );
  process.exit(1);
}
