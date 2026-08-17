#!/usr/bin/env node
// 26. Reuse an invoiceNumber for a REFUND → a distinct linked document.
//
//   node --env-file=.env examples/26-reuse-number-for-refund.mjs
//
// WHAT THIS SHOWS
//   Make a sale, then send a REFUND on the SAME invoiceNumber. This does not
//   duplicate the sale and is not a replay — the server resolves the source sale
//   by that number and records a SEPARATE linked refund with its own, brand-new
//   server-issued invoiceId.
//
// HOW IT WORKS
//   The source payment is resolved automatically from the shared invoiceNumber
//   (TAXCORE-639) — you do NOT need to hold the SDC fiscalInvoiceNumber. A sale
//   and its refund deliberately share one invoiceNumber (the "evolving-invoice"
//   model); they are distinguished by transactionType, not by the number.
//
// RELATION TO 03
//   This is the idempotency-framed view of 03-normal-refund: the focus here is
//   that reusing the number yields a NEW invoiceId (a linked document), never a
//   duplicate or a mutation of the sale.
import {
  fiscalise,
  expectFiscalised,
  requireFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-REUSE");
const saleLines = [vatLine("Coffee 250g", 500, 2)];
const cash = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (1) the sale.
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    payments: cash(totalsOf(saleLines)),
    ...totalsOf(saleLines),
  }),
  "sale",
);
requireFiscal(sale, "sale"); // must be signed before it can be refunded
printReceipt(sale, "Sale");

// (2) the refund — SAME invoiceNumber, transactionType REFUND. The server
// resolves the source sale from the number; no SDC number is supplied.
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
const refund = await expectFiscalised(
  await fiscalise({
    invoiceNumber, // SAME number as the sale
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
printReceipt(refund, "Refund");

const distinct = refund.invoiceId !== sale.invoiceId;
console.log("\nSame invoiceNumber, two documents:");
console.log(`  sale   invoiceId : ${sale.invoiceId}`);
console.log(`  refund invoiceId : ${refund.invoiceId}`);
console.log(
  distinct
    ? "  ✓ distinct invoiceIds — the refund is a linked document, not a duplicate."
    : "  ✗ expected the refund to have its own invoiceId.",
);
if (!distinct) process.exit(1);
