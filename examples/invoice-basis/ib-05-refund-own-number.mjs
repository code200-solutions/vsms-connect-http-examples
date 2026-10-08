#!/usr/bin/env node
// ib-05. Refund an at-issue sale with the refund's OWN number (refundNumber).
//
//   node --env-file=.env examples/invoice-basis/ib-05-refund-own-number.mjs
//
// WHAT THIS SHOWS
//   Same as ib-02, plus `refundNumber` - the refund document's own reference.
//   `invoiceNumber` still equals the sale's number and still FINDS the sale;
//   `refundNumber` is what the refund's fiscal receipt prints as its Invoice ID.
//
// BASIS
//   An explicit REFUND is resolved the same way on cash and invoice basis, so
//   `refundNumber` behaves identically on both (see examples/28 for cash basis).
//   It is REFUND-only: the partial refund the server DECLARES for you when you
//   re-push a SALE with a lower total (ib-04) is a system-generated document -
//   it cannot carry a `refundNumber` (a SALE body that sends one is 422
//   REFUND_NUMBER_REFUND_ONLY).
//
// RESPONSE
//   The response's `invoiceNumber` still echoes the `invoiceNumber` you sent (the
//   sale's); `refundNumber` is not a response field.
//
// REQUIRES an invoice-basis business - see ./README.md.
import {
  expectAtIssue,
  expectFiscalised,
  fiscalise,
  IB,
  printReceipt,
  requireFiscal,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../lib.mjs";

const invoiceNumber = uniqueNumber("IB");
const refundNumber = uniqueNumber("IB-RFND");
const now = () => new Date().toISOString();
const lineItems = [vatLine("Coffee 250g", 500, 2)];

// (a) the at-issue sale to refund — no payments, per ib-01.
const sale = await expectAtIssue(
  await fiscalise(
    {
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "SALE",
      storeCode: STORE_CODE,
      invoiceDate: now(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems,
      ...totalsOf(lineItems),
    },
    IB,
  ),
  "sale to refund",
  IB,
);
printReceipt(sale, "At-issue sale");
// A refund needs a SIGNED source — clear message rather than a crash if not.
requireFiscal(sale, "sale to refund");

// (b) the refund — SAME invoiceNumber, and nothing else naming the source.
//     `payments` IS required here (see the header note).
const refundLines = [vatLine("Coffee 250g — returned", 500, 2)];
const refundTotals = totalsOf(refundLines);
printReceipt(
  await expectFiscalised(
    await fiscalise(
      {
        invoiceNumber, // SAME as the sale: finds it
        refundNumber, // the refund's OWN number (prints as the Invoice ID)
        invoiceType: "NORMAL",
        transactionType: "REFUND",
        invoiceDate: now(),
        currencyCode: "VUV",
        cashierId: "example-pos",
        lineItems: refundLines,
        payments: [
          {
            amount: refundTotals.totalAmount,
            paymentType: "CASH",
            paymentDate: now(),
          },
        ],
        ...refundTotals,
      },
      IB,
    ),
    "ib-05. Refund with its own number",
    IB,
  ),
  "Refund",
  invoiceNumber,
);

console.log(
  `\nsale   Invoice ID on its receipt : ${invoiceNumber}\n` +
    `refund Invoice ID on its receipt : ${refundNumber}`,
);
