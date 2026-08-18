#!/usr/bin/env node
// 02. Normal Sale with buyer identification — same as 01 plus a buyer block.
// buyer.tin makes the receipt a tax-deductible expense record; buyer.email
// receives an auto-emailed receipt copy (when the business has auto-email on).
//   node --env-file=.env examples/02-normal-sale-with-buyer.mjs
import {
  BUYER,
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const lineItems = [vatLine("Office supplies bundle", 5000, 1)];
const body = {
  invoiceNumber: uniqueNumber(),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  buyer: BUYER,
  lineItems,
  payments: [
    {
      amount: totalsOf(lineItems).totalAmount,
      paymentType: "CARD",
      paymentDate: new Date().toISOString(),
    },
  ],
  ...totalsOf(lineItems),
};

printReceipt(
  await expectFiscalised(
    await fiscalise(body),
    "02. Normal Sale with buyer identification",
  ),
  "Normal Sale with buyer",
);
