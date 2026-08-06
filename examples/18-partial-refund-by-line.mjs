#!/usr/bin/env node
// 18. Item-level partial refund — refund ONE line of a multi-line sale by
// sending exactly that line in the refund body, instead of a proportional
// slice of the whole invoice. The refund reuses the sale's invoiceNumber and
// references its fiscal number; its own lineItems + totals describe precisely
// what is being returned. Because the refund total is less than the sale
// total, the connector records it as a partial refund.
//   node --env-file=.env examples/18-partial-refund-by-line.mjs
import {
  fiscalise,
  expectFiscalised,
  firstFiscal,
  printReceipt,
  vatLine,
  totalsOf,
  uniqueNumber,
} from "./lib.mjs";

const invoiceNumber = uniqueNumber();
const cash = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (a) a two-line sale — Coffee (1000) + Ceramic mug (500), both VAT15.
const saleLines = [vatLine("Coffee 250g", 1000), vatLine("Ceramic mug", 500)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    payments: cash(totalsOf(saleLines)),
    ...totalsOf(saleLines),
  }),
  "sale to partially refund",
);
const src = firstFiscal(sale);

// (b) refund ONLY the mug — a single-line refund body. Its total (575 incl.
// VAT) is below the sale total, so this is an item-level partial refund: the
// returned line is forwarded verbatim rather than scaling the whole invoice.
const refundLines = [vatLine("Ceramic mug — refund", 500)];
printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "REFUND",
      referentDocumentNumber: src.number,
      invoiceDate: new Date().toISOString(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems: refundLines,
      payments: cash(totalsOf(refundLines)),
      ...totalsOf(refundLines),
    }),
    "18. Item-level partial refund",
  ),
  "Item-level partial refund",
);
