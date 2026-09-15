#!/usr/bin/env node
// ib-03. Void (cancel) an at-issue sale — reverse it with a V-SDC
// counter-document.
//
//   node --env-file=.env examples/invoice-basis/ib-03-void.mjs
//
// WHAT THIS SHOWS
//   Cancelling by your own invoiceNumber alone, with no SDC fiscal number. The
//   original receipt is NOT mutated; V-SDC signs a NEW record reversing it.
//
// HOW IT WORKS
//   A cancel is fail-closed: the server resolves the target within that
//   invoiceNumber's family (the sale plus every linked refund, copy and
//   adjustment) and refuses to guess if more than one fiscalised document
//   matches. An invoice-basis sale that has NEVER BEEN EDITED is exactly one
//   document, so there is nothing to be ambiguous about.
//
// ⚠️ THIS ONLY HOLDS BEFORE ANY EDIT
//   An edit (ib-04) declares a SECOND fiscalised document under the same
//   invoiceNumber — a chained sale for an increase, a partial refund for a
//   decrease. From that point on, cancelling by invoiceNumber alone gets the
//   same fail-closed 422 that a split-tender sale gets on cash basis:
//
//     invoiceNumber='IB-…' has 2 fiscalised payments, so the cancel target is
//     ambiguous. Pass transactionType and/or externalPaymentId to name it,
//     or use fiscalInvoiceNumber.
//
//   How you narrow it depends on which edit you made:
//     * DECREASE — the delta is a REFUND, so `transactionType: "SALE"` isolates
//       the original sale (and "REFUND" the reversal).
//     * INCREASE — the delta is another SALE, so `transactionType` cannot split
//       them, and `externalPaymentId` cannot either: BOTH documents carry
//       `externalPaymentId: null` (each is a server-synthesised event, not a
//       payment you sent). Use `fiscalInvoiceNumber` — pass a plain string to
//       `cancelDoc` to target a document by its SDC number.
//
//   And note a cancel reverses ONE document, not the chain: an edited invoice
//   needs each of its documents cancelled.
//
// CONTRAST — examples/15-cancel.mjs (cash basis)
//   The same call, and the same fail-closed rule. There it is a split-tender or
//   deposit-chain sale that makes the number ambiguous; here it is an edit. An
//   edited invoice-basis sale converges onto exactly that story.
//
// REQUIRES an invoice-basis business — see ./README.md.
import {
  cancelDoc,
  expectAtIssue,
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
const lineItems = [vatLine("Coffee 250g", 500, 2)];

// (a) an at-issue sale to void — no payments, per ib-01.
const sale = await expectAtIssue(
  await fiscalise(
    {
      invoiceNumber,
      invoiceType: "NORMAL",
      transactionType: "SALE",
      storeCode: STORE_CODE,
      invoiceDate: new Date().toISOString(),
      currencyCode: "VUV",
      cashierId: "example-pos",
      lineItems,
      ...totalsOf(lineItems),
    },
    IB,
  ),
  "sale to void",
  IB,
);
printReceipt(sale, "At-issue sale");
requireFiscal(sale, "sale to void"); // a cancel needs a SIGNED document

// (b) void it by the caller's own invoiceNumber — no SDC number, and no
//     narrowing needed, because this sale has never been edited.
const result = await cancelDoc({ invoiceNumber }, IB);
console.log(`\nHTTP ${result.status}`);
if (result.envelope.error) {
  console.error(`${result.envelope.code}: ${result.envelope.message}`);
  process.exitCode = 1;
} else {
  console.log("cancellationPaymentId:", result.payload.cancellationPaymentId);
  printReceipt(result.payload, "Void");
  console.log(
    "\nunambiguous because this invoice was never edited — run ib-04 first and the\n" +
      "same call needs a fiscalInvoiceNumber (or a transactionType) to say which document.",
  );
}
