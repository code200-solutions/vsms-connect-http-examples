#!/usr/bin/env node
// 19. Refund in a different tender than the sale — the customer paid CASH but
// is refunded to CARD. The refund body's paymentType drives the credit note's
// tender; it no longer just inherits the original sale's tender.
//   node --env-file=.env examples/19-refund-different-tender.mjs
import {
  fiscalise,
  expectFiscalised,
  firstFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber();
const pay = (t, paymentType) => [
  { amount: t.totalAmount, paymentType, paymentDate: new Date().toISOString() },
];
const lines = [vatLine("Wireless headphones", 8000)];

// (a) the sale — paid in CASH.
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: lines,
    payments: pay(totalsOf(lines), "CASH"),
    ...totalsOf(lines),
  }),
  "sale (paid CASH)",
);
const src = firstFiscal(sale);

// (b) the refund — same amount, but settled to CARD.
const refundLines = [vatLine("Wireless headphones — refund", 8000)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "REFUND",
      referentDocumentNumber: src.number,
      invoiceDate: new Date().toISOString(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems: refundLines,
      payments: pay(totalsOf(refundLines), "CARD"),
      ...totalsOf(refundLines),
    }),
    "19. Refund to a different tender",
  ),
  "Refund settled to CARD",
);
