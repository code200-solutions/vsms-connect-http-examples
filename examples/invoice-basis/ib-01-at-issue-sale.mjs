#!/usr/bin/env node
// ib-01. At-issue sale — the whole point of invoice basis: the supply is
// declared the moment the invoice is ISSUED, before any money has moved.
//
//   node --env-file=.env examples/invoice-basis/ib-01-at-issue-sale.mjs
//
// WHAT THIS SHOWS
//   A credit sale with NO `payments` at all. The invoice fiscalises anyway, as
//   ONE fiscal document for the whole `totalAmount`. Nothing is waiting for a
//   settlement, because on invoice basis the settlement is not the taxable
//   event — issuing the invoice is.
//
// HOW IT WORKS
//   `payments` may be omitted entirely on a NORMAL or ADVANCE **SALE**. The
//   server synthesises the single at-issue event from the invoice's own total
//   and stamps it `paymentType: OTHER` — no money has moved at signing, and
//   `OTHER` is the honest way to say so (V-SDC still requires a payment element
//   carrying a type). Look for it on the `fiscalJournal` receipt below.
//
//   Two body fields you send are REWRITTEN rather than honoured, and that is
//   deliberate:
//     * `invoiceType: "ADVANCE"` is pinned to NORMAL. ADVANCE means prepayment
//       before delivery; a credit sale is the opposite — the supply happened,
//       only the money is outstanding. There is no deposit chain on this basis.
//     * any `payments[]` you do send are replaced by the single full-amount
//       at-issue event. Sending them is harmless, but they do not become
//       separate fiscal documents the way they do on cash basis.
//
// CONTRAST — examples/01-normal-sale.mjs (cash basis)
//   There, one fiscal event is signed per `payments[]` entry, carrying YOUR
//   `paymentType`, and an invoice with no payments could not be sent at all.
//
// REQUIRES an invoice-basis business — see ../invoice-basis/README.md. Basis is
// fixed when a business is REGISTERED and cannot be changed afterwards, so this
// is a different business (and API key) from the one examples/01-27 use.
import {
  expectAtIssue,
  fiscalise,
  IB,
  printReceipt,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../lib.mjs";

const lineItems = [vatLine("Coffee 250g", 500, 2)];

const body = {
  invoiceNumber: uniqueNumber("IB"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  // ── NO `payments` KEY AT ALL ──────────────────────────────────────────────
  // This is the line that matters. On cash basis its absence is a
  // `422 payments must be a non-empty array`; on invoice basis it is the
  // normal shape of a credit sale that has not been paid yet.
  ...totalsOf(lineItems),
};

const payload = await expectAtIssue(
  await fiscalise(body, IB),
  "ib-01. At-issue sale",
  IB,
);
printReceipt(payload, "At-issue sale (no payment sent)");

// What to look for, stated rather than left to the reader to spot.
const results = payload.paymentResults ?? [];
console.log(
  `\ndeclared events: ${results.length} (expected 1 — the whole invoice, ${totalsOf(lineItems).totalAmount} VUV)`,
);
console.log(
  `externalPaymentId: ${results[0]?.externalPaymentId ?? "null"} (expected null — this event is ours, not a payment you sent)`,
);
console.log(
  "the receipt above should show the payment as OTHER, not CASH — no money moved at signing.",
);
