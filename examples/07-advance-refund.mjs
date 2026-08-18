#!/usr/bin/env node
// 07. Advance Refund — refund ONE deposit of an advance sale. Each deposit was
// fiscalised as its own event, so a refund targets a single deposit's fiscal
// number with a self-contained body scaled to that deposit's amount (11,500).
// A full unwind is one refund per deposit. This script makes the advance sale
// first, then refunds its first deposit.
//   node --env-file=.env examples/07-advance-refund.mjs
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

const invoiceNumber = uniqueNumber("EX-LAY");
const now = () => new Date().toISOString();

// (a) the advance sale (3 deposits of 11,500)
const saleLines = [vatLine("Furniture layby — sofa set", 10000, 3)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "ADVANCE",
    transactionType: "SALE",
    storeCode: STORE_CODE,
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    // Give each deposit our OWN id so a refund can target one of them without
    // the SDC fiscal number (TAXCORE-639, multi-payment disambiguation).
    payments: [
      {
        amount: 11500,
        paymentType: "CARD",
        paymentDate: now(),
        externalPaymentId: "dep-1",
      },
      {
        amount: 11500,
        paymentType: "CASH",
        paymentDate: now(),
        externalPaymentId: "dep-2",
      },
      {
        amount: 11500,
        paymentType: "CASH",
        paymentDate: now(),
        externalPaymentId: "dep-3",
      },
    ],
    ...totalsOf(saleLines),
  }),
  "advance sale to refund",
);
// The sale must be signed before we can refund a deposit (clear message if not).
requireFiscal(sale, "advance sale to refund");

// (b) refund deposit 1 — scaled body (11,500), SAME invoiceNumber. Because the
// invoice has several fiscalised deposits, name WHICH one via our own id
// (`sourceExternalPaymentId`) rather than the SDC fiscal number (TAXCORE-639).
const refundLines = [vatLine("Furniture layby — refund deposit 1/3", 10000, 1)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "ADVANCE",
      transactionType: "REFUND",
      sourceExternalPaymentId: "dep-1",
      invoiceDate: now(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems: refundLines,
      payments: [{ amount: 11500, paymentType: "CASH", paymentDate: now() }],
      ...totalsOf(refundLines),
    }),
    "07. Advance Refund",
  ),
  "Advance Refund (deposit 1)",
);
