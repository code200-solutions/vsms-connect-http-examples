#!/usr/bin/env node
// 10. Copy Refund — reprint a fiscalised REFUND. COPY preserves the source's
// transaction type, so this sends transactionType=REFUND. This script builds
// the chain it needs: a sale, a refund of it, then a copy of that refund.
//   node --env-file=.env examples/10-copy-refund.mjs
import {
  fiscalise,
  expectFiscalised,
  firstFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
  msToIso,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber();
const now = () => new Date().toISOString();
const lineItems = [vatLine("Coffee 250g", 500, 2)];
const pay = (t) => [
  { amount: t.totalAmount, paymentType: "CASH", paymentDate: now() },
];

// (a) sale
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: pay(totalsOf(lineItems)),
    ...totalsOf(lineItems),
  }),
  "sale",
);

// (b) refund it
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
const refund = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "REFUND",
    referentDocumentNumber: firstFiscal(sale).number,
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: refundLines,
    payments: pay(totalsOf(refundLines)),
    ...totalsOf(refundLines),
  }),
  "refund to copy",
);
const src = firstFiscal(refund);

// (c) copy the refund
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber: uniqueNumber("EX-COPY"),
      invoiceType: "COPY",
      transactionType: "REFUND", // preserve the source's transaction type
      cashierId: "example-pos",
      source: {
        referencedFiscalNumber: src.number,
        referencedFiscalTimestamp: msToIso(src.timestampMs),
      },
    }),
    "10. Copy Refund",
  ),
  "Copy Refund",
);
