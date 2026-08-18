#!/usr/bin/env node
// 22. Custom (unmapped) tax code — the invoice-derived discovery path.
//
// Proves the open-vocabulary behaviour (TAXCORE-635): ANY `taxCode` is now
// accepted at the wire. A pre-635 backend rejected anything but `VAT15`/`VAT0`
// with a 422 at the boundary. A code with no confirmed V-SDC mapping is now
// accepted and the invoice is PERSISTED but BLOCKED (`MISSING_TAX_MAPPING`) —
// never signed at an unknown rate — and the code surfaces in the admin's
// unmapped-tax-types panel (provider=http) to be mapped. Example 21 is the
// declare-up-front path; this is the "just send an invoice" fallback.
//
// This is the truest test for a NEW business: a fresh business has zero HTTP
// tax mappings, and since TAXCORE-646 there is no auto-seed/"Initialize"
// shortcut — an admin must declare (example 21) or let a code surface from an
// invoice, then map it. So on day 0 even a VAT15 sale blocks until mapped.
//
// Pass a code as the first arg (default "TESTRATE"). `invoiceNumber` is always
// unique so a re-run is never an idempotent replay.
//   node --env-file=.env examples/22-custom-tax-code.mjs [TAXCODE]
import {
  fiscalise,
  STORE_CODE,
  totalsOf,
  uniqueNumber,
  vatLine,
} from "./lib.mjs";

const taxCode = process.argv[2] || "TESTRATE";

// vatLine derives the rate from the code (15% unless "VAT0"); the exact rate is
// irrelevant here because an unmapped code blocks before it ever fiscalises.
const lineItems = [vatLine("Mystery item", 1000, 1, taxCode)];
const body = {
  invoiceNumber: uniqueNumber(),
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
};

const { status, envelope, payload } = await fiscalise(body);

// A pre-635 backend rejects an unknown code at the wire. If that happens, the
// open-vocabulary change isn't deployed here — call it out explicitly rather
// than reporting a generic validation error.
if (envelope.error) {
  const wireRejectedCode =
    status === 422 &&
    (envelope.validationErrors ?? []).some((v) =>
      String(v.field).includes("taxCode"),
    );
  if (wireRejectedCode) {
    console.error(
      `✗ taxCode "${taxCode}" was REJECTED at the wire (HTTP 422 ${envelope.code}).`,
    );
    console.error(
      "  The open-vocabulary change (TAXCORE-635) does not appear to be live on this",
    );
    console.error("  backend — a pre-635 server only accepts VAT15 / VAT0.");
  } else {
    console.error(`✗ HTTP ${status} ${envelope.code}: ${envelope.message}`);
  }
  for (const v of envelope.validationErrors ?? [])
    console.error(`    ${v.field}: ${v.message}`);
  process.exit(1);
}

const fiscalised = payload.paymentResults.some(
  (p) => p.status === "fiscalised",
);

if (fiscalised) {
  // The code already has a confirmed mapping for this business — nothing to
  // discover. Run again with a code you haven't mapped to see the block.
  console.log(
    `✓ taxCode "${taxCode}" is already mapped — the sale fiscalised (invoiceId ${payload.invoiceId}).`,
  );
  for (const p of payload.paymentResults)
    console.log(
      `  payment ${p.invoicePaymentId}: ${p.status} — ${p.fiscalInvoiceNumber ?? "—"}`,
    );
  console.log(
    "\nTo observe discovery, run again with an unmapped code, e.g.\n" +
      "  node --env-file=.env examples/22-custom-tax-code.mjs BRANDNEW",
  );
  process.exit(0);
}

// Expected path for an unmapped code: accepted (HTTP 201), persisted, but every
// payment blocked — no fiscal number, no job dispatched.
console.log(
  `✓ taxCode "${taxCode}" was ACCEPTED (HTTP ${status}) and the invoice was persisted, but BLOCKED — not fiscalised.`,
);
console.log(`  invoiceId ${payload.invoiceId}`);
for (const p of payload.paymentResults)
  console.log(
    `  payment ${p.invoicePaymentId}: status "${p.status}" (no fiscal number → blocked)`,
  );
console.log(
  "\nWhy: the code has no confirmed V-SDC mapping, so the server blocks the invoice\n" +
    "with MISSING_TAX_MAPPING rather than signing it at an unknown rate. The code now\n" +
    "appears in the admin's unmapped-tax-types panel (provider=http). To finish:\n" +
    `  1. an admin maps "${taxCode}" to a V-SDC label on the HTTP integration screen\n` +
    "     (or declare it up front — see examples/21-declare-tax-rates.mjs),\n" +
    "  2. then reprocess the blocked invoice and it fiscalises.",
);
