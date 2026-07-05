#!/usr/bin/env node
// 09. Copy Sale — reprint a fiscalised sale (lost/damaged receipt). A COPY
// inherits lines/payments/totals/buyer from the source, so the body carries
// ONLY invoiceNumber + invoiceType + transactionType + cashierId + source.
// The copy gets its OWN fiscal number. This script makes a sale first, then
// copies it.
//   node --env-file=.env examples/09-copy-sale.mjs
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

const lineItems = [vatLine("Coffee 250g", 500, 2)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber: uniqueNumber(),
    invoiceType: "NORMAL",
    transactionType: "SALE",
    invoiceDate: new Date().toISOString(),
    currencyCode: "VUV",
    cashierId: "example-pos",
    lineItems,
    payments: [
      {
        amount: totalsOf(lineItems).totalAmount,
        paymentType: "CASH",
        paymentDate: new Date().toISOString(),
      },
    ],
    ...totalsOf(lineItems),
  }),
  "sale to copy",
);
const src = firstFiscal(sale);

printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber: uniqueNumber("EX-COPY"),
      invoiceType: "COPY",
      transactionType: "SALE", // matches the source's transaction type
      cashierId: "example-pos",
      source: {
        referencedFiscalNumber: src.number,
        referencedFiscalTimestamp: msToIso(src.timestampMs), // epoch-ms → ISO
      },
    }),
    "09. Copy Sale",
  ),
  "Copy Sale",
);
