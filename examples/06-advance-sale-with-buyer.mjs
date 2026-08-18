#!/usr/bin/env node
// 06. Advance Sale with buyer identification — the deposit chain from 05 plus
// a buyer block.
//   node --env-file=.env examples/06-advance-sale-with-buyer.mjs
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

const lineItems = [vatLine("Furniture layby — sofa set", 10000, 3)];
const now = () => new Date().toISOString();
const body = {
  invoiceNumber: uniqueNumber("EX-LAY"),
  invoiceType: "ADVANCE",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: now(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  buyer: BUYER,
  lineItems,
  payments: [
    { amount: 11500, paymentType: "CARD", paymentDate: now() },
    { amount: 11500, paymentType: "CASH", paymentDate: now() },
    { amount: 11500, paymentType: "CASH", paymentDate: now() },
  ],
  ...totalsOf(lineItems),
};

printReceipt(
  await expectFiscalised(
    await fiscalise(body),
    "06. Advance Sale with buyer identification",
  ),
  "Advance Sale with buyer",
);
