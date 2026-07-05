#!/usr/bin/env node
// 07. Advance Refund — refund ONE deposit of an advance sale. Each deposit was
// fiscalised as its own event, so a refund targets a single deposit's fiscal
// number with a self-contained body scaled to that deposit's amount (11,500).
// A full unwind is one refund per deposit. This script makes the advance sale
// first, then refunds its first deposit.
//   node --env-file=.env examples/07-advance-refund.mjs
import {
  fiscalise,
  expectFiscalised,
  firstFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
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
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    payments: [
      { amount: 11500, paymentType: "CARD", paymentDate: now() },
      { amount: 11500, paymentType: "CASH", paymentDate: now() },
      { amount: 11500, paymentType: "CASH", paymentDate: now() },
    ],
    ...totalsOf(saleLines),
  }),
  "advance sale to refund",
);
const deposit1 = firstFiscal(sale); // first fiscalised deposit

// (b) refund that deposit — scaled body (11,500), same invoiceNumber
const refundLines = [vatLine("Furniture layby — refund deposit 1/3", 10000, 1)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "ADVANCE",
      transactionType: "REFUND",
      referentDocumentNumber: deposit1.number,
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
