#!/usr/bin/env node
// 03. Normal Refund — refund a fiscalised sale. This script first makes a sale
// (so it runs standalone), then refunds it. The refund reuses the sale's SAME
// invoiceNumber (evolving-invoice model) and points referentDocumentNumber at
// the sale's fiscal number; referentDocumentDT is omitted (server derives it).
//   node --env-file=.env examples/03-normal-refund.mjs
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
const lineItems = [vatLine("Coffee 250g", 500, 2)];
const payment = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (a) the sale to refund
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: payment(totalsOf(lineItems)),
    ...totalsOf(lineItems),
  }),
  "sale to refund",
);
const src = firstFiscal(sale);

// (b) the refund — SAME invoiceNumber, referencing the sale's fiscal number
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
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
      payments: payment(totalsOf(refundLines)),
      ...totalsOf(refundLines),
    }),
    "03. Normal Refund",
  ),
  "Normal Refund",
);
