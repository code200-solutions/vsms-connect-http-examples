#!/usr/bin/env node
// ib-02. Refund an at-issue sale — returning goods against an invoice that was
// declared at issue.
//
//   node --env-file=.env examples/invoice-basis/ib-02-refund.mjs
//
// WHAT THIS SHOWS
//   The refund reuses the sale's SAME invoiceNumber and names nothing else. No
//   `referentDocumentNumber` (the SDC number of the sale), no
//   `sourceExternalPaymentId` — the server resolves the source by itself.
//
// HOW IT WORKS
//   An invoice-basis sale is declared as exactly ONE fiscal document, so there
//   is exactly one candidate to refund and the server resolves it with nothing
//   to choose by. On cash basis the same call works only when the sale happened
//   to have a single payment; a split-tender or deposit-chain sale there is
//   ambiguous and has to be named with `sourceExternalPaymentId`.
//
//   ⚠️ `sourceExternalPaymentId` is not just unnecessary here — it cannot work.
//   The at-issue event carries `externalPaymentId: null` (it is the server's
//   own synthesised event, not a payment you sent), so naming one matches
//   nothing and the refund 404s. If you have a cash-basis integration that
//   always sends it, that is the line to delete for invoice basis.
//
//   A REFUND still REQUIRES `payments` — the relaxation that lets a SALE omit
//   them is SALE-only, and deliberately: a refund is money genuinely going back
//   to the buyer, which is a settlement whatever the basis.
//
// CONTRAST — examples/03-normal-refund.mjs (cash basis)
//   Same call shape, and it works there too — but by luck, because that sale
//   has a single payment. The difference only bites on a multi-payment sale.
//
// REQUIRES an invoice-basis business — see ./README.md.
import {
  expectAtIssue,
  expectFiscalised,
  fiscalise,
  IB,
  printReceipt,
  requireFiscal,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../lib.mjs";

const invoiceNumber = uniqueNumber("IB");
const now = () => new Date().toISOString();
const lineItems = [vatLine("Coffee 250g", 500, 2)];

// (a) the at-issue sale to refund — no payments, per ib-01.
const sale = await expectAtIssue(
  await fiscalise(
    {
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "SALE",
      storeCode: STORE_CODE,
      invoiceDate: now(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems,
      ...totalsOf(lineItems),
    },
    IB,
  ),
  "sale to refund",
  IB,
);
printReceipt(sale, "At-issue sale");
// A refund needs a SIGNED source — clear message rather than a crash if not.
requireFiscal(sale, "sale to refund");

// (b) the refund — SAME invoiceNumber, and nothing else naming the source.
//     `payments` IS required here (see the header note).
const refundLines = [vatLine("Coffee 250g — returned", 500, 2)];
const refundTotals = totalsOf(refundLines);
printReceipt(
  await expectFiscalised(
    await fiscalise(
      {
        invoiceNumber,
        invoiceType: "NORMAL",
        transactionType: "REFUND",
        invoiceDate: now(),
        currencyCode: "VUV",
        cashierId: "example-pos",
        lineItems: refundLines,
        payments: [
          {
            amount: refundTotals.totalAmount,
            paymentType: "CASH",
            paymentDate: now(),
          },
        ],
        ...refundTotals,
      },
      IB,
    ),
    "ib-02. Refund",
    IB,
  ),
  "Refund",
  invoiceNumber,
);

console.log(
  "\nthe refund is a DISTINCT linked document (its own invoiceId) sharing the sale's invoiceNumber —\n" +
    "the same evolving-invoice model cash basis uses; only the source resolution differs.",
);
