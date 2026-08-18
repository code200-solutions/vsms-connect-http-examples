#!/usr/bin/env node
// 09. Copy Sale — reprint a fiscalised sale (lost/damaged receipt). A COPY
// inherits lines/payments/totals/buyer from the source, so the body carries
// ONLY invoiceNumber + invoiceType + transactionType + cashierId. The copy
// gets its OWN fiscal number. This script makes a sale first, then copies it.
//
// The copy REUSES the sale's invoiceNumber and omits `source`: the server
// resolves the source from that invoiceNumber — its single fiscalised payment —
// so you never persist or echo the SDC fiscal number (TAXCORE-639). (You can
// still name it explicitly via `source.referencedFiscalNumber` — see 10.)
//   node --env-file=.env examples/09-copy-sale.mjs
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
const lineItems = [vatLine("Coffee 250g", 500, 2)];
const sale = await expectFiscalised(
  await fiscalise({
    invoiceNumber,
    invoiceType: "NORMAL",
    transactionType: "SALE",
    storeCode: STORE_CODE,
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
// A COPY needs a SIGNED source — guard with a clear message if it isn't.
requireFiscal(sale, "sale to copy");

printReceipt(
  await expectFiscalised(
    await fiscalise({
      invoiceNumber, // reuse the sale's number → server resolves the source
      invoiceType: "COPY",
      transactionType: "SALE", // matches the source's transaction type
      cashierId: "example-pos",
    }),
    "09. Copy Sale",
  ),
  "Copy Sale",
);
