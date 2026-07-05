#!/usr/bin/env node
// 01. Normal Sale — a plain POS sale: one VAT15 line, one CASH payment.
//   node --env-file=.env examples/01-normal-sale.mjs
import {
  fiscalise,
  expectFiscalised,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const lineItems = [vatLine("Coffee 250g", 500, 2)];
const body = {
  invoiceNumber: uniqueNumber(),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: [
    {
      amount: totalsOf(lineItems).totalAmount,
      paymentType: "CASH",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(lineItems),
};

printReceipt(
  await expectFiscalised(await fiscalise(body), "01. Normal Sale"),
  "Normal Sale",
);
