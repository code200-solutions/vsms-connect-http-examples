#!/usr/bin/env node
// ib-04. Edit a declared invoice — what happens when the invoice changes AFTER
// it was declared at issue.
//
//   node --env-file=.env examples/invoice-basis/ib-04-edit.mjs
//
// WHAT THIS SHOWS
//   Re-POSTing the same invoiceNumber with a genuinely different total does NOT
//   append a payment and does NOT amend the original document. It declares the
//   DIFFERENCE as a new document of its own:
//
//     total went UP    → a chained NORMAL **sale** for the increase
//     total went DOWN  → a partial **refund** of what was over-declared
//     total unchanged  → nothing at all (a no-op)
//
//   Each of those is a distinct linked document with its own `invoiceId`, which
//   is what the response hands back — so the id you get from an edit is the id
//   of the document your edit produced, not the original invoice's.
//
// WHY IT WORKS THIS WAY
//   On invoice basis the tax was declared when the invoice was issued. Changing
//   the invoice afterwards changes the tax owed, so the change itself has to be
//   declared. Nothing already signed is ever rewritten — V-SDC documents are
//   immutable — so the only honest way to say "it is 345 more than I told you"
//   is another document for 345.
//
//   The server diffs your body against the LAST BODY IT DECLARED, not against
//   the original invoice, so a second edit is measured from the first. That is
//   also why an unchanged re-push is free: it compares equal and stops.
//
// CONTRAST — cash basis has no equivalent
//   There, re-POSTing an invoiceNumber appends a settlement PAYMENT, and the
//   invoice total is locked: a body whose totals moved is rejected outright
//   with `422 INVOICE_FIELD_MISMATCH`. The total never changes by design,
//   because on cash basis the total was never what was declared.
//
// REQUIRES an invoice-basis business — see ./README.md.
import {
  expectAtIssue,
  fiscalise,
  IB,
  pollUntilTerminal,
  printReceipt,
  requireFiscal,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../lib.mjs";

const invoiceNumber = uniqueNumber("IB");
const now = () => new Date().toISOString();

const coffee = vatLine("Coffee 250g", 500, 2); // 1000 + 150 = 1150
const tea = vatLine("Tea 100g", 300, 1); //  300 +  45 =  345

/** The common envelope — only `lineItems`, the totals and `payments` vary. */
const bodyFor = (lineItems, extra = {}) => ({
  invoiceNumber,
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: now(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  ...totalsOf(lineItems),
  ...extra,
});

/**
 * Report what one edit declared, and follow the new document to a fiscal
 * number. An edit answers 201 with no jobId (the dispatch happens behind it),
 * so `expectFiscalised` would not poll — we poll the returned id explicitly.
 */
async function reportEdit(result, originalInvoiceId, label) {
  if (result.envelope.error) {
    console.error(
      `\n✗ ${label}: HTTP ${result.status} ${result.envelope.code}: ${result.envelope.message}`,
    );
    for (const v of result.envelope.validationErrors ?? [])
      console.error(`    ${v.field}: ${v.message}`);
    process.exitCode = 1;
    return null;
  }

  const { invoiceId, paymentResults = [] } = result.payload;
  const declaredSomething = invoiceId !== originalInvoiceId;

  console.log(`\n── ${label} — HTTP ${result.status}`);
  if (!declaredSomething) {
    console.log(
      `   NO-OP: invoiceId is still the original (${invoiceId}), paymentResults is ${
        paymentResults.length === 0 ? "empty" : `${paymentResults.length} long`
      }.`,
    );
    console.log("   Nothing was declared, because nothing changed.");
    return null;
  }

  console.log(`   NEW document: invoiceId ${invoiceId}`);
  console.log(`   (the original stays ${originalInvoiceId}, untouched)`);
  return printReceipt(
    await pollUntilTerminal(invoiceId, 120_000, IB),
    label,
    invoiceNumber,
  );
}

// ── (a) the at-issue sale — 1150 VUV, no payments (see ib-01) ───────────────
const sale = await expectAtIssue(
  await fiscalise(bodyFor([coffee]), IB),
  "sale to edit",
  IB,
);
printReceipt(sale, "At-issue sale — 1150 VUV");
// The decrease in (d) is declared as a partial refund OF the at-issue document,
// so that document has to have signed first.
requireFiscal(sale, "sale to edit");
const originalInvoiceId = sale.invoiceId;

// ── (b) the customer pays — a re-push that changes nothing ──────────────────
// The settlement itself is not a taxable event here, so attaching the payment
// declares nothing. (The body still differs from (a) — it now carries
// `payments` — so this is a real request, not an idempotency-cache replay.)
await reportEdit(
  await fiscalise(
    bodyFor([coffee], {
      payments: [
        {
          amount: totalsOf([coffee]).totalAmount,
          paymentType: "CASH",
          paymentDate: now(),
        },
      ],
    }),
    IB,
  ),
  originalInvoiceId,
  "(b) settlement — same lines, same total",
);

// ── (c) INCREASE — a line was missed off the invoice ────────────────────────
// 1150 → 1495. The difference (345) is declared as a chained NORMAL sale
// carrying just the added line.
await reportEdit(
  await fiscalise(bodyFor([coffee, tea]), IB),
  originalInvoiceId,
  "(c) increase — added Tea 100g (+345)",
);

// ── (d) DECREASE — the line is taken back off ───────────────────────────────
// 1495 → 1150, measured against what was last declared (NOT against the
// original 1150). The 345 over-declared is reversed as a partial refund.
await reportEdit(
  await fiscalise(bodyFor([coffee]), IB),
  originalInvoiceId,
  "(d) decrease — removed Tea 100g (−345)",
);

console.log(
  `\nAll of the above share invoiceNumber ${invoiceNumber}. Retrieve any one of them\n` +
    "with GET /businesses/:businessId/fiscalise/:invoiceId using the id it reported —\n" +
    "there is no lookup by invoiceNumber, so keep the ids your edits hand back.\n" +
    "\n" +
    "⚠️ This invoice now has several fiscalised documents, so cancelling it by\n" +
    "   invoiceNumber alone is ambiguous — see ib-03-void.mjs.",
);
