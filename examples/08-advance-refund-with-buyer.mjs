#!/usr/bin/env node
// 08. Advance Refund with buyer identification — like 07, with the buyer block
// on both the advance sale and the deposit refund.
//   node --env-file=.env examples/08-advance-refund-with-buyer.mjs
import {
  fiscalise,
  expectFiscalised,
  firstFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
  BUYER,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber("EX-LAY");
const now = () => new Date().toISOString();

const saleLines = [vatLine("Furniture layby — sofa set", 10000, 3)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "ADVANCE",
    transactionType: "SALE",
    invoiceDate: now(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    buyer: BUYER,
    lineItems: saleLines,
    payments: [
      { amount: 11500, paymentType: "CARD", paymentDate: now() },
      { amount: 11500, paymentType: "CASH", paymentDate: now() },
      { amount: 11500, paymentType: "CASH", paymentDate: now() },
    ],
    ...totalsOf(saleLines),
  }),
  "advance buyer sale to refund",
);
const deposit1 = firstFiscal(sale);

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
      buyer: BUYER,
      lineItems: refundLines,
      payments: [{ amount: 11500, paymentType: "CASH", paymentDate: now() }],
      ...totalsOf(refundLines),
    }),
    "08. Advance Refund with buyer identification",
  ),
  "Advance Refund with buyer (deposit 1)",
);
