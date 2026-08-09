#!/usr/bin/env node
// 15. Cancel — reverse a fiscalised sale with a V-SDC counter-document. The
// original receipt is NOT mutated; V-SDC signs a NEW record reversing it.
//
// This script makes a sale, then cancels it by REUSING the sale's
// invoiceNumber — no SDC fiscalInvoiceNumber needed (TAXCORE-639). The server
// resolves the single fiscalised payment under that number. Because a cancel
// signs a reversing document it is fail-closed: if the number were ambiguous
// (e.g. a sale AND a refund share it) the server answers 422, and you name the
// target with `transactionType` and/or `externalPaymentId` (or pass a
// `fiscalInvoiceNumber` string to cancelDoc to target it by SDC number).
//   node --env-file=.env examples/15-cancel.mjs
import {
  fiscalise,
  expectFiscalised,
  requireFiscal,
  cancelDoc,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber();
const now = () => new Date().toISOString();
const lineItems = [vatLine("Coffee 250g", 500, 2)];

// (a) a normal sale to cancel.
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: [
      {
        amount: totalsOf(lineItems).totalAmount,
        paymentType: "CASH",
        paymentDate: now(),
      },
    ],
    ...totalsOf(lineItems),
  }),
  "sale to cancel",
);
requireFiscal(sale, "sale to cancel"); // a cancel needs a SIGNED payment

// (b) cancel it by the caller's own invoiceNumber — no SDC number.
const result = await cancelDoc({ invoiceNumber });
console.log(`HTTP ${result.status}`);
if (result.envelope.error) {
  console.error(`${result.envelope.code}: ${result.envelope.message}`);
  process.exit(1);
}
console.log("cancellationPaymentId:", result.payload.cancellationPaymentId);
printReceipt(result.payload, "Cancellation");
