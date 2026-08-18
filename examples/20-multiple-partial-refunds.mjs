#!/usr/bin/env node
// 20. Multiple partial refunds against one sale — return items across two
// separate refund calls. Both reference the SAME sale fiscal number; each
// carries its own returned line. The running sum of refunds is guarded, so it
// can never exceed the sale total. (Before this was supported the second call
// was rejected with 409 INVOICE_ALREADY_REFUNDED.)
//   node --env-file=.env examples/20-multiple-partial-refunds.mjs
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

const invoiceNumber = uniqueNumber();
const cash = (t) => [
  {
    amount: t.totalAmount,
    paymentType: "CASH",
    paymentDate: new Date().toISOString(),
  },
];

// (a) a two-line sale — Item A (1200) + Item B (800), both VAT15.
const saleLines = [vatLine("Item A", 1200), vatLine("Item B", 800)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    storeCode: STORE_CODE,
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems: saleLines,
    payments: cash(totalsOf(saleLines)),
    ...totalsOf(saleLines),
  }),
  "sale to refund in parts",
);
requireFiscal(sale, "sale to refund in parts");

// A refund body for one returned line. Reuses the sale's invoiceNumber; the
// server resolves the source from it (TAXCORE-639), no SDC number needed.
const refundOf = (lineItems) => ({
  invoiceNumber,
  invoiceType: "NORMAL",
  transactionType: "REFUND",
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  payments: cash(totalsOf(lineItems)),
  ...totalsOf(lineItems),
});

// (b) first partial refund — Item A.
printReceipt(
  await expectFiscalised(
    await fiscalise(refundOf([vatLine("Item A — refund", 1200)])),
    "20a. First partial refund",
  ),
  "First partial refund (Item A)",
);

// (c) second partial refund — Item B. A distinct body (different line/amount),
// so it is a real second refund and not a cached replay of the first.
printReceipt(
  await expectFiscalised(
    await fiscalise(refundOf([vatLine("Item B — refund", 800)])),
    "20b. Second partial refund",
  ),
  "Second partial refund (Item B)",
);
