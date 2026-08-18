#!/usr/bin/env node
// Extra: a realistic mixed basket — multiple line items across TWO tax
// categories (VAT15 + zero-rated VAT0), a buyer, and one payment split across
// cash + card (a tenders[] breakdown). This is the shape a real supermarket
// POS sends; the receipt's tax table shows one row per rate.
//   node --env-file=.env examples/sale-mixed.mjs
import {
  BUYER,
  expectFiscalised,
  fiscalise,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

// Each line carries its own tax category. Totals sum across both.
const lineItems = [
  vatLine("Coffee 250g", 500, 2, "VAT15"), // 1000 + 150 tax
  vatLine("Bread (zero-rated staple)", 300, 3, "VAT0"), //  900 +   0 tax
  vatLine("Imported cheese", 1200, 1, "VAT15"), // 1200 + 180 tax
];
const totals = totalsOf(lineItems); // subtotal 3100, tax 330, total 3430

const body = {
  invoiceNumber: uniqueNumber("EX-MIX"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  buyer: BUYER,
  lineItems,
  // One payment settled with two tenders; the scalar type is OTHER and the
  // tenders[] carry the cash/card split (summing to the payment amount).
  payments: [
    {
      amount: totals.totalAmount,
      paymentType: "OTHER",
      paymentDate: new Date().toISOString(),
      tenders: [
        { amount: 2000, paymentType: "CASH" },
        { amount: totals.totalAmount - 2000, paymentType: "CARD" },
      ],
    },
  ],
  ...totals,
};

printReceipt(
  await expectFiscalised(await fiscalise(body), "mixed basket"),
  "Mixed basket (VAT15 + VAT0, split tender)",
);
