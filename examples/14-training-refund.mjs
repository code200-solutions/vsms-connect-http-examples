#!/usr/bin/env node
// 14. Training Refund — refund a training sale (training:true on both). A
// training refund can only reference a training fiscal number. This script
// makes the training sale first, then refunds it.
//   node --env-file=.env examples/14-training-refund.mjs
import {
  fiscalise,
  expectFiscalised,
  requireFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-TRAIN");
const now = () => new Date().toISOString();
const lineItems = [vatLine("Demo item", 100, 1)];
const pay = (t) => [
  { amount: t.totalAmount, paymentType: "CASH", paymentDate: now() },
];

const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    training: true,
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "trainee-1",
    lineItems,
    payments: pay(totalsOf(lineItems)),
    ...totalsOf(lineItems),
  }),
  "training sale to refund",
);
requireFiscal(sale, "training sale to refund");

const refundLines = [vatLine("Demo item — refund", 100, 1)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "REFUND",
      training: true,
      invoiceDate: now(),
      currencyCode: "VUV",
      cashierId: "trainee-1",
      lineItems: refundLines,
      payments: pay(totalsOf(refundLines)),
      ...totalsOf(refundLines),
    }),
    "14. Training Refund",
  ),
  "Training Refund",
);
