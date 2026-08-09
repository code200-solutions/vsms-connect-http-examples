#!/usr/bin/env node
// 04. Normal Refund with buyer identification — like 03, but the sale and its
// refund both carry the buyer block, so the refund balances the buyer's
// tax-deductible expense record.
//   node --env-file=.env examples/04-normal-refund-with-buyer.mjs
import {
  fiscalise,
  expectFiscalised,
  requireFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
  BUYER,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber();
const lineItems = [vatLine("Office supplies bundle", 5000, 1)];
const pay = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CARD",
    paymentDate: new Date().toISOString(),
  },
];

const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    buyer: BUYER,
    lineItems,
    payments: pay(totalsOf(lineItems)),
    ...totalsOf(lineItems),
  }),
  "buyer sale to refund",
);
// The sale must be signed before we can refund it (clear message if not).
requireFiscal(sale, "buyer sale to refund");

// The refund reuses the sale's invoiceNumber; the server resolves the source
// from it (TAXCORE-639), so no SDC fiscal number is echoed back.
const refundLines = [vatLine("Office supplies bundle — refund", 5000, 1)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "REFUND",
      invoiceDate: new Date().toISOString(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      buyer: BUYER,
      lineItems: refundLines,
      payments: pay(totalsOf(refundLines)),
      ...totalsOf(refundLines),
    }),
    "04. Normal Refund with buyer identification",
  ),
  "Normal Refund with buyer",
);
