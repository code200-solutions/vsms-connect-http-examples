#!/usr/bin/env node
// ib-06. Unmapped tax code on a payment-free sale — it must BLOCK, not dispatch.
//
//   node --env-file=.env examples/invoice-basis/ib-06-unmapped-tax-code.mjs [TAXCODE]
//
// WHAT THIS SHOWS
//   A credit sale (no `payments`, see ib-01) whose line carries a `taxCode` that
//   has been DECLARED to us but never MAPPED to a V-SDC label by an admin. The
//   correct answer is the same as on cash basis (example 22): HTTP 201, the
//   invoice persisted, every payment BLOCKED with `MISSING_TAX_MAPPING`, no
//   fiscal number, nothing dispatched. Once an admin maps the code and runs
//   "Re-sync blocked invoices", the SAME invoice signs under the SAME
//   `invoiceNumber` — you never resend it.
//
// WHY IT HAS ITS OWN CASE
//   Invoice basis is the one place the block could be lost. A payment-free sale
//   has no payment row to carry a block, and the single at-issue event the
//   server builds in its place used to inherit nothing. The invoice was then
//   dispatched with an empty tax label, failed on the server ("line item has no
//   confirmed V-SDC tax label") and ended FAILED — which cannot be retried from
//   the app — while you saw a 502 FISCAL_ERROR instead of a 201.
//
//   Cash basis never had this problem (it requires payments, and the block rides
//   on them), so this script is invoice-basis only.
//
// HOW TO READ THE RESULT
//   ✓ HTTP 201 + MISSING_TAX_MAPPING   → correct. Stays that way after the wait.
//   ✗ HTTP 200 / 202                   → a job ran: the unmapped invoice was
//                                        dispatched.
//   ✗ HTTP 502 FISCAL_ERROR            → a job ran and FAILED. Inspect
//                                        GET /fiscalise/:invoiceId — the payment
//                                        is in `error`.
//
// Pass a code as the first argument to reuse one you already declared. Without
// one, a fresh `UNMAPPED-<timestamp>` is used so it is guaranteed unmapped and a
// re-run is never an idempotent replay. It will appear in the business's
// unmapped-tax-types list; map it or ignore it.
//
// REQUIRES an invoice-basis business — see ./README.md.
import {
  declareTaxRates,
  expectAtIssue,
  fiscalise,
  getStatus,
  IB,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "../lib.mjs";

const taxCode =
  process.argv[2] || `UNMAPPED-${Date.now().toString(36).toUpperCase()}`;

// ── (a) declare the code, but do NOT map it ─────────────────────────────────
// The integrator's usual path: send your tax table up front (example 21). Each
// code lands as a PROPOSAL; nothing is mapped until an admin confirms it.
const declared = await declareTaxRates(
  [{ code: taxCode, name: "Unmapped example code", rate: 0 }],
  IB,
);
if (declared.envelope.error) {
  console.error(
    `✗ declaring "${taxCode}": HTTP ${declared.status} ${declared.envelope.code}: ${declared.envelope.message}`,
  );
  process.exit(1);
}
console.log(`declared "${taxCode}" — a proposal, not a mapping.`);

// ── (b) a credit sale carrying it, with NO payments ─────────────────────────
const lineItems = [vatLine("Item on an unmapped code", 1000, 1, taxCode)];
const body = {
  invoiceNumber: uniqueNumber("IB"),
  invoiceType: "NORMAL",
  transactionType: "SALE",
  storeCode: STORE_CODE,
  invoiceDate: new Date().toISOString(),
  currencyCode: "VUV",
  cashierId: "example-pos",
  lineItems,
  // ── NO `payments` KEY ─────────────────────────────────────────────────────
  // The case that used to lose the block.
  ...totalsOf(lineItems),
};

const result = await fiscalise(body, IB);

// A cash-basis business rejects a payment-free sale at the wire. Reuse the
// shared probe so the explanation is the same as in ib-01..05.
if (
  result.status === 422 &&
  (result.envelope?.validationErrors ?? []).some((v) => v.field === "payments")
) {
  await expectAtIssue(result, "ib-06. Unmapped tax code", IB);
}

if (result.envelope.error) {
  // 502 FISCAL_ERROR is the pre-fix symptom: the unmapped invoice was
  // dispatched and failed. Say so, rather than printing a generic error.
  const dispatched = result.status === 502;
  console.error(
    `\n✗ HTTP ${result.status} ${result.envelope.code}: ${result.envelope.message}`,
  );
  if (dispatched) {
    console.error(
      "\n  An invoice on an UNMAPPED tax code was dispatched and failed. It should have\n" +
        "  been accepted and BLOCKED (HTTP 201, MISSING_TAX_MAPPING). That payment is now\n" +
        "  in `error`, which cannot be retried from the app. This backend predates the fix.",
    );
  }
  for (const v of result.envelope.validationErrors ?? [])
    console.error(`    ${v.field}: ${v.message}`);
  process.exit(1);
}

const { invoiceId, paymentResults = [] } = result.payload;
const blocked =
  result.status === 201 &&
  paymentResults.length > 0 &&
  paymentResults.every(
    (p) =>
      p.eligibleForFiscalisation === false &&
      [p.fiscalisationBlockReasons ?? []]
        .flat()
        .includes("MISSING_TAX_MAPPING"),
  );

if (!blocked) {
  console.error(
    `\n✗ HTTP ${result.status}: expected 201 with every payment blocked on MISSING_TAX_MAPPING.`,
  );
  for (const p of paymentResults)
    console.error(
      `    payment ${p.invoicePaymentId}: status "${p.status}", eligible ${p.eligibleForFiscalisation}, reasons [${[
        p.fiscalisationBlockReasons ?? [],
      ]
        .flat()
        .join(", ")}], fiscal number ${p.fiscalInvoiceNumber ?? "—"}`,
    );
  if (result.status === 200 || result.status === 202)
    console.error(
      "\n  A job ran, so the unmapped invoice was dispatched. This backend predates the fix.",
    );
  process.exit(1);
}

console.log(
  `\n✓ HTTP ${result.status} — accepted and BLOCKED, as it should be.  invoiceId ${invoiceId}`,
);
for (const p of paymentResults)
  console.log(
    `  payment ${p.invoicePaymentId}: "${p.status}", reasons [${[p.fiscalisationBlockReasons].flat().join(", ")}], no fiscal number`,
  );

// ── (c) it STAYS blocked ────────────────────────────────────────────────────
// The failure this guards against arrived asynchronously: the POST answered,
// then a job failed a few seconds later and flipped the payment to `error`. A
// clean first response is not proof, so read it back for a while.
console.log("\nreading it back for 10s to confirm nothing dispatches it …");
const deadline = Date.now() + 10_000;
for (;;) {
  const { envelope, payload } = await getStatus(invoiceId, IB);
  if (envelope.error) {
    console.error(`✗ status GET failed: ${envelope.code}`);
    process.exit(1);
  }
  const bad = (payload.paymentResults ?? []).find(
    (p) =>
      p.status === "error" ||
      p.status === "fiscalised" ||
      p.fiscalInvoiceNumber,
  );
  if (bad) {
    console.error(
      `\n✗ the invoice changed to "${bad.status}" after the POST — it was dispatched while its tax code was unmapped.`,
    );
    process.exit(1);
  }
  if (Date.now() >= deadline) break;
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("✓ still blocked after 10s — nothing dispatched it.");

console.log(
  "\nTO RELEASE IT (not done by this script — mapping needs an admin):\n" +
    `  1. an admin maps "${taxCode}" to a V-SDC label on the Generic HTTP screen → Tax mappings,\n` +
    '  2. then runs "Re-sync blocked invoices" on the same screen.\n' +
    "The same invoice then signs under the same invoiceNumber — do not resend it.\n" +
    `Check it with: GET /businesses/${IB.businessId}/fiscalise/${invoiceId}`,
);
