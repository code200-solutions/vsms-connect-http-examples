#!/usr/bin/env node
// 10. Copy Refund — reprint a fiscalised REFUND. COPY preserves the source's
// transaction type, so this sends transactionType=REFUND. This script builds
// the chain it needs: a sale, a refund of it, then a copy of that refund.
//
// Like a copy of a SALE (09), a refund copy needs NO SDC number: reuse the same
// invoiceNumber and set transactionType=REFUND. The server resolves the refund
// from that invoiceNumber's family (sale + refunds/copies), picking the REFUND
// (TAXCORE-639). If several refunds share the number (partial refunds), add
// `sourceExternalPaymentId` (your own id on the refund) to name one; you can
// still pass `source.referencedFiscalNumber` to target it by SDC number.
//   node --env-file=.env examples/10-copy-refund.mjs
import {
  fiscalise,
  expectFiscalised,
  requireFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
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
requireFiscal(sale, "sale"); // must be signed before we can refund it

// (b) refund it — SAME invoiceNumber; the server resolves the source (TAXCORE-639)
const refundLines = [vatLine("Coffee 250g — refund", 500, 2)];
const refund = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "REFUND",
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: refundLines,
    payments: pay(totalsOf(refundLines)),
    ...totalsOf(refundLines),
  }),
  "refund to copy",
);
// A COPY needs a SIGNED source — guard with a clear message if it isn't.
requireFiscal(refund, "refund to copy");

// (c) copy the refund — reuse the invoiceNumber; transactionType=REFUND tells
// the server to resolve the REFUND in that number's family, not the sale.
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber, // reuse the number → server resolves the refund
      invoiceType: "COPY",
      transactionType: "REFUND", // copy the refund, not the sale
      cashierId: "example-pos",
    }),
    "10. Copy Refund",
  ),
  "Copy Refund",
);
