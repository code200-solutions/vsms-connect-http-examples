#!/usr/bin/env node
// 03. Normal Refund — refund a fiscalised sale. This script first makes a sale
// (so it runs standalone), then refunds it. The refund reuses the sale's SAME
// invoiceNumber (evolving-invoice model) and points referentDocumentNumber at
// the sale's fiscal number; referentDocumentDT is omitted (server derives it).
//   node --env-file=.env examples/03-normal-refund.mjs
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
    storeCode: STORE_CODE,
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: payment(totalsOf(lineItems)),
    ...totalsOf(lineItems),
  }),
  "sale to refund",
);
// The sale must be signed before we can refund it (clear message if not).
requireFiscal(sale, "sale to refund");

// (b) the refund — SAME invoiceNumber. The server resolves the source from that
// invoiceNumber (TAXCORE-639), so no SDC fiscal number is echoed back.
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "REFUND",
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
