#!/usr/bin/env node
// 28. A REFUND with its OWN reference number (refundNumber).
//
//   node --env-file=.env examples/28-refund-own-number.mjs
//
// WHAT THIS SHOWS
//   `invoiceNumber` on a refund must equal the original sale's number — it is the
//   key the server uses to FIND the sale. That used to mean the refund receipt
//   printed the sale's number as its "Invoice ID". `refundNumber` (optional,
//   REFUND-only, ≤60 chars) carries the refund document's OWN number instead:
//
//       invoiceNumber : "EX-SALE-…"  → finds the sale      (same as the sale)
//       refundNumber  : "EX-RFND-…"  → the refund's own id (what the receipt prints)
//
// WITHOUT refundNumber
//   Nothing changes: the refund inherits the sale's number (see 03 / 26).
//
// WHAT THE RESPONSE ECHOES
//   The response's `invoiceNumber` still echoes the `invoiceNumber` you sent (the
//   sale's) — that is the correlation key. `refundNumber` is the refund's own
//   number on the fiscal receipt; it is not a second echo field.
//
// HANDLES AFTERWARDS
//   A refund can later be copied or cancelled by the sale's invoiceNumber, or by
//   its own refundNumber.
import {
  expectFiscalised,
  fiscalise,
  printReceipt,
  requireFiscal,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-SALE");
const refundNumber = uniqueNumber("EX-RFND");
const saleLines = [vatLine("Coffee 250g", 500, 2)];
const cash = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (1) the sale — prints `invoiceNumber` as its Invoice ID.
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    storeCode: STORE_CODE,
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    payments: cash(totalsOf(saleLines)),
    ...totalsOf(saleLines),
  }),
  "sale",
);
requireFiscal(sale, "sale");
printReceipt(sale, "Sale");

// (2) the refund — invoiceNumber finds the sale, refundNumber is its own number.
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
const refund = await expectFiscalised(
  await fiscalise({
    invoiceNumber, // SAME as the sale: resolves the source
    refundNumber, // the refund's OWN number (prints as the Invoice ID)
    invoiceType: "NORMAL",
    transactionType: "REFUND",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: refundLines,
    payments: cash(totalsOf(refundLines)),
    ...totalsOf(refundLines),
  }),
  "refund",
);
printReceipt(refund, "Refund"); // echoes invoiceNumber (the sale's), not refundNumber

console.log("\nTwo documents, two numbers:");
console.log(`  sale   Invoice ID : ${invoiceNumber}`);
console.log(`  refund Invoice ID : ${refundNumber}`);
