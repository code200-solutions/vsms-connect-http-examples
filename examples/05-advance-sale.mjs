#!/usr/bin/env node
// 05. Advance Sale — a layby / instalment sale: one invoice paid over several
// deposits. Send ONE POST with multiple payments[]; the server signs the
// non-final deposits as ADVANCE and the last as NORMAL (closing the chain).
// Each deposit gets its own fiscal number (see paymentResults[]).
//   node --env-file=.env examples/05-advance-sale.mjs
import {
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

// 30,000 net + 4,500 tax = 34,500 total, paid as 3 deposits of 11,500.
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
  lineItems,
  payments: [
    { amount: 11500, paymentType: "CARD", paymentDate: now() },
    { amount: 11500, paymentType: "CASH", paymentDate: now() },
    { amount: 11500, paymentType: "CASH", paymentDate: now() },
  ],
  ...totalsOf(lineItems), // subtotal 30000, tax 4500, total 34500
};

printReceipt(
  await expectFiscalised(await fiscalise(body), "05. Advance Sale"),
  "Advance Sale (3 deposits)",
);
