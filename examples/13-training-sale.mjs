#!/usr/bin/env node
// 13. Training Sale — a NORMAL-shaped sale flagged `training: true`. The server
// stamps invoiceType=TRAINING regardless of the invoiceType field, so the
// receipt is a training document (no real-rate fiscal record).
//   node --env-file=.env examples/13-training-sale.mjs
import {
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const lineItems = [vatLine("Demo item", 100, 1)];
const body = {
  invoiceNumber: uniqueNumber("EX-TRAIN"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  training: true, // ← forces TRAINING server-side
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "trainee-1",
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
  await expectFiscalised(await fiscalise(body), "13. Training Sale"),
  "Training Sale",
);
