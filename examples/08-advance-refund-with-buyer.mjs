#!/usr/bin/env node
// 08. Advance Refund with buyer identification — like 07, with the buyer block
// on both the advance sale and the deposit refund.
//   node --env-file=.env examples/08-advance-refund-with-buyer.mjs
import {
  BUYER,
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
    buyer: BUYER,
    lineItems: saleLines,
    // Own id per deposit so a refund can target one without the SDC number.
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
  "advance buyer sale to refund",
);
// The sale must be signed before we can refund a deposit (clear message if not).
requireFiscal(sale, "advance buyer sale to refund");

// Refund deposit 1 by our own id (TAXCORE-639) — SAME invoiceNumber, no SDC number.
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
      buyer: BUYER,
      lineItems: refundLines,
      payments: [{ amount: 11500, paymentType: "CASH", paymentDate: now() }],
      ...totalsOf(refundLines),
    }),
    "08. Advance Refund with buyer identification",
  ),
  "Advance Refund with buyer (deposit 1)",
);
